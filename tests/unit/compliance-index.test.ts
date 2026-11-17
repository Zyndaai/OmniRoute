import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compliance-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_RETENTION_DAYS = "10";
process.env.CALL_LOG_RETENTION_DAYS = "5";

const core = await import("../../src/lib/db/core.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

async function resetDb() {
  await resetTestDb();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("compliance audit log initialization, writes and filtered reads work end to end", async () => {
  compliance.initAuditLog();
  await compliance.logAuditEvent({
    action: "settings.update",
    actor: "admin",
    target: "system-settings",
    details: { changed: ["theme"] },
    resourceType: "settings",
    status: "success",
    requestId: "req-123",
    ipAddress: "127.0.0.1",
  });
  await compliance.logAuditEvent({
    action: "apiKey.create",
    details: '"manual note"',
  });

  const all = await compliance.getAuditLog();
  const filtered = await compliance.getAuditLog({
    action: "settings.update",
    actor: "admin",
    limit: 1,
    offset: 0,
  });

  assert.equal(all.length, 2);
  assert.equal(all[0].action, "apiKey.create");
  assert.equal(all[0].actor, "system");
  assert.equal(all[0].details, "manual note");
  assert.equal(filtered[0].resourceType, "settings");
  assert.equal(filtered[0].resource_type, "settings");
  assert.equal(filtered[0].status, "success");
  assert.equal(filtered[0].requestId, "req-123");
  assert.equal(filtered[0].request_id, "req-123");
  assert.equal(filtered[0].ip, "127.0.0.1");
  assert.deepEqual(filtered[0].metadata, { changed: ["theme"] });
  assert.deepEqual(filtered, [
    {
      ...filtered[0],
      action: "settings.update",
      actor: "admin",
      target: "system-settings",
      details: { changed: ["theme"] },
      ip_address: "127.0.0.1",
    },
  ]);
});

test("compliance audit log supports structured filters, totals and secret redaction", async () => {
  compliance.initAuditLog();

  await compliance.logAuditEvent({
    action: "provider.credentials.updated",
    actor: "admin",
    target: "openai:primary",
    resourceType: "provider_credentials",
    status: "success",
    requestId: "req-provider-1",
    details: {
      apiKey: "sk-secret",
      nested: {
        refreshToken: "refresh-secret",
      },
      providerSpecificData: {
        extraApiKeys: ["sk-extra-1", "sk-extra-2"],
        token: "token-secret",
        userToken: "user-token-secret",
        cookie: "cookie-secret",
      },
      changedFields: ["defaultModel"],
    },
    ipAddress: "10.0.0.4",
    createdAt: "2026-04-14T10:00:00.000Z",
  });
  await compliance.logAuditEvent({
    action: "provider.validation.ssrf_blocked",
    actor: "admin",
    target: "provider-node",
    resourceType: "provider_validation",
    status: "blocked",
    requestId: "req-provider-2",
    metadata: {
      reason: "Blocked private or local provider URL",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    createdAt: "2026-04-14T11:00:00.000Z",
  });

  const filtered = await compliance.getAuditLog({
    resourceType: "provider_validation",
    status: "blocked",
    requestId: "req-provider-2",
    from: "2026-04-14T10:30:00.000Z",
    to: "2026-04-14T12:00:00.000Z",
  });

  assert.equal(await compliance.countAuditLog({ actor: "admin" }), 2);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].action, "provider.validation.ssrf_blocked");
  assert.deepEqual(filtered[0].metadata, {
    reason: "Blocked private or local provider URL",
    baseUrl: "http://127.0.0.1:11434/v1",
  });

  const updatedEntry = (await compliance.getAuditLog({ action: "provider.credentials.updated" }))[0];
  assert.deepEqual(updatedEntry.details, {
    apiKey: "[redacted]",
    nested: {
      refreshToken: "[redacted]",
    },
    providerSpecificData: {
      extraApiKeys: "[redacted]",
      token: "[redacted]",
      userToken: "[redacted]",
      cookie: "[redacted]",
    },
    changedFields: ["defaultModel"],
  });
  assert.deepEqual(updatedEntry.metadata, updatedEntry.details);
});

test("compliance noLog helpers cover missing ids, in-memory overrides and persisted DB values", async () => {
  const now = new Date().toISOString();
  const keyHash = createHash("sha256").update("sk-persisted").digest("hex");

  await getTestBackend().execute(
    `INSERT INTO api_keys (id, name, key, key_hash, machine_id, allowed_models, no_log, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    ["persisted-no-log", "Persisted", "sk-persisted", keyHash, null, "[]", true, now]
  );

  assert.equal(await compliance.isNoLog(""), false);
  assert.equal(await compliance.isNoLog("persisted-no-log"), true);

  compliance.setNoLog("manual-no-log", true);
  assert.equal(await compliance.isNoLog("manual-no-log"), true);

  compliance.setNoLog("manual-no-log", false);
  assert.equal(await compliance.isNoLog("manual-no-log"), false);
  assert.deepEqual(compliance.getRetentionDays(), { app: 10, call: 5 });
});

test("cleanupExpiredLogs removes stale rows across all log tables and records an audit entry", async () => {
  compliance.initAuditLog();
  const backend = getTestBackend();

  const oldCallTs = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const oldAppTs = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString();
  const freshTs = new Date().toISOString();

  await backend.execute("INSERT INTO usage_history (provider, model, timestamp) VALUES ($1, $2, $3)", [
    "openai",
    "gpt-4o",
    oldCallTs,
  ]);
  await backend.execute("INSERT INTO usage_history (provider, model, timestamp) VALUES ($1, $2, $3)", [
    "openai",
    "gpt-4o",
    freshTs,
  ]);

  await backend.execute(
    "INSERT INTO call_logs (id, timestamp, method, path) VALUES ($1, $2, $3, $4)",
    ["call-old", oldCallTs, "POST", "/v1/chat/completions"]
  );
  await backend.execute(
    "INSERT INTO call_logs (id, timestamp, method, path) VALUES ($1, $2, $3, $4)",
    ["call-new", freshTs, "POST", "/v1/chat/completions"]
  );

  await backend.execute(
    "INSERT INTO proxy_logs (id, timestamp, status, proxy_type) VALUES ($1, $2, $3, $4)",
    ["proxy-old", oldCallTs, "ok", "http"]
  );
  await backend.execute(
    "INSERT INTO proxy_logs (id, timestamp, status, proxy_type) VALUES ($1, $2, $3, $4)",
    ["proxy-new", freshTs, "ok", "http"]
  );

  await backend.execute("INSERT INTO mcp_tool_audit (tool_name, created_at) VALUES ($1, $2)", [
    "memory_search",
    oldAppTs,
  ]);
  await backend.execute("INSERT INTO mcp_tool_audit (tool_name, created_at) VALUES ($1, $2)", [
    "memory_add",
    freshTs,
  ]);

  await compliance.logAuditEvent({
    action: "admin.cleanup.seed",
    actor: "admin",
    details: { seeded: true },
  });
  await backend.execute('UPDATE audit_log SET "timestamp" = $1 WHERE action = $2', [
    oldAppTs,
    "admin.cleanup.seed",
  ]);

  const result = await compliance.cleanupExpiredLogs();
  const count = async (table: string) =>
    Number(
      (await backend.queryOne<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))?.count
    );
  const usageCount = await count("usage_history");
  const callCount = await count("call_logs");
  const proxyCount = await count("proxy_logs");
  const mcpAuditCount = await count("mcp_tool_audit");
  const auditEntries = await compliance.getAuditLog();
  const auditActions = auditEntries.map((entry) => entry.action);

  assert.deepEqual(result, {
    deletedUsage: 1,
    deletedCallLogs: 1,
    deletedProxyLogs: 1,
    // request_detail_logs was removed with the SQLite migration; the field stays for shape.
    deletedRequestDetailLogs: 0,
    deletedAuditLogs: 1,
    deletedMcpAuditLogs: 1,
    trimmedCallLogs: 0,
    trimmedProxyLogs: 0,
    appRetentionDays: 10,
    callRetentionDays: 5,
    callLogsMaxRows: result.callLogsMaxRows,
    proxyLogsMaxRows: result.proxyLogsMaxRows,
  });
  assert.equal(usageCount, 1);
  assert.equal(callCount, 1);
  assert.equal(proxyCount, 1);
  assert.equal(mcpAuditCount, 1);
  assert.ok(auditActions.includes("compliance.cleanup"));
  const cleanupEntry = auditEntries.find((entry) => entry.action === "compliance.cleanup");
  assert.equal(cleanupEntry.resourceType, "maintenance");
  assert.equal(cleanupEntry.status, "success");
  assert.equal(cleanupEntry.target, "log-retention");
});

test("cleanupExpiredLogs tolerates missing tables and logAuditEvent failures without breaking", async () => {
  compliance.initAuditLog();
  const backend = getTestBackend();

  // Rename (not drop) so the foreign keys and partitions of the other tables stay intact.
  for (const table of [
    "usage_history",
    "call_logs",
    "proxy_logs",
    "audit_log",
    "mcp_tool_audit",
  ]) {
    await backend.execute(`ALTER TABLE ${table} RENAME TO ${table}_gone`);
  }

  await compliance.logAuditEvent({
    action: "will.fail.silently",
    details: { reason: "table dropped" },
  });

  const result = await compliance.cleanupExpiredLogs();

  assert.deepEqual(result, {
    deletedUsage: 0,
    deletedCallLogs: 0,
    deletedProxyLogs: 0,
    deletedRequestDetailLogs: 0,
    deletedAuditLogs: 0,
    deletedMcpAuditLogs: 0,
    trimmedCallLogs: 0,
    trimmedProxyLogs: 0,
    appRetentionDays: 10,
    callRetentionDays: 5,
    callLogsMaxRows: result.callLogsMaxRows,
    proxyLogsMaxRows: result.proxyLogsMaxRows,
  });
});
