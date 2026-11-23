/**
 * Companion regression for #13876 — enforceQuotaShare side.
 *
 * A cap configured via the pool's PRIMARY connection's plan (the only
 * connection the wizard's "Limite" step ever PUTs an override to) must also
 * be enforced correctly for a request that is actually served by a
 * NON-primary pool member connection. Before the fix, enforceQuotaShare
 * resolved the plan from `input.connectionId` (the serving connection), so a
 * non-primary connection with no override fell back to an empty plan and the
 * cap was silently never enforced for traffic routed through it.
 *
 * getSaturation(input.connectionId, ...) remains per-connection by design —
 * only plan/dimension resolution moves to the pool's canonical connection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-13876-enf-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "quota-13876-enforce-secret";

const core = await import("../../../src/lib/db/core.ts");
const poolsDb = await import("../../../src/lib/db/quotaPools.ts");
const plansDb = await import("../../../src/lib/db/providerPlans.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { getTestBackend } = await import("../../helpers/postgres.ts");

test.after(async () => {
  await core.resetDbInstance();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("multi-connection pool: a cap set on the primary connection's plan is enforced for a request served by a non-primary member", async () => {
  const { enforceQuotaShare, recordConsumption } = await import("../../../src/lib/quota/enforce.ts");

  const PROVIDER = "quota-13876-enforce-test-provider"; // not in the built-in catalog on purpose

  // Pool and plan rows reference provider connections and the API key by foreign key.
  for (const id of ["conn-primary-2", "conn-secondary-2"]) {
    await getTestBackend().execute(
      "INSERT INTO provider_connections (id, provider) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [id, PROVIDER]
    );
  }
  const key = await apiKeysDb.createApiKey("quota-13876-enforce-key", "machine-13876-enforce");
  const apiKeyId = key.id as string;

  await poolsDb.createPool({
    connectionId: "conn-primary-2",
    connectionIds: ["conn-primary-2", "conn-secondary-2"],
    name: "Repro Pool #13876 (enforce)",
    allocations: [{ apiKeyId, weight: 100, policy: "hard" }],
  });

  // The operator sets a small daily token cap via the wizard — only the
  // primary connection gets the manual override. The pool has 2 member
  // connections, so the effective (global) limit is limit × accountCount —
  // set the per-account limit small enough that a single request still
  // saturates the whole pool.
  await plansDb.upsertPlan(
    "conn-primary-2",
    PROVIDER,
    [{ unit: "tokens", window: "daily", limit: 100 }],
    "manual"
  );

  // A request served via the secondary connection consumes past the
  // effective (accountCount-multiplied) cap of 200 tokens.
  await recordConsumption({
    apiKeyId,
    connectionId: "conn-secondary-2",
    provider: PROVIDER,
    cost: { tokens: 1500, usd: 0, requests: 1 },
  });

  // The NEXT request, also served via the secondary connection, must now be
  // blocked by the cap that was configured only on the primary connection's
  // plan — matching what the dashboard (which reads via pool.connectionId)
  // shows as consumed.
  const decision = await enforceQuotaShare({
    apiKeyId,
    connectionId: "conn-secondary-2",
    provider: PROVIDER,
  });

  assert.equal(
    decision.kind,
    "block",
    `expected the primary connection's cap to block a request served via the secondary connection, got ${JSON.stringify(decision)}`
  );
});
