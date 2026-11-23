// Target filtering of handleComboChat: context-window and context-override compatibility, vision
// and tool capability fail-closed filters, and the combo pre-screen. Merged from seven files so
// the combo.ts module graph loads once; each original file is one `describe` below, named after
// the file it came from.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-target-filtering-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-target-filtering-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../../src/lib/modelsDevSync.ts");
const { filterTargetsByRequestCompatibility, handleComboChat } =
  await import("../../../open-sse/services/combo.ts");
const { describeCapabilityFilterExhaustion, providerSupportsEmulatedToolCalling } =
  await import("../../../open-sse/services/combo/comboStructure.ts");
const { resolveAutoStrategyOrder } =
  await import("../../../open-sse/services/combo/resolveAutoStrategy.ts");
const { evaluateContextLimit } =
  await import("../../../open-sse/services/combo/contextOverrideGate.ts");
const { estimateTokens } = await import("../../../open-sse/services/contextManager.ts");
const { setModelContextOverride, removeModelContextOverride } =
  await import("../../../src/lib/db/modelContextOverrides.ts");
const { getResolvedModelCapabilities } = await import("../../../src/lib/modelCapabilities.ts");
const { comboRuntimeConfigSchema } =
  await import("../../../src/shared/validation/schemas/combo.ts");
const { resetAllComboMetrics } = await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearAllModelLockouts } = await import("../../../open-sse/services/accountFallback.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../../open-sse/services/rateLimitSemaphore.ts");
const { _resetAllDecks } = await import("../../../src/shared/utils/shuffleDeck.ts");

// Each source file used to start in a fresh process; every describe starts from a clean DB
// (synced capabilities, context overrides, combos) and clean in-memory combo state.
async function resetSharedState() {
  await resetTestDb();
  await clearModelsDevCapabilities();
  await settingsDb.clearAllLKGP();
  resetAllComboMetrics();
  await resetAllCircuitBreakers();
  resetAllSemaphores();
  clearAllModelLockouts();
  _resetAllDecks();
}

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-context-window-filter", () => {
  // Regression tests for the context-aware combo compatibility filter.
  // Context metadata is advisory: known-fitting targets are preferred, while
  // unknown and catalog-too-small targets remain available for runtime fallback.
  before(resetSharedState);

  beforeEach(async () => {
    await clearModelsDevCapabilities();
  });

  function capabilityEntry(limitContext: number | null) {
    return {
      tool_call: true,
      reasoning: false,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: false,
      limit_context: limitContext,
      limit_input: limitContext,
      limit_output: 4096,
      interleaved_field: null,
    };
  }

  function capabilityEntryWithLimits(
    limitInput: number | null,
    limitContext: number | null,
    limitOutput = 4096
  ) {
    return {
      ...capabilityEntry(limitContext),
      limit_input: limitInput,
      limit_output: limitOutput,
    };
  }

  function target(modelStr: string) {
    return {
      kind: "model" as const,
      stepId: modelStr,
      executionKey: modelStr,
      modelStr,
      provider: modelStr.includes("/") ? modelStr.split("/")[0] : modelStr,
      providerId: null,
      connectionId: null,
      weight: 1,
      label: null,
    };
  }

  function largeContextBody() {
    return {
      messages: [{ role: "user", content: "x".repeat(80_000) }],
    };
  }

  // Build a body whose input estimates to roughly `tokens` tokens. estimateTokens
  // is `ceil(charCount / 4)` over the JSON-serialized payload, so a run of
  // `tokens * 4` characters lands the estimate near `tokens` (the wrapper is
  // negligible at this scale).
  function bigContextBody(tokens: number) {
    return {
      messages: [{ role: "user", content: "x".repeat(tokens * 4) }],
    };
  }

  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

  test("known compatible context target is preferred while unknown targets remain fallback", async () => {
    await saveModelsDevCapabilities({
      "unit-known-context": {
        tiny: capabilityEntry(8_000),
        million: capabilityEntry(1_000_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [
        target("unit-unknown-context/mystery-a"),
        target("unit-known-context/tiny"),
        target("unit-known-context/million"),
        target("unit-unknown-context/mystery-b"),
      ],
      largeContextBody(),
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      [
        "unit-known-context/million",
        "unit-unknown-context/mystery-a",
        "unit-known-context/tiny",
        "unit-unknown-context/mystery-b",
      ]
    );
  });

  test("unknown-context targets keep strategy order when no known limit was rejected", async () => {
    await saveModelsDevCapabilities({
      "unit-known-context": {
        million: capabilityEntry(1_000_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-unknown-context/mystery-a"), target("unit-known-context/million")],
      { messages: [{ role: "user", content: "hello" }] },
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-unknown-context/mystery-a", "unit-known-context/million"]
    );
  });

  test("unknown-context targets do not become the only survivors when no known-compatible context target exists", async () => {
    await saveModelsDevCapabilities({
      "unit-known-context": {
        tiny: capabilityEntry(8_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [
        target("unit-unknown-context/mystery-a"),
        target("unit-known-context/tiny"),
        target("unit-unknown-context/mystery-b"),
      ],
      largeContextBody(),
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      [
        "unit-unknown-context/mystery-a",
        "unit-known-context/tiny",
        "unit-unknown-context/mystery-b",
      ]
    );
  });

  test("all known-too-small context targets still fall back to strategy order", async () => {
    await saveModelsDevCapabilities({
      "unit-known-context": {
        tiny: capabilityEntry(8_000),
        small: capabilityEntry(16_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-known-context/tiny"), target("unit-known-context/small")],
      largeContextBody(),
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-known-context/tiny", "unit-known-context/small"]
    );
  });

  test("output-token limits remain a hard compatibility requirement", async () => {
    await saveModelsDevCapabilities({
      "unit-output-limit": {
        insufficient: capabilityEntryWithLimits(128_000, 128_000, 128),
        sufficient: capabilityEntryWithLimits(128_000, 128_000, 4_096),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-output-limit/insufficient"), target("unit-output-limit/sufficient")],
      { messages: [{ role: "user", content: "hello" }], max_tokens: 512 },
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-output-limit/sufficient"]
    );
  });

  test("combo dispatches requests that only an approximate estimate marks oversized", async () => {
    await saveModelsDevCapabilities({
      "unit-known-context": {
        tiny: capabilityEntry(8_000),
        small: capabilityEntry(16_000),
      },
    });
    let dispatches = 0;

    const response = await handleComboChat({
      body: largeContextBody(),
      combo: {
        name: "known-context-overflow",
        strategy: "priority",
        models: ["unit-known-context/tiny", "unit-known-context/small"],
      },
      handleSingleModel: async () => {
        dispatches += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      log: noopLog,
    });

    assert.equal(response.status, 200);
    assert.equal(dispatches, 1);
  });

  test("round-robin dispatches requests that only an approximate estimate marks oversized", async () => {
    await saveModelsDevCapabilities({
      "unit-known-context": {
        tiny: capabilityEntry(8_000),
        small: capabilityEntry(16_000),
      },
    });
    let dispatches = 0;

    const response = await handleComboChat({
      body: largeContextBody(),
      combo: {
        name: "known-context-overflow-round-robin",
        strategy: "round-robin",
        models: ["unit-known-context/tiny", "unit-known-context/small"],
      },
      handleSingleModel: async () => {
        dispatches += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      log: noopLog,
    });

    assert.equal(response.status, 200);
    assert.equal(dispatches, 1);
  });

  test("native Responses context reaches an all-Codex target beyond its catalog hint (#8932)", async () => {
    await saveModelsDevCapabilities({
      codex: {
        large: capabilityEntry(272_000),
      },
    });
    let dispatches = 0;

    const response = await handleComboChat({
      body: bigContextBody(275_000),
      combo: {
        name: "native-codex-overflow",
        strategy: "priority",
        models: ["codex/large"],
      },
      clientManagedResponsesContext: true,
      isModelAvailable: async () => true,
      handleSingleModel: async () => {
        dispatches += 1;
        return new Response("ok", { status: 200 });
      },
      log: noopLog,
    });

    assert.notEqual(response.status, 400);
    assert.equal(dispatches, 1);
  });

  test("input-only maxInputTokens is not double-counted against the output reserve (#7039)", async () => {
    // Faithful reproduction of #7039 (Codex gpt-5.5-xhigh):
    //   maxInputTokens = 272_000, contextWindow = 400_000, maxOutputTokens = 128_000
    // With max_tokens = 32_000 the OLD code required
    //   maxInputTokens >= estimatedInputTokens + 32_000
    // i.e. it allowed only ~240K of input against a real 272K input cap — the
    // output reserve was double-counted against an already input-only cap. Here
    // the input (~256K tokens) sits between the buggy allowance (240K) and the
    // real cap (272K): the fix keeps the target, the bug drops it.
    await saveModelsDevCapabilities({
      "unit-7039": {
        "codex-like": capabilityEntryWithLimits(272_000, 400_000, 128_000),
        huge: capabilityEntryWithLimits(1_000_000, 1_000_000, 500_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-7039/codex-like"), target("unit-7039/huge")],
      { ...bigContextBody(256_000), max_tokens: 32_000 },
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-7039/codex-like", "unit-7039/huge"]
    );
  });

  test("small input-only maxInputTokens keeps a target whose input fits even though output reserve would overflow the cap (#7039)", async () => {
    // A second, lightweight reproduction: with maxInputTokens = 100 the input-only
    // cap comfortably holds the ~11-token input, but the old code compared it
    // against input + output (~411) and rejected the target. The fix keeps it.
    await saveModelsDevCapabilities({
      "unit-7039-small": {
        "input-capped": capabilityEntryWithLimits(100, 1_000_000, 500),
        huge: capabilityEntryWithLimits(1_000_000, 1_000_000, 500_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-7039-small/input-capped"), target("unit-7039-small/huge")],
      { messages: [{ role: "user", content: "hello" }], max_tokens: 400 },
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-7039-small/input-capped", "unit-7039-small/huge"]
    );
  });

  test("input-only maxInputTokens is demoted when the input itself exceeds the cap", async () => {
    // #8944 made context metadata ADVISORY: a catalog-too-small target is no longer
    // removed (a stale catalog entry must never delete the only target that could
    // accept the request at runtime), it is ordered AFTER the known-fitting ones.
    // `too-small` has maxInputTokens = 1, which cannot hold the ~11-token input, so
    // it must lose the ordering to `huge` while remaining available as a fallback.
    await saveModelsDevCapabilities({
      "unit-7039-too-small": {
        "too-small": capabilityEntryWithLimits(1, 1_000_000, 500),
        huge: capabilityEntryWithLimits(1_000_000, 1_000_000, 500_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-7039-too-small/too-small"), target("unit-7039-too-small/huge")],
      { messages: [{ role: "user", content: "hello" }], max_tokens: 400 },
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-7039-too-small/huge", "unit-7039-too-small/too-small"]
    );
  });

  test("maxInputTokens defaulting to contextWindow is demoted when input + output exceeds the total window (#7039 follow-up)", async () => {
    // Shared-window model where maxInputTokens equals the total window size. The
    // input alone fits the input cap but input + output overflows the window, so the
    // target must not be PREFERRED — since #8944 it is demoted rather than dropped.
    await saveModelsDevCapabilities({
      "unit-7039-window": {
        "shared-window": capabilityEntryWithLimits(400_000, 400_000, 200_000),
        huge: capabilityEntryWithLimits(1_000_000, 1_000_000, 500_000),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-7039-window/shared-window"), target("unit-7039-window/huge")],
      { messages: [{ role: "user", content: "x".repeat(350_000 * 4) }], max_tokens: 100_000 },
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-7039-window/huge", "unit-7039-window/shared-window"]
    );
  });

  // A persisted model_context_override (Feature 5004 — operator-set or
  // auto-discovered) reflects a target's real usable window and must win over the
  // static catalog limit for server-side routing. Otherwise a provider whose
  // catalog `maxInputTokens` is a deliberately smaller client-facing hint (set
  // below the true window so coding agents auto-compact, #6191) gets wrongly
  // dropped for large-context requests, collapsing the fallback pool.
  test("model_context_override lets a small-catalog target survive a large-context request", async () => {
    await saveModelsDevCapabilities({
      "unit-override": {
        big: capabilityEntry(1_000_000),
        capped: capabilityEntry(8_000),
      },
    });
    await setModelContextOverride("unit-override", "capped", 1_000_000);
    try {
      const out = await filterTargetsByRequestCompatibility(
        [target("unit-override/capped"), target("unit-override/big")],
        largeContextBody(),
        noopLog
      );
      assert.deepEqual(out.map((entry) => entry.modelStr).sort(), [
        "unit-override/big",
        "unit-override/capped",
      ]);
    } finally {
      await removeModelContextOverride("unit-override", "capped");
    }
  });

  // #8944: "dropped" became "demoted" — the small-catalog target survives as a
  // runtime fallback but must never outrank the one whose known limit fits.
  test("without an override the small-catalog target is ordered last for the large request", async () => {
    await saveModelsDevCapabilities({
      "unit-override": {
        big: capabilityEntry(1_000_000),
        capped: capabilityEntry(8_000),
      },
    });
    // No override: capped (8K) is catalog-too-small, so it stays behind the
    // known-compatible target while remaining available as a runtime fallback.
    const out = await filterTargetsByRequestCompatibility(
      [target("unit-override/capped"), target("unit-override/big")],
      largeContextBody(),
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-override/big", "unit-override/capped"]
    );
  });

  // #12273: real Claude Code requests always carry `tools`, and the auto/coding
  // pool mixes coding-capable providers with providers whose catalog marks
  // toolCalling=false. Those non-coding targets are HARD-rejected (tools), so the
  // compat filter can collapse the whole pool to a single too-small-context
  // coding model (e.g. mimo-v2.5-free at 200k) for a much larger request — the
  // larger-context model was never assembled into the candidate pool. Routing to
  // that sole survivor is a guaranteed context_length_exceeded, so the filter
  // must fall back to the full pool instead of silently pinning the request.
  test("#12273 single known-too-small survivor falls back to the full pool", async () => {
    await saveModelsDevCapabilities({
      "unit-collapse": {
        small: capabilityEntry(200_000),
      },
      "unit-noncoding": {
        nocoder: { ...capabilityEntry(1_000_000), tool_call: false },
      },
    });
    const body = {
      ...bigContextBody(300_000),
      tools: [{ type: "function" }], // Claude Code always sends tools
    };

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-collapse/small"), target("unit-noncoding/nocoder")],
      body,
      noopLog
    );

    // nocoder is hard-rejected (toolCalling=false); small (200k) is the only
    // compatible survivor but is known to be too small for a 300k request, so the
    // filter returns the full pool rather than dispatch to a guaranteed failure.
    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-collapse/small", "unit-noncoding/nocoder"]
    );
  });

  // Guard against regression: when the single survivor's window DOES fit the
  // request, the filter still collapses (existing behavior preserved).
  test("#12273 single compatible target that fits is still collapsed", async () => {
    await saveModelsDevCapabilities({
      "unit-collapse": {
        big: capabilityEntry(1_000_000),
      },
      "unit-noncoding": {
        nocoder: { ...capabilityEntry(1_000_000), tool_call: false },
      },
    });
    const body = {
      ...bigContextBody(300_000),
      tools: [{ type: "function" }],
    };

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-collapse/big"), target("unit-noncoding/nocoder")],
      body,
      noopLog
    );

    // big (1M) fits the 300k request, so the collapse is legitimate.
    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-collapse/big"]
    );
  });

  // #12278: unknown context is advisory, not "known too small". Collapsing to a
  // single survivor whose context limit is unknown must NOT restore hard-rejected
  // targets (output_tokens here; vision is covered by combo-vision-aware-routing).
  test("#12273 unknown-context sole survivor does not restore hard-rejected targets", async () => {
    await saveModelsDevCapabilities({
      "unit-output": {
        tiny: capabilityEntryWithLimits(128_000, 128_000, 4096),
      },
    });
    const body = {
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 32_000,
    };

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-unknown/mystery"), target("unit-output/tiny")],
      body,
      noopLog
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-unknown/mystery"]
    );
  });

  // Opt-in `outputLimitAdvisory`: a known output ceiling below `max_tokens` keeps a
  // target in its strategy position instead of removing it. Clients such as Claude Code send max_tokens as a
  // generous ceiling (128000), which otherwise strips every 64k-output model.
  test("outputLimitAdvisory keeps output-limited targets in strategy order instead of removing them", async () => {
    await saveModelsDevCapabilities({
      "unit-output-limit": {
        insufficient: capabilityEntryWithLimits(128_000, 128_000, 128),
        sufficient: capabilityEntryWithLimits(128_000, 128_000, 4_096),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-output-limit/insufficient"), target("unit-output-limit/sufficient")],
      { messages: [{ role: "user", content: "hello" }], max_tokens: 512 },
      noopLog,
      undefined,
      { outputLimitAdvisory: true }
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-output-limit/insufficient", "unit-output-limit/sufficient"]
    );
  });

  test("outputLimitAdvisory keeps strategy order when every target is output-limited", async () => {
    await saveModelsDevCapabilities({
      "unit-output-limit": {
        a: capabilityEntryWithLimits(128_000, 128_000, 128),
        b: capabilityEntryWithLimits(128_000, 128_000, 256),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-output-limit/a"), target("unit-output-limit/b")],
      { messages: [{ role: "user", content: "hello" }], max_tokens: 512 },
      noopLog,
      undefined,
      { outputLimitAdvisory: true }
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-output-limit/a", "unit-output-limit/b"]
    );
  });

  test("outputLimitAdvisory does not soften tool-calling mismatches", async () => {
    await saveModelsDevCapabilities({
      "unit-output-limit": {
        notools: { ...capabilityEntryWithLimits(128_000, 128_000, 4_096), tool_call: false },
        tools: capabilityEntryWithLimits(128_000, 128_000, 128),
      },
    });

    const out = await filterTargetsByRequestCompatibility(
      [target("unit-output-limit/notools"), target("unit-output-limit/tools")],
      {
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 512,
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      noopLog,
      undefined,
      { outputLimitAdvisory: true }
    );

    assert.deepEqual(
      out.map((entry) => entry.modelStr),
      ["unit-output-limit/tools"]
    );
  });

  test("combo config outputLimitAdvisory keeps an output-limited target in its priority slot", async () => {
    await saveModelsDevCapabilities({
      // Separate providers: a 503 from one provider must not skip the other.
      "unit-output-a": { insufficient: capabilityEntryWithLimits(128_000, 128_000, 128) },
      "unit-output-b": { sufficient: capabilityEntryWithLimits(128_000, 128_000, 4_096) },
    });
    const run = async (config?: Record<string, unknown>) => {
      const calls: string[] = [];
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "hello" }], max_tokens: 512 },
        combo: {
          name: "output-limit-advisory",
          strategy: "priority",
          models: ["unit-output-a/insufficient", "unit-output-b/sufficient"],
          ...(config ? { config } : {}),
        },
        handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
          calls.push(modelStr);
          const ok = modelStr.endsWith("/insufficient");
          return new Response(
            JSON.stringify(ok ? { choices: [{ message: { content: "ok" } }] } : { error: "down" }),
            { status: ok ? 200 : 503, headers: { "Content-Type": "application/json" } }
          );
        },
        log: noopLog,
      });
      return { status: response.status, calls };
    };

    // The failing target may be retried, so assert on which targets are reached.
    const strict = await run();
    assert.notEqual(strict.status, 200);
    assert.ok(!strict.calls.includes("unit-output-a/insufficient"));

    const advisory = await run({ outputLimitAdvisory: true });
    assert.equal(advisory.status, 200);
    // Operator priority wins: the output-limited first step is tried first.
    assert.deepEqual(advisory.calls, ["unit-output-a/insufficient"]);
  });

  test("combo config schema accepts boolean outputLimitAdvisory and rejects other types", async () => {
    assert.equal(comboRuntimeConfigSchema.safeParse({ outputLimitAdvisory: true }).success, true);
    assert.equal(comboRuntimeConfigSchema.safeParse({ outputLimitAdvisory: "yes" }).success, false);
  });
});

describe("combo-prescreen", () => {
  before(resetSharedState);

  function okResponse(model: string) {
    return Response.json({ choices: [{ message: { role: "assistant", content: model } }] });
  }

  function makeLog() {
    return {
      info() {},
      warn() {},
      debug() {},
      error() {},
    };
  }

  const reqBody = {
    model: "prescreen-test",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  };

  test("pre-screen: all targets checked in parallel", async () => {
    const checkOrder: string[] = [];

    const combo = await combosDb.createCombo({
      name: "prescreen-parallel",
      strategy: "priority",
      models: ["p1/m1", "p2/m2", "p3/m3"],
    });

    const response = await handleComboChat({
      body: { ...reqBody, model: combo.name },
      combo,
      allCombos: [combo],
      isModelAvailable: async (modelStr: string) => {
        checkOrder.push(modelStr);
        return true;
      },
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        return okResponse(modelStr);
      },
    });

    assert.equal(response.status, 200);
    assert.ok(checkOrder.length >= 3, "pre-screen must check all 3 targets concurrently");
  });

  test("pre-screen: unavailable targets are skipped", async () => {
    const calls: string[] = [];
    const availability = new Map([
      ["p1/m1", false],
      ["p2/m2", true],
      ["p3/m3", true],
    ]);

    const combo = await combosDb.createCombo({
      name: "prescreen-skip",
      strategy: "priority",
      models: ["p1/m1", "p2/m2", "p3/m3"],
    });

    const response = await handleComboChat({
      body: { ...reqBody, model: combo.name },
      combo,
      allCombos: [combo],
      isModelAvailable: async (modelStr: string) => {
        return availability.get(modelStr) ?? true;
      },
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse(modelStr);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "p2/m2");
  });

  test("pre-screen: failure treated as unknown availability", async () => {
    const calls: string[] = [];
    let checkCount = 0;

    const combo = await combosDb.createCombo({
      name: "prescreen-failure",
      strategy: "priority",
      models: ["p1/m1", "p2/m2"],
    });

    const response = await handleComboChat({
      body: { ...reqBody, model: combo.name },
      combo,
      allCombos: [combo],
      isModelAvailable: async (modelStr: string) => {
        checkCount++;
        if (checkCount === 1) {
          throw new Error("DB connection failed");
        }
        return true;
      },
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse(modelStr);
      },
    });

    assert.equal(response.status, 200);
    // m1 pre-screen failed (treated as available), m2 pre-screen succeeded
    // Both should be tried, m1 first since it's available
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "p1/m1");
  });

  test("pre-screen: only runs for priority strategy", async () => {
    const checkOrder: string[] = [];

    const combo = await combosDb.createCombo({
      name: "prescreen-strategy",
      strategy: "round-robin",
      models: ["p1/m1", "p2/m2"],
    });

    const response = await handleComboChat({
      body: { ...reqBody, model: combo.name },
      combo,
      allCombos: [combo],
      isModelAvailable: async (modelStr: string) => {
        checkOrder.push(modelStr);
        return true;
      },
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        return okResponse(modelStr);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(checkOrder.length >= 1, true);
  });

  test("pre-screen: backward compatible with all targets available", async () => {
    const calls: string[] = [];

    const combo = await combosDb.createCombo({
      name: "prescreen-compat",
      strategy: "priority",
      models: ["p1/m1", "p2/m2", "p3/m3"],
    });

    const response = await handleComboChat({
      body: { ...reqBody, model: combo.name },
      combo,
      allCombos: [combo],
      isModelAvailable: async () => true,
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse(modelStr);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "p1/m1");
  });

  test("priority combo: quota 429 on passthrough provider does not skip another model on same provider", async () => {
    const calls: string[] = [];

    const combo = await combosDb.createCombo({
      name: "passthrough-quota-scope",
      strategy: "priority",
      models: ["antigravity/claude-opus-4-6-thinking", "antigravity/gemini-3.7-flash-high"],
    });

    const response = await handleComboChat({
      body: { ...reqBody, model: combo.name },
      combo,
      allCombos: [combo],
      isModelAvailable: async () => true,
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        if (modelStr.includes("claude-opus")) {
          return Response.json(
            { error: { message: "quota exhausted for claude-opus-4-6-thinking" } },
            { status: 429 }
          );
        }
        return okResponse(modelStr);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(calls.at(-1), "antigravity/gemini-3.7-flash-high");
    assert.ok(
      calls.includes("antigravity/claude-opus-4-6-thinking"),
      "first passthrough model should be attempted before fallback"
    );
  });
});

describe("combo-13870-chars4-overdrops-override-primary", () => {
  // Repro for #13870: the combo context-fit compat filter (filterTargetsByRequestCompatibility)
  // uses the chars/4 estimate (estimateTokens) as the sole ground truth for ranking targets.
  // On a repetitive agent-session body, chars/4 overstates the real tokenizer count by ~3-4x
  // (issue measured 276,792 estimated vs 74,679 real for the same body). A user-defined combo
  // whose primary/fallback members carry manual model_context_overrides sized for the REAL
  // window (250k) gets those overrides evaluated against the inflated estimate, fail the
  // context check, and are demoted behind the emergency (899k catalog) member -- even though
  // the real request would have fit the primary with 3x headroom.
  before(resetSharedState);

  beforeEach(async () => {
    await clearModelsDevCapabilities();
  });

  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

  function target(modelStr: string) {
    return {
      kind: "model" as const,
      stepId: modelStr,
      executionKey: modelStr,
      modelStr,
      provider: modelStr.split("/")[0],
      providerId: null,
      connectionId: null,
      weight: 1,
      label: null,
    };
  }

  function capabilityEntry(limitContext: number | null) {
    return {
      tool_call: true,
      reasoning: false,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: false,
      limit_context: limitContext,
      limit_input: limitContext,
      limit_output: 65_536,
      interleaved_field: null,
    };
  }

  function repetitiveAgentBody() {
    const toolResultChunk =
      '{"tool_call_id":"call_abc123","role":"tool","content":"' +
      "line of repeated structured tool output ".repeat(160) +
      '"}';
    const messages = [];
    for (let i = 0; i < 400; i++) {
      messages.push({ role: i % 2 === 0 ? "assistant" : "tool", content: toolResultChunk });
    }
    const tools = Array.from({ length: 25 }, (_, i) => ({
      type: "function",
      function: { name: `tool_${i}`, description: "d".repeat(200), parameters: { type: "object" } },
    }));
    return { messages, tools, max_tokens: 32000 };
  }

  test("#13870: chars/4 overestimate demotes a real-fitting override primary behind the catalog emergency member", async () => {
    await saveModelsDevCapabilities({
      "unit-13870-primary": { model: capabilityEntry(null) },
      "unit-13870-fallback": { model: capabilityEntry(null) },
      "unit-13870-emergency": { model: capabilityEntry(899_153) },
      "unit-13870-small": { model: capabilityEntry(128_450) },
    });

    await setModelContextOverride("unit-13870-primary", "model", 250_000);
    await setModelContextOverride("unit-13870-fallback", "model", 250_000);

    try {
      const body = repetitiveAgentBody();

      const estimated = estimateTokens({ messages: body.messages, tools: body.tools });
      assert.ok(
        estimated > 250_000 - 32_000,
        `expected the chars/4 estimate to exceed the override window; got ${estimated}`
      );

      const targets = [
        target("unit-13870-primary/model"),
        target("unit-13870-fallback/model"),
        target("unit-13870-emergency/model"),
        target("unit-13870-small/model"),
      ];

      const out = await filterTargetsByRequestCompatibility(targets, body, noopLog);

      assert.equal(
        out[0].modelStr,
        "unit-13870-primary/model",
        `expected the real-fitting override primary to stay first, but the inflated ` +
          `chars/4 estimate promoted "${out[0].modelStr}" ahead of it -- this is the ` +
          `"collapse to the emergency member" reported in #13870`
      );
    } finally {
      await removeModelContextOverride("unit-13870-primary", "model");
      await removeModelContextOverride("unit-13870-fallback", "model");
    }
  });
});

describe("14232-qwen-cloud-vision-leaves", () => {
  // Regression test for #14232 — `qwen-cloud-token-plan/qwen3.8-flash` and
  // `deepseek-v4.1-flash` accept images but had no registry entry, so every tier of the vision
  // cascade came up empty and the fail-closed combo compatibility filter (#8332) dropped them
  // from image requests, leaving only a dead vision-flagged leaf and no fallback. Both are
  // vision-capable per Alibaba's model pages.
  before(resetSharedState);

  test("#14232 qwen-cloud-token-plan image-accepting leaves resolve as vision-capable", async () => {
    for (const id of [
      "qwen-cloud-token-plan/qwen3.8-flash",
      "qwen-cloud-token-plan/deepseek-v4.1-flash",
    ]) {
      const resolved = await getResolvedModelCapabilities(id);
      assert.equal(resolved.supportsVision, true, `${id} should be vision-capable`);
      assert.equal(resolved.reasoning, true, `${id} should be a reasoning model`);
    }
  });

  const target = (modelStr: string) => ({
    kind: "model" as const,
    stepId: modelStr,
    executionKey: modelStr,
    modelStr,
    provider: modelStr.split("/")[0],
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  });
  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
  const imageBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "ok" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
    ],
  };

  test("#14232 an image request keeps the qwen-cloud-token-plan leaf in the combo pool", async () => {
    const kept = (
      await filterTargetsByRequestCompatibility(
        [target("qwen-cloud-token-plan/qwen3.8-flash"), target("groq/llama-3.1-8b-instant")],
        imageBody,
        noopLog
      )
    ).map((t) => t.modelStr);
    assert.equal(
      (await getResolvedModelCapabilities("groq/llama-3.1-8b-instant")).supportsVision,
      null
    );
    assert.deepEqual(
      kept,
      ["qwen-cloud-token-plan/qwen3.8-flash", "groq/llama-3.1-8b-instant"],
      "vision-confirmed leaf must stay first; unknown remains a last-resort fallback"
    );
  });
});

describe("8332-combo-vision-fallback", () => {
  // Regression guard for #8332: combo routing's #6238 last-resort compat-fallback tier
  // dispatched an image_url-bearing request to a text-only (vision-incapable) target.
  // filterTargetsByRequestCompatibility correctly rejects such targets up front
  // (comboStructure.ts), but the round-robin path rebuilt its rejected set from the raw
  // evalRankedTargets list (discarding the per-target rejection reasons), so
  // `attemptCompatRejectedFallback` reconsidered a vision-rejected target exactly like any other
  // compat-rejected-but-healthy target and sent it the unmodified image body — producing the
  // upstream `400: unknown variant "image_url", expected "text"`.
  //
  // The fix makes vision a hard capability requirement for the fallback tier: a target rejected
  // because it cannot confirm vision support must never be reconsidered, even as a last resort.
  function createLog() {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  function okResponse(body: unknown = { choices: [{ message: { content: "ok" } }] }) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function capabilityEntry(limitContext: unknown, overrides: Record<string, unknown> = {}) {
    return {
      tool_call: true,
      reasoning: false,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: false,
      limit_context: limitContext,
      limit_input: limitContext,
      limit_output: 4096,
      interleaved_field: null,
      ...overrides,
    };
  }

  const imageRequestBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
  };

  beforeEach(resetSharedState);

  after(async () => {
    await resetSharedState();
  });

  test(
    "round-robin last-resort compat fallback never dispatches an image_url request " +
      "to a vision-incapable target (#8332)",
    async () => {
      // rr-blind is text-only (attachment:false -> supportsVision:false) -> the
      // vision-requiring request makes the compat pre-filter reject it. rr-vision-a
      // and rr-vision-b are vision-capable -> kept, but both are simulated
      // runtime-unavailable, forcing recordedAttempts === 0 and triggering the
      // #6238 last-resort tier. Only the vision-rejected rr-blind is "healthy".
      await saveModelsDevCapabilities({
        openai: {
          "rr-blind": capabilityEntry(128000, { attachment: false }),
          "rr-vision-a": capabilityEntry(128000, { attachment: true }),
          "rr-vision-b": capabilityEntry(128000, { attachment: true }),
        },
      });

      const attempted: string[] = [];

      const result = await handleComboChat({
        body: imageRequestBody,
        combo: {
          name: "rr-compat-fallback-8332-vision",
          strategy: "round-robin",
          models: ["openai/rr-blind", "openai/rr-vision-a", "openai/rr-vision-b"],
          config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
        },
        handleSingleModel: async (_body, modelStr) => {
          attempted.push(modelStr);
          return okResponse({ choices: [{ message: { content: `served by ${modelStr}` } }] });
        },
        // Only the vision-rejected rr-blind is "available"; the vision-capable
        // compat-kept targets are all runtime-unavailable.
        isModelAvailable: async (modelStr) => modelStr === "openai/rr-blind",
        log: createLog(),
        settings: null,
        relayOptions: null,
        allCombos: null,
      });

      // Before the fix, rr-blind (vision-incapable but "available") was dispatched
      // the raw image_url body as the #6238 last-resort fallback. After the fix it
      // must never be attempted, and since no other target is available, the combo
      // must surface its normal exhaustion error instead of a corrupted 200.
      assert.deepEqual(
        attempted,
        [],
        "vision-incapable rr-blind must never receive the image_url body, even as a last-resort fallback"
      );
      assert.notEqual(
        result.status,
        200,
        "must not silently succeed via the vision-incapable target"
      );
    }
  );

  test(
    "round-robin last-resort compat fallback still serves a healthy non-vision-rejected " +
      "target for an image request (#8332 — does not overcorrect #6238)",
    async () => {
      // rr-no-tools is tool-incapable (irrelevant here; no tools requested) but IS
      // vision-capable, so it is not rejected for vision. rr-vision-a is also
      // vision-capable and compat-kept, but runtime-unavailable, forcing the
      // #6238 last-resort tier. This proves the vision-only exclusion does not
      // also swallow legitimate non-vision-rejection fallback targets.
      await saveModelsDevCapabilities({
        openai: {
          "rr-vision-a": capabilityEntry(128000, { attachment: true }),
        },
      });

      const attempted: string[] = [];

      const result = await handleComboChat({
        body: imageRequestBody,
        combo: {
          name: "rr-compat-fallback-8332-sanity",
          strategy: "round-robin",
          models: ["openai/rr-vision-a"],
          config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
        },
        handleSingleModel: async (_body, modelStr) => {
          attempted.push(modelStr);
          return okResponse({ choices: [{ message: { content: `served by ${modelStr}` } }] });
        },
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        relayOptions: null,
        allCombos: null,
      });

      assert.equal(result.status, 200);
      assert.deepEqual(attempted, ["openai/rr-vision-a"]);
    }
  );
});

describe("8488-capability-filter-fail-closed", () => {
  // #8488 — capability filters fail closed when every candidate is incompatible.
  function capabilityEntry(limit_context: number, overrides: Record<string, unknown> = {}) {
    return {
      tool_call: null,
      reasoning: null,
      attachment: null,
      structured_output: null,
      temperature: null,
      modalities_input: "[]",
      modalities_output: "[]",
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: null,
      limit_context,
      limit_input: null,
      limit_output: null,
      interleaved_field: null,
      ...overrides,
    };
  }

  function target(provider: string, modelStr: string) {
    return {
      kind: "model" as const,
      stepId: "s1",
      executionKey: `${provider}>${modelStr}`,
      modelStr,
      provider,
      providerId: null,
      connectionId: null,
      weight: 1,
      label: null,
    };
  }

  const log = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  beforeEach(async () => {
    await resetSharedState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  test("#8488 filter: some tool-capable targets kept (unchanged)", async () => {
    await saveModelsDevCapabilities({
      openai: {
        "with-tools": capabilityEntry(128000, { tool_call: true }),
        "no-tools": capabilityEntry(128000, { tool_call: false }),
      },
    });

    const kept = await filterTargetsByRequestCompatibility(
      [target("openai", "openai/with-tools"), target("openai", "openai/no-tools")],
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      log
    );
    assert.deepEqual(
      kept.map((t) => t.modelStr),
      ["openai/with-tools"]
    );
  });

  test("#8488 filter: zero tool-capable targets → empty (fail closed)", async () => {
    await saveModelsDevCapabilities({
      openai: {
        "no-tools-a": capabilityEntry(128000, { tool_call: false }),
        "no-tools-b": capabilityEntry(128000, { tool_call: false }),
      },
    });

    const targets = [target("openai", "openai/no-tools-a"), target("openai", "openai/no-tools-b")];
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    };
    const kept = await filterTargetsByRequestCompatibility(targets, body, log);
    assert.equal(kept.length, 0);

    const exhaustion = await describeCapabilityFilterExhaustion(targets, body, "tools-combo");
    assert.ok(exhaustion);
    assert.match(exhaustion!.message, /supports tool calling/i);
    assert.equal(exhaustion!.terminalReason, "capability_mismatch");
    assert.ok(exhaustion!.excluded.some((e) => e.reason.includes("tools")));
  });

  test("#8488 filter: Gemini Web emulation stays eligible for tools (#5240)", async () => {
    // Registry honestly tags Gemini Web models toolCalling:false; the prompt
    // shim is what makes tools work. Fail-closed must not hard-reject them.
    assert.equal(providerSupportsEmulatedToolCalling("gemini-web"), true);
    assert.equal(providerSupportsEmulatedToolCalling("gweb"), true);
    assert.equal(providerSupportsEmulatedToolCalling("claude-web"), false); // toolCalling:"none"
    assert.equal(providerSupportsEmulatedToolCalling("openai"), false);

    const kept = await filterTargetsByRequestCompatibility(
      [
        target("gemini-web", "gemini-web/gemini-3.1-pro"),
        target("gemini-web", "gemini-web/gemini-3.7-flash"),
      ],
      {
        messages: [{ role: "user", content: "Use a tool." }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      log
    );
    assert.equal(kept.length, 2);
    assert.deepEqual(
      kept.map((t) => t.modelStr),
      ["gemini-web/gemini-3.1-pro", "gemini-web/gemini-3.7-flash"]
    );

    const exhaustion = await describeCapabilityFilterExhaustion(
      [
        target("gemini-web", "gemini-web/gemini-3.1-pro"),
        target("gemini-web", "gemini-web/gemini-3.7-flash"),
      ],
      {
        messages: [{ role: "user", content: "Use a tool." }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      "web-cookie-tools"
    );
    assert.equal(exhaustion, null, "emulation-capable pool must not report capability_mismatch");
  });

  test("#8488 auto: Gemini Web emulation survives tool pre-filter (#5240)", async () => {
    const result = await resolveAutoStrategyOrder({
      orderedTargets: [target("gemini-web", "gemini-web/gemini-3.1-pro")] as never,
      body: {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      combo: { id: "c1", name: "auto-web-cookie", config: {} } as never,
      settings: null,
      config: {},
      relayOptions: null,
      resilienceSettings: { quotaPreflight: { enabled: false } } as never,
      log: log as never,
      buildAutoCandidates: (async () => []) as never,
    });

    assert.ok(
      !("earlyResponse" in result),
      "must not 400 capability_mismatch for emulation providers"
    );
    if ("orderedTargets" in result) {
      assert.equal(result.orderedTargets.length, 1);
      assert.equal(result.orderedTargets[0].modelStr, "gemini-web/gemini-3.1-pro");
    }
  });

  test("#8488 filter: opt-in compatFilterFailOpen restores full pool", async () => {
    await saveModelsDevCapabilities({
      openai: {
        "no-tools-a": capabilityEntry(128000, { tool_call: false }),
        "no-tools-b": capabilityEntry(128000, { tool_call: false }),
      },
    });

    const kept = await filterTargetsByRequestCompatibility(
      [target("openai", "openai/no-tools-a"), target("openai", "openai/no-tools-b")],
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      log,
      "Context-aware fallback",
      { failOpen: true }
    );
    assert.equal(kept.length, 2);
  });

  test("#8488 filter: vision with no confirmed target → empty (fail closed)", async () => {
    await saveModelsDevCapabilities({
      openai: {
        "text-only": capabilityEntry(128000, { attachment: false, tool_call: true }),
      },
    });

    const kept = await filterTargetsByRequestCompatibility(
      [target("openai", "openai/text-only")],
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see?" },
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
            ],
          },
        ],
      },
      log
    );
    assert.equal(kept.length, 0);
  });

  test("#8488 auto: tool pre-filter fail closed returns early 400", async () => {
    await saveModelsDevCapabilities({
      openai: {
        "no-tools": capabilityEntry(128000, { tool_call: false }),
      },
    });

    const result = await resolveAutoStrategyOrder({
      orderedTargets: [target("openai", "openai/no-tools")] as never,
      body: {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      combo: { id: "c1", name: "auto-tools", config: {} } as never,
      settings: null,
      config: {},
      relayOptions: null,
      resilienceSettings: { quotaPreflight: { enabled: false } } as never,
      log: log as never,
      buildAutoCandidates: (async () => []) as never,
    });

    assert.ok("earlyResponse" in result);
    if ("earlyResponse" in result) {
      assert.equal(result.earlyResponse.status, 400);
      const body = await result.earlyResponse.json();
      assert.equal(body?.error?.code, "capability_mismatch");
      assert.match(String(body?.error?.message || ""), /supports tool calling/i);
    }
  });

  test("#8488 auto: tool pre-filter fail-open opt-in keeps full pool", async () => {
    await saveModelsDevCapabilities({
      openai: {
        "no-tools": capabilityEntry(128000, { tool_call: false }),
      },
    });

    const result = await resolveAutoStrategyOrder({
      orderedTargets: [target("openai", "openai/no-tools")] as never,
      body: {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      },
      combo: {
        id: "c1",
        name: "auto-tools-open",
        config: { compatFilterFailOpen: true },
      } as never,
      settings: null,
      config: { compatFilterFailOpen: true },
      relayOptions: null,
      resilienceSettings: { quotaPreflight: { enabled: false } } as never,
      log: log as never,
      buildAutoCandidates: (async () => []) as never,
    });

    assert.ok(!("earlyResponse" in result));
    if ("orderedTargets" in result) {
      assert.equal(result.orderedTargets.length, 1);
    }
  });

  test("auto context estimate still dispatches when all known limits look too small", async () => {
    await saveModelsDevCapabilities({
      openai: {
        tiny: capabilityEntry(100, { tool_call: true }),
      },
    });

    const hugePrompt = "x".repeat(4000); // ~1000 tokens at 4 chars/token
    const dispatches: string[] = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: hugePrompt }] },
      combo: { id: "c1", name: "auto-ctx", strategy: "auto", models: ["openai/tiny"] },
      handleSingleModel: async (_body, modelStr) => {
        dispatches.push(modelStr);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(dispatches, ["openai/tiny"]);
  });

  test("#12229 exhaustion: output_tokens exclusion names max_tokens vs the model ceiling", async () => {
    await saveModelsDevCapabilities({
      claude: {
        "claude-haiku-4-5-20251001": capabilityEntry(200000, {
          tool_call: true,
          structured_output: true,
          limit_output: 64000,
        }),
      },
    });

    const targets = [target("claude", "claude/claude-haiku-4-5-20251001")];
    const body = {
      messages: [{ role: "user", content: "hoi wie ben je?" }],
      max_tokens: 100000,
    };

    const exhaustion = await describeCapabilityFilterExhaustion(targets, body, "hermes-main");
    assert.ok(exhaustion);
    assert.deepEqual(exhaustion!.unmet, ["output_tokens"]);
    assert.equal(exhaustion!.excluded[0].reason, "output_tokens");
    assert.equal(
      exhaustion!.message,
      "No target in combo hermes-main can produce the requested max_tokens=100000; the highest known output limit in the pool is 64000"
    );
    assert.doesNotMatch(exhaustion!.message, /structured output/i);
    assert.equal(exhaustion!.terminalReason, "capability_mismatch");
  });

  // #14313 — an auto combo whose candidate pool is already empty. Off by default the empty
  // pool keeps the legacy 400 capability_mismatch; COMBO_EMPTY_POOL_NO_ELIGIBLE_TARGETS_ENABLED
  // turns it into a truthful 503 no_eligible_targets.
  function emptyPoolRequest() {
    return resolveAutoStrategyOrder({
      orderedTargets: [] as never,
      body: {
        messages: [{ role: "user", content: "hi" }],
        tools: Array.from({ length: 12 }, (_, i) => ({
          type: "function",
          function: { name: `lookup_${i}`, parameters: {} },
        })),
      },
      combo: { id: "c1", name: "auto/best-coding", config: {} } as never,
      settings: null,
      config: {},
      relayOptions: null,
      resilienceSettings: { quotaPreflight: { enabled: false } } as never,
      log: log as never,
      buildAutoCandidates: (async () => []) as never,
    });
  }

  test("#14313 auto: empty candidate pool keeps the legacy 400 with the flag off (default)", async () => {
    delete process.env.COMBO_EMPTY_POOL_NO_ELIGIBLE_TARGETS_ENABLED;
    const result = await emptyPoolRequest();
    assert.ok("earlyResponse" in result);
    if ("earlyResponse" in result) {
      assert.equal(result.earlyResponse.status, 400);
      const body = await result.earlyResponse.json();
      assert.match(String(body?.error?.message || ""), /supports tool calling/i);
      assert.equal(body?.error?.code, "capability_mismatch");
      assert.equal(body?.diagnostics?.terminalReason, "capability_mismatch");
    }
  });

  test("#14313 auto: empty candidate pool answers 503 no_eligible_targets with the flag on", async () => {
    process.env.COMBO_EMPTY_POOL_NO_ELIGIBLE_TARGETS_ENABLED = "true";
    try {
      const result = await emptyPoolRequest();
      assert.ok("earlyResponse" in result);
      if ("earlyResponse" in result) {
        assert.equal(result.earlyResponse.status, 503);
        const body = await result.earlyResponse.json();
        assert.doesNotMatch(String(body?.error?.message || ""), /supports tool calling/i);
        assert.match(String(body?.error?.message || ""), /candidate pool is empty/i);
        assert.equal(body?.error?.code, "no_eligible_targets");
        assert.equal(body?.diagnostics?.poolSize, 0);
        assert.equal(body?.diagnostics?.terminalReason, "no_eligible_targets");
      }
    } finally {
      delete process.env.COMBO_EMPTY_POOL_NO_ELIGIBLE_TARGETS_ENABLED;
    }
  });

  test("#14313 auto: the flag never fires on a populated pool (tool pre-filter still decides)", async () => {
    process.env.COMBO_EMPTY_POOL_NO_ELIGIBLE_TARGETS_ENABLED = "true";
    try {
      const result = await resolveAutoStrategyOrder({
        orderedTargets: [target("no-tools-provider", "no-tools-provider/model-x")] as never,
        body: {
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
        },
        combo: { id: "c1", name: "auto/best-coding", config: {} } as never,
        settings: null,
        config: {},
        relayOptions: null,
        resilienceSettings: { quotaPreflight: { enabled: false } } as never,
        log: log as never,
        buildAutoCandidates: (async () => []) as never,
      });
      if ("earlyResponse" in result) {
        const body = await result.earlyResponse.json();
        assert.notEqual(body?.error?.code, "no_eligible_targets");
      }
    } finally {
      delete process.env.COMBO_EMPTY_POOL_NO_ELIGIBLE_TARGETS_ENABLED;
    }
  });
});

describe("combo-effort-suffix-context-override-12475", () => {
  // #12475: effort-suffixed combo targets must inherit the base model's model_context_overrides
  // row. Without that, the compat filter falls back to the static catalog and inverts priority
  // order (Diego confirmed the chokepoint is resolveContextOverrideVerdict).
  before(resetSharedState);

  beforeEach(async () => {
    await clearModelsDevCapabilities();
  });

  const LARGE_REQ = {
    estimatedInputTokens: 300_000,
    requiredContextTokens: 348_000,
  };

  function capabilityEntry(limitContext: number) {
    return {
      tool_call: true,
      reasoning: false,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: false,
      limit_context: limitContext,
      limit_input: limitContext,
      limit_output: 4096,
      interleaved_field: null,
    };
  }

  function target(modelStr: string) {
    return {
      kind: "model" as const,
      stepId: modelStr,
      executionKey: modelStr,
      modelStr,
      provider: modelStr.includes("/") ? modelStr.split("/")[0] : modelStr,
      providerId: null,
      connectionId: null,
      weight: 1,
      label: null,
    };
  }

  function bigContextBody(tokens: number) {
    return {
      messages: [{ role: "user", content: "x".repeat(tokens * 4) }],
    };
  }

  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

  test("#12475 GLM-5.3-high inherits the GLM-5.3 override (catalog 200k would reject)", async () => {
    await setModelContextOverride("unit-12475", "GLM-5.3", 385_351);
    try {
      const verdict = await evaluateContextLimit(
        { maxInputTokens: 200_000, contextWindow: 200_000 },
        LARGE_REQ,
        "unit-12475/GLM-5.3-high"
      );
      assert.equal(verdict, true, "base override 385351 must fit 348k after stripping -high");
    } finally {
      await removeModelContextOverride("unit-12475", "GLM-5.3");
    }
  });

  test("#12475 GLM-5.2-high spec 1M must not shadow the GLM-5.2 override", async () => {
    await setModelContextOverride("unit-12475", "GLM-5.2", 128_450);
    try {
      const verdict = await evaluateContextLimit(
        { maxInputTokens: 1_000_000, contextWindow: 1_000_000 },
        LARGE_REQ,
        "unit-12475/GLM-5.2-high"
      );
      assert.equal(verdict, false, "base override 128450 must reject 348k even when spec says 1M");
    } finally {
      await removeModelContextOverride("unit-12475", "GLM-5.2");
    }
  });

  test("#12475 exact variant override still wins over the base row", async () => {
    await setModelContextOverride("unit-12475", "GLM-5.3", 385_351);
    await setModelContextOverride("unit-12475", "GLM-5.3-high", 10_000);
    try {
      const verdict = await evaluateContextLimit(
        { maxInputTokens: 200_000, contextWindow: 200_000 },
        LARGE_REQ,
        "unit-12475/GLM-5.3-high"
      );
      assert.equal(verdict, false, "an explicit GLM-5.3-high row must not inherit the larger base");
    } finally {
      await removeModelContextOverride("unit-12475", "GLM-5.3-high");
      await removeModelContextOverride("unit-12475", "GLM-5.3");
    }
  });

  test("#12475 xhigh / mixed-case suffix also inherit", async () => {
    await setModelContextOverride("unit-12475", "GLM-5.3-Flash", 899_153);
    try {
      const verdict = await evaluateContextLimit(
        { maxInputTokens: 200_000, contextWindow: 200_000 },
        LARGE_REQ,
        "unit-12475/GLM-5.3-Flash-xhigh"
      );
      assert.equal(verdict, true, "GLM-5.3-Flash-xhigh must inherit GLM-5.3-Flash");
    } finally {
      await removeModelContextOverride("unit-12475", "GLM-5.3-Flash");
    }
  });

  test("#12475 filter prefers the larger-window effort variant, not the spec-inflated one", async () => {
    await saveModelsDevCapabilities({
      "unit-12475": {
        "GLM-5.3-high": capabilityEntry(200_000),
        "GLM-5.2-high": capabilityEntry(1_000_000),
      },
    });
    await setModelContextOverride("unit-12475", "GLM-5.3", 1_000_000);
    await setModelContextOverride("unit-12475", "GLM-5.2", 128_000);
    try {
      const out = await filterTargetsByRequestCompatibility(
        [target("unit-12475/GLM-5.2-high"), target("unit-12475/GLM-5.3-high")],
        bigContextBody(300_000),
        noopLog
      );
      assert.equal(out[0]?.modelStr, "unit-12475/GLM-5.3-high");
      assert.equal(out[1]?.modelStr, "unit-12475/GLM-5.2-high");
    } finally {
      await removeModelContextOverride("unit-12475", "GLM-5.3");
      await removeModelContextOverride("unit-12475", "GLM-5.2");
    }
  });
});
