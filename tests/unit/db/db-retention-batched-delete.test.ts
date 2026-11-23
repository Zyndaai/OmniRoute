import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #19434: the scheduled cleanup deletes expired rows of plain tables in batches of 10,000, so a
// large backlog never runs as one long statement.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-retention-batched-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { db } = await import("../../../src/lib/db/pg.ts");
const cleanup = await import("../../../src/lib/db/cleanup.ts");
const { deleteFromTableBeforeInBatches } =
  await import("../../../src/lib/db/cleanup/usagePurge.ts");

test.before(async () => {
  await resetTestDb();
});

test.after(async () => {
  await db().execute("DROP TABLE IF EXISTS tmp_retention_batch");
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a backlog over one batch is fully deleted and newer rows survive", async () => {
  await db().execute(
    "CREATE TABLE IF NOT EXISTS tmp_retention_batch (id serial PRIMARY KEY, created_at timestamptz NOT NULL)"
  );
  await db().execute(
    `INSERT INTO tmp_retention_batch (created_at)
       SELECT now() - interval '40 days' FROM generate_series(1, 25001)`
  );
  await db().execute(
    `INSERT INTO tmp_retention_batch (created_at)
       SELECT now() FROM generate_series(1, 5)`
  );

  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const deleted = await deleteFromTableBeforeInBatches(
    { table: "tmp_retention_batch", column: "created_at", cutoff: "iso" },
    cutoff
  );

  assert.equal(deleted, 25001);
  const left = await db().queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM tmp_retention_batch");
  assert.equal(Number(left?.n), 5);
});

test("closed quota-share buckets are pruned, live and per-key counters stay", async () => {
  await db().execute(
    `INSERT INTO quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at)
     VALUES ('k', 'pool1:tokens:monthly', 1, 1, now() - interval '100 days'),
            ('k', 'pool1:tokens:monthly', 2, 1, now()),
            ('k', 'key-quota:tpm', 3, 1, now() - interval '100 days')`
  );
  const result = await cleanup.cleanupQuotaShareBuckets();
  assert.equal(result.errors, 0);
  assert.equal(result.deleted, 1);
  const left = await db().query<{ dimension_key: string; bucket_index: string | number }>(
    "SELECT dimension_key, bucket_index FROM quota_counters ORDER BY bucket_index"
  );
  assert.deepEqual(
    left.map((row) => Number(row.bucket_index)),
    [2, 3]
  );
});

test("the scheduled cleanup of a plain table reports its deleted rows", async () => {
  const result = await cleanup.cleanupMcpAudit();
  assert.equal(result.errors, 0);
  assert.equal(typeof result.deleted, "number");
});
