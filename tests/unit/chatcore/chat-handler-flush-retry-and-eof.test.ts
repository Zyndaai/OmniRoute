// handleChat flush empty-turn retry hook and early-EOF sibling failover.
// Split from one merged file so these timer-heavy suites run in parallel; each `describe` is
// one former file. Load-time env: DATA_DIR, REQUIRE_API_KEY, STREAM_READINESS_TIMEOUT_MS=1000.
// Feature flags read at request time are set and restored inside each describe.
import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chat-handler-empty-turn-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.REQUIRE_API_KEY = "false";
process.env.DASHBOARD_PASSWORD = "";
process.env.INITIAL_PASSWORD = "";
delete process.env.JWT_SECRET;
if (!process.env.API_KEY_SECRET) {
  process.env.API_KEY_SECRET = `test-chat-handler-empty-turn-${Date.now()}`;
}
process.env.STREAM_READINESS_TIMEOUT_MS = "1000";

const { resetTestDb } = await import("../../helpers/postgres.ts");
const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const leaseDb = await import("../../../src/lib/db/exclusiveConnectionLeases.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const { handleChat } = await import("../../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../../open-sse/translator/index.ts");
const { clearInflight } = await import("../../../open-sse/services/requestDedup.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");

const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  clearInflight();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("flush-empty-retry-hook", () => {
  // Hook-level tests for the flush empty-turn retry (translate-path streams).
  //
  // A Gemini upstream speaks a non-OpenAI format, so the OpenAI-speaking client
  // path always goes through the translate transform — the hook's
  // `isTranslatePath` gate is armed. Two Gemini accounts isolate rotation:
  // the first serves an empty turn, the second serves content.
  const FLAG = "FLUSH_EMPTY_RETRY_ENABLED";
  const ORIGINAL_FLAG = process.env[FLAG];

  function setFlag(enabled: boolean) {
    if (enabled) process.env[FLAG] = "true";
    else delete process.env[FLAG];
  }

  async function resetStorage() {
    clearInflight();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    resetAllCircuitBreakers();
    initTranslators();
  }

  async function seedGemini(name: string, apiKey: string) {
    const row = (await providersDb.createProviderConnection({
      provider: "gemini",
      authType: "apikey",
      name,
      apiKey,
      isActive: true,
      testStatus: "active",
    })) as { id: string };
    return { id: row.id, apiKey };
  }

  // Anonymized replay of the 19/09 reasoning-only payload shape: 74 tokens of
  // thinking text (native thought part), empty message text, terminal stop.
  function reasoningOnlyStreamResponse(): Response {
    const thinking = "r".repeat(74);
    return new Response(
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: thinking, thought: true }] } }],
      })}\n\ndata: ${JSON.stringify({
        candidates: [{ finishReason: "STOP" }],
      })}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  // Anonymized replay of the 19/09 zero-chunk payload shape: no candidates at
  // all (the upstream turn emitted nothing translatable).
  function zeroChunkStreamResponse(): Response {
    return new Response(
      `data: ${JSON.stringify({ candidates: [] })}\n\n` +
        `data: ${JSON.stringify({ candidates: [] })}\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  // The upstream sent a first frame with nothing usable in it, then the
  // connection dropped (undici surfaces this as a TypeError "terminated" on the
  // body). The first frame lets the stream readiness gate pass, so the failure
  // happens while the flush hook is buffering the turn.
  function droppedStreamResponse(): Response {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [] })}\n\n`)
          );
          return;
        }
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  function contentStreamResponse(text: string): Response {
    return new Response(
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
      })}\n\ndata: ${JSON.stringify({
        candidates: [{ finishReason: "STOP" }],
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  function streamRequest(extraHeaders: Record<string, string> = {}) {
    const nonce = `flush-empty-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: "gemini/gemini-2.5-flash",
        messages: [{ role: "user", content: `Reply with OK only. ${nonce}` }],
        max_tokens: 64,
        stream: true,
        temperature: 0,
      }),
    });
  }

  function stubFetch(dispatches: string[], handler: (auth: string, callIndex: number) => Response) {
    globalThis.fetch = (async (_url: unknown, init: { headers?: unknown }) => {
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      const auth = headers.get("authorization") ?? headers.get("x-goog-api-key") ?? "";
      const callIndex = dispatches.length;
      dispatches.push(auth);
      return handler(auth, callIndex);
    }) as typeof fetch;
  }

  async function drainText(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    return text;
  }

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    setFlag(true);
    await resetStorage();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    globalThis.fetch = originalFetch;
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
    else process.env[FLAG] = ORIGINAL_FLAG;
    await resetStorage();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await core.resetDbInstance();
  });

  test("flag off: empty reasoning-only turn exposes current behavior with zero retry", async () => {
    setFlag(false);
    await seedGemini("gemini-off-a", "sk-flush-off-a");
    await seedGemini("gemini-off-b", "sk-flush-off-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, () => reasoningOnlyStreamResponse());
    const response = await handleChat(streamRequest());
    await drainText(response);
    assert.equal(
      dispatches.length,
      1,
      `flag off must issue exactly 1 dispatch, got ${dispatches.length}`
    );
  });

  test("reasoning-only turn retries once through the normal credential path and serves content", async () => {
    await seedGemini("gemini-empty-a", "sk-flush-empty-a");
    await seedGemini("gemini-content-b", "sk-flush-content-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? reasoningOnlyStreamResponse() : contentStreamResponse("served-after-retry")
    );
    const response = await handleChat(streamRequest());
    const bodyText = await drainText(response);
    assert.equal(dispatches.length, 2, `expected initial + 1 retry, got ${dispatches.length}`);
    assert.match(bodyText, /served-after-retry/, "client must receive the retry content");
  });

  test("persistent empty turns exhaust the budget with exactly 5 dispatches", async () => {
    await seedGemini("gemini-empty2-a", "sk-flush-empty2-a");
    await seedGemini("gemini-empty2-b", "sk-flush-empty2-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, () => zeroChunkStreamResponse());
    const response = await handleChat(streamRequest());
    await drainText(response);
    assert.equal(
      dispatches.length,
      5,
      `budget 4 means 1 initial + 4 retries, got ${dispatches.length}`
    );
  });

  test("single slot retries the same account and serves content", async () => {
    await seedGemini("gemini-lone", "sk-flush-lone");
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? reasoningOnlyStreamResponse() : contentStreamResponse("served-after-retry")
    );
    const response = await handleChat(streamRequest());
    const bodyText = await drainText(response);
    assert.equal(
      dispatches.length,
      2,
      `single slot replays the same account, got ${dispatches.length}`
    );
    assert.match(bodyText, /served-after-retry/, "client must receive the retry content");
  });

  test("a stream that drops before anything reaches the client retries and serves content", async () => {
    await seedGemini("gemini-drop-a", "sk-flush-drop-a");
    await seedGemini("gemini-drop-b", "sk-flush-drop-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? droppedStreamResponse() : contentStreamResponse("served-after-drop")
    );
    const response = await handleChat(streamRequest());
    const bodyText = await drainText(response);
    assert.equal(dispatches.length, 2, `expected initial + 1 retry, got ${dispatches.length}`);
    assert.match(bodyText, /served-after-drop/, "client must receive the retry content");
  });

  test("persistent stream drops exhaust the same budget as empty turns", async () => {
    await seedGemini("gemini-drop2-a", "sk-flush-drop2-a");
    await seedGemini("gemini-drop2-b", "sk-flush-drop2-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, () => droppedStreamResponse());
    const response = await handleChat(streamRequest());
    await drainText(response);
    assert.equal(
      dispatches.length,
      5,
      `budget 4 means 1 initial + 4 retries, got ${dispatches.length}`
    );
  });

  test("flag off: a dropped stream is not retried", async () => {
    setFlag(false);
    await seedGemini("gemini-drop3-a", "sk-flush-drop3-a");
    await seedGemini("gemini-drop3-b", "sk-flush-drop3-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, () => droppedStreamResponse());
    const response = await handleChat(streamRequest());
    await drainText(response);
    assert.equal(
      dispatches.length,
      1,
      `flag off must issue exactly 1 dispatch, got ${dispatches.length}`
    );
  });

  test("the retry moves off the connection that returned the empty turn", async () => {
    await seedGemini("gemini-move-a", "sk-flush-move-a");
    await seedGemini("gemini-move-b", "sk-flush-move-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? reasoningOnlyStreamResponse() : contentStreamResponse("served-after-retry")
    );
    const response = await handleChat(streamRequest());
    const bodyText = await drainText(response);
    assert.equal(dispatches.length, 2, `expected initial + 1 retry, got ${dispatches.length}`);
    assert.notEqual(dispatches[1], dispatches[0], "the retry must not replay the empty connection");
    assert.match(bodyText, /served-after-retry/, "client must receive the retry content");
  });

  test("a failed retry logs the call against the connection that served it", async () => {
    // Round-robin with a sticky limit of 1 rotates on every pick, so the retry
    // lands on the other account even without an explicit exclusion.
    await settingsDb.updateSettings({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    const served = await seedGemini("gemini-kept-a", "sk-flush-kept-a");
    const other = await seedGemini("gemini-kept-b", "sk-flush-kept-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0
        ? reasoningOnlyStreamResponse()
        : new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 500 })
    );
    const response = await handleChat(streamRequest());
    await drainText(response);
    assert.deepEqual(dispatches, [served.apiKey, other.apiKey]);
    await callLogs.waitForCallLogSaves(2000);
    const logged = (await callLogs.getCallLogs({})) as Array<{ connectionId?: string | null }>;
    assert.equal(logged.length, 1, `expected one call log, got ${logged.length}`);
    assert.equal(
      logged[0].connectionId,
      served.id,
      "the kept response came from the first account, not the failed retry"
    );
  });

  test("the retry stays inside the key's connection allowlist", async () => {
    // Seeded first, so fill-first would pick it for an unrestricted selection.
    await seedGemini("gemini-outside", "sk-flush-outside");
    const first = await seedGemini("gemini-allowed-a", "sk-flush-allowed-a");
    const second = await seedGemini("gemini-allowed-b", "sk-flush-allowed-b");
    const key = await apiKeysDb.createApiKey("allowlisted-flush", "test", [], {
      allowedConnections: [first.id, second.id],
    });
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? reasoningOnlyStreamResponse() : contentStreamResponse("served-after-retry")
    );
    const response = await handleChat(streamRequest({ Authorization: `Bearer ${key.key}` }));
    const bodyText = await drainText(response);
    assert.deepEqual(dispatches, [first.apiKey, second.apiKey]);
    assert.match(bodyText, /served-after-retry/, "client must receive the retry content");
  });

  test("a pinned connection replays itself instead of rotating", async () => {
    await seedGemini("gemini-pin-a", "sk-flush-pin-a");
    const pinned = await seedGemini("gemini-pin-b", "sk-flush-pin-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? reasoningOnlyStreamResponse() : contentStreamResponse("served-after-retry")
    );
    const response = await handleChat(streamRequest({ "x-omniroute-connection": pinned.id }));
    const bodyText = await drainText(response);
    assert.deepEqual(dispatches, [pinned.apiKey, pinned.apiKey]);
    assert.match(bodyText, /served-after-retry/, "client must receive the retry content");
  });

  test("a managed lease replays the leased connection instead of rotating", async () => {
    const owner = `vlo_${"E".repeat(43)}`;
    await seedGemini("gemini-lease-a", "sk-flush-lease-a");
    const leased = await seedGemini("gemini-lease-b", "sk-flush-lease-b");
    const key = await apiKeysDb.createApiKey("managed-flush", "test", ["lease:exclusive"], {
      allowedConnections: [leased.id],
    });
    const acquired = await leaseDb.acquireExclusiveConnectionLease({
      leaseOwnerId: owner,
      apiKeyId: key.id,
      provider: "gemini",
      connectionId: leased.id,
    });
    assert.equal(acquired.kind, "ACQUIRED");
    if (acquired.kind !== "ACQUIRED") return;
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? reasoningOnlyStreamResponse() : contentStreamResponse("served-after-retry")
    );
    const response = await handleChat(
      streamRequest({
        Authorization: `Bearer ${key.key}`,
        "X-OmniRoute-Lease-Owner": owner,
        "X-OmniRoute-Lease-Generation": String(acquired.lease.generation),
      })
    );
    const bodyText = await drainText(response);
    assert.deepEqual(dispatches, [leased.apiKey, leased.apiKey]);
    assert.match(bodyText, /served-after-retry/, "client must receive the retry content");
  });

  // ---------------------------------------------------------------------------
  // #17461: direct (non-translated) openai→openai turns.
  //
  // The hook used to be armed for translate-path streams only, so a direct
  // openai→openai turn — the shape most degenerate turns arrive in — never
  // reached the retry loop, and a turn whose whole output was draft/system-echo
  // markup was classified as a normal turn.
  // ---------------------------------------------------------------------------

  async function seedGroq(name: string, apiKey: string) {
    const row = (await providersDb.createProviderConnection({
      provider: "groq",
      authType: "apikey",
      name,
      apiKey,
      isActive: true,
      testStatus: "active",
    })) as { id: string };
    return { id: row.id, apiKey };
  }

  // A direct openai→openai turn whose entire content is draft/system-echo
  // markup: nothing usable reaches the client, which strips the tags and is
  // left with an empty turn.
  function draftOnlyOpenAiStreamResponse(): Response {
    return new Response(
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "<summary>draft skeleton</summary>\n<analysis>draft skeleton</analysis>",
            },
          },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n` +
        `data: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  function contentOpenAiStreamResponse(text: string): Response {
    return new Response(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      })}\n\n` +
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n` +
        `data: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  function openAiStreamRequest() {
    const nonce = `flush-empty-retry-openai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: "groq/openai/gpt-oss-20b",
        messages: [{ role: "user", content: `Reply with OK only. ${nonce}` }],
        max_tokens: 64,
        stream: true,
        temperature: 0,
      }),
    });
  }

  test("direct openai→openai: a draft-only turn retries on a sibling and serves content (#17461)", async () => {
    await seedGroq("groq-draft-a", "sk-flush-draft-a");
    await seedGroq("groq-content-b", "sk-flush-content-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0
        ? draftOnlyOpenAiStreamResponse()
        : contentOpenAiStreamResponse("served-after-retry")
    );
    const response = await handleChat(openAiStreamRequest());
    const bodyText = await drainText(response);
    assert.equal(dispatches.length, 2, `expected initial + 1 retry, got ${dispatches.length}`);
    assert.match(bodyText, /served-after-retry/, "client must receive the retry content");
  });

  test("direct openai→openai: a real answer is served without a retry (#17461)", async () => {
    await seedGroq("groq-real-a", "sk-flush-real-a");
    await seedGroq("groq-real-b", "sk-flush-real-b");
    const dispatches: string[] = [];
    stubFetch(dispatches, () => contentOpenAiStreamResponse("answered-once"));
    const response = await handleChat(openAiStreamRequest());
    const bodyText = await drainText(response);
    assert.equal(
      dispatches.length,
      1,
      `a real answer must not be retried, got ${dispatches.length}`
    );
    assert.match(bodyText, /answered-once/, "client must receive the answer");
  });
});

describe("chat-stream-early-eof-failover", () => {
  // Stream early EOF sibling failover (direct single-model path, #13153).
  //
  // When the upstream opens an SSE stream but closes it before emitting any
  // useful frame, the readiness gate surfaces 502 STREAM_EARLY_EOF. The bounded
  // same-connection retry (#3758) makes one plain re-attempt. With
  // STREAM_EARLY_EOF_SIBLING_FAILOVER_ENABLED on, once that retry is spent the
  // request makes exactly ONE hop to a sibling connection; if no sibling can serve
  // it, the ORIGINAL STREAM_EARLY_EOF 502 is surfaced unchanged so combo-level
  // detection (isStreamEarlyEofErrorBody) keeps working. No account is ever marked
  // unavailable for an early close, and readiness timeout retry remains direct-only and
  // bounded. With the flag off (the default) the early-EOF release behavior is unchanged.
  //
  // These cases drive handleChat() directly rather than the /v1/chat/completions
  // route: the route wraps streaming requests in withEarlyStreamKeepalive, which
  // commits a synthetic 200 SSE response (dropping the handler's status and
  // headers) whenever the handler takes longer than 2 s — a cold first request or
  // a loaded machine is enough, and the failover assertions would then observe the
  // keepalive wrapper instead of the failover.

  async function flushBackgroundWork() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function resetStorage() {
    clearInflight();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    resetAllCircuitBreakers();
    initTranslators();
  }

  type SeededConnection = { id: string; apiKey: string };

  async function seedConnection(name: string, apiKey: string): Promise<SeededConnection> {
    const row = (await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name,
      apiKey,
      isActive: true,
      testStatus: "active",
    })) as { id: string };
    return { id: row.id, apiKey };
  }

  // An SSE body that closes with zero non-ping frames: the exact input shape
  // the readiness gate turns into 502 STREAM_EARLY_EOF.
  function pingOnlyStreamResponse(): Response {
    return new Response(`: keepalive\n\ndata: ${JSON.stringify({ type: "ping" })}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // An SSE body that stays open without a useful frame: STREAM_READINESS_TIMEOUT.
  function stalledStreamResponse(): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  function successStreamResponse(content: string): Response {
    return new Response(
      `data: ${JSON.stringify({
        id: "chatcmpl-early-eof-failover",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      })}\n\ndata: ${JSON.stringify({
        id: "chatcmpl-early-eof-failover",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  function unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request" } }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  function streamRequest(extraHeaders: Record<string, string> = {}) {
    // A per-request nonce keeps the semantic cache and request dedup out of the way.
    const nonce = `early-eof-failover-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: "openai/gpt-4.1",
        messages: [{ role: "user", content: `Reply with OK only. ${nonce}` }],
        max_tokens: 16,
        stream: true,
        temperature: 0,
      }),
    });
  }

  // Every outbound fetch carries the connection's own credential, so the stub
  // attributes each dispatch to a connection by its Authorization header.
  function stubFetch(dispatches: string[], handler: (auth: string, callIndex: number) => Response) {
    globalThis.fetch = (async (_url: unknown, init: { headers?: unknown }) => {
      const headers = new Headers((init?.headers ?? {}) as HeadersInit);
      const auth = headers.get("authorization") ?? "";
      const callIndex = dispatches.length;
      dispatches.push(auth);
      return handler(auth, callIndex);
    }) as typeof fetch;
  }

  function authOf(connection: SeededConnection): string {
    return `Bearer ${connection.apiKey}`;
  }

  function errorCodeOf(bodyText: string): string | undefined {
    try {
      return (JSON.parse(bodyText) as { error?: { code?: string } })?.error?.code;
    } catch {
      return undefined;
    }
  }

  async function assertNotMarked(connection: SeededConnection, label: string) {
    const row = (await providersDb.getProviderConnectionById(connection.id)) as Record<
      string,
      unknown
    > | null;
    assert.ok(row, `the ${label} connection must still exist`);
    const until = (row.rateLimitedUntil as string | null | undefined) ?? null;
    assert.ok(
      until === null || new Date(String(until)).getTime() <= Date.now(),
      `expected no cooldown on the ${label} connection, got rateLimitedUntil=${until}`
    );
    assert.notEqual(
      row.testStatus,
      "unavailable",
      `the ${label} connection must not be unavailable`
    );
  }

  const SIBLING_FAILOVER_FLAG = "STREAM_EARLY_EOF_SIBLING_FAILOVER_ENABLED";
  const ORIGINAL_SIBLING_FAILOVER_FLAG = process.env[SIBLING_FAILOVER_FLAG];

  function setSiblingFailoverFlag(enabled: boolean) {
    if (enabled) process.env[SIBLING_FAILOVER_FLAG] = "true";
    else delete process.env[SIBLING_FAILOVER_FLAG];
  }

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    setSiblingFailoverFlag(true);
    await resetStorage();
  });

  afterEach(async () => {
    await flushBackgroundWork();
    globalThis.fetch = originalFetch;
    if (ORIGINAL_SIBLING_FAILOVER_FLAG === undefined) delete process.env[SIBLING_FAILOVER_FLAG];
    else process.env[SIBLING_FAILOVER_FLAG] = ORIGINAL_SIBLING_FAILOVER_FLAG;
  });

  after(async () => {
    await flushBackgroundWork();
    globalThis.fetch = originalFetch;
    await core.resetDbInstance();
  });

  test("flag off (default): early EOF stays terminal after the same-connection retry, nothing marked", async () => {
    setSiblingFailoverFlag(false);
    const connA = await seedConnection("openai-flagoff-a", "sk-failover-flagoff-a");
    const connB = await seedConnection("openai-flagoff-b", "sk-failover-flagoff-b");

    const dispatches: string[] = [];
    stubFetch(dispatches, () => pingOnlyStreamResponse());

    const response = await handleChat(streamRequest());
    const bodyText = await response.text();

    // 1 initial + 1 bounded same-connection retry, then the terminal 502 — no
    // sibling hop despite an eligible sibling.
    assert.equal(dispatches.length, 2, `expected 2 dispatches, got ${dispatches.length}`);
    const firstAuth = dispatches[0];
    assert.equal(dispatches[1], firstAuth, "the bounded retry stays on the same connection");
    const first = firstAuth === authOf(connA) ? connA : connB;
    assert.equal(response.status, 502, `expected 502, got ${response.status}: ${bodyText}`);
    assert.equal(errorCodeOf(bodyText), "STREAM_EARLY_EOF");
    assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), first.id);
    await assertNotMarked(connA, "first");
    await assertNotMarked(connB, "sibling");
  });

  test("flag on: fails over to the sibling after the bounded retry, without marking any account", async () => {
    const connA = await seedConnection("openai-failover-a", "sk-failover-conn-a");
    const connB = await seedConnection("openai-failover-b", "sk-failover-conn-b");

    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex < 2 ? pingOnlyStreamResponse() : successStreamResponse("OK")
    );

    const response = await handleChat(streamRequest());
    const bodyText = await response.text();

    assert.equal(dispatches.length, 3, `expected 1 + retry + sibling, got ${dispatches.length}`);
    const first = dispatches[0] === authOf(connA) ? connA : connB;
    const sibling = first === connA ? connB : connA;
    assert.equal(dispatches[1], authOf(first), "the bounded retry stays on the same connection");
    assert.equal(dispatches[2], authOf(sibling), "the spent retry must hop to the sibling");
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${bodyText}`);
    assert.equal(
      response.headers.get("X-OmniRoute-Selected-Connection-Id"),
      sibling.id,
      "the response must carry the sibling as the selected connection"
    );
    assert.match(bodyText, /OK/, "the client must receive the sibling's content");
    assert.ok(!bodyText.includes("STREAM_EARLY_EOF"), "the client must not see the early-EOF 502");
    await assertNotMarked(first, "first");
    await assertNotMarked(sibling, "sibling");
  });

  test("flag on: bounds the failover to exactly one sibling hop per request", async () => {
    const conns = [
      await seedConnection("openai-onehop-a", "sk-failover-onehop-a"),
      await seedConnection("openai-onehop-b", "sk-failover-onehop-b"),
      await seedConnection("openai-onehop-c", "sk-failover-onehop-c"),
    ];

    const dispatches: string[] = [];
    stubFetch(dispatches, () => pingOnlyStreamResponse());

    const response = await handleChat(streamRequest());
    const bodyText = await response.text();

    // 1 initial + 1 same-connection retry + 1 sibling hop. The sibling's own early
    // close is terminal: no second hop to the third connection.
    assert.equal(
      dispatches.length,
      3,
      `expected exactly one hop, got ${dispatches.length} dispatches`
    );
    assert.equal(dispatches[1], dispatches[0], "the bounded retry stays on the same connection");
    assert.notEqual(dispatches[2], dispatches[0], "the single hop must go to a sibling");
    const sibling = conns.find((conn) => authOf(conn) === dispatches[2]);
    assert.ok(sibling, "the hop must reach a seeded sibling");
    assert.equal(response.status, 502, `expected 502, got ${response.status}: ${bodyText}`);
    assert.equal(errorCodeOf(bodyText), "STREAM_EARLY_EOF", "the terminal body keeps its code");
    assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), sibling.id);
    for (const conn of conns) await assertNotMarked(conn, conn.id);
  });

  test("flag on: a singleton pool surfaces the original STREAM_EARLY_EOF 502", async () => {
    const conn = await seedConnection("openai-singleton", "sk-failover-singleton");

    const dispatches: string[] = [];
    stubFetch(dispatches, () => pingOnlyStreamResponse());

    const response = await handleChat(streamRequest());
    const bodyText = await response.text();

    assert.equal(dispatches.length, 2, `expected 2 dispatches, got ${dispatches.length}`);
    assert.equal(response.status, 502, `expected 502, got ${response.status}: ${bodyText}`);
    assert.equal(
      errorCodeOf(bodyText),
      "STREAM_EARLY_EOF",
      `the original early-EOF body must survive an empty sibling pool: ${bodyText}`
    );
    assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), conn.id);
    await assertNotMarked(conn, "singleton");
  });

  test("flag on: a sibling that fails for another reason surfaces the original early-EOF 502", async () => {
    const connA = await seedConnection("openai-sibfail-a", "sk-failover-sibfail-a");
    const connB = await seedConnection("openai-sibfail-b", "sk-failover-sibfail-b");

    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex < 2 ? pingOnlyStreamResponse() : unauthorizedResponse()
    );

    const response = await handleChat(streamRequest());
    const bodyText = await response.text();

    const first = dispatches[0] === authOf(connA) ? connA : connB;
    const sibling = first === connA ? connB : connA;
    assert.equal(dispatches.length, 3, `expected 1 + retry + sibling, got ${dispatches.length}`);
    assert.equal(dispatches[2], authOf(sibling));
    assert.equal(response.status, 502, `expected 502, got ${response.status}: ${bodyText}`);
    assert.equal(errorCodeOf(bodyText), "STREAM_EARLY_EOF", `unexpected body: ${bodyText}`);
    assert.equal(response.headers.get("X-OmniRoute-Selected-Connection-Id"), first.id);
    await assertNotMarked(first, "first");
  });

  test("flag on: a forced connection never hops to a sibling", async () => {
    const connA = await seedConnection("openai-forced-a", "sk-failover-forced-a");
    await seedConnection("openai-forced-b", "sk-failover-forced-b");

    const dispatches: string[] = [];
    stubFetch(dispatches, () => pingOnlyStreamResponse());

    const response = await handleChat(streamRequest({ "x-omniroute-connection": connA.id }));
    const bodyText = await response.text();

    // A forced pin skips the same-connection retry and must never rotate.
    assert.equal(dispatches.length, 1, `expected 1 dispatch, got ${dispatches.length}`);
    assert.equal(dispatches[0], authOf(connA));
    assert.equal(response.status, 502, `expected 502, got ${response.status}: ${bodyText}`);
    assert.equal(errorCodeOf(bodyText), "STREAM_EARLY_EOF");
  });

  test("STREAM_READINESS_TIMEOUT retries once on the same connection without marking accounts", async () => {
    const connA = await seedConnection("openai-timeout-a", "sk-failover-timeout-a");
    const connB = await seedConnection("openai-timeout-b", "sk-failover-timeout-b");

    const dispatches: string[] = [];
    stubFetch(dispatches, (_auth, callIndex) =>
      callIndex === 0 ? stalledStreamResponse() : successStreamResponse("recovered")
    );

    const response = await handleChat(streamRequest());
    const bodyText = await response.text();

    assert.equal(dispatches.length, 2, `expected one retry, got ${dispatches.length}`);
    assert.equal(
      dispatches[1],
      dispatches[0],
      "the readiness retry must reuse the target connection"
    );
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${bodyText}`);
    assert.match(bodyText, /recovered/);
    await assertNotMarked(connA, "first");
    await assertNotMarked(connB, "sibling");
  });

  test("STREAM_READINESS_TIMEOUT remains bounded after the retry", async () => {
    const conn = await seedConnection("openai-timeout-bounded", "sk-failover-timeout-bounded");
    const dispatches: string[] = [];
    stubFetch(dispatches, () => stalledStreamResponse());

    const response = await handleChat(streamRequest());
    const bodyText = await response.text();

    assert.equal(dispatches.length, 2, `expected one retry, got ${dispatches.length}`);
    assert.equal(response.status, 504, `expected 504, got ${response.status}: ${bodyText}`);
    assert.equal(errorCodeOf(bodyText), "STREAM_READINESS_TIMEOUT");
    await assertNotMarked(conn, "bounded retry");
  });
});
