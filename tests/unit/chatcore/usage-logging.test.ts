// @ts-nocheck
// Usage, call-log and lifecycle-event tests around handleChatCore: call_logs ids, estimated
// usage billing, failure-path usage, stream-recovery log wiring, streamed TTFT, request
// lifecycle events. Merged from six files so the chatCore module graph loads once; each
// original file is one `describe` below, named after the file it came from. Two of the
// sources carried `// @ts-nocheck`, so the merged file does too.
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-usage-logging-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { CALL_LOG_SETTLE_TIMEOUT_MS } = await import("../../helpers/callLogSettle.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const artifacts = await import("../../../src/lib/usage/callLogArtifacts.ts");
const usageHistory = await import("../../../src/lib/usage/usageHistory.ts");
const { getDailyTotal } = await import("../../../src/domain/costRules.ts");
const { on } = await import("../../../src/lib/events/eventBus.ts");
const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");
const { persistAttemptLogs, resolveRequestLifecycleEvent } =
  await import("../../../open-sse/handlers/chatCore/attemptLogging.ts");
const { extractUsage, filterUsageForFormat, isEstimatedUsage } =
  await import("../../../open-sse/utils/usageTracking.ts");
const { extractUsageFromResponse } = await import("../../../open-sse/handlers/usageExtractor.ts");
const { STREAM_RECOVERY } = await import("../../../open-sse/config/constants.ts");

after(async () => {
  // estimated-usage-billing-guard closed the call-log saver in its own `after`; closing it
  // refuses every later save, so it happens once here, after all describes.
  await callLogs.closeCallLogSaves(5_000);
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("call-logs-id-collision", () => {
  // #14451: call_logs.id must not be a 6-char UUID prefix. Two attempts that share
  // that prefix (birthday collision, or fail-then-fallback in one handleChatCore)
  // must both land as rows. UNIQUE on an explicit durable id must retry with a
  // generated id, not swallow the row. Dashboard request.* events still pair on
  // the short live-topology token.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function baseCtx(overrides: Record<string, unknown> = {}) {
    const pendingRequestId = (overrides.pendingRequestId as string) ?? "pending-shared";
    return {
      traceId: overrides.traceId ?? pendingRequestId,
      provider: "openai",
      connectionId: "conn-1",
      model: "gpt-x",
      skillRequestId: "skill-1",
      detailedLoggingEnabled: false,
      reqLogger: null,
      pendingRequestId,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      requestedModel: "gpt-x-requested",
      credentials: { connectionId: "cred-conn" },
      startTime: Date.now(),
      body: { messages: [{ role: "user", content: "hi" }] },
      sourceFormat: "openai",
      targetFormat: "openai",
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
      tokensCompressed: 0,
      apiKeyInfo: { id: "key-1", name: "Key One" },
      noLogEnabled: false,
      ...overrides,
    } as Parameters<typeof persistAttemptLogs>[1];
  }

  async function clearCallLogs() {
    await getTestBackend().execute("DELETE FROM call_logs");
  }

  function allCallLogRows(): Promise<Array<{ id: string; status: number }>> {
    return getTestBackend().query<{ id: string; status: number }>(
      "SELECT id, status FROM call_logs ORDER BY status, id"
    );
  }

  before(async () => {
    await core.ensureDbInitialized();
  });

  after(async () => {
    await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
  });

  test("saveCallLog without an id persists a UUID primary key, not Date.now()-counter", async () => {
    await clearCallLogs();
    await callLogs.saveCallLog({
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "test-model",
      provider: "test-provider",
      duration: 1,
      tokens: { in: 1, out: 1 },
    });
    assert.equal(await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS), true);
    const rows = await allCallLogRows();
    assert.equal(rows.length, 1);
    assert.match(rows[0].id, UUID_RE);
    assert.doesNotMatch(rows[0].id, /^\d+-\d+$/);
  });

  test("two persistAttemptLogs sharing a 6-char dashboard traceId both land as rows", async () => {
    await clearCallLogs();
    const traceId = "9cfcc2";
    const lifecycleIds: string[] = [];
    const offCompleted = on("request.completed", (payload) => {
      lifecycleIds.push(payload.id);
    });
    const offFailed = on("request.failed", (payload) => {
      lifecycleIds.push(payload.id);
    });
    try {
      persistAttemptLogs({ status: 502, error: "first attempt" }, baseCtx({ traceId }));
      persistAttemptLogs({ status: 200, tokens: { input: 1, output: 2 } }, baseCtx({ traceId }));
      assert.equal(await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS), true);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const rows = await allCallLogRows();
      assert.equal(
        rows.length,
        2,
        "fail-then-success with the same 6-char traceId must not drop a row"
      );
      assert.equal(new Set(rows.map((row) => row.id)).size, 2);
      assert.deepEqual(
        rows.map((row) => row.status),
        [200, 502]
      );
      assert.ok(
        rows.every((row) => row.id !== traceId),
        "the primary key id must not be the dashboard traceId"
      );
      assert.ok(rows.every((row) => UUID_RE.test(row.id)));

      const details = await Promise.all(rows.map((row) => callLogs.getCallLogById(row.id)));
      assert.deepEqual(
        details.map((row) => row?.status).sort((a, b) => Number(a) - Number(b)),
        [200, 502]
      );
      assert.ok(
        details.every((row) => row?.detailState === "ready" && row.error !== undefined),
        "each row must still open its own artifact after both attempts persist"
      );

      assert.ok(
        lifecycleIds.includes(traceId),
        "dashboard request.completed/failed must still pair on the short traceId"
      );
    } finally {
      offCompleted();
      offFailed();
    }
  });

  test("saveCallLog retries UNIQUE on an explicit id instead of dropping the second row", async () => {
    await clearCallLogs();
    const collidingId = "durable-call-log-id-collision";
    // The primary key is (id, "timestamp"): a reused id only collides when the timestamp is
    // reused too, so both attempts carry the same one.
    const timestamp = "2026-10-06T12:00:00.000Z";
    await callLogs.saveCallLog({
      id: collidingId,
      timestamp,
      method: "POST",
      path: "/v1/chat/completions",
      status: 500,
      model: "test-model",
      provider: "test-provider",
      duration: 2,
      tokens: { in: 0, out: 0 },
      error: "first",
    });
    await callLogs.saveCallLog({
      id: collidingId,
      timestamp,
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "test-model",
      provider: "test-provider",
      duration: 3,
      tokens: { in: 2, out: 3 },
    });
    assert.equal(await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS), true);

    const rows = await allCallLogRows();
    assert.equal(rows.length, 2, "UNIQUE must not swallow the second insert");
    assert.deepEqual(
      rows.map((row) => row.status),
      [200, 500]
    );
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    assert.ok(rows.some((row) => row.id === collidingId));
    const regenerated = rows.find((row) => row.id !== collidingId);
    assert.ok(regenerated);
    assert.match(regenerated.id, UUID_RE);
  });

  test("a repeated explicit id with the same timestamp does not overwrite the first row's artifact", async () => {
    await clearCallLogs();
    const collidingId = "replayed-session-id";
    const timestamp = "2026-10-05T12:00:00.000Z";
    const base = {
      id: collidingId,
      timestamp,
      method: "POST",
      path: "/v1/responses",
      model: "test-model",
      provider: "test-provider",
      duration: 1,
      tokens: { in: 0, out: 0 },
    };
    await callLogs.saveCallLog({ ...base, status: 500, error: "first attempt detail" });
    await callLogs.saveCallLog({ ...base, status: 502, error: "second attempt detail" });
    assert.equal(await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS), true);

    const rows = await getTestBackend().query<{
      id: string;
      status: number;
      artifact_relpath: string | null;
    }>("SELECT id, status, artifact_relpath FROM call_logs ORDER BY status");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.artifact_relpath));
    assert.notEqual(
      rows[0].artifact_relpath,
      rows[1].artifact_relpath,
      "two rows must never share one artifact file"
    );

    for (const [row, expectedError] of [
      [rows[0], "first attempt detail"],
      [rows[1], "second attempt detail"],
    ] as const) {
      const detail = await callLogs.getCallLogById(row.id);
      assert.equal(detail?.detailState, "ready");
      assert.equal(detail?.error, expectedError, `row ${row.status} must open its own artifact`);
      const { artifact } = artifacts.readCallArtifact(row.artifact_relpath);
      assert.equal(
        artifact?.summary.id,
        row.id,
        "artifact summary.id must match the row's final primary key"
      );
    }
  });

  test("chatCore does not truncate randomUUID to six hex chars for the request trace", () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url)),
      "utf8"
    );
    // Positive anchor: a negative guard alone passes on an empty/moved file.
    assert.match(src, /export async function handleChatCore\(/);
    assert.doesNotMatch(
      src,
      /crypto\.randomUUID\(\)\.slice\(0,\s*6\)/,
      "6-char UUID prefixes collide in production call_logs (#14451)"
    );
  });
});

describe("estimated-usage-billing-guard", () => {
  // Estimated token usage: billing stays exactly as it is, and the call log records that the
  // counts were estimated. Drives the real handleChatCore (non-streaming and streaming) with a
  // fetch stub, then reads the persisted call log and the API-key spend ledger.
  const originalFetch = globalThis.fetch;
  const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
  const MODEL = "gpt-4o-mini";

  before(async () => {
    await resetTestDb();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
  });

  const USAGE = { prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000 };

  function jsonCompletion(usage: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-estimated",
        object: "chat.completion",
        model: MODEL,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  function sseCompletion(events: unknown[]): Response {
    const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  const textChunk = (content: string, finish: string | null = null) => ({
    id: "chatcmpl-estimated",
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });

  async function runChat(apiKeyId: string, stream: boolean, response: () => Response) {
    globalThis.fetch = (async () => response()) as typeof fetch;
    const body = { model: MODEL, stream, messages: [{ role: "user", content: "hello there" }] };
    const result = (await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: MODEL, extendedContext: false },
      credentials: { apiKey: "sk-test-estimated" },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
      },
      apiKeyInfo: { id: apiKeyId, name: apiKeyId },
      userAgent: "unit-test",
      isCombo: false,
      log: silentLog,
    } as unknown as Parameters<typeof handleChatCore>[0])) as { response?: Response };
    const clientText = result.response ? await result.response.text() : "";
    return clientText;
  }

  async function persistedLog(apiKeyId: string) {
    const deadline = Date.now() + CALL_LOG_SETTLE_TIMEOUT_MS;
    for (;;) {
      await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
      const rows = (await callLogs.getCallLogs({})) as Array<{ id: string; apiKeyId: string }>;
      const row = rows.find((r) => r.apiKeyId === apiKeyId);
      if (row) return callLogs.getCallLogById(row.id);
      if (Date.now() > deadline) throw new Error(`no call log for ${apiKeyId}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function spend(apiKeyId: string): Promise<number> {
    const deadline = Date.now() + 5_000;
    let total = await getDailyTotal(apiKeyId);
    while (total === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      total = await getDailyTotal(apiKeyId);
    }
    return total;
  }

  function usageEstimatedMeta(entry: unknown): unknown {
    const responseBody = (entry as { responseBody?: { _omniroute?: Record<string, unknown> } })
      ?.responseBody;
    return responseBody?._omniroute?.usageEstimated;
  }

  test("extraction keeps an internal estimated marker that never serializes or spreads", () => {
    const estimatedChunk = { choices: [], usage: { ...USAGE, estimated: true } };
    const reportedChunk = { choices: [], usage: { ...USAGE } };
    const estimated = extractUsage(estimatedChunk);
    const reported = extractUsage(reportedChunk);
    assert.equal(isEstimatedUsage(estimated), true);
    assert.equal(isEstimatedUsage(reported), false);
    assert.deepStrictEqual(estimated, reported, "token fields are untouched");
    assert.equal(JSON.stringify(estimated), JSON.stringify(reported));
    assert.equal(isEstimatedUsage({ ...estimated }), false, "spread copies never carry it");
    assert.equal(isEstimatedUsage(filterUsageForFormat(estimated, "openai")), false);

    const fromResponse = extractUsageFromResponse({ usage: { ...USAGE, estimated: true } }, "x");
    assert.equal(isEstimatedUsage(fromResponse), true);
    assert.equal(JSON.stringify(fromResponse).includes("estimated"), false);
    assert.equal(isEstimatedUsage(extractUsageFromResponse({ usage: { ...USAGE } }, "x")), false);
  });

  test("non-streaming estimated usage is still billed and is marked in the call log", async () => {
    const clientText = await runChat("key-json-estimated", false, () =>
      jsonCompletion({ ...USAGE, estimated: true })
    );
    assert.ok((await spend("key-json-estimated")) > 0, "API-key spend still records the cost");
    const entry = await persistedLog("key-json-estimated");
    assert.equal(entry?.tokens?.in, USAGE.prompt_tokens);
    assert.equal(entry?.tokens?.out, USAGE.completion_tokens);
    assert.equal(usageEstimatedMeta(entry), true);
    assert.doesNotMatch(clientText, /usageEstimated/);
  });

  test("non-streaming provider-reported usage carries no estimated marker", async () => {
    await runChat("key-json-reported", false, () => jsonCompletion({ ...USAGE }));
    assert.ok((await spend("key-json-reported")) > 0);
    const entry = await persistedLog("key-json-reported");
    assert.equal(usageEstimatedMeta(entry), undefined);
  });

  test("a stream without upstream usage is billed on the estimate and marked in the call log", async () => {
    const clientText = await runChat("key-sse-silent", true, () =>
      sseCompletion([textChunk("hello from the model"), textChunk("", "stop")])
    );
    assert.match(clientText, /hello from the model/);
    assert.ok((await spend("key-sse-silent")) > 0, "API-key spend still records the estimate");
    const entry = await persistedLog("key-sse-silent");
    assert.ok((entry?.tokens?.out ?? 0) > 0);
    assert.equal(usageEstimatedMeta(entry), true);
    assert.doesNotMatch(clientText, /usageEstimated/);
  });

  test("a stream whose executor reports estimated usage is billed and marked in the call log", async () => {
    const clientText = await runChat("key-sse-executor", true, () =>
      sseCompletion([
        textChunk("hello from the model"),
        textChunk("", "stop"),
        {
          id: "chatcmpl-estimated",
          object: "chat.completion.chunk",
          model: MODEL,
          choices: [],
          usage: { ...USAGE, estimated: true },
        },
      ])
    );
    assert.ok((await spend("key-sse-executor")) > 0);
    const entry = await persistedLog("key-sse-executor");
    assert.equal(entry?.tokens?.in, USAGE.prompt_tokens);
    assert.equal(usageEstimatedMeta(entry), true);
    assert.doesNotMatch(clientText, /usageEstimated/);
  });

  test("a stream with provider-reported usage carries no estimated marker", async () => {
    await runChat("key-sse-reported", true, () =>
      sseCompletion([
        textChunk("hello from the model"),
        textChunk("", "stop"),
        {
          id: "chatcmpl-estimated",
          object: "chat.completion.chunk",
          model: MODEL,
          choices: [],
          usage: { ...USAGE },
        },
      ])
    );
    const entry = await persistedLog("key-sse-reported");
    assert.equal(entry?.tokens?.in, USAGE.prompt_tokens);
    assert.equal(usageEstimatedMeta(entry), undefined);
  });
});

describe("chatcore-failure-usage-cpa-scope", () => {
  // Regression guard for #14544: `persistFailureUsage` read `providerResponse`, a `let` that lives
  // inside handleChatCore's big `try { … } finally { … }` body, while the closure itself is declared
  // before that `try`. The name was therefore out of scope (TS2304 under open-sse typecheck, which
  // typecheck:core does not cover) and every failure path that records usage threw
  // `ReferenceError: providerResponse is not defined`. There is no `catch` on that `try`, so the
  // error escaped handleChatCore instead of returning the upstream error response.
  //
  // This drives a real failure path end to end: the upstream answers with a non-OK status, so
  // handleChatCore must return that failure — not reject.
  const originalFetch = globalThis.fetch;

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  async function flushAsyncSideEffects() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await flushAsyncSideEffects();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
  });

  test("#14544 regression: an upstream failure is returned, not thrown as a ReferenceError", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );

    const body = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      stream: false,
    };

    let result;
    await assert.doesNotReject(async () => {
      result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
        credentials: { apiKey: "sk-test-not-real", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "test-client/1.0",
      });
    }, "handleChatCore must not throw on an upstream failure (persistFailureUsage scope)");

    assert.equal(result.success, false, "an upstream 400 is a failed request");
    assert.equal(result.status, 400, "the upstream status is surfaced, not replaced");
  });
});

describe("chatcore-stream-recovery-log-wiring", () => {
  // handleChatCore wiring of the mid-stream continuation log hooks: a real streaming request
  // with stream recovery + mid-stream continuation enabled, an upstream that commits the
  // holdback window and then drops, and a continuation that finishes the answer. The injected
  // log must receive the release attempt line at warn and the stitched outcome at info,
  // both carrying the requesting call's correlationId.
  const ENV_KEYS = ["STREAM_RECOVERY_ENABLED", "STREAM_RECOVERY_MIDSTREAM_ENABLED"] as const;
  const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const enc = new TextEncoder();

  const chunk = (content: string) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-wiring",
      object: "chat.completion.chunk",
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { role: "assistant", content } }],
    })}\n\n`;

  before(() => {
    core.resetDbInstance();
    process.env.STREAM_RECOVERY_ENABLED = "true";
    process.env.STREAM_RECOVERY_MIDSTREAM_ENABLED = "true";
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
  });

  test("handleChatCore routes continuation logs through buildContinuationLogHooks", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        // Two chunks spaced past the holdback window (so the stream commits), then a silent
        // cut: no finish_reason, no [DONE].
        let step = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            step += 1;
            if (step === 1) controller.enqueue(enc.encode(chunk("Hello there ")));
            else if (step === 2) {
              await new Promise((r) => setTimeout(r, STREAM_RECOVERY.HOLDBACK_MS + 150));
              controller.enqueue(enc.encode(chunk("world")));
            } else controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(chunk("there world, nice to meet you!") + "data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const warn: string[] = [];
    const debug: string[] = [];
    const info: string[] = [];
    const log = {
      info: (tag: string, msg: string) => info.push(`${tag} ${msg}`),
      error() {},
      warn: (tag: string, msg: string) => warn.push(`${tag} ${msg}`),
      debug: (tag: string, msg: string) => debug.push(`${tag} ${msg}`),
    };
    const body = {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test-wiring" },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "text/event-stream" }),
      },
      userAgent: "unit-test",
      isCombo: false,
      log,
      correlationId: "req-wiring-1",
    } as unknown as Parameters<typeof handleChatCore>[0]);

    const response = (result as { response?: Response }).response;
    assert.ok(response?.body, "streaming response expected");
    const text = await response.text();

    assert.equal(calls, 2, "one upstream request plus one continuation");
    assert.match(text, /nice to meet you!/);
    const recoveryWarns = warn.filter((l) => l.startsWith("STREAM_RECOVERY "));
    assert.deepEqual(recoveryWarns, [
      "STREAM_RECOVERY mid-stream continuation attempt 1/4 correlationId=req-wiring-1",
    ]);
    assert.deepEqual(
      debug.filter((l) => l.startsWith("STREAM_RECOVERY ")),
      []
    );
    assert.ok(
      info.includes(
        "STREAM_RECOVERY mid-stream continuation attempt 1/4 outcome=suffix suffixChars=19 correlationId=req-wiring-1"
      ),
      info.filter((l) => l.startsWith("STREAM_RECOVERY")).join(" | ")
    );
  });
});

describe("chatcore-streaming-ttft", () => {
  // `usage_history.ttft_ms` for streamed requests must be the time from the start of
  // handleChatCore (the same epoch as latency_ms) to the first delta that carries output —
  // text, reasoning or a tool call — forwarded to the client. Before the fix it was either
  // ~0 ms (the clock started after the first upstream frame) or equal to latency_ms (the
  // Responses → Chat translation path never reported a value).
  const CODEX_WS_FLAG = "OMNIROUTE_CODEX_WS_ENABLED";
  const originalCodexWs = process.env[CODEX_WS_FLAG];
  const originalFetch = globalThis.fetch;
  const CONTENT_DELAY_MS = 300;
  // The stream keeps going after the first content, so latency_ms is clearly larger than ttft.
  const TAIL_DELAY_MS = 300;

  const noopLog = () => ({ debug() {}, info() {}, warn() {}, error() {} });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // latestRow() takes the newest usage_history row of a provider, so start from an empty
  // table: the describes above write openai rows of their own.
  before(async () => {
    // Keep Codex on the HTTP transport so the mocked fetch answers it.
    process.env[CODEX_WS_FLAG] = "false";
    await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
    await resetTestDb();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalCodexWs === undefined) delete process.env[CODEX_WS_FLAG];
    else process.env[CODEX_WS_FLAG] = originalCodexWs;
    await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
  });

  function delayedSse(frames) {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const frame of frames) {
            if (frame.delayMs) await sleep(frame.delayMs);
            controller.enqueue(encoder.encode(frame.text));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  const responsesEvent = (type, payload) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

  function codexResponsesStream() {
    const response = {
      id: "resp_1",
      object: "response",
      model: "gpt-5.6-sol",
      status: "in_progress",
    };
    return delayedSse([
      { text: responsesEvent("response.created", { response }) },
      { text: responsesEvent("response.in_progress", { response }) },
      {
        delayMs: CONTENT_DELAY_MS,
        text: responsesEvent("response.output_item.added", {
          output_index: 0,
          item: { id: "msg_1", type: "message", role: "assistant", content: [] },
        }),
      },
      {
        text: responsesEvent("response.output_text.delta", {
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          delta: "Hello",
        }),
      },
      {
        delayMs: TAIL_DELAY_MS,
        text: responsesEvent("response.completed", {
          response: {
            ...response,
            status: "completed",
            output: [
              {
                id: "msg_1",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Hello", annotations: [] }],
              },
            ],
            usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
          },
        }),
      },
    ]);
  }

  function openAiChatStream() {
    const chunk = (delta, extra = {}) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
    return delayedSse([
      { text: chunk({ role: "assistant", content: "" }) },
      { delayMs: CONTENT_DELAY_MS, text: chunk({ content: "Hello" }) },
      {
        delayMs: TAIL_DELAY_MS,
        text: `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
      },
    ]);
  }

  async function drain(response) {
    const reader = response.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  async function latestRow(provider, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await usageHistory.getUsageHistory({ provider });
      if (rows.length > 0) return rows.at(-1);
      await sleep(25);
    }
    return null;
  }

  async function runStreamed({ provider, model, credentials, upstream }) {
    globalThis.fetch = async () => upstream();
    const body = { model, stream: true, messages: [{ role: "user", content: "hi" }] };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider, model, extendedContext: false },
      credentials,
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream" }),
      },
      connectionId: `${provider}-conn`,
    });
    assert.equal(result.success, true, JSON.stringify(result.error ?? result.status));
    await drain(result.response);
    return latestRow(provider);
  }

  function assertTtftCoversContentDelay(row, label) {
    assert.ok(row, `${label}: expected a usage_history row`);
    const ttft = Number(row.timeToFirstTokenMs);
    const latency = Number(row.latencyMs);
    assert.ok(Number.isFinite(ttft), `${label}: ttft missing`);
    assert.ok(
      ttft >= CONTENT_DELAY_MS - 50,
      `${label}: ttft ${ttft} ms should include the ${CONTENT_DELAY_MS} ms before the first content`
    );
    assert.ok(
      ttft <= latency - (TAIL_DELAY_MS - 100),
      `${label}: ttft ${ttft} ms must end at the first content, well before latency ${latency} ms`
    );
  }

  test("Responses upstream translated to Chat Completions records the first-content time", async () => {
    const row = await runStreamed({
      provider: "codex",
      model: "gpt-5.6-sol",
      credentials: { accessToken: "codex-token", providerSpecificData: {} },
      upstream: codexResponsesStream,
    });
    assertTtftCoversContentDelay(row, "codex");
  });

  test("Chat Completions upstream records the first-content time, not the first frame", async () => {
    const row = await runStreamed({
      provider: "openai",
      model: "gpt-4o-mini",
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      upstream: openAiChatStream,
    });
    assertTtftCoversContentDelay(row, "openai");
  });
});

describe("topology-request-lifecycle-emit", () => {
  // The live topology lights a node green on `request.started` and only clears it when a
  // matching `request.completed`/`request.failed` arrives. Those terminal events were
  // declared + consumed by the client but never emitted, so a node stayed green until a
  // page reload (the "stuck green" latch). These tests guard the fix that emits them.

  test("resolveRequestLifecycleEvent: 2xx success → request.completed keyed by traceId", () => {
    const ev = resolveRequestLifecycleEvent({
      traceId: "abc123",
      status: 200,
      error: null,
      model: "gpt-5.6-sol",
      provider: "codex",
      comboName: "my-combo",
      tokens: { input: 10, output: 5 },
      latencyMs: 1234,
    });
    assert.equal(ev.name, "request.completed");
    assert.equal(ev.payload.id, "abc123");
    if (ev.name !== "request.completed") return;
    assert.equal(ev.payload.status, "success");
    assert.equal(ev.payload.provider, "codex");
    assert.equal(ev.payload.model, "gpt-5.6-sol");
    assert.equal(ev.payload.tokensInput, 10);
    assert.equal(ev.payload.tokensOutput, 5);
    assert.equal(ev.payload.latencyMs, 1234);
    assert.equal(ev.payload.comboName, "my-combo");
  });

  test("resolveRequestLifecycleEvent: 5xx → request.failed keyed by the same traceId", () => {
    const ev = resolveRequestLifecycleEvent({
      traceId: "e1",
      status: 500,
      error: "boom",
      model: "m",
      provider: "p",
      latencyMs: 7,
    });
    assert.equal(ev.name, "request.failed");
    if (ev.name !== "request.failed") return;
    assert.equal(ev.payload.id, "e1");
    assert.equal(ev.payload.error, "boom");
    assert.equal(ev.payload.statusCode, 500);
    assert.equal(ev.payload.latencyMs, 7);
  });

  test("resolveRequestLifecycleEvent: a 2xx status carrying an error string is still a failure", () => {
    const ev = resolveRequestLifecycleEvent({
      traceId: "x",
      status: 200,
      error: "late error",
      latencyMs: 1,
    });
    assert.equal(ev.name, "request.failed");
  });

  test("resolveRequestLifecycleEvent: tokens resolve from prompt_tokens/completion_tokens aliases", () => {
    const ev = resolveRequestLifecycleEvent({
      traceId: "t",
      status: 201,
      tokens: { prompt_tokens: 3, completion_tokens: 8 },
      latencyMs: 0,
    });
    assert.equal(ev.name, "request.completed");
    if (ev.name !== "request.completed") return;
    assert.equal(ev.payload.tokensInput, 3);
    assert.equal(ev.payload.tokensOutput, 8);
  });

  test("resolveRequestLifecycleEvent: missing/odd tokens degrade to zero, never NaN", () => {
    const ev = resolveRequestLifecycleEvent({
      traceId: "z",
      status: 200,
      tokens: "nope",
      latencyMs: 2,
    });
    assert.equal(ev.name, "request.completed");
    if (ev.name !== "request.completed") return;
    assert.equal(ev.payload.tokensInput, 0);
    assert.equal(ev.payload.tokensOutput, 0);
  });

  test("attemptLogging emits both terminal events through the dashboard event bus", () => {
    const src = fs.readFileSync(
      fileURLToPath(
        new URL("../../../open-sse/handlers/chatCore/attemptLogging.ts", import.meta.url)
      ),
      "utf8"
    );
    assert.match(src, /emit\("request\.completed"/, "success attempts must emit request.completed");
    assert.match(src, /emit\("request\.failed"/, "failed attempts must emit request.failed");
    assert.match(src, /resolveRequestLifecycleEvent/, "emit must go through the pure resolver");
  });

  test("chatCore threads traceId into the persistAttemptLogs context (pairs with request.started)", () => {
    const src = fs.readFileSync(
      fileURLToPath(new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url)),
      "utf8"
    );
    assert.match(
      src,
      /persistAttemptLogsFor\(args,\s*\{\s*traceId/,
      "the terminal event id must be the same traceId emitted in request.started"
    );
  });
});
