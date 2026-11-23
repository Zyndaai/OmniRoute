/**
 * tests/unit/db/quota-pool-delete-prune.test.ts
 *
 * Fix: deletePool should prune its id from every api_key's allowed_quotas JSON array.
 *
 * Coverage:
 * 1. Create a pool, assign it to a key's allowed_quotas → deletePool → key's
 *    allowed_quotas no longer contains that pool id.
 * 2. Unrelated pool ids in allowed_quotas are untouched.
 * 3. Key whose allowed_quotas doesn't contain the deleted pool id → unchanged.
 * 4. Key with empty allowed_quotas stays empty after delete.
 * 5. Multiple keys all pruned simultaneously.
 * 6. deletePool still returns true/false correctly.
 * 7. Pool row and allocation rows are gone after delete (regression guard).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// ── DB harness (same pattern as quota-exclusivity-reconcile.test.ts) ─────────
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pool-delete-prune-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "delete-prune-test-secret-32chars!!";

const poolsDb = await import("../../../src/lib/db/quotaPools.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

async function resetStorage() {
  await resetTestDb();
  await apiKeysDb.resetApiKeyState();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// pool connections reference provider_connections
async function seedConnection(id: string) {
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, auth_type, is_active)
     VALUES ($1, 'openai', 'apikey', true) ON CONFLICT (id) DO NOTHING`,
    [id]
  );
}

// ── Helper: get allowed_quotas for a key by id from DB ───────────────────────
async function getAllowedQuotasById(keyId: string): Promise<string[]> {
  const row = await getTestBackend().queryOne<{ allowed_quotas: unknown }>(
    "SELECT allowed_quotas FROM api_keys WHERE id = $1",
    [keyId]
  );
  if (!row) return [];
  const raw = row.allowed_quotas;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : (raw ?? []);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── 1. Basic prune: deletePool removes pool id from key's allowed_quotas ──────

test("deletePool prunes its id from api_key allowed_quotas", async () => {
  await seedConnection("conn-prune-1");
  const pool = await poolsDb.createPool({ connectionId: "conn-prune-1", name: "Prune Pool 1" });
  const keyObj = await apiKeysDb.createApiKey("Prune Key 1", "machine-prune-1");
  await apiKeysDb.updateApiKeyPermissions(keyObj.id, { allowedQuotas: [pool.id] });

  // Sanity: pool id is there before delete
  const before = await getAllowedQuotasById(keyObj.id);
  assert.ok(before.includes(pool.id), `pool.id should be in allowed_quotas before delete`);

  await poolsDb.deletePool(pool.id);

  const after = await getAllowedQuotasById(keyObj.id);
  assert.ok(!after.includes(pool.id), `pool.id should NOT be in allowed_quotas after delete`);
});

// ── 2. Unrelated pool ids are preserved ───────────────────────────────────────

test("deletePool preserves unrelated pool ids in allowed_quotas", async () => {
  await seedConnection("conn-prune-2a");
  await seedConnection("conn-prune-2b");
  const poolToDelete = await poolsDb.createPool({
    connectionId: "conn-prune-2a",
    name: "Delete Me",
  });
  const otherPool = await poolsDb.createPool({ connectionId: "conn-prune-2b", name: "Keep Me" });
  const unrelatedId = "unrelated-pool-id-xyz";

  const keyObj = await apiKeysDb.createApiKey("Prune Key 2", "machine-prune-2");
  await apiKeysDb.updateApiKeyPermissions(keyObj.id, {
    allowedQuotas: [poolToDelete.id, otherPool.id, unrelatedId],
  });

  await poolsDb.deletePool(poolToDelete.id);

  const after = await getAllowedQuotasById(keyObj.id);
  assert.ok(!after.includes(poolToDelete.id), "deleted pool id should be removed");
  assert.ok(after.includes(otherPool.id), "other pool id should remain");
  assert.ok(after.includes(unrelatedId), "unrelated id should remain");
});

// ── 3. Keys without the pool id are unchanged ─────────────────────────────────

test("deletePool does not modify keys that don't reference the deleted pool", async () => {
  await seedConnection("conn-prune-3a");
  await seedConnection("conn-prune-3b");
  const poolToDelete = await poolsDb.createPool({ connectionId: "conn-prune-3a", name: "Target" });
  const otherPool = await poolsDb.createPool({ connectionId: "conn-prune-3b", name: "Other" });

  const keyObj = await apiKeysDb.createApiKey("Prune Key 3", "machine-prune-3");
  // This key only references otherPool, not poolToDelete
  await apiKeysDb.updateApiKeyPermissions(keyObj.id, { allowedQuotas: [otherPool.id] });

  await poolsDb.deletePool(poolToDelete.id);

  const after = await getAllowedQuotasById(keyObj.id);
  assert.deepEqual(after, [otherPool.id], "key referencing only other pool should be unchanged");
});

// ── 4. Key with empty allowed_quotas remains empty ───────────────────────────

test("deletePool: key with empty allowed_quotas stays empty", async () => {
  await seedConnection("conn-prune-4");
  const pool = await poolsDb.createPool({ connectionId: "conn-prune-4", name: "Empty Test" });
  const keyObj = await apiKeysDb.createApiKey("Prune Key 4", "machine-prune-4");
  // Don't set allowedQuotas — default is []

  await poolsDb.deletePool(pool.id);

  const after = await getAllowedQuotasById(keyObj.id);
  assert.deepEqual(after, [], "empty allowed_quotas should remain empty after delete");
});

// ── 5. Multiple keys: all pruned simultaneously ───────────────────────────────

test("deletePool prunes pool id from ALL keys that reference it", async () => {
  await seedConnection("conn-prune-5");
  const pool = await poolsDb.createPool({ connectionId: "conn-prune-5", name: "Multi Key Pool" });

  const keys = await Promise.all([
    apiKeysDb.createApiKey("Prune Multi 1", "machine-pm-1"),
    apiKeysDb.createApiKey("Prune Multi 2", "machine-pm-2"),
    apiKeysDb.createApiKey("Prune Multi 3", "machine-pm-3"),
  ]);

  const otherPoolId = "other-pool-id-static";
  for (const k of keys) {
    await apiKeysDb.updateApiKeyPermissions(k.id, { allowedQuotas: [pool.id, otherPoolId] });
  }

  await poolsDb.deletePool(pool.id);

  for (const k of keys) {
    const after = await getAllowedQuotasById(k.id);
    assert.ok(!after.includes(pool.id), `${k.name}: pool.id should be pruned`);
    assert.ok(after.includes(otherPoolId), `${k.name}: other-pool-id should remain`);
  }
});

// ── 6. deletePool still returns true/false correctly ─────────────────────────

test("deletePool returns true for existing pool, false for non-existent", async () => {
  await seedConnection("conn-ret-1");
  const pool = await poolsDb.createPool({ connectionId: "conn-ret-1", name: "Return Test" });
  assert.equal(await poolsDb.deletePool(pool.id), true, "should return true for existing pool");
  assert.equal(
    await poolsDb.deletePool(pool.id),
    false,
    "should return false for already-deleted pool"
  );
  assert.equal(
    await poolsDb.deletePool("nonexistent-id"),
    false,
    "should return false for unknown id"
  );
});

// ── 7. Pool row and allocation rows are gone after delete (regression guard) ──

test("deletePool removes pool and allocation rows from DB", async () => {
  await seedConnection("conn-reg-1");
  await getTestBackend().execute(
    `INSERT INTO api_keys (id, name, key, key_hash) VALUES ('key-reg-1', 'reg key', 'test', $1)
     ON CONFLICT (id) DO NOTHING`,
    [createHash("sha256").update("key-reg-1").digest("hex")]
  );
  const pool = await poolsDb.createPool({
    connectionId: "conn-reg-1",
    name: "Regression Pool",
    allocations: [{ apiKeyId: "key-reg-1", weight: 50, policy: "hard" }],
  });

  await poolsDb.deletePool(pool.id);

  assert.equal(await poolsDb.getPool(pool.id), null, "getPool should return null after delete");
  const { items: allPools } = await poolsDb.listPools();
  assert.ok(
    !allPools.some((p) => p.id === pool.id),
    "listPools should not contain the deleted pool"
  );
});
