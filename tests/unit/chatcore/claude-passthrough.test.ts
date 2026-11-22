// @ts-nocheck
// Claude (Anthropic Messages) passthrough and request shaping through handleChatCore.
//
// Merged from 16 single-topic files so the chatCore module graph loads once per process
// instead of once per file. Each `describe` below is one former file (its name is the old
// file name without `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
// (claude-mid-system-passthrough-16127 stays in its own file: it guards the network while
// chatCore loads, which a shared import cannot do.)
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Global
// stubs (fetch, env vars) are installed and restored inside the describe that needs them. Call-log saves are drained per describe and closed once
// at the end of the file (closeCallLogSaves cannot be undone within a process).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, test } from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-claude-passthrough-"));
const TEST_DATA_DIR = path.join(TEST_ROOT, "data");
const previousEnv = {
  DATA_DIR: process.env.DATA_DIR,
  HOME: process.env.HOME,
  OMNIROUTE_PLUGINS_DIR: process.env.OMNIROUTE_PLUGINS_DIR,
};
process.env.DATA_DIR = TEST_DATA_DIR;
// Isolate HOME and the plugin dir before loading the app.
process.env.HOME = path.join(TEST_ROOT, "home");
process.env.OMNIROUTE_PLUGINS_DIR = path.join(TEST_ROOT, "plugins");
for (const dir of [process.env.DATA_DIR, process.env.HOME, process.env.OMNIROUTE_PLUGINS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { waitForCallLogSaves, closeCallLogSaves } =
  await import("../../../src/lib/usage/callLogs.ts");
const {
  handleChatCore,
  extractSystemRoleMessages,
  relocateDirectiveOnlyMessages,
  redactPassthroughThinkingSignatures,
} = await import("../../../open-sse/handlers/chatCore.ts");
const { isAdaptiveThinkingOnly } = await import("../../../src/shared/constants/modelSpecs.ts");
const { normalizeClaudeAdaptiveThinking } =
  await import("../../../open-sse/services/claudeAdaptiveThinking.ts");
const {
  shouldDefaultAllowClassifier,
  detectClassifierFormat,
  buildDefaultAllowClaudeMessage,
  applyClaudeClassifierReasoningDefault,
} = await import("../../../open-sse/handlers/chatCore/claudeClassifierCompat.ts");
const { FORMATS } = await import("../../../open-sse/translator/formats.ts");
const { translateRequest } = await import("../../../open-sse/translator/index.ts");
const { dropForeignServerToolUseBlocks } =
  await import("../../../open-sse/handlers/chatCore/anthropicPassthroughHistory.ts");
const { dropUnsignedPassthroughThinkingBlocks } =
  await import("../../../open-sse/handlers/chatCore/passthroughHelpers.ts");
const { FORWARDABLE_CLIENT_BETAS, mergeClientAnthropicBeta } =
  await import("../../../open-sse/config/anthropicHeaders.ts");
const { hoistToolAdditions, acceptsInlineToolAdditions } =
  await import("../../../open-sse/translator/helpers/claudeDeferredTools.ts");
const {
  applyProviderSystemTransforms,
  isSystemTransformsHandledDownstream,
  PROVIDER_CLAUDE,
  PROVIDER_CC_BRIDGE,
} = await import("../../../open-sse/services/systemTransforms.ts");

const originalFetch = globalThis.fetch;

async function flushAsyncSideEffects() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The per-test reset several former files ran: drop the DB handle and recreate DATA_DIR. */
async function resetDbHandleAndDataDir() {
  globalThis.fetch = originalFetch;
  await flushAsyncSideEffects();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/** Same, with a fresh Postgres database instead of a dropped handle. */
async function resetTestDbAndDataDir() {
  globalThis.fetch = originalFetch;
  await flushAsyncSideEffects();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  globalThis.fetch = originalFetch;
  await closeCallLogSaves();
  await core.resetDbInstance();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("claude-5x-thinking-passthrough", () => {
  // End-to-end request shaping for Claude 5.x adaptive thinking through handleChatCore:
  // an Anthropic-format client (e.g. @ai-sdk/anthropic / OpenCode) sending
  // `thinking: {type:"adaptive", display:"summarized"}` must reach the upstream unchanged
  // for 5.x models (Haiku 5.x included — it is adaptive-only), while Haiku 4.5 keeps the
  // manual `enabled` + budget shape it requires.
  after(async () => {
    globalThis.fetch = originalFetch;
    await waitForCallLogSaves(2_000);
  });

  const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
  const SSE = [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");

  async function upstreamThinking(
    provider: string,
    model: string,
    credentials: Record<string, unknown>,
    thinking: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = (async (url: unknown, init: { body?: unknown } = {}) => {
      if (String(url).includes("/v1/messages")) sent = JSON.parse(String(init.body ?? "{}"));
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const body = {
      model,
      max_tokens: 32000,
      stream: true,
      thinking,
      system: [{ type: "text", text: "You are a coding agent." }],
      tools: [{ name: "read", description: "read", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    };
    const headers = new Headers({
      "anthropic-beta": "interleaved-thinking-2025-05-14",
      "user-agent": "ai-sdk/anthropic",
    });
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider, model, extendedContext: false },
      credentials: { ...credentials, providerSpecificData: {} },
      log: noopLog,
      clientRawRequest: { endpoint: "/v1/messages", body: structuredClone(body), headers },
      userAgent: "ai-sdk/anthropic",
    } as never);
    await (result as { response: Response }).response.text();
    assert.ok(sent, "expected an upstream /v1/messages request");
    return sent.thinking as Record<string, unknown> | undefined;
  }

  const ADAPTIVE = { type: "adaptive", display: "summarized" };
  const OAUTH = { accessToken: "sk-ant-oat-test-token" };
  const API_KEY = { apiKey: "sk-ant-api-test" };

  for (const [provider, creds] of [
    ["claude", OAUTH],
    ["anthropic", API_KEY],
  ] as const) {
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
      test(`${provider}/${model}: adaptive + display summarized passes through unchanged`, async () => {
        assert.deepEqual(await upstreamThinking(provider, model, creds, ADAPTIVE), ADAPTIVE);
      });
    }

    test(`${provider}/claude-haiku-4-5: manual enabled + budget is kept`, async () => {
      const manual = { type: "enabled", budget_tokens: 2000, display: "summarized" };
      assert.deepEqual(
        await upstreamThinking(provider, "claude-haiku-4-5-20251001", creds, manual),
        manual
      );
    });
  }

  test("Claude Haiku 5.x is adaptive-only: a manual budget collapses to adaptive", () => {
    assert.equal(isAdaptiveThinkingOnly("claude-haiku-5-5"), true);
    assert.equal(isAdaptiveThinkingOnly("claude-haiku-4-5-20251001"), false);
    const out = normalizeClaudeAdaptiveThinking(
      { thinking: { type: "enabled", budget_tokens: 2000, display: "summarized" } },
      "claude-haiku-5-5"
    );
    assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" });
  });
});

describe("claude-classifier-compat", () => {
  /**
   * TDD test for the Claude Code auto-mode classifier compat mode (opt-in, default off).
   *
   * Claude Code's `--permission-mode auto` sends an internal `/v1/messages` security-classifier
   * request and requires the response to START with the literal token `<block>no</block>` (ALLOW)
   * or `<block>yes</block>` (BLOCK) — anything else is unparseable and Claude Code fails closed
   * with "Auto mode could not evaluate this action and is blocking it for safety".
   *
   * When a combo/fallback route sends the classifier call to a cheap model that returns 200 with
   * empty content, the well-formed-but-empty Claude message OmniRoute produces still fails that
   * parser. With `claudeClassifierCompat` set to "auto" (or "always"), handleChatCore detects the
   * classifier request and short-circuits with a synthetic ALLOW response — WITHOUT ever calling
   * the upstream provider. Default is "off": nothing changes unless an operator explicitly opts in.
   */

  // The default-is-off test below must read a pristine database; earlier describes share it.
  before(async () => {
    await resetTestDb();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await updateSettings({ claudeClassifierCompat: "off" });
  });

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  async function invokeUpstreamClassifier({
    headers = {},
    resolvedThinkingEffort,
  }: {
    headers?: Record<string, string>;
    resolvedThinkingEffort?: string;
  } = {}) {
    let outbound: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-classifier",
          object: "chat.completion",
          model: "sonnet-classifier-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "<block>yes</block>" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const body = {
      ...structuredClone(CLASSIFIER_BODY),
      model: "sonnet-classifier-test",
      max_tokens: 2112,
    };
    try {
      const result = await handleChatCore({
        body,
        modelInfo: {
          provider: "openai-compatible-classifier-test",
          model: "sonnet-classifier-test",
          extendedContext: false,
          resolvedThinkingEffort,
        },
        credentials: {
          apiKey: "sk-test",
          providerSpecificData: {
            baseUrl: "https://engine.example.test/v1",
            apiType: "chat",
            reasoningControl: "chat-template",
          },
        },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/messages",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json", ...headers }),
        },
        userAgent: "unit-test",
      });
      await waitForCallLogSaves(5000);
      return { outbound, result };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // Shape of the classifier request Claude Code's `--permission-mode auto` sends internally:
  // a Claude Messages request carrying the security-monitor system prompt AND `</block>` as a
  // stop sequence — the two independent signals the compat detector relies on.
  const CLASSIFIER_BODY = {
    model: "claude-3-5-haiku-20241022",
    stream: false,
    system: [
      {
        type: "text",
        text: "You are a security monitor for autonomous AI coding agents. Evaluate the following action and respond with <block>yes</block> or <block>no</block>.",
      },
    ],
    stop_sequences: ["</block>"],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "<transcript>WebFetch https://example.com</transcript>" }],
      },
    ],
    max_tokens: 8,
  };

  // Newer Claude Code builds send a "severity classifier" variant of the same internal
  // request: same security-monitor marker, but `stop_sequences` carries `</severity>`
  // instead of `</block>`, and it expects a `<severity>N</severity>` reply (#11289).
  const SEVERITY_CLASSIFIER_BODY = {
    ...CLASSIFIER_BODY,
    stop_sequences: ["</severity>"],
  };

  // ─── Settings default is opt-in (off) ────────────────────────────────────────
  // Runs FIRST in this describe, before any updateSettings() write, so it reads the pristine
  // DB (the describe's `before` resets it).

  test("settings default: claudeClassifierCompat is 'off' (opt-in)", async () => {
    const { getSettings } = await import("../../../src/lib/db/settings.ts");
    const settings = await getSettings();
    assert.equal(settings.claudeClassifierCompat, "off", "claudeClassifierCompat defaults to off");
  });

  // ─── Pure detector: shouldDefaultAllowClassifier ─────────────────────────────

  test("detector: off never short-circuits (pass-through preserved by default)", () => {
    assert.equal(shouldDefaultAllowClassifier(FORMATS.CLAUDE, CLASSIFIER_BODY, "off"), false);
    assert.equal(shouldDefaultAllowClassifier(FORMATS.CLAUDE, CLASSIFIER_BODY, undefined), false);
  });

  test("detector: auto fires on the security-monitor system-prompt marker", () => {
    const body = {
      system: [
        { type: "text", text: "You are a security monitor for autonomous AI coding agents." },
      ],
      stop_sequences: [],
    };
    assert.equal(shouldDefaultAllowClassifier(FORMATS.CLAUDE, body, "auto"), true);
  });

  test("detector: auto does NOT fire on the </block> stop_sequence token alone (#8189 — over-broad trigger fix)", () => {
    const body = { system: [{ type: "text", text: "unrelated" }], stop_sequences: ["</block>"] };
    assert.equal(
      shouldDefaultAllowClassifier(FORMATS.CLAUDE, body, "auto"),
      false,
      "stop_sequences=['</block>'] alone must not short-circuit without the security-monitor marker"
    );
  });

  test("detector: auto does NOT fire on a regular Claude request (no marker, no </block>)", () => {
    const body = {
      system: [{ type: "text", text: "You are a helpful coding assistant." }],
      stop_sequences: [],
      messages: [{ role: "user", content: "hello" }],
    };
    assert.equal(shouldDefaultAllowClassifier(FORMATS.CLAUDE, body, "auto"), false);
  });

  test("detector: never fires for non-Claude source formats even in always mode", () => {
    assert.equal(shouldDefaultAllowClassifier(FORMATS.OPENAI, CLASSIFIER_BODY, "always"), false);
  });

  test("detector: always does NOT fire for normal chat without classifier marker (#9276)", () => {
    const plain = { system: [{ type: "text", text: "hi" }], stop_sequences: [] };
    assert.equal(
      shouldDefaultAllowClassifier(FORMATS.CLAUDE, plain, "always"),
      false,
      "always must NOT short-circuit a normal chat (no security-monitor marker)"
    );
  });

  test("detector: always fires when classifier marker is present", () => {
    const classifier = {
      system: [
        {
          type: "text",
          text: "You are a security monitor for autonomous AI coding agents. Evaluate the following action.",
        },
      ],
      stop_sequences: ["</block>"],
    };
    assert.equal(
      shouldDefaultAllowClassifier(FORMATS.CLAUDE, classifier, "always"),
      true,
      "always must short-circuit when the classifier marker is present"
    );
  });

  test("classifier requests without reasoning default to disabled native thinking on both stages", () => {
    assert.equal(
      typeof applyClaudeClassifierReasoningDefault,
      "function",
      "classifier reasoning default is not implemented"
    );

    for (const [maxTokens, stopSequences] of [
      [2112, ["</block>"]],
      [10240, undefined],
    ] as const) {
      const body: Record<string, unknown> = {
        ...structuredClone(CLASSIFIER_BODY),
        model: "sonnet-classifier-test",
        max_tokens: maxTokens,
      };
      if (stopSequences === undefined) delete body.stop_sequences;
      else body.stop_sequences = [...stopSequences];

      const normalized = applyClaudeClassifierReasoningDefault!(FORMATS.CLAUDE, body);

      assert.deepEqual(normalized?.thinking, { type: "disabled" });
      assert.equal(normalized?.max_tokens, maxTokens);
      assert.deepEqual(normalized?.stop_sequences, stopSequences);
      assert.equal(body.thinking, undefined, "normalization must not mutate the client body");
    }
  });

  test("ordinary requests and explicit classifier reasoning controls stay unchanged", () => {
    assert.equal(
      typeof applyClaudeClassifierReasoningDefault,
      "function",
      "classifier reasoning default is not implemented"
    );

    const ordinary = {
      system: "You are a coding assistant.",
      messages: [{ role: "user", content: "hi" }],
    };
    assert.equal(applyClaudeClassifierReasoningDefault!(FORMATS.CLAUDE, ordinary), ordinary);
    assert.equal(
      applyClaudeClassifierReasoningDefault!(FORMATS.OPENAI, CLASSIFIER_BODY),
      CLASSIFIER_BODY
    );

    for (const explicit of [
      { thinking: { type: "enabled", budget_tokens: 1024 } },
      { thinking: { type: "disabled" } },
      { reasoning: { effort: "high" } },
      { reasoning_effort: "high" },
      { output_config: { effort: "high" } },
      { chat_template_kwargs: { enable_thinking: true, custom_flag: "kept" } },
      {
        _omnirouteReasoningRule: {
          id: "force-high",
          effortMode: "force",
          targetEffort: "high",
        },
      },
    ]) {
      const body = { ...structuredClone(CLASSIFIER_BODY), ...explicit };
      assert.equal(applyClaudeClassifierReasoningDefault!(FORMATS.CLAUDE, body), body);
    }

    const explicitContexts = [
      ...["auto", "low", "medium", "high", "xhigh", "max", "off"].map((value) => [
        `effort header ${value}`,
        { headers: new Headers({ "X-OmniRoute-Effort": value.toUpperCase() }) },
      ]),
      ...["adaptive", "off"].map((value) => [
        `thinking header ${value}`,
        { headers: { "x-OMNIROUTE-thinking": value.toUpperCase() } },
      ]),
      ["resolved effort", { resolvedThinkingEffort: "high" }],
    ] as Array<
      [string, { headers?: Headers | Record<string, string>; resolvedThinkingEffort?: string }]
    >;
    for (const [name, context] of explicitContexts) {
      const body = structuredClone(CLASSIFIER_BODY);
      assert.equal(
        applyClaudeClassifierReasoningDefault!(FORMATS.CLAUDE, body, context),
        body,
        name
      );
    }
  });

  // ─── Pure detector: detectClassifierFormat (#11289) ──────────────────────────

  test("format detector: defaults to 'block' for the legacy </block> classifier shape", () => {
    assert.equal(detectClassifierFormat(CLASSIFIER_BODY), "block");
  });

  test("format detector: returns 'severity' when stop_sequences carries </severity>", () => {
    assert.equal(detectClassifierFormat(SEVERITY_CLASSIFIER_BODY), "severity");
  });

  test("format detector: defaults to 'block' when stop_sequences is missing/empty", () => {
    assert.equal(detectClassifierFormat({}), "block");
    assert.equal(detectClassifierFormat({ stop_sequences: [] }), "block");
  });

  // ─── Pure builder: buildDefaultAllowClaudeMessage ────────────────────────────

  test("builder: synthetic message text STARTS WITH <block>no</block>", async () => {
    const built = buildDefaultAllowClaudeMessage("claude-3-5-haiku-20241022");
    assert.equal(built.success, true);
    const payload = (await built.response.json()) as {
      type: string;
      role: string;
      stop_reason: string;
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(payload.type, "message");
    assert.equal(payload.role, "assistant");
    assert.equal(payload.stop_reason, "end_turn");
    const text = payload.content.find((b) => b.type === "text")?.text ?? "";
    assert.ok(
      text.startsWith("<block>no</block>"),
      `expected synthetic text to start with <block>no</block>, got: ${text}`
    );
    assert.ok(!text.includes("<block>yes"), "must not signal BLOCK");
  });

  test("builder: format='severity' returns <severity>0</severity> (#11289)", async () => {
    const built = buildDefaultAllowClaudeMessage("claude-3-5-haiku-20241022", "severity");
    assert.equal(built.success, true);
    const payload = (await built.response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = payload.content.find((b) => b.type === "text")?.text ?? "";
    assert.equal(text, "<severity>0</severity>");
  });

  // ─── Handler-level: end-to-end short-circuit through handleChatCore ──────────

  test("handler: compat=off preserves upstream BLOCK while disabling native thinking", async () => {
    await updateSettings({ claudeClassifierCompat: "off" });
    const { outbound, result } = await invokeUpstreamClassifier();

    assert.deepEqual(outbound?.chat_template_kwargs, {
      thinking: false,
      enable_thinking: false,
    });
    assert.equal(outbound?.reasoning_effort, undefined);
    assert.equal(outbound?.max_tokens, 2112);
    const payload = await (result as { response: Response }).response.json();
    assert.equal(payload.content[0].text, "<block>yes</block>");
  });

  test("handler: explicit classifier effort header and resolved effort remain authoritative", async () => {
    await updateSettings({ claudeClassifierCompat: "off" });

    const header = await invokeUpstreamClassifier({
      headers: { "x-omniroute-effort": "auto" },
    });
    assert.equal(header.outbound?.reasoning_effort, "low");
    assert.equal(header.outbound?.chat_template_kwargs, undefined);

    const resolved = await invokeUpstreamClassifier({ resolvedThinkingEffort: "high" });
    assert.equal(resolved.outbound?.reasoning_effort, "high");
    assert.equal(resolved.outbound?.chat_template_kwargs, undefined);
  });

  test("handler: claudeClassifierCompat=auto short-circuits WITHOUT calling upstream, text starts with <block>no</block>", async () => {
    await updateSettings({ claudeClassifierCompat: "auto" });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("upstream fetch should NOT be called when the classifier short-circuits");
    }) as typeof fetch;

    try {
      const result = await handleChatCore({
        body: structuredClone(CLASSIFIER_BODY),
        modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/messages",
          body: structuredClone(CLASSIFIER_BODY),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
      });

      assert.equal(fetchCalls, 0, "upstream fetch must NOT be called");
      assert.equal(result.success, true, "handleChatCore must report success");
      const payload = (await (result as { response: Response }).response.json()) as {
        type: string;
        content: Array<{ type: string; text?: string }>;
      };
      assert.equal(payload.type, "message");
      const text = payload.content.find((b) => b.type === "text")?.text ?? "";
      assert.ok(
        text.startsWith("<block>no</block>"),
        `expected classifier response to start with <block>no</block>, got: ${text}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handler: claudeClassifierCompat=auto emits <severity>0</severity> for the severity-classifier shape (#11289)", async () => {
    await updateSettings({ claudeClassifierCompat: "auto" });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("upstream fetch should NOT be called when the classifier short-circuits");
    }) as typeof fetch;

    try {
      const result = await handleChatCore({
        body: structuredClone(SEVERITY_CLASSIFIER_BODY),
        modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/messages",
          body: structuredClone(SEVERITY_CLASSIFIER_BODY),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
      });

      assert.equal(fetchCalls, 0, "upstream fetch must NOT be called");
      assert.equal(result.success, true, "handleChatCore must report success");
      const payload = (await (result as { response: Response }).response.json()) as {
        type: string;
        content: Array<{ type: string; text?: string }>;
      };
      assert.equal(payload.type, "message");
      const text = payload.content.find((b) => b.type === "text")?.text ?? "";
      assert.equal(
        text,
        "<severity>0</severity>",
        `expected severity-classifier response to be <severity>0</severity>, got: ${text}`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("claude-directive-only-relocation", () => {
  // Claude Code 2.1.154+ clients send directives as system-role messages with an
  // empty content array and a message-level output_config. Anthropic rejects the
  // directive-only form when it lands at messages[0] (the initial system prompt
  // position) while accepting it at any other position. Upstream error text:
  //   messages.0: use the top-level 'system' parameter for the initial system
  //   prompt; the directive-only form (content: [] with output_config) is
  //   accepted at any position
  // Measured in production: 122x 400 in one hour on the offical-claude combo.

  test("relocateDirectiveOnlyMessages moves a directive-only messages[0] past the first real turn", () => {
    const payload = {
      messages: [
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 3);
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[1].role, "system");
    assert.deepEqual(payload.messages[1].output_config, { effort: "high" });
    assert.equal(payload.messages[2].role, "assistant");
  });

  test("relocateDirectiveOnlyMessages skips consecutive system messages to find the real turn", () => {
    const payload = {
      messages: [
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "system", content: "mid-conversation context" },
        { role: "user", content: "hello" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 3);
    assert.equal(payload.messages[0].role, "system");
    assert.equal(payload.messages[0].content, "mid-conversation context");
    assert.equal(payload.messages[1].role, "user");
    assert.equal(payload.messages[2].role, "system");
    assert.deepEqual(payload.messages[2].output_config, { effort: "high" });
  });

  test("relocateDirectiveOnlyMessages drops an empty system message without output_config at messages[0]", () => {
    const payload = {
      messages: [
        { role: "system", content: [] },
        { role: "user", content: "hello" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].role, "user");
  });

  test("relocateDirectiveOnlyMessages folds output_config to top level when no real turn exists", () => {
    const payload = {
      messages: [{ role: "system", content: [], output_config: { effort: "xhigh" } }],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 0);
    assert.deepEqual(payload.output_config, { effort: "xhigh" });
  });

  test("relocateDirectiveOnlyMessages keeps an existing top-level output_config untouched", () => {
    const payload = {
      output_config: { effort: "low" },
      messages: [{ role: "system", content: [], output_config: { effort: "xhigh" } }],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 0);
    assert.deepEqual(payload.output_config, { effort: "low" });
  });

  test("relocateDirectiveOnlyMessages is a no-op for a normal user first message", () => {
    const payload = {
      messages: [
        { role: "user", content: "hello" },
        { role: "system", content: [], output_config: { effort: "high" } },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[1].role, "system");
    assert.equal(payload.messages[1].content.length, 0);
    assert.deepEqual(payload.messages[1].output_config, { effort: "high" });
  });

  test("relocateDirectiveOnlyMessages relocates a directive after an empty system message", () => {
    const payload = {
      messages: [
        { role: "system", content: [] },
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "user", content: "hello" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[1].role, "system");
    assert.deepEqual(payload.messages[1].output_config, { effort: "high" });
  });

  test("relocateDirectiveOnlyMessages relocates consecutive directives in order", () => {
    const payload = {
      messages: [
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "user", content: "hello" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 3);
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[1].role, "system");
    assert.deepEqual(payload.messages[1].output_config, { effort: "high" });
    assert.equal(payload.messages[2].role, "system");
    assert.deepEqual(payload.messages[2].output_config, { effort: "low" });
  });

  test("relocateDirectiveOnlyMessages walks past a text system message to find the anchor", () => {
    const payload = {
      messages: [
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "system", content: "real system prompt" },
        { role: "user", content: "hello" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 3);
    assert.equal(payload.messages[0].content, "real system prompt");
    assert.equal(payload.messages[1].role, "user");
    assert.equal(payload.messages[2].role, "system");
    assert.deepEqual(payload.messages[2].output_config, { effort: "high" });
  });

  test("relocateDirectiveOnlyMessages is a no-op for a system message with text content", () => {
    const payload = {
      messages: [
        { role: "system", content: "real system prompt" },
        { role: "user", content: "hello" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].content, "real system prompt");
  });

  test("relocateDirectiveOnlyMessages handles a non-array messages field", () => {
    const payload = { messages: "not-an-array" };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages, "not-an-array");
  });

  test("relocateDirectiveOnlyMessages handles an empty messages array", () => {
    const payload = { messages: [] };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 0);
  });

  test("relocateDirectiveOnlyMessages handles developer-role directives too", () => {
    const payload = {
      messages: [
        { role: "developer", content: [], output_config: { format: { type: "json_schema" } } },
        { role: "user", content: "hello" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[1].role, "developer");
    assert.deepEqual(payload.messages[1].output_config, {
      format: { type: "json_schema" },
    });
  });

  test("extractSystemRoleMessages preserves the output_config of directive-only messages", () => {
    const payload = {
      messages: [
        { role: "system", content: "Memory context: foo" },
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].role, "user");
    assert.deepEqual(payload.system, [{ type: "text", text: "Memory context: foo" }]);
    assert.deepEqual(payload.output_config, { effort: "high" });
  });

  test("extractSystemRoleMessages keeps an existing top-level output_config", () => {
    const payload = {
      output_config: { effort: "low" },
      messages: [
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.output_config, { effort: "low" });
  });

  test("extractSystemRoleMessages folds output_config even when the message also has text", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "Text + directive" }],
          output_config: { effort: "high" },
        },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.system, [{ type: "text", text: "Text + directive" }]);
    assert.deepEqual(payload.output_config, { effort: "high" });
  });

  test("extractSystemRoleMessages keeps the first directive output_config among several", () => {
    const payload = {
      messages: [
        { role: "system", content: [], output_config: { effort: "high" } },
        { role: "system", content: [], output_config: { effort: "low" } },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.output_config, { effort: "high" });
  });

  test("extractSystemRoleMessages folds output_config for string-content messages too", () => {
    const payload = {
      messages: [
        { role: "system", content: "String content", output_config: { effort: "high" } },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.system, [{ type: "text", text: "String content" }]);
    assert.deepEqual(payload.output_config, { effort: "high" });
  });

  test("relocateDirectiveOnlyMessages does not throw on a null first message", () => {
    const payload = {
      messages: [null, { role: "user", content: "hello" }],
    };
    assert.doesNotThrow(() => relocateDirectiveOnlyMessages(payload));
    assert.equal(payload.messages.length, 2);
  });

  test("relocateDirectiveOnlyMessages does not throw on a null anchor candidate", () => {
    const payload = {
      messages: [
        { role: "system", content: [], output_config: { effort: "high" } },
        null,
        { role: "user", content: "hello" },
      ],
    };
    assert.doesNotThrow(() => relocateDirectiveOnlyMessages(payload));
    // The null entry stays where it was; the directive lands after the real turn.
    assert.equal(payload.messages.length, 3);
    assert.equal(payload.messages[0], null);
    assert.equal(payload.messages[1].role, "user");
    assert.equal(payload.messages[2].role, "system");
    assert.deepEqual(payload.messages[2].output_config, { effort: "high" });
  });

  test("relocateDirectiveOnlyMessages drops plain empties but keeps text system messages with no real turn", () => {
    const payload = {
      messages: [
        { role: "system", content: [] },
        { role: "system", content: "keep me" },
      ],
    };
    relocateDirectiveOnlyMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].content, "keep me");
    assert.equal(payload.output_config, undefined);
  });
});

describe("claude-directive-midconv-passthrough", () => {
  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  afterEach(resetDbHandleAndDataDir);

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("claude mid-conversation-system passthrough relocates a directive-only messages[0]", async () => {
    let captured = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      };
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const body = {
      model: "claude-opus-5",
      max_tokens: 64,
      system: [{ type: "text", text: "You are Claude." }],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object" } }],
      messages: [
        { role: "system", content: [], output_config: { effort: "medium" } },
        { role: "user", content: "hello" },
      ],
      stream: false,
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "claude", model: "claude-opus-5", extendedContext: false },
      credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "claude-code/2.1.154",
        }),
      },
      userAgent: "claude-code/2.1.154",
    });

    assert.ok(captured, "fetch was not called");
    assert.ok(captured.url.startsWith("https://api.anthropic.com/v1/messages"));
    assert.equal(captured.method, "POST");
    assert.ok(captured.headers.get("x-api-key"), "x-api-key header missing");
    assert.ok(captured.headers.get("anthropic-version"), "anthropic-version header missing");
    assert.equal(result.success, true);
    // The directive-only message must not sit at messages[0] when it reaches upstream.
    const upstreamMessages = captured.body.messages;
    assert.equal(upstreamMessages[0].role, "user");
    assert.equal(upstreamMessages[1].role, "system");
    assert.deepEqual(upstreamMessages[1].output_config, { effort: "medium" });
    // The relocation must not disturb anything else the client sent.
    assert.deepEqual(upstreamMessages[1].content, []);
    assert.equal(upstreamMessages[0].content, "hello");
    // The claude identity layer prepends its own blocks; assert the client's
    // block survived rather than an exact count.
    assert.ok(
      captured.body.system.some(
        (block) => block.type === "text" && block.text === "You are Claude."
      )
    );
    assert.equal(captured.body.tools.length, 1);
    // The directive stays message-level; the top level (if set) is the base
    // executor's own default injection, not the hoisted directive value.
    assert.notDeepEqual(captured.body.output_config, { effort: "medium" });
  });
});

describe("claude-mid-conversation-system-compatible-passthrough", () => {
  /**
   * Mid-conversation system turns on a plain `anthropic-compatible-*` connection (#16236).
   *
   * The claude → claude passthrough for a non-native provider runs
   * normalizeClaudeUpstreamMessages(), which hoists EVERY system-role turn into the
   * top-level `system`. A client that appends a system notification each turn (e.g. a
   * `<total_tokens>` budget update) therefore grows `system` — the head of the prompt —
   * on every request, so the cached conversation history after it never matches again
   * (observed: ~27K cache read / ~105K cache write per turn on a 133K prompt).
   *
   * Keeping those turns in place needs an upstream that accepts `role: "system"` inside
   * messages[] (the `mid-conversation-system-2026-04-07` beta). Relays without it 400, so the
   * in-place shape is opt-in: ANTHROPIC_COMPATIBLE_MID_CONVERSATION_SYSTEM (default off) AND the
   * client's own beta. Flag off, or beta absent, keeps the legacy full hoist byte-for-byte.
   * These tests assert the FINAL body and headers handed to fetch, not the helper in isolation.
   */
  const PROVIDER = "anthropic-compatible-relay-test";
  const MODEL = "claude-opus-5-5";
  const MID_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
  const FLAG = "ANTHROPIC_COMPATIBLE_MID_CONVERSATION_SYSTEM";
  let previousFlag: string | undefined;

  before(() => {
    previousFlag = process.env[FLAG];
    delete process.env[FLAG];
  });

  function setFlag(on) {
    if (on) process.env[FLAG] = "true";
    else delete process.env[FLAG];
  }

  // Captured Claude Code shape: it negotiates the beta itself when it sends such turns.
  const CLAUDE_CODE_HEADERS = {
    "user-agent": "claude-cli/2.1.286 (external, cli)",
    "x-app": "cli",
    "anthropic-beta": `claude-code-20250219,${MID_SYSTEM_BETA},effort-2025-11-24,per-turn-control-2026-07-01`,
  };
  // Same beta from a non-Claude Code client: identity must not matter.
  const SDK_HEADERS = {
    "user-agent": "opencode/1.4.0 ai-sdk/anthropic",
    "anthropic-beta": MID_SYSTEM_BETA,
  };
  // A client that did NOT negotiate the beta.
  const NO_BETA_HEADERS = {
    "user-agent": "claude-cli/2.1.160 (external, cli)",
    "anthropic-beta": "claude-code-20250219,effort-2025-11-24",
  };

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  afterEach(async () => {
    delete process.env[FLAG];
    await resetTestDbAndDataDir();
  });

  after(() => {
    if (previousFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previousFlag;
    globalThis.fetch = originalFetch;
  });

  function credentials() {
    return {
      apiKey: "sk-relay-test",
      providerSpecificData: { baseUrl: "https://relay.example.test/v1" },
    };
  }

  /** Synthetic Claude Code-shaped turn `n`: each turn appends assistant/tool/user + a budget notice. */
  function buildBody(turns, model = MODEL) {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Initial request" }] },
      { role: "system", content: "Environment instructions: auto mode is active." },
    ];
    for (let i = 0; i < turns; i++) {
      messages.push(
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: `plan ${i}`, signature: `sig-${i}` },
            { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `ls ${i}` } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: `result ${i}` }],
        },
        {
          role: "system",
          content: `<total_tokens>${15_000_000 - i * 1000} tokens left</total_tokens>`,
        }
      );
    }
    // The client advances its last breakpoint to the newest tool_result.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    lastUser.content[lastUser.content.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
    return {
      model,
      max_tokens: 1024,
      stream: false,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "BASE SYSTEM", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object" } }],
      messages,
    };
  }

  async function send(body, { headers = CLAUDE_CODE_HEADERS, model = MODEL } = {}) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      });
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: PROVIDER, model, extendedContext: false },
      credentials: credentials(),
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ "content-type": "application/json", ...headers }),
      },
      userAgent: headers["user-agent"],
    });
    assert.equal(result.success, true, "request should succeed");
    assert.equal(calls.length, 1, "exactly one upstream call");
    return calls[0];
  }

  const roles = (messages) => messages.map((m) => m.role);
  const systemTexts = (system) => (Array.isArray(system) ? system.map((b) => b.text) : [system]);
  const betaTokens = (call) =>
    (call.headers.get("anthropic-beta") || "").split(",").filter(Boolean);
  const stripCacheControl = (value) =>
    JSON.parse(JSON.stringify(value), (key, v) => (key === "cache_control" ? undefined : v));

  function assertInPlace(call, body) {
    assert.deepEqual(roles(call.body.messages), roles(body.messages));
    assert.deepEqual(call.body.system, body.system);
  }

  function assertHoisted(call) {
    assert.equal(call.body.messages.filter((m) => m.role === "system").length, 0);
    const texts = systemTexts(call.body.system);
    assert.ok(texts.includes("Environment instructions: auto mode is active."));
    assert.ok(texts.some((t) => /<total_tokens>/.test(t)));
    assert.ok(!betaTokens(call).includes(MID_SYSTEM_BETA), `beta: ${betaTokens(call)}`);
  }

  // ── Flag off (default): byte-for-byte legacy hoist ───────────────────────────────────────

  test("flag off (default): every system turn is hoisted even when the client sent the beta", async () => {
    setFlag(false);
    const body = buildBody(3);
    const call = await send(body);
    assert.ok(call.url.startsWith("https://relay.example.test/v1/messages"));
    assertHoisted(call);
    assert.deepEqual(
      roles(call.body.messages),
      roles(body.messages).filter((r) => r !== "system"),
      "only the system turns leave messages[]"
    );
  });

  test("flag off (default): a beta-less client is hoisted too", async () => {
    setFlag(false);
    assertHoisted(await send(buildBody(2), { headers: NO_BETA_HEADERS }));
  });

  // ── Flag on, but the client did not negotiate the beta: still the legacy hoist ─────────────

  test("flag on, client without the beta: turns are hoisted and the beta is never invented", async () => {
    setFlag(true);
    assertHoisted(await send(buildBody(2), { headers: NO_BETA_HEADERS }));
  });

  test("flag on, client without any anthropic-beta header: hoisted, no beta header invented", async () => {
    setFlag(true);
    assertHoisted(await send(buildBody(2), { headers: { "user-agent": "curl/8.0" } }));
  });

  test("flag on, a token that only looks like the beta: hoisted and not forwarded", async () => {
    setFlag(true);
    const call = await send(buildBody(2), {
      headers: { ...SDK_HEADERS, "anthropic-beta": `${MID_SYSTEM_BETA}x` },
    });
    assertHoisted(call);
    assert.ok(!betaTokens(call).some((t) => t.toLowerCase() === MID_SYSTEM_BETA));
  });

  // ── Flag on + client-negotiated beta: turns stay in place ──────────────────────────────────

  test("flag on + client beta: mid-conversation system turns stay in place in the final body", async () => {
    setFlag(true);
    const body = buildBody(3);
    const call = await send(body);

    assert.ok(call.url.startsWith("https://relay.example.test/v1/messages"));
    assert.deepEqual(roles(call.body.messages), roles(body.messages));
    assert.equal(call.body.messages.filter((m) => m.role === "system").length, 4);
    assert.equal(call.body.messages[1].content, "Environment instructions: auto mode is active.");
    assert.match(call.body.messages.at(-1).content, /<total_tokens>/);
    // Top-level system is exactly what the client sent — no hoisted turns appended.
    assert.deepEqual(call.body.system, body.system);
    // Tools, thinking history, message-level config and cache markers survive.
    // (The shared tool normalization may stamp `type: "custom"`; it is deterministic per turn.)
    assert.deepEqual(
      call.body.tools.map(({ name, input_schema }) => ({ name, input_schema })),
      body.tools.map(({ name, input_schema }) => ({ name, input_schema }))
    );
    assert.deepEqual(call.body.messages[2].content[0], body.messages[2].content[0]);
    assert.deepEqual(call.body.output_config, body.output_config);
    const lastToolResult = call.body.messages.at(-2).content.at(-1);
    assert.deepEqual(lastToolResult.cache_control, { type: "ephemeral", ttl: "1h" });
    assert.equal(lastToolResult.type, "tool_result", "tool_result block is not collapsed to text");
    // The client's own beta token reaches upstream next to the rest of its allowlisted set.
    assert.ok(betaTokens(call).includes(MID_SYSTEM_BETA), `beta: ${betaTokens(call)}`);
    assert.ok(
      betaTokens(call).includes("per-turn-control-2026-07-01"),
      `beta: ${betaTokens(call)}`
    );
  });

  test("flag on + client beta: successive turns keep system stable and earlier messages a prefix", async () => {
    setFlag(true);
    const bodies = [];
    for (const turns of [1, 2, 3, 4]) bodies.push((await send(buildBody(turns))).body);
    for (let i = 1; i < bodies.length; i++) {
      const prev = bodies[i - 1];
      const next = bodies[i];
      assert.deepEqual(next.tools, prev.tools, `tools changed between turn ${i} and ${i + 1}`);
      assert.deepEqual(next.system, prev.system, `system changed between turn ${i} and ${i + 1}`);
      assert.deepEqual(
        stripCacheControl(next.messages.slice(0, prev.messages.length)),
        stripCacheControl(prev.messages),
        `turn ${i} messages are not a prefix of turn ${i + 1}`
      );
    }
  });

  test("flag on: a non-Claude Code client that sent the beta gets the same treatment", async () => {
    setFlag(true);
    const body = buildBody(2);
    const call = await send(body, { headers: SDK_HEADERS });
    assertInPlace(call, body);
    assert.ok(betaTokens(call).includes(MID_SYSTEM_BETA));
  });

  test("flag on: the client's beta token is matched case-insensitively and with spaces", async () => {
    setFlag(true);
    const body = buildBody(2);
    const call = await send(body, {
      headers: {
        ...SDK_HEADERS,
        "anthropic-beta": `effort-2025-11-24, ${MID_SYSTEM_BETA.toUpperCase()} `,
      },
    });
    assertInPlace(call, body);
    assert.ok(
      betaTokens(call).some((t) => t.toLowerCase() === MID_SYSTEM_BETA),
      `beta: ${betaTokens(call)}`
    );
  });

  test("flag on + beta: a body carrying an OpenAI developer turn keeps the full legacy hoist", async () => {
    setFlag(true);
    const body = buildBody(2);
    body.messages.splice(2, 0, { role: "developer", content: "developer note" });
    const call = await send(body);
    assertHoisted(call);
    assert.equal(call.body.messages.filter((m) => m.role === "developer").length, 0);
    assert.ok(systemTexts(call.body.system).includes("developer note"));
  });

  test("flag on + beta: leading text system turn is hoisted, directive-only one relocated", async () => {
    setFlag(true);
    const body = buildBody(1);
    body.messages.unshift(
      { role: "system", content: [], output_config: { effort: "low" } },
      { role: "system", content: "[Output Styles] terse" }
    );
    const call = await send(body);
    const msgs = call.body.messages;
    assert.equal(msgs[0].role, "user", "messages[0] must be a real turn");
    assert.equal(msgs[1].role, "system");
    assert.deepEqual(msgs[1].output_config, { effort: "low" });
    assert.deepEqual(systemTexts(call.body.system), [
      ...systemTexts(body.system),
      "[Output Styles] terse",
    ]);
    // Genuine mid-conversation turns after the first user turn keep their place.
    assert.equal(msgs[2].content, "Environment instructions: auto mode is active.");
    assert.match(msgs.at(-1).content, /<total_tokens>/);
  });

  test("flag on + beta: requests without system turns keep their shape and get no extra beta", async () => {
    setFlag(true);
    const body = buildBody(1);
    body.messages = body.messages.filter((m) => m.role !== "system");
    const call = await send(body);
    assert.deepEqual(roles(call.body.messages), roles(body.messages));
    assert.deepEqual(call.body.system, body.system);
    assert.ok(!betaTokens(call).includes(MID_SYSTEM_BETA), "no beta without a surviving turn");
  });

  test("flag on + beta: the caller's body is not mutated, so retries/combo attempts see the original", async () => {
    setFlag(true);
    const body = buildBody(2);
    const snapshot = structuredClone(body);
    const credentialsFixture = credentials();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      await handleChatCore({
        body,
        modelInfo: { provider: PROVIDER, model: MODEL, extendedContext: false },
        credentials: credentialsFixture,
        log: noopLog(),
        clientRawRequest: { endpoint: "/v1/messages", body, headers: new Headers(SDK_HEADERS) },
        userAgent: SDK_HEADERS["user-agent"],
      });
    }
    assert.deepEqual(body.messages, snapshot.messages);
    assert.deepEqual(body.system, snapshot.system);
  });

  test("policy: scope, client beta and fail-closed flag reader", async () => {
    const { resolveClaudeMidConversationSystemPolicy } =
      await import("../../../open-sse/services/claudeMidConversationSystem.ts");
    const resolve = (extra = {}) =>
      resolveClaudeMidConversationSystemPolicy({
        provider: PROVIDER,
        sourceFormat: "claude",
        targetFormat: "claude",
        clientAnthropicBeta: `effort-2025-11-24,${MID_SYSTEM_BETA}`,
        isPassthroughEnabled: () => true,
        ...extra,
      });
    assert.equal(resolve(), true, "plain anthropic-compatible claude passthrough, opted in");
    assert.equal(resolve({ isPassthroughEnabled: () => false }), false, "flag off");
    assert.equal(resolve({ isPassthroughEnabled: undefined }), false, "no reader = off");
    assert.equal(
      resolve({
        isPassthroughEnabled: () => {
          throw new Error("db down");
        },
      }),
      false,
      "a failing flag read keeps the legacy hoist"
    );
    assert.equal(resolve({ clientAnthropicBeta: null }), false, "client did not negotiate");
    assert.equal(resolve({ clientAnthropicBeta: "effort-2025-11-24" }), false);
    assert.equal(resolve({ targetFormat: "openai" }), false);
    assert.equal(resolve({ provider: "claude" }), false, "native path keeps its own policy");
    assert.equal(
      resolve({ provider: "anthropic-compatible-cc-relay" }),
      false,
      "CC bridge builds its own body"
    );
    let flagReads = 0;
    resolve({
      provider: "openai",
      isPassthroughEnabled: () => {
        flagReads++;
        return true;
      },
    });
    assert.equal(flagReads, 0, "the flag is not read for providers outside the scope");
  });
});

describe("claude-passthrough-cache-wiring", () => {
  /**
   * Wiring test for ensurePassthroughCacheBreakpoints (#chat-passthrough-cache).
   *
   * The helper's unit tests (claude-passthrough-cache-rescue.test.ts) prove the
   * function's contract; this test proves the chatCore passthrough branch
   * actually CALLS it. A marker-less Anthropic-format request forwarded through
   * pure claude→claude passthrough must reach the upstream with injected cache
   * breakpoints (system tail 1h, second-to-last user + last assistant ephemeral)
   * — otherwise marker-less clients (e.g. Cursor) re-bill the full prefix
   * every turn. A client-managed marker anywhere must pass through untouched.
   */
  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  function createSseResponse(events) {
    return new Response(`${events.join("\n\n")}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  function markerlessClaudeBody() {
    return {
      model: "claude/claude-sonnet-5",
      max_tokens: 64,
      stream: true,
      system: [
        { type: "text", text: "You are a helpful assistant." },
        { type: "text", text: "Project context." },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "u1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "u2" }] },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
        { role: "user", content: [{ type: "text", text: "u3" }] },
      ],
    };
  }

  afterEach(resetDbHandleAndDataDir);

  after(() => {
    globalThis.fetch = originalFetch;
  });

  function countCacheControls(body) {
    let count = 0;
    if (Array.isArray(body.system)) {
      for (const block of body.system) if (block?.cache_control) count++;
    }
    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (Array.isArray(message.content)) {
          for (const block of message.content) if (block?.cache_control) count++;
        }
      }
    }
    return count;
  }

  test("claude→claude passthrough injects cache breakpoints into a marker-less body", async () => {
    let upstreamBody = null;

    globalThis.fetch = async (_url, init = {}) => {
      upstreamBody = JSON.parse(String(init.body || "{}"));
      return createSseResponse([
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-sonnet-5"}}`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
        `event: message_stop\ndata: {"type":"message_stop"}`,
      ]);
    };

    const body = markerlessClaudeBody();
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "claude", model: "claude-sonnet-5", extendedContext: false },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ "content-type": "application/json" }),
      },
      userAgent: "cursor/1.0",
    });

    assert.ok(result, "handleChatCore returned a response");
    assert.ok(upstreamBody, "upstream fetch captured the passthrough body");

    // The rescue must have fired: the upstream body now carries breakpoints.
    const marked = countCacheControls(upstreamBody);
    assert.ok(marked >= 2, `expected injected cache_control markers, got ${marked}`);

    const system = upstreamBody.system;
    assert.deepEqual(system[system.length - 1].cache_control, { type: "ephemeral", ttl: "1h" });
  });

  test("claude→claude passthrough leaves client-managed markers untouched", async () => {
    let upstreamBody = null;

    globalThis.fetch = async (_url, init = {}) => {
      upstreamBody = JSON.parse(String(init.body || "{}"));
      return createSseResponse([
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-sonnet-5"}}`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
        `event: message_stop\ndata: {"type":"message_stop"}`,
      ]);
    };

    const body = markerlessClaudeBody();
    // A client that manages its own breakpoints must pass through the plain
    // passthrough branch byte-untouched. NOTE: the userAgent must NOT look like
    // Claude Code — "claude-code"/"claude-cli"/x-app:cli route the request into
    // the CC semantic-passthrough branch, whose
    // ensureCacheControlOnLastUserMessage adds its own marker by contract.
    body.system[1].cache_control = { type: "ephemeral", ttl: "5m" };

    await handleChatCore({
      body,
      modelInfo: { provider: "claude", model: "claude-sonnet-5", extendedContext: false },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ "content-type": "application/json" }),
      },
      userAgent: "cursor/1.0",
    });

    assert.ok(upstreamBody, "upstream fetch captured the passthrough body");
    assert.equal(
      countCacheControls(upstreamBody),
      1,
      "client-managed marker must pass through with zero injection"
    );
    const system = upstreamBody.system;
    assert.deepEqual(system[system.length - 1].cache_control, { type: "ephemeral", ttl: "5m" });
  });

  test("a connection that opts out of prompt caching gets no injected breakpoints", async () => {
    let upstreamBody = null;

    globalThis.fetch = async (_url, init = {}) => {
      upstreamBody = JSON.parse(String(init.body || "{}"));
      return createSseResponse([
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-sonnet-5"}}`,
        `event: message_stop\ndata: {"type":"message_stop"}`,
      ]);
    };

    const body = markerlessClaudeBody();
    await handleChatCore({
      body,
      modelInfo: { provider: "claude", model: "claude-sonnet-5", extendedContext: false },
      credentials: {
        apiKey: "test-key",
        providerSpecificData: { cache: { supportsPromptCaching: false } },
      },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ "content-type": "application/json" }),
      },
      userAgent: "cursor/1.0",
    });

    assert.ok(upstreamBody, "upstream fetch captured the passthrough body");
    assert.equal(countCacheControls(upstreamBody), 0);
  });
});

describe("claude-passthrough-foreign-server-tool-use-3685", () => {
  // Port of decolua/9router#3685: a built-in-tool provider (z.ai/glm `analyze_image`)
  // emits `server_tool_use` blocks with OpenAI-style `call_` ids. When a combo later
  // routes the conversation to Anthropic, the id fails `^srvtoolu_` and every turn 400s.
  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  afterEach(resetTestDbAndDataDir);

  after(() => {
    globalThis.fetch = originalFetch;
  });

  function makeMessages() {
    return [
      { role: "user", content: [{ type: "text", text: "describe the image" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking at it." },
          {
            type: "server_tool_use",
            id: "call_50b82aba1b754d82a4408a53",
            name: "analyze_image",
            input: {},
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "call_50b82aba1b754d82a4408a53",
            content: [],
          },
          { type: "text", text: "It is a cat." },
        ],
      },
      { role: "user", content: [{ type: "text", text: "search the web" }] },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "srvtoolu_01ABC", name: "web_search", input: { q: "x" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_01ABC", content: [] },
          { type: "text", text: "Found it." },
        ],
      },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ];
  }

  test("drops a foreign server_tool_use id and its paired result, keeps srvtoolu_ blocks", () => {
    const messages = makeMessages();
    const before = JSON.stringify(messages);

    const out = dropForeignServerToolUseBlocks(messages);

    assert.equal(JSON.stringify(messages), before, "input is not mutated");
    assert.deepEqual(out[1].content, [
      { type: "text", text: "Looking at it." },
      { type: "text", text: "It is a cat." },
    ]);
    assert.equal(out[3], messages[3], "valid srvtoolu_ turn keeps its reference");
    assert.equal(out[0], messages[0]);
  });

  test("drops a paired result that lives in another message (tool_result in a user turn)", () => {
    const messages = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [{ type: "server_tool_use", id: "call_x", name: "analyze_image", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_x", content: "r" },
          { type: "text", text: "next" },
        ],
      },
    ];
    const out = dropForeignServerToolUseBlocks(messages);
    assert.deepEqual(out, [
      { role: "user", content: "q" },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
  });

  test("a message left empty after removal is dropped instead of sending empty content", () => {
    const messages = [
      { role: "user", content: "a" },
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "call_only", name: "analyze_image", input: {} },
          { type: "web_search_tool_result", tool_use_id: "call_only", content: [] },
        ],
      },
      { role: "user", content: "b" },
    ];
    const out = dropForeignServerToolUseBlocks(messages);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user", "user"]
    );
    assert.ok(out.every((m) => typeof m.content === "string" || m.content.length > 0));
  });

  test("returns the same reference when nothing is foreign", () => {
    const messages = [makeMessages()[3]];
    assert.equal(dropForeignServerToolUseBlocks(messages), messages);
    assert.equal(dropForeignServerToolUseBlocks(undefined), undefined);
    assert.equal(dropForeignServerToolUseBlocks(null), null);
  });

  async function runPassthrough(provider, model = "claude-opus-5") {
    let captured = null;
    globalThis.fetch = async (url, init = {}) => {
      captured = { url: String(url), body: JSON.parse(String(init.body || "{}")) };
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const body = {
      model,
      max_tokens: 64,
      messages: makeMessages(),
      stream: false,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider, model, extendedContext: false },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "claude-code/2.1.154",
        }),
      },
      userAgent: "claude-code/2.1.154",
    });
    return { captured, result };
  }

  test("claude passthrough never forwards a foreign server_tool_use id to api.anthropic.com", async () => {
    const { captured, result } = await runPassthrough("claude");
    assert.ok(captured, "fetch was not called");
    assert.ok(captured.url.startsWith("https://api.anthropic.com/v1/messages"));
    assert.equal(result.success, true);

    const blocks = captured.body.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : []
    );
    const ids = blocks.filter((b) => b.type === "server_tool_use").map((b) => b.id);
    assert.deepEqual(ids, ["srvtoolu_01ABC"]);
    const resultIds = blocks.filter((b) => b.tool_use_id).map((b) => b.tool_use_id);
    assert.deepEqual(resultIds, ["srvtoolu_01ABC"]);
    assert.ok(
      blocks.some((b) => b.text === "It is a cat."),
      "visible text is preserved"
    );
  });

  test("non-Anthropic Claude-format target (zai) receives the history unchanged", async () => {
    const { captured, result } = await runPassthrough("zai", "glm-5.1");
    assert.ok(captured, "fetch was not called");
    assert.notEqual(new URL(captured.url).hostname, "api.anthropic.com");
    assert.equal(result.success, true);

    const blocks = captured.body.messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : []
    );
    const ids = blocks.filter((b) => b.type === "server_tool_use").map((b) => b.id);
    assert.deepEqual(ids, ["call_50b82aba1b754d82a4408a53", "srvtoolu_01ABC"]);
  });
});

describe("claude-passthrough-thinking-2454", () => {
  const SIG = "SYNTHETIC_SIGNATURE_FIXTURE";

  // `redactPassthroughThinkingSignatures` now passes thinking blocks through
  // unchanged. Rewriting them to `redacted_thinking` made the Anthropic Messages
  // API reject the request with 400 "thinking or redacted_thinking blocks in the
  // latest assistant message cannot be modified" (the blocks are validated against
  // the original response). The thinking signature is validated server-side and
  // stays valid on replay, so the redaction that targeted #2454 is unnecessary.

  test("passes all thinking blocks through unchanged (historical and latest)", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature: "TOKEN_A_SIG_1" },
          { type: "text", text: "answer 1" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "more" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning 2", signature: "TOKEN_A_SIG_2" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    ];
    const before = JSON.stringify(messages);

    const out = redactPassthroughThinkingSignatures(messages, SIG);

    assert.equal(out, messages, "returns the same array reference (no copy / no rewrite)");
    assert.equal(JSON.stringify(out), before, "no block is modified");
    // original signatures survive on every turn, historical and latest
    assert.equal((messages[1].content as { type: string }[])[0].type, "thinking");
    assert.equal((messages[1].content as { signature?: string }[])[0].signature, "TOKEN_A_SIG_1");
    assert.equal((messages[3].content as { type: string }[])[0].type, "thinking");
    assert.equal((messages[3].content as { signature?: string }[])[0].signature, "TOKEN_A_SIG_2");
  });

  test("pre-existing redacted_thinking blocks are not re-stamped", () => {
    const messages = [
      { role: "assistant", content: [{ type: "redacted_thinking", data: "ORIGINAL_DATA" }] },
    ];
    const out = redactPassthroughThinkingSignatures(messages, SIG) as {
      content: { type: string; data: string }[];
    }[];
    assert.equal(out[0].content[0].type, "redacted_thinking");
    assert.equal(out[0].content[0].data, "ORIGINAL_DATA");
  });

  test("non-array messages pass through", () => {
    assert.equal(redactPassthroughThinkingSignatures(undefined, SIG), undefined);
    assert.equal(redactPassthroughThinkingSignatures(null, SIG), null);
  });
});

describe("claude-passthrough-unsigned-thinking-12917", () => {
  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  afterEach(resetTestDbAndDataDir);

  after(() => {
    globalThis.fetch = originalFetch;
  });

  function makeMessages() {
    return [
      { role: "user", content: [{ type: "text", text: "q1" }] },
      {
        // relayed from an OpenAI-compatible leg: reasoning surfaced as an UNSIGNED thinking block
        role: "assistant",
        content: [
          { type: "thinking", thinking: "unsigned relay" },
          { type: "text", text: "a1" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "q2" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "empty sig", signature: "" },
          { type: "redacted_thinking" },
          { type: "thinking", thinking: "genuine", signature: "GENUINE_SIG" },
          { type: "redacted_thinking", data: "GENUINE_DATA" },
          { type: "text", text: "a2" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "q3" }] },
    ];
  }

  test("helper drops thinking/redacted_thinking blocks without a signature and keeps the rest", () => {
    const messages = makeMessages();
    const before = JSON.stringify(messages);

    const out = dropUnsignedPassthroughThinkingBlocks(messages);

    assert.equal(JSON.stringify(messages), before, "input is not mutated");
    assert.deepEqual(out[1].content, [{ type: "text", text: "a1" }]);
    assert.deepEqual(out[3].content, [
      { type: "thinking", thinking: "genuine", signature: "GENUINE_SIG" },
      { type: "redacted_thinking", data: "GENUINE_DATA" },
      { type: "text", text: "a2" },
    ]);
    assert.equal(out[0], messages[0], "untouched messages keep their reference");
  });

  test("helper returns the same reference when every thinking block is signed", () => {
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r", signature: "SIG" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
        ],
      },
    ];
    assert.equal(dropUnsignedPassthroughThinkingBlocks(messages), messages);
    assert.equal(dropUnsignedPassthroughThinkingBlocks(undefined), undefined);
    assert.equal(dropUnsignedPassthroughThinkingBlocks(null), null);
  });

  test("helper drops an assistant message whose only content was unsigned thinking", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "thinking", thinking: "only reasoning" }] },
      { role: "user", content: "b" },
    ];
    const out = dropUnsignedPassthroughThinkingBlocks(messages);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user", "user"]
    );
  });

  test("claude passthrough never replays unsigned thinking history to api.anthropic.com", async () => {
    let captured = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = { url: String(url), body: JSON.parse(String(init.body || "{}")) };
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const body = {
      model: "claude-opus-5",
      max_tokens: 64,
      system: [{ type: "text", text: "You are Claude." }],
      messages: makeMessages(),
      stream: false,
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "claude", model: "claude-opus-5", extendedContext: false },
      credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "claude-code/2.1.154",
        }),
      },
      userAgent: "claude-code/2.1.154",
    });

    assert.ok(captured, "fetch was not called");
    assert.ok(captured.url.startsWith("https://api.anthropic.com/v1/messages"));
    assert.equal(result.success, true);

    const sentBlocks = captured.body.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((b) => b.type === "thinking" || b.type === "redacted_thinking");
    assert.deepEqual(sentBlocks, [
      { type: "thinking", thinking: "genuine", signature: "GENUINE_SIG" },
      { type: "redacted_thinking", data: "GENUINE_DATA" },
    ]);
    assert.ok(
      captured.body.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.text === "a1")
      ),
      "the visible answer text of the affected turn is preserved"
    );
  });
});

describe("claude-thread-translated-route", () => {
  // Claude Code's message-threads beta sends a delta body with a top-level `thread` object. Only
  // Anthropic holds the thread state. A translated route would drop the task, the system prompt
  // and the earlier turns, so it answers 400 invalid_request_error and the client resends the
  // full conversation. Native Anthropic targets keep the field.
  type Json = Record<string, unknown>;

  after(async () => {
    globalThis.fetch = originalFetch;
    await flushAsyncSideEffects();
  });

  function threadBody(thread: unknown = { type: "continue", previous_message_id: "msg_1" }): Json {
    return {
      model: "gpt-4o",
      max_tokens: 64,
      stream: false,
      thread,
      messages: [{ role: "user", content: "and then?" }],
    };
  }

  function translate(target: string, provider: string, body: Json) {
    return translateRequest(FORMATS.CLAUDE, target, "gpt-4o", body, false, null, provider) as Json;
  }

  test("Claude -> OpenAI translation rejects a message-thread request with a 400", async () => {
    await assert.rejects(
      async () => translate(FORMATS.OPENAI, "openai", threadBody()),
      (error: Error & { statusCode?: number; errorType?: string; details?: Json }) => {
        assert.equal(error.statusCode, 400);
        assert.equal(error.errorType, "invalid_request_error");
        assert.equal(error.details?.error_code, "thread_unsupported_request");
        return true;
      }
    );
  });

  test("Claude -> Claude gateway that is not Anthropic rejects a message-thread request too", async () => {
    await assert.rejects(
      async () => translate(FORMATS.CLAUDE, "kimi-coding", threadBody()),
      (error: Error & { statusCode?: number }) => error.statusCode === 400
    );
  });

  test("a native Anthropic target does not reject a message-thread request", async () => {
    for (const provider of ["claude", "anthropic", "anthropic-compatible-acme"]) {
      await assert.doesNotReject(
        async () => translate(FORMATS.CLAUDE, provider, threadBody()),
        provider
      );
    }
  });

  test("a body without a thread object is translated as before", async () => {
    for (const thread of [undefined, null, "continue", ["continue"]]) {
      const body = threadBody(thread);
      if (thread === undefined) delete body.thread;
      await assert.doesNotReject(
        async () => translate(FORMATS.OPENAI, "openai", body),
        String(thread)
      );
    }
  });

  test("only a Claude source is checked: an OpenAI body with a thread field is left alone", async () => {
    await assert.doesNotReject(async () =>
      translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, "claude-sonnet-4-6", threadBody(), false)
    );
  });

  test("handleChatCore answers 400 and never calls the upstream for a thread request", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const body = threadBody();
    const result = (await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o", extendedContext: false },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({
          accept: "application/json",
          "content-type": "application/json",
          "anthropic-beta": "message-threads-2026-08-12",
        }),
      },
      userAgent: "claude-code/2.1.291",
    })) as { success: boolean; status?: number; response?: Response };

    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    const payload = (await result.response!.json()) as {
      error?: { type?: string; details?: { error_code?: string } };
    };
    assert.equal(payload.error?.type, "invalid_request_error");
    // Anthropic SDK clients that opt into continue_unthreaded read this code to resend unthreaded.
    assert.equal(payload.error?.details?.error_code, "thread_unsupported_request");
    assert.equal(fetchCalls, 0, "the upstream must not receive a history-less delta");
  });

  test("a translation failure forwards only a public-safe detail code", async () => {
    const { createTranslationFailureResult } =
      await import("../../../open-sse/handlers/chatCore/translationFailure.ts");
    const forwarded = createTranslationFailureResult(
      400,
      "no threads here",
      "invalid_request_error",
      "thread_unsupported_request"
    );
    const withCode = (await forwarded.response.json()) as { error: { details?: Json } };
    assert.deepEqual(withCode.error.details, { error_code: "thread_unsupported_request" });

    for (const unsafe of ["has spaces and\nnewline", "x".repeat(200), "not_in_the_public_list"]) {
      const dropped = createTranslationFailureResult(400, "m", "invalid_request_error", unsafe);
      const body = (await dropped.response.json()) as { error: { details?: Json } };
      assert.equal(body.error.details, undefined, unsafe.slice(0, 20));
    }
  });
});

describe("claude-timing-inline-tools-beta-forward", () => {
  const PER_TURN_BETA = "per-turn-control-2026-07-01";
  const TIMING_BETA = "timing-2026-09-09";
  const INLINE_TOOLS_BETA = "inline-tools-2026-09-15";
  const CLAUDE_CODE_BETA_HEADER = [
    "claude-code-20250219",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "effort-2025-11-24",
    "mid-conversation-system-2026-04-07",
    PER_TURN_BETA,
    TIMING_BETA,
    INLINE_TOOLS_BETA,
  ].join(",");

  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  afterEach(resetTestDbAndDataDir);

  after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const beta of [TIMING_BETA, INLINE_TOOLS_BETA]) {
    test(`mergeClientAnthropicBeta forwards the client-negotiated ${beta}`, () => {
      assert.ok(FORWARDABLE_CLIENT_BETAS.includes(beta));
      const merged = mergeClientAnthropicBeta("claude-code-20250219", CLAUDE_CODE_BETA_HEADER);
      assert.ok(merged.split(",").includes(beta), `${beta} must reach the upstream`);
    });
  }

  test("mergeClientAnthropicBeta does not invent timing or inline-tools betas", () => {
    const merged = mergeClientAnthropicBeta("claude-code-20250219", "effort-2025-11-24");
    for (const beta of [TIMING_BETA, INLINE_TOOLS_BETA]) {
      assert.ok(!merged.split(",").includes(beta), `${beta} was never negotiated by the client`);
    }
  });

  test("claude passthrough sends timing and inline-tools betas with the fields they gate", async () => {
    let captured = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      };
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const body = {
      model: "claude-opus-5",
      max_tokens: 64,
      system: [{ type: "text", text: "You are Claude." }],
      tools: [
        { type: "advisor_20260301", name: "advisor", model: "claude-fable-5-1" },
        { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: "hello" },
        {
          role: "system",
          content: [
            { type: "text", text: "Subagent context." },
            { type: "tool_addition", tool: { type: "tool_reference", name: "advisor" } },
          ],
          output_config: { effort: "medium" },
        },
        { role: "user", content: "go" },
      ],
      stream: false,
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "claude", model: "claude-opus-5", extendedContext: false },
      credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "claude-code/2.1.284",
          "anthropic-beta": CLAUDE_CODE_BETA_HEADER,
        }),
      },
      userAgent: "claude-code/2.1.284",
    });

    assert.ok(captured, "fetch was not called");
    assert.ok(captured.url.startsWith("https://api.anthropic.com/v1/messages"));
    assert.equal(result.success, true);

    const forwarded = (captured.headers.get("anthropic-beta") ?? "").split(",");
    assert.ok(forwarded.includes(PER_TURN_BETA), "per-turn-control beta missing upstream");
    assert.ok(forwarded.includes(TIMING_BETA), "timing beta missing upstream");
    assert.ok(forwarded.includes(INLINE_TOOLS_BETA), "inline-tools beta missing upstream");

    const systemMessage = captured.body.messages.find((message) => message.role === "system");
    assert.ok(systemMessage, "mid-conversation system message missing upstream");
    assert.deepEqual(systemMessage.output_config, { effort: "medium" });
    assert.ok(systemMessage.content.some((block) => block.type === "tool_addition"));
  });
});

describe("claude-tool-addition-hoist", () => {
  type Json = Record<string, unknown>;

  after(async () => {
    globalThis.fetch = originalFetch;
    await flushAsyncSideEffects();
  });

  function addition(name: string): Json {
    return {
      type: "tool_addition",
      tool: {
        type: "tool_definition",
        definition: {
          name,
          description: "MCP tool",
          input_schema: { type: "object", properties: {} },
        },
      },
    };
  }

  function makeBody(): Json {
    return {
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "system",
          content: [{ type: "text", text: "context" }, addition("mcp_tool")],
        },
        { role: "user", content: [{ type: "text", text: "go" }] },
      ],
    };
  }

  function toolNames(tools: unknown): string[] {
    if (!Array.isArray(tools)) return [];
    return tools.map((tool: Json) => {
      const fn = tool.function as Json | undefined;
      return String(fn?.name ?? tool.name);
    });
  }

  test("hoistToolAdditions moves definitions into tools without duplicates and keeps the source", async () => {
    const body = {
      tools: [{ name: "existing", input_schema: { type: "object" } }],
      messages: [
        {
          role: "system",
          content: [addition("new_tool"), addition("new_tool"), addition("existing")],
        },
        { role: "user", content: [{ type: "text", text: "run" }, addition("other_tool")] },
      ],
    };
    const snapshot = structuredClone(body);

    const result = hoistToolAdditions(body);

    assert.deepEqual(toolNames(result.tools), ["existing", "new_tool", "other_tool"]);
    assert.deepEqual(result.messages, [{ role: "user", content: [{ type: "text", text: "run" }] }]);
    assert.deepEqual(body, snapshot, "the input body must not be mutated");
  });

  test("hoistToolAdditions drops tool_reference additions and returns untouched bodies as-is", async () => {
    const plain = makeBody();
    plain.messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    assert.equal(hoistToolAdditions(plain), plain);

    const withReference = {
      tools: [{ name: "advisor", input_schema: { type: "object" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_addition", tool: { type: "tool_reference", name: "advisor" } },
          ],
        },
      ],
    };
    const result = hoistToolAdditions(withReference);
    assert.deepEqual(toolNames(result.tools), ["advisor"]);
    assert.deepEqual(result.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  test("hoistToolAdditions merges same-role neighbours left adjacent by a removed turn", async () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [addition("mcp_tool")] },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
      system: [{ type: "text", text: "sys" }, addition("sys_tool")],
    };

    const result = hoistToolAdditions(body);

    assert.deepEqual(toolNames(result.tools), ["sys_tool", "mcp_tool"]);
    assert.deepEqual(result.system, [{ type: "text", text: "sys" }]);
    assert.deepEqual(result.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  test("acceptsInlineToolAdditions only for Anthropic-native targets", async () => {
    for (const provider of ["claude", "anthropic", "anthropic-compatible-acme"]) {
      assert.equal(acceptsInlineToolAdditions(provider), true, provider);
    }
    for (const provider of ["kimi-coding", "zai", "deepseek", "vertex", "kimi", null]) {
      assert.equal(acceptsInlineToolAdditions(provider), false, String(provider));
    }
  });

  test("Claude -> OpenAI translation exposes the deferred MCP tool as a function", async () => {
    const body = makeBody();
    const result = (await translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "kimi-k2",
      body,
      true,
      null,
      "kimi"
    )) as Json;

    assert.ok(toolNames(result.tools).includes("mcp_tool"), "mcp_tool must reach tools[]");
    assert.ok(!JSON.stringify(result.messages).includes("tool_addition"));
    assert.ok(JSON.stringify(body.messages).includes("tool_addition"), "source body untouched");
  });

  test("Claude -> Claude translation hoists for third-party gateways only", async () => {
    const kimi = (await translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "kimi-for-coding",
      makeBody(),
      true,
      null,
      "kimi-coding"
    )) as Json;
    assert.ok(toolNames(kimi.tools).includes("mcp_tool"));
    assert.ok(!JSON.stringify(kimi.messages).includes("tool_addition"));

    const claude = (await translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "claude-sonnet-4-6",
      makeBody(),
      true,
      null,
      "claude"
    )) as Json;
    assert.ok(JSON.stringify(claude.messages).includes("tool_addition"));
    assert.ok(!toolNames(claude.tools).includes("mcp_tool"));
  });

  test("claude passthrough to a third-party Claude gateway sends the MCP tool in tools[]", async () => {
    let captured: Json | null = null;
    globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
      captured = JSON.parse(String(init.body || "{}"));
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "glm-5.3",
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const body = { ...makeBody(), model: "glm-5.3", stream: false };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "zai", model: "glm-5.3", extendedContext: false },
      credentials: { apiKey: "test-zai-key", providerSpecificData: {} },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "claude-code/2.1.284",
          "anthropic-beta": "claude-code-20250219,inline-tools-2026-09-15",
        }),
      },
      userAgent: "claude-code/2.1.284",
    });

    assert.equal(result.success, true);
    assert.ok(captured, "fetch was not called");
    const upstream = captured as Json;
    assert.ok(toolNames(upstream.tools).includes("mcp_tool"), "mcp_tool must reach tools[]");
    assert.ok(!JSON.stringify(upstream).includes("tool_addition"));
  });
});

describe("system-transforms-provider-scope", () => {
  // Regression test for the per-provider system transforms gap.
  //
  // `systemTransforms.providers.<key>` has always accepted any provider key
  // ("generic per-provider DSL covering native claude, anthropic-compatible-cc-*
  // bridge, and any other provider key"), but only the Claude-native
  // (executors/base.ts) and CC-bridge (services/claudeCodeCompatible.ts) wire
  // paths ever applied it, and the executor itself only read/wrote the Claude
  // `system` field. A pipeline configured for an OpenAI-shaped provider such as
  // `kiro` was therefore inert: the config saved, the UI showed it, and no
  // request ever had it applied.
  //
  // This test asserts the fixed behaviour:
  //  - non-Claude provider keys get the pipeline applied from chatCore, on the
  //    client-shaped body, BEFORE translation (so the translators carry it);
  //  - the OpenAI `messages[]` system carrier is read and written instead of a
  //    `body.system` field those translators ignore;
  //  - `claude` / `anthropic-compatible-cc-*` stay skipped, because their own
  //    executors already apply the same config (no double application);
  //  - Claude-shaped bodies keep writing `body.system` exactly as before.
  const RULE_KEY = "tool-calling-rule:";
  const TOOL_RULE = `${RULE_KEY} emit standard function calls only`;
  const APPEND_OP = {
    kind: "append_system_block",
    text: TOOL_RULE,
    // `idempotencyKey` is matched as a text prefix by the op, so the block text
    // must start with it for repeat passes to be no-ops.
    idempotencyKey: RULE_KEY,
  };

  /** Provider-scoped config: an enabled pipeline for `kiro`, plus a claude entry
   *  that must stay untouched by the generic entry point. */
  function config(providers) {
    return {
      providers: Object.assign(
        {
          kiro: { enabled: true, pipeline: [APPEND_OP] },
          claude: { enabled: true, pipeline: [APPEND_OP] },
          "anthropic-compatible-cc": { enabled: true, pipeline: [APPEND_OP] },
        },
        providers || {}
      ),
    };
  }

  function openAiKiroBody() {
    return {
      model: "claude-opus-5.5",
      messages: [
        { role: "system", content: "You are a helpful agent." },
        { role: "user", content: "hello" },
      ],
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Provider scope
  // ──────────────────────────────────────────────────────────────────────────

  test("kiro: a per-provider pipeline reaches an OpenAI-shaped client body", () => {
    const body = openAiKiroBody();
    const result = applyProviderSystemTransforms("kiro", body, config());

    assert.deepEqual(result.appliedOpKinds, ["append_system_block"]);
    assert.match(String(body.messages[0].content), /You are a helpful agent\./);
    assert.match(String(body.messages[0].content), /emit standard function calls only/);
    // The carrier is messages[]: no stray Claude-shaped `system` field is created.
    assert.equal(body.system, undefined);
    assert.equal(body.messages.length, 2, "no extra system message is inserted");
  });

  test("kiro: the pipeline is idempotent across repeated passes", () => {
    const body = openAiKiroBody();
    applyProviderSystemTransforms("kiro", body, config());
    applyProviderSystemTransforms("kiro", body, config());
    const content = String(body.messages[0].content);
    assert.equal(content.split(TOOL_RULE).length - 1, 1, "block appended exactly once");
  });

  test("claude is skipped — its executor applies the same config downstream", () => {
    assert.equal(isSystemTransformsHandledDownstream(PROVIDER_CLAUDE), true);
    const body = openAiKiroBody();
    const result = applyProviderSystemTransforms(PROVIDER_CLAUDE, body, config());
    assert.deepEqual(result.appliedOpKinds, []);
    assert.equal(String(body.messages[0].content), "You are a helpful agent.");
  });

  test("anthropic-compatible-cc-* providers are skipped (shared bridge config)", () => {
    assert.equal(isSystemTransformsHandledDownstream(PROVIDER_CC_BRIDGE), true);
    assert.equal(isSystemTransformsHandledDownstream(`${PROVIDER_CC_BRIDGE}-7f3a`), true);
    const body = openAiKiroBody();
    const result = applyProviderSystemTransforms(`${PROVIDER_CC_BRIDGE}-7f3a`, body, config());
    assert.deepEqual(result.appliedOpKinds, []);
  });

  test("a provider with no configured pipeline is a no-op", () => {
    const body = openAiKiroBody();
    const result = applyProviderSystemTransforms("antigravity", body, config());
    assert.deepEqual(result.appliedOpKinds, []);
    assert.equal(String(body.messages[0].content), "You are a helpful agent.");
  });

  test("a disabled pipeline is a no-op", () => {
    const body = openAiKiroBody();
    const result = applyProviderSystemTransforms(
      "kiro",
      body,
      config({ kiro: { enabled: false, pipeline: [APPEND_OP] } })
    );
    assert.deepEqual(result.appliedOpKinds, []);
    assert.equal(String(body.messages[0].content), "You are a helpful agent.");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OpenAI carrier handling
  // ──────────────────────────────────────────────────────────────────────────

  test("a client body without a system message gets one created at the front", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const result = applyProviderSystemTransforms("kiro", body, config());
    assert.deepEqual(result.appliedOpKinds, ["append_system_block"]);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, TOOL_RULE);
    assert.equal(body.messages[1].role, "user");
  });

  test("a text-part array carrier is read and rewritten as text", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: "You are a helpful agent." }] },
        { role: "user", content: "hello" },
      ],
    };
    applyProviderSystemTransforms("kiro", body, config());
    assert.equal(body.messages[0].content, `You are a helpful agent.\n\n${TOOL_RULE}`);
  });

  test("a non-text carrier is left untouched rather than silently losing content", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "image_url", image_url: { url: "x" } }] },
        { role: "user", content: "hello" },
      ],
    };
    const result = applyProviderSystemTransforms("kiro", body, config());
    assert.deepEqual(result.appliedOpKinds, []);
    assert.deepEqual(body.messages[0].content, [{ type: "image_url", image_url: { url: "x" } }]);
  });

  test("Claude-shaped bodies keep writing the top-level `system` field", () => {
    const body = {
      system: "You are a helpful agent.",
      messages: [{ role: "user", content: "hello" }],
    };
    const result = applyProviderSystemTransforms(
      "minimax",
      body,
      config({
        minimax: { enabled: true, pipeline: [APPEND_OP] },
      })
    );
    assert.deepEqual(result.appliedOpKinds, ["append_system_block"]);
    assert.ok(Array.isArray(body.system), "system is normalised to a block array");
    const text = body.system.map((b) => b.text).join("\n\n");
    assert.match(text, /You are a helpful agent\./);
    assert.match(text, /emit standard function calls only/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Wiring — chatCore must call the generic entry point before translation
  // ──────────────────────────────────────────────────────────────────────────

  test("chatCore applies the per-provider pipeline on the pre-translation body", () => {
    const chatCore = fs.readFileSync(path.join(REPO_ROOT, "open-sse/handlers/chatCore.ts"), "utf8");
    assert.match(
      chatCore,
      /import \{ applyProviderSystemTransforms \} from "\.\.\/services\/systemTransforms\.ts";/,
      "chatCore must import the generic entry point"
    );
    assert.match(
      chatCore,
      /applyProviderSystemTransforms\(\s*provider,/,
      "chatCore must pass the resolved provider key"
    );

    const callSite = chatCore.indexOf("applyProviderSystemTransforms(");
    const translateCall = chatCore.indexOf("translatedBody = await translateRequest(", callSite);
    assert.ok(callSite > -1 && translateCall > callSite, "call site must precede translateRequest");
  });
});

describe("system-role-extraction", () => {
  test("extractSystemRoleMessages moves role=system to top-level system", () => {
    const payload = {
      messages: [
        { role: "system", content: "Memory context: foo" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].role, "user");
    assert.deepEqual(payload.system, [{ type: "text", text: "Memory context: foo" }]);
  });

  test("extractSystemRoleMessages also lifts role=developer (OpenAI Responses system alias)", () => {
    const payload = {
      messages: [
        { role: "developer", content: "Dev instructions" },
        { role: "system", content: "Sys context" },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    // both developer and system are removed from messages and lifted into system
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].role, "user");
    assert.deepEqual(payload.system, [
      { type: "text", text: "Dev instructions" },
      { type: "text", text: "Sys context" },
    ]);
  });

  test("extractSystemRoleMessages merges with existing top-level system string", () => {
    const payload = {
      system: "You are Claude.",
      messages: [
        { role: "system", content: "Memory context: bar" },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.system, [
      { type: "text", text: "You are Claude." },
      { type: "text", text: "Memory context: bar" },
    ]);
  });

  test("extractSystemRoleMessages merges with existing top-level system array", () => {
    const payload = {
      system: [{ type: "text", text: "Existing system" }],
      messages: [
        { role: "system", content: "Memory context: baz" },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.system, [
      { type: "text", text: "Existing system" },
      { type: "text", text: "Memory context: baz" },
    ]);
  });

  test("extractSystemRoleMessages does nothing when no system role messages", () => {
    const payload = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.system, undefined);
  });

  test("extractSystemRoleMessages handles non-array messages gracefully", () => {
    const payload = { messages: "not-an-array" };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages, "not-an-array");
  });

  test("extractSystemRoleMessages handles empty messages array", () => {
    const payload = { messages: [] };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 0);
  });

  test("extractSystemRoleMessages handles case-insensitive role System", () => {
    const payload = {
      messages: [
        { role: "System", content: "Memory context: caps" },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.system, [{ type: "text", text: "Memory context: caps" }]);
  });

  test("extractSystemRoleMessages drops empty text content from system messages", () => {
    const payload = {
      messages: [
        { role: "system", content: "" },
        { role: "system", content: "valid" },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.system, [{ type: "text", text: "valid" }]);
  });

  test("extractSystemRoleMessages handles system messages with array content", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Block 1" },
            { type: "text", text: "Block 2" },
          ],
        },
        { role: "user", content: "hello" },
      ],
    };
    extractSystemRoleMessages(payload);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.system, [
      { type: "text", text: "Block 1" },
      { type: "text", text: "Block 2" },
    ]);
  });
});

describe("thinking-signature-diagnostics-chatcore-wiring-15534", () => {
  // #15534 — handleChatCore must forward the pipeline's onSignatureFailure hook so an
  // Anthropic invalid-signature 400 emits exactly one bounded THINKING_SIGNATURE event
  // on both the streaming and the non-streaming legs (no payload text in the event).
  const SECRET_THINKING = "private chain of thought 15534";

  function captureLog() {
    const warnings = [];
    return {
      warnings,
      log: {
        debug() {},
        info() {},
        warn(tag, message) {
          warnings.push({ tag, message });
        },
        error() {},
      },
    };
  }

  afterEach(resetDbHandleAndDataDir);

  after(() => {
    globalThis.fetch = originalFetch;
  });

  function okResponse(stream) {
    if (stream) {
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_ok",
            type: "message",
            role: "assistant",
            model: "claude-opus-5",
            content: [],
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({
        id: "msg_ok",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  async function runSignatureFailure(stream) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "messages.1.content.0: Invalid `signature` in `thinking` block",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return okResponse(stream);
    };

    const body = {
      model: "claude-opus-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "q1" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: SECRET_THINKING, signature: "SIG_FOREIGN_15534" },
            { type: "text", text: "a1" },
          ],
        },
        { role: "user", content: "q2" },
      ],
      stream,
    };

    const { warnings, log } = captureLog();
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "claude", model: "claude-opus-5", extendedContext: false },
      credentials: { apiKey: "test-claude-key", providerSpecificData: {} },
      log,
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({
          accept: stream ? "text/event-stream" : "application/json",
          "content-type": "application/json",
          "user-agent": "claude-code/2.1.154",
        }),
      },
      userAgent: "claude-code/2.1.154",
    });
    if (stream && result?.response?.body) await result.response.text();
    return { calls, result, events: warnings.filter((w) => w.tag === "THINKING_SIGNATURE") };
  }

  for (const stream of [false, true]) {
    test(`handleChatCore (stream=${stream}) emits one bounded THINKING_SIGNATURE event`, async () => {
      const { calls, result, events } = await runSignatureFailure(stream);
      assert.equal(calls, 2, "one recovery send after the signature 400");
      assert.equal(result.success, true);
      assert.equal(events.length, 1, "exactly one diagnostics event per signature failure");
      const event = JSON.parse(events[0].message);
      assert.equal(event.provider, "claude");
      assert.equal(event.status, 400);
      assert.equal(event.recoveryAttempted, true);
      assert.equal(event.recoverySucceeded, true);
      assert.ok(!events[0].message.includes(SECRET_THINKING), "event must not carry thinking text");
      assert.ok(
        !events[0].message.includes("SIG_FOREIGN_15534"),
        "event must not carry signatures"
      );
    });
  }
});

describe("anthropic-fallback-policy-16406", () => {
  const requested = "claude-opus-5-5";
  let previousApiKeySecret: string | undefined;

  // API_KEY_SECRET is read at call time (API key CRC, Claude identity ids), so scoping it to
  // this describe matches the former file, which set it before loading the app.
  before(async () => {
    previousApiKeySecret = process.env.API_KEY_SECRET;
    process.env.API_KEY_SECRET = "fallback-16406-test-secret-only";
    await resetTestDb();
  });

  after(async () => {
    assert.equal(await waitForCallLogSaves(10_000), true);
    globalThis.fetch = originalFetch;
    if (previousApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = previousApiKeySecret;
  });

  function anthropicSuccess(model: string, stream: boolean): Response {
    const message = {
      id: "msg-fixture",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    };
    if (!stream) return Response.json(message);
    const events = [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      {
        headers: { "content-type": "text/event-stream" },
      }
    );
  }

  async function request(
    stream: boolean,
    optIn: boolean,
    key?: { key: string; id: string },
    identity?: { bearer: string; scopeId?: string }
  ) {
    const sent: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const outbound = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
      sent.push(outbound.model);
      assert.equal(
        new Headers(init?.headers).get("x-omniroute-allow-cross-version-fallback"),
        null,
        "internal policy header must not reach upstream"
      );
      if (outbound.model === requested) {
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: `model: ${requested}` } },
          { status: 404 }
        );
      }
      return anthropicSuccess(outbound.model, outbound.stream === true);
    };
    const body = {
      model: `anthropic/${requested}`,
      stream,
      messages: [{ role: "user", content: "Reply OK" }],
      max_tokens: 8,
    };
    const headers = new Headers({ accept: stream ? "text/event-stream" : "application/json" });
    if (optIn) headers.set("x-omniroute-allow-cross-version-fallback", "true");
    if (key) headers.set("authorization", `Bearer ${key.key}`);
    if (identity) headers.set("authorization", `Bearer ${identity.bearer}`);
    if (identity?.scopeId) headers.set("x-omniroute-self-loop-key-id", identity.scopeId);
    const result = await handleChatCore({
      apiKeyInfo: key ? { id: key.id } : undefined,
      body,
      modelInfo: { provider: "anthropic", model: requested },
      credentials: {
        apiKey: "fixture-key",
        connectionId: "policy-fixture",
        providerSpecificData: {},
      },
      connectionId: "policy-fixture",
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers },
      userAgent: "unit-test",
    });
    return { result, sent, text: await result.response.text() };
  }

  for (const stream of [false, true]) {
    test(`stream=${stream}: default does not silently dispatch another model version`, async () => {
      const { result, sent } = await request(stream, false);
      assert.equal(result.success, false, JSON.stringify({ sent, status: result.status }));
      assert.ok(sent.length > 0);
      assert.ok(
        sent.every((model) => model === requested),
        JSON.stringify(sent)
      );
    });
    test(`stream=${stream}: opted-in fallback reports the actual dispatched model`, async () => {
      const { result, sent, text } = await request(stream, true);
      assert.equal(result.success, true, JSON.stringify({ sent, status: result.status, text }));
      assert.notEqual(sent.at(-1), requested, JSON.stringify(sent));
      assert.equal(result.response.headers.get("x-omniroute-model"), sent.at(-1));
      if (!stream) assert.equal(JSON.parse(text).model, sent.at(-1));
      else assert.ok(text.includes(`"model":"${sent.at(-1)}"`), text);
    });
  }

  for (const stream of [false, true]) {
    test(`stream=${stream}: opt-in cannot authorize a model denied to the API key`, async () => {
      const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
      const key = await createApiKey("fallback restriction fixture", "fixture-machine", [], {
        modelAccessMode: "restricted",
        allowedModels: [`anthropic/${requested}`],
      });
      const { result, sent } = await request(stream, true, key);
      assert.equal(result.success, false);
      assert.ok(sent.length > 0);
      assert.ok(
        sent.every((model) => model === requested),
        JSON.stringify(sent)
      );
    });
  }

  for (const stream of [false, true]) {
    test(`stream=${stream}: an authorized API key can opt into the fallback model`, async () => {
      const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
      const key = await createApiKey("fallback permitted fixture", "fixture-machine", [], {
        modelAccessMode: "restricted",
        allowedModels: [`anthropic/${requested}`, "anthropic/claude-opus-5"],
      });
      const { result, sent } = await request(stream, true, key);
      assert.equal(result.success, true);
      assert.equal(sent.at(-1), "claude-opus-5");
      assert.equal(result.response.headers.get("x-omniroute-model"), "claude-opus-5");
    });
  }

  test("API-key metadata without a resolvable credential cannot authorize a fallback", async () => {
    const { getNextRequestFamilyFallback } =
      await import("../../../open-sse/services/modelFamilyFallbackPolicy.ts");
    assert.equal(
      await getNextRequestFamilyFallback(requested, new Set([requested]), "anthropic", {
        headers: { "x-omniroute-allow-cross-version-fallback": "true" },
        hasApiKeyMetadata: true,
      }),
      null
    );
  });

  test("the opt-in header is allowed by both browser preflight surfaces", async () => {
    const app = await import("../../../src/shared/utils/cors.ts");
    const engine = await import("../../../open-sse/utils/cors.ts");
    for (const headers of [app.CORS_HEADERS, engine.CORS_HEADERS]) {
      assert.ok(
        headers["Access-Control-Allow-Headers"]
          .toLowerCase()
          .includes("x-omniroute-allow-cross-version-fallback")
      );
    }
  });

  test("opt-in composes API-key grants with hidden models and active-connection lockouts", async () => {
    const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
    const { setModelIsHidden } = await import("../../../src/lib/db/models.ts");
    const { lockExactModel, clearAllModelLockouts } =
      await import("../../../open-sse/services/accountFallback.ts");
    const key = await createApiKey("combined fallback eligibility fixture", "fixture-machine", [], {
      modelAccessMode: "restricted",
      allowedModels: [
        `anthropic/${requested}`,
        "anthropic/claude-opus-5",
        "anthropic/claude-opus-4.8",
      ],
    });
    setModelIsHidden("anthropic", "claude-opus-5", true, "chat");
    lockExactModel("anthropic", "policy-fixture", "claude-opus-4.8", "rate_limit", 60_000);
    try {
      const restricted = await request(false, true, key);
      assert.equal(restricted.result.success, false);
      assert.ok(restricted.sent.every((model) => model === requested));
      const unrestricted = await request(false, true);
      assert.equal(unrestricted.result.success, true);
      assert.equal(unrestricted.sent.at(-1), "claude-sonnet-5");
    } finally {
      setModelIsHidden("anthropic", "claude-opus-5", false, "chat");
      clearAllModelLockouts();
    }
  });

  for (const stream of [false, true]) {
    test(`stream=${stream}: scoped self-loop fallback uses the original restricted key`, async () => {
      const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
      const { resolveSelfLoopBearer } =
        await import("../../../src/shared/middleware/chatAdmissionIdentity.ts");
      const key = await createApiKey("scoped fallback fixture", "fixture-machine", [], {
        modelAccessMode: "restricted",
        allowedModels: [`anthropic/${requested}`],
      });
      const { result, sent } = await request(stream, true, key, {
        bearer: resolveSelfLoopBearer(),
        scopeId: key.id,
      });
      assert.equal(result.success, false);
      assert.ok(sent.every((model) => model === requested));
    });
  }

  test("an unknown self-loop scope fails closed instead of using the internal bearer", async () => {
    const { resolveSelfLoopBearer } =
      await import("../../../src/shared/middleware/chatAdmissionIdentity.ts");
    const { getNextRequestFamilyFallback } =
      await import("../../../open-sse/services/modelFamilyFallbackPolicy.ts");
    const next = await getNextRequestFamilyFallback(requested, new Set([requested]), "anthropic", {
      hasApiKeyMetadata: true,
      headers: {
        authorization: `Bearer ${resolveSelfLoopBearer()}`,
        "x-omniroute-self-loop-key-id": "missing-fixture-key",
        "x-omniroute-allow-cross-version-fallback": "true",
      },
    });
    assert.equal(next, null);
  });

  test("a valid unscoped self-loop retains its permitted opt-in fallback", async () => {
    const { resolveSelfLoopBearer } =
      await import("../../../src/shared/middleware/chatAdmissionIdentity.ts");
    const { getNextRequestFamilyFallback } =
      await import("../../../open-sse/services/modelFamilyFallbackPolicy.ts");
    assert.equal(
      await getNextRequestFamilyFallback(requested, new Set([requested]), "anthropic", {
        hasApiKeyMetadata: true,
        headers: {
          authorization: `Bearer ${resolveSelfLoopBearer()}`,
          "x-omniroute-allow-cross-version-fallback": "true",
        },
      }),
      "claude-opus-5"
    );
  });
});
