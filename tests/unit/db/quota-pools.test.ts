/**
 * Unit tests for src/lib/db/quotaPools.ts — pagination and batchBuildPools.
 *
 * Each test file gets its own database (tests/_setup/isolatePostgres.ts); resetTestDb()
 * empties it between tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const qp = await import("../../../src/lib/db/quotaPools.ts");

// Membership rows reference provider connections, so the connection must exist.
async function seedConnection(connectionId: string): Promise<void> {
  await getTestBackend().execute(
    "INSERT INTO provider_connections (id, provider) VALUES ($1, 'openai') ON CONFLICT (id) DO NOTHING",
    [connectionId]
  );
}

// Insert a pool plus its primary membership row directly (bypass createPool for speed).
// Membership lives in quota_pool_connections; position 0 is the primary connection.
async function insertPool(
  id: string,
  name: string,
  connectionId: string,
  createdAt = new Date().toISOString()
) {
  const backend = getTestBackend();
  await backend.execute(
    "INSERT INTO quota_pools (id, name, group_id, created_at) VALUES ($1, $2, $3, $4)",
    [id, name, "group-demo", createdAt]
  );
  await seedConnection(connectionId);
  await backend.execute(
    "INSERT INTO quota_pool_connections (pool_id, connection_id, position) VALUES ($1, $2, 0)",
    [id, connectionId]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
});

// ─────────────────────────────────────────────────────────────────────────────
// listPools — pagination
// ─────────────────────────────────────────────────────────────────────────────

test("listPools without limit/offset returns all pools", async () => {
  await insertPool("p1", "Alpha", "c1");
  await insertPool("p2", "Beta", "c2");
  const result = await qp.listPools();
  assert.equal(result.total, 2);
  assert.equal(result.items.length, 2);
});

test("listPools with limit returns ≤ limit items, total unchanged", async () => {
  await insertPool("p1", "Alpha", "c1");
  await insertPool("p2", "Beta", "c2");
  await insertPool("p3", "Gamma", "c3");
  const result = await qp.listPools({ limit: 2 });
  assert.equal(result.total, 3);
  assert.equal(result.items.length, 2);
});

test("listPools with limit+offset returns correct slice", async () => {
  await insertPool("p1", "Alpha", "c1", "2024-01-01T00:00:00Z");
  await insertPool("p2", "Beta", "c2", "2024-01-02T00:00:00Z");
  await insertPool("p3", "Gamma", "c3", "2024-01-03T00:00:00Z");
  const result = await qp.listPools({ limit: 1, offset: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, "Beta");
});

test("listPools with only offset (no limit) ignores offset", async () => {
  await insertPool("p1", "Alpha", "c1");
  await insertPool("p2", "Beta", "c2");
  // offset without limit — should not add OFFSET clause (was a bug)
  const result = await qp.listPools({ offset: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.items.length, 2);
});

test("listPools with zero limit treated as no limit", async () => {
  await insertPool("p1", "Alpha", "c1");
  // limit=0 is invalid in SQL — code treats it as "no limit"
  const result = await qp.listPools({ limit: 0 });
  assert.equal(result.total, 1);
  assert.equal(result.items.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// getPoolsByGroup — pagination
// ─────────────────────────────────────────────────────────────────────────────

test("getPoolsByGroup with limit returns correct count", async () => {
  await insertPool("p1", "A", "c1");
  await insertPool("p2", "B", "c2");
  const items = await qp.getPoolsByGroup("group-demo", 1);
  assert.equal(items.length, 1);
});

test("getPoolsByGroup with limit+offset returns correct slice", async () => {
  await insertPool("p1", "Alpha", "c1", "2024-01-01T00:00:00Z");
  await insertPool("p2", "Beta", "c2", "2024-01-02T00:00:00Z");
  await insertPool("p3", "Gamma", "c3", "2024-01-03T00:00:00Z");
  const items = await qp.getPoolsByGroup("group-demo", 1, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Gamma");
});

test("getPoolsByGroup with only offset ignores offset", async () => {
  await insertPool("p1", "Alpha", "c1");
  await insertPool("p2", "Beta", "c2");
  const items = await qp.getPoolsByGroup("group-demo", undefined, 1);
  assert.equal(items.length, 2);
});

test("getPoolsByGroup with empty group returns []", async () => {
  const items = await qp.getPoolsByGroup("nonexistent");
  assert.deepEqual(items, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// batchBuildPools — allocations loaded in batch
// ─────────────────────────────────────────────────────────────────────────────

test("batchBuildPools loads allocations in single query", async () => {
  const backend = getTestBackend();
  await backend.execute(
    "INSERT INTO quota_pools (id, name, group_id, created_at) VALUES ($1, $2, $3, $4)",
    ["p1", "PoolA", "group-demo", new Date().toISOString()]
  );
  await seedConnection("c1");
  await backend.execute(
    "INSERT INTO quota_pool_connections (pool_id, connection_id, position) VALUES ($1, $2, 0)",
    ["p1", "c1"]
  );
  await backend.execute(
    "INSERT INTO api_keys (id, name, key, key_hash) VALUES ($1, $2, $3, $4)",
    ["ak_test", "test key", "not-a-real-secret", "0".repeat(64)]
  );
  await backend.execute(
    "INSERT INTO quota_allocations (pool_id, api_key_id, weight, cap_value) VALUES ($1, $2, $3, $4)",
    ["p1", "ak_test", 1, 100]
  );

  const result = await qp.listPools();
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 1);
  const pool = result.items[0];
  assert.equal(pool.name, "PoolA");
  assert.ok(pool.allocations !== undefined);
  assert.equal(pool.allocations.length, 1);
  assert.equal(pool.allocations[0].apiKeyId, "ak_test");
});
