// @ts-nocheck
// handleChatCore request shaping: body sanitization, output caps, output_config stripping,
// cache policy, reasoning-cache writes, stale forwarding headers and the guardrail wiring.
//
// Merged from 9 single-topic files so the chatCore module graph loads once per process
// instead of once per file. Each `describe` below is one former file (its name is the old
// file name without `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Each
// describe restores the globals it stubs (fetch, feature flags, caches) in its own hooks; the
// database handle is closed once at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, test } from "node:test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-request-shaping-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// chatcore-cache-policy kept the plugin scanner inside its own DATA_DIR.
process.env.OMNIROUTE_PLUGINS_DIR = path.join(TEST_DATA_DIR, "plugins");

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { clearCache, getCachedResponse, generateSignature } =
  await import("../../../src/lib/semanticCache.ts");
const { SemanticCacheManager, resetSemanticCacheManager } =
  await import("../../../open-sse/services/cache/semanticCacheManager.ts");
const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");
const { clearInflight } = await import("../../../open-sse/services/requestDedup.ts");
const { clearPendingRequests } = await import("../../../src/lib/usage/usageHistory.ts");
const { waitForCallLogSaves } = await import("../../../src/lib/usage/callLogs.ts");
const overridesDb = await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const featureFlagsDb = await import("../../../src/lib/db/featureFlags.ts");
const { refreshFeatureFlagSnapshot } = await import("../../../src/shared/utils/featureFlags.ts");
const { stripOutputConfigFormatForCompat, FIRST_PARTY_ANTHROPIC_PROVIDERS } =
  await import("../../../open-sse/handlers/chatCore/outputConfigFormatStrip.ts");
const { buildReasoningCacheScope, buildToolCallCacheKey, lookupReasoning, clearReasoningCacheAll } =
  await import("../../../open-sse/services/reasoningCache.ts");

const originalFetch = globalThis.fetch;

async function flushAsyncSideEffects() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

after(async () => {
  globalThis.fetch = originalFetch;
  await waitForCallLogSaves(5000);
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("chatcore-cache-policy", () => {
  function buildOpenAIResponse(stream: boolean, text: string) {
    const completion = {
      id: "chatcmpl-cache-policy",
      object: stream ? "chat.completion.chunk" : "chat.completion",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          ...(stream
            ? { delta: { role: "assistant", content: text } }
            : { message: { role: "assistant", content: text } }),
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
    return new Response(
      stream
        ? `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`
        : JSON.stringify(completion),
      { headers: { "Content-Type": stream ? "text/event-stream" : "application/json" } }
    );
  }

  async function invokeChatCore({
    body,
    apiKeyInfo,
    accept,
    responseFactory,
  }: {
    body: Record<string, unknown>;
    apiKeyInfo: { id: string; cacheDefaultMode: string };
    accept: string;
    responseFactory: () => Response;
  }) {
    const calls: unknown[] = [];
    globalThis.fetch = async () => {
      calls.push(true);
      return responseFactory();
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      apiKeyInfo,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept }),
      },
    } as Parameters<typeof handleChatCore>[0]);
    await flushAsyncSideEffects();
    return { result, calls };
  }

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await waitForCallLogSaves(5000);
    clearPendingRequests();
    clearInflight();
    await clearCache();
    resetSemanticCacheManager(null);
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  after(async () => {
    await waitForCallLogSaves(5000);
  });

  for (const stream of [false, true]) {
    for (const control of ["key bypass", "settings toggle"]) {
      test(`chatCore skips semantic cache writes with ${control} (stream=${stream})`, async () => {
        const manager = new SemanticCacheManager({ enabled: true }, undefined, async () => ({
          embedding: [1, 0],
          inputTokens: 1,
        }));
        resetSemanticCacheManager(manager);
        const apiKeyInfo = { id: "cache-policy-key", cacheDefaultMode: "legacy" };
        const body = {
          model: "gpt-4o-mini",
          stream,
          temperature: 0,
          messages: [{ role: "user", content: `cache policy ${control} ${stream}` }],
        };
        const setEnabled = async (enabled: boolean) => {
          if (control === "key bypass") {
            apiKeyInfo.cacheDefaultMode = enabled ? "legacy" : "bypass";
          } else {
            await updateSettings({ semanticCacheEnabled: enabled });
          }
        };
        const invoke = () =>
          invokeChatCore({
            body,
            apiKeyInfo,
            accept: stream ? "text/event-stream" : "application/json",
            responseFactory: () => buildOpenAIResponse(stream, "cache-policy-response"),
          });

        try {
          await setEnabled(false);
          const bypassed = await invoke();
          assert.equal(bypassed.result.success, true);
          await bypassed.result.response.text();
          await flushAsyncSideEffects();
          const signature = generateSignature(body.model, body.messages, 0, 1, apiKeyInfo.id);
          assert.equal(
            await getCachedResponse(signature),
            null,
            "disabled request must not write the legacy cache"
          );
          assert.equal(
            (await manager.getStats()).entries,
            0,
            "disabled request must not write the vector cache"
          );

          await setEnabled(true);
          const fresh = await invoke();
          assert.equal(
            fresh.calls.length,
            1,
            "re-enabling caching must not expose bypassed responses"
          );
          await fresh.result.response.text();
          await flushAsyncSideEffects();
          assert.ok(
            await getCachedResponse(signature),
            "enabled request must still populate the legacy cache"
          );
          assert.equal(
            (await manager.getStats()).entries,
            1,
            "enabled request must still populate the vector cache"
          );

          await setEnabled(false);
          const ignoredHit = await invoke();
          assert.equal(ignoredHit.calls.length, 1, "disabled request must ignore existing entries");
          await ignoredHit.result.response.text();

          await setEnabled(true);
          const hit = await invoke();
          assert.equal(hit.calls.length, 0, "re-enabled cache must serve existing entries");
          assert.equal(hit.result.response.headers.get("X-OmniRoute-Cache"), "HIT");
          await hit.result.response.text();
        } finally {
          await waitForCallLogSaves(5000);
          resetSemanticCacheManager(null);
        }
      });
    }
  }
});

describe("chatcore-model-output-cap-wiring", () => {
  // Direct output-budget tests cannot prove handleChatCore passes capability caps
  // through its non-combo runtime path. This drives that public handler with a
  // temporary DB and upstream fetch stub.
  const PROVIDER = "capwire-testprov";
  const MODEL = "capwire-testmodel";
  const OUTPUT_CAP = 1000;
  const INPUT_CAP = 10;
  const REQUESTED_MAX_TOKENS = 50_000;
  let dispatchedBody: Record<string, unknown> | null = null;
  let fetchCalls = 0;
  const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

  function buildRequest(maxTokens: number, content = "hello") {
    const body = {
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: maxTokens,
      stream: false,
    };
    return {
      body,
      modelInfo: { provider: PROVIDER, model: MODEL, extendedContext: false },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: { baseUrl: "https://capwire.example.test" },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      isCombo: false,
      log: silentLog,
    };
  }

  before(async () => {
    await core.resetDbInstance();
    assert.equal(
      await overridesDb.setModelCapabilityOverride(
        `${PROVIDER}/${MODEL}`,
        "max_output_tokens",
        OUTPUT_CAP
      ),
      true
    );
    assert.equal(
      await overridesDb.setModelCapabilityOverride(
        `${PROVIDER}/${MODEL}`,
        "max_input_tokens",
        INPUT_CAP
      ),
      true
    );
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      dispatchedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-capwire",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await featureFlagsDb.removeFeatureFlagOverride("DISABLE_CONTEXT_WINDOW_CHECKS");
    await refreshFeatureFlagSnapshot();
  });

  test("handleChatCore clamps an over-cap max_tokens to the model's output cap before dispatch", async () => {
    dispatchedBody = null;
    fetchCalls = 0;
    await handleChatCore(buildRequest(REQUESTED_MAX_TOKENS));
    assert.equal(fetchCalls, 1);
    assert.equal(dispatchedBody?.max_tokens, OUTPUT_CAP);
  });

  test("handleChatCore leaves a max_tokens below the cap untouched", async () => {
    dispatchedBody = null;
    fetchCalls = 0;
    const underCap = OUTPUT_CAP - 1;
    await handleChatCore(buildRequest(underCap));
    assert.equal(fetchCalls, 1);
    assert.equal(dispatchedBody?.max_tokens, underCap);
  });

  test("handleChatCore rejects input over the model input cap before upstream dispatch", async () => {
    dispatchedBody = null;
    fetchCalls = 0;
    const result = await handleChatCore(buildRequest(1, "x".repeat(200)));
    assert.equal(result.status, 400);
    assert.equal(fetchCalls, 0, "input-cap rejection must not call the upstream");
    assert.match(JSON.stringify(result), /maximum input tokens/i);
  });

  test("handleChatCore dispatches input within the model input cap", async () => {
    dispatchedBody = null;
    fetchCalls = 0;
    await handleChatCore(buildRequest(1, "x"));
    assert.equal(fetchCalls, 1);
    assert.ok(dispatchedBody, "input below the cap must reach the upstream");
  });

  test("DISABLE_CONTEXT_WINDOW_CHECKS lets direct-model input exceed the declared input cap", async () => {
    dispatchedBody = null;
    fetchCalls = 0;
    await featureFlagsDb.setFeatureFlagOverride("DISABLE_CONTEXT_WINDOW_CHECKS", "true");
    await refreshFeatureFlagSnapshot();
    try {
      const result = await handleChatCore(buildRequest(1, "x".repeat(200)));
      assert.equal(result.success, true);
      assert.equal(fetchCalls, 1, "disabled context checks must let the upstream decide");
      assert.ok(dispatchedBody, "oversized input must reach the upstream when the flag is enabled");
    } finally {
      await featureFlagsDb.removeFeatureFlagOverride("DISABLE_CONTEXT_WINDOW_CHECKS");
      await refreshFeatureFlagSnapshot();
    }
  });

  test("DISABLE_CONTEXT_WINDOW_CHECKS keeps the direct model output cap active", async () => {
    dispatchedBody = null;
    fetchCalls = 0;
    await featureFlagsDb.setFeatureFlagOverride("DISABLE_CONTEXT_WINDOW_CHECKS", "true");
    await refreshFeatureFlagSnapshot();
    try {
      const result = await handleChatCore(buildRequest(REQUESTED_MAX_TOKENS, "x".repeat(200)));
      assert.equal(result.success, true);
      assert.equal(fetchCalls, 1);
      assert.equal(dispatchedBody?.max_tokens, OUTPUT_CAP);
    } finally {
      await featureFlagsDb.removeFeatureFlagOverride("DISABLE_CONTEXT_WINDOW_CHECKS");
      await refreshFeatureFlagSnapshot();
    }
  });
});

describe("chatcore-output-config-format-strip", () => {
  type Body = Record<string, unknown>;

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await flushAsyncSideEffects();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  const TITLE_SCHEMA = {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  };

  function titleGenBody(): Body {
    return {
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      stream: false,
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: [{ type: "text", text: "name this session" }] }],
      output_config: { effort: "high", format: structuredClone(TITLE_SCHEMA) },
    };
  }

  test("first-party Anthropic ids are claude (OAuth) and anthropic (API key)", () => {
    assert.deepEqual([...FIRST_PARTY_ANTHROPIC_PROVIDERS].sort(), ["anthropic", "claude"]);
  });

  test("official anthropic API-key provider keeps output_config.format", () => {
    const body = titleGenBody();
    stripOutputConfigFormatForCompat(body, "anthropic");
    assert.deepEqual(body.output_config, { effort: "high", format: TITLE_SCHEMA });
  });

  test("claude OAuth provider keeps output_config.format (control)", () => {
    const body = titleGenBody();
    stripOutputConfigFormatForCompat(body, "claude");
    assert.deepEqual(body.output_config, { effort: "high", format: TITLE_SCHEMA });
  });

  test("Claude-compatible gateway strips format and keeps effort", () => {
    const body = titleGenBody();
    stripOutputConfigFormatForCompat(body, "anthropic-compatible-xyz");
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.ok(!JSON.stringify(body).includes("json_schema"));
  });

  test("Claude-compatible gateway drops output_config entirely when format was the only field", () => {
    const body = titleGenBody();
    delete (body.output_config as Body).effort;
    stripOutputConfigFormatForCompat(body, "anthropic-compatible-xyz");
    assert.equal("output_config" in body, false);
  });

  test("missing or non-object output_config is left untouched", () => {
    const noConfig: Body = { model: "x" };
    stripOutputConfigFormatForCompat(noConfig, "anthropic-compatible-xyz");
    assert.deepEqual(noConfig, { model: "x" });

    const nullConfig: Body = { model: "x", output_config: null };
    stripOutputConfigFormatForCompat(nullConfig, "anthropic-compatible-xyz");
    assert.deepEqual(nullConfig, { model: "x", output_config: null });
  });

  test("Claude passthrough to the anthropic API-key provider forwards output_config.format upstream", async () => {
    let captured: { url: string; body: Body } | null = null;

    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      captured = { url: String(url), body: JSON.parse(String(init.body || "{}")) };
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: '{"title":"t"}' }],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const body = titleGenBody();
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "anthropic", model: "claude-sonnet-4-6", extendedContext: false },
      credentials: { apiKey: "test-anthropic-key", providerSpecificData: {} },
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
    } as Parameters<typeof handleChatCore>[0]);

    assert.ok(captured, "fetch was not called");
    const sent = captured as { url: string; body: Body };
    assert.ok(sent.url.startsWith("https://api.anthropic.com/v1/messages"));
    assert.equal(result.success, true);
    const outputConfig = sent.body.output_config as Body | undefined;
    assert.ok(outputConfig, "output_config was stripped for the first-party anthropic provider");
    assert.deepEqual(outputConfig.format, TITLE_SCHEMA);
  });
});

describe("chatcore-reasoning-cache-write-guard", () => {
  // Integration guard for the reasoning-cache write gate.
  // The predicate is tested in isolation in chatCore-reasoning-cache-guard.test.ts; this
  // describe proves handleChatCore's ACTUAL call sites are wired to it, for both the
  // non-streaming and streaming response paths, via the cache's own observable side
  // effect (no spying on cacheReasoningFromAssistantMessage — same convention as
  // the chatcore-sanitization describe in tests/unit/chatcore/request-shaping.test.ts and
  // the compression-probe describe in tests/unit/chatcore/combo-context.test.ts: mock fetch, call the
  // real handleChatCore, assert real behavior).
  //
  // Deepseek is also a replay provider (proven by the predicate test), but its wire
  // format is openai-responses — a plain openai chat.completion mock would hit
  // MALFORMED-200 and never reach the cache write. xiaomi-mimo serves the same
  // predicate (REASONING_REPLAY_PROVIDERS member) while staying on the openai wire
  // format, so both the non-streaming JSON mock and the streaming chat.completion.chunk
  // SSE mock exercise the passthrough path with minimal translation noise.

  // These requests carry no API key or session, so entries belong to the local scope.
  const lookupLocal = (id: string) =>
    lookupReasoning(buildToolCallCacheKey(buildReasoningCacheScope(undefined, null), id));

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  function nonStreamingUpstreamResponse(toolCallId: string, model: string) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-reasoning-cache-guard",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "because the guard test says so",
              tool_calls: [
                { id: toolCallId, type: "function", function: { name: "noop", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  function streamingUpstreamResponse(toolCallId: string) {
    const firstChunk = {
      id: "chatcmpl-reasoning-cache-stream-guard",
      object: "chat.completion.chunk",
      model: "probe",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "because the guard test says so",
            tool_calls: [
              {
                index: 0,
                id: toolCallId,
                type: "function",
                function: { name: "noop", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const secondChunk = {
      id: "chatcmpl-reasoning-cache-stream-guard",
      object: "chat.completion.chunk",
      model: "probe",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    };
    const sseBody =
      `data: ${JSON.stringify(firstChunk)}\n\n` +
      `data: ${JSON.stringify(secondChunk)}\n\n` +
      "data: [DONE]\n\n";
    return new Response(sseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  async function invokeChatCoreNonStreaming(provider: string, model: string, toolCallId: string) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => nonStreamingUpstreamResponse(toolCallId, model);
    try {
      const body = { model, messages: [{ role: "user", content: "call the tool" }], stream: false };
      await handleChatCore({
        body,
        modelInfo: { provider, model, extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
      } as never);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function invokeChatCoreStreaming(provider: string, model: string, toolCallId: string) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => streamingUpstreamResponse(toolCallId);
    try {
      const body = { model, messages: [{ role: "user", content: "call the tool" }], stream: true };
      const result = await handleChatCore({
        body,
        modelInfo: { provider, model, extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: new Headers({ accept: "text/event-stream" }),
        },
        userAgent: "unit-test",
      } as never);
      // Drain the streaming response to trigger onStreamComplete (the cache write callback fires on flush/close)
      if (result.success && result.response?.body) {
        const reader = result.response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) text += decoder.decode(value as Uint8Array, { stream: true });
        }
        await new Promise((resolve) => setImmediate(resolve));
        void text;
      } else if (result.success) {
        try {
          await result.response.text();
          await new Promise((resolve) => setImmediate(resolve));
        } catch {}
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  after(() => {
    try {
      clearReasoningCacheAll();
    } catch {}
  });

  test("non-streaming: a replay provider (xiaomi-mimo) populates the reasoning cache", async () => {
    const id = "tc-reasoning-cache-nonstream-mimo";
    assert.equal(lookupLocal(id), null);
    await invokeChatCoreNonStreaming("xiaomi-mimo", "mimo-v1", id);
    assert.equal(lookupLocal(id), "because the guard test says so");
  });

  test("non-streaming: a non-replay provider (openai) does NOT populate the reasoning cache", async () => {
    const id = "tc-reasoning-cache-nonstream-openai";
    assert.equal(lookupLocal(id), null);
    await invokeChatCoreNonStreaming("openai", "gpt-5.1", id);
    assert.equal(lookupLocal(id), null);
  });

  test("streaming: a replay provider (xiaomi-mimo) populates the reasoning cache", async () => {
    const id = "tc-reasoning-cache-stream-mimo";
    assert.equal(lookupLocal(id), null);
    await invokeChatCoreStreaming("xiaomi-mimo", "mimo-v1", id);
    assert.equal(lookupLocal(id), "because the guard test says so");
  });

  test("streaming: a non-replay provider (openai) does NOT populate the reasoning cache", async () => {
    const id = "tc-reasoning-cache-stream-openai";
    assert.equal(lookupLocal(id), null);
    await invokeChatCoreStreaming("openai", "gpt-5.1", id);
    assert.equal(lookupLocal(id), null);
  });
});

describe("chatcore-reasoning-cache-write-guard-responses", () => {
  // Integration guard for the reasoning-cache write path on a Responses-API target.
  //
  // The chatcore-reasoning-cache-write-guard describe (same file) proves the capture sites
  // fire for a Chat-format upstream (xiaomi-mimo) and deliberately avoids DeepSeek
  // because its wire format is openai-responses. This describe covers exactly that lane:
  // opencode-go/deepseek-v4-flash is dispatched to `/responses`, so the translated
  // upstream body carries `input`, not `messages`, and the plain-turn cache key must
  // be built from the pivot transcript `translateRequest` reports instead.
  //
  // Same convention as the sibling describe: mock fetch, call the real handleChatCore,
  // assert real behavior — here the observable behavior is the SECOND turn's upstream
  // request body: a client that replays history without `reasoning_content` must
  // still produce a `reasoning` input item ahead of the assistant message, or
  // DeepSeek answers `400 The reasoning_text in the thinking mode must be passed back`.
  type JsonRecord = Record<string, unknown>;

  const PROVIDER = "opencode-go";
  const MODEL = "deepseek-v4-flash";
  const REASONING = "The user only wants a greeting, so no tool is needed.";
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  function completedResponse() {
    return {
      id: "resp_reasoning_guard",
      object: "response",
      status: "completed",
      model: MODEL,
      output: [
        {
          type: "reasoning",
          id: "rs_reasoning_guard",
          summary: [],
          content: [{ type: "reasoning_text", text: REASONING }],
        },
        {
          type: "message",
          id: "msg_reasoning_guard",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi!", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
  }

  function nonStreamingUpstreamResponse() {
    return new Response(JSON.stringify(completedResponse()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function streamingUpstreamResponse() {
    const completed = completedResponse();
    const events: Array<[string, JsonRecord]> = [
      [
        "response.created",
        {
          type: "response.created",
          response: { ...completed, status: "in_progress", output: [] },
        },
      ],
      [
        "response.output_item.added",
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rs_reasoning_guard", summary: [], content: [] },
        },
      ],
      [
        "response.reasoning_text.delta",
        {
          type: "response.reasoning_text.delta",
          item_id: "rs_reasoning_guard",
          output_index: 0,
          content_index: 0,
          delta: REASONING,
        },
      ],
      [
        "response.output_item.done",
        { type: "response.output_item.done", output_index: 0, item: completed.output[0] },
      ],
      [
        "response.output_item.added",
        {
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "message",
            id: "msg_reasoning_guard",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
      ],
      [
        "response.output_text.delta",
        {
          type: "response.output_text.delta",
          item_id: "msg_reasoning_guard",
          output_index: 1,
          content_index: 0,
          delta: "Hi!",
        },
      ],
      [
        "response.output_item.done",
        { type: "response.output_item.done", output_index: 1, item: completed.output[1] },
      ],
      ["response.completed", { type: "response.completed", response: completed }],
    ];
    const sseBody = events
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");
    return new Response(sseBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  async function drain(result: { success?: boolean; response?: Response }) {
    if (!result.success || !result.response) return;
    if (result.response.body) {
      const reader = result.response.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } else {
      try {
        await result.response.text();
      } catch {}
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Runs one client turn through the real handleChatCore against a mocked upstream and
   * returns the JSON body OmniRoute sent upstream.
   */
  async function runTurn(
    session: string,
    messages: unknown[],
    stream: boolean,
    upstream: () => Response
  ): Promise<JsonRecord> {
    const originalFetch = globalThis.fetch;
    const sent: Array<{ url: string; body: JsonRecord }> = [];
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String((input as { url?: unknown })?.url ?? input);
      if (typeof init?.body === "string") {
        sent.push({ url, body: JSON.parse(init.body) as JsonRecord });
      }
      return upstream();
    }) as typeof fetch;
    try {
      const body = { model: MODEL, messages, tools: TOOLS, stream };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: PROVIDER, model: MODEL, extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
        },
        userAgent: "unit-test",
        sessionAffinityKey: session,
      } as never);
      await drain(result as { success?: boolean; response?: Response });
    } finally {
      globalThis.fetch = originalFetch;
    }
    // Select the Responses-lane dispatch by URL rather than "last fetch", so an
    // unrelated POST inside the handler window can neither satisfy nor break this.
    const responsesCalls = sent.filter((call) => /\/responses(\?|$)/.test(call.url));
    assert.equal(responsesCalls.length, 1, `exactly one /responses dispatch (saw ${sent.length})`);
    return responsesCalls[0].body;
  }

  function reasoningTexts(input: unknown): string[] {
    return (Array.isArray(input) ? input : [])
      .filter((item) => (item as JsonRecord)?.type === "reasoning")
      .map((item) =>
        ((item as JsonRecord).content as Array<{ text?: string }>)
          .map((part) => part.text ?? "")
          .join("")
      );
  }

  const TURN_1 = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Say hi first, no tools." },
  ];
  const TURN_2 = [
    ...TURN_1,
    // The client replays the plain assistant turn WITHOUT reasoning_content.
    { role: "assistant", content: "Hi!" },
    { role: "user", content: "Now read README.md" },
  ];

  after(() => {
    // clearReasoningCacheAll() writes through the DB, so close the handle after it, not before
    // (the file-level `after` closes it).
    try {
      clearReasoningCacheAll();
    } catch {}
  });

  test("non-streaming: a plain turn captured from a Responses upstream is replayed on the next turn", async () => {
    clearReasoningCacheAll();
    const session = "reasoning-cache-write-guard-responses-nonstream";
    const first = await runTurn(session, TURN_1, false, nonStreamingUpstreamResponse);
    assert.ok(Array.isArray(first.input), "turn 1 went upstream as a Responses body");
    assert.equal(first.messages, undefined);

    const second = await runTurn(session, TURN_2, false, nonStreamingUpstreamResponse);
    const input = second.input as JsonRecord[];
    assert.deepEqual(reasoningTexts(input), [REASONING]);
    const reasoningIndex = input.findIndex((item) => item.type === "reasoning");
    const assistantIndex = input.findIndex(
      (item) => item.type === "message" && item.role === "assistant"
    );
    assert.ok(reasoningIndex >= 0 && reasoningIndex < assistantIndex);
  });

  test("streaming: a plain turn captured from a Responses SSE upstream is replayed on the next turn", async () => {
    clearReasoningCacheAll();
    const session = "reasoning-cache-write-guard-responses-stream";
    const first = await runTurn(session, TURN_1, true, streamingUpstreamResponse);
    assert.ok(Array.isArray(first.input), "turn 1 went upstream as a Responses body");
    assert.equal(first.messages, undefined);

    const second = await runTurn(session, TURN_2, false, nonStreamingUpstreamResponse);
    assert.deepEqual(reasoningTexts(second.input), [REASONING]);
  });
});

describe("chatcore-sanitization", () => {
  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  function toPlainHeaders(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, value == null ? "" : String(value)])
    );
  }

  function buildUpstreamResponse(stream) {
    if (stream) {
      return new Response(
        'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        id: "chatcmpl-json",
        object: "chat.completion",
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  async function invokeChatCore({
    body,
    accept = "application/json",
    provider = "openai",
    model = "gpt-4o-mini",
    endpoint = "/v1/chat/completions",
    credentials = { apiKey: "sk-test", providerSpecificData: {} },
    apiKeyInfo = null,
    userAgent = "unit-test",
    responseFactory,
  } = {}) {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const nextcloudJsonOnlyClient = /nextcloud\s+openai\/localai\s+integration/i.test(userAgent);
    const jsonStreamDefault = apiKeyInfo?.streamDefaultMode === "json";
    const resolvedStream =
      body?.stream === true ||
      (body?.stream === undefined && String(accept).toLowerCase().includes("text/event-stream")) ||
      (body?.stream === undefined &&
        !nextcloudJsonOnlyClient &&
        !jsonStreamDefault &&
        !String(accept).includes("json"));

    globalThis.fetch = async (url, init = {}) => {
      const parsedBody = init.body ? JSON.parse(String(init.body)) : null;
      const captured = {
        url: String(url),
        method: init.method || "GET",
        headers: toPlainHeaders(init.headers),
        body: parsedBody,
      };
      calls.push(captured);
      return responseFactory ? responseFactory(captured) : buildUpstreamResponse(resolvedStream);
    };

    try {
      const requestBody = structuredClone(body);
      const result = await handleChatCore({
        body: requestBody,
        modelInfo: { provider, model, extendedContext: false },
        credentials: structuredClone(credentials),
        log: noopLog(),
        clientRawRequest: {
          endpoint,
          body: structuredClone(body),
          headers: new Headers({ accept, "user-agent": userAgent }),
        },
        apiKeyInfo,
        userAgent,
      });

      return { result, call: calls.at(-1), calls };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("chatCore sanitization normalizes max_output_tokens into max_tokens", async () => {
    const copied = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        max_output_tokens: 0,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    const preserved = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        max_output_tokens: 64,
        max_tokens: 7,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    const untouched = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    assert.equal(copied.call.body.max_tokens, undefined);
    assert.equal("max_output_tokens" in copied.call.body, false);
    assert.equal(preserved.call.body.max_tokens, 7);
    assert.equal("max_output_tokens" in preserved.call.body, false);
    assert.equal("max_tokens" in untouched.call.body, false);
  });

  test("chatCore sanitization preserves max_output_tokens for openai-responses targets", async () => {
    // When the target provider uses openai-responses format (e.g. Codex),
    // max_output_tokens is the canonical field and must NOT be normalized to
    // max_tokens. Normalizing it breaks Responses→Responses passthrough because
    // the translator (which converts max_tokens back) is skipped for same-format.
    const { call } = await invokeChatCore({
      endpoint: "/v1/responses",
      provider: "codex",
      body: {
        model: "gpt-5.4",
        max_output_tokens: 4096,
        input: [{ role: "user", content: "hello" }],
      },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "resp_test",
            object: "response",
            status: "completed",
            model: "gpt-5.4",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    // max_output_tokens should survive sanitization for Responses targets
    assert.equal(
      "max_tokens" in call.body,
      false,
      "max_tokens must not be injected for Responses targets"
    );

    // Reverse normalization: max_tokens → max_output_tokens for Responses targets
    const fromMaxTokens = await invokeChatCore({
      endpoint: "/v1/responses",
      provider: "codex",
      body: {
        model: "gpt-5.4",
        max_tokens: 2048,
        input: [{ role: "user", content: "hello" }],
      },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "resp_test2",
            object: "response",
            status: "completed",
            model: "gpt-5.4",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    assert.equal(
      "max_tokens" in fromMaxTokens.call.body,
      false,
      "max_tokens should be converted to max_output_tokens"
    );

    // Reverse normalization: max_completion_tokens → max_output_tokens for Responses targets
    const fromMaxCompletion = await invokeChatCore({
      endpoint: "/v1/responses",
      provider: "codex",
      body: {
        model: "gpt-5.4",
        max_completion_tokens: 8192,
        input: [{ role: "user", content: "hello" }],
      },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "resp_test3",
            object: "response",
            status: "completed",
            model: "gpt-5.4",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    assert.equal(
      "max_completion_tokens" in fromMaxCompletion.call.body,
      false,
      "max_completion_tokens should be converted to max_output_tokens"
    );
  });

  test("chatCore preserves Chat max_tokens as max_output_tokens for Perplexity Agent Anthropic models", async () => {
    const { call, result } = await invokeChatCore({
      endpoint: "/v1/chat/completions",
      provider: "perplexity-agent",
      model: "anthropic/claude-opus-4-5",
      body: {
        model: "anthropic/claude-opus-4-5",
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply with OK only." }],
      },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "resp_pplx_agent",
            object: "response",
            status: "completed",
            model: "anthropic/claude-opus-4-5",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    assert.equal(result.success, true);
    assert.equal(call.url, "https://api.perplexity.ai/v1/responses");
    assert.equal(call.body.model, "anthropic/claude-opus-4-5");
    assert.equal(call.body.max_output_tokens, 32);
    assert.equal("max_tokens" in call.body, false);
    assert.equal("max_completion_tokens" in call.body, false);
  });

  test("chatCore defaults max_output_tokens for Perplexity Agent Anthropic chat requests", async () => {
    const { call, result } = await invokeChatCore({
      endpoint: "/v1/chat/completions",
      provider: "perplexity-agent",
      model: "anthropic/claude-opus-4-5",
      body: {
        model: "anthropic/claude-opus-4-5",
        messages: [{ role: "user", content: "hi" }],
      },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "resp_pplx_agent_default_tokens",
            object: "response",
            status: "completed",
            model: "anthropic/claude-opus-4-5",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello!" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    assert.equal(result.success, true);
    assert.equal(call.url, "https://api.perplexity.ai/v1/responses");
    assert.equal(call.body.max_output_tokens, 4096);
    assert.equal("max_tokens" in call.body, false);
    assert.equal("max_completion_tokens" in call.body, false);
  });

  test("chatCore defaults max_output_tokens for Perplexity Agent Kimi chat requests", async () => {
    const { call, result } = await invokeChatCore({
      endpoint: "/v1/chat/completions",
      provider: "perplexity-agent",
      model: "perplexity/kimi-k3",
      body: {
        model: "perplexity/kimi-k3",
        messages: [{ role: "user", content: "hi" }],
      },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "resp_pplx_agent_kimi_default_tokens",
            object: "response",
            status: "completed",
            model: "perplexity/kimi-k3",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello!" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    assert.equal(result.success, true);
    assert.equal(call.url, "https://api.perplexity.ai/v1/responses");
    assert.equal(call.body.max_output_tokens, 4096);
    assert.equal("max_tokens" in call.body, false);
    assert.equal("max_completion_tokens" in call.body, false);
  });

  test("chatCore sanitization strips empty message names and filters empty tool names", async () => {
    // Note: `input` field is tested separately because its presence triggers
    // Responses format detection (PR #1002), which changes message handling.
    const { call } = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: "hello", name: "" },
          { role: "assistant", content: "world", name: "valid-name" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup_weather", parameters: { type: "object" } },
          },
          { type: "function", function: { name: "", parameters: { type: "object" } } },
          { type: "function", function: { name: "   ", parameters: { type: "object" } } },
          { name: "anthropic_lookup", input_schema: { type: "object" } },
          { name: "", input_schema: { type: "object" } },
        ],
      },
    });

    assert.equal(call.body.messages[0].name, undefined);
    assert.equal(call.body.messages[1].name, "valid-name");
    // 3 invalid tools removed: 2 empty function names + 1 empty anthropic name
    // 2 valid remain in the client's own order: lookup_weather + anthropic_lookup.
    // Client tools are no longer sorted alphabetically — only gateway-injected tools are —
    // because a later tool cap keeps the head of the list (#18120).
    assert.equal(call.body.tools.length, 2);
    const tool0Name = call.body.tools[0].function?.name ?? call.body.tools[0].name;
    assert.equal(tool0Name, "lookup_weather");
    const tool1Name = call.body.tools[1].function?.name ?? call.body.tools[1].name;
    assert.equal(tool1Name, "anthropic_lookup");
  });

  test("chatCore sanitization strips empty input item names on responses endpoint", async () => {
    const { call } = await invokeChatCore({
      endpoint: "/v1/responses",
      body: {
        model: "gpt-4o-mini",
        input: [
          { role: "user", content: "input-1", name: "" },
          { role: "user", content: "input-2", name: "still-valid" },
        ],
      },
      responseFactory: () =>
        new Response(
          JSON.stringify({
            id: "resp_test",
            object: "response",
            status: "completed",
            model: "gpt-4o-mini",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    });

    // The input array may be translated to messages by the responses pipeline
    // Verify that empty names were stripped during sanitization:
    // Check both possible locations (input array or messages array after translation)
    const items = call.body.input || call.body.messages || [];
    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        // No item should have an empty string name after sanitization
        if (item.name !== undefined) {
          assert.notEqual(item.name, "", "empty name should have been stripped");
        }
      }
    }
  });

  test("chatCore sanitization normalizes mixed content blocks and removes unsupported or empty ones", async () => {
    const { call } = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "keep me" },
              { type: "text", text: "" },
              { type: "image_url", image_url: { url: "https://example.com/image.png" } },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
              { type: "file_url", file_url: { url: "data:text/plain;base64,SGk=" } },
              { type: "file", file: { name: "README.md", content: "Read me please." } },
              { type: "file", file: { name: "blob.bin", data: "AAEC" } },
              { type: "file", file: { name: "draft.txt", text: "Draft text" } },
              { type: "document", name: "notes.txt", text: "Meeting notes" },
              { type: "document", document: { url: "data:text/plain;base64,SGVsbG8=" } },
              { type: "tool_result", tool_use_id: "tool-1", content: "done" },
              {
                type: "tool_result",
                tool_use_id: "tool-2",
                content: [{ type: "text", text: "structured result" }],
              },
              {
                type: "tool_result",
                tool_use_id: "tool-3",
                content: { status: "ok", count: 2 },
              },
              { type: "unknown_block", value: "drop me" },
            ],
          },
        ],
      },
    });

    const content = call.body.messages[0].content;
    const textBlocks = content.filter((block) => block.type === "text");

    assert.equal(
      content.some((block) => block.type === "text" && block.text === ""),
      false
    );
    assert.equal(
      content.some((block) => block.type === "unknown_block"),
      false
    );
    assert.equal(
      content.some((block) => block.type === "image_url"),
      true
    );
    assert.equal(
      content.some((block) => block.type === "image"),
      true
    );
    assert.equal(
      content.some(
        (block) => block.type === "file_url" && block.file_url.url.startsWith("data:text/plain")
      ),
      true
    );
    assert.equal(
      content.some((block) => block.type === "file" && block.file?.data === "AAEC"),
      true
    );
    assert.equal(
      content.some((block) => block.type === "document" && block.document?.url.startsWith("data:")),
      true
    );
    assert.equal(
      textBlocks.some((block) => block.text === "[README.md]\nRead me please."),
      true
    );
    assert.equal(
      textBlocks.some((block) => block.text === "[notes.txt]\nMeeting notes"),
      true
    );
    assert.equal(
      textBlocks.some((block) => block.text === "[draft.txt]\nDraft text"),
      true
    );
    // Orphaned tool_result blocks (no matching tool_use anywhere in the request) are
    // stripped by `stripOrphanedToolResults` (#5805) before reaching content normalization,
    // to avoid strict-upstream 400s. They are therefore removed entirely — neither preserved
    // as tool_result blocks nor inlined as "[Tool Result: …]" text.
    assert.equal(
      content.some((block) => block.type === "tool_result"),
      false
    );
    assert.equal(
      textBlocks.some(
        (block) => typeof block.text === "string" && block.text.includes("[Tool Result:")
      ),
      false
    );
  });

  test("chatCore preserves Claude passthrough tool_result blocks instead of converting them to plain text", async () => {
    const { call } = await invokeChatCore({
      endpoint: "/v1/messages",
      provider: "claude",
      model: "claude-opus-4-7",
      userAgent: "claude-cli/2.1.114",
      body: {
        model: "claude-opus-4-7",
        max_tokens: 64,
        system: [{ type: "text", text: "sys" }],
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_keep", name: "Bash", input: { command: "pwd" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_keep", content: "done" }],
          },
        ],
        tools: [{ name: "Bash", input_schema: { type: "object", properties: {} } }],
      },
    });

    assert.equal(call.body.messages[0].role, "assistant");
    assert.equal(call.body.messages[0].content[0].type, "tool_use");
    assert.equal(call.body.messages[1].role, "user");
    assert.equal(call.body.messages[1].content[0].type, "tool_result");
    assert.equal(call.body.messages[1].content[0].tool_use_id, "toolu_keep");
    assert.equal(
      call.body.messages[1].content.some(
        (block) => block.type === "text" && /\[Tool Result:/.test(block.text)
      ),
      false
    );
  });

  test("chatCore resolves stream mode from body.stream and Accept header", async () => {
    const explicitTrue = await invokeChatCore({
      accept: "application/json",
      body: { model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hello" }] },
    });
    const explicitFalse = await invokeChatCore({
      accept: "text/event-stream",
      body: { model: "gpt-4o-mini", stream: false, messages: [{ role: "user", content: "hello" }] },
    });
    const acceptDriven = await invokeChatCore({
      accept: "text/event-stream",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
    });
    const jsonDefault = await invokeChatCore({
      accept: "application/json",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
    });

    assert.equal(explicitTrue.call.headers.Accept, "text/event-stream");
    assert.equal(explicitFalse.call.headers.Accept, "application/json");
    assert.equal(acceptDriven.call.headers.Accept, "text/event-stream");
    assert.equal(jsonDefault.call.headers.Accept, "application/json");
  });

  test("chatCore treats Nextcloud OpenAI integration requests as non-streaming by default", async () => {
    const nextcloudDefault = await invokeChatCore({
      accept: "*/*",
      userAgent: "Nextcloud OpenAI/LocalAI integration",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
    });
    const nextcloudExplicitStream = await invokeChatCore({
      accept: "application/json",
      userAgent: "Nextcloud OpenAI/LocalAI integration",
      body: { model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: "hello" }] },
    });

    assert.equal(nextcloudDefault.call.headers.Accept, "application/json");
    assert.equal(nextcloudDefault.result.response.headers.get("content-type"), "application/json");
    assert.equal(nextcloudExplicitStream.call.headers.Accept, "text/event-stream");
  });

  test("chatCore honors API key JSON stream-default compatibility mode", async () => {
    const jsonCompatibleDefault = await invokeChatCore({
      accept: "*/*",
      userAgent: "generic-openai-client",
      apiKeyInfo: { id: "json-stream-default-key", streamDefaultMode: "json" },
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
    });
    const explicitSse = await invokeChatCore({
      accept: "text/event-stream",
      userAgent: "generic-openai-client",
      apiKeyInfo: { id: "json-stream-default-key", streamDefaultMode: "json" },
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
    });

    assert.equal(jsonCompatibleDefault.call.headers.Accept, "application/json");
    assert.equal(
      jsonCompatibleDefault.result.response.headers.get("content-type"),
      "application/json"
    );
    assert.equal(explicitSse.call.headers.Accept, "text/event-stream");
  });
});

describe("chatcore-strip-stale-headers", () => {
  test("stripStaleForwardingHeaders removes content-encoding/content-length/transfer-encoding", async () => {
    const { stripStaleForwardingHeaders } = await import("../../../open-sse/handlers/chatCore.ts");

    const headers = new Headers({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": "1234",
      "transfer-encoding": "chunked",
      "x-request-id": "abc",
    });

    stripStaleForwardingHeaders(headers);

    assert.equal(headers.get("content-encoding"), null);
    assert.equal(headers.get("content-length"), null);
    assert.equal(headers.get("transfer-encoding"), null);
    // Unrelated headers must be preserved so downstream behavior (content-type
    // negotiation, request tracing) keeps working.
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("x-request-id"), "abc");
  });

  test("stripStaleForwardingHeaders is case-insensitive", async () => {
    const { stripStaleForwardingHeaders } = await import("../../../open-sse/handlers/chatCore.ts");

    const headers = new Headers();
    headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", "999");
    headers.set("Transfer-Encoding", "chunked");

    stripStaleForwardingHeaders(headers);

    assert.equal(headers.get("content-encoding"), null);
    assert.equal(headers.get("content-length"), null);
    assert.equal(headers.get("transfer-encoding"), null);
  });

  test("stripStaleForwardingHeaders is a no-op when headers are absent", async () => {
    const { stripStaleForwardingHeaders } = await import("../../../open-sse/handlers/chatCore.ts");

    const headers = new Headers({ "content-type": "application/json" });
    stripStaleForwardingHeaders(headers);

    assert.equal(headers.get("content-type"), "application/json");
  });
});

describe("guardrail-pipeline-wiring-characterization", () => {
  // Characterization tests — guardrail pipeline WIRING (plan item V3-1, before the v4 module
  // extraction). Companion of tests/unit/guardrail-pipeline-characterization.test.ts, which
  // pins the behavior of the pieces; this describe pins where they are plugged in.
  //
  // Approach: STATIC SOURCE ASSERTIONS. Driving handleChat / handleChatCore end to end needs the
  // full provider/executor/DB stack, so behavioral coverage of "which routes hit the hooks" and
  // "what runs before/after post-call" is impractical and brittle. Instead this describe:
  //   3. scans every non-test source file under src/, open-sse/ and bin/ for callers
  //      of runPreCallHooks / runPostCallHooks and for importers of the chat handler, and pins
  //      the exact sets — so a new caller or a new chat-family route fails here on purpose;
  //   4. asserts the textual order of the post-call block in nonStreamingResponse.ts (memory
  //      extraction → tool execution → post-call → block exit → semantic-cache store);
  //   5. asserts the self-loop plumbing (undici fetch in the vision bridge, the proxyFetch stamp).
  // When a refactor legitimately moves a call, update the expected set/order here in the same PR
  // and say why — that is the point of a characterization test.
  const ROOT = REPO_ROOT;
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const SOURCE_EXT = /\.(ts|tsx|mts|js|mjs|cjs)$/;
  const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

  function walk(relDir: string, out: string[] = []): string[] {
    const abs = path.join(ROOT, relDir);
    if (!fs.existsSync(abs)) return out;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) walk(rel, out);
      else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(rel);
    }
    return out;
  }

  const SOURCE_FILES = ["src", "open-sse", "bin"].flatMap((dir) => walk(dir));

  function filesMatching(pattern: RegExp) {
    return SOURCE_FILES.filter((file) => pattern.test(read(file))).sort();
  }

  function indexOrFail(source: string, needle: string, from = 0) {
    const index = source.indexOf(needle, from);
    assert.notEqual(index, -1, `expected to find \`${needle}\``);
    return index;
  }

  // ─── 3. Coverage: who reaches the hooks ──────────────────────────────────────

  test("runPreCallHooks has exactly two production callers: the chat handler and the guardrail test API", () => {
    assert.deepEqual(filesMatching(/\.runPreCallHooks\s*\(/), [
      "src/app/api/guardrails/test/route.ts",
      "src/sse/handlers/chat.ts",
    ]);
    // The chat handler calls it once.
    assert.equal(read("src/sse/handlers/chat.ts").match(/\.runPreCallHooks\s*\(/g)?.length, 1);
  });

  test("runPostCallHooks has exactly one production caller: the non-streaming response leaf", () => {
    assert.deepEqual(filesMatching(/\.runPostCallHooks\s*\(/), [
      "open-sse/handlers/chatCore/nonStreamingResponse.ts",
    ]);
    for (const streamingLeaf of [
      "open-sse/handlers/chatCore/streamingResponse.ts",
      "open-sse/handlers/chatCore/streamingPipeline.ts",
      "open-sse/handlers/chatCore/streamingTail.ts",
    ]) {
      assert.doesNotMatch(read(streamingLeaf), /guardrailRegistry|runPostCallHooks/);
    }
  });

  test("the chat handler is imported by exactly these modules (the chat-family routes + Telegram)", () => {
    assert.deepEqual(filesMatching(/from\s+["'](?:@\/|(?:\.\.\/)+)sse\/handlers\/chat["']/), [
      "src/app/api/v1/antigravity/route.ts",
      "src/app/api/v1/api/chat/route.ts",
      "src/app/api/v1/chat/completions/route.ts",
      "src/app/api/v1/completions/route.ts",
      "src/app/api/v1/messages/route.ts",
      "src/app/api/v1/providers/[provider]/chat/completions/route.ts",
      "src/app/api/v1/relay/chat/completions/route.ts",
      "src/app/api/v1/responses/[...path]/route.ts",
      "src/app/api/v1/responses/route.ts",
      "src/app/api/v1beta/models/[...path]/route.ts",
      "src/lib/telegram/chatProxy.ts",
    ]);
  });

  test("image, embeddings and audio routes never reach the guardrail registry", () => {
    const routes = SOURCE_FILES.filter((file) =>
      /^src\/app\/api\/v1\/(images|embeddings|audio)\/.*route\.ts$/.test(file)
    );
    assert.ok(routes.length >= 6, `expected the image/embeddings/audio routes, got ${routes}`);
    for (const route of routes) {
      const source = read(route);
      assert.ok(!/sse\/handlers\/chat["']/.test(source), `${route} imports the chat handler`);
      assert.ok(!/lib\/guardrails/.test(source), `${route} imports the guardrail registry`);
    }
    // The only injection check those routes get is the legacy middleware facade (prompt
    // injection only; see the disable-channel characterization in the behavioral file).
    for (const route of [
      "src/app/api/v1/embeddings/route.ts",
      "src/app/api/v1/images/generations/route.ts",
      "src/app/api/v1/images/edits/route.ts",
      "src/app/api/v1/audio/speech/route.ts",
    ]) {
      assert.ok(/(?:withInjectionGuard|createInjectionGuard)\(/.test(read(route)), route);
    }
  });

  test("chat.ts feeds the pre-call pass all disable channels and maps a block to HTTP 400", () => {
    const chat = read("src/sse/handlers/chat.ts");
    const call = indexOrFail(chat, "guardrailRegistry.runPreCallHooks(body, {");
    const window = chat.slice(call, call + 1500);
    assert.match(
      window,
      /resolveDisabledGuardrails\(\{\s*apiKeyInfo:[^}]*body,\s*headers: request\.headers,\s*\}\)/
    );
    assert.match(window, /stream: body\?\.stream === true/);
    assert.match(window, /if \(preCallGuardrails\.blocked\)[\s\S]*HTTP_STATUS\.BAD_REQUEST/);
    // The guarded payload replaces the request body for everything downstream.
    assert.match(window, /body = preCallGuardrails\.payload;/);
  });

  test("post-call runs only on the non-streaming branch of handleChatCore", () => {
    const core = read("open-sse/handlers/chatCore.ts");
    const streamBranch = indexOrFail(
      core,
      "if (stream) {\n    const streamingOutcome = await runStreamingResponse("
    );
    const nonStreamBranch = indexOrFail(
      core,
      "if (!stream) {\n    const nonStreamingOutcome = await runNonStreamingResponse("
    );
    assert.ok(streamBranch < nonStreamBranch);
    assert.equal(core.match(/runNonStreamingResponse\(/g)?.length, 1);
  });

  // ─── 4. Ordering inside nonStreamingResponse.ts ──────────────────────────────

  // The memory-extraction step that used to come first went with the memory engine.
  test("non-streaming order: tool execution → post-call → block exit → cache store", () => {
    const leaf = read("open-sse/handlers/chatCore/nonStreamingResponse.ts");
    const tools = indexOrFail(leaf, "translatedResponse = await handleToolCallExecution(");
    const context = indexOrFail(leaf, "buildPostCallGuardrailContext({", tools);
    const postCall = indexOrFail(leaf, "guardrailRegistry.runPostCallHooks(", context);
    const apply = indexOrFail(leaf, "translatedResponse = postCallGuardrails.response;", postCall);
    const blocked = indexOrFail(leaf, "if (postCallGuardrails.blocked) {", apply);
    const blockedExit = indexOrFail(
      leaf,
      "response: createErrorResult(HTTP_STATUS.BAD_REQUEST, guardrailMessage)",
      blocked
    );
    const cacheStore = indexOrFail(leaf, "storeSemanticCacheResponse({", blockedExit);
    const idempotency = indexOrFail(leaf, "await saveIdempotency(", cacheStore);
    assert.ok(tools < postCall && postCall < blocked);
    assert.ok(blocked < blockedExit && blockedExit < cacheStore && cacheStore < idempotency);
    // Each anchor appears once, so the order above is unambiguous.
    for (const anchor of ["guardrailRegistry.runPostCallHooks(", "storeSemanticCacheResponse({"]) {
      assert.equal(leaf.split(anchor).length - 1, 1, anchor);
    }
    // characterization: tool execution sees the response BEFORE the post-call guardrails, so a
    // response later blocked (or rewritten) by a post-call guardrail has already been offered
    // to built-in tool execution.
  });

  test("the post-call verdict is applied to what is cached, and the cache write is keyed per API key", () => {
    const leaf = read("open-sse/handlers/chatCore/nonStreamingResponse.ts");
    const store = indexOrFail(leaf, "storeSemanticCacheResponse({");
    const call = leaf.slice(store, indexOrFail(leaf, "});", store));
    assert.match(call, /translatedResponse,/);
    assert.match(call, /apiKeyId: apiKeyInfo\?\.id \?\? undefined,/);
    assert.match(call, /provider,/);
  });

  // ─── 5. Self-loop plumbing ───────────────────────────────────────────────────

  test("proxyFetch stamps the self-hop header before any dispatch decision", () => {
    const proxyFetch = read("open-sse/utils/proxyFetch.ts");
    const fn = indexOrFail(proxyFetch, "async function patchedFetchUnrecorded(");
    const stamp = indexOrFail(proxyFetch, "stampOwnListenerSelfHop(input, options);", fn);
    const direct = indexOrFail(
      proxyFetch,
      "if (proxyContext.getStore() === DIRECT_PROXY_CONTEXT)",
      fn
    );
    assert.ok(stamp < direct);
  });

  test("characterization: the vision-bridge describe call uses undici fetch, bypassing the self-hop stamp", () => {
    // VisionBridgeGuardrail injects `undiciFetch` as fetchImpl, so the describe self-call never
    // passes through proxyFetch.patchedFetchUnrecorded and carries no x-omniroute-self-hop
    // header; admission instead relies on x-omniroute-admission-bypass + the self-loop bearer
    // (pinned behaviorally in guardrail-pipeline-characterization.test.ts).
    const bridge = read("src/lib/guardrails/visionBridge.ts");
    assert.match(bridge, /import \{ fetch as undiciFetch \} from "undici";/);
    const describe = indexOrFail(bridge, "const describeConfig = {");
    assert.match(
      bridge.slice(describe, describe + 200),
      /fetchImpl: undiciFetch as unknown as typeof fetch,/
    );
    const helpers = read("src/lib/guardrails/visionBridgeHelpers.ts");
    assert.doesNotMatch(helpers, /self-hop|selfHop/);
    assert.match(helpers, /headers\["x-omniroute-disabled-guardrails"\] = routeThroughOmniRoute/);
  });
});

describe("chatcore-imports-cleanly", () => {
  /**
   * Regression guard: `open-sse/handlers/chatCore.ts` must transform/compile.
   *
   * `handleChatCore` declared `const settings` twice in the same function scope
   * (a "fetch once, reuse" const near the top + a duplicate added by the per-key
   * stream-default-mode feature). esbuild/tsx rejected it with
   * "The symbol 'settings' has already been declared", which turned EVERY test
   * that imports chatCore red and broke the production build.
   *
   * Importing the module forces the transform; if the duplicate declaration
   * returns, this import throws and the test fails loudly.
   */
  test("chatCore.ts imports without a duplicate-declaration transform error", async () => {
    const mod = await import("../../../open-sse/handlers/chatCore.ts");
    assert.equal(
      typeof mod.handleChatCore,
      "function",
      "handleChatCore must be importable (no duplicate `const settings` in scope)"
    );
  });
});
