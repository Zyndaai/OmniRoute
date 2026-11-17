/**
 * tests/unit/quota-division-blocks.test.ts
 *
 * Task A2 — per-key quota division blocks for countable units.
 *
 * Regression: before the fix, enforce.ts derived consumedTotal from the
 * saturation signal (globalUsedPercent × effectiveLimit), which is always 0
 * for countable units (requests/tokens/usd). As a result, the pool was never
 * considered "saturated" and enforceQuotaShare never returned "block" for
 * countable-unit overage, regardless of actual consumption.
 *
 * After the fix, enforce.ts uses store.poolConsumedTotal() for countable units,
 * which sums real per-key consumption from the store. When the pool total ≥
 * effectiveLimit the decision is "block" (global-saturated path in decideFairShare).
 *
 * Test scenarios (integration through enforceQuotaShare + real SQLite store):
 *   A. Pool total OVER budget → block (global-saturated fires when
 *      consumedTotal ≥ effectiveLimit).
 *   B. Pool total UNDER budget, key UNDER fair-share → allow.
 *
 * Both scenarios run within a SINGLE test against the SAME SQLite DB using
 * distinct connection IDs / pool IDs so their consumptions are fully isolated.
 *
 * Setup:
 *   - Custom provider "test-provider-a2" (not in catalog → manual plan only).
 *   - provider_plans: requests/hourly/limit=100 for each connection.
 *   - accountCount=1 → effectiveLimit=100; fairShare for 50%-weight key = 50.
 *   - Pool with 1 connection, 2 API keys at 50/50 hard policy per scenario.
 *
 * Scenario A: keyA=60, keyB=60 → poolTotal=120 ≥ effectiveLimit=100 → block.
 * Scenario B: keyA=20, keyB=20 → poolTotal=40 < effectiveLimit=100 → allow.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Set DATA_DIR BEFORE any DB import (resolved as module-level constant) ───
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-division-blocks-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "quota-division-blocks-test-secret";

// ── Imports ──────────────────────────────────────────────────────────────────
const providersDb = await import("../../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const providerPlans = await import("../../../src/lib/db/providerPlans.ts");
const quotaPools = await import("../../../src/lib/db/quotaPools.ts");
const { SqliteQuotaStore } = await import("../../../src/lib/quota/sqliteQuotaStore.ts");
const { enforceQuotaShare } = await import("../../../src/lib/quota/enforce.ts");
const core = await import("../../../src/lib/db/core.ts");

// ── Suite cleanup ─────────────────────────────────────────────────────────────
test.after(async () => {
  await core.resetDbInstance();
  if (fs.existsSync(TEST_DATA_DIR)) {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
});

// ── Constants ─────────────────────────────────────────────────────────────────
const LIMIT = 100; // per-account plan limit; accountCount=1 → effectiveLimit=100
const store = new SqliteQuotaStore();

// quota_allocations reference api_keys on Postgres: every allocated key must be a real row.
async function seedApiKey(name: string): Promise<string> {
  const key = (await apiKeysDb.createApiKey(name, "quota-division-blocks-test")) as {
    id: string;
  };
  return String(key.id);
}

// provider_plans and quota pools reference provider_connections on Postgres, so each scenario
// needs a real connection row; its id is what the plan and pool are keyed by.
async function seedConnection(provider: string, name: string): Promise<string> {
  const connection = (await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `${name}-key`,
    isActive: true,
    testStatus: "active",
  })) as Record<string, unknown>;
  return String(connection.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Single suite: both scenarios share a DB, isolated by distinct pool/conn IDs
// ─────────────────────────────────────────────────────────────────────────────

await test("quota-division-blocks: countable-unit enforcement (block + allow)", async (t) => {
  // ── Scenario A: pool total > effectiveLimit → block ──────────────────────
  await t.test("[A] pool total > effectiveLimit → block (global-saturated)", async () => {
    const PROV = "test-provider-a2-block";
    const CONN = await seedConnection(PROV, "block-account");
    const KEY_A = await seedApiKey("block-a");
    const KEY_B = await seedApiKey("block-b");

    // Seed plan: requests/hourly/limit=100
    await providerPlans.upsertPlan(
      CONN,
      PROV,
      [{ unit: "requests", window: "hourly", limit: LIMIT }],
      "manual"
    );

    // Create pool: 2 allocations at 50/50 hard
    const pool = await quotaPools.createPool({
      connectionId: CONN,
      name: "Block Pool A",
      allocations: [
        { apiKeyId: KEY_A, weight: 50, policy: "hard" },
        { apiKeyId: KEY_B, weight: 50, policy: "hard" },
      ],
    });

    const dim = { poolId: pool.id, unit: "requests" as const, window: "hourly" as const };

    // Consume: keyA=60, keyB=60 → poolTotal=120 > effectiveLimit=100
    await store.consume(KEY_A, dim, 60);
    await store.consume(KEY_B, dim, 60);

    const decision = await enforceQuotaShare({
      apiKeyId: KEY_A,
      connectionId: CONN,
      provider: PROV,
      estimatedCost: { requests: 1 },
    });

    assert.equal(
      decision.kind,
      "block",
      `[A] Expected block when poolTotal(120) ≥ effectiveLimit(100); got: ${JSON.stringify(decision)}`
    );
  });

  // ── Scenario B: pool total < effectiveLimit, key under fair-share → allow ─
  await t.test("[B] pool total < effectiveLimit and key under fair-share → allow", async () => {
    const PROV = "test-provider-a2-allow";
    const CONN = await seedConnection(PROV, "allow-account");
    const KEY_A = await seedApiKey("allow-a");
    const KEY_B = await seedApiKey("allow-b");

    // Seed plan for separate connection: requests/hourly/limit=100
    await providerPlans.upsertPlan(
      CONN,
      PROV,
      [{ unit: "requests", window: "hourly", limit: LIMIT }],
      "manual"
    );

    // Create pool: distinct from Scenario A (different poolId + connection)
    const pool = await quotaPools.createPool({
      connectionId: CONN,
      name: "Allow Pool B",
      allocations: [
        { apiKeyId: KEY_A, weight: 50, policy: "hard" },
        { apiKeyId: KEY_B, weight: 50, policy: "hard" },
      ],
    });

    const dim = { poolId: pool.id, unit: "requests" as const, window: "hourly" as const };

    // Consume: keyA=20, keyB=20 → poolTotal=40 < effectiveLimit=100
    await store.consume(KEY_A, dim, 20);
    await store.consume(KEY_B, dim, 20);

    const decision = await enforceQuotaShare({
      apiKeyId: KEY_A,
      connectionId: CONN,
      provider: PROV,
      estimatedCost: { requests: 1 },
    });

    assert.equal(
      decision.kind,
      "allow",
      `[B] Expected allow when poolTotal(40) < effectiveLimit(100); got: ${JSON.stringify(decision)}`
    );
  });
});
