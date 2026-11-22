// @ts-nocheck
// Merged chatCore tests for the Codex / OpenAI-family request paths. Each source file keeps its
// own describe() (named after the original file) so its helpers and hooks stay scoped to it.
// All describes share one process, one DATA_DIR and one Postgres database, so every describe that
// touches the DB starts from a fresh one (`before(freshDb)`) unless it already resets per test.
import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Load-time env, set once before any app module loads.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-codex-openai-"));
const TEST_DATA_DIR = path.join(TEST_ROOT, "data");
const TEST_PLUGINS_DIR = path.join(TEST_ROOT, "plugins");
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  OMNIROUTE_PLUGINS_DIR: process.env.OMNIROUTE_PLUGINS_DIR,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
};
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_PLUGINS_DIR = TEST_PLUGINS_DIR;
process.env.API_KEY_SECRET = "synthetic-refresh-gate-secret";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settings = await import("../../../src/lib/db/settings.ts");
const cache = await import("../../../src/lib/db/readCache.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const { updateCompressionSettings } = await import("../../../src/lib/db/compression.ts");
const { setModelCapabilityOverride } =
  await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const tokens = await import("../../../open-sse/services/tokenRefresh.ts");
const wrappers = await import("../../../src/sse/services/tokenRefresh.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const { handleChat } = await import("../../../src/sse/handlers/chat.ts");
const { handleChatCore, clearUpstreamProxyConfigCache } =
  await import("../../../open-sse/handlers/chatCore.ts");
const { fetchAndPersistProviderLimits } = await import("../../../src/lib/usage/providerLimits.ts");
const manual = await import("../../../src/app/api/providers/[id]/refresh/route.ts");
const probe = await import("../../../src/app/api/providers/[id]/test/route.ts");
const health = await import("../../../src/lib/tokenHealthCheck.ts");
const importer = await import("../../../src/app/api/oauth/codex/import/route.ts");
const { listCodexResetCredits } = await import("../../../src/lib/usage/codexResetCredits.ts");
const { validateWebRuntimeEnv } = await import("../../../src/lib/env/runtimeEnv.ts");
const { getCallLogs, getCallLogById, waitForCallLogSaves } =
  await import("../../../src/lib/usage/callLogs.ts");
const { clearPendingRequests } = await import("../../../src/lib/usage/usageHistory.ts");
const { clearCache } = await import("../../../src/lib/semanticCache.ts");
const { clearIdempotency } = await import("../../../src/lib/idempotencyLayer.ts");
const { supportsMaxTokens } = await import("../../../src/lib/modelCapabilities.ts");
const { OMNIROUTE_RESPONSE_HEADERS } = await import("../../../src/shared/constants/headers.ts");
const { isCompressionExcluded, normalizeCompressionExclusions } =
  await import("../../../open-sse/services/compression/exclusions.ts");
const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { clearInflight } = await import("../../../open-sse/services/requestDedup.ts");
const { resetAll: resetAccountSemaphores } =
  await import("../../../open-sse/services/accountSemaphore.ts");
const { resetPayloadRulesConfigForTests } =
  await import("../../../open-sse/services/payloadRules.ts");
const { CodexExecutor } = await import("../../../open-sse/executors/codex.ts");
const { GithubExecutor } = await import("../../../open-sse/executors/github.ts");
const { getModelsByProviderId } = await import("../../../open-sse/config/providerModels.ts");
const { GITHUB_COPILOT_STATIC_FALLBACK_MODELS } =
  await import("../../../open-sse/services/githubCopilotModels.ts");
const { resolveCopilotAuto } =
  await import("../../../open-sse/handlers/chatCore/copilotAutoModel.ts");
const {
  COPILOT_AUTO_API_VERSION,
  COPILOT_AUTO_REFRESH_WINDOW_MS,
  CopilotAutoSessionCache,
  copilotAutoSessions,
  extractAutoPrompt,
  hasAutoImageInput,
  parseAutoDecision,
} = await import("../../../open-sse/executors/github/autoModel.ts");
const { shouldSkipNativeCodexReactiveCompaction, NATIVE_CODEX_REACTIVE_COMPACTION_FLAG } =
  await import("../../../open-sse/handlers/chatCore/nativeCodexCompaction.ts");
const { wrapChatCompletionJsonAsResponsesSse, maybeWrapForcedNonStreamingResponsesJson } =
  await import("../../../open-sse/handlers/chatCore/responsesJsonToSse.ts");
const { normalizeToolSchemasForProvider } =
  await import("../../../open-sse/handlers/chatCore/openrouterToolSchemas.ts");
const { stripInvalidRegexPatterns, stripUnsupportedRegexPatterns } =
  await import("../../../open-sse/translator/helpers/schemaCoercion.ts");

/** Each original file started on its own freshly cloned database; give each describe the same. */
async function freshDb() {
  await resetTestDb();
}

after(async () => {
  await core.resetDbInstance();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("responses-json-to-sse-13033", () => {
  function chatCompletion(content = "hi") {
    return {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    };
  }

  test("wraps non-streaming chat JSON as Responses SSE ending in response.completed", async () => {
    const response = wrapChatCompletionJsonAsResponsesSse(chatCompletion("hello"), {
      "X-OmniRoute-Cache": "MISS",
    });
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.equal(response.headers.get("X-OmniRoute-Cache"), "MISS");
    const sse = await response.text();
    assert.match(sse, /event: response\.created/);
    assert.match(sse, /event: response\.completed/);
    assert.match(sse, /hello/);
    assert.match(sse, /data: \[DONE\]/);
  });

  test("injection: returning JSON early for a 200 chat completion goes red", async () => {
    const response = wrapChatCompletionJsonAsResponsesSse(chatCompletion());
    assert.notEqual(response.headers.get("Content-Type"), "application/json");
  });

  test("maybeWrapForcedNonStreamingResponsesJson keeps JSON when the client did not ask for SSE", async () => {
    const response = maybeWrapForcedNonStreamingResponsesJson({
      clientRequestedResponsesStream: false,
      body: chatCompletion("plain"),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(response.headers.get("Content-Type"), "application/json");
    const payload = JSON.parse(await response.text());
    assert.equal(payload.choices[0].message.content, "plain");
  });

  test("maybeWrapForcedNonStreamingResponsesJson wraps JSON when the client asked for SSE", async () => {
    const response = maybeWrapForcedNonStreamingResponsesJson({
      clientRequestedResponsesStream: true,
      body: chatCompletion("stream-me"),
      headers: { "Content-Type": "application/json", "X-OmniRoute-Cache": "MISS" },
    });
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    const sse = await response.text();
    assert.match(sse, /event: response\.completed/);
    assert.match(sse, /stream-me/);
  });

  test("chatCore stamps clientRequestedResponsesStream before forcing stream:false", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(
      join(import.meta.dirname, "../../../open-sse/handlers/chatCore.ts"),
      "utf-8"
    );
    const stamp = source.indexOf("clientRequestedResponsesStream = true");
    const force = source.indexOf("(body as Record<string, unknown>).stream = false");
    const leafSource = await readFile(
      join(import.meta.dirname, "../../../open-sse/handlers/chatCore/nonStreamingResponse.ts"),
      "utf-8"
    );
    const wrap = leafSource.indexOf("maybeWrapForcedNonStreamingResponsesJson({");
    const leafCall = source.indexOf("await runNonStreamingResponse(");
    assert.ok(stamp !== -1, "must stamp the client-requested stream flag");
    assert.ok(force !== -1, "must still force stream:false for the web_search fallback");
    assert.ok(wrap !== -1, "must wrap the non-streaming JSON return");
    assert.ok(stamp < force, "stamp must happen before stream:false");
    assert.ok(
      leafCall > force,
      "the non-streaming leaf runs after the force, so its wrap lands after it"
    );
  });

  // When the client speaks the Responses API, the forced non-streaming leg is
  // translated into a Responses object (object: "response", output[]), not a Chat
  // completion. It has no `choices`, so the Chat-only synthesis produced nothing
  // and the JSON went back raw: Codex CLI on a Cursor combo with web_search
  // interception got it as an in-band error frame and never saw response.completed.
  function responsesObject() {
    return {
      id: "resp_chatcmpl-cursor-1",
      object: "response",
      created_at: 1790340021,
      model: "cursor/gemini-3.8-flash",
      status: "completed",
      error: null,
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Looking it up." }],
          status: "completed",
        },
        {
          id: "ws_1",
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "opencode /v1/models" },
        },
        {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: '{"cmd":"cat README.md"}',
          status: "completed",
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "pong", annotations: [] }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
  }

  function parseEvents(sse: string) {
    return sse
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("event: "))
      .map((block) => {
        const [eventLine, dataLine] = block.split("\n");
        return {
          event: eventLine.slice("event: ".length),
          data: JSON.parse(dataLine.slice("data: ".length)),
        };
      });
  }

  test("wraps a Responses-shaped object as SSE instead of returning raw JSON", async () => {
    const response = maybeWrapForcedNonStreamingResponsesJson({
      clientRequestedResponsesStream: true,
      body: responsesObject(),
      headers: { "Content-Type": "application/json", "X-OmniRoute-Cache": "MISS" },
    });
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");
    assert.equal(response.headers.get("X-OmniRoute-Cache"), "MISS");
    const sse = await response.text();
    const events = parseEvents(sse);

    assert.equal(events[0].event, "response.created");
    assert.equal(events[0].data.response.status, "in_progress");
    assert.deepEqual(events[0].data.response.output, []);
    const completed = events.filter((e) => e.event === "response.completed");
    assert.equal(completed.length, 1, "exactly one response.completed");
    assert.equal(events.at(-1)?.event, "response.completed", "response.completed comes last");
    assert.deepEqual(completed[0].data.response, responsesObject(), "every item survives");
    assert.match(sse, /data: \[DONE\]\s*$/);

    const seq = events.map((e) => e.data.sequence_number);
    assert.deepEqual(
      seq,
      seq.map((_, i) => i),
      "sequence numbers count up from 0"
    );
  });

  test("a Responses-shaped object streams one added/done pair per output item, in order", async () => {
    const sse = await wrapChatCompletionJsonAsResponsesSse(responsesObject()).text();
    const events = parseEvents(sse);
    const expected = responsesObject().output;

    const added = events.filter((e) => e.event === "response.output_item.added");
    const done = events.filter((e) => e.event === "response.output_item.done");
    assert.deepEqual(
      added.map((e) => [e.data.output_index, e.data.item.type]),
      expected.map((item, i) => [i, item.type])
    );
    assert.deepEqual(
      done.map((e) => e.data.item),
      expected,
      "done carries the final item"
    );

    const text = events.find((e) => e.event === "response.output_text.delta");
    assert.equal(text?.data.delta, "pong");
    assert.equal(text?.data.item_id, "msg_1");
    const textDone = events.find((e) => e.event === "response.output_text.done");
    assert.equal(textDone?.data.text, "pong");
    const args = events.find((e) => e.event === "response.function_call_arguments.done");
    assert.equal(args?.data.arguments, '{"cmd":"cat README.md"}');
    assert.equal(args?.data.item_id, "fc_1");
  });

  test("a failed or incomplete Responses object ends with its own terminal event", async () => {
    for (const status of ["failed", "incomplete"] as const) {
      const body = { ...responsesObject(), status };
      const events = parseEvents(await wrapChatCompletionJsonAsResponsesSse(body).text());
      assert.equal(events.at(-1)?.event, `response.${status}`);
      assert.equal(events.at(-1)?.data.response.status, status);
    }
  });

  test("the created/in_progress shell carries the envelope only, not final usage", async () => {
    const events = parseEvents(
      await wrapChatCompletionJsonAsResponsesSse(responsesObject()).text()
    );
    for (const event of events.slice(0, 2)) {
      const shell = event.data.response;
      assert.equal(shell.id, "resp_chatcmpl-cursor-1");
      assert.equal(shell.object, "response");
      assert.equal(shell.model, "cursor/gemini-3.8-flash");
      assert.equal(shell.status, "in_progress");
      assert.deepEqual(shell.output, []);
      assert.equal(shell.usage, undefined, `${event.event} must not announce final usage`);
    }
  });

  test("a finished object without a terminal status ends as completed", async () => {
    for (const status of [undefined, "in_progress", "queued"]) {
      const body: Record<string, unknown> = { ...responsesObject(), status };
      if (status === undefined) delete body.status;
      const events = parseEvents(await wrapChatCompletionJsonAsResponsesSse(body).text());
      assert.equal(events.at(-1)?.event, "response.completed", `status ${status}`);
      assert.equal(events.at(-1)?.data.response.status, "completed", `status ${status}`);
    }
  });

  test("a cancelled object ends with response.failed", async () => {
    for (const status of ["cancelled", "canceled"]) {
      const body = { ...responsesObject(), status };
      const events = parseEvents(await wrapChatCompletionJsonAsResponsesSse(body).text());
      assert.equal(events.at(-1)?.event, "response.failed", `status ${status}`);
    }
  });

  test("output_index and content_index follow the final response, skipping malformed entries", async () => {
    const body = {
      ...responsesObject(),
      output: [
        null,
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [null, { type: "output_text", text: "pong", annotations: [] }],
        },
      ],
    };
    const events = parseEvents(await wrapChatCompletionJsonAsResponsesSse(body).text());
    const added = events.filter((e) => e.event === "response.output_item.added");
    assert.deepEqual(
      added.map((e) => e.data.output_index),
      [1]
    );
    const parts = events.filter((e) => e.event.startsWith("response.content_part."));
    assert.ok(parts.length > 0);
    for (const part of parts) {
      assert.equal(part.data.content_index, 1);
      assert.ok(part.data.part, "no null part");
    }
  });

  test("text events carry logprobs like a live stream", async () => {
    const events = parseEvents(
      await wrapChatCompletionJsonAsResponsesSse(responsesObject()).text()
    );
    for (const name of ["response.output_text.delta", "response.output_text.done"]) {
      const event = events.find((e) => e.event === name);
      assert.deepEqual(event?.data.logprobs, [], name);
    }
  });

  test("a refusal part streams as refusal events", async () => {
    const body = {
      ...responsesObject(),
      output: [
        {
          id: "msg_r",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I can't help with that." }],
        },
      ],
    };
    const events = parseEvents(await wrapChatCompletionJsonAsResponsesSse(body).text());
    const delta = events.find((e) => e.event === "response.refusal.delta");
    const done = events.find((e) => e.event === "response.refusal.done");
    assert.equal(delta?.data.delta, "I can't help with that.");
    assert.equal(done?.data.refusal, "I can't help with that.");
    assert.equal(done?.data.item_id, "msg_r");
    const added = events.find((e) => e.event === "response.content_part.added");
    assert.equal(added?.data.part.refusal, "", "the part opens empty");
    assert.equal(
      events.some((e) => e.event.startsWith("response.output_text.")),
      false
    );
  });

  test("a reasoning summary streams as reasoning_summary events", async () => {
    const events = parseEvents(
      await wrapChatCompletionJsonAsResponsesSse(responsesObject()).text()
    );
    const names = events
      .filter((e) => e.event.startsWith("response.reasoning_summary_"))
      .map((e) => e.event);
    assert.deepEqual(names, [
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
    ]);
    const delta = events.find((e) => e.event === "response.reasoning_summary_text.delta");
    assert.equal(delta?.data.item_id, "rs_1");
    assert.equal(delta?.data.summary_index, 0);
    assert.equal(delta?.data.delta, "Looking it up.");
    const opened = events.find(
      (e) => e.event === "response.output_item.added" && e.data.item.type === "reasoning"
    );
    assert.deepEqual(opened?.data.item.summary, [], "reasoning opens with an empty summary");
  });

  test("an item without an id gets one that its sub-events share", async () => {
    const body = {
      ...responsesObject(),
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "pong", annotations: [] }],
        },
      ],
    };
    const events = parseEvents(await wrapChatCompletionJsonAsResponsesSse(body).text());
    const added = events.find((e) => e.event === "response.output_item.added");
    const done = events.find((e) => e.event === "response.output_item.done");
    const delta = events.find((e) => e.event === "response.output_text.delta");
    assert.equal(typeof added?.data.item.id, "string");
    assert.ok(added?.data.item.id);
    assert.equal(delta?.data.item_id, added?.data.item.id);
    assert.equal(done?.data.item.id, added?.data.item.id);
    const completed = events.at(-1);
    assert.equal(
      completed?.data.response.output[0].id,
      added?.data.item.id,
      "the final snapshot agrees"
    );
  });

  test("the web_search fallback's round trip reaches the client item by item", async () => {
    const output = [
      {
        id: "fc_ws",
        type: "function_call",
        call_id: "call_ws1",
        name: "omniroute_web_search",
        arguments: '{"query":"node lts"}',
        status: "completed",
      },
      { type: "function_call_output", call_id: "call_ws1", output: '{"success":true}' },
      {
        id: "ws_call_ws1",
        type: "web_search_call",
        status: "completed",
        action: { type: "web_search", query: "node lts", sources: [] },
      },
    ];
    const body = { ...responsesObject(), output };
    const events = parseEvents(await wrapChatCompletionJsonAsResponsesSse(body).text());
    const done = events.filter((e) => e.event === "response.output_item.done");
    assert.deepEqual(
      done.map((e) => [e.data.output_index, e.data.item.type, e.data.item.call_id ?? null]),
      [
        [0, "function_call", "call_ws1"],
        [1, "function_call_output", "call_ws1"],
        [2, "web_search_call", null],
      ]
    );
    assert.equal(done[1].data.item.output, '{"success":true}');
  });
});

describe("codex-prompt-compression-passthrough (#12793)", () => {
  const chatCoreSource = readFileSync(
    new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url),
    "utf8"
  );

  // Regression guard for https://github.com/cheaper-inference/OmniRoute/issues/12793:
  // native Codex passthrough (`POST /v1/responses`, provider `codex`) silently stopped
  // producing compression analytics (100% `skip_reason='excluded'`) after #8933 added
  // `nativeCodexPassthrough ||` to the prompt-compression exclusion (landed on release
  // via #11088). Prompt compression must depend ONLY on the operator exclusions list.

  test("codex prompt compression is not gated on native passthrough", () => {
    const match = chatCoreSource.match(/const compressionExcluded =([\s\S]*?);/);
    assert.ok(match, "compressionExcluded assignment must exist in chatCore.ts");
    assert.doesNotMatch(
      match[1],
      /nativeCodexPassthrough/,
      "prompt-compression exclusion must not reference nativeCodexPassthrough"
    );
    assert.match(match[1], /isCompressionExcluded/);
  });

  test("codex target is compressible by default; operators can still opt out via exclusions", () => {
    assert.equal(
      isCompressionExcluded(
        { provider: "codex", model: "gpt-5.6-terra" },
        normalizeCompressionExclusions([])
      ),
      false
    );
    assert.equal(
      isCompressionExcluded(
        { provider: "codex", model: "gpt-5.6-terra" },
        normalizeCompressionExclusions(["codex/*"])
      ),
      true
    );
  });

  test("prompt-only scope: reactive compaction still bypasses native passthrough", () => {
    // Deliberately left for follow-up (overflow fail-fast + history-rewriting safety).
    // If these gates are ever lifted, update the PR body notes, not just this test.
    // #16632: the bypass is now lifted ONLY by the default-off
    // NATIVE_CODEX_REACTIVE_COMPACTION_ENABLED flag; with the flag off the guard is
    // exactly `nativeCodexPassthrough` (behavior proven end-to-end in the
    // native-codex-passthrough-compaction describe of this file).
    assert.match(
      chatCoreSource,
      /skipNativeCodexReactiveCompaction\s*=\s*shouldSkipNativeCodexReactiveCompaction\(\s*nativeCodexPassthrough,/
    );
    assert.match(
      chatCoreSource,
      /reactiveContextCompactionEnabled\s*&&\s*!skipNativeCodexReactiveCompaction\s*&&\s*estimatedTokens\s*>\s*threshold/
    );
    assert.match(
      chatCoreSource,
      /reactiveContextCompactionEnabled\s*&&\s*!skipNativeCodexReactiveCompaction\s*&&\s*finalEstimatedInputTokens\s*>=\s*effectiveCompactionCeiling/
    );
  });
});

describe("github-copilot-auto-model", () => {
  type Captured = {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown> | null;
  };

  const originalFetch = globalThis.fetch;
  const AUTO_URL = "https://api.githubcopilot.com/auto";
  const IMAGE_PART = {
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
  };

  function freshCredentials(overrides: Record<string, unknown> = {}) {
    return {
      accessToken: "gho-access",
      copilotToken: "copilot-live-token",
      copilotTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      connectionId: "conn-auto-1",
      providerSpecificData: {},
      ...overrides,
    };
  }

  function autoDecision(model: string, vision = false, sessionToken = `session-${model}`) {
    return new Response(
      JSON.stringify({
        selected_model: { id: model, capabilities: { supports: { vision } } },
        session_token: sessionToken,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  function toPlainHeaders(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    return Object.fromEntries(
      Object.entries(headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    );
  }

  function mockFetch(respond: (call: Captured, calls: Captured[]) => Response) {
    const calls: Captured[] = [];
    globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
      const call: Captured = {
        url: String(url),
        method: init.method || "GET",
        headers: toPlainHeaders(init.headers),
        body: init.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      return respond(call, calls);
    }) as typeof fetch;
    return calls;
  }

  function headerValue(headers: Record<string, string>, name: string): string | undefined {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
  }

  const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

  before(freshDb);

  afterEach(() => {
    globalThis.fetch = originalFetch;
    copilotAutoSessions.clear();
    clearPendingRequests();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    core.resetDbInstance();
  });

  test("github registry and static fallback expose the Copilot auto model", () => {
    const auto = getModelsByProviderId("github").find((model) => model.id === "auto");
    assert.ok(auto, "github/auto must be listed");
    assert.equal(auto.supportsVision, undefined, "vision is resolved per request, never assumed");
    assert.ok(GITHUB_COPILOT_STATIC_FALLBACK_MODELS.includes("auto"));
  });

  test("extractAutoPrompt reads the latest user-typed text across client formats", () => {
    assert.equal(
      extractAutoPrompt({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "  latest question  " },
        ],
      }),
      "latest question"
    );
    assert.equal(
      extractAutoPrompt({
        messages: [{ role: "user", content: [{ type: "text", text: "a" }, IMAGE_PART] }],
      }),
      "a"
    );
    // Claude agentic loop: the last user turn only carries a tool_result.
    assert.equal(
      extractAutoPrompt({
        messages: [
          { role: "user", content: [{ type: "text", text: "refactor the parser" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] },
        ],
      }),
      "refactor the parser"
    );
    assert.equal(extractAutoPrompt({ input: "responses prompt" }), "responses prompt");
    assert.equal(
      extractAutoPrompt({
        input: [{ role: "user", content: [{ type: "input_text", text: "from items" }] }],
      }),
      "from items"
    );
    assert.equal(extractAutoPrompt({ messages: [] }), "");
  });

  test("hasAutoImageInput detects image parts in messages and Responses input", () => {
    assert.equal(hasAutoImageInput({ messages: [{ role: "user", content: "hi" }] }), false);
    assert.equal(hasAutoImageInput({ messages: [{ role: "user", content: [IMAGE_PART] }] }), true);
  });

  test("parseAutoDecision requires a model id and session token and normalizes expiry", () => {
    const now = 1_800_000_000_000;
    assert.deepEqual(
      parseAutoDecision(
        {
          selected_model: { id: "gpt-5-mini", capabilities: { supports: { vision: true } } },
          session_token: "tok",
          expires_at: 1_800_003_600,
        },
        now
      ),
      {
        model: "gpt-5-mini",
        sessionToken: "tok",
        expiresAtMs: 1_800_003_600_000,
        supportsVision: true,
      }
    );
    assert.equal(parseAutoDecision({ selected_model: { id: "x" } }, now), null);
    assert.equal(parseAutoDecision({ session_token: "tok" }, now), null);
    assert.equal(parseAutoDecision(null, now), null);
  });

  test("CopilotAutoSessionCache is bounded and honours the refresh window", () => {
    const now = Date.now();
    const cache = new CopilotAutoSessionCache(2);
    const decision = (model: string, ttlMs = 3_600_000) => ({
      model,
      sessionToken: model,
      expiresAtMs: now + ttlMs,
      supportsVision: false,
    });
    cache.set("a", decision("a"), now);
    cache.set("b", decision("b"), now);
    cache.set("c", decision("c"), now);
    assert.equal(cache.size, 2, "oldest entry evicted past the bound");
    assert.equal(cache.getUsable("a", false, now), null);
    assert.equal(cache.getUsable("c", false, now)?.model, "c");
    assert.equal(cache.getUsable("c", true, now), null, "image turn re-resolves a non-vision pick");
    cache.set("near", decision("near", COPILOT_AUTO_REFRESH_WINDOW_MS - 1), now);
    assert.equal(cache.getUsable("near", false, now), null, "inside refresh window → re-resolve");
  });

  test("resolveAutoModel POSTs the prompt to /auto and caches the decision per session", async () => {
    const calls = mockFetch((call) =>
      call.url === AUTO_URL
        ? autoDecision("gpt-5-mini")
        : new Response("unexpected", { status: 500 })
    );
    const executor = new GithubExecutor();
    const body = { messages: [{ role: "user", content: "pick a model for me" }] };

    const first = await executor.resolveAutoModel({
      body,
      credentials: freshCredentials(),
      sessionKey: "conversation-1",
    });
    assert.equal(first.ok, true);
    assert.equal(first.ok && first.decision.model, "gpt-5-mini");
    assert.equal(first.ok && first.decision.sessionToken, "session-gpt-5-mini");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, AUTO_URL);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { prompt: "pick a model for me" });
    assert.equal(headerValue(calls[0].headers, "x-github-api-version"), COPILOT_AUTO_API_VERSION);
    assert.equal(headerValue(calls[0].headers, "authorization"), "Bearer copilot-live-token");

    const second = await executor.resolveAutoModel({
      body,
      credentials: freshCredentials(),
      sessionKey: "conversation-1",
    });
    assert.equal(second.ok && second.cached, true);
    assert.equal(calls.length, 1, "same account + session reuses the cached decision");

    await executor.resolveAutoModel({
      body,
      credentials: freshCredentials(),
      sessionKey: "conversation-2",
    });
    assert.equal(calls.length, 2, "another conversation resolves on its own");
  });

  test("resolveAutoModel re-resolves with has_image when the cached pick lacks vision", async () => {
    let n = 0;
    const calls = mockFetch(() =>
      n++ === 0 ? autoDecision("o3-mini") : autoDecision("gpt-5", true)
    );
    const executor = new GithubExecutor();
    const credentials = freshCredentials();
    await executor.resolveAutoModel({
      body: { messages: [{ role: "user", content: "text only" }] },
      credentials,
      sessionKey: "s",
    });
    const withImage = await executor.resolveAutoModel({
      body: {
        messages: [{ role: "user", content: [{ type: "text", text: "describe" }, IMAGE_PART] }],
      },
      credentials,
      sessionKey: "s",
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body, { prompt: "describe", has_image: true });
    assert.equal(withImage.ok && withImage.decision.model, "gpt-5");
  });

  test("buildHeaders sends Copilot-Session-Token on the auto API version only when present", () => {
    const executor = new GithubExecutor();
    const plain = executor.buildHeaders(freshCredentials(), true, null, "gpt-5-mini");
    assert.equal(plain["Copilot-Session-Token"], undefined);

    const auto = executor.buildHeaders(
      freshCredentials({ copilotSessionToken: "sess-123" }),
      true,
      null,
      "gpt-5-mini"
    );
    assert.equal(auto["Copilot-Session-Token"], "sess-123");
    assert.equal(auto["x-github-api-version"], COPILOT_AUTO_API_VERSION);
  });

  test("resolveCopilotAuto leaves non-auto and non-github requests untouched", async () => {
    const calls = mockFetch(() => new Response("{}", { status: 200 }));
    const credentials = freshCredentials();
    const viaGithub = await resolveCopilotAuto("github", "gpt-5-mini", {}, credentials);
    assert.equal(viaGithub.model, "gpt-5-mini");
    assert.equal(viaGithub.credentials, credentials);
    const ghe = await resolveCopilotAuto("ghe-copilot", "auto", {}, credentials);
    assert.equal(ghe.model, "auto", "ghe-copilot does not opt into auto");
    assert.equal(calls.length, 0);
  });

  test("resolveCopilotAuto swaps model, body and a credentials copy without mutating input", async () => {
    mockFetch(() => autoDecision("claude-sonnet-5"));
    const credentials = freshCredentials();
    const body: Record<string, unknown> = {
      model: "github/auto",
      messages: [{ role: "user", content: "hello" }],
    };
    const outcome = await resolveCopilotAuto("github", "auto", body, credentials, "sess");
    assert.equal(outcome.errorResult, undefined);
    assert.equal(outcome.model, "claude-sonnet-5");
    assert.equal(body.model, "claude-sonnet-5");
    assert.equal(outcome.credentials.copilotSessionToken, "session-claude-sonnet-5");
    assert.equal(
      (credentials as Record<string, unknown>).copilotSessionToken,
      undefined,
      "the caller's credentials object must not carry the per-request token"
    );
  });

  test("resolveCopilotAuto surfaces an /auto 4xx as a sanitized error result", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "auto is not enabled" } }), { status: 403 })
    );
    const outcome = await resolveCopilotAuto(
      "github",
      "auto",
      { messages: [{ role: "user", content: "x" }] },
      freshCredentials()
    );
    assert.ok(outcome.errorResult);
    assert.equal(outcome.errorResult.status, 403);
    assert.equal(outcome.model, "auto");
    const payload = await outcome.errorResult.response.json();
    assert.match(payload.error.message, /auto model selection failed \(403\)/);
    assert.ok(!payload.error.message.includes("at /"), "no stack trace in the error body");
  });

  test("resolveCopilotAuto mints a fresh Copilot token for /auto when the stored one is stale", async () => {
    const calls = mockFetch((call) => {
      if (call.url.startsWith("https://api.github.com/copilot_internal/v2/token")) {
        return new Response(
          JSON.stringify({
            token: "copilot-minted",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200 }
        );
      }
      return autoDecision("gpt-5-mini");
    });
    const stale = freshCredentials({ copilotToken: undefined, copilotTokenExpiresAt: undefined });
    const outcome = await resolveCopilotAuto(
      "github",
      "auto",
      { messages: [{ role: "user", content: "x" }] },
      stale
    );
    assert.equal(outcome.model, "gpt-5-mini");
    // The minted token is only used for /auto: the request credentials stay stale so
    // BaseExecutor.execute() runs its own refresh and persists the token as before.
    assert.equal(outcome.credentials.copilotToken, undefined);
    assert.equal(outcome.credentials.copilotSessionToken, "session-gpt-5-mini");
    const autoCall = calls.find((call) => call.url === AUTO_URL);
    assert.equal(headerValue(autoCall?.headers || {}, "authorization"), "Bearer copilot-minted");
  });

  async function runChatCore(body: Record<string, unknown>, respond: (call: Captured) => Response) {
    const calls = mockFetch(respond);
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "github", model: "auto", extendedContext: false },
      credentials: freshCredentials(),
      log: noopLog,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      connectionId: "conn-auto-1",
      userAgent: "unit-test",
      sessionAffinityKey: "chatcore-session",
    } as unknown as Parameters<typeof handleChatCore>[0]);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    return { calls, result };
  }

  test("chatCore routes github/auto to the selected model and records usage under it", async () => {
    const { calls, result } = await runChatCore(
      {
        model: "github/auto",
        stream: false,
        messages: [{ role: "user", content: "which model am I talking to?" }],
      },
      (call) => {
        if (call.url === AUTO_URL) return autoDecision("gpt-5-mini");
        return new Response(
          JSON.stringify({
            id: "chatcmpl-auto",
            object: "chat.completion",
            model: "gpt-5-mini",
            choices: [
              { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    assert.equal(result.success, true);
    assert.equal(calls[0].url, AUTO_URL);
    const chat = calls.find((call) => call.url.endsWith("/chat/completions"));
    assert.ok(chat, "chat request must follow the /auto decision");
    assert.equal(chat.body?.model, "gpt-5-mini");
    assert.equal(headerValue(chat.headers, "copilot-session-token"), "session-gpt-5-mini");

    // Call-log writes are fire-and-forget; poll (30s ceiling) so a loaded CI worker
    // does not race the assertion. Green runs return on the first saved row.
    let log: Awaited<ReturnType<typeof getCallLogById>> | null = null;
    for (const startedAt = Date.now(); !log && Date.now() - startedAt < 30_000;) {
      await waitForCallLogSaves(5000);
      const rows = await getCallLogs({ limit: 5 });
      log = rows.length > 0 ? await getCallLogById(rows[0].id) : null;
      if (!log) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(log, "the request must be persisted in call logs");
    assert.equal(log.model, "gpt-5-mini", "usage is attributed to the model that served it");
    assert.match(String(log.requestedModel), /auto/, "the client's requested model stays auto");
  });

  test("chatCore sends a Claude auto pick through Copilot's /v1/messages shim in Anthropic shape", async () => {
    const { calls, result } = await runChatCore(
      {
        model: "github/auto",
        stream: false,
        messages: [{ role: "user", content: "write a haiku" }],
      },
      (call) => {
        if (call.url === AUTO_URL) return autoDecision("claude-sonnet-5", true);
        return new Response(
          JSON.stringify({
            id: "msg_auto",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    assert.equal(result.success, true);
    const upstream = calls.find((call) => call.url !== AUTO_URL);
    assert.equal(upstream?.url, "https://api.githubcopilot.com/v1/messages");
    assert.equal(upstream?.body?.model, "claude-sonnet-5");
    assert.ok(Array.isArray(upstream?.body?.messages));
    assert.equal(
      headerValue(upstream?.headers || {}, "copilot-session-token"),
      "session-claude-sonnet-5"
    );
  });
});

describe("openrouter-tool-schema-patterns", () => {
  // OpenRouter → Cohere rejects a whole agent request with
  // `invalid 'parameters' provided: pattern must be a valid regex` when ONE of
  // its (often ~50) function tools carries a malformed `pattern` constraint.
  // Drop only the malformed constraints, only for openrouter, before dispatch.
  type JsonRecord = Record<string, unknown>;
  type DebugCall = [string, string];

  const originalFetch = globalThis.fetch;

  function recordingLog(calls: DebugCall[]) {
    return {
      debug: (tag: string, message: string) => calls.push([tag, message]),
      info() {},
      warn() {},
      error() {},
    };
  }

  function findFilesTool(): JsonRecord {
    return {
      type: "function",
      function: {
        name: "find_files",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", pattern: "^[a-z]+$" },
            properties: { type: "string", pattern: "(" },
            nested: {
              type: "object",
              properties: { value: { type: "string", pattern: "[" } },
            },
          },
          required: ["pattern", "properties"],
        },
      },
    };
  }

  function paramsOf(tool: unknown): JsonRecord {
    return ((tool as JsonRecord).function as JsonRecord).parameters as JsonRecord;
  }

  function propsOf(schema: JsonRecord): JsonRecord {
    return schema.properties as JsonRecord;
  }

  test("openrouter: malformed pattern removed, valid pattern kept", () => {
    const normalized = normalizeToolSchemasForProvider("openrouter", [findFilesTool()]);
    const params = paramsOf(normalized[0]);
    const props = propsOf(params);

    assert.deepEqual(props.pattern, { type: "string", pattern: "^[a-z]+$" });
    assert.deepEqual(propsOf(props.nested as JsonRecord).value, { type: "string" });
  });

  test("openrouter: properties literally named pattern/properties stay properties", () => {
    const normalized = normalizeToolSchemasForProvider("openrouter", [findFilesTool()]);
    const params = paramsOf(normalized[0]);
    const props = propsOf(params);

    assert.deepEqual(Object.keys(props), ["pattern", "properties", "nested"]);
    assert.deepEqual(props.properties, { type: "string" });
    assert.deepEqual(params.required, ["pattern", "properties"]);
    assert.equal(params.type, "object");
  });

  test("openrouter: items/anyOf/$defs invalid patterns removed without mutating input", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "search",
          parameters: {
            type: "object",
            properties: {
              filters: { type: "array", items: { type: "string", pattern: "[" } },
              alternatives: {
                anyOf: [
                  { type: "string", pattern: "^ok$" },
                  { type: "string", pattern: "(" },
                ],
              },
              ref: { $ref: "#/$defs/id" },
            },
            $defs: { id: { type: "string", pattern: "a{2,1}" } },
          },
        },
      },
    ];
    const snapshot = structuredClone(tools);

    const normalized = normalizeToolSchemasForProvider("openrouter", tools);
    const params = paramsOf(normalized[0]);
    const props = propsOf(params);

    assert.deepEqual((props.filters as JsonRecord).items, { type: "string" });
    assert.deepEqual((props.alternatives as JsonRecord).anyOf, [
      { type: "string", pattern: "^ok$" },
      { type: "string" },
    ]);
    assert.deepEqual((params.$defs as JsonRecord).id, { type: "string" });
    assert.deepEqual(tools, snapshot, "input tools must not be mutated");
    assert.notEqual(normalized, tools);
  });

  test("openrouter: flat Responses-shaped function tool parameters are normalized too", () => {
    const tools = [
      {
        type: "function",
        name: "flat",
        parameters: { type: "object", properties: { q: { type: "string", pattern: "[" } } },
      },
    ];
    const normalized = normalizeToolSchemasForProvider("openrouter", tools);
    const params = (normalized[0] as JsonRecord).parameters as JsonRecord;
    assert.deepEqual(propsOf(params).q, { type: "string" });
  });

  test("non-openrouter provider returns the identical array reference", () => {
    const tools = [findFilesTool()];
    assert.equal(normalizeToolSchemasForProvider("groq", tools), tools);
    assert.equal(normalizeToolSchemasForProvider(undefined, tools), tools);
    assert.deepEqual(tools, [findFilesTool()], "non-openrouter tools must stay byte-identical");
  });

  test("openrouter with nothing to strip returns the identical array reference", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "ok",
          parameters: { type: "object", properties: { a: { type: "string", pattern: "^a+$" } } },
        },
      },
    ];
    assert.equal(normalizeToolSchemasForProvider("openrouter", tools), tools);
    assert.equal(normalizeToolSchemasForProvider("openrouter", undefined), undefined);
  });

  test("debug log fires once with a redacted count; silent when nothing removed", () => {
    const calls: DebugCall[] = [];
    normalizeToolSchemasForProvider("openrouter", [findFilesTool()], recordingLog(calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "TOOLSCHEMA");
    assert.match(calls[0][1], /openrouter \| stripped 2 invalid pattern constraints/);
    assert.equal(calls[0][1].includes("["), false, "log must not leak schema content");
    assert.equal(calls[0][1].includes("find_files"), false, "log must not leak tool names");

    const silent: DebugCall[] = [];
    normalizeToolSchemasForProvider(
      "openrouter",
      [{ type: "function", function: { name: "x", parameters: { type: "object" } } }],
      recordingLog(silent)
    );
    assert.equal(silent.length, 0);
  });

  test("stripInvalidRegexPatterns counts removals and leaves non-string patterns alone", () => {
    const stats = { removed: 0 };
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", pattern: "[" },
        b: { type: "string", pattern: "\\d+" },
        c: { type: "string", pattern: 42 },
      },
    };
    const out = stripInvalidRegexPatterns(schema, stats) as JsonRecord;
    assert.equal(stats.removed, 1);
    assert.deepEqual(propsOf(out).a, { type: "string" });
    assert.deepEqual(propsOf(out).b, { type: "string", pattern: "\\d+" });
    assert.deepEqual(propsOf(out).c, { type: "string", pattern: 42 });
  });

  test("stripInvalidRegexPatterns leaves oversized patterns untouched (bounded validation)", () => {
    const huge = "a".repeat(5000) + "[";
    const stats = { removed: 0 };
    const out = stripInvalidRegexPatterns({ type: "string", pattern: huge }, stats) as JsonRecord;
    assert.equal(out.pattern, huge);
    assert.equal(stats.removed, 0);
  });

  test("stripUnsupportedRegexPatterns (codex lookaround strip) behavior is unchanged", () => {
    const out = stripUnsupportedRegexPatterns({
      type: "object",
      properties: {
        look: { type: "string", pattern: "^(?=.*@).+$" },
        broken: { type: "string", pattern: "[" },
      },
    }) as JsonRecord;
    assert.deepEqual(propsOf(out).look, { type: "string" });
    assert.deepEqual(propsOf(out).broken, { type: "string", pattern: "[" });
  });

  // ── Wiring: the strip runs in handleChatCore before the upstream dispatch ──

  async function invoke(provider: string, model: string): Promise<JsonRecord | null> {
    let captured: JsonRecord | null = null;
    globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
      captured = init.body ? (JSON.parse(String(init.body)) as JsonRecord) : null;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
    const body = {
      model,
      messages: [{ role: "user", content: "hi" }],
      tools: [findFilesTool()],
      stream: false,
    };
    try {
      await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider, model, extendedContext: false },
        credentials: { ["api" + "Key"]: "test-key", providerSpecificData: {} },
        log: recordingLog([]),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: new Headers({ accept: "application/json" }),
        },
        connectionId: null,
        apiKeyInfo: null,
        userAgent: "unit-test",
        isCombo: false,
        comboStrategy: null,
        onCredentialsRefreshed: null,
        onRequestSuccess: null,
      });
      return captured;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function resetStorage() {
    clearUpstreamProxyConfigCache();
    resetPayloadRulesConfigForTests();
    clearCache();
    clearIdempotency();
    clearInflight();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  before(freshDb);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetAccountSemaphores();
    await resetStorage();
  });

  after(() => {
    core.resetDbInstance();
  });

  test("chatCore strips malformed tool patterns on the openrouter wire body", async () => {
    const sent = await invoke("openrouter", "cohere/command-a");
    assert.ok(sent, "upstream request was captured");
    const tools = sent.tools as unknown[];
    assert.equal(Array.isArray(tools), true);
    const props = propsOf(paramsOf(tools[0]));
    assert.deepEqual(props.pattern, { type: "string", pattern: "^[a-z]+$" });
    assert.deepEqual(props.properties, { type: "string" });
    assert.deepEqual(propsOf(props.nested as JsonRecord).value, { type: "string" });
  });

  test("chatCore leaves tool patterns untouched for a non-openrouter provider", async () => {
    const sent = await invoke("groq", "llama-3.3-70b-versatile");
    assert.ok(sent, "upstream request was captured");
    const props = propsOf(paramsOf((sent.tools as unknown[])[0]));
    assert.deepEqual(props.properties, { type: "string", pattern: "(" });
    assert.deepEqual(propsOf(props.nested as JsonRecord).value, { type: "string", pattern: "[" });
  });
});

describe("13789-builtin-openai-nonfunction-tools (#13789)", () => {
  // #13789 — built-in OpenAI-format providers forward non-function tool types unchanged.
  //
  // normalizeOpenAICompatibleTools() only ran for custom `openai-compatible-*` providers,
  // so a built-in provider like agentrouter (OpenAI Chat wire) forwarded client tools such
  // as `{ type: "web_search" }` verbatim and the GLM backend rejected the WHOLE request
  // with `400 tools[0].type:type is illegal`. The fix extends the normalization to a
  // conservative allowlist of built-in providers observed to accept function tools only,
  // gated on the OpenAI Chat target format. OpenAI itself is NOT on the list, so its
  // `custom` tools keep passing through untouched (acceptance criterion 2).
  const originalFetch = globalThis.fetch;

  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  function chatCompletionResponse(model) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl_13789",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  async function flushAsyncSideEffects() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  before(freshDb);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await flushAsyncSideEffects();
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await core.resetDbInstance();
  });

  async function runChatRequest({ provider, model, apiKey, tools }) {
    let captured = null;
    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init.body || "{}")),
      };
      return chatCompletionResponse(model);
    };

    const body = {
      model: `${provider}/${model}`,
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      max_tokens: 16,
      stream: false,
      tools,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider, model, extendedContext: false },
      credentials: { apiKey, providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "test-client/1.0",
    });
    return { result, captured };
  }

  test("#13789 agentrouter+glm: a request with non-function tools reaches the executor with none", async () => {
    const { result, captured } = await runChatRequest({
      provider: "agentrouter",
      model: "glm-5.3",
      apiKey: "test-...ey",
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
        // Acceptance shape from the issue: a hosted `{ type: "web_search" }` tool.
        // The web-search fallback converts this to the omniroute_web_search function
        // tool on this provider, so it never reaches upstream as a non-function type.
        { type: "web_search" },
        // The shapes that actually leak on the current tip: a named Claude server
        // tool (must convert to function) and a nameless hosted tool (must drop).
        // Both forwarded verbatim, agentrouter GLM 400s the WHOLE request with
        // `tools[0].type:type is illegal`.
        { type: "computer_20241022", name: "computer", display_width_px: 1024 },
        { type: "code_interpreter" },
      ],
    });

    assert.equal(result.success, true);
    assert.ok(captured, "the executor was reached");
    assert.equal(captured.url, "https://agentrouter.org/v1/chat/completions");

    const tools = captured.body.tools ?? [];
    for (const tool of tools) {
      assert.equal(
        tool.type,
        "function",
        `non-function tool reached agentrouter upstream: ${JSON.stringify(tool)}`
      );
    }
    const names = new Set(tools.map((t) => t.function?.name));
    assert.ok(names.has("get_weather"), "the plain function tool survives");
    assert.ok(names.has("computer"), "the named server tool is converted, not forwarded raw");
    assert.ok(names.has("omniroute_web_search"), "web_search lands as the fallback function tool");
    assert.equal(
      names.has("code_interpreter"),
      false,
      "the nameless hosted tool is dropped, not forwarded"
    );
  });

  test("#13789 openai: `custom` tools stay untouched (allowlist is conservative)", async () => {
    const customTool = {
      type: "custom",
      name: "exec",
      format: { type: "grammar", grammar: "lark" },
    };
    const { result, captured } = await runChatRequest({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "test-openai-key",
      tools: [customTool],
    });

    assert.equal(result.success, true);
    assert.ok(captured, "the executor was reached");
    const tools = captured.body.tools ?? [];
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, "custom", "openai keeps its own custom tool type");
    assert.equal(tools[0].name, "exec");
  });
});

describe("gpt6-max-tokens-rename-14869 (#14869)", () => {
  // #14869: GPT-6 rejects `max_tokens` and wants `max_completion_tokens` (Chat
  // Completions) or `max_output_tokens` (Responses). The rename in chatCore is
  // gated by supportsMaxTokens(), whose blocklist only named gpt-5.4 and
  // gpt-5.5, so gpt-6-astra left the client's max_tokens on the wire and the
  // upstream answered 400.
  const originalFetch = globalThis.fetch;

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  function buildResponse() {
    return new Response(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  async function invoke({ provider, model }) {
    let captured = null;
    globalThis.fetch = async (_url, init = {}) => {
      captured = init.body ? JSON.parse(String(init.body)) : null;
      return buildResponse();
    };
    try {
      await handleChatCore({
        body: {
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 2048,
          stream: false,
        },
        modelInfo: { provider, model, extendedContext: false },
        credentials: { ["api" + "Key"]: "test-key", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 2048 },
          headers: new Headers({ accept: "application/json" }),
        },
        connectionId: null,
        apiKeyInfo: null,
        userAgent: "unit-test",
        isCombo: false,
        comboStrategy: null,
        onCredentialsRefreshed: null,
        onRequestSuccess: null,
      });
      return captured;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function resetStorage() {
    clearUpstreamProxyConfigCache();
    resetPayloadRulesConfigForTests();
    clearCache();
    clearIdempotency();
    clearInflight();
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
  }

  before(freshDb);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetAccountSemaphores();
    await resetStorage();
  });

  after(async () => {
    await core.resetDbInstance();
  });

  test("#14869 gpt-6-astra is not treated as a max_tokens model", async () => {
    assert.equal(await supportsMaxTokens({ provider: "openai", model: "gpt-6-astra" }), false);
    assert.equal(await supportsMaxTokens({ provider: "openai", model: "gpt-5.5" }), false);
    assert.equal(await supportsMaxTokens({ provider: "openai", model: "gpt-4o" }), true);
  });

  test("#14869 a custom gpt-6 model leaves no max_tokens on the openai body", async () => {
    // A user-added model has no registry entry and so no targetFormat override:
    // it stays on Chat Completions and must be renamed by the default executor
    // rather than the Responses translator. This used gpt-6-luna until #15164
    // registered it (with targetFormat openai-responses); the id below stays
    // unregistered so the custom-model path is still the one exercised.
    const body = await invoke({ provider: "openai", model: "gpt-6-custom-14869" });
    assert.ok(body, "upstream request was captured");
    assert.equal(body.max_tokens, undefined, "gpt-6 rejects max_tokens");
    assert.equal(body.max_completion_tokens, 2048);
  });

  test("#14869 a registered gpt-6 model on Responses carries max_output_tokens only", async () => {
    // #15164 registered gpt-6-luna with targetFormat openai-responses, so the
    // Responses translator owns the rename: max_output_tokens, never max_tokens.
    const body = await invoke({ provider: "openai", model: "gpt-6-luna" });
    assert.ok(body, "upstream request was captured");
    assert.equal(body.max_tokens, undefined, "gpt-6 rejects max_tokens");
    assert.equal(body.max_output_tokens, 2048);
  });
});

describe("codex-stream-false", () => {
  const originalFetch = globalThis.fetch;

  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  function createComboLog() {
    const entries = [];
    return {
      info: (tag, msg) => entries.push({ level: "info", tag, msg }),
      warn: (tag, msg) => entries.push({ level: "warn", tag, msg }),
      error: (tag, msg) => entries.push({ level: "error", tag, msg }),
      entries,
    };
  }

  function createCaptureLog() {
    const entries = [];
    return {
      debug: (tag, msg) => entries.push({ level: "debug", tag, msg }),
      info: (tag, msg) => entries.push({ level: "info", tag, msg }),
      warn: (tag, msg) => entries.push({ level: "warn", tag, msg }),
      error: (tag, msg) => entries.push({ level: "error", tag, msg }),
      entries,
    };
  }

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function buildResponsesSse(text = "Brasilia") {
    return new Response(
      [
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.3-codex","status":"in_progress","output":[]}}',
        "",
        "event: response.output_text.delta",
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          delta: text,
        })}`,
        "",
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            object: "response",
            model: "gpt-5.3-codex",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text }],
              },
            ],
            usage: { input_tokens: 6, output_tokens: 1 },
          },
        })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }

  function buildResponsesNdjson(text = "Brasilia") {
    return new Response(
      [
        JSON.stringify({
          type: "response.created",
          response: {
            id: "resp_1",
            model: "gpt-5.3-codex",
            status: "in_progress",
            output: [],
          },
        }),
        JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          delta: text,
        }),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            object: "response",
            model: "gpt-5.3-codex",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text }],
              },
            ],
            usage: { input_tokens: 6, output_tokens: 1 },
          },
        }),
      ].join("\n"),
      {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }
    );
  }

  async function resetStorage() {
    core.resetDbInstance();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  async function flushAsyncSideEffects() {
    // setImmediate rounds drain the event loop more reliably than setTimeout under CI load.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  async function invokeChatCore({
    body,
    provider = "openai",
    model = "gpt-4o-mini",
    endpoint = "/v1/chat/completions",
    accept = "application/json",
    responseFactory,
    log = noopLog(),
  } = {}) {
    const calls = [];

    globalThis.fetch = async (url, init = {}) => {
      const headers =
        init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : init.headers || {};
      const call = {
        url: String(url),
        method: init.method || "GET",
        headers,
        body: init.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      return responseFactory(call);
    };

    try {
      const requestBody = structuredClone(body);
      const result = await handleChatCore({
        body: requestBody,
        modelInfo: { provider, model, extendedContext: false },
        credentials: {
          apiKey: "sk-test",
          accessToken: "codex-token",
          providerSpecificData: {},
        },
        log,
        clientRawRequest: {
          endpoint,
          body: structuredClone(body),
          headers: new Headers({ accept }),
        },
        userAgent: "unit-test",
      });
      await flushAsyncSideEffects();
      return { result, calls, call: calls.at(-1) };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    await resetStorage();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await resetStorage();
  });

  test("CodexExecutor.transformRequest clones the request body before forcing stream=true", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: [{ type: "input_text", text: "Oi" }] }],
      stream: false,
      reasoning: { effort: "low" },
    };
    const original = structuredClone(body);

    const transformed = executor.transformRequest("gpt-5.6-sol", body, false, {
      requestEndpointPath: "/responses",
    });

    assert.notStrictEqual(transformed, body);
    assert.deepEqual(body, original);
    assert.equal(transformed.stream, true);
  });

  test("chatCore converts Responses-style SSE fallback into JSON when stream=false", async () => {
    const { result, call } = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Qual a capital do Brasil?" }],
      },
      provider: "openai",
      model: "gpt-4o-mini",
      responseFactory: () => buildResponsesSse("Brasilia"),
    });

    const payload = (await result.response.json()) as any;

    assert.equal(result.success, true);
    assert.equal(call.headers.Accept || call.headers.accept, "application/json");
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0].message.content, "Brasilia");
    assert.ok(payload.usage.total_tokens >= 7);
    assert.ok(payload.usage.prompt_tokens > 0);
    assert.ok(payload.usage.completion_tokens > 0);
  });

  test("chatCore buffers expected Codex upstream SSE without warning for stream=false clients", async () => {
    const log = createCaptureLog();
    const { result, call } = await invokeChatCore({
      body: {
        model: "gpt-5.3-codex",
        stream: false,
        messages: [{ role: "user", content: "Qual a capital do Brasil?" }],
      },
      provider: "codex",
      model: "gpt-5.3-codex",
      responseFactory: () => buildResponsesSse("Brasilia"),
      log,
    });

    const payload = (await result.response.json()) as any;

    assert.equal(result.success, true);
    assert.equal(call.headers.Accept || call.headers.accept, "text/event-stream");
    assert.equal(call.body.stream, true);
    assert.equal(payload.choices[0].message.content, "Brasilia");
    assert.equal(
      log.entries.some(
        (entry) =>
          entry.level === "warn" &&
          String(entry.msg).includes("Unexpected SSE response for non-streaming request")
      ),
      false
    );
    assert.equal(
      log.entries.some(
        (entry) =>
          entry.level === "debug" &&
          String(entry.msg).includes("Buffering upstream SSE response for non-streaming client")
      ),
      true
    );
  });

  test("chatCore converts Responses-style NDJSON fallback into JSON when stream=false", async () => {
    const { result, call } = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Qual a capital do Brasil?" }],
      },
      provider: "openai",
      model: "gpt-4o-mini",
      responseFactory: () => buildResponsesNdjson("Brasilia"),
    });

    const payload = (await result.response.json()) as any;

    assert.equal(result.success, true);
    assert.equal(call.headers.Accept || call.headers.accept, "application/json");
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.choices[0].message.content, "Brasilia");
    assert.ok(payload.usage.total_tokens >= 7);
  });

  test("handleComboChat validates non-stream quality using the original client stream intent", async () => {
    const combo = {
      name: "codex-stream-false-quality",
      models: ["codex/gpt-5.6-sol", "openai/gpt-4o-mini"],
    };
    const log = createComboLog();
    const seenModels = [];

    const result = await handleComboChat({
      body: {
        stream: false,
        messages: [{ role: "user", content: "Qual a capital do Brasil?" }],
      },
      combo,
      handleSingleModel: async (requestBody, modelStr) => {
        seenModels.push(modelStr);
        if (modelStr === "codex/gpt-5.6-sol") {
          requestBody.stream = true;
          return jsonResponse({
            choices: [
              { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
            ],
          });
        }

        return jsonResponse({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Brasilia" },
              finish_reason: "stop",
            },
          ],
        });
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
    });

    const payload = (await result.json()) as any;

    assert.equal(result.ok, true);
    assert.deepEqual(seenModels, ["codex/gpt-5.6-sol", "openai/gpt-4o-mini"]);
    assert.equal(payload.choices[0].message.content, "Brasilia");
    assert.ok(
      log.entries.some(
        (entry) =>
          entry.level === "warn" &&
          String(entry.msg).includes(
            "failed quality check: empty content and no tool_calls in response"
          )
      )
    );
  });

  test("non-stream chat success carries cost-telemetry meta headers (cost/version/tokens)", async () => {
    // Regression guard: the single non-stream success return in chatCore.ts routes
    // through attachOmniRouteMetaHeaders, which must always emit the cost-telemetry
    // headers. A usage-bearing JSON upstream body proves real usage flowed through.
    const { result } = await invokeChatCore({
      body: {
        model: "gpt-4o-mini",
        stream: false,
        messages: [{ role: "user", content: "Qual a capital do Brasil?" }],
      },
      provider: "openai",
      model: "gpt-4o-mini",
      responseFactory: () =>
        jsonResponse({
          id: "chatcmpl-cost-header",
          object: "chat.completion",
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Brasilia" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    });

    assert.equal(result.success, true);

    const headers = result.response.headers;

    const cost = headers.get(OMNIROUTE_RESPONSE_HEADERS.responseCost);
    assert.equal(typeof cost, "string");
    // 10-decimal cost format; 0.0000000000 is valid when no pricing is available.
    assert.match(String(cost), /^\d+\.\d{10}$/);

    const version = headers.get(OMNIROUTE_RESPONSE_HEADERS.version);
    assert.equal(typeof version, "string");
    assert.ok(String(version).length > 0);

    // Real usage from the upstream body must surface as token-count headers.
    assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.tokensIn), "10");
    assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.tokensOut), "5");
  });
});

describe("chatcore-codex-account-pool", () => {
  const originalFetch = globalThis.fetch;

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

  function buildResponsesResponse(text = "ok") {
    return new Response(
      JSON.stringify({
        id: "resp_123",
        object: "response",
        status: "completed",
        model: "gpt-5.1-codex",
        output: [
          {
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  async function waitForAsyncSideEffects() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async function invokeChatCore({
    body,
    provider = "codex",
    model,
    endpoint = "/v1/responses",
    credentials,
    responseFactory,
    connectionId = null,
    isCombo = false,
  }: {
    body: unknown;
    provider?: string;
    model: string;
    endpoint?: string;
    credentials: Record<string, unknown>;
    responseFactory: (captured: unknown, calls: unknown[]) => Response;
    connectionId?: string | null;
    isCombo?: boolean;
  }) {
    const calls: unknown[] = [];
    globalThis.fetch = async (url, init = {}) => {
      const headers = toPlainHeaders(init.headers);
      const captured = {
        url: String(url),
        method: init.method || "GET",
        headers,
        body: init.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(captured);
      return responseFactory(captured, calls);
    };

    try {
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider, model, extendedContext: false },
        credentials,
        log: noopLog(),
        clientRawRequest: {
          endpoint,
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        connectionId,
        userAgent: "unit-test",
        isCombo,
      });
      await waitForAsyncSideEffects();
      return { calls, result };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  before(freshDb);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await waitForAsyncSideEffects();
    await resetStorage();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await waitForAsyncSideEffects();
    await resetStorage();
    await core.resetDbInstance();
  });

  test("chatCore persists child cooldown for each rotated Codex attempt", async () => {
    const first = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "codex-rotation-first@example.com",
      accessToken: "codex-rotation-first",
      isActive: true,
      providerSpecificData: {},
    });
    const second = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "codex-rotation-second@example.com",
      accessToken: "codex-rotation-second",
      isActive: true,
      providerSpecificData: {},
    });
    const liveCredentials = {
      accessToken: "codex-rotation-first",
      connectionId: first.id,
      providerSpecificData: {},
    };

    const { result } = await invokeChatCore({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      endpoint: "/v1/responses",
      connectionId: first.id,
      credentials: liveCredentials,
      body: {
        model: "gpt-5.3-codex-spark",
        input: "rotate twice",
        stream: false,
      },
      responseFactory() {
        return new Response(
          JSON.stringify({ error: { message: "The usage limit has been reached" } }),
          { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" } }
        );
      },
    });
    const firstPersisted = await providersDb.getProviderConnectionById(first.id);
    const secondPersisted = await providersDb.getProviderConnectionById(second.id);

    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.equal(
      typeof firstPersisted.providerSpecificData.codexScopeRateLimitedUntil.spark,
      "string"
    );
    assert.equal(
      typeof secondPersisted.providerSpecificData.codexScopeRateLimitedUntil.spark,
      "string"
    );
    assert.equal(liveCredentials.connectionId, second.id);
  });

  test("chatCore retains exact quota resets from intermediate rotated Codex 429s", async () => {
    const first = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "codex-exact-reset-first@example.com",
      accessToken: "codex-exact-reset-first",
      isActive: true,
      providerSpecificData: {},
    });
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "codex-exact-reset-second@example.com",
      accessToken: "codex-exact-reset-second",
      isActive: true,
      providerSpecificData: {},
    });
    const exactReset = new Date(Date.now() + 300_000).toISOString();
    const weeklyReset = new Date(Date.now() + 3_600_000).toISOString();
    const { result } = await invokeChatCore({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      endpoint: "/v1/responses",
      connectionId: first.id,
      isCombo: true,
      credentials: {
        accessToken: "codex-exact-reset-first",
        connectionId: first.id,
        providerSpecificData: {},
      },
      body: {
        model: "gpt-5.3-codex-spark",
        input: "persist exact reset before rotation",
        stream: false,
      },
      // Key the 429 on the FIRST account's token, not on a call count: since #14959 a
      // 429 carrying Retry-After: 60 skips the same-account intra-retries, so the first
      // account answers once (not 3x) before chatCore rotates to the second one.
      responseFactory(captured: unknown) {
        const headers = (captured as { headers: Record<string, string> }).headers;
        const auth = headers.authorization ?? headers.Authorization ?? "";
        if (auth.includes("codex-exact-reset-first")) {
          return new Response(JSON.stringify({ error: { message: "Codex quota exceeded" } }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "60",
              "x-codex-5h-usage": "100",
              "x-codex-5h-limit": "100",
              "x-codex-5h-reset-at": exactReset,
              "x-codex-7d-usage": "10",
              "x-codex-7d-limit": "100",
              "x-codex-7d-reset-at": weeklyReset,
            },
          });
        }
        return buildResponsesResponse("rotated account succeeded");
      },
    });
    const persisted = await providersDb.getProviderConnectionById(first.id);

    assert.ok(persisted);
    assert.equal(result.success, true);
    assert.equal(persisted.providerSpecificData.codexScopeRateLimitedUntil.spark, exactReset);
    assert.equal(persisted.providerSpecificData.codexExhaustedWindowByScope.spark, "5h");
    assert.equal(persisted.providerSpecificData.codexQuotaStateByScope.spark.resetAt5h, exactReset);
  });

  test("chatCore keeps a Codex Spark 429 scoped so Sol remains selectable", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      email: "codex-scope@example.com",
      accessToken: "codex-scope-token",
      isActive: true,
      providerSpecificData: {},
    });

    const { result } = await invokeChatCore({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      endpoint: "/v1/responses",
      connectionId: connection.id,
      credentials: {
        accessToken: "codex-scope-token",
        connectionId: connection.id,
        providerSpecificData: {},
      },
      body: {
        model: "gpt-5.3-codex-spark",
        input: "scope this cooldown",
        stream: false,
      },
      responseFactory() {
        return new Response(
          JSON.stringify({ error: { message: "The usage limit has been reached" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "60",
            },
          }
        );
      },
    });

    const updated = await providersDb.getProviderConnectionById(connection.id);
    const sparkSelected = await auth.getProviderCredentials(
      "codex",
      null,
      null,
      "gpt-5.3-codex-spark"
    );
    const solSelected = await auth.getProviderCredentials("codex", null, null, "gpt-5.6-sol");

    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.equal(updated.rateLimitedUntil, undefined);
    assert.equal(typeof updated.providerSpecificData.codexScopeRateLimitedUntil.spark, "string");
    assert.equal(sparkSelected.allRateLimited, true);
    assert.equal(solSelected.connectionId, connection.id);
  });
});

describe("native-codex-passthrough-compaction (#16632)", () => {
  const ENV_CONTEXT_LIMIT = "CONTEXT_LENGTH_CODEX";
  const originalFetch = globalThis.fetch;
  const originalEnvContext = process.env[ENV_CONTEXT_LIMIT];
  const originalFlag = process.env[NATIVE_CODEX_REACTIVE_COMPACTION_FLAG];

  let upstreamPayload: Record<string, unknown> | null = null;

  async function resetStorage() {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  before(freshDb);

  before(async () => {
    await resetStorage();
    process.env[ENV_CONTEXT_LIMIT] = "4000";

    await updateCompressionSettings({
      enabled: true,
      defaultMode: "off",
    });

    globalThis.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(url instanceof Request ? url.url : url).includes("/__omniroute_event")) {
        return new Response(null, { status: 204 });
      }
      if (init.body) {
        try {
          upstreamPayload = JSON.parse(String(init.body));
        } catch {
          upstreamPayload = null;
        }
      }
      return new Response(
        JSON.stringify({
          id: "resp-test",
          object: "response",
          model: "gpt-5.6-terra",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok from upstream codex" }],
            },
          ],
          usage: { input_tokens: 1500, output_tokens: 5, total_tokens: 1505 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    };
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalEnvContext === undefined) {
      delete process.env[ENV_CONTEXT_LIMIT];
    } else {
      process.env[ENV_CONTEXT_LIMIT] = originalEnvContext;
    }
    if (originalFlag === undefined) {
      delete process.env[NATIVE_CODEX_REACTIVE_COMPACTION_FLAG];
    } else {
      process.env[NATIVE_CODEX_REACTIVE_COMPACTION_FLAG] = originalFlag;
    }
    await new Promise((r) => setTimeout(r, 200));
    core.resetDbInstance();
  });

  function buildOversizedNativeCodexRequest() {
    // 10 turns of Responses API input[] (~5,000 estimated tokens, > 4,000 context limit)
    const input = [];
    for (let i = 0; i < 10; i++) {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Turn ${i} user request: ` + "word ".repeat(250) }],
      });
      input.push({
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: `Turn ${i} assistant reply: ` + "answer ".repeat(250) },
        ],
      });
    }
    const responsesBody = { model: "gpt-5.6-terra", input, stream: false };
    return { input, responsesBody };
  }

  function runNativeCodex(responsesBody: Record<string, unknown>) {
    return handleChatCore({
      body: responsesBody,
      modelInfo: { provider: "codex", model: "gpt-5.6-terra", extendedContext: false },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: { baseUrl: "https://api.openai.com" },
      },
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: responsesBody,
        headers: new Headers({ accept: "application/json", "content-type": "application/json" }),
      },
      userAgent: "codex_cli/1.0.0",
      isCombo: false,
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
  }

  test("flag resolver: exclusion holds by default, opts in only when the flag is on, fails closed", () => {
    assert.equal(
      shouldSkipNativeCodexReactiveCompaction(false, () => false),
      false
    );
    assert.equal(
      shouldSkipNativeCodexReactiveCompaction(true, () => false),
      true
    );
    assert.equal(
      shouldSkipNativeCodexReactiveCompaction(true, () => true),
      false
    );
    assert.equal(
      shouldSkipNativeCodexReactiveCompaction(true, () => {
        throw new Error("flag store unavailable");
      }),
      true
    );
    let askedKey = "";
    shouldSkipNativeCodexReactiveCompaction(true, (key) => {
      askedKey = key;
      return false;
    });
    assert.equal(askedKey, "NATIVE_CODEX_REACTIVE_COMPACTION_ENABLED");
  });

  test("flag off (default): native Codex history is never compacted — oversized request is rejected unchanged", async () => {
    delete process.env[NATIVE_CODEX_REACTIVE_COMPACTION_FLAG];
    upstreamPayload = null;
    const { responsesBody } = buildOversizedNativeCodexRequest();

    const result = await runNativeCodex(responsesBody);

    assert.equal(result.success, false, "oversized native Codex history must not be compacted");
    assert.equal((result as { status?: number }).status, 400);
    assert.match(String((result as { error?: string }).error), /exceeds context window/);
    assert.equal(upstreamPayload, null, "no upstream dispatch with the exclusion in place");
  });

  test("flag on: native Codex passthrough compacts multi-turn Responses payloads when context threshold exceeded", async () => {
    process.env[NATIVE_CODEX_REACTIVE_COMPACTION_FLAG] = "true";
    upstreamPayload = null;
    const { input, responsesBody } = buildOversizedNativeCodexRequest();

    const result = await runNativeCodex(responsesBody);
    delete process.env[NATIVE_CODEX_REACTIVE_COMPACTION_FLAG];

    assert.equal(
      result.success,
      true,
      `expected request to succeed, got error: ${(result as { error?: string }).error}`
    );
    assert.ok(upstreamPayload, "expected upstream request to be dispatched");
    assert.ok(
      Array.isArray(upstreamPayload.input),
      "expected native Responses input[] array upstream"
    );
    assert.ok(
      (upstreamPayload.input as unknown[]).length < input.length,
      `expected input turns to be compacted/pruned: original ${input.length}, upstream ${(upstreamPayload.input as unknown[]).length}`
    );
  });
});

describe("compaction-input-cap-alignment", () => {
  const TEST_PROVIDER = "test-compaction-prov";
  const TEST_MODEL = "test-compaction-model";
  const ENV_CONTEXT_LIMIT = "CONTEXT_LENGTH_TEST_COMPACTION_PROV";

  const originalFetch = globalThis.fetch;
  const originalEnvContext = process.env[ENV_CONTEXT_LIMIT];

  async function resetStorage() {
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  before(freshDb);

  before(async () => {
    await resetStorage();
    // Window is 8000 tokens, but input-only cap is 4000 tokens
    process.env[ENV_CONTEXT_LIMIT] = "8000";

    await updateCompressionSettings({
      enabled: true,
      defaultMode: "off",
    });

    await setModelCapabilityOverride(`${TEST_PROVIDER}/${TEST_MODEL}`, "max_input_tokens", 4000);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: Date.now(),
          model: TEST_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok from upstream" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3000, completion_tokens: 5, total_tokens: 3005 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalEnvContext === undefined) {
      delete process.env[ENV_CONTEXT_LIMIT];
    } else {
      process.env[ENV_CONTEXT_LIMIT] = originalEnvContext;
    }
    await new Promise((r) => setTimeout(r, 200));
    await core.resetDbInstance();
  });

  test("aligns reactive compaction ceiling to max_input_tokens so dead band [cap, window) auto-compacts instead of 400", async () => {
    // Generate multi-turn history with ~5,500 estimated tokens (chars/4).
    // Fits in window (8000) but exceeds input cap (4000).
    // Without the fix, last-resort compaction skipped (5500 < 8000) and enforceOutputTokenBudget rejects with 400.
    // With the fix, last-resort targets 4000, prunes older history, fits < 4000 and succeeds.
    const turns = [];
    for (let i = 0; i < 10; i++) {
      turns.push({
        role: "user",
        content: `Turn ${i} user request: ` + "word ".repeat(250),
      });
      turns.push({
        role: "assistant",
        content: `Turn ${i} assistant reply: ` + "answer ".repeat(250),
      });
    }

    const result = await handleChatCore({
      body: {
        model: TEST_MODEL,
        messages: turns,
        stream: false,
      },
      modelInfo: {
        provider: TEST_PROVIDER,
        model: TEST_MODEL,
        extendedContext: false,
      },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: {
          baseUrl: "https://test-compaction.example.test",
        },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {
          model: TEST_MODEL,
          messages: turns,
          stream: false,
        },
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      isCombo: false,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    });

    assert.equal(
      result.success,
      true,
      `expected request to succeed via last-resort compaction to input cap, got error: ${
        (result as { error?: string }).error
      }`
    );
  });
});

describe("namespace-tool-identity-integration", () => {
  const originalFetch = globalThis.fetch;

  type ToolItem = { type: string; namespace?: string; name?: string };
  type SseFrame = { event: string | undefined; data: unknown };

  function requestBody(stream: boolean) {
    return {
      model: "gpt-4o-mini",
      stream,
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "mcp__atlassian__cloud__tenant",
              tools: [{ name: "read_issue", parameters: { type: "object" } }],
            },
          ],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }] },
      ],
    };
  }

  function chatToolCall() {
    return {
      id: "chatcmpl_namespace_identity",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_namespace_identity",
                type: "function",
                function: {
                  name: "mcp__atlassian__cloud__tenant__read_issue",
                  arguments: JSON.stringify({ key: "PROJ-1" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  function streamingChatToolCall() {
    const toolCall = chatToolCall().choices[0].message.tool_calls[0];
    return [
      {
        id: "chatcmpl_namespace_identity",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", tool_calls: [toolCall] },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];
  }

  function sse(events: unknown[]) {
    return (
      events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") + "data: [DONE]\n\n"
    );
  }

  async function invokeResponsesRequest(stream: boolean) {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init.body));
      calls.push({ body });
      const payload = stream ? sse(streamingChatToolCall()) : JSON.stringify(chatToolCall());
      return new Response(payload, {
        status: 200,
        headers: { "Content-Type": stream ? "text/event-stream" : "application/json" },
      });
    };

    try {
      const body = requestBody(stream);
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/responses",
          body: structuredClone(body),
          headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
        },
        userAgent: "namespace-identity-integration-test",
      } as never);

      assert.equal(result.success, true);
      assert.equal(calls.length, 1);
      assert.equal(
        "_toolNameMap" in calls[0].body,
        false,
        "identity metadata must not reach upstream"
      );
      return result.response;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function parseSseFrames(body: string): SseFrame[] {
    return body
      .trim()
      .split(/\r?\n\r?\n/)
      .map((frame) => {
        const fields = frame.split(/\r?\n/);
        const event = fields.find((line) => line.startsWith("event: "))?.slice("event: ".length);
        const data = fields.find((line) => line.startsWith("data: "))?.slice("data: ".length);
        return { event, data: data === "[DONE]" ? data : JSON.parse(data ?? "null") };
      });
  }

  function assertNamespaceTuple(item: ToolItem | undefined) {
    assert.ok(item, "expected a function-call output item");
    assert.equal(item.type, "function_call");
    assert.deepEqual(
      { namespace: item.namespace, name: item.name },
      { namespace: "mcp__atlassian__cloud__tenant", name: "read_issue" }
    );
  }

  before(freshDb);

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns a namespace tuple for a non-streaming Responses request translated through chatCore", async () => {
    const response = await invokeResponsesRequest(false);
    const payload = await response.json();

    assertNamespaceTuple(payload.output.find((item: ToolItem) => item.type === "function_call"));
  });

  test("emits namespace tuples for every streaming Responses function-call event translated through chatCore", async () => {
    const response = await invokeResponsesRequest(true);
    const frames = parseSseFrames(await response.text());

    const added = frames.find((frame) => frame.event === "response.output_item.added");
    assertNamespaceTuple((added?.data as { item?: ToolItem })?.item);

    const done = frames.find((frame) => frame.event === "response.output_item.done");
    assertNamespaceTuple((done?.data as { item?: ToolItem })?.item);

    const completed = frames.find((frame) => frame.event === "response.completed");
    assertNamespaceTuple(
      (completed?.data as { response?: { output?: ToolItem[] } })?.response?.output?.find(
        (item) => item.type === "function_call"
      )
    );
  });
});

describe("codex-passive-refresh-gate", () => {
  const dataDir = TEST_DATA_DIR;
  const db = providersDb;
  const { markAccountUnavailable } = auth;
  const originalFetch = globalThis.fetch;
  const originalRequireApiKey = process.env.REQUIRE_API_KEY;
  let tokenCalls = 0;
  let dispatches: string[] = [];
  let passive = true;
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };

  type SqlMethod = "query" | "queryOne" | "execute";

  /**
   * Runs `onCall` before every SQL statement the process backend issues, so tests can count writes
   * or inject failures. Returns the function that restores the original methods.
   */
  function spyOnSql(onCall: (sql: string, params?: unknown[]) => void): () => void {
    const backend = getTestBackend() as unknown as Record<
      SqlMethod,
      (...args: unknown[]) => unknown
    >;
    const names: SqlMethod[] = ["query", "queryOne", "execute"];
    const originals = {} as Record<SqlMethod, (...args: unknown[]) => unknown>;
    for (const name of names) {
      const original = backend[name];
      originals[name] = original;
      backend[name] = (sql: unknown, params?: unknown) => {
        onCall(String(sql), params as unknown[] | undefined);
        return original.call(backend, sql, params);
      };
    }
    return () => {
      for (const name of names) backend[name] = originals[name];
    };
  }

  function request(url: string, body: unknown) {
    return new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function chat(stream = false) {
    return handleChat(
      request("/v1/chat/completions", {
        model: "cx/gpt-5.5",
        messages: [{ role: "user", content: "synthetic" }],
        stream,
      })
    );
  }
  async function connection(seconds = 3600) {
    return await db.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "synthetic-refresh-gate",
      email: `${crypto.randomUUID()}@example.invalid`,
      accessToken: "synthetic-access",
      // Unique per connection: the refresh guard remembers a token the server rejected as dead.
      refreshToken: `synthetic-refresh-${crypto.randomUUID()}`,
      idToken: "synthetic-id",
      expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
      isActive: true,
      testStatus: "active",
      healthCheckInterval: 1,
      providerSpecificData: { workspaceId: "synthetic-workspace" },
    });
  }
  function mockFetch(onDispatch?: () => Promise<void>, status = 401) {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("auth.openai.com/oauth/token")) {
        tokenCalls++;
        assert.equal(passive, false, "passive refresh must never reach the Codex token endpoint");
        return Response.json({ error: { code: "invalid_grant" } }, { status: 400 });
      }
      assert.match(url, /chatgpt.com\/backend-api/);
      dispatches.push(new Headers(init?.headers).get("authorization") || "");
      await onDispatch?.();
      return Response.json({ error: { message: "synthetic invalid token" } }, { status });
    };
  }
  async function nonterminal(id: string) {
    await new Promise((resolve) => setImmediate(resolve));
    const row = await db.getProviderConnectionById(id);
    assert.notEqual(row.testStatus, "expired");
    assert.equal(row.isActive, true);
    assert.equal(row.providerSpecificData?.refreshCircuit, undefined);
    assert.equal(tokens.getCircuitBreakerStatus().codex, undefined);
    return row;
  }

  before(() => {
    // Load-time env of the original file; REQUIRE_API_KEY is read per request.
    process.env.REQUIRE_API_KEY = "false";
  });

  beforeEach(async () => {
    await resetTestDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    await settings.updateSettings({
      requireLogin: false,
      requireApiKey: false,
      fallbackStrategy: "fill-first",
      requestRetry: 0,
      maxRetryIntervalSec: 0,
    });
    process.env.OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS = "codex";
    process.env.HEALTHCHECK_STAGGER_MS = "0";
    passive = true;
    const now = Date.now;
    Date.now = () => now() + 31 * 60 * 1000;
    delete process.env.OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS;
    try {
      await tokens.refreshWithRetry(
        async () => ({ accessToken: "synthetic-breaker-reset" }),
        1,
        quiet,
        "codex"
      );
    } finally {
      Date.now = now;
      process.env.OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS = "codex";
    }
    tokenCalls = 0;
    dispatches = [];
    mockFetch();
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS;
    delete process.env.HEALTHCHECK_STAGGER_MS;
    if (originalRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
    else process.env.REQUIRE_API_KEY = originalRequireApiKey;
    await core.resetDbInstance();
  });

  for (const enabled of [true, false]) {
    for (const stream of [false, true]) {
      for (const proactive of [true, false]) {
        test(`chat ${proactive ? "proactive expiry" : "reactive authentication"} avoids token exchange only when passive=${enabled} stream=${stream}`, async () => {
          passive = enabled;
          if (!enabled) delete process.env.OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS;
          const c = await connection(proactive ? 30 : 3600);
          const response = await chat(stream);
          await response.text();
          assert.equal(response.status, 401);
          if (enabled) {
            assert.equal(tokenCalls, 0);
            assert.deepEqual(dispatches, ["Bearer synthetic-access"]);
            const row = await nonterminal(c.id);
            assert.ok(
              Date.parse(row.rateLimitedUntil) > Date.now(),
              "upstream 401 retains cooldown"
            );
            assert.equal(row.providerSpecificData.apiKeyHealth.primary.failures, 1);
          } else {
            assert.ok(tokenCalls > 0, "active control reaches the real refresher");
          }
        });
      }
    }
    for (const entry of [
      "usage",
      "health sweep",
      "import",
      "manual",
      "connection test",
      "reset credits",
      "wrapper",
      "generic",
    ] as const) {
      test(`${entry} avoids Codex token exchange only when passive=${enabled}`, async () => {
        passive = enabled;
        if (!enabled) delete process.env.OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS;
        const c = await connection(30);
        if (entry === "usage") {
          await fetchAndPersistProviderLimits(c.id, "manual", { allowRotatingRefresh: true });
        } else if (entry === "health sweep") {
          assert.equal(await health.sweep(), 1);
        } else if (entry === "import") {
          const response = await importer.POST(
            request("/api/oauth/codex/import", {
              accounts: {
                access_token: "synthetic-import-access",
                refresh_token: "synthetic-import-refresh",
                email: "synthetic-import@example.invalid",
              },
            })
          );
          const body = await response.json();
          assert.equal(body.imported, enabled ? 1 : 0);
          if (enabled) {
            const imported = (await db.getProviderConnections({ provider: "codex" })).find(
              (r) => r.email === "synthetic-import@example.invalid"
            );
            assert.equal(imported.accessToken, "synthetic-import-access");
            assert.equal(imported.refreshToken, "synthetic-import-refresh");
          }
        } else if (entry === "manual") {
          const response = await manual.POST(request(`/api/providers/${c.id}/refresh`, {}), {
            params: Promise.resolve({ id: c.id }),
          });
          const body = await response.json();
          assert.equal(response.status, enabled ? 409 : 200);
          if (enabled) {
            assert.equal(body.code, "refresh_disabled");
            assert.match(body.error, /passive.*codex|codex.*passive/i);
          } else {
            assert.equal(body.skipped, true);
          }
        } else if (entry === "connection test") {
          await probe.testOAuthConnection(c);
        } else if (entry === "reset credits") {
          await assert.rejects(listCodexResetCredits(c.id));
        } else if (entry === "wrapper") {
          await wrappers.refreshCodexToken(c.refreshToken, { ...c, connectionId: c.id });
        } else {
          await tokens.refreshAccessToken(
            "codex",
            c.refreshToken,
            { ...c, connectionId: c.id },
            quiet
          );
        }
        if (enabled || entry === "manual") assert.equal(tokenCalls, 0);
        else
          assert.ok(
            tokenCalls > 0,
            "active control reaches the token endpoint where base refreshes"
          );
        if (enabled) await nonterminal(c.id);
      });
    }
  }

  for (const stream of [false, true]) {
    for (const stored of ["different", "unchanged", "expired"] as const) {
      test(`reactive retry uses a different unexpired synchronized token exactly once: ${stored} stream=${stream}`, async () => {
        const c = await connection();
        mockFetch(async () => {
          if (dispatches.length === 1)
            await db.updateProviderConnection(c.id, {
              accessToken: stored === "unchanged" ? c.accessToken : "synthetic-synchronized",
              expiresAt: new Date(
                Date.now() + (stored === "expired" ? -60000 : 3600000)
              ).toISOString(),
            });
        });
        const response = await chat(stream);
        await response.text();
        assert.equal(response.status, 401);
        assert.deepEqual(
          dispatches,
          stored === "different"
            ? ["Bearer synthetic-access", "Bearer synthetic-synchronized"]
            : ["Bearer synthetic-access"]
        );
        assert.equal(tokenCalls, 0);
        await nonterminal(c.id);
      });
    }
  }

  for (const stream of [false, true]) {
    test(`authentication rollback never dispatches a rejected token twice stream=${stream}`, async () => {
      const c = await connection();
      mockFetch(async () => {
        await db.updateProviderConnection(c.id, {
          accessToken: dispatches.length === 1 ? "synthetic-synchronized" : c.accessToken,
        });
      });
      const response = await chat(stream);
      await response.text();
      assert.equal(response.status, 401);
      assert.deepEqual(dispatches, ["Bearer synthetic-access", "Bearer synthetic-synchronized"]);
      assert.equal(new Set(dispatches).size, dispatches.length);
      const row = await nonterminal(c.id);
      assert.equal(row.providerSpecificData.apiKeyHealth.primary.failures, 2);
      assert.ok(Date.parse(row.rateLimitedUntil) > Date.now());
      assert.equal(tokenCalls, 0);
    });
  }

  test("rejected token fingerprints are bounded to the newest four and isolated by request", async () => {
    const helper = await import("../../../open-sse/services/tokenRefresh/passiveCodex.ts");
    assert.equal("getAllRejectedTokens" in helper, false);
    assert.equal("rejectedTokens" in helper, false);
    assert.deepEqual(
      Object.keys(helper).sort(),
      [
        "PASSIVE_CODEX_IDS",
        "PASSIVE_REFRESH_ENV",
        "PASSIVE_REFRESH_MESSAGE",
        "adoptPassiveCodex",
        "getRejectedTokenFingerprints",
        "isPassiveCodex",
        "parsePassiveProviders",
        "passiveProvidersError",
        "recordRejectedToken",
        "resolvePassiveCodex",
      ].sort()
    );
    const c = await connection();
    const first = { ...c, connectionId: c.id };
    assert.deepEqual(helper.getRejectedTokenFingerprints(first), []);
    const rejected: string[] = [];
    for (let i = 0; i < 9; i++) {
      first.accessToken = `synthetic-rejected-access-${i}`;
      rejected.push(first.accessToken);
      helper.recordRejectedToken(first);
      const fingerprints = helper.getRejectedTokenFingerprints(first);
      assert.equal(fingerprints.length, Math.min(i + 1, 4));
      for (const fp of fingerprints) {
        assert.match(fp, /^[a-f0-9]{64}$/);
        for (const token of rejected) assert.equal(fp.includes(token), false);
      }
    }
    const { createHash } = await import("node:crypto");
    assert.deepEqual(
      helper.getRejectedTokenFingerprints(first),
      rejected.slice(-4).map((token) => createHash("sha256").update(token).digest("hex"))
    );
    const snapshot = helper.getRejectedTokenFingerprints(first);
    snapshot.length = 0;
    assert.equal(helper.getRejectedTokenFingerprints(first).length, 4);
    await db.updateProviderConnection(c.id, { accessToken: rejected.at(-1) });
    first.accessToken = "synthetic-current";
    assert.equal((await helper.resolvePassiveCodex(first)).error, "refresh_disabled");
    const second = { ...c, connectionId: c.id };
    assert.deepEqual(helper.getRejectedTokenFingerprints(second), []);
    assert.equal((await helper.resolvePassiveCodex(second)).accessToken, rejected.at(-1));
  });

  test("active authentication recovery never invokes passive credential helpers", async () => {
    delete process.env.OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS;
    passive = false;
    const c = await connection(30);
    const { default: cryptoModule } = await import("node:crypto");
    const { syncBuiltinESMExports } = await import("node:module");
    const createHash = cryptoModule.createHash;
    let helperCalls = 0;
    cryptoModule.createHash = (...args: Parameters<typeof createHash>) => {
      if (new Error().stack?.includes("passiveCodex")) helperCalls++;
      return createHash(...args);
    };
    syncBuiltinESMExports();
    const restoreSql = spyOnSql(() => {
      if (new Error().stack?.includes("resolvePassiveCodex")) helperCalls++;
    });
    try {
      const helper = await import("../../../open-sse/services/tokenRefresh/passiveCodex.ts");
      helper.recordRejectedToken({ accessToken: "synthetic-spy-control" });
      await helper.resolvePassiveCodex({ ...c, connectionId: c.id });
      assert.ok(helperCalls > 0, "spies detect passive helpers on copied credentials");
      helperCalls = 0;
      const result = await handleChatCore({
        body: { model: "gpt-5.5", input: "synthetic", stream: true },
        modelInfo: { provider: "codex", model: "gpt-5.5" },
        credentials: { ...c, connectionId: c.id },
        log: quiet,
        clientRawRequest: { endpoint: "/v1/responses", headers: new Headers(), body: {} },
      });
      await result.response.text();
      assert.equal(result.response.status, 401);
      assert.ok(tokenCalls > 0);
      assert.equal(helperCalls, 0);
    } finally {
      restoreSql();
      cryptoModule.createHash = createHash;
      syncBuiltinESMExports();
    }
  });

  test("shared entry points bypass cached rows, return only token fields and never persist adoption", async () => {
    const c = await connection();
    const credentials = {
      ...c,
      connectionId: c.id,
      providerSpecificData: {
        _omnirouteCodexThinking: {
          supportedThinkingEfforts: ["low"],
          defaultThinkingEffort: "low",
        },
        workspaceId: "synthetic-local-workspace",
      },
    };
    await cache.getCachedProviderConnectionById(c.id);
    await db.updateProviderConnection(c.id, { accessToken: "synthetic-synchronized" });
    let writes = 0;
    const restoreSql = spyOnSql((sql) => {
      if (/^\s*UPDATE provider_connections/i.test(sql)) writes++;
    });
    let persists = 0;
    try {
      for (const provider of ["codex", "cx"]) {
        const result = await tokens.getAccessToken(provider, credentials, quiet, null, async () => {
          persists++;
        });
        assert.equal(result.accessToken, "synthetic-synchronized");
        assert.deepEqual(
          Object.keys(result).sort(),
          ["accessToken", "expiresAt", "idToken", "refreshToken", "tokenExpiresAt"].sort()
        );
        assert.deepEqual(
          { ...credentials, ...result }.providerSpecificData,
          credentials.providerSpecificData
        );
      }
      assert.equal(persists, 0);
      assert.equal(writes, 0);
    } finally {
      restoreSql();
    }
  });

  test("shared refresh without a connection or a new usable token returns non-terminal refresh_disabled", async () => {
    const c = await connection();
    const current = { ...c, connectionId: c.id };
    for (const creds of [
      current,
      { refreshToken: "synthetic-refresh" },
      { connectionId: "synthetic-missing" },
    ]) {
      const result = await tokens.getAccessToken("codex", creds, quiet);
      assert.equal(result.error, "refresh_disabled");
      assert.equal(tokens.isUnrecoverableRefreshError(result), false);
    }
    for (let i = 0; i < 8; i++) {
      await tokens.refreshWithRetry(
        () => tokens.getAccessToken("codex", current, quiet),
        1,
        quiet,
        "codex"
      );
    }
    await nonterminal(c.id);
    assert.equal(tokenCalls, 0);
  });

  test("adoption during chatCore recovery preserves request-local metadata without writing credentials", async () => {
    const c = await connection();
    const localData = {
      _omnirouteCodexThinking: { supportedThinkingEfforts: ["low"], defaultThinkingEffort: "low" },
      workspaceId: "synthetic-local-workspace",
    };
    let callbacks = 0;
    mockFetch(async () => {
      if (dispatches.length === 1)
        await db.updateProviderConnection(c.id, { accessToken: "synthetic-synchronized" });
    });
    const credentials = { ...c, connectionId: c.id, providerSpecificData: localData };
    const result = await handleChatCore({
      body: { model: "gpt-5.5", input: "synthetic", stream: false },
      modelInfo: { provider: "codex", model: "gpt-5.5" },
      credentials,
      log: quiet,
      clientRawRequest: { endpoint: "/v1/responses", headers: new Headers(), body: {} },
      onCredentialsRefreshed: async () => {
        callbacks++;
      },
    });
    await result.response.text();
    assert.deepEqual(dispatches, ["Bearer synthetic-access", "Bearer synthetic-synchronized"]);
    assert.deepEqual(credentials.providerSpecificData, localData);
    assert.equal(callbacks, 0);
  });

  test("passive authentication failures retain exponential cooldown and deactivation stays permanent", async () => {
    const c = await connection(-60);
    const now = Date.now;
    let clock = now();
    Date.now = () => clock;
    try {
      for (const expected of [5000, 10000, 20000, 40000, 80000, 120000, 120000]) {
        await markAccountUnavailable(c.id, 401, "synthetic invalid token", "codex", "gpt-5.5");
        const row = await nonterminal(c.id);
        const cooldown = Date.parse(row.rateLimitedUntil) - clock;
        assert.equal(cooldown, expected);
        clock += expected + 1000;
      }
      await markAccountUnavailable(
        c.id,
        401,
        "Your account has been deactivated",
        "codex",
        "gpt-5.5",
        undefined,
        { structuredError: { code: "account_deactivated" } }
      );
      const row = await db.getProviderConnectionById(c.id);
      assert.equal(row.lastErrorType, "account_deactivated");
      assert.equal(row.rateLimitedUntil ?? null, null);
      assert.ok(
        ["banned", "deactivated"].includes(String(row.testStatus)),
        "deactivation is a permanent lock"
      );
    } finally {
      Date.now = now;
    }
  });

  for (const stream of [false, true]) {
    test(`proactive adoption records the token actually dispatched so recovery cannot resend it stream=${stream}`, async () => {
      const c = await connection(30);
      await db.updateProviderConnection(c.id, { accessToken: "synthetic-synchronized" });
      const credentials = { ...c, connectionId: c.id };
      let persists = 0;
      const result = await handleChatCore({
        body: { model: "gpt-5.5", input: "synthetic", stream },
        modelInfo: { provider: "codex", model: "gpt-5.5" },
        credentials,
        log: quiet,
        onCredentialsRefreshed: async () => {
          persists++;
        },
        clientRawRequest: { endpoint: "/v1/responses", headers: new Headers(), body: {} },
      });
      await result.response.text();
      assert.equal(result.response.status, 401);
      assert.deepEqual(dispatches, ["Bearer synthetic-synchronized"]);
      assert.equal(credentials.accessToken, "synthetic-synchronized");
      assert.equal(persists, 0);
      assert.equal(tokenCalls, 0);
    });
  }

  test("passive gate logs never include token values or prefixes even when reread fails", async () => {
    const c = await connection();
    const lines: unknown[][] = [];
    const log = {
      info: (...args: unknown[]) => lines.push(args),
      warn: (...args: unknown[]) => lines.push(args),
      error: (...args: unknown[]) => lines.push(args),
    };
    await tokens.getAccessToken("codex", { ...c, connectionId: c.id }, log);
    await tokens.getAccessToken(
      "codex",
      { connectionId: "synthetic-missing", refreshToken: c.refreshToken },
      log
    );
    const debug = console.debug;
    console.debug = (...args: unknown[]) => {
      lines.push(args);
    };
    const restoreSql = spyOnSql((sql, params) => {
      if (/FROM provider_connections\b/.test(sql) && params?.includes(c.id)) {
        throw new Error(`synthetic database failure ${c.accessToken}`);
      }
    });
    try {
      assert.equal(
        (await tokens.getAccessToken("codex", { ...c, connectionId: c.id }, log)).error,
        "refresh_disabled"
      );
    } finally {
      restoreSql();
      console.debug = debug;
    }
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], [
      "[TOKEN_REFRESH]",
      { provider: "codex", connectionId: c.id, reason: "reread failed" },
    ]);
    const text = JSON.stringify(lines);
    for (const material of [
      c.accessToken,
      c.refreshToken,
      c.idToken,
      "synthetic-ac",
      "synthetic-ref",
    ])
      assert.equal(text.includes(material), false);
  });

  test("startup accepts only Codex identities for passive refresh", () => {
    for (const value of ["codex", " CX, codex, ", ""]) {
      const result = validateWebRuntimeEnv({ OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS: value });
      assert.equal(
        result.errors.some((e) => e.name === "OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS"),
        false
      );
    }
    const result = validateWebRuntimeEnv({ OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS: "openai" });
    assert.equal(
      result.errors.some((e) => e.name === "OMNIROUTE_TOKEN_REFRESH_PASSIVE_PROVIDERS"),
      true
    );
  });

  test("other providers retain refresh behaviour while Codex is passive", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ access_token: "synthetic-google-access", expires_in: 3600 });
    };
    const result = await tokens.getAccessToken(
      "gemini",
      { refreshToken: "synthetic-google-refresh" },
      quiet
    );
    assert.equal(result.accessToken, "synthetic-google-access");
    assert.equal(calls, 1);
  });
});
