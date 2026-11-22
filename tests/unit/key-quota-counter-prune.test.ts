import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// #19445: per-key minute counters older than the previous bucket are unreadable; each new bucket
// removes them so quota_counters stops growing without limit.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-prune-"));
process.env.DATA_DIR = dataDir;

const core = await import("../../src/lib/db/core.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const { db } = await import("../../src/lib/db/pg.ts");
const quotaDb = await import("../../src/lib/db/keyQuota.ts");

const WINDOW = quotaDb.KEY_QUOTA_WINDOW_MS;
const t0 = Date.parse("2026-09-14T12:00:30.000Z");

async function bucketsOf(keyId: string): Promise<number[]> {
  const rows = await db().query<{ bucket_index: string | number }>(
    "SELECT DISTINCT bucket_index FROM quota_counters WHERE api_key_id = $1 ORDER BY bucket_index",
    [keyId]
  );
  return rows.map((row) => Number(row.bucket_index));
}

test.before(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("minute counters older than the previous bucket are pruned, live buckets stay", async () => {
  await quotaDb.recordKeyQuotaUsage("key-1", 100, t0);
  await quotaDb.recordKeyQuotaUsage("key-1", 100, t0 + 5 * WINDOW);
  await quotaDb.recordKeyQuotaUsage("key-1", 100, t0 + 6 * WINDOW);

  const current = Math.floor((t0 + 6 * WINDOW) / WINDOW);
  assert.deepEqual(await bucketsOf("key-1"), [current - 1, current]);
});

test("a repeat write in the same bucket keeps the previous bucket", async () => {
  await quotaDb.recordKeyQuotaUsage("key-2", 1000, t0);
  await quotaDb.recordKeyQuotaUsage("key-2", 250, t0 + WINDOW);
  await quotaDb.recordKeyQuotaUsage("key-2", 5, t0 + WINDOW + 10);
  const current = Math.floor((t0 + WINDOW) / WINDOW);
  assert.deepEqual(await bucketsOf("key-2"), [current - 1, current]);
});

test("a large backlog is drained in bounded steps by later new buckets", async () => {
  const now = t0 + 20 * WINDOW;
  const current = Math.floor(now / WINDOW);
  await db().execute(
    `INSERT INTO quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at)
       SELECT 'key-backlog', 'key-quota:tpm', $1::bigint - g, 1, now() FROM generate_series(2, 2501) g`,
    [current]
  );
  const oldRows = async () =>
    Number(
      (
        await db().queryOne<{ n: number }>(
          "SELECT COUNT(*) AS n FROM quota_counters WHERE api_key_id = 'key-backlog' AND bucket_index < $1",
          [current - 1]
        )
      )?.n
    );
  assert.equal(await oldRows(), 2500);

  await quotaDb.recordKeyQuotaUsage("key-backlog", 100, now);
  const afterFirst = await oldRows();
  assert.ok(afterFirst > 0 && afterFirst < 2500, "one new bucket removes only a bounded part");

  let step = 1;
  while ((await oldRows()) > 0 && step < 10) {
    await quotaDb.recordKeyQuotaUsage("key-backlog", 100, now + step * WINDOW);
    step++;
  }
  assert.equal(await oldRows(), 0);
});
