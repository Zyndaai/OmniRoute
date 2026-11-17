import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-write-lifecycle-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";

const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const { getTestBackend } = await import("../../helpers/postgres.ts");

test.after(async () => {
  await callLogs.closeCallLogSaves();
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Hold a SHARE lock on a table from a second connection until released. SHARE blocks
 * writes (ROW EXCLUSIVE) but not reads. Writes that wait on it fail with a statement
 * timeout (57014), a retryable conflict, and are deferred.
 */
async function holdShareLock(table: string) {
  const client = new pg.Client({ connectionString: process.env.OMNIROUTE_POSTGRES_URL });
  await client.connect();
  await client.query("BEGIN");
  await client.query(`LOCK TABLE ${table} IN SHARE MODE`);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}

test("prepared call logs retain request-scoped API key and connection attribution", async () => {
  const { runWithCallLogApiKeyContext } =
    await import("../../../src/lib/usage/callLogApiKeyContext.ts");
  await runWithCallLogApiKeyContext(
    { apiKeyId: "context-key", apiKeyName: "context-name", connectionId: "context-connection" },
    () => callLogs.saveCallLog({ id: "context-attribution", status: 200, noLog: true })
  );
  const row = (await callLogs.getCallLogs()).find((entry) => entry.id === "context-attribution");
  assert.equal(row?.apiKeyId, "context-key");
  assert.equal(row?.apiKeyName, "context-name");
  assert.equal(row?.connectionId, "context-connection");
});

test("clearing proxy logs also discards the batch waiting for its first flush", async () => {
  const proxy = await import("../../../src/lib/proxyLogger.ts");
  await proxy.clearProxyLogs();
  proxy.logProxyEvent({ status: "success", correlationId: "cleared-before-flush" });
  await proxy.clearProxyLogs();
  await proxy.flushProxyLogsSync();
  const row = await getTestBackend().queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM proxy_logs WHERE correlation_id = $1",
    ["cleared-before-flush"]
  );
  assert.equal(Number(row?.count ?? 0), 0);
  await proxy.clearProxyLogs();
});

test("deferred physical usage attempts preserve the deduplication opt-out", async () => {
  const { saveRequestUsage } = await import("../../../src/lib/usage/usageHistory.ts");
  const b = getTestBackend();
  const locker = await holdShareLock("usage_history");
  const entry = {
    provider: "test-provider",
    model: "physical-retry",
    timestamp: "2026-10-17T12:00:00.000Z",
    tokens: { input_tokens: 10, output_tokens: 20 },
  };
  try {
    // Each attempt waits on the lock, times out and is deferred by one retry.
    await saveRequestUsage(entry, { deduplicate: false });
    await saveRequestUsage(entry, { deduplicate: false });
    await locker.release();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const row = await b.queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM usage_history WHERE model = $1",
      [entry.model]
    );
    assert.equal(Number(row?.count ?? 0), 2);
  } finally {
    await locker.release();
  }
});
