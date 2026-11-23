import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_THINKING_CONFIG,
  setThinkingBudgetConfig,
  ThinkingMode,
} from "../../../open-sse/services/thinkingBudget.ts";
import { FORMATS } from "../../../open-sse/translator/formats.ts";
import { translateRequest } from "../../../open-sse/translator/index.ts";
import { claudeToGeminiRequest } from "../../../open-sse/translator/request/claude-to-gemini.ts";
import { openaiToGeminiRequest } from "../../../open-sse/translator/request/openai-to-gemini.ts";
import { applyReasoningRuleDirective } from "../../../src/lib/reasoningRouting/policy.ts";

const MODEL = "gemini-3.5-flash-lite";

afterEach(() => setThinkingBudgetConfig(DEFAULT_THINKING_CONFIG));

interface NativeThinkingConfig {
  thinkingLevel?: string;
  includeThoughts?: boolean;
  thinkingBudget?: number;
}

async function nativeThinking(request: Record<string, unknown> = {}): Promise<NativeThinkingConfig> {
  const converted = (await openaiToGeminiRequest(
    MODEL,
    {
      messages: [{ role: "user", content: "Reply exactly OK" }],
      ...request,
    },
    false
  )) as unknown as { generationConfig: { thinkingConfig?: NativeThinkingConfig } };
  return converted.generationConfig.thinkingConfig ?? {};
}

// The production entry point: applyThinkingBudget runs before the translator here.
async function pipelineRequest(
  request: Record<string, unknown>,
  target: string = FORMATS.GEMINI,
  source: string = FORMATS.OPENAI,
  model: string = MODEL
): Promise<Record<string, unknown>> {
  return (await translateRequest(
    source,
    target,
    model,
    { model, messages: [{ role: "user", content: "Reply exactly OK" }], ...request },
    false,
    null,
    target === FORMATS.ANTIGRAVITY ? "antigravity" : "gemini"
  )) as Record<string, unknown>;
}

async function pipelineThinking(request: Record<string, unknown>): Promise<NativeThinkingConfig> {
  const converted = (await pipelineRequest(request)) as {
    generationConfig: { thinkingConfig?: NativeThinkingConfig };
  };
  return converted.generationConfig.thinkingConfig ?? {};
}

async function claudeThinking(request: Record<string, unknown>, model = MODEL) {
  const converted = (await claudeToGeminiRequest(
    model,
    { messages: [{ role: "user", content: "Reply exactly OK" }], ...request },
    false
  )) as unknown as { generationConfig: { thinkingConfig?: NativeThinkingConfig } };
  return converted.generationConfig.thinkingConfig;
}

test("Gemini 3.5 Flash-Lite uses native minimal thinking by default", async () => {
  assert.deepEqual(await nativeThinking(), {
    thinkingLevel: "minimal",
    includeThoughts: true,
  });
});

test("Gemini 3.5 Flash-Lite maps OpenAI effort to native levels", async () => {
  const cases = [
    ["none", "minimal", false],
    ["minimal", "minimal", true],
    ["low", "low", true],
    ["medium", "medium", true],
    ["high", "high", true],
    ["xhigh", "high", true],
    ["auto", "high", true],
  ] as const;
  for (const [effort, level, includeThoughts] of cases) {
    assert.deepEqual(
      await nativeThinking({ reasoning_effort: effort }),
      { thinkingLevel: level, includeThoughts },
      effort
    );
  }
});

test("Gemini 3.5 Flash-Lite maps numeric budgets without sending thinkingBudget", async () => {
  assert.deepEqual(await nativeThinking({ thinking: { type: "enabled", budget_tokens: 4096 } }), {
    thinkingLevel: "medium",
    includeThoughts: true,
  });
});

test("Gemini native level preserves summary opt-outs only when they win", async () => {
  const cases: Array<{
    name: string;
    request: Record<string, unknown>;
    level: string;
    includeThoughts: boolean;
  }> = [
    {
      name: "disabled thinking",
      request: { thinking: { type: "disabled" } },
      level: "minimal",
      includeThoughts: false,
    },
    {
      name: "thinking false",
      request: { thinking: false },
      level: "minimal",
      includeThoughts: false,
    },
    {
      name: "zero budget",
      request: { thinking: { budget_tokens: 0 } },
      level: "minimal",
      includeThoughts: false,
    },
    {
      name: "negative budget",
      request: { thinking: { budget_tokens: -20 } },
      level: "minimal",
      includeThoughts: false,
    },
    {
      name: "effort overrides disabled",
      request: { reasoning_effort: "high", thinking: { type: "disabled" } },
      level: "high",
      includeThoughts: true,
    },
    {
      name: "effort overrides zero",
      request: { reasoning_effort: "low", thinking: { budget_tokens: 0 } },
      level: "low",
      includeThoughts: true,
    },
    {
      name: "explicit overrides none",
      request: { thinkingLevel: "high", reasoning_effort: "none" },
      level: "high",
      includeThoughts: true,
    },
    {
      name: "explicit overrides disabled",
      request: { thinkingLevel: "low", thinking: { type: "disabled" } },
      level: "low",
      includeThoughts: true,
    },
  ];
  for (const item of cases) {
    assert.deepEqual(
      await nativeThinking(item.request),
      { thinkingLevel: item.level, includeThoughts: item.includeThoughts },
      item.name
    );
  }
});

test("an enabled budget beats effort, the same order as the budget path", async () => {
  const enabled = (budget_tokens: number) => ({ thinking: { type: "enabled", budget_tokens } });
  assert.deepEqual(await nativeThinking({ reasoning_effort: "high", ...enabled(512) }), {
    thinkingLevel: "low",
    includeThoughts: true,
  });
  assert.deepEqual(await nativeThinking({ reasoning_effort: "low", ...enabled(20000) }), {
    thinkingLevel: "high",
    includeThoughts: true,
  });
  assert.deepEqual(await nativeThinking({ reasoning_effort: "high", ...enabled(0) }), {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
  assert.deepEqual(await nativeThinking({ thinkingLevel: "medium", ...enabled(512) }), {
    thinkingLevel: "medium",
    includeThoughts: true,
  });
});

test("Gemini native thinkingLevel wins over both default and OpenAI effort", async () => {
  for (const [levelField, requested, expected] of [
    ["thinkingLevel", "LOW", "low"],
    ["thinking_level", "medium", "medium"],
  ] as const) {
    assert.deepEqual(await nativeThinking({ [levelField]: requested, reasoning_effort: "high" }), {
      thinkingLevel: expected,
      includeThoughts: true,
    });
  }
  assert.deepEqual(
    await nativeThinking({
      reasoning_effort: "high",
      generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
    }),
    { thinkingLevel: "low", includeThoughts: true }
  );
});

test("translateRequest keeps an explicit native level ahead of effort for every spelling", async () => {
  const nested = (level: string) => ({
    generationConfig: { thinkingConfig: { thinkingLevel: level } },
  });
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["top low", { thinkingLevel: "low" }, "low"],
    ["top LOW", { thinkingLevel: "LOW" }, "low"],
    ["top snake", { thinking_level: "medium" }, "medium"],
    ["top high", { thinkingLevel: "high" }, "high"],
    ["top minimal", { thinkingLevel: "minimal" }, "minimal"],
    ["top low over effort", { thinkingLevel: "low", reasoning_effort: "high" }, "low"],
    ["nested low", nested("low"), "low"],
    ["nested high", nested("high"), "high"],
    ["nested high over effort", { ...nested("high"), reasoning_effort: "low" }, "high"],
    [
      "nested snake",
      { generationConfig: { thinking_config: { thinkingLevel: "medium" } } },
      "medium",
    ],
  ];
  for (const [name, request, level] of cases) {
    assert.deepEqual(
      await pipelineThinking(request),
      { thinkingLevel: level, includeThoughts: true },
      name
    );
  }
});

test("translateRequest maps levels Gemini does not define through the budget path", async () => {
  assert.deepEqual(await pipelineThinking({ thinkingLevel: "xhigh" }), {
    thinkingLevel: "high",
    includeThoughts: true,
  });
  assert.deepEqual(await pipelineThinking({ thinkingLevel: "none" }), {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
});

test("translateRequest ignores an unknown level on a native-level model", async () => {
  assert.deepEqual(await pipelineThinking({ thinkingLevel: "bogus" }), {
    thinkingLevel: "minimal",
    includeThoughts: true,
  });
});

test("translateRequest keeps the explicit level on the Antigravity envelope", async () => {
  const converted = (await pipelineRequest({ thinkingLevel: "low" }, FORMATS.ANTIGRAVITY)) as {
    request: { generationConfig: { thinkingConfig?: NativeThinkingConfig } };
  };
  assert.deepEqual(converted.request.generationConfig.thinkingConfig, {
    thinkingLevel: "low",
    includeThoughts: true,
  });
});

test("a Gemini-format client keeps its native level on a same-format request", async () => {
  const converted = await translateRequest(
    FORMATS.GEMINI,
    FORMATS.GEMINI,
    MODEL,
    {
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: "Reply exactly OK" }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
    },
    false,
    null,
    "gemini"
  ) as { generationConfig: { thinkingConfig?: NativeThinkingConfig } };
  assert.deepEqual(converted.generationConfig.thinkingConfig, { thinkingLevel: "high" });
});

test("a non-Gemini target still gets the level normalized to a budget", async () => {
  const converted = await pipelineRequest({ thinkingLevel: "low" }, FORMATS.OPENAI);
  assert.equal("thinkingLevel" in converted, false);
  assert.deepEqual(converted.thinking, { type: "enabled", budget_tokens: 4096 });
});

test("operator thinking modes still override a client level", async () => {
  setThinkingBudgetConfig({ mode: ThinkingMode.AUTO });
  assert.deepEqual(await pipelineThinking({ thinkingLevel: "high" }), {
    thinkingLevel: "minimal",
    includeThoughts: true,
  });

  setThinkingBudgetConfig({ mode: ThinkingMode.CUSTOM, customBudget: 512 });
  assert.deepEqual(await pipelineThinking({ thinkingLevel: "high" }), {
    thinkingLevel: "low",
    includeThoughts: true,
  });

  setThinkingBudgetConfig({ mode: ThinkingMode.ADAPTIVE, effortLevel: "high" });
  assert.deepEqual(await pipelineThinking({ thinkingLevel: "low" }), {
    thinkingLevel: "low",
    includeThoughts: true,
  });
});

function reasoningRule(effortMode: string, targetEffort: string, budgetAction: string) {
  return {
    _omnirouteReasoningRule: {
      id: "rule-1",
      effortMode,
      targetEffort,
      budgetAction,
      budgetTokens: budgetAction === "set" ? 20000 : null,
    },
  };
}

function clientLevelSpellings(thinkingLevel: string): Record<string, unknown>[] {
  return [
    { thinkingLevel },
    { thinking_level: thinkingLevel },
    { generationConfig: { thinkingConfig: { thinkingLevel } } },
    { generationConfig: { thinking_config: { thinkingLevel } } },
  ];
}

// chatCore applies the directive before translation and keeps it on the body for
// translateRequest, so a forced rule clears a top-level level before any budget exists.
async function chatCoreThinking(
  rule: Record<string, unknown>,
  request: Record<string, unknown>
): Promise<NativeThinkingConfig> {
  const applied = applyReasoningRuleDirective({ ...rule, ...request }) as Record<string, unknown>;
  return pipelineThinking({ ...applied, ...rule });
}

test("a forced reasoning rule beats a client level in every spelling", async () => {
  for (const clientLevel of clientLevelSpellings("high")) {
    const rule = reasoningRule("force", "low", "preserve");
    assert.deepEqual(await chatCoreThinking(rule, clientLevel), {
      thinkingLevel: "low",
      includeThoughts: true,
    });
  }
});

test("a rule that sets the budget beats a client level in every spelling", async () => {
  for (const clientLevel of clientLevelSpellings("low")) {
    const rule = reasoningRule("inherit", "low", "set");
    assert.deepEqual(await pipelineThinking({ ...rule, ...clientLevel }), {
      thinkingLevel: "high",
      includeThoughts: true,
    });
  }
});

test("a rule that sets the budget beats client effort in every spelling", async () => {
  const rule = reasoningRule("inherit", "low", "set");
  for (const clientEffort of [
    { reasoning_effort: "low" },
    { reasoning: { effort: "low" } },
    { reasoning_effort: "none" },
  ]) {
    assert.deepEqual(await pipelineThinking({ ...rule, ...clientEffort }), {
      thinkingLevel: "high",
      includeThoughts: true,
    });
  }
});

test("a rule that sets a zero budget turns thinking off despite client effort", async () => {
  const rule = reasoningRule("inherit", "low", "set");
  rule._omnirouteReasoningRule.budgetTokens = 0;
  assert.deepEqual(await pipelineThinking({ ...rule, reasoning_effort: "high" }), {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
});

test("a rule that removes the budget drops a client level in every spelling", async () => {
  for (const clientLevel of clientLevelSpellings("high")) {
    const rule = reasoningRule("inherit", "high", "remove");
    assert.deepEqual(await pipelineThinking({ ...rule, ...clientLevel }), {
      thinkingLevel: "minimal",
      includeThoughts: true,
    });
  }
});

test("a rule that leaves effort and budget alone keeps the client level", async () => {
  for (const clientLevel of clientLevelSpellings("high")) {
    for (const rule of [
      reasoningRule("default", "low", "preserve"),
      reasoningRule("inherit", "high", "preserve"),
    ]) {
      assert.equal((await pipelineThinking({ ...rule, ...clientLevel })).thinkingLevel, "high");
    }
  }
});

test("models without native levels keep forwarding the level verbatim", async () => {
  const forwarded = async (level: string) => {
    const converted = (await openaiToGeminiRequest(
      "gemini-3.1-pro-preview",
      {
        messages: [{ role: "user", content: "Reply exactly OK" }],
        generationConfig: { thinkingConfig: { thinkingLevel: level } },
      },
      false
    )) as unknown as { generationConfig: { thinkingConfig?: NativeThinkingConfig } };
    return converted.generationConfig.thinkingConfig;
  };
  assert.deepEqual(await forwarded("bogus"), { includeThoughts: true, thinkingLevel: "bogus" });
  assert.deepEqual(await forwarded("HIGH"), { includeThoughts: true, thinkingLevel: "HIGH" });
});

test("claude -> gemini maps budgets and effort to native levels", async () => {
  const budget = (budget_tokens: number) => ({ thinking: { type: "enabled", budget_tokens } });
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["budget 512", budget(512), "low"],
    ["budget 2048", budget(2048), "medium"],
    ["budget 32768", budget(32768), "high"],
    ["effort low", { output_config: { effort: "low" } }, "low"],
    ["effort HIGH", { output_config: { effort: "HIGH" } }, "high"],
    ["effort max", { output_config: { effort: "max" } }, "high"],
    ["budget over effort", { ...budget(512), output_config: { effort: "high" } }, "low"],
    ["explicit over budget", { ...budget(512), thinkingLevel: "high" }, "high"],
  ];
  for (const [name, request, level] of cases) {
    assert.deepEqual(
      await claudeThinking(request),
      { thinkingLevel: level, includeThoughts: true },
      name
    );
  }
});

test("claude -> gemini leaves a request with no positive control to the upstream default", async () => {
  assert.equal(await claudeThinking({}), undefined);
  assert.equal(await claudeThinking({ output_config: { effort: "none" } }), undefined);
  assert.deepEqual(await claudeThinking({ thinking: { type: "enabled", budget_tokens: 0 } }), {
    includeThoughts: true,
  });
});

test("translateRequest keeps an explicit level on a Claude-format request", async () => {
  const converted = (await pipelineRequest(
    { thinkingLevel: "low", thinking: { type: "enabled", budget_tokens: 32768 } },
    FORMATS.GEMINI,
    FORMATS.CLAUDE
  )) as { generationConfig: { thinkingConfig?: NativeThinkingConfig } };
  assert.deepEqual(converted.generationConfig.thinkingConfig, {
    thinkingLevel: "low",
    includeThoughts: true,
  });
});

test("Claude -> Antigravity carries the level as a budget through the OpenAI hub", async () => {
  const converted = (await pipelineRequest(
    { thinkingLevel: "high" },
    FORMATS.ANTIGRAVITY,
    FORMATS.CLAUDE
  )) as { request: { generationConfig: { thinkingConfig?: NativeThinkingConfig } } };
  assert.deepEqual(converted.request.generationConfig.thinkingConfig, {
    thinkingLevel: "high",
    includeThoughts: true,
  });
});

test("claude -> gemini leaves models without native levels on the budget path", async () => {
  assert.deepEqual(
    await claudeThinking(
      { thinking: { type: "enabled", budget_tokens: 2048 } },
      "gemini-flash-lite-latest"
    ),
    { thinkingBudget: 2048, includeThoughts: true }
  );
});
