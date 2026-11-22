// Rejected-request call-log rows, the client raw-request snapshot and the provider-breaker trip
// predicate around handleChat (src/sse/handlers/chat.ts). Merged from five files so the chat
// handler module graph loads once; each original file is one `describe` below, named after the
// file it came from.
//
// Load-time env: OMNIROUTE_CHAT_HARD_MAX_MESSAGES is read once when chatBodyAdmission.ts loads, so
// it is set here, before the dynamic imports, for the whole file. A cap of 2 messages means every
// request this file sends through handleChat or the routes must carry at most 2 messages.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ISOLATED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chat-handler-reject-"));
process.env.DATA_DIR = ISOLATED_DATA_DIR;
process.env.OMNIROUTE_CHAT_HARD_MAX_MESSAGES = "2";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "handler-reject-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const usageHistory = await import("../../../src/lib/usage/usageHistory.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const continuationStore = await import("../../../src/lib/db/responsesContinuationStore.ts");
const runtimeModule = await import("../../../open-sse/services/admission/runtime.ts");
const chatAdmission = await import("../../../src/sse/handlers/chatAdmission.ts");
const completionsRoute = await import("../../../src/app/api/v1/chat/completions/route.ts");
const responsesRoute = await import("../../../src/app/api/v1/responses/route.ts");
const chatHandler = await import("../../../src/sse/handlers/chat.ts");
const {
  buildClientRawRequest,
  resolveDispatchClientRawRequest,
  shouldTripProviderBreakerForResult,
} = chatHandler;
const { isProviderBreakerFailureStatus } =
  await import("../../../src/sse/handlers/chatPredicates.ts");
const { shouldRecordProviderBreakerFailure } =
  await import("../../../open-sse/services/combo/comboPredicates.ts");
const { cloneBoundedForLog, MAX_LOG_ARRAY_ITEMS } =
  await import("../../../open-sse/utils/requestLogger.ts");

after(() => {
  try {
    runtimeModule.resetAdaptiveAdmissionRuntimeForTests();
  } catch {}
  try {
    usageHistory.clearPendingRequests();
  } catch {}
  try {
    apiKeysDb.resetApiKeyState();
  } catch {}
  core.resetDbInstance();
  fs.rmSync(ISOLATED_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("admission-rejection-call-log", () => {
  // Every admission rejection (413/503) leaves a queryable call_logs row.
  // Admission OK leaves behavior and rows unchanged; rejections never touch the
  // pending-usage registry (bounded memory by construction).

  // The admission queue deadline timer is unref'd (it must not pin the event
  // loop open when idle), so a test whose only pending work is a queued
  // acquire would see the loop drain before the deadline fires. A ref'd
  // guard timer keeps the loop alive until the rejection lands.
  function keepLoopAlive(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function uniqueCorrelationId(label: string): string {
    return `admission-reject-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  type RejectionRow = {
    status?: number;
    model?: string;
    error?: string | null;
    duration?: number;
    session_tag?: string | null;
    correlationId?: string;
  };

  async function rowsByCorrelation(correlationId: string): Promise<Array<RejectionRow>> {
    // The rejection log is fire-and-forget (never holds the rejection path),
    // so poll briefly instead of asserting synchronously after the await.
    const deadline = Date.now() + 10_000;
    let rows: Array<RejectionRow> = [];
    while (Date.now() < deadline) {
      await callLogs.waitForCallLogSaves(1_000);
      const found = await callLogs.getCallLogs({ correlationId, limit: 50 });
      rows = (Array.isArray(found) ? found : []).filter(
        (row: RejectionRow) => row.correlationId === correlationId
      );
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return rows;
  }

  function enforceRuntime(): void {
    runtimeModule.reloadAdaptiveAdmissionRuntime({
      config: {
        mode: "enforce",
        minLimit: 1,
        maxLimit: 1,
        initialLimit: 1,
        maxQueueCount: 1,
        maxQueueCost: 1,
        defaultMaxWaitMs: 50,
        windowMs: 50,
        cost: { maxRequestCost: 1, baseCost: 1 },
      },
      checkResourcePressure: () => null,
    });
  }

  function chatRequest(correlationId: string): Request {
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-correlation-id": correlationId },
      body: JSON.stringify({
        model: "openai/gpt-4.1",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
  }

  test("admission shed leaves a 503 call_logs row with the admission reason", async () => {
    const correlationId = uniqueCorrelationId("shed");
    enforceRuntime();
    const runtime = runtimeModule.getAdaptiveAdmissionRuntime();
    const holder = await runtime.acquire({
      tenantKey: "admission-reject-holder",
      body: { messages: [{ role: "user", content: "hold" }], stream: true },
      maxWaitMs: 50,
    });
    assert.equal(holder.status, "admitted");
    try {
      const [response] = await Promise.all([
        chatHandler.handleChat(chatRequest(correlationId), null, null, correlationId),
        keepLoopAlive(500),
      ]);
      assert.equal(response.status, 503);
      const payload = (await response.clone().json()) as { error?: { code?: string } };
      assert.match(payload.error?.code ?? "", /^admission_/);

      const rows = await rowsByCorrelation(correlationId);
      assert.equal(rows.length, 1, "a shed request must leave exactly one call_logs row");
      assert.equal(rows[0].status, 503);
      assert.match(rows[0].error ?? "", /admission_/);
      assert.equal(rows[0].duration, 0);
      assert.equal(rows[0].session_tag ?? null, null, "rejection rows carry no session tag");
    } finally {
      if (holder.status === "admitted") holder.lease.release("success");
      runtimeModule.resetAdaptiveAdmissionRuntimeForTests();
    }
  });

  test("admitted requests log no extra rejection row", async () => {
    const correlationId = uniqueCorrelationId("accept");
    runtimeModule.resetAdaptiveAdmissionRuntimeForTests();
    const response = await chatHandler.handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-correlation-id": correlationId },
        body: JSON.stringify({
          model: "openai/gpt-4.1",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      null,
      null,
      correlationId
    );
    void response;
    const rows = await rowsByCorrelation(correlationId);
    assert.ok(
      rows.every((row) => !(row.duration === 0 && row.status >= 500 && row.status !== 499)),
      "no rejection row may appear for an admitted request"
    );
  });

  test("rejections leave the pending-usage registry untouched", async () => {
    const before = usageHistory.getPendingById().size;
    const correlationId = uniqueCorrelationId("bounded");
    enforceRuntime();
    const runtime = runtimeModule.getAdaptiveAdmissionRuntime();
    const holder = await runtime.acquire({
      tenantKey: "admission-reject-bounded",
      body: { messages: [{ role: "user", content: "hold" }], stream: true },
      maxWaitMs: 50,
    });
    assert.equal(holder.status, "admitted");
    try {
      for (let i = 0; i < 3; i++) {
        const [response] = await Promise.all([
          chatHandler.handleChat(
            chatRequest(`${correlationId}-${i}`),
            null,
            null,
            `${correlationId}-${i}`
          ),
          keepLoopAlive(500),
        ]);
        await response.text().catch(() => undefined);
      }
      assert.equal(
        usageHistory.getPendingById().size,
        before,
        "rejections must not grow the pending-usage registry"
      );
    } finally {
      if (holder.status === "admitted") holder.lease.release("success");
      runtimeModule.resetAdaptiveAdmissionRuntimeForTests();
    }
  });

  test("chat completions byte rejection leaves a 413 call_logs row", async () => {
    const correlationId = uniqueCorrelationId("byte");
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    const response = await completionsRoute.POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(65 * 1024 * 1024),
          "x-correlation-id": correlationId,
        },
        body,
      })
    );
    assert.equal(response.status, 413);
    const rows = await rowsByCorrelation(correlationId);
    assert.equal(rows.length, 1, "a byte rejection must leave exactly one call_logs row");
    assert.equal(rows[0].status, 413);
    assert.match(rows[0].error ?? "", /PAYLOAD_TOO_LARGE/);
    assert.equal(rows[0].model, "-");
    assert.equal(rows[0].duration, 0);
  });

  test("chat completions structural rejection leaves a 413 call_logs row", async () => {
    const correlationId = uniqueCorrelationId("structural");
    const body = JSON.stringify({
      model: "openai/gpt-4.1",
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    const response = await completionsRoute.POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-correlation-id": correlationId },
        body,
      })
    );
    assert.equal(response.status, 413);
    const rows = await rowsByCorrelation(correlationId);
    assert.equal(rows.length, 1, "a structural rejection must leave exactly one call_logs row");
    assert.equal(rows[0].status, 413);
    assert.match(rows[0].error ?? "", /chat_history_too_large/);
    assert.equal(rows[0].model, "openai/gpt-4.1");
    assert.equal(rows[0].duration, 0);
  });

  test("responses byte rejection leaves a 413 call_logs row", async () => {
    const correlationId = uniqueCorrelationId("responses-byte");
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    const response = await responsesRoute.POST(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(65 * 1024 * 1024),
          "x-correlation-id": correlationId,
        },
        body,
      })
    );
    assert.equal(response.status, 413);
    const rows = await rowsByCorrelation(correlationId);
    assert.equal(rows.length, 1, "a responses byte rejection must leave exactly one call_logs row");
    assert.equal(rows[0].status, 413);
    assert.match(rows[0].error ?? "", /PAYLOAD_TOO_LARGE/);
  });

  test("responses structural rejection leaves a 413 call_logs row", async () => {
    const correlationId = uniqueCorrelationId("responses-structural");
    const body = JSON.stringify({
      model: "openai/gpt-4.1",
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    const response = await responsesRoute.POST(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "x-correlation-id": correlationId },
        body,
      })
    );
    assert.equal(response.status, 413);
    const rows = await rowsByCorrelation(correlationId);
    assert.equal(rows.length, 1, "a responses structural rejection must leave exactly one row");
    assert.equal(rows[0].status, 413);
    assert.match(rows[0].error ?? "", /chat_history_too_large/);
  });

  test("unreadable rejection bodies still leave a row with the fallback reason", async () => {
    const rejection = new Response("not-json{{{", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const context = chatAdmission.createChatAdmissionContext();
    void context;
    void rejection;
    const correlationId = uniqueCorrelationId("fallback");
    enforceRuntime();
    const runtime = runtimeModule.getAdaptiveAdmissionRuntime();
    const holder = await runtime.acquire({
      tenantKey: "admission-reject-fallback",
      body: { messages: [{ role: "user", content: "hold" }], stream: true },
      maxWaitMs: 50,
    });
    assert.equal(holder.status, "admitted");
    try {
      const [response] = await Promise.all([
        chatHandler.handleChat(chatRequest(correlationId), null, null, correlationId),
        keepLoopAlive(500),
      ]);
      assert.equal(response.status, 503);
      const rows = await rowsByCorrelation(correlationId);
      assert.equal(rows.length, 1);
      assert.match(rows[0].error ?? "", /admission_|unknown/);
    } finally {
      if (holder.status === "admitted") holder.lease.release("success");
      runtimeModule.resetAdaptiveAdmissionRuntimeForTests();
    }
  });
});

describe("handler-rejection-call-log", () => {
  // Rejected handler requests leave a queryable call_logs row; admitted ones do not.
  type RejectionRow = {
    status?: number;
    model?: string;
    error?: string | null;
    duration?: number;
    correlationId?: string;
    apiKeyId?: string | null;
    path?: string;
  };

  function uniqueCorrelationId(label: string): string {
    return `handler-reject-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  function chatRequest(
    url: string,
    payload: unknown,
    correlationId: string,
    extra?: HeadersInit
  ): Request {
    return new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-correlation-id": correlationId,
        ...(extra ?? {}),
      },
      body: JSON.stringify(payload),
    });
  }

  async function rowsByCorrelation(correlationId: string): Promise<Array<RejectionRow>> {
    // The rejection log is fire-and-forget (never holds the rejection path),
    // so poll briefly instead of asserting synchronously after the await.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await callLogs.waitForCallLogSaves(1_000);
      const found = await callLogs.getCallLogs({ correlationId, limit: 50 });
      const rows = (Array.isArray(found) ? found : []).filter(
        (row: RejectionRow) => row.correlationId === correlationId
      );
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [];
  }

  async function noRowsFor(correlationId: string): Promise<Array<RejectionRow>> {
    await callLogs.waitForCallLogSaves(500);
    const found = await callLogs.getCallLogs({ correlationId, limit: 50 });
    return (Array.isArray(found) ? found : []).filter(
      (row: RejectionRow) => row.correlationId === correlationId
    );
  }

  test("rejects invalid body with one 400 log line", async () => {
    const correlationId = uniqueCorrelationId("invalid-body");
    const response = await chatHandler.handleChat(
      chatRequest(
        "http://localhost/v1/chat/completions",
        { model: "openai/gpt-4.1", messages: "not-an-array" },
        correlationId
      ),
      null,
      null,
      correlationId
    );
    assert.equal(response.status, 400);
    const payload = (await response.clone().json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "bad_request");

    const rows = await rowsByCorrelation(correlationId);
    assert.equal(rows.length, 1, "an invalid body must leave exactly one call_logs row");
    assert.equal(rows[0].status, 400);
    assert.match(rows[0].error ?? "", /invalid_request|bad_request|messages|unknown/);
    assert.equal(rows[0].duration, 0);
  });

  test("rejects missing model with one 400 log line", async () => {
    const correlationId = uniqueCorrelationId("missing-model");
    const response = await chatHandler.handleChat(
      chatRequest(
        "http://localhost/v1/chat/completions",
        { messages: [{ role: "user", content: "hi" }] },
        correlationId
      ),
      null,
      null,
      correlationId
    );
    assert.equal(response.status, 400);

    const rows = await rowsByCorrelation(correlationId);
    assert.equal(rows.length, 1, "a missing model must leave exactly one call_logs row");
    assert.equal(rows[0].status, 400);
    assert.equal(rows[0].duration, 0);
  });

  test("rejects disabled key with an attributed 403 line", async () => {
    const created = await apiKeysDb.createApiKey("Reject Key", "machine-reject");
    await apiKeysDb.updateApiKeyPermissions(created.id, { isActive: false });
    const correlationId = uniqueCorrelationId("disabled-key");
    const response = await chatHandler.handleChat(
      chatRequest(
        "http://localhost/v1/chat/completions",
        { model: "openai/gpt-4.1", messages: [{ role: "user", content: "hi" }] },
        correlationId,
        { Authorization: `Bearer ${created.key}` }
      ),
      null,
      null,
      correlationId
    );
    assert.equal(response.status, 403);

    const rows = await rowsByCorrelation(correlationId);
    assert.equal(rows.length, 1, "a disabled key must leave exactly one call_logs row");
    assert.equal(rows[0].status, 403);
    assert.equal(rows[0].apiKeyId, created.id);
  });

  test("keeps response status and error code", async () => {
    const correlationId = uniqueCorrelationId("untouched");
    const response = await chatHandler.handleChat(
      chatRequest(
        "http://localhost/v1/chat/completions",
        { model: "openai/gpt-4.1", messages: "not-an-array" },
        correlationId
      ),
      null,
      null,
      correlationId
    );
    assert.equal(response.status, 400);
    const payload = (await response.clone().json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "bad_request");
    await rowsByCorrelation(correlationId);
  });

  test("admitted then dispatched writes no rejection line", async () => {
    const correlationId = uniqueCorrelationId("admitted");
    const response = await chatHandler.handleChat(
      chatRequest(
        "http://localhost/v1/chat/completions",
        { model: "openai/gpt-4.1", messages: [{ role: "user", content: "hi" }] },
        correlationId
      ),
      null,
      null,
      correlationId
    );
    void response;
    const rows = await noRowsFor(correlationId);
    assert.ok(
      rows.every((row) => !(row.duration === 0 && row.error)),
      "no rejection row may appear for an admitted request"
    );
  });

  test("logs unknown previous response id with one 400 line", async () => {
    const correlationId = uniqueCorrelationId("unknown-prev-response");
    const response = await chatHandler.handleChat(
      chatRequest(
        "http://localhost/v1/responses",
        {
          model: "openai/gpt-4.1",
          previous_response_id: `resp_never_seen_by_omniroute-${correlationId}`,
          input: [{ type: "message", role: "user", content: "hi" }],
        },
        correlationId
      ),
      null,
      null,
      correlationId
    );
    assert.equal(response.status, 400);
    const payload = (await response.clone().json()) as { error?: { code?: string } };
    assert.equal(payload.error?.code, "previous_response_not_found");

    const rows = await rowsByCorrelation(correlationId);
    assert.equal(
      rows.length,
      1,
      "an unknown previous response id must leave exactly one call_logs row"
    );
    assert.equal(rows[0].status, 400);
    assert.match(rows[0].error ?? "", /previous_response_not_found/);
    assert.equal(rows[0].duration, 0);
  });

  test("known previous response id writes no rejection line", async () => {
    const previousEnv = process.env.ENABLE_REQUEST_LOGS;
    process.env.ENABLE_REQUEST_LOGS = "true";
    const responseId = `resp_known_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const created = await apiKeysDb.createApiKey("Previous Response Key", "machine-prev-response");
    const correlationId = uniqueCorrelationId("known-prev-response");
    try {
      continuationStore.seedPendingContinuationState(
        responseId,
        created.id,
        {
          clientRawRequest: {
            effectiveInput: [{ type: "message", role: "user", content: "hi" }],
          },
          clientResponse: {
            output: [{ type: "message", role: "assistant", content: "ok" }],
          },
        },
        false
      );
      const response = await chatHandler.handleChat(
        chatRequest(
          "http://localhost/v1/responses",
          {
            model: "openai/gpt-4.1",
            previous_response_id: responseId,
            input: [{ type: "message", role: "user", content: "again" }],
          },
          correlationId,
          { Authorization: `Bearer ${created.key}` }
        ),
        null,
        null,
        correlationId
      );
      void response;
      const rows = await noRowsFor(correlationId);
      assert.ok(
        rows.every((row) => !(row.duration === 0 && row.error)),
        "no rejection row may appear for a known previous response id"
      );
    } finally {
      if (previousEnv === undefined) delete process.env.ENABLE_REQUEST_LOGS;
      else process.env.ENABLE_REQUEST_LOGS = previousEnv;
      continuationStore.clearPendingContinuationState(responseId);
    }
  });

  test("keeps previous response not found body byte identical", async () => {
    const correlationId = uniqueCorrelationId("prev-response-body");
    const response = await chatHandler.handleChat(
      chatRequest(
        "http://localhost/v1/responses",
        {
          model: "openai/gpt-4.1",
          previous_response_id: `resp_never_seen_by_omniroute-${correlationId}`,
          input: [{ type: "message", role: "user", content: "hi" }],
        },
        correlationId
      ),
      null,
      null,
      correlationId
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(
      await response.text(),
      JSON.stringify({
        error: {
          message: "Previous response not found.",
          type: "invalid_request_error",
          code: "previous_response_not_found",
        },
      })
    );
  });
});

describe("chat-build-client-raw-request", () => {
  // #5152: handleChat used to clone the body twice for logging — once into a local
  // `rawClientBody` and again inside buildClientRawRequest — doubling per-request heap
  // residency on the hot path (and cloning even when clientRawRequest was already provided).
  // The outer clone was removed; buildClientRawRequest still owns the (single) deep clone.
  // These tests pin that the logging snapshot remains an ISOLATED copy so dropping the outer
  // clone cannot leak a shared reference that downstream mutation would corrupt.
  function req(body: unknown) {
    return new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("buildClientRawRequest deep-clones the body (not the same reference)", () => {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const out = buildClientRawRequest(req(body), body);
    assert.deepEqual(out.body, body);
    assert.notEqual(out.body, body, "must be a distinct object");
    assert.notEqual(out.body.messages, body.messages, "nested arrays must be cloned too");
  });

  test("mutating the original body after capture does not corrupt the snapshot", () => {
    const body = { model: "m", messages: [{ role: "user", content: "original" }] };
    const out = buildClientRawRequest(req(body), body);
    body.messages[0].content = "MUTATED";
    body.messages.push({ role: "user", content: "added" });
    assert.equal(out.body.messages.length, 1, "snapshot length is frozen at capture time");
    assert.equal(out.body.messages[0].content, "original", "snapshot content is isolated");
  });

  test("endpoint and headers are captured from the request", () => {
    const out = buildClientRawRequest(req({ model: "m" }), { model: "m" });
    assert.equal(out.endpoint, "/v1/chat/completions");
    assert.equal(out.headers["content-type"], "application/json");
  });

  test("buildClientRawRequest can carry an explicit stream lifecycle signal", () => {
    const requestAbort = new AbortController();
    const streamAbort = new AbortController();
    const request = new Request("http://x/v1/responses", {
      method: "POST",
      body: "{}",
      signal: requestAbort.signal,
    });
    const out = buildClientRawRequest(request, { model: "m" }, streamAbort.signal);
    assert.equal(out.signal, streamAbort.signal);
    assert.notEqual(out.signal, requestAbort.signal);
  });

  // #7360 follow-up (live incident, log id 1784418258231-14961a): a combo target
  // abandoned by comboTargetTimeoutMs used to hang forever because chatCore.ts's
  // createStreamController/withRateLimit only ever watches the ORIGINAL client's
  // request.signal — which stays open for as long as the overall combo keeps
  // succeeding via a different target. resolveDispatchClientRawRequest merges in
  // the per-target modelAbortSignal so an abandoned dispatch can observe its own
  // abort and reach its cleanup path (trackPendingRequest(false)).
  test("resolveDispatchClientRawRequest returns clientRawRequest unchanged when there is no modelAbortSignal", () => {
    const clientRawRequest = { endpoint: "/v1/responses", signal: null };
    const out = resolveDispatchClientRawRequest(clientRawRequest, null);
    assert.equal(out, clientRawRequest, "must be the exact same reference — no-op common case");
  });

  test("resolveDispatchClientRawRequest uses modelAbortSignal directly when clientRawRequest has no signal of its own", () => {
    const modelAbortController = new AbortController();
    const clientRawRequest = { endpoint: "/v1/responses", signal: null };
    const out = resolveDispatchClientRawRequest(clientRawRequest, modelAbortController.signal);
    assert.equal(out?.endpoint, "/v1/responses", "other fields are preserved");
    assert.equal(out?.signal?.aborted, false);
    modelAbortController.abort(new Error("target timeout"));
    assert.equal(out?.signal?.aborted, true, "the returned signal must reflect the model abort");
  });

  test("resolveDispatchClientRawRequest merges both signals — EITHER aborting fires the combined signal", () => {
    const clientAbortController = new AbortController();
    const modelAbortController = new AbortController();
    const clientRawRequest = { endpoint: "/v1/responses", signal: clientAbortController.signal };

    const out = resolveDispatchClientRawRequest(clientRawRequest, modelAbortController.signal);
    assert.equal(out?.signal?.aborted, false);

    // The per-target timeout fires WITHOUT the real client ever disconnecting —
    // this is exactly the live-incident scenario: the merged signal must still abort.
    modelAbortController.abort(new Error("comboTargetTimeoutMs exceeded"));
    assert.equal(
      out?.signal?.aborted,
      true,
      "modelAbortSignal alone (client signal untouched) must abort the merged signal"
    );
    assert.equal(
      clientAbortController.signal.aborted,
      false,
      "the original client signal is untouched"
    );
  });

  test("resolveDispatchClientRawRequest: the real client disconnecting also aborts the merged signal", () => {
    const clientAbortController = new AbortController();
    const modelAbortController = new AbortController();
    const clientRawRequest = { endpoint: "/v1/responses", signal: clientAbortController.signal };

    const out = resolveDispatchClientRawRequest(clientRawRequest, modelAbortController.signal);
    clientAbortController.abort(new Error("client disconnected"));
    assert.equal(out?.signal?.aborted, true);
  });
});

describe("repro-7847-bound-client-raw-request", () => {
  // Repro + regression guard for #7847: buildClientRawRequest deep-clones the ENTIRE request body
  // on every chat request, unbounded, even though every consumer of clientRawRequest.body is
  // observability that either discards it or re-clones it *bounded*.
  //
  // Consumers traced at the time of writing — none feeds dispatch, translation or the upstream call:
  //   1. chatCore.ts        -> reqLogger.logClientRawRequest(...)  (no-op when the logger is off,
  //                            otherwise re-clones via cloneBoundedForLog)
  //   2. chatCore.ts        -> trackPendingRequest({ clientRequest }) -> /api/logs/[id]
  //   3. chat.ts            -> recordRejectedRequestUsage({ requestBody })
  //
  // The incident: a 3.05 MiB request (729 messages / 86 tools) reached ~12,282 MiB of V8 heap.
  const MESSAGES = MAX_LOG_ARRAY_ITEMS + 500;

  function makeRequest(): Request {
    return new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
  }

  function longHistoryBody() {
    return {
      model: "claude-opus-5",
      messages: Array.from({ length: MESSAGES }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i} `.repeat(200),
      })),
    };
  }

  test("#7847: buildClientRawRequest must not retain an unbounded copy of the message history", () => {
    const captured = buildClientRawRequest(makeRequest(), longHistoryBody()) as {
      body: { messages: unknown[] };
    };

    // The bounded clone keeps a truncation marker plus the tail, never the whole history.
    assert.ok(
      captured.body.messages.length <= MAX_LOG_ARRAY_ITEMS + 1,
      `clientRawRequest.body retained ${captured.body.messages.length} of ${MESSAGES} messages — ` +
        `every consumer is observability and keeps at most ${MAX_LOG_ARRAY_ITEMS}`
    );
  });

  test("#7847: the retained snapshot does not grow with the message count", () => {
    // The amplification in #7847 is that retention scaled with history length. Ten times the
    // history must not cost ten times the retained snapshot.
    const size = (v: unknown) => JSON.stringify(v).length;
    const at = (messages: number) =>
      size(
        (
          buildClientRawRequest(makeRequest(), {
            model: "claude-opus-5",
            messages: Array.from({ length: messages }, (_, i) => ({
              role: i % 2 === 0 ? "user" : "assistant",
              content: `message ${i} `.repeat(200),
            })),
          }) as { body: unknown }
        ).body
      );

    const small = at(MESSAGES);
    const tenfold = at(MESSAGES * 10);
    // Not exactly equal: only the tail is retained, and the tail of the longer history carries
    // wider index numbers ("message 7999" vs "message 799"). What matters is that the growth is
    // a rounding error rather than the 10x a proportional retention would cost.
    assert.ok(
      tenfold < small * 1.5,
      `retained ${tenfold} bytes for ${MESSAGES * 10} messages vs ${small} for ${MESSAGES} — ` +
        `retention must be bounded; proportional retention would be ~${small * 10}`
    );
  });

  test("bounding at the entry does not change what the request logger ultimately stores", () => {
    // chatCore hands clientRawRequest.body to reqLogger.logClientRawRequest, which applies
    // cloneBoundedForLog itself. Bounding earlier may only be safe if that second pass is a
    // no-op — otherwise the persisted log payload would change shape.
    const body = longHistoryBody();
    const once = cloneBoundedForLog(body);
    const twice = cloneBoundedForLog(once);
    assert.deepEqual(
      twice,
      once,
      "cloneBoundedForLog must be idempotent for the entry clone to be safe"
    );
  });

  test("buildClientRawRequest still carries endpoint, headers and signal", () => {
    const req = new Request("http://localhost:20128/v1/chat/completions?x=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-omniroute-session-id": "sess-1" },
    });
    const out = buildClientRawRequest(req, { model: "m", messages: [] }) as {
      endpoint: string;
      headers: Record<string, string>;
      signal: unknown;
    };
    assert.equal(out.endpoint, "/v1/chat/completions");
    assert.equal(out.headers["x-omniroute-session-id"], "sess-1");
    assert.equal(out.headers["content-type"], "application/json");
    assert.ok("signal" in out);
  });

  test("the captured body is a snapshot — later mutation of the request body must not leak in", () => {
    // chatCore rewrites `body` downstream (plugin onRequest hook, compression). The captured
    // snapshot must not alias it, or the log would show post-mutation content.
    const body = { model: "m", messages: [{ role: "user", content: "original" }] };
    const captured = buildClientRawRequest(makeRequest(), body) as {
      body: { messages: { content: string }[] };
    };
    body.messages[0].content = "mutated by a downstream plugin";
    assert.equal(captured.body.messages[0].content, "original");
  });
});

describe("circuit-breaker-abort-provider-trip-7907", () => {
  /**
   * #7907/#7908 follow-up: two breaker-trip call sites bypass `isFailure`/
   * `shouldSkipConnDisable` and were purely status-code gated, so a client-side
   * abort (status defaults to 502, error='request_signal_aborted', no errorCode)
   * still tripped the whole-provider circuit breaker — the highest blast-radius
   * of the 3 resilience mechanisms — even though PR #7908 already fixed the
   * connection-cooldown half of the same bug via `shouldSkipConnDisable()`.
   *
   * This test exercises the two REAL predicates directly (not just the isolated
   * `isLocalStreamLifecycleError()` helper):
   *  - `shouldTripProviderBreakerForResult()` — single-model non-combo path,
   *    src/sse/handlers/chat.ts.
   *  - `shouldRecordProviderBreakerFailure()` — combo path,
   *    open-sse/services/combo/comboPredicates.ts (handleComboChat's executeTarget).
   */

  // The exact abort shape described in the PR body / issue #7907: no upstream
  // status arrives, so it defaults to 502, and the error surfaces as the bare
  // `request_signal_aborted` reason with no errorCode/errorType.
  const ABORT_RESULT = {
    status: 502,
    error: "request_signal_aborted",
  } as const;

  test("single-model breaker status guard accepts only provider-level failures", () => {
    assert.equal(isProviderBreakerFailureStatus(502), true);
    assert.equal(isProviderBreakerFailureStatus(429), false);
  });

  test("chat.ts single-model path: breaker stays CLOSED on a client abort (502 default, no errorCode)", () => {
    assert.equal(shouldTripProviderBreakerForResult(ABORT_RESULT, false, false), false);
  });

  test("chat.ts single-model path: genuine upstream 502s still trip the breaker", () => {
    assert.equal(
      shouldTripProviderBreakerForResult({ status: 502, error: "Bad Gateway" }, false, false),
      true
    );
  });

  test("chat.ts single-model path: combo/forceLiveComboTest requests are still excluded regardless of error shape", () => {
    assert.equal(shouldTripProviderBreakerForResult({ status: 502 }, true, false), false);
    assert.equal(shouldTripProviderBreakerForResult({ status: 502 }, false, true), false);
  });

  test("combo.ts handleComboChat path: breaker stays CLOSED on a client abort (502 default, message-based)", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 502,
        sameProviderNext: false,
        error: "request_signal_aborted",
      }),
      false
    );
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 502,
        sameProviderNext: false,
        error: "Client disconnected: request_signal_aborted",
      }),
      false
    );
  });

  test("combo.ts handleComboChat path: genuine upstream failures still trip the breaker", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 502,
        sameProviderNext: false,
        error: "upstream 502 Bad Gateway",
      }),
      true
    );
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 503,
        sameProviderNext: false,
      }),
      true
    );
  });
});
