/**
 * tests/unit/db/quota-per-key-model.test.ts
 *
 * TDD for per-(key, model) budget/rate-limit cap (Fase 3 #7).
 *
 * Scenarios:
 *   1. keyA has a cap of N requests for model M; after N uses → enforce blocks keyA on model M.
 *   2. keyA blocked on M still allowed on model M2 (no cap / cap not reached) in the same pool.
 *   3. No cap configured → behaviour unchanged (no block).
 *   4. Cap value ≤ EPSILON → ignored (placeholder skip, consistent with planRegistry pattern).
 *
 * Uses the real PostgreSQL test database (per-file isolation via tests/_setup/isolatePostgres.ts).
 * Live enforceQuotaShare + recordConsumption path ensures end-to-end correctness.
 *
 * Part of: Group B — Quota Sharing Engine, Fase 3 #7.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// ── Isolated DATA_DIR for files the modules still write ────────────────────
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-cap-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// ── Module imports (after DATA_DIR is set) ────────────────────────────────
const core = await import("../../../src/lib/db/core.ts");
const { createPool, upsertAllocations } = await import("../../../src/lib/db/quotaPools.ts");
const { setModelCap } = await import("../../../src/lib/db/quotaModelCaps.ts");
const { enforceQuotaShare, recordConsumption } = await import("../../../src/lib/quota/enforce.ts");
const { resetQuotaStoreSingleton } = await import("../../../src/lib/quota/storeFactory.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

// ── Storage reset helper ──────────────────────────────────────────────────
async function resetStorage() {
  resetQuotaStoreSingleton();
  await resetTestDb();
}

// ── Test fixtures ─────────────────────────────────────────────────────────
const CONN_ID = "conn-model-cap-test";
const PROVIDER = "kimi"; // kimi has {unit:"requests", window:"hourly", limit:1500} in planRegistry
const KEY_A = "key-model-cap-a";
const MODEL_M = "kimi-k2";
const MODEL_M2 = "kimi-k2-lite";
const CAP_N = 3; // requests

// ── Hooks ─────────────────────────────────────────────────────────────────
test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Helper: create pool with KEY_A allocation ─────────────────────────────
async function makePool() {
  // quota_allocations.api_key_id references api_keys: seed the key row first.
  await getTestBackend().execute(
    `INSERT INTO api_keys (id, name, key, key_hash) VALUES ($1, 'model cap key', 'test', $2)
     ON CONFLICT (id) DO NOTHING`,
    [KEY_A, createHash("sha256").update(KEY_A).digest("hex")]
  );
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, auth_type, is_active)
     VALUES ($1, $2, 'apikey', true) ON CONFLICT (id) DO NOTHING`,
    [CONN_ID, PROVIDER]
  );
  const pool = await createPool({ connectionId: CONN_ID, name: "Model Cap Test Pool" });
  await upsertAllocations(pool.id, [{ apiKeyId: KEY_A, weight: 100, policy: "hard" }]);
  return pool;
}

// ---------------------------------------------------------------------------
// Scenario 1: cap N requests on model M → block after N uses
// ---------------------------------------------------------------------------
test("per-(key,model) cap — keyA blocked on model M after N requests", async () => {
  const pool = await makePool();
  await setModelCap({
    poolId: pool.id,
    apiKeyId: KEY_A,
    model: MODEL_M,
    capValue: CAP_N,
    capUnit: "requests",
  });

  // Simulate CAP_N prior consumptions
  for (let i = 0; i < CAP_N; i++) {
    await recordConsumption({
      apiKeyId: KEY_A,
      connectionId: CONN_ID,
      provider: PROVIDER,
      model: MODEL_M,
      cost: { requests: 1 },
    });
  }

  const result = await enforceQuotaShare({
    apiKeyId: KEY_A,
    connectionId: CONN_ID,
    provider: PROVIDER,
    model: MODEL_M,
    estimatedCost: {},
  });

  assert.equal(result.kind, "block", "must block when model cap is reached");
  assert.ok(
    "reason" in result && result.reason.includes("model-cap"),
    `reason must mention model-cap; got: ${"reason" in result ? result.reason : "(no reason)"}`
  );
  assert.equal("httpStatus" in result && result.httpStatus, 429, "must return 429");
});

// ---------------------------------------------------------------------------
// Scenario 2: keyA blocked on M still allowed on M2
// ---------------------------------------------------------------------------
test("per-(key,model) cap — keyA blocked on M, still allowed on M2 same pool", async () => {
  const pool = await makePool();
  await setModelCap({
    poolId: pool.id,
    apiKeyId: KEY_A,
    model: MODEL_M,
    capValue: 1,
    capUnit: "requests",
  });

  // Consume the single request cap on model M
  await recordConsumption({
    apiKeyId: KEY_A,
    connectionId: CONN_ID,
    provider: PROVIDER,
    model: MODEL_M,
    cost: { requests: 1 },
  });

  // Model M must be blocked
  const resultM = await enforceQuotaShare({
    apiKeyId: KEY_A,
    connectionId: CONN_ID,
    provider: PROVIDER,
    model: MODEL_M,
    estimatedCost: {},
  });
  assert.equal(resultM.kind, "block", "model M should be blocked");
  assert.ok(
    "reason" in resultM && resultM.reason.includes("model-cap"),
    `reason must mention model-cap; got: ${"reason" in resultM ? resultM.reason : "(no reason)"}`
  );

  // Model M2 (no cap configured) must still be allowed
  const resultM2 = await enforceQuotaShare({
    apiKeyId: KEY_A,
    connectionId: CONN_ID,
    provider: PROVIDER,
    model: MODEL_M2,
    estimatedCost: {},
  });
  assert.equal(resultM2.kind, "allow", "model M2 should still be allowed (no cap on M2)");
});

// ---------------------------------------------------------------------------
// Scenario 3: no cap configured → behaviour unchanged (allow)
// ---------------------------------------------------------------------------
test("per-(key,model) cap — no cap configured → no block (unchanged behaviour)", async () => {
  await makePool();
  // No setModelCap call — cap table is empty

  const result = await enforceQuotaShare({
    apiKeyId: KEY_A,
    connectionId: CONN_ID,
    provider: PROVIDER,
    model: MODEL_M,
    estimatedCost: {},
  });

  // With a pool but no model cap, the pool-level fair-share check runs.
  // KEY_A has weight=100, 0 consumption → well within fair-share → allow.
  assert.equal(result.kind, "allow", "no model cap → no block");
});

// ---------------------------------------------------------------------------
// Scenario 4: cap ≤ EPSILON → ignored (placeholder skip)
// ---------------------------------------------------------------------------
test("per-(key,model) cap — EPSILON cap value → ignored, request allowed", async () => {
  const pool = await makePool();

  // Insert a placeholder cap directly (Number.EPSILON > 0 passes DB CHECK constraint
  // but enforce.ts skips it: !(capValue > Number.EPSILON) → true for EPSILON).
  await getTestBackend().execute(
    `INSERT INTO quota_allocation_model_caps (pool_id, api_key_id, model, cap_value, cap_unit)
     VALUES ($1, $2, $3, $4, $5)`,
    [pool.id, KEY_A, MODEL_M, Number.EPSILON, "requests"]
  );

  const result = await enforceQuotaShare({
    apiKeyId: KEY_A,
    connectionId: CONN_ID,
    provider: PROVIDER,
    model: MODEL_M,
    estimatedCost: {},
  });

  assert.equal(result.kind, "allow", "EPSILON cap → placeholder → skip → allow");
});
