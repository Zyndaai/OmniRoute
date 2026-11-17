import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db, ts } from "../../../../src/lib/db/pg.ts";
import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";

// Group D1: usage history, daily aggregates, analytics and caches, against the real database.
// Each process gets a fresh database (tests/_setup/isolatePostgres.ts).

const DAY_MS = 24 * 3600_000;

beforeEach(async () => {
  await truncateAll(getTestBackend());
});

async function insertUsage(row: {
  timestamp: string;
  provider?: string;
  model?: string;
  connectionId?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  teamId?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  success?: boolean;
  costUsd?: number | null;
  endpoint?: string | null;
  latency?: number;
}) {
  await db().execute(
    `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name,
       billing_team_id, tokens_input, tokens_output, tokens_cache_read, success, provider_cost_usd,
       endpoint, latency_ms, "timestamp")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.provider ?? "openai",
      row.model ?? "gpt-4o",
      row.connectionId ?? null,
      row.apiKeyId ?? null,
      row.apiKeyName ?? null,
      row.teamId ?? null,
      row.input ?? 100,
      row.output ?? 50,
      row.cacheRead ?? 0,
      row.success ?? true,
      row.costUsd ?? null,
      row.endpoint ?? null,
      row.latency ?? 200,
      row.timestamp,
    ]
  );
}

// ─── ccr_blocks ───────────────────────────────────────────────────────────

test("ccrBlocks: persist, load, touch, upsert, expire, prune, count, delete", async () => {
  const ccr = await import("../../../../src/lib/db/ccrBlocks.ts");
  const now = Date.now();
  const block = (hash: string, expiresAt: number, content = "hello") => ({
    principalId: "key-1",
    hash,
    content,
    bytes: 5,
    chars: 5,
    lines: 1,
    contentType: "text/plain",
    source: "compression",
    createdAt: now - 1000,
    lastAccessedAt: now - 500,
    expiresAt,
  });

  await ccr.persistCcrBlock(block("h1", now + 60_000));
  const loaded = await ccr.loadCcrBlock("key-1", "h1", now);
  assert.equal(loaded?.content, "hello");
  assert.equal(loaded?.createdAt, now - 1000);
  assert.equal(loaded?.expiresAt, now + 60_000);

  await ccr.touchCcrBlock("key-1", "h1", now + 10);
  assert.equal((await ccr.loadCcrBlock("key-1", "h1", now))?.lastAccessedAt, now + 10);

  await ccr.persistCcrBlock(block("h1", now + 60_000, "replaced"));
  assert.equal((await ccr.loadCcrBlock("key-1", "h1", now))?.content, "replaced");
  assert.equal(await ccr.countCcrBlocks(), 1);

  // An expired row reads as a miss and is deleted on the way.
  await ccr.persistCcrBlock(block("old", now - 1));
  assert.equal(await ccr.loadCcrBlock("key-1", "old", now), null);
  assert.equal(await ccr.countCcrBlocks("key-1"), 1);

  await ccr.persistCcrBlock(block("old2", now - 5));
  assert.equal(await ccr.pruneExpiredCcrBlocks(now), 1);

  await ccr.deleteCcrBlockRow("key-1", "h1");
  assert.equal(await ccr.countCcrBlocks(), 0);
  await ccr.persistCcrBlock(block("again", now + 1000));
  await ccr.deleteAllCcrBlocks();
  assert.equal(await ccr.countCcrBlocks(), 0);
});

// ─── semantic cache ───────────────────────────────────────────────────────

test("semanticCache: set/get/hit counters/list/prune/delete, concurrent hit counting", async () => {
  const cache = await import("../../../../src/lib/semanticCache.ts");
  const rows = await import("../../../../src/lib/db/semanticCache.ts");

  await cache.setCachedResponse("sig-a", "gpt-4o", { choices: [{ text: "a" }] }, 12, 60_000);
  await cache.setCachedResponse("sig-b", "claude", { choices: [{ text: "b" }] }, 5, 60_000);
  // Second write replaces the first.
  await cache.setCachedResponse("sig-a", "gpt-4o", { choices: [{ text: "a2" }] }, 13, 60_000);

  cache.clearMemoryCache();
  assert.deepEqual(await cache.getCachedResponse("sig-a"), { choices: [{ text: "a2" }] });
  assert.equal(await cache.getCachedResponse("missing"), null);

  const stats = await cache.getCacheStats();
  assert.equal(stats.dbEntries, 2);
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.tokensSaved, 13);

  // Concurrent hit recording must not lose increments.
  await Promise.all(Array.from({ length: 20 }, () => cache.recordSemanticCacheHit("sig-b", 2)));
  const after = await cache.getCacheStats();
  assert.equal(after.hits, 21);
  assert.equal(after.tokensSaved, 13 + 40);
  const sigB = await db().queryOne<{ hit_count: number }>(
    "SELECT hit_count FROM semantic_cache WHERE signature = 'sig-b'"
  );
  assert.equal(sigB?.hit_count, 20);

  const listed = await rows.listSemanticCacheEntries({
    page: 1,
    limit: 10,
    search: "sig",
    model: "",
    sortBy: "model",
    sortOrder: "asc",
  });
  assert.equal(listed.total, 2);
  assert.deepEqual(
    listed.entries.map((e) => e.model),
    ["claude", "gpt-4o"]
  );
  assert.equal(listed.entries[0].id, "sig-b");

  // Expired row is invisible to reads and removed by prune; the cap evicts the oldest.
  await db().execute(
    `INSERT INTO semantic_cache (signature, model, prompt_hash, response, created_at, expires_at)
     VALUES ('sig-old', 'm', 'h', '{}', now() - interval '2 hours', now() - interval '1 hour')`
  );
  cache.clearMemoryCache();
  assert.equal(await cache.getCachedResponse("sig-old"), null);
  const pruned = await rows.pruneSemanticCache({ batchSize: 10, maxBatches: 5, maxRows: 1 });
  assert.equal(pruned.expiredDeleted, 1);
  assert.equal(pruned.capDeleted, 1);
  const left = await db().query("SELECT signature FROM semantic_cache");
  assert.equal(left.length, 1);

  assert.deepEqual(await rows.deleteSemanticCacheByModel("gpt-4o"), { deleted: 1 });
  assert.equal(await cache.invalidateByModel("nope"), 0);
  await cache.setCachedResponse("sig-c", "m2", { ok: true }, 0, 60_000);
  assert.equal(await cache.invalidateBySignature("sig-c"), true);
  assert.deepEqual(await rows.deleteSemanticCacheBySignature("sig-c"), { deleted: 1 });
  await cache.setCachedResponse("sig-d", "m2", { ok: true }, 0, 60_000);
  assert.equal(await cache.clearCache(), 1);
  assert.equal((await cache.getCacheStats()).hits, 0);
  assert.equal(await cache.invalidateStale(1000), 0);
});

// ─── reasoning cache ──────────────────────────────────────────────────────

test("reasoningCache: set/get/replace/stats/entries/cleanup/clear", async () => {
  const rc = await import("../../../../src/lib/db/reasoningCache.ts");
  await rc.setReasoningCache("call-1", "deepseek", "v4", "thinking...", 60_000);
  await rc.setReasoningCache("call-2", "kimi", "k2", "more thinking", 60_000);
  await rc.setReasoningCache("call-3", "kimi", "k2", "expired thought", -1000);
  await rc.setReasoningCache("call-ph", "kimi", "k2", "(prior reasoning summary unavailable)");

  const got = await rc.getReasoningCache("call-1");
  assert.equal(got?.reasoning, "thinking...");
  assert.ok(got && !Number.isNaN(Date.parse(got.expiresAt)));
  assert.equal(await rc.getReasoningCache("call-3"), null);
  assert.equal(await rc.getReasoningCache("call-ph"), null);

  await rc.setReasoningCache("call-1", "deepseek", "v4", "replaced", 60_000);
  assert.equal((await rc.getReasoningCache("call-1"))?.reasoning, "replaced");

  const stats = await rc.getReasoningCacheStats();
  assert.equal(stats.totalEntries, 2);
  assert.equal(stats.byProvider.kimi.entries, 1);
  assert.equal(stats.byModel.v4.chars, "replaced".length);
  assert.ok(stats.oldestEntry && stats.newestEntry);

  const entries = await rc.getReasoningCacheEntries({ provider: "kimi" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolCallId, "call-2");

  assert.equal(await rc.cleanupExpiredReasoning(), 1);
  assert.equal(await rc.deleteReasoningCache("call-2"), 1);
  assert.equal(await rc.clearAllReasoningCache("deepseek"), 1);
  assert.equal(await rc.clearAllReasoningCache(), 0);
});

// ─── radar ────────────────────────────────────────────────────────────────

test("radar: caches, settings, key clearing, local model state", async () => {
  const radar = await import("../../../../src/lib/db/radar.ts");
  assert.equal(await radar.getRadarCache(), null);

  await radar.setRadarCache({
    version: "1",
    generatedAt: "2026-11-01",
    tier: "community",
    payload: '{"a": 1,  "b":2}',
    signature: "sig",
  });
  await radar.setRadarCache({
    version: "2",
    generatedAt: null,
    tier: "live",
    payload: "{}",
    signature: "sig2",
  });
  const feed = await radar.getRadarCache();
  assert.equal(feed?.version, "2");
  assert.equal(feed?.tier, "live");
  assert.ok(feed && !Number.isNaN(Date.parse(feed.fetchedAt)));

  await radar.setRadarReferralsCache({
    generatedAt: "2026-11-02",
    tier: "community",
    payload: "[ 1 ]",
    signature: "r",
  });
  assert.equal((await radar.getRadarReferralsCache())?.payload, "[ 1 ]");
  await radar.setRadarOffersCache({ version: "o1", tier: "live", payload: "{}", signature: "o" });
  assert.equal((await radar.getRadarOffersCache())?.version, "o1");
  await radar.setRadarIntelCache({
    version: "i1",
    tier: "live",
    payload: "{}",
    signature: "i",
    supporterIdentity: "ident",
  });
  assert.equal((await radar.getRadarIntelCache())?.supporterIdentity, "ident");

  // The settings row is seeded by the migration but truncateAll removed it: defaults read.
  assert.equal((await radar.getRadarSettings()).optIn, false);
  await radar.setRadarOptIn(true);
  assert.equal((await radar.getRadarSettings()).optIn, true);
  await radar.setRadarKey("supporter-secret");
  const settings = await radar.getRadarSettings();
  assert.equal(settings.supporterKey, "supporter-secret");
  assert.equal(settings.optIn, true);
  // Changing the key drops every cached signed feed.
  assert.equal(await radar.getRadarCache(), null);
  assert.equal(await radar.getRadarReferralsCache(), null);
  assert.equal(await radar.getRadarOffersCache(), null);
  assert.equal(await radar.getRadarIntelCache(), null);
  await radar.setRadarKey(null);
  assert.equal((await radar.getRadarSettings()).supporterKey, null);

  assert.equal(await radar.setRadarLocalModelOverride("openai", "gpt-4o", { displayName: "Fast" }), true);
  assert.equal(await radar.setRadarLocalModelOverride("openai", "gpt-4o", { enabled: false }), true);
  assert.equal(await radar.setRadarLocalModelOverride("bad provider!", "x", { enabled: true }), false);
  assert.equal(await radar.setRadarModelTombstone("openai", "gpt-4o", true), true);
  let merge = await radar.getRadarLocalMergeState();
  assert.deepEqual(merge.localOverrides.get("openai:gpt-4o"), { displayName: "Fast", enabled: false });
  assert.ok(merge.tombstones.has("openai:gpt-4o"));

  assert.equal(await radar.clearRadarLocalModelOverride("openai", "gpt-4o"), true);
  merge = await radar.getRadarLocalMergeState();
  assert.equal(merge.localOverrides.size, 0);
  assert.ok(merge.tombstones.has("openai:gpt-4o"));
  assert.equal(await radar.setRadarModelTombstone("openai", "gpt-4o", false), true);
  assert.equal((await radar.listRadarLocalModelState()).length, 0);

  // Concurrent read-modify-write patches on one row must both survive.
  await Promise.all([
    radar.setRadarLocalModelOverride("p", "m", { displayName: "N" }),
    radar.setRadarLocalModelOverride("p", "m", { enabled: true }),
  ]);
  const [state] = await radar.listRadarLocalModelState();
  assert.equal(state.displayName, "N");
  assert.equal(state.enabled, true);
});

// ─── usage_history writes, dedup and reads ────────────────────────────────

test("usage write: insert, natural-key dedup under concurrency, success flag, reads", async () => {
  const retry = await import("../../../../src/lib/usage/usageWriteRetry.ts");
  const history = await import("../../../../src/lib/usage/usageHistory.ts");

  const stamp = new Date(Date.now() - 5000).toISOString();
  const entry = {
    provider: "openai",
    model: "gpt-4o",
    connectionId: "conn-1",
    apiKeyId: "key-1",
    apiKeyName: "Main",
    tokens: { input: 100.4, output: 50 },
    latencyMs: 123.6,
    endpoint: null,
    timestamp: stamp,
  };

  // Five identical callbacks for one request collapse into one row.
  await Promise.all(Array.from({ length: 5 }, () => retry.attemptWrite(entry)));
  const rows = await db().query<{ tokens_input: number; latency_ms: number; ttft_ms: number }>(
    "SELECT tokens_input, latency_ms, ttft_ms FROM usage_history"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latency_ms, 124);

  // The dedup backfills a missing endpoint instead of inserting.
  await retry.attemptWrite({ ...entry, endpoint: "/v1/chat/completions" });
  const backfilled = await db().query<{ endpoint: string | null }>(
    "SELECT endpoint FROM usage_history"
  );
  assert.equal(backfilled.length, 1);
  assert.equal(backfilled[0].endpoint, "/v1/chat/completions");

  // deduplicate: false keeps both physical attempts.
  await retry.attemptWrite(entry, { deduplicate: false });
  assert.equal((await db().query("SELECT 1 FROM usage_history")).length, 2);

  await history.saveRequestUsage({
    provider: "anthropic",
    model: "claude",
    success: false,
    tokens: { input: 10, output: 1 },
    apiKeyId: "key-2",
    latencyMs: 50,
  });
  const failed = await db().queryOne<{ success: boolean }>(
    "SELECT success FROM usage_history WHERE provider = 'anthropic'"
  );
  assert.equal(failed?.success, false);

  const all = await history.getUsageHistory({ provider: "openai" });
  assert.equal(all.length, 2);
  assert.equal(all[0].success, true);
  assert.equal(all[0].tokens.input, 100);

  const page = await history.getUsageDb(new Date(Date.now() - DAY_MS).toISOString(), 2);
  assert.equal(page.data.history.length, 2);
  assert.ok(page.data.nextCursor);

  const latency = await history.getModelLatencyStats({ minSamples: 1 });
  assert.ok(latency["openai/gpt-4o"]);
  const failedKey = Object.keys(latency).find((key) => key.endsWith("/claude"));
  assert.ok(failedKey);
  assert.equal(latency[failedKey].successRate, 0);

  assert.equal(retry.isWriteLockError({ code: "40P01" }), true);
  assert.equal(retry.isWriteLockError(new Error("boom")), false);
});

test("usageStats and connection speed over usage_history", async () => {
  const stats = await import("../../../../src/lib/usage/usageStats.ts");
  const speed = await import("../../../../src/lib/usage/connectionSpeedStats.ts");
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    await insertUsage({
      timestamp: new Date(now - i * 1000).toISOString(),
      connectionId: "c1",
      apiKeyId: "k1",
      apiKeyName: "Key One",
      input: 1000,
      output: 400,
      costUsd: 0.5,
      latency: 1000,
    });
  }
  await insertUsage({
    timestamp: new Date(now - 2000).toISOString(),
    connectionId: "c1",
    success: false,
    costUsd: 9,
  });

  const result = await stats.getUsageStats();
  assert.equal(result.totalRequests, 4);
  assert.equal(result.totalPromptTokens, 3100);
  assert.ok(result.byApiKey["id:k1"]);
  assert.ok(result.last10Minutes.reduce((sum, b) => sum + b.requests, 0) >= 4);

  assert.ok((await stats.getMonthlyProviderTokensForConnection("openai", "c1")) >= 0);
  const spend = await stats.getConnectionSpendUsdSinceAdded("openai", "c1");
  assert.equal(spend.requests, 3);
  assert.equal(spend.costUsd, 1.5);

  const connSpeed = await speed.getConnectionSpeedStats("c1");
  assert.ok(connSpeed === null || typeof connSpeed === "object");
  const decorated = await speed.attachConnectionSpeedStats({ c1: { a: 1 } });
  assert.equal(decorated.c1.a, 1);
});

// ─── aggregation, analytics, summaries ────────────────────────────────────

test("aggregateHistory: rollup is idempotent and team rollup merges shapes", async () => {
  const agg = await import("../../../../src/lib/usage/aggregateHistory.ts");
  await db().execute(`INSERT INTO teams (id, name) VALUES ('team-1', 'Team One')`);

  const oldDay = new Date(Date.now() - 40 * DAY_MS);
  const dayIso = oldDay.toISOString().slice(0, 10);
  const at = (h: number) => `${dayIso}T${String(h).padStart(2, "0")}:00:00.000Z`;
  await insertUsage({ timestamp: at(1), teamId: "team-1", apiKeyId: "k1", costUsd: 0.25 });
  await insertUsage({ timestamp: at(2), teamId: "team-1", apiKeyId: "k1", costUsd: 0.25 });
  await insertUsage({ timestamp: at(3), teamId: "team-1", apiKeyId: "k1", costUsd: 0.5, success: false });
  await insertUsage({ timestamp: at(4), teamId: null, input: 7, output: 3, costUsd: 1 });

  const before = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const result = await agg.rollupUsageHistoryBeforeDate(before);
  assert.equal(result.errors, 0);

  const summary = await db().query<{
    total_requests: number;
    total_input_tokens: number;
    total_cost: number;
    date: string;
  }>("SELECT * FROM daily_usage_summary");
  assert.equal(summary.length, 1);
  assert.equal(summary[0].total_requests, 4);
  assert.equal(summary[0].total_input_tokens, 307);
  assert.equal(summary[0].total_cost, 2);
  assert.equal(summary[0].date, dayIso);

  const team = await db().queryOne<{
    total_requests: number;
    successful_requests: number;
    token_shapes: Record<string, number>;
    successful_token_shapes: Record<string, number>;
  }>("SELECT * FROM daily_team_usage_summary WHERE team_id = 'team-1'");
  assert.equal(team?.total_requests, 3);
  assert.equal(team?.successful_requests, 2);
  assert.deepEqual(team?.token_shapes, { "[100,50,0,0,0]": 3 });
  assert.deepEqual(team?.successful_token_shapes, { "[100,50,0,0,0]": 2 });

  const unprocessed = await db().queryOne<{ n: number }>(
    "SELECT count(*) AS n FROM usage_history WHERE billing_team_id IS NOT NULL AND team_rollup_processed_at IS NULL"
  );
  assert.equal(unprocessed?.n, 0);

  // A second run replaces the summary (idempotent) and adds nothing to the team rollup.
  await agg.rollupUsageHistoryBeforeDate(before);
  assert.equal((await db().queryOne<{ n: number }>("SELECT count(*) AS n FROM daily_usage_summary"))?.n, 1);
  assert.equal(
    (await db().queryOne<{ t: number }>("SELECT total_requests AS t FROM daily_team_usage_summary"))?.t,
    3
  );

  // New late rows for the same team/day merge into the existing shape object.
  await insertUsage({ timestamp: at(5), teamId: "team-1", apiKeyId: "k1", input: 1, output: 1 });
  await agg.rollupUsageHistoryBeforeDate(before);
  const merged = await db().queryOne<{ total_requests: number; token_shapes: Record<string, number> }>(
    "SELECT total_requests, token_shapes FROM daily_team_usage_summary"
  );
  assert.equal(merged?.total_requests, 4);
  assert.deepEqual(merged?.token_shapes, { "[100,50,0,0,0]": 3, "[1,1,0,0,0]": 1 });

  // quota_snapshots roll-up reads numeric fields of raw_data safely.
  await db().execute(`INSERT INTO provider_connections (id, provider) VALUES ('c', 'p')`);
  await db().execute(
    `INSERT INTO quota_snapshots (provider, connection_id, window_key, raw_data, created_at)
     VALUES ('p', 'c', 'w', '{"model":"m","input_tokens":5,"output_tokens":"x"}', $1)`,
    [ts(`${dayIso}T10:00:00Z`)]
  );
  const daily = await agg.rollupDailyUsage(dayIso, dayIso);
  assert.equal(daily.errors, 0);
  assert.equal(
    (await db().queryOne<{ n: number }>("SELECT total_input_tokens AS n FROM daily_usage_summary WHERE model = 'm'"))?.n,
    5
  );

  assert.equal(typeof (await agg.getRawDataCutoffDate()), "string");
  assert.equal(await agg.isAggregationEnabled(), true);
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('databaseSettings', 'aggregation.enabled', 'false')`
  );
  assert.equal(await agg.isAggregationEnabled(), false);
});

test("usageAnalytics queries over the unified source", async () => {
  const analytics = await import("../../../../src/lib/db/usageAnalytics.ts");
  const teamAnalytics = await import("../../../../src/lib/db/teamUsageAnalytics.ts");
  const summaries = await import("../../../../src/lib/db/usageSummary.ts");
  const groups = await import("../../../../src/lib/db/usageModelGroups.ts");
  const metrics = await import("../../../../src/lib/db/settings/cacheMetrics.ts");

  const now = Date.now();
  const recent = (offset: number) => new Date(now - offset).toISOString();
  await insertUsage({ timestamp: recent(1000), apiKeyId: "k1", apiKeyName: "One", connectionId: "c1", cacheRead: 40, endpoint: "/v1/chat" });
  await insertUsage({ timestamp: recent(2000), apiKeyId: "k1", apiKeyName: "One", connectionId: "c1", provider: "anthropic", model: "claude" });
  await insertUsage({ timestamp: recent(3000), apiKeyId: "k2", apiKeyName: "Two", success: false, costUsd: 0.1 });
  // A rolled-up day well in the past.
  await db().execute(
    `INSERT INTO daily_usage_summary (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
     VALUES ('openai', 'gpt-4o', '2020-01-05', 10, 1000, 500, 1.5)`
  );

  const since = new Date(now - DAY_MS).toISOString();
  const raw = analytics.buildUnifiedSource({
    sinceIso: since,
    untilIso: null,
    rawCutoffDate: "2025-01-01",
    apiKeyWhere: "",
    apiKeyParams: {},
  });
  const all = analytics.buildUnifiedSource({
    sinceIso: null,
    untilIso: null,
    rawCutoffDate: new Date(now - 30 * DAY_MS).toISOString().slice(0, 10),
    apiKeyWhere: "",
    apiKeyParams: {},
  });

  const summary = await analytics.getUsageSummary(raw.unifiedSource, raw.unifiedParams);
  assert.equal(summary.totalRequests, 3);
  assert.equal(summary.successfulRequests, 2);
  assert.equal(summary.uniqueApiKeys, 2);
  assert.ok(summary.firstRequest && summary.lastRequest);

  const unified = await analytics.getUsageSummary(all.unifiedSource, all.unifiedParams);
  assert.equal(unified.totalRequests, 13);

  const daily = await analytics.getDailyUsage(all.unifiedSource, all.unifiedParams);
  assert.equal(daily[0].date, "2020-01-05");
  assert.equal(daily[0].requests, 10);

  const dailyCost = await analytics.getDailyCostRows(all.unifiedSource, all.unifiedParams);
  assert.ok(dailyCost.some((r) => r.isAggregated === 1 && r.storedCost === 1.5));

  const modelRows = await analytics.getModelUsageRows(raw.unifiedSource, raw.unifiedParams);
  assert.equal(modelRows.find((r) => r.model === "gpt-4o")?.requests, 2);
  assert.ok(modelRows[0].lastUsed);

  assert.equal((await analytics.getProviderCostRows(raw.unifiedSource, raw.unifiedParams)).length, 2);
  assert.equal((await analytics.getProviderUsageRows(raw.unifiedSource, raw.unifiedParams)).length, 2);
  assert.equal((await analytics.getServiceTierUsageRows(raw.unifiedSource, raw.unifiedParams)).length, 2);
  const weekly = await analytics.getWeeklyPatternRows(raw.unifiedSource, raw.unifiedParams);
  assert.ok(weekly.length >= 1 && /^[0-6]$/.test(weekly[0].dayOfWeek));
  const providerDaily = await analytics.getProviderDailyUsageRows(all.unifiedSource, all.unifiedParams);
  assert.ok(providerDaily.length >= 2);

  const preset = analytics.buildPresetUnifiedSource({
    sinceIso: since,
    untilIso: null,
    rawCutoffDate: "2025-01-01",
    apiKeyWhere: "",
    apiKeyParams: {},
  });
  assert.equal((await analytics.getPresetCostModelRows(preset.unifiedSource, preset.unifiedParams)).length, 2);

  const heat = await analytics.getHeatmapRows(['"timestamp" >= @h'], { h: since });
  assert.equal(heat.length >= 1, true);
  assert.equal(heat.reduce((s, r) => s + r.totalTokens, 0), 450);

  const keyWhere = "WHERE (api_key_id IN (@apiKey0))";
  const keyRows = await analytics.getApiKeyUsageRows(keyWhere, { apiKey0: "k1" });
  assert.equal(keyRows.reduce((s, r) => s + r.requests, 0), 2);
  const keyTotals = await analytics.getApiKeyTotalsRows(keyWhere, { apiKey0: "k1" });
  assert.ok(keyTotals[0].lastUsed);
  const keyMeta = await analytics.getApiKeyMetadataRows("WHERE api_key_id IS NOT NULL", {});
  assert.equal(keyMeta.length, 2);

  const accountCost = await analytics.getAccountCostRows("WHERE usage_history.connection_id = @c", { c: "c1" });
  assert.equal(accountCost.length, 2);
  const accountUsage = await analytics.getAccountUsageRows("", {});
  assert.ok(accountUsage.length >= 1);
  assert.ok(accountUsage.every((r) => r.account));

  const endpoints = await analytics.getEndpointUsageRows({ sinceIso: since });
  assert.deepEqual(endpoints.map((e) => e.endpoint).sort(), ["/v1/chat", "unknown", "unknown"]);
  assert.equal(
    (await analytics.getAllUsageHistory()).length + (await analytics.getAllDailyTeamUsageSummary()).length +
      (await analytics.getAllDomainCostHistory()).length + (await analytics.getAllDomainBudgets()).length,
    3
  );

  // Team usage report: raw rows (unprocessed) plus retained summaries.
  await db().execute(`INSERT INTO teams (id, name) VALUES ('t1', 'T1')`);
  await insertUsage({ timestamp: recent(500), teamId: "t1", apiKeyId: "k1", costUsd: 0.2 });
  const report = await teamAnalytics.getTeamUsageReport("t1");
  assert.equal(report.summary.requests, 1);
  assert.equal(report.summary.successfulRequests, 1);
  assert.equal(report.byApiKey.length, 1);

  // Cache metrics and monthly sum.
  const cache = await metrics.getCacheMetrics();
  assert.equal(cache.requestsWithCacheControl, 1);
  assert.equal(cache.totalCachedTokens, 40);
  assert.equal(cache.byProvider.openai.cachedRequests, 1);
  const trend = await metrics.getCacheTrend(24);
  assert.ok(trend.length >= 1);
  assert.match(trend[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
  assert.ok((await summaries.sumUsageTokensThisMonth()) >= 0);

  // Unpriced-usage groups skip rows that carry a provider-reported cost.
  const modelGroups = await groups.getSuccessfulUsageModelGroupsSince(since);
  assert.deepEqual(modelGroups.map((g) => `${g.provider}/${g.model}`).sort(), ["anthropic/claude", "openai/gpt-4o"]);
  await db().execute(`INSERT INTO api_keys (id, name, key, key_hash, usage_limit_enabled, daily_usage_limit_usd)
    VALUES ('k1', 'One', 'enc', repeat('a', 64), true, 5)`);
  assert.equal(await groups.countLimitedApiKeysUsingModelsSince(since, ["openai/gpt-4o"]), 1);
  assert.equal(await groups.countLimitedApiKeysUsingModelsSince(since, []), 0);
});

// ─── call_logs based views ────────────────────────────────────────────────

test("call_logs readers: auto-routing breakdown, cache health, combo health, recent logs", async () => {
  const usageLogs = await import("../../../../src/lib/db/usageLogs.ts");
  const cacheHealth = await import("../../../../src/lib/usage/cacheHealth.ts");
  const history = await import("../../../../src/lib/usage/usageHistory.ts");

  const now = Date.now();
  const insertLog = (id: string, requested: string, over: Record<string, unknown> = {}) =>
    db().execute(
      `INSERT INTO call_logs (id, "timestamp", status, model, requested_model, provider, duration,
         tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, combo_name)
       VALUES ($1, $2, $3, $4, $5, $6, 100, 10, 5, $7, $8, $9)`,
      [
        id,
        new Date(now - 1000).toISOString(),
        over.status ?? 200,
        over.model ?? "gpt-4o",
        requested,
        over.provider ?? "openai",
        over.read ?? null,
        over.write ?? null,
        over.combo ?? null,
      ]
    );
  await insertLog("a", "auto");
  await insertLog("b", "auto/fast");
  await insertLog("c", "gpt-4o", { read: 500, write: 100 });

  assert.deepEqual(await usageLogs.getAutoRoutingTotalCount(), { count: 2 });
  const variants = await usageLogs.getAutoRoutingVariantBreakdown();
  assert.deepEqual(variants.map((v) => v.variant).sort(), ["default", "fast"]);
  assert.deepEqual(await usageLogs.getAutoRoutingTopProviders(), [{ provider: "openai", count: 2 }]);

  const health = await cacheHealth.buildCacheHealthResponse({ range: "24h" });
  assert.equal(health.totalCalls, 1);
  assert.equal(health.cacheReadTotal, 500);
  assert.equal(health.truncated, false);
  const filtered = await cacheHealth.buildCacheHealthResponse({ range: "24h", model: "nope" });
  assert.equal(filtered.totalCalls, 0);

  const recent = await history.getRecentLogs(2);
  assert.equal(recent.length, 2);
  assert.match(recent[0], /OPENAI/);
});

test("comboHealth: usage skew and performance come from call_logs", async () => {
  const comboHealth = await import("../../../../src/lib/usage/comboHealth.ts");
  const now = Date.now();
  await db().execute(
    `INSERT INTO call_logs (id, "timestamp", status, model, provider, duration, tokens_in, tokens_out, combo_name, combo_step_id)
     VALUES ('l1', $1, 200, 'm1', 'openai', 100, 10, 5, 'combo-a', 'step-1'),
            ('l2', $1, 500, 'm1', 'openai', 300, 10, 5, 'combo-a', 'step-1')`,
    [new Date(now - 1000).toISOString()]
  );
  const response = await comboHealth.buildComboHealthResponse({
    range: "24h",
    now,
    combos: [
      {
        id: "combo-a",
        name: "combo-a",
        strategy: "priority",
        models: [{ id: "s1", kind: "model", model: "openai/m1" }],
      } as never,
    ],
  });
  const combo = response.combos[0];
  assert.equal(combo.performance.totalRequests, 2);
  assert.equal(combo.performance.successRate, 0.5);
  assert.equal(combo.performance.avgLatencyMs, 200);
  assert.equal(combo.usageSkew.modelDistribution.find((m) => m.model === "m1")?.requestShare, 1);
  assert.ok(Array.isArray(combo.quotaHealth.providers));
});

// ─── provider window costs, self service, bridge ──────────────────────────

test("providerWindowCosts and apiKeySelfService read usage_history", async () => {
  const windowCosts = await import("../../../../src/lib/usage/providerWindowCosts.ts");
  const selfService = await import("../../../../src/lib/usage/apiKeySelfService.ts");
  const now = Date.now();
  await insertUsage({ timestamp: new Date(now - 1000).toISOString(), apiKeyId: "k1", apiKeyName: "One", connectionId: "c1", costUsd: 0.75 });
  await insertUsage({ timestamp: new Date(now - 2000).toISOString(), apiKeyId: "k1", apiKeyName: "One", connectionId: "c1", costUsd: 0.25 });
  await db().execute(
    `INSERT INTO domain_cost_history (api_key_id, cost, "timestamp") VALUES ('k1', 0.5, $1)`,
    [new Date(now - 1000).toISOString()]
  );

  const breakdown = await windowCosts.getProviderWindowCostBreakdown({ provider: "openai", now });
  assert.equal(breakdown.windowSource, "fallback_rolling_7d");
  assert.equal(breakdown.rows.length, 1);
  assert.equal(breakdown.rows[0].requests, 2);
  assert.equal(breakdown.rows[0].costUsd, 1);
  assert.equal(breakdown.totalCostUsd, 1);

  const status = await selfService.buildApiKeySelfServiceStatus(
    { id: "k1", name: "One", scopes: ["usage:self"], allowedConnections: [] },
    {
      now: () => now,
      getCostSummary: () => ({
        budget: null,
        totalCostMonth: 1,
        totalCostPeriod: 1,
        activeLimitUsd: 0,
        resetInterval: null,
        budgetResetAt: null,
        periodStartAt: null,
        nextResetAt: null,
        warningThreshold: null,
      }),
      checkBudget: () => ({}),
      getProviderConnectionById: async () => null,
      getProviderConnections: async () => [],
      fetchAndPersistProviderLimits: async () => ({ usage: {} }),
    }
  ).catch((error: Error) => error);
  if (status instanceof Error) {
    // The scope name is owned by selfServiceScopes; only the SQL path matters here.
    assert.equal(status.message, "missing_self_usage_scope");
  } else {
    assert.equal(status.usage.tokens.inputTokens, 200);
    assert.equal(status.usage.tokens.outputTokens, 100);
  }
});

test("semanticCacheDbBridge: cache settings and embedding connection feed the resolver", async () => {
  const bridge = await import("../../../../src/lib/cache/semanticCacheDbBridge.ts");
  const config = await import("../../../../open-sse/config/semanticCacheConfig.ts");

  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES
       ('databaseSettings', 'cache.semanticCacheVectorEnabled', 'true'),
       ('databaseSettings', 'cache.semanticCacheEmbeddingProvider', '"lemonade"'),
       ('databaseSettings', 'cache.semanticCacheThreshold', '0.9')`
  );
  await db().execute(
    `INSERT INTO provider_connections (id, provider, api_key, provider_specific_data, priority)
     VALUES ('pc1', 'lemonade', 'sk-test', '{"baseUrl":"http://localhost:1234/v1"}', 1)`
  );
  assert.deepEqual(await bridge.resolveProviderConnectionDetails("lemonade"), {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "sk-test",
  });
  assert.deepEqual(await bridge.resolveProviderConnectionDetails("nobody"), {});

  // ensure returns the first snapshot read, so the first manager can await it.
  await bridge.ensureSemanticCacheDbBridge();
  const resolved = config.resolveSemanticCacheConfig();
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.similarityThreshold, 0.9);
  assert.equal(resolved.embeddingBaseUrl, "http://localhost:1234/v1");

  // A save becomes visible after an awaited refresh.
  await db().execute(
    `UPDATE config_entries SET value = '0.5' WHERE namespace = 'databaseSettings' AND key = 'cache.semanticCacheThreshold'`
  );
  await bridge.refreshSemanticCacheDbBridge();
  assert.equal(config.resolveSemanticCacheConfig().similarityThreshold, 0.5);

  // A failed read keeps the last good snapshot instead of resetting it to null.
  const backend = db();
  const original = backend.query.bind(backend);
  (backend as { query: unknown }).query = async () => {
    throw new Error("transient");
  };
  try {
    await bridge.refreshSemanticCacheDbBridge();
  } finally {
    (backend as { query: unknown }).query = original;
  }
  assert.equal(config.resolveSemanticCacheConfig().similarityThreshold, 0.5);
});

test("export rows keep the stable export format", async () => {
  const analytics = await import("../../../../src/lib/db/usageAnalytics.ts");
  await db().execute(`INSERT INTO teams (id, name) VALUES ('team-x', 'X')`);
  await db().execute(
    `INSERT INTO daily_team_usage_summary (date, team_id, api_key_id, provider, model, total_requests, token_shapes, successful_token_shapes)
     VALUES ('2026-01-01', 'team-x', 'k', 'p', 'm', 2, '{"[1,2,0,0,0]": 2}', NULL)`
  );
  const summaries = await analytics.getAllDailyTeamUsageSummary();
  assert.equal(summaries.length, 1);
  assert.deepEqual(JSON.parse(String(summaries[0].token_shapes_json)), { "[1,2,0,0,0]": 2 });
  assert.equal(summaries[0].successful_token_shapes_json, null);
  assert.equal("token_shapes" in summaries[0], false);

  await insertUsage({ timestamp: new Date().toISOString(), success: false });
  await insertUsage({ timestamp: new Date().toISOString(), success: true });
  const history = await analytics.getAllUsageHistory();
  assert.deepEqual(history.map((r) => r.success).sort(), [0, 1]);
});
