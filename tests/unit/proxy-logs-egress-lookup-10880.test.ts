import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #10460/#10525: DATA_DIR must be assigned BEFORE any transitive DB import —
// core.ts captures resolveWritableDataDir at module-load time.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-egress-lookup-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const core = await import("../../src/lib/db/core.ts");
const proxyLogger = await import("../../src/lib/proxyLogger.ts");
const { getRecentEgressIpForConnection } = await import("../../src/lib/db/proxyLogs.ts");

async function resetStorage() {
  await proxyLogger.clearProxyLogs();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => resetStorage());
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("returns the LAST known egress IP of the connection in the window", async () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "opencode",
    targetUrl: "https://api.opencode.ai/chat",
    egressIp: "203.0.113.7",
    connectionId: "conn-a",
  });
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "opencode",
    targetUrl: "https://api.opencode.ai/chat",
    egressIp: "203.0.113.9",
    connectionId: "conn-a",
  });
  await proxyLogger.flushProxyLogsSync(); // persist the enqueued batch before the DB-backed lookup
  const got = await getRecentEgressIpForConnection(
    "conn-a",
    new Date(Date.now() - 24 * 3600_000).toISOString()
  );
  assert.deepEqual(got, { egressIp: "203.0.113.9", at: got!.at });
});

test("ignores rows with NULL egress_ip (never probed)", async () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "opencode",
    targetUrl: "https://api.opencode.ai/chat",
    egressIp: null,
    connectionId: "conn-b",
  });
  await proxyLogger.flushProxyLogsSync();
  assert.equal(
    await getRecentEgressIpForConnection("conn-b", new Date(Date.now() - 24 * 3600_000).toISOString()),
    null
  );
});

test("returns null when the connection has no row in the window", async () => {
  assert.equal(
    await getRecentEgressIpForConnection(
      "ghost-conn",
      new Date(Date.now() - 24 * 3600_000).toISOString()
    ),
    null
  );
});

test("does not return rows outside the since window", async () => {
  // logProxyEvent forces timestamp = now (proxyLogger.ts) — insert the old
  // row via raw SQL to control the timestamp.
  await getTestBackend().execute(
    `INSERT INTO proxy_logs (id, "timestamp", status, provider, target_url, egress_ip, connection_id)
     VALUES ($1, $2, 'success', 'opencode', 'https://api.opencode.ai/chat', '203.0.113.1', 'conn-c')`,
    [randomUUID(), new Date(Date.now() - 48 * 3600_000).toISOString()]
  );
  assert.equal(
    await getRecentEgressIpForConnection(
      "conn-c",
      new Date(Date.now() - 24 * 3600_000).toISOString()
    ),
    null
  );
});
