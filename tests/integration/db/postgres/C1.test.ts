/**
 * Group C1 against a real PostgreSQL: quota counters and limits, token limits, quota pools,
 * domain budgets/lockouts/breakers, exclusive leases, Codex wakeups, relay tokens, the
 * server-tool fence and the other runtime-state tables.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.STORAGE_ENCRYPTION_KEY ||= "c1-test-storage-encryption-key-0123456789";

import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";

const backend = getTestBackend();

const tokenLimits = await import("../../../../src/lib/db/tokenLimits.ts");
const tokenCounter = await import("../../../../open-sse/services/tokenLimitCounter.ts");
const keyQuota = await import("../../../../src/lib/db/keyQuota.ts");
const consumption = await import("../../../../src/lib/db/quotaConsumption.ts");
const groups = await import("../../../../src/lib/db/quotaGroups.ts");
const pools = await import("../../../../src/lib/db/quotaPools.ts");
const modelCaps = await import("../../../../src/lib/db/quotaModelCaps.ts");
const schedules = await import("../../../../src/lib/db/quotaSchedules.ts");
const tickets = await import("../../../../src/lib/db/quotaRecoveryTickets.ts");
const plans = await import("../../../../src/lib/db/providerPlans.ts");
const runtimeState = await import("../../../../src/lib/db/connectionRuntimeState.ts");
const providerQuota = await import("../../../../src/lib/quota/providerQuotaState.ts");
const quotaAnalytics = await import("../../../../src/lib/quota/quotaAnalytics.ts");
const resetTimers = await import("../../../../src/lib/quota/quotaResetTimers.ts");
const domain = await import("../../../../src/lib/db/domainState.ts");
const leases = await import("../../../../src/lib/db/exclusiveConnectionLeases.ts");
const codex = await import("../../../../src/lib/db/codexWakeups.ts");
const commandCode = await import("../../../../src/lib/db/commandCodeAuth.ts");
const handoffs = await import("../../../../src/lib/db/contextHandoffs.ts");
const relay = await import("../../../../src/lib/db/relayProxies.ts");
const fenceDb = await import("../../../../src/lib/db/skillExecutionFence.ts");
const fence = await import("../../../../src/lib/skills/toolExecutionFence.ts");
const apiKeyLimits = await import("../../../../src/lib/usage/apiKeyUsageLimits.ts");
const teamLimits = await import("../../../../src/lib/usage/teamUsageLimits.ts");
const { invalidateDbCache } = await import("../../../../src/lib/db/readCache.ts");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function addKey(id: string) {
  await backend.execute(
    "INSERT INTO api_keys (id, name, key, key_hash) VALUES ($1, $1, $2, $3) ON CONFLICT DO NOTHING",
    [id, `raw-${id}`, sha(id)]
  );
}

async function addConn(id: string, provider = "codex") {
  await backend.execute(
    "INSERT INTO provider_connections (id, provider) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [id, provider]
  );
}

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const row = await backend.queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    params
  );
  return row?.n ?? 0;
}

async function waitFor(check: () => Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition not reached in time");
}

test.beforeEach(async () => {
  await truncateAll(backend, { except: [] });
  // the seed group is created by the migration; truncate removed it
  await backend.execute(
    "INSERT INTO quota_groups (id, name) VALUES ('group-demo', 'GroupDemo') ON CONFLICT DO NOTHING"
  );
  tokenCounter.clearTokenLimitCache();
});

// ---------------------------------------------------------------------------------------------
// Token limits
// ---------------------------------------------------------------------------------------------

test("token limits: CRUD, id update conflicts, uuid guard, cascade", async () => {
  await addKey("k1");
  const model = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k1",
    scopeType: "model",
    scopeValue: " gpt-4 ",
    tokenLimit: 1000.9,
    resetInterval: "daily",
    resetTime: "06:30",
  });
  assert.equal(model.scopeValue, "gpt-4");
  assert.equal(model.tokenLimit, 1000);
  assert.equal(model.resetTime, "06:30");
  assert.equal(model.enabled, true);
  assert.match(model.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  // Same scope + interval merges into the same row.
  const merged = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k1",
    scopeType: "model",
    scopeValue: "gpt-4",
    tokenLimit: 2000,
    resetInterval: "daily",
    enabled: false,
  });
  assert.equal(merged.id, model.id);
  assert.equal(merged.tokenLimit, 2000);
  assert.equal(merged.enabled, false);
  assert.equal(merged.resetTime, "00:00");

  // A different interval is a different limit.
  const weekly = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k1",
    scopeType: "model",
    scopeValue: "gpt-4",
    tokenLimit: 5000,
    resetInterval: "weekly",
  });
  assert.notEqual(weekly.id, model.id);

  await assert.rejects(
    tokenLimits.upsertTokenLimit({
      id: weekly.id,
      apiKeyId: "k1",
      scopeType: "model",
      scopeValue: "gpt-4",
      tokenLimit: 1,
      resetInterval: "daily",
    }),
    tokenLimits.TokenLimitConflictError
  );
  await assert.rejects(
    tokenLimits.upsertTokenLimit({
      id: "not-a-uuid",
      apiKeyId: "k1",
      scopeType: "global",
      tokenLimit: 1,
    }),
    tokenLimits.TokenLimitNotFoundError
  );
  const updated = await tokenLimits.upsertTokenLimit({
    id: weekly.id,
    apiKeyId: "k1",
    scopeType: "global",
    tokenLimit: 77,
    resetInterval: "monthly",
  });
  assert.equal(updated.scopeType, "global");
  assert.equal(updated.scopeValue, "");

  const listed = await tokenLimits.listTokenLimits("k1");
  assert.deepEqual(
    listed.map((l) => l.scopeType),
    ["model", "global"]
  );

  const forRequest = await tokenLimits.getTokenLimitsForRequest("k1", "openai", "gpt-4");
  assert.deepEqual(
    forRequest.map((l) => l.id),
    [updated.id],
    "the model limit is disabled, the global one applies"
  );

  await tokenLimits.incrementWindowTokens(updated.id, "1700000000000", 5);
  await tokenLimits.logTokenLimitReset(updated.id, 5, "1700000000000");
  assert.equal(await tokenLimits.deleteTokenLimit("not-a-uuid"), false);
  assert.equal(await tokenLimits.deleteTokenLimit(updated.id), true);
  assert.equal(await count("api_key_token_counters"), 0);
  assert.equal(await count("api_key_token_limit_reset_logs"), 0);

  await backend.execute("DELETE FROM api_keys WHERE id = 'k1'");
  assert.equal(await count("api_key_token_limits"), 0, "key delete cascades");
});

test("token limits: concurrent increments, one reset log per window, cold-window seed", async () => {
  await addKey("k2");
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k2",
    scopeType: "global",
    tokenLimit: 100,
    resetInterval: "daily",
  });
  const { windowStart } = tokenLimits.resetWindowIfElapsed(limit);

  await Promise.all(
    Array.from({ length: 20 }, () => tokenLimits.incrementWindowTokens(limit.id, windowStart, 5))
  );
  assert.equal(await tokenLimits.getWindowUsage(limit), 100);

  await Promise.all(
    Array.from({ length: 5 }, () => tokenLimits.logTokenLimitReset(limit.id, 9, windowStart))
  );
  assert.equal(await count("api_key_token_limit_reset_logs"), 1);

  // Cold window: usage_history seeds the counter once even under concurrent reads.
  await backend.execute("TRUNCATE api_key_token_counters");
  tokenCounter.clearTokenLimitCache();
  const now = new Date().toISOString();
  await backend.execute(
    `INSERT INTO usage_history ("timestamp", api_key_id, provider, model, tokens_input, tokens_output, tokens_reasoning)
     VALUES ($1, 'k2', 'openai', 'gpt-4', 60, 40, 20), ($1, 'k2', 'openai', 'gpt-4', 30, 10, 0)`,
    [now]
  );
  const reads = await Promise.all(
    Array.from({ length: 5 }, () => tokenCounter.getCurrentWindowUsage(limit, Date.now(), true))
  );
  assert.deepEqual(reads, [160, 160, 160, 160, 160]);
  assert.equal(await tokenLimits.getWindowUsage(limit), 160);

  const breach = await tokenCounter.checkTokenLimits("k2", "openai", "gpt-4");
  assert.ok(breach);
  assert.equal(breach.limitId, limit.id);
  assert.equal(breach.tokensUsed, 160);
  assert.equal(breach.remaining, 0);
  assert.equal(await tokenCounter.checkTokenLimits("nobody", "openai", "gpt-4"), null);
});

test("token limits: recordTokenUsage accumulates and logs the rollover once", async () => {
  await addKey("k3");
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k3",
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 100000,
    resetInterval: "daily",
  });
  // Usage left in the previous window: its counter row must produce one reset log.
  const now = Date.now();
  const current = tokenLimits.resetWindowIfElapsed(limit, now);
  const prior = String(current.periodStartAt - 86_400_000);
  await tokenLimits.incrementWindowTokens(limit.id, prior, 42);

  for (let i = 0; i < 3; i++) tokenCounter.recordTokenUsage("k3", "openai", "gpt-4", 10);
  await waitFor(async () => (await tokenLimits.getWindowUsage(limit, now)) === 30);
  assert.equal(await count("api_key_token_limit_reset_logs", "prev_tokens = 42"), 1);
});

// ---------------------------------------------------------------------------------------------
// Key quota + counters
// ---------------------------------------------------------------------------------------------

test("key quota: partial upserts, sliding window, unpriced marker, clear", async () => {
  await addKey("q1");
  assert.deepEqual(await keyQuota.getKeyQuotaLimits("q1"), {
    apiKeyId: "q1",
    tpmLimit: null,
    rpmLimit: null,
    monthlyAmountUsd: null,
  });
  await keyQuota.upsertKeyQuotaLimits("q1", { tpmLimit: 100 });
  const second = await keyQuota.upsertKeyQuotaLimits("q1", { rpmLimit: 5, monthlyAmountUsd: 12.5 });
  assert.equal(second.tpmLimit, 100, "omitted field keeps its value");
  assert.equal(second.rpmLimit, 5);
  assert.equal(second.monthlyAmountUsd, 12.5);

  await keyQuota.saveUnpricedQuotaMonthStart("q1", Date.UTC(2026, 10, 1));
  assert.equal(await keyQuota.loadUnpricedQuotaMonthStart("q1"), Date.UTC(2026, 10, 1));
  await keyQuota.upsertKeyQuotaLimits("q1", { tpmLimit: null });
  assert.equal(await keyQuota.loadUnpricedQuotaMonthStart("q1"), null, "saving limits resets it");
  assert.equal((await keyQuota.getKeyQuotaLimits("q1")).tpmLimit, null);

  await keyQuota.upsertKeyQuotaLimits("q1", { tpmLimit: 100 });
  const base = Math.floor(Date.now() / 60_000) * 60_000 + 30_000; // mid-minute
  await Promise.all(
    Array.from({ length: 10 }, () => keyQuota.incrementKeyQuotaCounter("q1", "tpm", 10, base))
  );
  await keyQuota.incrementKeyQuotaCounter("q1", "tpm", 20, base - 60_000);
  await keyQuota.recordKeyQuotaUsage("q1", 0, base);
  const status = await keyQuota.getKeyQuotaStatus("q1", {
    now: () => base,
    monthTotalUsd: 1,
  });
  assert.equal(status.counters.tpmUsed, 110); // 100 + 20 * (1 - 0.5)
  assert.equal(status.counters.rpmUsed, 1);
  assert.equal(status.tpmExceeded, true);
  assert.equal(status.rpmExceeded, false);

  await keyQuota.clearKeyQuotaLimits("q1");
  assert.equal(await count("quota_counters", "api_key_id = 'q1'"), 0);
  assert.equal(await count("api_key_quota_limits"), 0);
});

test("quota consumption: atomic buckets, pairs, pool sums, list, gc", async () => {
  const dim = "pool-a:requests:hourly";
  await Promise.all(
    Array.from({ length: 10 }, () => consumption.incrementBucket("ka", dim, 100, 2, Date.now()))
  );
  await consumption.incrementBucket("ka", dim, 99, 7, Date.now());
  await consumption.incrementBucket("kb", dim, 100, 3, Date.now());
  assert.equal(await consumption.getBucket("ka", dim, 100), 20);
  assert.equal(await consumption.getBucket("ka", dim, 5), 0);
  assert.deepEqual(await consumption.getPair("ka", dim, 100), { curr: 20, prev: 7 });
  assert.deepEqual(await consumption.sumPoolDimension(dim, 100), { currTotal: 23, prevTotal: 7 });

  const events = await consumption.listConsumptionForPool("pool-a", 10);
  assert.equal(events.length, 3);
  assert.equal(events[0].unit, "requests");
  assert.equal(events[0].window, "hourly");
  assert.ok(events[0].updatedAt > Date.now() - 60_000);
  assert.equal((await consumption.listConsumptionForPool("pool_a", 10)).length, 0);

  assert.equal(await consumption.gcOlderThan(Date.now() - 3_600_000), 0);
  assert.equal(await consumption.gcOlderThan(Date.now() + 1000), 3);
});

// ---------------------------------------------------------------------------------------------
// Quota groups, pools, caps, schedules
// ---------------------------------------------------------------------------------------------

test("quota pools: membership order, allocations keep caps, group propagation, cascade delete", async () => {
  await addKey("a1");
  await addKey("a2");
  for (const id of ["c1", "c2", "c3"]) await addConn(id, "codex");
  await addConn("c4", "claude");

  const group = await groups.createGroup("G1");
  assert.equal(await groups.getGroupName(group.id), "G1");
  assert.equal((await groups.listGroups()).length, 2);
  assert.equal(await groups.renameGroup(group.id, "G1b"), true);
  await assert.rejects(groups.deleteGroup("group-demo"), /protected/);

  const pool = await pools.createPool({
    connectionId: "c1",
    name: "p1",
    groupId: group.id,
    connectionIds: ["c1", "c2", "c1"],
    allocations: [
      { apiKeyId: "a1", weight: 60, policy: "hard" },
      { apiKeyId: "a2", weight: 40, capValue: 10, capUnit: "requests", policy: "soft" },
    ],
  });
  assert.equal(pool.connectionId, "c1");
  assert.deepEqual(pool.connectionIds, ["c1", "c2"]);
  assert.equal(pool.groupId, group.id);
  assert.equal(pool.allocations.length, 2);
  await assert.rejects(groups.deleteGroup(group.id), /has pools/);

  await assert.rejects(
    pools.createPool({ connectionId: "c1", name: "mixed", connectionIds: ["c1", "c4"] }),
    /single provider/
  );

  await modelCaps.setModelCap({
    poolId: pool.id,
    apiKeyId: "a1",
    model: "gpt-x",
    capValue: 5,
    capUnit: "tokens",
  });
  await modelCaps.setModelCap({
    poolId: pool.id,
    apiKeyId: "a1",
    model: "gpt-x",
    capValue: 6,
    capUnit: "tokens",
  });
  assert.equal((await modelCaps.getModelCap(pool.id, "a1", "gpt-x"))?.capValue, 6);
  assert.equal(await modelCaps.getModelCap(pool.id, "a1", "other"), null);

  // Reorder members and shrink allocations: a1's model cap survives, a2 goes.
  const updated = await pools.updatePool(pool.id, {
    name: "p1b",
    connectionIds: ["c3", "c1"],
    allocations: [{ apiKeyId: "a1", weight: 100, policy: "burst" }],
  });
  assert.ok(updated);
  assert.deepEqual(updated.connectionIds, ["c3", "c1"]);
  assert.equal(updated.connectionId, "c3");
  assert.equal(updated.name, "p1b");
  assert.deepEqual(
    updated.allocations.map((a) => [a.apiKeyId, a.policy]),
    [["a1", "burst"]]
  );
  assert.equal((await modelCaps.getModelCap(pool.id, "a1", "gpt-x"))?.capValue, 6);
  assert.equal(await pools.updatePool("missing", { name: "x" }), null);

  // Sibling pools in the group receive the same allocations.
  const sibling = await pools.createPool({ connectionId: "c2", name: "p2", groupId: group.id });
  await pools.upsertAllocations(pool.id, [
    { apiKeyId: "a1", weight: 0, policy: "hard" },
    { apiKeyId: "a2", weight: 0, policy: "hard" },
  ]);
  const siblingAfter = await pools.getPool(sibling.id);
  assert.deepEqual(siblingAfter?.allocations.map((a) => [a.apiKeyId, a.weight]).sort(), [
    ["a1", 50],
    ["a2", 50],
  ]);
  assert.equal((await pools.listAllocationsForApiKey("a2")).length, 2);
  assert.equal((await pools.getPoolsByGroup(group.id)).length, 2);
  const page = await pools.listPools({ limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);

  const again = await pools.ensurePool({
    connectionId: "c2",
    name: "p2",
    groupId: group.id,
    allocations: [
      { apiKeyId: "a1", weight: 50, policy: "hard" },
      { apiKeyId: "a2", weight: 50, policy: "hard" },
    ],
  });
  assert.deepEqual([again.created, again.updated], [false, false]);

  // Schedules.
  const saved = await schedules.replaceSchedules(pool.id, [
    {
      label: "work",
      days: [3, 1, 1, 9],
      startMinute: 60,
      endMinute: 120,
      timezone: "UTC",
      mode: "allow",
      reserves: [
        { window: "daily", percent: 20 },
        { window: "bogus" as never, percent: 20 },
      ],
      budgetValue: 5,
      budgetUnit: "usd",
      budgetWindow: "daily",
      priority: 2,
      enabled: true,
    },
    {
      days: [0],
      startMinute: 0,
      endMinute: 30,
      mode: "block",
      reserves: [],
      budgetWindow: "weekly",
      priority: 1,
      enabled: false,
    },
  ]);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0].days, [1, 3]);
  assert.deepEqual(saved[0].reserves, [{ window: "daily", percent: 20 }]);
  assert.equal(saved[0].budgetUnit, "usd");
  assert.equal(saved[1].enabled, false);
  assert.equal((await schedules.listEnabledSchedules(pool.id)).length, 1);
  assert.deepEqual(schedules.parseDays("1, 2,,x,7"), [1, 2]);

  // Deleting the pool removes members, allocations, caps and schedules, and prunes the key grant.
  await backend.execute(
    `UPDATE api_keys SET allowed_quotas = $2::jsonb WHERE id = $1`,
    ["a1", JSON.stringify([pool.id, "keep-me"])]
  );
  assert.equal(await pools.deletePool(pool.id), true);
  assert.equal(await pools.deletePool(pool.id), false);
  assert.equal(await pools.getPool(pool.id), null);
  assert.equal(await count("quota_pool_connections", "pool_id = $1", [pool.id]), 0);
  assert.equal(await count("quota_allocations", "pool_id = $1", [pool.id]), 0);
  assert.equal(await count("quota_allocation_model_caps"), 0);
  assert.equal(await count("quota_schedules"), 0);
  const key = await backend.queryOne<{ allowed_quotas: string[] }>(
    "SELECT allowed_quotas FROM api_keys WHERE id = 'a1'"
  );
  assert.deepEqual(key?.allowed_quotas, ["keep-me"]);
});

// ---------------------------------------------------------------------------------------------
// Recovery tickets
// ---------------------------------------------------------------------------------------------

test("quota recovery tickets: idempotent enqueue, single claimer, lifecycle", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const input = {
    apiKeyId: "env-key",
    turnKey: "s1:t1",
    endpoint: "responses" as const,
    requestPayload: '{"input":"hello"}',
    nextAttemptAt: past,
    expiresAt: future,
  };
  const first = await tickets.enqueueQuotaRecoveryTicket(input);
  const again = await tickets.enqueueQuotaRecoveryTicket(input);
  assert.equal(again.id, first.id);
  await assert.rejects(
    tickets.enqueueQuotaRecoveryTicket({ ...input, requestPayload: '{"input":"other"}' }),
    /reused with a different request/
  );
  assert.equal((await tickets.getQuotaRecoveryTicket(first.id, "env-key"))?.state, "pending");
  assert.equal(await tickets.getQuotaRecoveryTicket(first.id, "someone-else"), null);
  assert.equal(await tickets.getQuotaRecoveryTicket("not-a-uuid", "env-key"), null);
  assert.equal((await tickets.listDueQuotaRecoveryTickets()).length, 1);

  const claims = await Promise.all(
    Array.from({ length: 5 }, () => tickets.claimQuotaRecoveryTicket(first.id))
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.attemptCount, 1);
  assert.equal(await tickets.readQuotaRecoveryRequest(first.id), '{"input":"hello"}');

  assert.equal(await tickets.rescheduleQuotaRecoveryTicket(first.id, past), true);
  assert.ok(await tickets.claimQuotaRecoveryTicket(first.id));
  assert.equal(await tickets.completeQuotaRecoveryTicket(first.id, '{"ok":1}'), true);
  assert.equal(await tickets.completeQuotaRecoveryTicket(first.id, "{}"), false);
  assert.equal(await tickets.readQuotaRecoveryResult(first.id, "env-key"), '{"ok":1}');
  assert.equal(await tickets.readQuotaRecoveryResult(first.id, "other"), null);

  const second = await tickets.enqueueQuotaRecoveryTicket({ ...input, turnKey: "s1:t2" });
  assert.ok(await tickets.claimQuotaRecoveryTicket(second.id));
  assert.equal(await tickets.markQuotaRecoveryNeedsConfirmation(second.id), true);
  assert.equal(await tickets.cancelQuotaRecoveryTicket(second.id, "env-key"), true);

  const third = await tickets.enqueueQuotaRecoveryTicket({ ...input, turnKey: "s1:t3" });
  assert.ok(await tickets.claimQuotaRecoveryTicket(third.id));
  assert.equal(await tickets.reconcileInterruptedQuotaRecoveries(), 1);
  const fourth = await tickets.enqueueQuotaRecoveryTicket({ ...input, turnKey: "s1:t4" });
  assert.ok(await tickets.claimQuotaRecoveryTicket(fourth.id));
  assert.equal(
    await tickets.reconcileStaleRunningQuotaRecoveries(new Date(Date.now() + 3_600_000), 60_000),
    1
  );
  assert.equal(await tickets.failQuotaRecoveryTicket(fourth.id), false);
  assert.equal(await tickets.expireQuotaRecoveryTickets(new Date(Date.now() + 7_200_000)) >= 3, true);
});

// ---------------------------------------------------------------------------------------------
// Provider plans, runtime state, provider quota state
// ---------------------------------------------------------------------------------------------

test("provider plans and connection runtime state", async () => {
  await addConn("pc1");
  await plans.upsertPlan("pc1", "codex", [{ unit: "tokens", window: "daily", limit: 10 }], "auto");
  await plans.upsertPlan("pc1", "codex", [{ unit: "usd", window: "weekly", limit: 3 }], "manual");
  const plan = await plans.getPlan("pc1");
  assert.deepEqual(plan, {
    connectionId: "pc1",
    provider: "codex",
    dimensions: [{ unit: "usd", window: "weekly", limit: 3 }],
    source: "manual",
  });
  assert.equal((await plans.listPlans()).length, 1);
  assert.equal(await plans.deletePlan("pc1"), true);
  assert.equal(await plans.getPlan("pc1"), null);

  assert.equal(await runtimeState.getConnectionRuntimeState("pc1"), null);
  const at = "2026-11-16T10:00:00.000Z";
  await runtimeState.upsertWarmupState("pc1", { lastWarmupAt: at, lastResult: "ok", tokensUsed: 7 });
  await runtimeState.upsertWarmupCircuit("pc1", {
    streak: 3,
    until: "2026-11-16T11:00:00.000Z",
    lastFailAt: at,
  });
  const state = await runtimeState.getConnectionRuntimeState("pc1");
  assert.equal(state?.warmupCircuitStreak, 3);
  assert.equal(state?.lastWarmupAt, at);
  assert.equal(state?.lastWarmupResult, "ok");
  assert.equal(state?.warmupTokensUsed, 7);
  await runtimeState.clearWarmupCircuit("pc1");
  assert.equal((await runtimeState.getConnectionRuntimeState("pc1"))?.warmupCircuitUntil, null);
  await runtimeState.markForbidden("pc1", at);
  assert.equal((await runtimeState.getConnectionRuntimeState("pc1"))?.lastWarmupResult, "forbidden");
  await backend.execute("DELETE FROM provider_connections WHERE id = 'pc1'");
  assert.equal(await runtimeState.getConnectionRuntimeState("pc1"), null, "connection FK cascade");
});

test("provider quota state: atomic window roll, analytics, expired purge", async () => {
  const windowMs = 86_400_000;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      providerQuota.recordProviderQuotaUsage("pq1", "m1", 5, { tokenLimit: 100, windowMs })
    )
  );
  let snap = await providerQuota.getProviderQuota("pq1", "m1");
  assert.equal(snap?.known, true);
  assert.equal(snap?.tokensUsed, 50);
  assert.equal(snap?.tokenLimit, 100);
  assert.equal(snap?.tokensRemaining, 50);
  assert.equal(snap?.remainingRatio, 0.5);
  assert.equal(await providerQuota.getProviderQuota("pq1", "nope"), null);

  await providerQuota.recordProviderQuotaUsage("pq2", "m1", 10, { tokenLimit: 10, windowMs });
  const summary = await quotaAnalytics.getQuotaAnalyticsSummary();
  assert.equal(summary.totalConnectionsTracked, 2);
  assert.equal(summary.exhaustedConnections, 1);
  assert.equal(summary.totalTokensUsed, 60);
  assert.equal(summary.totalTokenLimit, 110);
  assert.equal((await resetTimers.getActiveQuotaResetItems()).length, 2);

  // The window rolled: the next write restarts usage at the delta.
  await backend.execute(
    "UPDATE provider_quota_state SET window_reset = now() - interval '1 minute' WHERE connection_id = 'pq1'"
  );
  snap = await providerQuota.getProviderQuota("pq1", "m1");
  assert.equal(snap?.known, false);
  await providerQuota.recordProviderQuotaUsage("pq1", "m1", 3, { windowMs });
  snap = await providerQuota.getProviderQuota("pq1", "m1");
  assert.equal(snap?.tokensUsed, 3);
  assert.equal(snap?.tokenLimit, 100, "limit is kept when the caller passes none");

  await backend.execute(
    "UPDATE provider_quota_state SET window_reset = now() - interval '1 minute' WHERE connection_id = 'pq2'"
  );
  assert.equal(await resetTimers.resetExpiredQuotaWindows(), 1);
  await providerQuota.clearProviderQuota("pq1");
  assert.equal(await count("provider_quota_state"), 0);
});

// ---------------------------------------------------------------------------------------------
// Domain state
// ---------------------------------------------------------------------------------------------

test("domain budgets: round trip, preserved unpriced marker, one reset log per period, cascade", async () => {
  const resetAt = Date.parse("2026-11-17T06:00:00.000Z");
  await domain.saveBudget("b1", {
    dailyLimitUsd: 5,
    monthlyLimitUsd: 100,
    warningThreshold: 0.5,
    resetInterval: "daily",
    resetTime: "06:00",
    budgetResetAt: resetAt,
    lastBudgetResetAt: 0,
  });
  const loaded = await domain.loadBudget("b1");
  assert.equal(loaded?.dailyLimitUsd, 5);
  assert.equal(loaded?.weeklyLimitUsd, 0);
  assert.equal(loaded?.monthlyLimitUsd, 100);
  assert.equal(loaded?.resetTime, "06:00");
  assert.equal(loaded?.budgetResetAt, resetAt);
  assert.equal(loaded?.lastBudgetResetAt, null);
  assert.equal(await domain.loadBudget("missing"), null);

  await domain.saveBudgetUnpricedPeriodStart("b1", 1_700_000_000_000);
  await domain.saveBudget("b1", { dailyLimitUsd: 6, resetTime: "bogus" });
  assert.equal(await domain.loadBudgetUnpricedPeriodStart("b1"), 1_700_000_000_000);
  assert.equal((await domain.loadBudget("b1"))?.resetTime, "00:00");
  await domain.saveBudgetUnpricedPeriodStart("nobudget", 1_700_000_000_000);
  assert.equal(await domain.loadBudgetUnpricedPeriodStart("nobudget"), null);

  const log = {
    apiKeyId: "b1",
    resetInterval: "daily" as const,
    previousSpend: 1.25,
    resetAt: 1_700_000_100_000,
    nextResetAt: 1_700_086_500_000,
    periodStart: 1_700_000_000_000,
    periodEnd: 1_700_086_400_000,
  };
  await Promise.all(Array.from({ length: 5 }, () => domain.saveBudgetResetLog(log)));
  const logs = await domain.loadBudgetResetLogs("b1");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].previousSpend, 1.25);
  assert.equal(logs[0].periodStart, 1_700_000_000_000);

  assert.deepEqual(Object.keys(await domain.loadAllBudgets()), ["b1"]);
  await domain.deleteBudget("b1");
  assert.equal(await count("domain_budget_reset_logs"), 0);
  assert.equal(await domain.loadBudgetUnpricedPeriodStart("b1"), null);
});

test("domain state: cost history, fallback chains, lockouts, circuit breakers", async () => {
  const t0 = Date.parse("2026-11-16T00:00:00.000Z");
  await domain.saveCostEntry("c", 1.5, t0);
  await domain.batchSaveCostEntries([
    { apiKeyId: "c", cost: 2, timestamp: t0 + 1000 },
    { apiKeyId: "c", cost: 3, timestamp: t0 + 2000 },
    { apiKeyId: "d", cost: 9, timestamp: t0 },
  ]);
  assert.equal(await domain.loadCostTotal("c", t0), 6.5);
  assert.equal(await domain.loadCostTotal("c", t0 + 1000), 5);
  assert.deepEqual(await domain.loadCostEntries("c", t0 + 1000), [
    { cost: 2, timestamp: t0 + 1000 },
    { cost: 3, timestamp: t0 + 2000 },
  ]);
  assert.equal((await domain.loadCostEntriesInRange("c", t0, t0 + 2000)).length, 2);
  assert.equal(await domain.cleanOldCostEntries(t0 + 1), 2);
  await domain.deleteCostEntries("c");
  assert.equal(await count("domain_cost_history"), 0);
  await domain.deleteAllCostData();

  const chain = [{ provider: "openai", priority: 1, enabled: true }];
  await domain.saveFallbackChain("gpt-4", chain);
  await domain.saveFallbackChain("gpt-4", [...chain, { provider: "x", priority: 2, enabled: false }]);
  assert.equal((await domain.loadFallbackChain("gpt-4"))?.length, 2);
  assert.equal(await domain.loadFallbackChain("nope"), null);
  assert.deepEqual(Object.keys(await domain.loadAllFallbackChains()), ["gpt-4"]);
  assert.equal(await domain.deleteFallbackChain("gpt-4"), true);
  await domain.deleteAllFallbackChains();

  // Concurrent failed attempts are all kept.
  const base = Date.parse("2026-11-16T12:00:00.000Z");
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => domain.appendLockoutAttempt("1.2.3.4", base + i))
  );
  const state = await domain.loadLockoutState("1.2.3.4");
  assert.equal(state?.attempts.length, 10);
  assert.equal(state?.lockedUntil, null);
  await domain.saveLockoutState("1.2.3.4", {
    attempts: [base, base + 5],
    lockedUntil: Date.now() + 60_000,
  });
  const saved = await domain.loadLockoutState("1.2.3.4");
  assert.deepEqual(saved?.attempts, [base, base + 5]);
  assert.equal((await domain.loadAllLockedIdentifiers()).length, 1);
  await domain.deleteLockoutState("1.2.3.4");
  assert.equal(await domain.loadLockoutState("1.2.3.4"), null);

  await domain.saveCircuitBreakerState("openai", {
    state: "OPEN",
    failureCount: 4,
    lastFailureTime: base,
    options: { threshold: 5 },
  });
  assert.deepEqual(await domain.loadCircuitBreakerState("openai"), {
    state: "OPEN",
    failureCount: 4,
    lastFailureTime: base,
    options: { threshold: 5 },
  });
  await domain.saveCircuitBreakerState("claude", {
    state: "weird",
    failureCount: 0,
    lastFailureTime: null,
  });
  assert.equal((await domain.loadCircuitBreakerState("claude"))?.state, "CLOSED");
  assert.equal((await domain.loadAllCircuitBreakerStates()).length, 2);
  await domain.deleteCircuitBreakerState("claude");
  await domain.deleteAllCircuitBreakerStates();
  assert.equal(await count("domain_circuit_breakers"), 0);
});

// ---------------------------------------------------------------------------------------------
// Exclusive leases
// ---------------------------------------------------------------------------------------------

const owner = (n: number) => `vlo_${String(n).padStart(43, "a")}`;

test("exclusive leases: mutual exclusion across racing owners, renew, transition, release, expiry", async () => {
  await addKey("lk");
  for (const id of ["l1", "l2", "l3"]) await addConn(id, "glm");

  const first = await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: owner(1),
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l1",
  });
  assert.equal(first.kind, "ACQUIRED");
  assert.equal("lease" in first && first.lease.generation, 1);
  const reused = await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: owner(1),
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l1",
  });
  assert.equal(reused.kind, "REUSED");
  const busy = await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: owner(2),
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l1",
  });
  assert.equal(busy.kind, "CONNECTION_BUSY");
  const ownerActive = await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: owner(1),
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l2",
  });
  assert.equal(ownerActive.kind, "OWNER_ALREADY_ACTIVE");

  // Two owners racing for one free connection: exactly one wins.
  const race = await Promise.all(
    [3, 4, 5, 6].map((n) =>
      leases.acquireExclusiveConnectionLease({
        leaseOwnerId: owner(n),
        apiKeyId: "lk",
        provider: "glm",
        connectionId: "l2",
      })
    )
  );
  assert.equal(race.filter((r) => r.kind === "ACQUIRED").length, 1);
  assert.equal(race.filter((r) => r.kind === "CONNECTION_BUSY").length, 3);
  assert.equal(await count("exclusive_connection_leases", "state = 'ACTIVE'"), 2);

  const renewed = await leases.renewExclusiveConnectionLease({
    leaseOwnerId: owner(1),
    generation: 1,
    apiKeyId: "lk",
    ttlMs: 600_000,
  });
  assert.equal(renewed.kind, "RENEWED");
  assert.equal(
    (
      await leases.renewExclusiveConnectionLease({
        leaseOwnerId: owner(1),
        generation: 9,
        apiKeyId: "lk",
      })
    ).kind,
    "STALE"
  );

  const status = await leases.getExclusiveConnectionLeaseStatus({
    leaseOwnerId: owner(1),
    generation: 1,
    apiKeyId: "lk",
  });
  assert.equal(status?.provider, "glm");
  assert.equal(status?.lease.connectionId, "l1");
  assert.equal(
    (await leases.assertExclusiveConnectionLeaseFence({
      leaseOwnerId: owner(1),
      generation: 1,
      apiKeyId: "lk",
      connectionId: "l1",
    })).kind,
    "VALID"
  );
  assert.equal(
    (await leases.assertExclusiveConnectionLeaseFence({
      leaseOwnerId: owner(1),
      generation: 1,
      apiKeyId: "lk",
      connectionId: "l3",
    })).kind,
    "CONNECTION_MISMATCH"
  );
  assert.equal(await leases.isExclusiveConnectionActivelyLeased("l1"), true);
  assert.equal(await leases.isExclusiveConnectionActivelyLeased("l3"), false);
  assert.equal((await leases.getExclusiveLeaseOccupancy(["l1", "l2", "l3"])).size, 2);

  // Transition to a free connection invalidates the old lease and keeps the generation.
  const moved = await leases.transitionExclusiveConnectionLease({
    leaseOwnerId: owner(1),
    generation: 1,
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l3",
    reason: "HEALTH_OR_COOLDOWN",
  });
  assert.equal(moved.kind, "TRANSITIONED");
  assert.equal(
    await count("exclusive_connection_leases", "state = 'INVALIDATED' AND connection_id = 'l1'"),
    1
  );
  // Transition onto an occupied connection rolls back and reports the conflict.
  const blocked = await leases.transitionExclusiveConnectionLease({
    leaseOwnerId: owner(1),
    generation: 1,
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l2",
    reason: "QUOTA_UNAVAILABLE",
  });
  assert.equal(blocked.kind, "CONNECTION_BUSY");
  assert.equal(
    await count("exclusive_connection_leases", "state = 'ACTIVE' AND connection_id = 'l3'"),
    1
  );

  const released = await leases.releaseExclusiveConnectionLease({
    leaseOwnerId: owner(1),
    generation: 1,
    apiKeyId: "lk",
  });
  assert.equal(released.kind, "RELEASED");
  assert.equal(
    (
      await leases.releaseExclusiveConnectionLease({
        leaseOwnerId: owner(1),
        generation: 1,
        apiKeyId: "lk",
      })
    ).kind,
    "RELEASED",
    "release is idempotent"
  );
  assert.equal(await leases.getActiveExclusiveConnectionLease(owner(1)), null);

  const invalidated = await leases.invalidateExclusiveConnectionLease({
    leaseOwnerId: owner(2),
    generation: 1,
    apiKeyId: "lk",
    reason: "MANAGED_KEY_REVOKED",
  });
  assert.equal(invalidated.kind, "STALE");

  // TTL expiry frees the connection for the next owner.
  const old = "2020-01-01T00:00:00.000Z";
  await backend.execute("TRUNCATE exclusive_connection_leases");
  await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: owner(7),
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l1",
    now: old,
    ttlMs: 1000,
  });
  const next = await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: owner(8),
    apiKeyId: "lk",
    provider: "glm",
    connectionId: "l1",
  });
  assert.equal(next.kind, "ACQUIRED");
  assert.equal(await count("exclusive_connection_leases", "end_reason = 'TTL_EXPIRED'"), 1);
  assert.equal(await leases.reconcileExpiredExclusiveConnectionLeases(), 0);

  await backend.execute("DELETE FROM provider_connections WHERE id = 'l1'");
  assert.equal(await count("exclusive_connection_leases", "connection_id = 'l1'"), 0);
});

// ---------------------------------------------------------------------------------------------
// Codex wakeups
// ---------------------------------------------------------------------------------------------

test("codex wakeups: one live run per task, atomic result append, recovery, limits", async () => {
  const input = {
    name: "morning",
    connectionIds: ["x1", "x2"],
    schedule: { kind: "interval" as const, minutes: 30 },
    enabled: true,
  };
  const past = new Date(Date.now() - 60_000).toISOString();
  const task = await codex.createCodexWakeupTask(input as never, past);
  assert.equal(task.enabled, true);
  assert.deepEqual(task.connectionIds, ["x1", "x2"]);
  assert.equal(task.nextRunAt, past);
  assert.equal(await codex.getCodexWakeupTask("not-a-uuid"), null);
  assert.equal((await codex.listCodexWakeupTasks()).length, 1);

  const nextSlot = new Date(Date.now() + 1_800_000).toISOString();
  const claims = await Promise.all(
    Array.from({ length: 5 }, () =>
      codex.claimCodexWakeupRun(task.id, "scheduled", Date.now(), () => nextSlot)
    )
  );
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean)!;
  assert.equal(claim.task.nextRunAt, nextSlot);
  assert.equal((await codex.getCodexWakeupTask(task.id))?.nextRunAt, nextSlot);
  assert.equal(await codex.claimCodexWakeupRun(task.id, "manual", Date.now(), () => null), null);
  await assert.rejects(
    codex.updateCodexWakeupTask(task.id, input as never, nextSlot),
    (err: unknown) => (err as { code?: string }).code === "running"
  );
  await assert.rejects(
    codex.claimCodexWakeupRun("not-a-uuid", "manual", Date.now(), () => null),
    (err: unknown) => (err as { code?: string }).code === "not_found"
  );

  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      codex.recordCodexWakeupResult(claim.run.id, {
        connectionId: `x${i}`,
        status: "succeeded",
        reason: "ok",
        durationMs: i,
      })
    )
  );
  const finished = await codex.finishCodexWakeupRun(claim.run.id);
  assert.equal(finished?.results.length, 6);
  assert.equal(finished?.status, "succeeded");
  assert.equal(await codex.finishCodexWakeupRun(claim.run.id), null);
  await codex.recordCodexWakeupResult(claim.run.id, {
    connectionId: "late",
    status: "failed",
    reason: "late",
    durationMs: 1,
  });
  assert.equal((await codex.listCodexWakeupRuns())[0].results.length, 6);

  // A crashed run (expired lease) is interrupted and does not block the next claim.
  const crashed = await codex.claimCodexWakeupRun(task.id, "manual", Date.now(), () => null);
  assert.ok(crashed);
  const later = Date.now() + 600_000;
  const fresh = await codex.claimCodexWakeupRun(task.id, "manual", later, () => null);
  assert.ok(fresh);
  assert.equal(await count("codex_wakeup_runs", "status = 'interrupted'"), 1);
  assert.equal(await codex.recoverCodexWakeupRuns(later + 1_000_000), 1);

  const updated = await codex.updateCodexWakeupTask(
    task.id,
    { ...input, enabled: false } as never,
    nextSlot
  );
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextRunAt, null);
  await codex.deleteCodexWakeupTask(task.id);
  assert.equal(await count("codex_wakeup_runs"), 0);
  await assert.rejects(
    codex.deleteCodexWakeupTask(task.id),
    (err: unknown) => (err as { code?: string }).code === "not_found"
  );
});

// ---------------------------------------------------------------------------------------------
// Command Code auth sessions
// ---------------------------------------------------------------------------------------------

test("command code auth: single redemption, expiry", async () => {
  const stateHash = commandCode.hashCommandCodeAuthState("state-1");
  const created = await commandCode.createPendingCommandCodeAuthSession({
    stateHash,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  assert.equal(created.status, "pending");
  assert.equal(created.metadata, null);
  const received = await commandCode.markCommandCodeAuthSessionReceived({
    stateHash,
    apiKey: "secret-key",
    metadata: { userName: "ada" },
  });
  assert.equal(received?.status, "received");
  assert.equal(received?.metadata?.userName, "ada");
  assert.ok(received?.metadata?.receivedAt);

  const redeemed = await Promise.all(
    Array.from({ length: 4 }, () => commandCode.consumeCommandCodeAuthSecret(stateHash))
  );
  assert.equal(redeemed.filter(Boolean).length, 1);
  assert.equal(redeemed.find(Boolean)?.apiKey, "secret-key");
  assert.equal(redeemed.find(Boolean)?.status, "applied");
  assert.equal((await commandCode.getCommandCodeAuthSessionSafeStatus(stateHash))?.status, "applied");
  const raw = await backend.queryOne<{ encrypted_api_key: string | null }>(
    "SELECT encrypted_api_key FROM command_code_auth_sessions"
  );
  assert.equal(raw?.encrypted_api_key, null);

  const expiredHash = commandCode.hashCommandCodeAuthState("state-2");
  await commandCode.createPendingCommandCodeAuthSession({
    stateHash: expiredHash,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal((await commandCode.getCommandCodeAuthSessionSafeStatus(expiredHash))?.status, "expired");
  assert.equal(
    await commandCode.markCommandCodeAuthSessionReceived({ stateHash: expiredHash, apiKey: "x" })
      .then((s) => s?.status),
    "expired"
  );
  assert.equal(await commandCode.getCommandCodeAuthSessionSafeStatus("missing"), null);
});

// ---------------------------------------------------------------------------------------------
// Context handoffs + session pins
// ---------------------------------------------------------------------------------------------

test("context handoffs and session model pins", async () => {
  const payload = {
    sessionId: "s1",
    comboName: "combo",
    fromAccount: "acct",
    summary: "bad\u0000 summary",
    keyDecisions: ["a", "b\u0000"],
    taskProgress: "half",
    activeEntities: ["e1"],
    messageCount: 12,
    model: "m",
    warningThresholdPct: 0.9,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  await handoffs.upsertHandoff(payload);
  await handoffs.upsertHandoff({ ...payload, summary: "second", lastModel: "m2" });
  const got = await handoffs.getHandoff("s1", "combo");
  assert.equal(got?.summary, "second");
  assert.equal(got?.lastModel, "m2");
  assert.deepEqual(got?.keyDecisions, ["a", "b"]);
  assert.equal(got?.messageCount, 12);
  assert.ok(got?.id);
  assert.equal(await handoffs.hasActiveHandoff("s1", "combo"), true);
  assert.equal(await handoffs.hasActiveHandoff("s1", "other"), false);
  await handoffs.upsertHandoff({
    ...payload,
    sessionId: "s2",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(await handoffs.getHandoff("s2", "combo"), null);
  assert.equal(await handoffs.cleanupExpiredHandoffs(), 1);
  await handoffs.deleteHandoff("s1", "combo");
  assert.equal(await handoffs.getHandoff("s1", "combo"), null);

  await Promise.all([
    handoffs.recordSessionModelUsage("s1", "combo", "model-a", "p", "c1"),
    handoffs.recordSessionModelUsage("s1", "combo", "model-a", "p", "c1"),
  ]);
  await handoffs.recordSessionModelUsage("s1", "combo", "model-b", "p");
  await handoffs.recordSessionModelUsage("s2", "combo", "model-c", "p");
  assert.equal(await handoffs.getLastSessionModel("s1", "combo"), "model-b");
  assert.equal(await count("session_model_pins"), 2);
  assert.equal(await handoffs.getLastSessionModel("s9", "combo"), null);
  assert.equal(await handoffs.deleteSessionModelHistory("s1", "combo"), 1);
  assert.equal(await handoffs.clearSessionModelHistoryForCombo("combo"), 1);
  await handoffs.recordSessionModelUsage("s3", "combo", "model-d", "p");
  await backend.execute("UPDATE session_model_pins SET used_at = now() - interval '2 days'");
  assert.equal(await handoffs.cleanupStaleSessionModelPins(86_400_000), 1);
});

// ---------------------------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------------------------

test("relay tokens: CRUD, rate limit windows, usage logs, auth failures, cascade", async () => {
  const created = await relay.createRelayToken({
    name: "t",
    allowedModels: ["gpt-*"],
    maxRequestsPerMinute: 3,
    maxCostPerDay: 1.5,
    metadata: { owner: "me" },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.match(created.id, /^rl_[0-9a-f]{32}$/);
  assert.equal(created.enabled, true);
  assert.equal(JSON.parse(created.allowedModels)[0], "gpt-*");
  assert.deepEqual(JSON.parse(created.metadata), { owner: "me" });
  assert.equal(created.maxRequestsPerMinute, 3);
  assert.equal(created.maxCostPerDay, 1.5);
  assert.ok(created.createdAt > 1_700_000_000 && created.createdAt < 1e11);
  assert.ok(created.expiresAt && created.expiresAt > created.createdAt);
  assert.equal(created.lastUsedAt, null);

  const byHash = await relay.getRelayTokenByHash(sha(created.rawToken));
  assert.equal(byHash?.id, created.id);
  assert.equal((await relay.getRelayTokens()).length, 1);

  assert.deepEqual(await relay.checkRateLimit(created.id), {
    allowed: true,
    remaining: 3,
    resetIn: (await relay.checkRateLimit(created.id)).resetIn,
  });
  await Promise.all(
    Array.from({ length: 3 }, () =>
      relay.recordRelayUsage(created.id, {
        model: "gpt-4",
        promptTokens: 10,
        completionTokens: 5,
        cost: 0.25,
        clientIp: "1.1.1.1",
      })
    )
  );
  const limited = await relay.checkRateLimit(created.id);
  assert.equal(limited.allowed, false);
  assert.equal(limited.remaining, 0);
  assert.equal((await relay.checkRateLimit("missing")).allowed, false);
  assert.ok((await relay.getRelayToken(created.id))?.lastUsedAt);

  const usage = await relay.getRelayUsage(created.id, Math.floor(Date.now() / 1000) - 60);
  assert.deepEqual(usage, { requestCount: 3, totalCost: 0.75 });
  const logs = await relay.getRelayLogs(created.id, 10);
  assert.equal(logs.length, 3);
  assert.equal(logs[0].prompt_tokens, 10);
  assert.ok(logs[0].created_at > 1_700_000_000 && logs[0].created_at < 1e11);

  // Auth failures and vanished tokens log with a NULL token and write no window.
  await relay.recordRelayUsage("unknown", { status: "auth_failed", statusCode: 401 });
  await relay.recordRelayUsage("rl_gone", { status: "error", statusCode: 500 });
  assert.equal(await count("relay_logs", "token_id IS NULL"), 2);
  assert.equal(await count("relay_rate_limits"), 1);
  assert.equal((await relay.getRelayLogs(undefined, 100)).length, 5);

  const patched = await relay.updateRelayToken(created.id, {
    name: "renamed",
    allowedModels: ["*"],
    maxRequestsPerDay: 5,
  });
  assert.equal(patched?.name, "renamed");
  assert.equal(patched?.maxRequestsPerDay, 5);
  assert.equal((await relay.toggleRelayToken(created.id, false))?.enabled, false);
  assert.equal(await relay.getRelayTokenByHash(sha(created.rawToken)), null);

  await relay.deleteRelayToken(created.id);
  assert.equal(await count("relay_rate_limits"), 0);
  assert.equal(await count("relay_logs", "token_id IS NOT NULL"), 0);
});

// ---------------------------------------------------------------------------------------------
// Server tool fence
// ---------------------------------------------------------------------------------------------

test("server tool fence: one claimer per identity, replay, conflict, runWithServerToolFence", async () => {
  const identity = {
    apiKeyId: "fk",
    requestIdentity: "req-1",
    toolCallId: "call-1",
    toolName: "search",
    inputDigest: "d1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const claims = await Promise.all(
    Array.from({ length: 6 }, () => fenceDb.claimServerToolExecution(identity))
  );
  assert.equal(claims.filter((c) => c.kind === "claimed").length, 1);
  assert.equal(claims.filter((c) => c.kind === "in_progress").length, 5);
  const claimed = claims.find((c) => c.kind === "claimed")!;

  const conflict = await fenceDb.claimServerToolExecution({ ...identity, inputDigest: "other" });
  assert.equal(conflict.kind, "identity_conflict");

  assert.equal(
    await fenceDb.finalizeServerToolExecution({
      executionId: claimed.executionId,
      status: "success",
      output: { found: ["a\u0000b"] },
      errorMessage: null,
      durationMs: 12.6,
    }),
    true
  );
  assert.equal(
    await fenceDb.finalizeServerToolExecution({
      executionId: claimed.executionId,
      status: "error",
      output: null,
      errorMessage: "late",
      durationMs: 1,
    }),
    false
  );
  assert.equal(await fenceDb.finalizeServerToolExecution({ executionId: "nope", status: "error", output: null, errorMessage: null, durationMs: 1 }), false);
  const replay = await fenceDb.claimServerToolExecution(identity);
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.kind === "replay" && replay.output, { found: ["a\u0000b"] });
  const nul = await fenceDb.claimServerToolExecution({ ...identity, toolCallId: "call-nul" });
  await fenceDb.finalizeServerToolExecution({
    executionId: nul.executionId,
    status: "error",
    output: null,
    errorMessage: "bad\u0000 message",
    durationMs: 1,
  });
  const nulReplay = await fenceDb.claimServerToolExecution({ ...identity, toolCallId: "call-nul" });
  assert.equal(nulReplay.kind === "replay" && nulReplay.errorMessage, "bad message");
  assert.equal((await fenceDb.readRow(backend, claimed.executionId))?.status, "success");
  assert.equal(await fenceDb.readRow(backend, "nope"), null);

  const expired = await fenceDb.claimServerToolExecution({
    ...identity,
    toolCallId: "call-2",
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  assert.equal(expired.kind, "claimed");
  assert.equal(
    (
      await fenceDb.claimServerToolExecution({
        ...identity,
        toolCallId: "call-2",
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      })
    ).kind,
    "unknown"
  );

  let runs = 0;
  const options = {
    apiKeyId: "fk",
    requestIdentity: "req-2",
    toolCallId: "call-9",
    toolName: "calc",
    arguments: { x: 1 },
    leaseDurationMs: 60_000,
    execute: async () => {
      runs++;
      return { answer: 42 };
    },
  };
  const ran = await fence.runWithServerToolFence(options);
  assert.deepEqual(ran, { kind: "executed", value: { answer: 42 } });
  const replayed = await fence.runWithServerToolFence(options);
  assert.equal(replayed.kind, "replayed");
  assert.equal(runs, 1);
});

// ---------------------------------------------------------------------------------------------
// Usage limits read paths
// ---------------------------------------------------------------------------------------------

test("api key usage limits: spend window from usage_history", async () => {
  await addKey("ul");
  await backend.execute(
    `INSERT INTO usage_history ("timestamp", api_key_id, provider, model, provider_cost_usd, success)
     VALUES (now(), 'ul', 'xai', 'grok', 2.5, true)`
  );
  const status = await apiKeyLimits.getApiKeyUsageLimitStatus(
    { id: "ul", usageLimitEnabled: true, dailyUsageLimitUsd: 2, weeklyUsageLimitUsd: 100 },
    {
      getProviderConnectionById: async () => null,
      getProviderConnections: async () => [],
      getProviderLimitsCache: async () => null,
      getAllProviderLimitsCache: async () => ({}),
    }
  );
  assert.equal(status.dailySpentUsd, 2.5);
  assert.equal(status.dailyExceeded, true);
  assert.equal(status.weeklyExceeded, false);
  assert.equal(status.dailyHasUnpricedUsage, false);
});

test("review fixes: lease owner race, budget window writers, pool edit lock, wakeup updated_at", async () => {
  // Lease: release/transition racing an acquire for the same owner never throws.
  await addKey("rk");
  for (const id of ["r1", "r2", "r3"]) await addConn(id, "glm");
  for (let i = 0; i < 12; i++) {
    await backend.execute("DELETE FROM exclusive_connection_leases");
    const o = owner(100 + i);
    const base = { leaseOwnerId: o, apiKeyId: "rk", provider: "glm" };
    const got = await leases.acquireExclusiveConnectionLease({ ...base, connectionId: "r1" });
    assert.equal(got.kind, "ACQUIRED");
    const results = await Promise.all([
      leases.releaseExclusiveConnectionLease({ ...base, generation: 1 }),
      leases.transitionExclusiveConnectionLease({
        ...base,
        generation: 1,
        connectionId: "r2",
        reason: "HEALTH_OR_COOLDOWN",
      }),
      leases.acquireExclusiveConnectionLease({ ...base, connectionId: "r1" }),
    ]);
    for (const r of results) assert.ok(r.kind);
    assert.ok((await count("exclusive_connection_leases", "state = 'ACTIVE'")) <= 1);
  }

  // Budgets: a window write from a stale cache does not revert an operator's limit.
  await domain.saveBudget("kb", { dailyLimitUsd: 10 });
  const stale = (await domain.loadBudget("kb"))!;
  await domain.saveBudget("kb", { ...stale, dailyLimitUsd: 100 });
  const rolledAt = Date.parse("2026-11-17T00:00:00.000Z");
  assert.equal(
    await domain.saveBudgetWindowState("kb", { budgetResetAt: rolledAt, lastBudgetResetAt: rolledAt }),
    true
  );
  const after = (await domain.loadBudget("kb"))!;
  assert.equal(after.dailyLimitUsd, 100);
  assert.equal(after.budgetResetAt, rolledAt);
  await domain.saveBudgetWindowState("kb", { warningEmittedAt: rolledAt });
  // A config save that omits window fields keeps them; null clears.
  await domain.saveBudget("kb", { dailyLimitUsd: 50 });
  const kept = (await domain.loadBudget("kb"))!;
  assert.equal(kept.dailyLimitUsd, 50);
  assert.equal(kept.budgetResetAt, rolledAt);
  assert.equal(kept.warningEmittedAt, rolledAt);
  await domain.saveBudget("kb", { dailyLimitUsd: 50, warningEmittedAt: null });
  assert.equal((await domain.loadBudget("kb"))?.warningEmittedAt, null);
  assert.equal(await domain.saveBudgetWindowState("nobudget", { budgetResetAt: rolledAt }), false);

  // Pools: concurrent membership replacements serialize instead of colliding.
  for (const id of ["pc1", "pc2", "pc3"]) await addConn(id, "codex");
  const pool = await pools.createPool({ connectionId: "pc1", name: "race", connectionIds: ["pc1", "pc2"] });
  const edits = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      pools.updatePool(pool.id, { connectionIds: i % 2 ? ["pc3", "pc1"] : ["pc1", "pc2", "pc3"] })
    )
  );
  assert.equal(edits.filter((e) => e.status === "rejected").length, 0);

  // Codex wakeups: a scheduled claim bumps the task's updated_at.
  const wake = await codex.createCodexWakeupTask(
    {
      name: "upd",
      connectionIds: ["x1"],
      schedule: { kind: "interval" as const, minutes: 30 },
      enabled: true,
    } as never,
    new Date(Date.now() - 60_000).toISOString()
  );
  await backend.execute("UPDATE codex_wakeup_tasks SET updated_at = now() - interval '1 day'");
  const claimed = await codex.claimCodexWakeupRun(wake.id, "scheduled", Date.now(), () =>
    new Date(Date.now() + 1_800_000).toISOString()
  );
  assert.ok(claimed);
  const touched = await backend.queryOne<{ fresh: boolean }>(
    "SELECT updated_at > now() - interval '1 hour' AS fresh FROM codex_wakeup_tasks WHERE id = $1",
    [wake.id]
  );
  assert.equal(touched?.fresh, true);
});

test("team usage limits: committed cost query runs against the schema", async () => {
  await addKey("tk");
  assert.equal(await teamLimits.getTeamUsageLimitStatusForApiKey("tk"), null);
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  await backend.execute(
    `INSERT INTO teams (id, name, max_budget_usd, budget_duration, budget_reset_at)
     VALUES ('t1', 'Team', 100, '1d', $1)`,
    [resetAt]
  );
  await backend.execute(
    `INSERT INTO api_key_billing_team_history (api_key_id, team_id, valid_from)
     VALUES ('tk', 't1', now() - interval '2 days')`
  );
  await backend.execute(
    `INSERT INTO usage_history ("timestamp", api_key_id, billing_team_id, provider, model, tokens_input, tokens_output, success)
     VALUES (now() - interval '1 hour', 'tk', 't1', 'openai', 'gpt-4o-mini', 100, 50, true)`
  );
  await backend.execute(
    `INSERT INTO daily_team_usage_summary (team_id, api_key_id, provider, model, date, successful_requests, successful_input_tokens, successful_token_shapes)
     VALUES ('t1', 'tk', 'openai', 'gpt-4o-mini', (now() - interval '3 days')::date, 2, 20, '{"[10,5,0,0,0]": 2}')`
  );
  // Raw writes bypass teams.ts, so drop the per-key policy cache the first read filled.
  invalidateDbCache();
  const status = await teamLimits.getTeamUsageLimitStatusForApiKey("tk");
  assert.equal(status?.teamId, "t1");
  assert.equal(status?.maxBudgetUsd, 100);
  assert.equal(typeof status?.estimatedListCostUsd, "number");
});
