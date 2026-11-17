/**
 * API-key policy config cache (perf, 2026-11-17): the billing team, key quota limits, token
 * limits and quota allocations of a key are read on every request and cached per key for a
 * few seconds. Every write through the owning module must be visible to the next read.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY_SECRET ||= "api-key-policy-cache-test-secret";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
import { invalidateDbCache } from "../../../src/lib/db/readCache.ts";
import { createApiKey } from "../../../src/lib/db/apiKeys.ts";
import {
  clearKeyQuotaLimits,
  getKeyQuotaLimits,
  upsertKeyQuotaLimits,
} from "../../../src/lib/db/keyQuota.ts";
import {
  deleteTokenLimit,
  getTokenLimitsForRequest,
  upsertTokenLimit,
} from "../../../src/lib/db/tokenLimits.ts";
import {
  archiveTeam,
  assignApiKeyBillingTeam,
  createTeam,
  getActiveBillingTeamForApiKey,
  unassignApiKeyBillingTeam,
  updateTeam,
} from "../../../src/lib/db/teams.ts";
import {
  createPool,
  deletePool,
  listAllocationsForApiKey,
  upsertAllocations,
} from "../../../src/lib/db/quotaPools.ts";

let keyId = "";

test.beforeEach(async () => {
  await resetTestDb();
  keyId = (await createApiKey("policy-cache", "machine-test")).id;
});

test.after(async () => {
  await resetDbInstance();
});

test("key quota limits: upsert and clear take effect at once", async () => {
  assert.equal((await getKeyQuotaLimits(keyId)).rpmLimit, null);
  await upsertKeyQuotaLimits(keyId, { rpmLimit: 60 });
  assert.equal((await getKeyQuotaLimits(keyId)).rpmLimit, 60);
  await upsertKeyQuotaLimits(keyId, { tpmLimit: 1000 });
  const both = await getKeyQuotaLimits(keyId);
  assert.equal(both.rpmLimit, 60);
  assert.equal(both.tpmLimit, 1000);
  await clearKeyQuotaLimits(keyId);
  assert.equal((await getKeyQuotaLimits(keyId)).rpmLimit, null);
});

test("key quota limits: a caller cannot change the cached copy", async () => {
  await upsertKeyQuotaLimits(keyId, { rpmLimit: 60 });
  const limits = await getKeyQuotaLimits(keyId);
  limits.rpmLimit = 1;
  assert.equal((await getKeyQuotaLimits(keyId)).rpmLimit, 60);
});

test("token limits: create, update and delete take effect at once", async () => {
  assert.deepEqual(await getTokenLimitsForRequest(keyId, "openai", "gpt-x"), []);
  const created = await upsertTokenLimit({ apiKeyId: keyId, scopeType: "global", tokenLimit: 500 });
  assert.deepEqual(
    (await getTokenLimitsForRequest(keyId, "openai", "gpt-x")).map((l) => l.tokenLimit),
    [500]
  );
  await upsertTokenLimit({
    id: created.id,
    apiKeyId: keyId,
    scopeType: "global",
    tokenLimit: 900,
  });
  assert.deepEqual(
    (await getTokenLimitsForRequest(keyId, "openai", "gpt-x")).map((l) => l.tokenLimit),
    [900]
  );
  assert.equal(await deleteTokenLimit(created.id), true);
  assert.deepEqual(await getTokenLimitsForRequest(keyId, "openai", "gpt-x"), []);
});

test("token limits: entries are per provider/model", async () => {
  await upsertTokenLimit({
    apiKeyId: keyId,
    scopeType: "model",
    scopeValue: "gpt-x",
    tokenLimit: 100,
  });
  assert.equal((await getTokenLimitsForRequest(keyId, "openai", "gpt-x")).length, 1);
  assert.equal((await getTokenLimitsForRequest(keyId, "openai", "gpt-y")).length, 0);
});

test("billing team: assign, budget edit, unassign and archive take effect at once", async () => {
  assert.equal(await getActiveBillingTeamForApiKey(keyId), null);
  const team = await createTeam({ name: "Team A" });
  await assignApiKeyBillingTeam(keyId, team.id);
  assert.equal((await getActiveBillingTeamForApiKey(keyId))?.id, team.id);

  await updateTeam(team.id, { maxBudgetUsd: 25, budgetDuration: "30d" });
  assert.equal((await getActiveBillingTeamForApiKey(keyId))?.maxBudgetUsd, 25);

  assert.equal(
    await unassignApiKeyBillingTeam(keyId, new Date(Date.now() + 1000).toISOString()),
    true
  );
  assert.equal(await getActiveBillingTeamForApiKey(keyId), null);

  const teamB = await createTeam({ name: "Team B" });
  await assignApiKeyBillingTeam(keyId, teamB.id, new Date(Date.now() + 2000).toISOString());
  assert.equal((await getActiveBillingTeamForApiKey(keyId))?.id, teamB.id);
  await archiveTeam(teamB.id, new Date(Date.now() + 3000).toISOString());
  assert.equal(await getActiveBillingTeamForApiKey(keyId), null);
});

test("quota allocations: create, replace and delete take effect at once", async () => {
  await getTestBackend().execute(
    "INSERT INTO provider_connections (id, provider) VALUES ('c1', 'openai') ON CONFLICT (id) DO NOTHING"
  );
  assert.deepEqual(await listAllocationsForApiKey(keyId), []);
  const pool = await createPool({
    connectionId: "c1",
    name: "pool-a",
    allocations: [{ apiKeyId: keyId, weight: 100, policy: "hard" }],
  });
  assert.deepEqual(
    (await listAllocationsForApiKey(keyId)).map((a) => a.poolId),
    [pool.id]
  );
  await upsertAllocations(pool.id, []);
  assert.deepEqual(await listAllocationsForApiKey(keyId), []);
  await upsertAllocations(pool.id, [{ apiKeyId: keyId, weight: 50, policy: "soft" }]);
  assert.equal((await listAllocationsForApiKey(keyId))[0]?.allocation.policy, "soft");
  assert.equal(await deletePool(pool.id), true);
  assert.deepEqual(await listAllocationsForApiKey(keyId), []);
});

test("a raw write is seen after a full cache invalidation", async () => {
  await upsertKeyQuotaLimits(keyId, { rpmLimit: 60 });
  assert.equal((await getKeyQuotaLimits(keyId)).rpmLimit, 60);
  await getTestBackend().execute(
    "UPDATE api_key_quota_limits SET rpm_limit = 5 WHERE api_key_id = $1",
    [keyId]
  );
  // Another process's write: served from the cache until it expires or is invalidated.
  assert.equal((await getKeyQuotaLimits(keyId)).rpmLimit, 60);
  invalidateDbCache();
  assert.equal((await getKeyQuotaLimits(keyId)).rpmLimit, 5);
});
