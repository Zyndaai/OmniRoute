import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Typed views over the raw rows / payload envelopes this suite inspects —
// keeps the assertions honest without @typescript-eslint/no-explicit-any (#12146).
type CallLogRow = {
  name?: string;
  cnt?: number;
  detail_state?: string | null;
  cache_source?: string | null;
  has_request_body?: boolean;
  has_response_body?: boolean;
  has_pipeline_details?: boolean;
  artifact_relpath?: string;
  artifact_size_bytes?: number;
  error_summary?: string | null;
};
type PayloadEnvelope = { body?: Record<string, unknown> };
type PayloadMap = { providerResponse?: PayloadEnvelope; clientResponse?: PayloadEnvelope };

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-artifacts-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
process.env.CALL_LOG_MAX_ENTRIES = "100";

const ORIGINAL_CALL_LOG_PIPELINE_MAX_SIZE_KB = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;

const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function restorePipelineEnv() {
  if (ORIGINAL_CALL_LOG_PIPELINE_MAX_SIZE_KB === undefined) {
    delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  } else {
    process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = ORIGINAL_CALL_LOG_PIPELINE_MAX_SIZE_KB;
  }
}

const one = (sql: string, params: unknown[]) =>
  getTestBackend().queryOne<CallLogRow>(sql, params) as Promise<CallLogRow>;

async function insertCallLog(row) {
  const r = {
    requested_model: null,
    connection_id: null,
    duration: 0,
    tokens_in: 0,
    tokens_out: 0,
    cache_source: "upstream",
    source_format: null,
    target_format: null,
    api_key_id: null,
    api_key_name: null,
    combo_name: null,
    combo_step_id: null,
    combo_execution_key: null,
    error_summary: null,
    detail_state: "none",
    artifact_relpath: null,
    artifact_size_bytes: null,
    artifact_sha256: null,
    has_request_body: false,
    has_response_body: false,
    has_pipeline_details: false,
    request_summary: null,
    ...row,
  };
  await getTestBackend().execute(
    `
    INSERT INTO call_logs (
      id, "timestamp", method, path, status, model, requested_model, provider, account,
      connection_id, duration, tokens_in, tokens_out, cache_source, source_format, target_format,
      api_key_id, api_key_name, combo_name, combo_step_id, combo_execution_key,
      error_summary, detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256,
      has_request_body, has_response_body, has_pipeline_details, request_summary
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21,
      $22, $23, $24, $25, $26,
      $27, $28, $29, $30
    )
  `,
    [
      r.id,
      r.timestamp,
      r.method,
      r.path,
      r.status,
      r.model,
      r.requested_model,
      r.provider,
      r.account,
      r.connection_id,
      r.duration,
      r.tokens_in,
      r.tokens_out,
      r.cache_source,
      r.source_format,
      r.target_format,
      r.api_key_id,
      r.api_key_name,
      r.combo_name,
      r.combo_step_id,
      r.combo_execution_key,
      r.error_summary,
      r.detail_state,
      r.artifact_relpath,
      r.artifact_size_bytes,
      r.artifact_sha256,
      r.has_request_body,
      r.has_response_body,
      r.has_pipeline_details,
      r.request_summary,
    ]
  );
}

test.beforeEach(async () => {
  restorePipelineEnv();
  process.env.CALL_LOG_RETENTION_DAYS = "3650";
  await resetStorage();
});

test.after(async () => {
  restorePipelineEnv();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("saveCallLog stores only summary metadata in SQLite and writes detailed artifact", async () => {
  const timestamp = "2026-03-30T12:34:56.789Z";
  const logId = "req_artifact_1";

  await callLogs.saveCallLog({
    id: logId,
    timestamp,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    requestedModel: "openai/gpt-5",
    provider: "openai",
    cacheSource: "semantic",
    duration: 42,
    comboName: "combo-a",
    comboStepId: "step-openai-a",
    comboExecutionKey: "combo-a:0:step-openai-a",
    requestBody: { messages: [{ role: "user", content: "hello" }] },
    responseBody: { id: "resp_1", choices: [{ message: { content: "world" } }] },
    pipelinePayloads: {
      clientRawRequest: { body: { raw: true } },
      providerRequest: { body: { translated: true } },
      providerResponse: { body: { upstream: true } },
      clientResponse: { body: { final: true } },
    },
  });

  const logs = await callLogs.getCallLogs({ limit: 5 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].hasRequestBody, true);
  assert.equal(logs[0].hasResponseBody, true);
  assert.equal(logs[0].hasPipelineDetails, true);
  assert.equal(logs[0].detailState, "ready");

  const detail = await callLogs.getCallLogById(logId);
  assert.equal(detail?.requestedModel, "openai/gpt-5");
  assert.equal(detail?.cacheSource, "semantic");
  assert.equal(detail?.comboName, "combo-a");
  assert.equal(detail?.comboStepId, "step-openai-a");
  assert.equal(detail?.comboExecutionKey, "combo-a:0:step-openai-a");
  assert.equal(detail?.pipelinePayloads?.clientRawRequest?.body?.raw, true);
  assert.equal(
    (detail?.pipelinePayloads?.providerRequest as PayloadEnvelope | undefined)?.body?.translated,
    true
  );
  assert.equal(
    (detail?.pipelinePayloads as PayloadMap | undefined)?.providerResponse?.body?.upstream,
    true
  );
  assert.equal(
    (detail?.pipelinePayloads as PayloadMap | undefined)?.clientResponse?.body?.final,
    true
  );
  assert.match(
    detail?.artifactRelPath || "",
    /^2026-03-30\/2026-03-30T12-34-56\.789Z_req_artifact_1\.json$/
  );

  const columns = (
    await getTestBackend().query<CallLogRow>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'"
    )
  ).map((row) => row.name);
  assert.ok(columns.length > 0);
  assert.equal(columns.includes("request_body"), false);
  assert.equal(columns.includes("response_body"), false);
  assert.equal(columns.includes("error"), false);

  const summaryRow = await one(
    `
      SELECT detail_state, artifact_relpath, cache_source, has_request_body, has_response_body, has_pipeline_details
      FROM call_logs WHERE id = $1
    `,
    [logId]
  );
  assert.equal(summaryRow.detail_state, "ready");
  assert.equal(summaryRow.cache_source, "semantic");
  assert.equal(summaryRow.has_request_body, true);
  assert.equal(summaryRow.has_response_body, true);
  assert.equal(summaryRow.has_pipeline_details, true);
  assert.equal(typeof summaryRow.artifact_relpath, "string");

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", detail.artifactRelPath);
  const serializedArtifact = fs.readFileSync(artifactPath, "utf8");
  const artifact = JSON.parse(serializedArtifact);
  assert.equal(Buffer.byteLength(serializedArtifact), detail.artifactSizeBytes);
  assert.match(detail.artifactSha256 || "", /^[0-9a-f]{8}$/);
  assert.equal(artifact.summary.id, logId);
  assert.equal(artifact.summary.requestedModel, "openai/gpt-5");
  assert.equal(artifact.summary.comboExecutionKey, "combo-a:0:step-openai-a");
});

test("getCallLogs resolves raw account labels from provider connections", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "logs.user@example.com",
    email: "logs.user@example.com",
    accessToken: "token",
  });

  await insertCallLog({
    id: "masked-account-log",
    timestamp: "2026-03-30T12:34:56.789Z",
    method: "POST",
    path: "/v1/responses",
    status: 200,
    model: "gpt-5.5",
    requested_model: "codex/gpt-5.5",
    provider: "codex",
    account: "log******@********com",
    connection_id: connection.id,
  });

  const logs = await callLogs.getCallLogs({ account: "logs.user@example.com", limit: 10 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].account, "logs.user@example.com");

  const detail = await callLogs.getCallLogById("masked-account-log");
  assert.equal(detail?.account, "logs.user@example.com");
});

test("rotateCallLogs removes expired rows and orphaned artifacts but keeps fresh referenced artifacts", async () => {
  process.env.CALL_LOG_RETENTION_DAYS = "1";
  const oldRelPath = "2026-03-10/2026-03-10T00-00-00.000Z_old.json";
  const oldAbsPath = path.join(TEST_DATA_DIR, "call_logs", oldRelPath);
  fs.mkdirSync(path.dirname(oldAbsPath), { recursive: true });
  fs.writeFileSync(oldAbsPath, JSON.stringify({ schemaVersion: 4 }, null, 2));

  await insertCallLog({
    id: "expired-log",
    timestamp: "2026-03-10T00:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    account: "Expired",
    detail_state: "ready",
    artifact_relpath: oldRelPath,
    has_request_body: true,
  });

  await callLogs.saveCallLog({
    id: "fresh-log",
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    requestBody: { ok: true },
  });

  const freshRow = await one("SELECT artifact_relpath FROM call_logs WHERE id = $1", [
    "fresh-log",
  ]);
  const freshAbsPath = path.join(TEST_DATA_DIR, "call_logs", freshRow.artifact_relpath);

  assert.equal(
    (await one("SELECT COUNT(*) AS cnt FROM call_logs WHERE id = $1", ["expired-log"])).cnt,
    1
  );
  assert.equal(fs.existsSync(oldAbsPath), true);
  assert.equal(fs.existsSync(freshAbsPath), true);

  await callLogs.rotateCallLogs();

  assert.equal(
    (await one("SELECT COUNT(*) AS cnt FROM call_logs WHERE id = $1", ["expired-log"])).cnt,
    0
  );
  assert.equal(fs.existsSync(oldAbsPath), false);
  assert.equal(
    (await one("SELECT COUNT(*) AS cnt FROM call_logs WHERE id = $1", ["fresh-log"])).cnt,
    1
  );
  assert.equal(fs.existsSync(freshAbsPath), true);

  const orphanDir = path.join(TEST_DATA_DIR, "call_logs", "2026-03-31");
  const orphanFile = path.join(orphanDir, "orphan.json");
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(orphanFile, "{}");
  await callLogs.cleanupOrphanCallLogFiles();
  assert.equal(fs.existsSync(orphanFile), false);

  process.env.CALL_LOG_RETENTION_DAYS = "3650";
});

test("getCallLogs applies provider, account, apiKey, combo, search, and status filters with summary fields", async () => {
  await insertCallLog({
    id: "filter-hit",
    timestamp: "2026-03-30T12:34:56.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    requested_model: "openai/gpt-5",
    provider: "openai",
    account: "Primary Account",
    connection_id: "conn-1",
    duration: 42,
    tokens_in: 11,
    tokens_out: 7,
    source_format: "openai",
    target_format: "openai",
    api_key_id: "key-1",
    api_key_name: "Primary Key",
    combo_name: "combo-a",
    combo_step_id: "step-a",
    combo_execution_key: "combo-a:0:step-a",
    has_request_body: true,
  });
  await insertCallLog({
    id: "filter-miss",
    timestamp: "2026-03-30T12:35:56.000Z",
    method: "POST",
    path: "/v1/embeddings",
    status: 200,
    model: "gemini/text-embedding",
    provider: "gemini",
    account: "Backup Account",
    connection_id: "conn-2",
    duration: 9,
    tokens_in: 3,
    tokens_out: 1,
    source_format: "openai",
    target_format: "gemini",
    api_key_id: "key-2",
    api_key_name: "Backup Key",
  });
  await insertCallLog({
    id: "status-error-by-message",
    timestamp: "2026-03-30T12:36:56.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    account: "Primary Account",
    error_summary: "synthetic failure",
  });
  await insertCallLog({
    id: "status-error",
    timestamp: "2026-03-30T12:37:56.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 500,
    model: "openai/gpt-4.1",
    provider: "openai",
    account: "Primary Account",
  });

  assert.deepEqual(
    (await callLogs.getCallLogs({ provider: "openai" })).map((row) => row.id),
    ["status-error", "status-error-by-message", "filter-hit"]
  );
  assert.deepEqual(
    (await callLogs.getCallLogs({ account: "primary" })).map((row) => row.id),
    ["status-error", "status-error-by-message", "filter-hit"]
  );
  assert.deepEqual(
    (await callLogs.getCallLogs({ apiKey: "Primary" })).map((row) => row.id),
    ["filter-hit"]
  );
  assert.deepEqual(
    (await callLogs.getCallLogs({ combo: true })).map((row) => row.id),
    ["filter-hit"]
  );
  assert.deepEqual(
    (await callLogs.getCallLogs({ search: "gpt-5" })).map((row) => row.id),
    ["filter-hit"]
  );
  assert.deepEqual(
    (await callLogs.getCallLogs({ status: "error" })).map((row) => row.id),
    ["status-error", "status-error-by-message"]
  );
  assert.deepEqual(
    (await callLogs.getCallLogs({ status: "ok" })).map((row) => row.id),
    ["status-error-by-message", "filter-miss", "filter-hit"]
  );
});

test("getCallLogById marks missing artifacts explicitly and clears stale DB pointers", async () => {
  await insertCallLog({
    id: "missing-artifact",
    timestamp: "2026-03-30T12:34:56.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    account: "Primary Account",
    detail_state: "ready",
    artifact_relpath: "2026-03-30/missing.json",
    has_request_body: true,
  });

  const detail = await callLogs.getCallLogById("missing-artifact");
  assert.equal(detail?.detailState, "missing");
  assert.equal(detail?.requestBody, null);

  const row = await one(
    "SELECT artifact_relpath, detail_state FROM call_logs WHERE id = $1",
    ["missing-artifact"]
  );
  assert.equal(row.artifact_relpath, null);
  assert.equal(row.detail_state, "missing");
});

test("saveCallLog keeps large payloads out of the database while preserving explicit detail export", async () => {
  const requestBody = { payload: "x".repeat(320 * 1024) };

  await callLogs.saveCallLog({
    id: "artifact-only-large-payload",
    timestamp: "2026-03-31T09:05:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 500,
    model: "openai/gpt-4.1",
    provider: "openai",
    duration: 7,
    requestType: "search",
    requestBody,
    error: "upstream unavailable",
  });

  const row = await one(
    `
      SELECT detail_state, has_request_body, artifact_relpath, error_summary, request_summary
      FROM call_logs WHERE id = $1
    `,
    ["artifact-only-large-payload"]
  );
  assert.equal(row.detail_state, "ready");
  assert.equal(row.has_request_body, true);
  assert.equal(typeof row.artifact_relpath, "string");
  assert.equal(row.error_summary, "upstream unavailable");

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.requestBody.payload.length, requestBody.payload.length);

  const detail = await callLogs.getCallLogById("artifact-only-large-payload");
  assert.equal(detail?.requestBody?.payload.length, requestBody.payload.length);

  const exported = await callLogs.exportCallLogsSince("2026-03-31T00:00:00.000Z");
  assert.equal(exported.length, 1);
  assert.equal(
    (exported[0] as { requestBody: { payload: string } }).requestBody.payload.length,
    requestBody.payload.length
  );
});

test("saveCallLog truncates oversized call log artifacts for storage", async () => {
  const hugeChunk = "x".repeat(600 * 1024);

  await callLogs.saveCallLog({
    id: "truncated-artifact",
    timestamp: "2026-03-31T10:05:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    requestBody: { payload: "request" },
    responseBody: { output: "response" },
    pipelinePayloads: {
      streamChunks: {
        provider: [hugeChunk],
        openai: [hugeChunk],
        client: [hugeChunk],
      },
    },
  });

  const row = await one(
    `
      SELECT artifact_relpath, artifact_size_bytes, detail_state
      FROM call_logs WHERE id = $1
    `,
    ["truncated-artifact"]
  );
  assert.equal(row.detail_state, "ready");
  assert.ok(row.artifact_size_bytes <= 512 * 1024);

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.deepEqual(artifact.requestBody, { payload: "request" });
  assert.deepEqual(artifact.responseBody, { output: "response" });
  assert.equal(artifact.error, null);
  assert.deepEqual(artifact.pipeline.streamChunks, {
    provider: ["[stream chunks omitted: call log artifact size limit exceeded]"],
    openai: ["[stream chunks omitted: call log artifact size limit exceeded]"],
    client: ["[stream chunks omitted: call log artifact size limit exceeded]"],
  });
});

test("saveCallLog omits oversized non-stream pipeline payloads to enforce artifact cap", async () => {
  const hugePayload = "x".repeat(600 * 1024);

  await callLogs.saveCallLog({
    id: "truncated-pipeline-artifact",
    timestamp: "2026-03-31T10:06:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    requestBody: { payload: "request" },
    responseBody: { output: "response" },
    pipelinePayloads: {
      providerRequest: { body: hugePayload },
      providerResponse: { body: hugePayload },
    },
  });

  const row = await one(
    `
      SELECT artifact_relpath, artifact_size_bytes, detail_state
      FROM call_logs WHERE id = $1
    `,
    ["truncated-pipeline-artifact"]
  );
  assert.equal(row.detail_state, "ready");
  assert.ok(row.artifact_size_bytes <= 512 * 1024);

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.deepEqual(artifact.requestBody, { payload: "request" });
  assert.deepEqual(artifact.responseBody, { output: "response" });
  assert.deepEqual(artifact.pipeline, {
    error: {
      _omniroute_truncated: true,
      reason: "call_log_artifact_size_limit_exceeded",
    },
  });
});

test("saveCallLog honors CALL_LOG_PIPELINE_MAX_SIZE_KB for pipeline artifacts", async () => {
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "8";
  const hugePayload = "x".repeat(32 * 1024);

  await callLogs.saveCallLog({
    id: "configured-pipeline-artifact-cap",
    timestamp: "2026-03-31T10:07:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    requestBody: { payload: "request" },
    responseBody: { output: "response" },
    pipelinePayloads: {
      providerRequest: { body: hugePayload },
      providerResponse: { body: hugePayload },
    },
  });

  const row = await one(
    `
      SELECT artifact_relpath, artifact_size_bytes, detail_state
      FROM call_logs WHERE id = $1
    `,
    ["configured-pipeline-artifact-cap"]
  );
  assert.equal(row.detail_state, "ready");
  assert.ok(row.artifact_size_bytes <= 8 * 1024);

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.deepEqual(artifact.pipeline, {
    error: {
      _omniroute_truncated: true,
      reason: "call_log_artifact_size_limit_exceeded",
    },
  });
});

test("saveCallLog falls back to a compact sentinel when the configured cap is very small", async () => {
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "1";
  const hugePayload = "x".repeat(32 * 1024);

  await callLogs.saveCallLog({
    id: "tiny-pipeline-artifact-cap",
    timestamp: "2026-03-31T10:07:30.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: `openai/${"gpt".repeat(512)}`,
    provider: "openai",
    requestBody: { payload: "request" },
    responseBody: { output: "response" },
    pipelinePayloads: {
      providerRequest: { body: hugePayload },
      providerResponse: { body: hugePayload },
    },
  });

  const row = await one(
    `
      SELECT artifact_relpath, artifact_size_bytes, detail_state
      FROM call_logs WHERE id = $1
    `,
    ["tiny-pipeline-artifact-cap"]
  );
  assert.equal(row.detail_state, "ready");
  assert.ok(row.artifact_size_bytes <= 1024);

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.deepEqual(artifact, {
    schemaVersion: 5,
    _omniroute_truncated: true,
    reason: "call_log_artifact_size_limit_exceeded",
    error: null,
  });
});

test("saveCallLog preserves a truncated error in size-limit-fallback artifacts (opencode-go 504 diagnosability)", async () => {
  // Regression: the minimal size-limit fallback used to replace the error
  // with "[omitted: call log artifact size limit exceeded]", wiping the only
  // field that explains WHY the request failed. The error must survive.
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "1";
  const hugePayload = "x".repeat(64 * 1024);
  const upstreamError =
    "[504]: Fetch timeout after 110000ms on https://opencode.ai/zen/go/v1/chat/completions";

  await callLogs.saveCallLog({
    id: "tiny-cap-preserves-error",
    timestamp: "2026-03-31T10:08:30.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 504,
    model: `openai/${"gpt".repeat(512)}`,
    provider: "opencode-go",
    requestBody: { payload: "request" },
    responseBody: { output: "response" },
    error: upstreamError,
    pipelinePayloads: {
      providerRequest: { body: hugePayload },
      providerResponse: { body: hugePayload },
    },
  });

  const row = await one(
    `
      SELECT artifact_relpath, artifact_size_bytes, detail_state
      FROM call_logs WHERE id = $1
    `,
    ["tiny-cap-preserves-error"]
  );
  assert.equal(row.detail_state, "ready");

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(
    artifact.error,
    upstreamError,
    "the upstream error must be preserved verbatim in the fallback artifact"
  );
  assert.equal(artifact._omniroute_truncated, true);
  assert.equal(
    artifact.requestBody,
    undefined,
    "oversized bodies must be dropped, but the error must survive"
  );
});

test("CALL_LOG_PIPELINE_MAX_SIZE_KB does not cap artifacts without pipeline details", async () => {
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "8";
  const requestBody = { payload: "x".repeat(16 * 1024) };

  await callLogs.saveCallLog({
    id: "non-pipeline-artifact-ignores-pipeline-cap",
    timestamp: "2026-03-31T10:08:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    requestBody,
    responseBody: { output: "response" },
  });

  const row = await one(
    `
      SELECT artifact_relpath, artifact_size_bytes, detail_state
      FROM call_logs WHERE id = $1
    `,
    ["non-pipeline-artifact-ignores-pipeline-cap"]
  );
  assert.equal(row.detail_state, "ready");
  assert.ok(row.artifact_size_bytes > 8 * 1024);

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.requestBody.payload.length, requestBody.payload.length);
});

test("saveCallLog logs and returns when database persistence throws unexpectedly", async () => {
  const db = getTestBackend();
  const originalExecute = db.execute;
  const originalConsoleError = console.error;
  const consoleCalls = [];

  db.execute = ((sql: string, ...rest: unknown[]) => {
    if (/INSERT INTO call_logs/.test(sql)) {
      return Promise.reject(new Error("simulated sqlite prepare failure"));
    }
    return (originalExecute as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.execute;
  console.error = (...args) => {
    consoleCalls.push(args.join(" "));
  };

  try {
    await assert.doesNotReject(() =>
      callLogs.saveCallLog({
        id: "prepare-failure",
        timestamp: "2026-03-30T12:40:00Z",
        method: "POST",
        path: "/v1/chat/completions",
        status: 200,
        model: "openai/gpt-4.1",
        provider: "openai",
        duration: 1,
      })
    );
  } finally {
    db.execute = originalExecute;
    console.error = originalConsoleError;
  }

  assert.equal(consoleCalls.length, 1);
  assert.match(consoleCalls[0], /Failed to save call log/);
  assert.match(consoleCalls[0], /simulated sqlite prepare failure/);
});

test("getCallLogs and getCallLogById expose combo target identifiers", async () => {
  await callLogs.saveCallLog({
    id: "combo-target-log",
    timestamp: "2026-03-31T08:15:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 503,
    model: "openai/gpt-4o-mini",
    requestedModel: "router-fixed-accounts",
    provider: "openai",
    connectionId: "conn-fixed-2",
    comboName: "router-fixed-accounts",
    comboStepId: "step-openai-secondary",
    comboExecutionKey: "router-fixed-accounts:1:step-openai-secondary",
    error: "upstream unavailable",
  });

  const logs = await callLogs.getCallLogs({ search: "step-openai-secondary" });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].comboStepId, "step-openai-secondary");
  assert.equal(logs[0].comboExecutionKey, "router-fixed-accounts:1:step-openai-secondary");

  const detail = await callLogs.getCallLogById("combo-target-log");
  assert.equal(detail?.comboName, "router-fixed-accounts");
  assert.equal(detail?.comboStepId, "step-openai-secondary");
  assert.equal(detail?.comboExecutionKey, "router-fixed-accounts:1:step-openai-secondary");
});
