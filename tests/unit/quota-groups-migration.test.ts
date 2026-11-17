/**
 * tests/unit/quota-groups-migration.test.ts
 *
 * Task B1 — first-class quota Group entity.
 *
 * Coverage:
 * - After migrations run (fresh DB), quota_groups has a 'group-demo' row.
 * - quota_pools has a group_id column.
 * - createPool without groupId → pool.groupId === 'group-demo'.
 * - createPool with groupId: 'g1' (group pre-inserted) → pool.groupId === 'g1'.
 * - getPool and listPools both surface groupId.
 * - updatePool with groupId updates the group assignment.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── DB harness (mirrors quota-pool-connections.test.ts) ─────────────────────
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-groups-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const poolsDb = await import("../../src/lib/db/quotaPools.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

async function resetStorage() {
  await resetTestDb();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      break;
    } catch (err: any) {
      if ((err?.code === "EBUSY" || err?.code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seedConnection(id: string) {
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, auth_type, is_active)
     VALUES ($1, 'openai', 'apikey', true) ON CONFLICT (id) DO NOTHING`,
    [id]
  );
}

async function insertGroup(id: string, name: string) {
  await getTestBackend().execute(
    "INSERT INTO quota_groups (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [id, name]
  );
}

// ── B1.2: Schema after migration ──────────────────────────────────────────────

test("after migrations run, quota_groups has a group-demo row named GroupDemo", async () => {
  const row = await getTestBackend().queryOne<{ id: string; name: string }>(
    "SELECT id, name FROM quota_groups WHERE id = 'group-demo'"
  );

  assert.ok(row, "group-demo row should exist in quota_groups");
  assert.equal(row!.id, "group-demo");
  assert.equal(row!.name, "GroupDemo");
});

test("quota_pools has a group_id column after migration", async () => {
  const cols = await getTestBackend().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'quota_pools'`
  );
  assert.ok(
    cols.map((r) => r.column_name).includes("group_id"),
    "quota_pools should have a group_id column"
  );
});

// ── B1.3: createPool defaults ─────────────────────────────────────────────────

test("createPool without groupId → pool.groupId === 'group-demo'", async () => {
  await seedConnection("conn-1");
  const pool = await poolsDb.createPool({
    connectionId: "conn-1",
    name: "Default Group Pool",
  });

  assert.equal(pool.groupId, "group-demo", "groupId should default to 'group-demo'");

  // Re-read from DB to confirm persistence.
  const reread = await poolsDb.getPool(pool.id);
  assert.ok(reread, "pool should be findable after creation");
  assert.equal(reread!.groupId, "group-demo", "persisted groupId should be 'group-demo'");
});

test("createPool with explicit groupId persists the given group", async () => {
  await insertGroup("g1", "Group One");
  await seedConnection("conn-g1");

  const pool = await poolsDb.createPool({
    connectionId: "conn-g1",
    name: "G1 Pool",
    groupId: "g1",
  });

  assert.equal(pool.groupId, "g1", "groupId should be 'g1'");

  const reread = await poolsDb.getPool(pool.id);
  assert.ok(reread, "pool should be findable after creation");
  assert.equal(reread!.groupId, "g1", "persisted groupId should be 'g1'");
});

// ── B1.4: listPools surfaces groupId ─────────────────────────────────────────

test("listPools returns groupId on every pool", async () => {
  await insertGroup("g2", "Group Two");
  await seedConnection("lp-1");
  await seedConnection("lp-2");

  await poolsDb.createPool({ connectionId: "lp-1", name: "Pool Default" });
  await poolsDb.createPool({ connectionId: "lp-2", name: "Pool G2", groupId: "g2" });

  const { items: pools } = await poolsDb.listPools();
  assert.equal(pools.length, 2);

  const pDef = pools.find((p) => p.name === "Pool Default")!;
  assert.equal(pDef.groupId, "group-demo");

  const pG2 = pools.find((p) => p.name === "Pool G2")!;
  assert.equal(pG2.groupId, "g2");
});

// ── B1.5: updatePool groupId ──────────────────────────────────────────────────

test("updatePool with groupId updates the group assignment", async () => {
  await insertGroup("g3", "Group Three");
  await seedConnection("up-1");

  const pool = await poolsDb.createPool({ connectionId: "up-1", name: "Update Group Pool" });
  assert.equal(pool.groupId, "group-demo");

  const updated = await poolsDb.updatePool(pool.id, { groupId: "g3" });
  assert.ok(updated, "updatePool should return the updated pool");
  assert.equal(updated!.groupId, "g3", "groupId should be updated to 'g3'");

  const reread = await poolsDb.getPool(pool.id);
  assert.equal(reread!.groupId, "g3", "persisted groupId should be 'g3'");
});
