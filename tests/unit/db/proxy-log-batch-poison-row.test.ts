import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #19470: one proxy log row that the database rejects does not drop the other rows of its batch.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-log-poison-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { db } = await import("../../../src/lib/db/pg.ts");
const proxyLogger = await import("../../../src/lib/proxyLogger.ts");

test.before(async () => {
  await resetTestDb();
});

test.after(async () => {
  await proxyLogger.flushProxyLogsSync();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("one row the database rejects does not drop the other rows of its batch", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const name of ["a", "b", "c"]) {
      proxyLogger.logProxyEvent({ status: "success", provider: `ok-${name}`, level: "direct" });
    }
    // A port past the integer range makes the whole batch statement fail.
    proxyLogger.logProxyEvent({
      status: "success",
      provider: "poison",
      level: "direct",
      proxy: { type: "http", host: "h", port: 99_999_999_999 },
    } as never);
    await proxyLogger.flushProxyLogsSync();
  } finally {
    console.warn = warn;
  }
  const rows = await db().query<{ provider: string }>(
    "SELECT provider FROM proxy_logs ORDER BY provider"
  );
  assert.deepEqual(
    rows.map((r) => r.provider),
    ["ok-a", "ok-b", "ok-c"]
  );
});
