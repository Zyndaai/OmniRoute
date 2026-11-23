import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-log-retention-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_RETENTION_DAYS = "2";
process.env.CALL_LOG_RETENTION_DAYS = "1";
process.env.CALL_LOGS_TABLE_MAX_ROWS = "5";
process.env.PROXY_LOGS_TABLE_MAX_ROWS = "5";

const core = await import("../../../src/lib/db/core.ts");
const { db } = await import("../../../src/lib/db/pg.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const compliance = await import("../../../src/lib/compliance/index.ts");

async function countRows(table: string): Promise<number> {
  const row = await db().queryOne<{ cnt: number }>(`SELECT COUNT(*)::int AS cnt FROM ${table}`);
  return row?.cnt ?? 0;
}

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  await core.resetDbInstance();
});

test("cleanupExpiredLogs uses separate APP and CALL retention windows", async () => {
  compliance.initAuditLog();

  const oldCallTs = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const freshCallTs = new Date().toISOString();
  const oldAppTs = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const freshAppTs = new Date().toISOString();

  await db().execute(
    "INSERT INTO usage_history (provider, model, tokens_input, tokens_output, success, latency_ms, ttft_ms, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    ["openai", "old-usage", 1, 1, true, 1, 1, oldCallTs]
  );
  await db().execute(
    "INSERT INTO usage_history (provider, model, tokens_input, tokens_output, success, latency_ms, ttft_ms, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    ["openai", "fresh-usage", 1, 1, true, 1, 1, freshCallTs]
  );

  await db().execute(
    "INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, account, duration, tokens_in, tokens_out, has_pipeline_details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [
      "old-call",
      oldCallTs,
      "POST",
      "/v1/chat/completions",
      200,
      "old",
      "openai",
      "-",
      1,
      1,
      1,
      false,
    ]
  );
  await db().execute(
    "INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, account, duration, tokens_in, tokens_out, has_pipeline_details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [
      "fresh-call",
      freshCallTs,
      "POST",
      "/v1/chat/completions",
      200,
      "fresh",
      "openai",
      "-",
      1,
      1,
      1,
      false,
    ]
  );

  await db().execute(
    "INSERT INTO proxy_logs (id, timestamp, status, level, latency_ms) VALUES ($1, $2, $3, $4, $5)",
    ["old-proxy", oldCallTs, "success", "direct", 1]
  );
  await db().execute(
    "INSERT INTO proxy_logs (id, timestamp, status, level, latency_ms) VALUES ($1, $2, $3, $4, $5)",
    ["fresh-proxy", freshCallTs, "success", "direct", 1]
  );

  await db().execute("INSERT INTO audit_log (timestamp, action, actor) VALUES ($1, $2, $3)", [
    oldAppTs,
    "old-audit",
    "system",
  ]);
  await db().execute("INSERT INTO audit_log (timestamp, action, actor) VALUES ($1, $2, $3)", [
    freshAppTs,
    "fresh-audit",
    "system",
  ]);

  await db().execute(
    "INSERT INTO mcp_tool_audit (tool_name, success, created_at) VALUES ($1, $2, $3)",
    ["old-tool", true, oldAppTs]
  );
  await db().execute(
    "INSERT INTO mcp_tool_audit (tool_name, success, created_at) VALUES ($1, $2, $3)",
    ["fresh-tool", true, freshAppTs]
  );

  const result = await compliance.cleanupExpiredLogs();

  assert.equal(result.deletedUsage, 1);
  assert.equal(result.deletedCallLogs, 1);
  assert.equal(result.deletedProxyLogs, 1);
  // request_detail_logs no longer exists; the result keeps the field at 0.
  assert.equal(result.deletedRequestDetailLogs, 0);
  assert.equal(result.deletedAuditLogs, 1);
  assert.equal(result.deletedMcpAuditLogs, 1);
  assert.deepEqual(compliance.getRetentionDays(), { app: 2, call: 1 });

  assert.equal(await countRows("usage_history"), 1);
  assert.equal(await countRows("call_logs"), 1);
  assert.equal(await countRows("proxy_logs"), 1);
  assert.equal(await countRows("audit_log"), 2);
  assert.equal(await countRows("mcp_tool_audit"), 1);
});

test("cleanupExpiredLogs honors the dashboard usageHistory retention when env is unset (#4354)", async () => {
  // Operator did NOT set the retention env vars; the dashboard configured 90 days.
  // The startup cleanup must respect the dashboard value, not the 7-day env default.
  // The dashboard saves retention in config_entries('databaseSettings', 'retention.<name>').
  const savedCall = process.env.CALL_LOG_RETENTION_DAYS;
  const savedApp = process.env.APP_LOG_RETENTION_DAYS;
  delete process.env.CALL_LOG_RETENTION_DAYS;
  delete process.env.APP_LOG_RETENTION_DAYS;
  try {
    compliance.initAuditLog();
    for (const name of ["usageHistory", "callLogs"]) {
      await db().execute(
        `INSERT INTO config_entries (namespace, key, value)
         VALUES ('databaseSettings', $1, $2::jsonb)
         ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
        [`retention.${name}`, "90"]
      );
    }

    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db().execute(
      "INSERT INTO usage_history (provider, model, tokens_input, tokens_output, success, latency_ms, ttft_ms, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      ["openai", "old-usage", 1, 1, true, 1, 1, oldTs]
    );

    const result = await compliance.cleanupExpiredLogs();

    // 30 days < the configured 90-day dashboard retention → must be kept.
    // With the old env-default (7d) behavior this row would be deleted.
    assert.equal(
      result.deletedUsage,
      0,
      "30-day usage_history must survive a 90-day dashboard retention"
    );
    assert.equal(await countRows("usage_history"), 1);
  } finally {
    if (savedCall !== undefined) process.env.CALL_LOG_RETENTION_DAYS = savedCall;
    else delete process.env.CALL_LOG_RETENTION_DAYS;
    if (savedApp !== undefined) process.env.APP_LOG_RETENTION_DAYS = savedApp;
    else delete process.env.APP_LOG_RETENTION_DAYS;
  }
});

test("cleanupExpiredLogs enforces row count limits", async () => {
  compliance.initAuditLog();

  const now = new Date().toISOString();

  for (let i = 0; i < 10; i++) {
    await db().execute(
      "INSERT INTO call_logs (id, timestamp, method, path, status, model, provider, account, duration, tokens_in, tokens_out, has_pipeline_details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
      [`call-${i}`, now, "POST", "/v1/chat/completions", 200, "model", "provider", "-", 1, 1, 1, false]
    );
  }

  for (let i = 0; i < 10; i++) {
    await db().execute(
      "INSERT INTO proxy_logs (id, timestamp, status, level, latency_ms) VALUES ($1, $2, $3, $4, $5)",
      [`proxy-${i}`, now, "success", "direct", 1]
    );
  }

  assert.equal(await countRows("call_logs"), 10);
  assert.equal(await countRows("proxy_logs"), 10);

  const result = await compliance.cleanupExpiredLogs();

  assert.equal(result.trimmedCallLogs, 5);
  assert.equal(result.trimmedProxyLogs, 5);
  assert.equal(result.callLogsMaxRows, 5);
  assert.equal(result.proxyLogsMaxRows, 5);

  assert.equal(await countRows("call_logs"), 5);
  assert.equal(await countRows("proxy_logs"), 5);
});

test("getCallLogsTableMaxRows returns configured value", async () => {
  const { getCallLogsTableMaxRows, getProxyLogsTableMaxRows } =
    await import("../../../src/lib/logEnv.ts");

  assert.equal(getCallLogsTableMaxRows(), 5);
  assert.equal(getProxyLogsTableMaxRows(), 5);
});

test("call log pipeline env helpers parse stream chunk flag and size cap", async () => {
  const originalCapture = process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS;
  const originalMaxSize = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  const { getCallLogPipelineCaptureStreamChunks, getCallLogPipelineMaxSizeBytes } =
    await import("../../../src/lib/logEnv.ts");

  try {
    process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = "false";
    process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "256";

    assert.equal(getCallLogPipelineCaptureStreamChunks(), false);
    assert.equal(getCallLogPipelineMaxSizeBytes(), 256 * 1024);
  } finally {
    if (originalCapture === undefined) {
      delete process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS;
    } else {
      process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = originalCapture;
    }

    if (originalMaxSize === undefined) {
      delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
    } else {
      process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = originalMaxSize;
    }
  }
});
