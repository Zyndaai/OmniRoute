import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-cache-prune-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const { pruneSemanticCache } = await import("../../src/lib/db/semanticCache.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const now = new Date("2030-01-02T00:00:00.000Z");
const expired = "2030-01-01T00:00:00.000Z";
const future = "2030-01-03T00:00:00.000Z";
const options = { batchSize: 2, maxBatches: 50, maxRows: 0 };

// The row's signature doubles as its identity (the table has no separate id column).
async function insert(id: string, expiresAt = expired, createdAt = expired) {
  await getTestBackend().execute(
    `INSERT INTO semantic_cache
     (signature, model, prompt_hash, response, created_at, expires_at)
     VALUES ($1, 'test-model', 'test-hash', '{}', $2, $3)`,
    [id, createdAt, expiresAt]
  );
}
async function ids(): Promise<string[]> {
  const rows = await getTestBackend().query<{ signature: string }>(
    "SELECT signature FROM semantic_cache ORDER BY signature"
  );
  return rows.map((row) => row.signature);
}
async function seed(count: number, expiresAt = expired) {
  for (let i = 0; i < count; i++) await insert(`entry-${i}`, expiresAt);
}

test.beforeEach(async () => {
  await resetTestDb();
});
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("expiry deletes past and equal-to-now rows but never future rows", async () => {
  await insert("past");
  await insert("boundary", now.toISOString());
  await insert("future", future);
  assert.deepEqual(await pruneSemanticCache(options, now), {
    expiredDeleted: 2,
    capDeleted: 0,
    batches: 2,
  });
  assert.deepEqual(await ids(), ["future"]);
});

test("a short batch stops expiry without an extra delete", async () => {
  await seed(5);
  assert.deepEqual(await pruneSemanticCache(options, now), {
    expiredDeleted: 5,
    capDeleted: 0,
    batches: 3,
  });
  assert.deepEqual(await ids(), []);
});

test("batch size and the shared per-run batch budget bound deletes", async () => {
  await seed(7);
  assert.deepEqual(await pruneSemanticCache({ ...options, maxBatches: 2, maxRows: 1 }, now), {
    expiredDeleted: 4,
    capDeleted: 0,
    batches: 2,
  });
  assert.equal((await ids()).length, 3);
});

test("multi-batch expiry yields to a previously queued immediate", async () => {
  await seed(5);
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const run = pruneSemanticCache(options, now);
  assert.equal(yielded, false);
  await run;
  assert.equal(yielded, true);
});

test("MAX_ROWS evicts oldest created_at, breaking ties by signature, and keeps newest", async () => {
  await insert("newest", future, "2030-01-02T00:00:00.000Z");
  await insert("tie-first", future);
  await insert("tie-second", future);
  await insert("oldest", future, "2029-12-31T00:00:00.000Z");
  await insert("expired", expired);
  assert.deepEqual(await pruneSemanticCache({ ...options, maxRows: 2 }, now), {
    expiredDeleted: 1,
    capDeleted: 2,
    batches: 2,
  });
  assert.deepEqual(await ids(), ["newest", "tie-second"]);
});

test("cap pass shares budget, yields, and rechecks remaining row count", async () => {
  await seed(7, future);
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  assert.deepEqual(await pruneSemanticCache({ ...options, maxRows: 1, maxBatches: 3 }, now), {
    expiredDeleted: 0,
    capDeleted: 4,
    batches: 3,
  });
  assert.equal(yielded, true);
  assert.deepEqual(await ids(), ["entry-4", "entry-5", "entry-6"]);
});

test("default zero cap preserves every live row", async () => {
  await seed(7, future);
  assert.deepEqual(await pruneSemanticCache(options, now), {
    expiredDeleted: 0,
    capDeleted: 0,
    batches: 1,
  });
  assert.equal((await ids()).length, 7);
});

test("cap at or above row count removes nothing", async () => {
  await seed(2, future);
  assert.deepEqual(await pruneSemanticCache({ ...options, maxRows: 2 }, now), {
    expiredDeleted: 0,
    capDeleted: 0,
    batches: 1,
  });
});
