/**
 * tests/unit/db-quota-pools.test.ts
 *
 * CRUD coverage for src/lib/db/quotaPools.ts:
 * - create → list → get → update → delete lifecycle
 * - Returns null / false for missing IDs
 * - upsertAllocations replace strategy
 * - FK CASCADE: allocations removed when pool is deleted
 * - listAllocationsForApiKey cross-pool filtering
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

const poolsDb = await import("../../src/lib/db/quotaPools.ts");

// Pool members are provider connections (foreign key), so every connection id used below exists.
const CONNECTION_IDS = [
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
  "c7",
  "c8",
  "c9",
  "c10",
  "cx-1",
  "cx-2",
  "cz",
  "c-guardA",
  "c-guardA-valid",
];

// Pool allocations reference API keys (foreign key), so every api key id used below exists.
const API_KEY_IDS = [
  "key-a",
  "key-b",
  "key-x",
  "key-y",
  "key-z",
  "k1",
  "k2",
  "k3",
  "k99",
  "k-cascade",
  "shared-key",
  "other-key",
  "someone-else",
  "k-cap",
  "k-corrupt",
  "k-hard",
  "k-soft",
  "k-burst",
];

test.beforeEach(async () => {
  await resetTestDb();
  const backend = getTestBackend();
  for (const id of CONNECTION_IDS) {
    await backend.execute(
      "INSERT INTO provider_connections (id, provider) VALUES ($1, 'openai') ON CONFLICT (id) DO NOTHING",
      [id]
    );
  }
  for (const id of API_KEY_IDS) {
    await backend.execute(
      "INSERT INTO api_keys (id, name, key, key_hash) VALUES ($1, $1, 'test-secret', encode(sha256(convert_to($1, 'UTF8')), 'hex')) ON CONFLICT (id) DO NOTHING",
      [id]
    );
  }
});

// ---------------------------------------------------------------------------
// Basic CRUD
// ---------------------------------------------------------------------------

test("createPool creates a pool with no allocations", async () => {
  const pool = await poolsDb.createPool({ connectionId: "c1", name: "Test Pool" });

  assert.ok(pool.id, "should have an id");
  assert.equal(pool.connectionId, "c1");
  assert.equal(pool.name, "Test Pool");
  assert.ok(pool.createdAt, "should have createdAt");
  assert.deepEqual(pool.allocations, []);
});

test("createPool creates a pool with initial allocations", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c2",
    name: "Pool With Allocs",
    allocations: [
      { apiKeyId: "key-a", weight: 60, policy: "hard" },
      { apiKeyId: "key-b", weight: 40, policy: "soft" },
    ],
  });

  assert.equal(pool.allocations.length, 2);
  const keyA = pool.allocations.find((a) => a.apiKeyId === "key-a");
  assert.ok(keyA);
  assert.equal(keyA!.weight, 60);
  assert.equal(keyA!.policy, "hard");
});

test("listPools returns all pools in creation order", async () => {
  await poolsDb.createPool({ connectionId: "c1", name: "First" });
  await poolsDb.createPool({ connectionId: "c2", name: "Second" });

  const { items: pools } = await poolsDb.listPools();
  assert.equal(pools.length, 2);
  assert.equal(pools[0].name, "First");
  assert.equal(pools[1].name, "Second");
});

test("getPool returns pool by id", async () => {
  const created = await poolsDb.createPool({ connectionId: "c3", name: "Findable" });
  const found = await poolsDb.getPool(created.id);
  assert.ok(found);
  assert.equal(found!.id, created.id);
  assert.equal(found!.name, "Findable");
});

test("getPool returns null for unknown id", async () => {
  const found = await poolsDb.getPool("nonexistent-id");
  assert.equal(found, null);
});

test("updatePool updates the name", async () => {
  const pool = await poolsDb.createPool({ connectionId: "c4", name: "Old Name" });
  const updated = await poolsDb.updatePool(pool.id, { name: "New Name" });
  assert.ok(updated);
  assert.equal(updated!.name, "New Name");
  assert.equal(updated!.connectionId, "c4");
});

test("updatePool replaces allocations when provided", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c5",
    name: "P",
    allocations: [{ apiKeyId: "key-x", weight: 100, policy: "hard" }],
  });

  const updated = await poolsDb.updatePool(pool.id, {
    allocations: [
      { apiKeyId: "key-y", weight: 70, policy: "burst" },
      { apiKeyId: "key-z", weight: 30, policy: "soft" },
    ],
  });

  assert.ok(updated);
  assert.equal(updated!.allocations.length, 2);
  const keyX = updated!.allocations.find((a) => a.apiKeyId === "key-x");
  assert.equal(keyX, undefined, "old allocation should be gone");
});

test("updatePool returns null for unknown id", async () => {
  const result = await poolsDb.updatePool("no-such-pool", { name: "Ghost" });
  assert.equal(result, null);
});

test("deletePool removes pool and returns true", async () => {
  const pool = await poolsDb.createPool({ connectionId: "c6", name: "Deletable" });
  const deleted = await poolsDb.deletePool(pool.id);
  assert.equal(deleted, true);
  assert.equal(await poolsDb.getPool(pool.id), null);
});

test("deletePool returns false for unknown id", async () => {
  const result = await poolsDb.deletePool("ghost-pool");
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// upsertAllocations (replace strategy)
// ---------------------------------------------------------------------------

test("upsertAllocations replaces all previous allocations atomically", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c7",
    name: "Replace Test",
    allocations: [
      { apiKeyId: "k1", weight: 50, policy: "hard" },
      { apiKeyId: "k2", weight: 50, policy: "hard" },
    ],
  });

  await poolsDb.upsertAllocations(pool.id, [
    { apiKeyId: "k3", weight: 100, policy: "soft", capValue: 500, capUnit: "tokens" },
  ]);

  const refreshed = (await poolsDb.getPool(pool.id))!;
  assert.equal(refreshed.allocations.length, 1);
  assert.equal(refreshed.allocations[0].apiKeyId, "k3");
  assert.equal(refreshed.allocations[0].capValue, 500);
  assert.equal(refreshed.allocations[0].capUnit, "tokens");
});

test("upsertAllocations with empty array removes all allocations", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c8",
    name: "Clear Test",
    allocations: [{ apiKeyId: "k99", weight: 100, policy: "hard" }],
  });

  await poolsDb.upsertAllocations(pool.id, []);
  const refreshed = (await poolsDb.getPool(pool.id))!;
  assert.equal(refreshed.allocations.length, 0);
});

// ---------------------------------------------------------------------------
// FK CASCADE: delete pool → allocations gone
// ---------------------------------------------------------------------------

test("deletePool cascades to allocations", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c9",
    name: "With Allocs",
    allocations: [{ apiKeyId: "k-cascade", weight: 100, policy: "hard" }],
  });

  await poolsDb.deletePool(pool.id);

  // After pool is deleted, listAllocationsForApiKey should find nothing for k-cascade
  const remaining = await poolsDb.listAllocationsForApiKey("k-cascade");
  assert.equal(remaining.length, 0, "cascade should have removed allocation");
});

// ---------------------------------------------------------------------------
// listAllocationsForApiKey cross-pool filtering
// ---------------------------------------------------------------------------

test("listAllocationsForApiKey returns allocations across multiple pools for the same key", async () => {
  const p1 = await poolsDb.createPool({
    connectionId: "cx-1",
    name: "Pool A",
    allocations: [
      { apiKeyId: "shared-key", weight: 40, policy: "hard" },
      { apiKeyId: "other-key", weight: 60, policy: "soft" },
    ],
  });
  const p2 = await poolsDb.createPool({
    connectionId: "cx-2",
    name: "Pool B",
    allocations: [{ apiKeyId: "shared-key", weight: 100, policy: "burst" }],
  });

  const results = await poolsDb.listAllocationsForApiKey("shared-key");
  assert.equal(results.length, 2);

  const poolIds = results.map((r) => r.poolId).sort();
  assert.deepEqual(poolIds, [p1.id, p2.id].sort());
});

test("listAllocationsForApiKey returns empty for unknown key", async () => {
  await poolsDb.createPool({
    connectionId: "cz",
    name: "Irrelevant Pool",
    allocations: [{ apiKeyId: "someone-else", weight: 100, policy: "hard" }],
  });

  const results = await poolsDb.listAllocationsForApiKey("unknown-key");
  assert.equal(results.length, 0);
});

test("allocation stores optional capValue and capUnit correctly", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c10",
    name: "Cap Test",
    allocations: [
      {
        apiKeyId: "k-cap",
        weight: 50,
        policy: "soft",
        capValue: 1000,
        capUnit: "requests",
      },
    ],
  });

  const found = (await poolsDb.getPool(pool.id))!;
  const alloc = found.allocations.find((a) => a.apiKeyId === "k-cap")!;
  assert.equal(alloc.capValue, 1000);
  assert.equal(alloc.capUnit, "requests");
});

// ---------------------------------------------------------------------------
// Guard A (issue #10): corrupted/unknown policy in the DB must be normalized to
// the most restrictive policy ('hard') at the read boundary — never trusted via
// `row.policy as Policy`. A garbage policy reaching the fair-share engine would
// fall through every switch case and silently ALLOW (fail-OPEN).
//
// The schema has CHECK (policy IN ('hard','soft','burst')), so the check constraint is
// dropped for the test to simulate a legacy/corrupted row, then restored.
// ---------------------------------------------------------------------------

test("rowToAllocation normalizes an unknown DB policy to 'hard' (Guard A)", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c-guardA",
    name: "Corrupt Policy Pool",
    allocations: [{ apiKeyId: "k-corrupt", weight: 100, policy: "soft" }],
  });

  const backend = getTestBackend();
  await backend.execute(
    "ALTER TABLE quota_allocations DROP CONSTRAINT IF EXISTS quota_allocations_policy_check"
  );
  try {
    // Inject a corrupted policy directly, bypassing the CHECK constraint.
    await backend.execute(
      "UPDATE quota_allocations SET policy = $1 WHERE pool_id = $2 AND api_key_id = $3",
      ["bogus-policy", pool.id, "k-corrupt"]
    );

    // Read through the domain module — the unknown policy must become 'hard'.
    const found = (await poolsDb.getPool(pool.id))!;
    const alloc = found.allocations.find((a) => a.apiKeyId === "k-corrupt")!;
    assert.equal(alloc.policy, "hard", "unknown DB policy must be normalized to 'hard'");

    // Same expectation via listAllocationsForApiKey (the other read path).
    const list = await poolsDb.listAllocationsForApiKey("k-corrupt");
    assert.equal(list.length, 1);
    assert.equal(list[0].allocation.policy, "hard");
  } finally {
    await backend.execute(
      "UPDATE quota_allocations SET policy = 'soft' WHERE policy NOT IN ('hard', 'soft', 'burst')"
    );
    await backend.execute(
      "ALTER TABLE quota_allocations ADD CONSTRAINT quota_allocations_policy_check CHECK (policy IN ('hard', 'soft', 'burst'))"
    );
  }
});

test("rowToAllocation preserves valid policies unchanged (Guard A regression)", async () => {
  const pool = await poolsDb.createPool({
    connectionId: "c-guardA-valid",
    name: "Valid Policy Pool",
    allocations: [
      { apiKeyId: "k-hard", weight: 34, policy: "hard" },
      { apiKeyId: "k-soft", weight: 33, policy: "soft" },
      { apiKeyId: "k-burst", weight: 33, policy: "burst" },
    ],
  });

  const found = (await poolsDb.getPool(pool.id))!;
  assert.equal(found.allocations.find((a) => a.apiKeyId === "k-hard")!.policy, "hard");
  assert.equal(found.allocations.find((a) => a.apiKeyId === "k-soft")!.policy, "soft");
  assert.equal(found.allocations.find((a) => a.apiKeyId === "k-burst")!.policy, "burst");
});
