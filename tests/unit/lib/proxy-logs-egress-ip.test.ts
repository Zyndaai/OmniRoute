import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Persistence to the database only runs when shouldPersistToDisk is true
// (local mode: !isCloud). Setting DATA_DIR to a fresh temp
// dir keeps the test in local mode; the assertions below would otherwise fail
// with no explanatory guard.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-egress-ip-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const core = await import("../../../src/lib/db/core.ts");
const proxyLogger = await import("../../../src/lib/proxyLogger.ts");

// Fresh DB + fresh in-memory buffer per test (mirrors
// proxy-logger-client-ip.test.ts). clearProxyLogs() runs BEFORE the DB reset
// so queued rows are not written into the fresh database.
async function resetStorage() {
  await proxyLogger.clearProxyLogs();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function latestEgressIp(): Promise<string | null | undefined> {
  const row = await getTestBackend().queryOne<{ egress_ip: string | null }>(
    `SELECT egress_ip FROM proxy_logs ORDER BY "timestamp" DESC LIMIT 1`
  );
  return row?.egress_ip;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("logProxyEvent persists egressIp into proxy_logs.egress_ip", async () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "codex",
    targetUrl: "codex/gpt-5.5",
    egressIp: "203.0.113.9",
  });
  await proxyLogger.flushProxyLogsSync(); // persist the enqueued batch before the read
  assert.equal(await latestEgressIp(), "203.0.113.9");
});

test("egress_ip survives a DB close/reopen cycle (on-disk)", async () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "openai",
    egressIp: "198.51.100.7",
  });
  await proxyLogger.flushProxyLogsSync(); // persist to disk BEFORE the close/reopen cycle
  await core.resetDbInstance();
  assert.equal(await latestEgressIp(), "198.51.100.7");
});

test("egress_ip is NULL when not provided (never synthesized)", async () => {
  proxyLogger.logProxyEvent({ status: "success", provider: "claude" });
  await proxyLogger.flushProxyLogsSync(); // persist the enqueued batch before the read
  assert.equal(await latestEgressIp(), null);
});

test("getProxyLogs search matches the egress IP", () => {
  proxyLogger.logProxyEvent({ status: "success", provider: "codex", egressIp: "203.0.113.55" });
  const [log] = proxyLogger.getProxyLogs({ search: "203.0.113.55" });
  assert.ok(log, "expected a matching log");
  assert.equal(log.egressIp, "203.0.113.55");
});
