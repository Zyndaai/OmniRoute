import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../../../../src/lib/db/pg.ts";
import { truncateAll } from "../../../helpers/postgres.ts";
import * as providers from "../../../../src/lib/db/providers.ts";
import {
  getProviderNodePrefixSync,
  getProviderNodeIdByPrefixSync,
} from "../../../../src/lib/db/providers/nodePrefix.ts";
import {
  isProviderNodeIdConflictError,
  isProviderNodePrefixConflictError,
} from "../../../../src/lib/db/providers/nodes.ts";
import { mergeConnectionProviderSpecificData } from "../../../../src/lib/db/providers/providerSpecificDataMerge.ts";
import {
  setProviderLimitsCache,
  setProviderLimitsCacheBatch,
  getProviderLimitsCache,
  getAllProviderLimitsCache,
  deleteProviderLimitsCache,
} from "../../../../src/lib/db/providerLimits.ts";
import {
  getProviderCallStats,
  getModelCallStats,
} from "../../../../src/lib/db/providerStats.ts";
import { clearCodexAccountCooldown } from "../../../../src/lib/db/providers/codexAccountRecovery.ts";
import { getGheCopilotHosts, autoMigrateLegacyEncryptedConnections } from "../../../../src/lib/db/providers/migrations.ts";

type Row = Record<string, any>;

beforeEach(async () => {
  await truncateAll(db());
});

async function apiKeyConnection(provider: string, name: string, extra: Row = {}) {
  return (await providers.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    ...extra,
  })) as Row;
}

// ───────────────────────── provider_nodes ─────────────────────────

test("provider nodes: create, read, update, delete, id conflict", async () => {
  const node = (await providers.createProviderNode({
    id: "openai-compatible-aaa",
    type: "openai-compatible",
    name: "Alpha",
    prefix: "al",
    apiType: "chat",
    baseUrl: "https://alpha.example/v1",
    customHeaders: { "x-team": "one" },
    dailyQuotaResetHour: 0,
  })) as Row;
  assert.equal(node.id, "openai-compatible-aaa");
  assert.deepEqual(node.customHeaders, { "x-team": "one" });
  assert.equal(node.dailyQuotaResetHour, 0);

  await assert.rejects(
    () => providers.createProviderNode({ id: "openai-compatible-aaa", type: "openai-compatible", name: "Dup" }),
    (err: unknown) => isProviderNodeIdConflictError(err)
  );

  const read = (await providers.getProviderNodeById("openai-compatible-aaa")) as Row;
  assert.equal(read.name, "Alpha");
  assert.deepEqual(read.customHeaders, { "x-team": "one" });
  assert.equal(typeof read.createdAt, "string");

  // A partial update keeps the stored headers; an explicit null clears them.
  const renamed = (await providers.updateProviderNode("openai-compatible-aaa", {
    name: "Alpha 2",
    customHeaders: undefined,
  })) as Row;
  assert.equal(renamed.name, "Alpha 2");
  assert.deepEqual(renamed.customHeaders, { "x-team": "one" });
  const cleared = (await providers.updateProviderNode("openai-compatible-aaa", {
    customHeaders: null,
  })) as Row;
  assert.equal(cleared.customHeaders, null);
  assert.equal(((await providers.getProviderNodeById("openai-compatible-aaa")) as Row).customHeaders, null);

  await providers.createProviderNode({
    id: "anthropic-compatible-11111111-2222-3333-4444-555555555555",
    type: "anthropic-compatible",
    name: "Beta",
  });
  assert.equal(await providers.getProviderNodesCount(), 2);
  assert.equal(await providers.getProviderNodesCount({ type: "anthropic-compatible" }), 1);
  const page = (await providers.getProviderNodes({}, 1, 1)) as Row[];
  assert.deepEqual(page.map((n) => n.id), ["openai-compatible-aaa"]);
  const betaId = "anthropic-compatible-11111111-2222-3333-4444-555555555555";
  assert.equal((await providers.resolveProviderNodeForConnection("anthropic-compatible"))?.id, betaId);

  assert.equal(await providers.updateProviderNode("missing", { name: "x" }), null);
  const removed = (await providers.deleteProviderNode(betaId)) as Row;
  assert.equal(removed.name, "Beta");
  assert.equal(await providers.deleteProviderNode(betaId), null);
});

test("provider node prefix lookups follow node writes and treat blank prefixes as none", async () => {
  await providers.createProviderNode({ id: "node-1", type: "openai-compatible", name: "N1", prefix: "Aegy" });
  await providers.createProviderNode({ id: "node-2", type: "openai-compatible", name: "N2", prefix: "   " });
  assert.equal(await getProviderNodePrefixSync("node-1"), "Aegy");
  assert.equal(await getProviderNodePrefixSync("node-2"), null);
  assert.equal(await getProviderNodeIdByPrefixSync(" aegy "), "node-1");
  await providers.updateProviderNode("node-1", { prefix: "zed" });
  assert.equal(await getProviderNodeIdByPrefixSync("aegy"), null);
  assert.equal(await getProviderNodeIdByPrefixSync("ZED"), "node-1");
  await providers.deleteProviderNode("node-1");
  assert.equal(await getProviderNodeIdByPrefixSync("zed"), null);
});

// ───────────────────────── provider_connections ─────────────────────────

test("connections: create, dedup by api key, read with filters, projection, count", async () => {
  const first = await apiKeyConnection("openai", "one");
  assert.equal(first.priority, 1);
  const second = await apiKeyConnection("openai", "two", { group: "team-a", isActive: false });
  assert.equal(second.priority, 2);
  await apiKeyConnection("claude", "three", { proxyEnabled: false });

  // Same key under another name updates the first row instead of inserting.
  const dup = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "renamed",
    apiKey: "sk-one",
  });
  assert.equal((dup as Row).id, first.id);
  assert.equal(await providers.getProviderConnectionsCount(), 3);

  const byId = (await providers.getProviderConnectionById(second.id)) as Row;
  assert.equal(byId.apiKey, "sk-two");
  assert.equal(byId.group, "team-a");
  assert.equal(byId.isActive, false);
  assert.equal(typeof byId.createdAt, "string");
  assert.equal(byId.quotaWindowThresholds, null);
  assert.equal(await providers.getProviderConnectionById("missing"), null);

  assert.equal(await providers.getProviderConnectionsCount({ provider: "openai" }), 2);
  assert.equal(await providers.getProviderConnectionsCount({ isActive: false }), 1);
  assert.equal(await providers.getProviderConnectionsCount({ authType: "apikey" }), 3);
  const active = await providers.getProviderConnections({ provider: "openai", isActive: true });
  assert.deepEqual(active.map((c: Row) => c.id), [first.id]);

  const projected = (await providers.getProviderConnections({}, 3, 0, ["id", "group"])) as Row[];
  assert.equal(projected.length, 3);
  assert.ok(projected.some((c) => c.group === "team-a"));
  await assert.rejects(() => providers.getProviderConnections({}, undefined, undefined, ["id; DROP TABLE x"]));

  const meta = await providers.getProviderConnectionDisplayMetadata([first.id, second.id, ""]);
  assert.deepEqual(meta.map((m) => m.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(await providers.getDistinctGroups(), ["team-a"]);
});

test("connections: update merges, keeps unspecified fields, and normalises json and timestamps", async () => {
  const conn = await apiKeyConnection("openai", "upd");
  const expiresAt = "2026-12-01T10:00:00.000Z";
  const updated = (await providers.updateProviderConnection(conn.id, {
    name: "upd 2",
    expiresAt,
    expiresIn: 3600.4,
    quotaWindowThresholds: { session: 90 },
    rateLimitOverrides: { rpm: 5 },
    providerSpecificData: { baseUrl: "https://x.example" },
    maxConcurrent: 2,
  })) as Row;
  assert.equal(updated.name, "upd 2");
  assert.equal(updated.apiKey, "sk-upd");

  const read = (await providers.getProviderConnectionById(conn.id)) as Row;
  assert.equal(read.name, "upd 2");
  assert.equal(read.expiresAt, expiresAt);
  assert.equal(read.expiresIn, 3600);
  assert.deepEqual(read.quotaWindowThresholds, { session: 90 });
  assert.deepEqual(read.rateLimitOverrides, { rpm: 5 });
  assert.equal(read.providerSpecificData.baseUrl, "https://x.example");
  assert.equal(read.maxConcurrent, 2);
  assert.equal(read.apiKey, "sk-upd");

  assert.equal(await providers.updateProviderConnection("missing", { name: "x" }), null);
  await assert.rejects(() =>
    providers.updateProviderConnection(conn.id, { quotaWindowThresholds: { session: 500 } })
  );
});

test("connections: concurrent updates of different fields both survive", async () => {
  const conn = await apiKeyConnection("openai", "race");
  await Promise.all([
    providers.updateProviderConnection(conn.id, { displayName: "Race Display" }),
    providers.updateProviderConnection(conn.id, { defaultModel: "gpt-x" }),
    providers.updateProviderConnection(conn.id, { email: "race@example.com" }),
  ]);
  const read = (await providers.getProviderConnectionById(conn.id)) as Row;
  assert.equal(read.displayName, "Race Display");
  assert.equal(read.defaultModel, "gpt-x");
  assert.equal(read.email, "race@example.com");
});

test("connections: concurrent providerSpecificData merges keep every key", async () => {
  const conn = await apiKeyConnection("openai", "merge", { providerSpecificData: { keep: 1 } });
  await Promise.all(
    ["a", "b", "c", "d"].map((key) => providers.mergeConnectionProviderSpecificData(conn.id, { [key]: key }))
  );
  const read = (await providers.getProviderConnectionById(conn.id)) as Row;
  assert.deepEqual(
    { keep: read.providerSpecificData.keep, a: read.providerSpecificData.a, d: read.providerSpecificData.d },
    { keep: 1, a: "a", d: "d" }
  );
  assert.equal(Object.keys(read.providerSpecificData).length >= 5, true);
});

test("connections: concurrent creates get distinct priorities and priority 0 moves to the top", async () => {
  const created = (await Promise.all(
    ["p1", "p2", "p3", "p4"].map((name) => apiKeyConnection("openai", name))
  )) as Row[];
  const rows = (await providers.getProviderConnections({ provider: "openai" })) as Row[];
  assert.deepEqual(rows.map((r) => r.priority), [1, 2, 3, 4]);

  const last = rows[3];
  await providers.updateProviderConnection(last.id, { priority: 0 });
  const after = (await providers.getProviderConnections({ provider: "openai" })) as Row[];
  assert.equal(after[0].id, last.id);
  assert.deepEqual(after.map((r) => r.priority), [1, 2, 3, 4]);
  assert.equal(created.length, 4);
});

test("connections: touch, synced-models stamp and backoff reset", async () => {
  const conn = await apiKeyConnection("openai", "touch");
  await providers.touchConnectionLastUsed(conn.id, 7);
  await providers.touchConnectionSyncedModelsAt(conn.id);
  let read = (await providers.getProviderConnectionById(conn.id)) as Row;
  assert.equal(read.consecutiveUseCount, 7);
  assert.equal(typeof read.lastUsedAt, "string");
  assert.equal(typeof read.syncedModelsAt, "string");

  await providers.updateProviderConnection(conn.id, {
    backoffLevel: 3,
    testStatus: "unavailable",
    lastError: "boom",
    errorCode: 429,
  });
  await providers.resetConnectionBackoff(conn.id);
  read = (await providers.getProviderConnectionById(conn.id)) as Row;
  assert.equal(read.backoffLevel, 0);
  assert.equal(read.testStatus, "active");
  assert.equal(read.lastError, undefined);
});

test("rate limits: set, check, list, clear, crash recovery and compare-and-clear", async () => {
  const a = await apiKeyConnection("openai", "rl-a");
  const b = await apiKeyConnection("openai", "rl-b");
  const c = await apiKeyConnection("openai", "rl-c");

  assert.equal(await providers.isConnectionRateLimited(a.id), false);
  await providers.setConnectionRateLimitUntil(a.id, Date.now() - 1000); // expired write is a no-op
  assert.equal(await providers.isConnectionRateLimited(a.id), false);

  const until = Date.now() + 60_000;
  await providers.setConnectionRateLimitUntil(a.id, until);
  assert.equal(await providers.isConnectionRateLimited(a.id), true);
  const limited = await providers.getRateLimitedConnections("openai");
  assert.deepEqual(limited, [{ id: a.id, rateLimitedUntil: until }]);

  await providers.clearConnectionRateLimit(a.id);
  assert.equal(await providers.isConnectionRateLimited(a.id), false);
  await providers.markConnectionRateLimitedUntil(a.id, 120_000);
  assert.equal(await providers.isConnectionRateLimited(a.id), true);

  // Crash recovery keeps future cooldowns and terminal states, clears the expired one.
  const past = new Date(Date.now() - 5000).toISOString();
  await db().execute(
    "UPDATE provider_connections SET rate_limited_until = $1, test_status = 'unavailable', backoff_level = 4 WHERE id = $2",
    [past, b.id]
  );
  await db().execute(
    "UPDATE provider_connections SET rate_limited_until = $1, test_status = 'banned' WHERE id = $2",
    [past, c.id]
  );
  assert.deepEqual(await providers.clearStaleCrashCooldowns(), { cleared: 1 });
  const rb = (await providers.getProviderConnectionById(b.id)) as Row;
  assert.equal(rb.rateLimitedUntil, undefined);
  assert.equal(rb.testStatus, "active");
  assert.equal(rb.backoffLevel, 0);
  assert.equal(await providers.isConnectionRateLimited(a.id), true);
  const rc = (await providers.getProviderConnectionById(c.id)) as Row;
  assert.equal(rc.testStatus, "banned");

  // Compare-and-clear applies once, and refuses a stale snapshot.
  const snapshot = (await providers.getProviderConnectionById(a.id)) as Row;
  await providers.updateProviderConnection(a.id, { testStatus: "unavailable", lastErrorAt: new Date().toISOString() });
  const fresh = (await providers.getProviderConnectionById(a.id)) as Row;
  assert.equal(
    await providers.clearConnectionErrorIfUnchanged(a.id, {
      testStatus: snapshot.testStatus,
      lastErrorAt: snapshot.lastErrorAt,
      rateLimitedUntil: snapshot.rateLimitedUntil,
    }),
    false
  );
  const results = await Promise.all([
    providers.clearConnectionErrorIfUnchanged(a.id, {
      testStatus: fresh.testStatus,
      lastErrorAt: fresh.lastErrorAt,
      rateLimitedUntil: fresh.rateLimitedUntil,
    }),
    providers.clearConnectionErrorIfUnchanged(a.id, {
      testStatus: fresh.testStatus,
      lastErrorAt: fresh.lastErrorAt,
      rateLimitedUntil: fresh.rateLimitedUntil,
    }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await providers.isConnectionRateLimited(a.id), false);

  assert.equal(providers.getEffectiveQuotaUsage(10, new Date(Date.now() - 1000).toISOString()), 0);
  assert.equal(providers.getEffectiveQuotaUsage(10, null), 10);
});

test("codex scope state: scoped quota merge, cooldown lift and account release", async () => {
  const codex = (await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    email: "c@example.com",
    accessToken: "at",
    providerSpecificData: { workspaceId: "w1", chatgptUserId: "u1" },
  })) as Row;
  const future = new Date(Date.now() + 3_600_000).toISOString();

  await Promise.all([
    providers.updateCodexScopeCooldown(codex.id, "codex", future),
    providers.updateCodexScopeCooldown(codex.id, "spark", future),
  ]);
  const psd = ((await providers.getProviderConnectionById(codex.id)) as Row).providerSpecificData;
  assert.equal(psd.codexScopeRateLimitedUntil.codex, future);
  assert.equal(psd.codexScopeRateLimitedUntil.spark, future);
  assert.equal(await providers.hasCodexScopeCooldown(codex.id, "spark"), true);

  assert.equal(await providers.liftCodexScopeCooldownOnHeadroom(codex.id, "spark"), true);
  assert.equal(await providers.hasCodexScopeCooldown(codex.id, "spark"), false);
  assert.equal(await providers.hasCodexScopeCooldown(codex.id, "codex"), true);

  await clearCodexAccountCooldown(codex.id, "codex");
  assert.equal(await providers.hasCodexScopeCooldown(codex.id, "codex"), false);

  // A non-codex connection is left alone.
  const other = await apiKeyConnection("openai", "not-codex");
  assert.equal(await providers.updateCodexScopedQuotaState(other.id, "codex", { rateLimitedUntil: future }), null);

  // Same codex identity upserts onto the existing row instead of adding another.
  const again = (await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    email: "c@example.com",
    accessToken: "at2",
    providerSpecificData: { workspaceId: "w1", chatgptUserId: "u1" },
  })) as Row;
  assert.equal(again.id, codex.id);
  assert.equal(await providers.getProviderConnectionsCount({ provider: "codex" }), 1);
});

test("codex identity promotion rewrites usage_history account keys in the same transaction", async () => {
  const first = (await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    email: "p@example.com",
    accessToken: "at",
    providerSpecificData: { workspaceId: "w9" },
  })) as Row;
  const oldKey = JSON.stringify(["oauth", "codex", "workspace", "w9", "email", "p@example.com"]);
  await db().execute(
    `INSERT INTO usage_history (id, "timestamp", provider, connection_id, account_key, account_label, account_label_priority)
     VALUES (1, now(), 'codex', $1, $2, 'old', 1)`,
    [first.id, oldKey]
  );
  await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    email: "p@example.com",
    accessToken: "at",
    providerSpecificData: { workspaceId: "w9", chatgptUserId: "u9" },
  });
  const row = await db().queryOne<Row>("SELECT account_key, account_label_priority FROM usage_history WHERE id = 1");
  assert.equal(row?.account_key, JSON.stringify(["oauth", "codex", "workspace", "w9", "user", "u9"]));
  assert.ok((row?.account_label_priority ?? 0) >= 3);
});

test("connection deletion removes rows with and without foreign keys", async () => {
  const a = await apiKeyConnection("openai", "del-a");
  const b = await apiKeyConnection("openai", "del-b");
  const c = await apiKeyConnection("openai", "del-c");
  const d = await apiKeyConnection("claude", "del-d");

  for (const conn of [a, b, c, d]) {
    await setProviderLimitsCache(conn.id, {
      quotas: null,
      plan: null,
      message: null,
      fetchedAt: new Date().toISOString(),
    });
    await db().execute(
      `INSERT INTO provider_quota_state (connection_id, model, window_start, window_reset) VALUES ($1, 'm', now(), now())`,
      [conn.id]
    );
    await db().execute(
      `INSERT INTO auto_candidate_overrides (api_key_id, auto_channel, connection_id) VALUES ('k', 'auto', $1)`,
      [conn.id]
    );
  }

  assert.equal(await providers.deleteProviderConnection(a.id), true);
  assert.equal(await providers.deleteProviderConnection(a.id), false);
  assert.equal(await getProviderLimitsCache(a.id), null);
  const orphanState = await db().query("SELECT 1 FROM provider_quota_state WHERE connection_id = $1", [a.id]);
  assert.equal(orphanState.length, 0);
  const orphanOverride = await db().query("SELECT 1 FROM auto_candidate_overrides WHERE connection_id = $1", [a.id]);
  assert.equal(orphanOverride.length, 0);

  // The survivors of the provider are renumbered 1..n.
  const left = (await providers.getProviderConnections({ provider: "openai" })) as Row[];
  assert.deepEqual(left.map((r) => r.priority), [1, 2]);

  assert.equal(await providers.deleteProviderConnections([b.id, "nope"]), 1);
  assert.equal(await providers.deleteProviderConnections([]), 0);
  assert.equal(await providers.deleteProviderConnectionsByProvider("openai"), 1);
  assert.equal(await providers.getProviderConnectionsCount(), 1);
  assert.equal((await getAllProviderLimitsCache())[d.id] !== undefined, true);
  assert.equal(Object.keys(await getAllProviderLimitsCache()).length, 1);
});

test("migrations: legacy re-encrypt sweep is a no-op without legacy data and GHE hosts resolve", async () => {
  await providers.createProviderConnection({
    provider: "ghe-copilot",
    authType: "oauth",
    email: "g@example.com",
    accessToken: "t",
    providerSpecificData: { gheUrl: "https://ghe.corp.example/path", copilotApiUrl: "not a url" },
  });
  await providers.createProviderConnection({
    provider: "ghe-copilot",
    authType: "oauth",
    email: "off@example.com",
    accessToken: "t2",
    isActive: false,
    providerSpecificData: { gheUrl: "https://disabled.example" },
  });
  assert.deepEqual(await getGheCopilotHosts(), ["ghe.corp.example"]);
  assert.equal(await autoMigrateLegacyEncryptedConnections(), 0);
});

// ───────────────────────── connection_limits_cache ─────────────────────────

test("provider limits cache: upsert, batch, read, delete, and no row for a missing connection", async () => {
  const a = await apiKeyConnection("openai", "lim-a");
  const b = await apiKeyConnection("openai", "lim-b");
  const entry = (fetchedAt: string, extra: Row = {}) => ({
    quotas: { session: { used: 1, total: 10 } },
    plan: "pro",
    message: null,
    fetchedAt,
    source: "test",
    ...extra,
  });

  const stored = await setProviderLimitsCache(a.id, entry("2026-01-01T00:00:00.000Z"));
  assert.equal(stored.fetchedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual((await getProviderLimitsCache(a.id))?.quotas, { session: { used: 1, total: 10 } });

  await setProviderLimitsCache(a.id, entry("2026-02-01T00:00:00.000Z", { limitReached: true }));
  const second = await getProviderLimitsCache(a.id);
  assert.equal(second?.fetchedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(second?.limitReached, true);

  assert.equal(
    await setProviderLimitsCacheBatch([
      { connectionId: a.id, entry: entry("2026-03-01T00:00:00.000Z") },
      { connectionId: b.id, entry: entry("2026-03-02T00:00:00.000Z") },
      { connectionId: "deleted-meanwhile", entry: entry("2026-03-03T00:00:00.000Z") },
    ]),
    3
  );
  const all = await getAllProviderLimitsCache();
  assert.deepEqual(Object.keys(all).sort(), [a.id, b.id].sort());
  assert.equal(await getProviderLimitsCache("deleted-meanwhile"), null);

  // Concurrent writers for one connection: one row, last committed value.
  await Promise.all(
    [4, 5, 6].map((month) => setProviderLimitsCache(a.id, entry(`2026-0${month}-01T00:00:00.000Z`)))
  );
  const rows = await db().query("SELECT 1 FROM connection_limits_cache WHERE connection_id = $1", [a.id]);
  assert.equal(rows.length, 1);

  await deleteProviderLimitsCache(a.id);
  assert.equal(await getProviderLimitsCache(a.id), null);
  assert.equal(await getProviderLimitsCache(b.id) !== null, true);

  // Removing the connection cascades to its cache row.
  await providers.deleteProviderConnection(b.id);
  assert.equal(await getProviderLimitsCache(b.id), null);
});

// ───────────────────────── provider stats ─────────────────────────

test("provider stats aggregate call_logs for live providers and keyless ones only", async () => {
  await providers.createProviderNode({ id: "openai-compatible-stat", type: "openai-compatible", name: "Stat Node" });
  await apiKeyConnection("openai-compatible-stat", "stat-conn");
  await apiKeyConnection("claude", "stat-claude");

  const insert = (id: string, provider: string, model: string, status: number, duration: number, tin: number, tout: number, ts: Date) =>
    db().execute(
      `INSERT INTO call_logs (id, "timestamp", provider, model, status, duration, tokens_in, tokens_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ts.toISOString(), provider, model, status, duration, tin, tout]
    );
  const now = new Date();
  await insert("c1", "openai-compatible-stat", "m1", 200, 100, 10, 20, now);
  await insert("c2", "openai-compatible-stat", "m1", 500, 300, 5, 5, now);
  await insert("c3", "claude", "m2", 200, 50, 1, 2, now);
  await insert("c4", "ghost-provider", "m3", 200, 50, 1, 2, now);
  await insert("c5", "claude", "m2", 200, 50, 1, 2, new Date(now.getTime() - 30 * 86_400_000));

  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const stats = await getProviderCallStats(since);
  assert.deepEqual(stats.map((s) => s.provider), ["openai-compatible-stat", "claude"]);
  assert.equal(stats[0].nodeName, "Stat Node");
  assert.equal(stats[0].totalRequests, 2);
  assert.equal(stats[0].successfulRequests, 1);
  assert.equal(stats[0].avgLatencyMs, 200);
  assert.equal(stats[0].totalTokensIn, 15);
  assert.equal(stats[0].totalTokensOut, 25);
  assert.equal(stats[1].nodeName, null);

  const models = await getModelCallStats(since);
  assert.deepEqual(models.map((m) => `${m.provider}/${m.model}`), ["claude/m2", "openai-compatible-stat/m1"]);
  assert.equal(models[1].requests, 2);
});

// ───────────────────────── review fixes ─────────────────────────

test("concurrent creates of the same api key or oauth account leave one row", async () => {
  const keyed = await Promise.all(
    Array.from({ length: 6 }, () =>
      providers.createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "same",
        apiKey: "sk-same-key",
      })
    )
  );
  assert.equal(new Set(keyed.map((c) => (c as Row).id)).size, 1);
  assert.equal(await providers.getProviderConnectionsCount({ provider: "openai" }), 1);

  await Promise.all(
    Array.from({ length: 4 }, () =>
      providers.createProviderConnection({
        provider: "claude",
        authType: "oauth",
        email: "dev@example.com",
        accessToken: "tok",
      })
    )
  );
  assert.equal(await providers.getProviderConnectionsCount({ provider: "claude" }), 1);
});

test("a re-create merging into an existing row does not lose a concurrent update", async () => {
  const first = await apiKeyConnection("openai", "keep");
  await Promise.all([
    providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "keep",
      apiKey: "sk-keep",
      group: "g1",
    }),
    providers.updateProviderConnection(first.id, { defaultModel: "gpt-x" }),
  ]);
  const row = (await providers.getProviderConnectionById(first.id)) as Row;
  assert.equal(await providers.getProviderConnectionsCount({ provider: "openai" }), 1);
  assert.equal(row.group, "g1");
  assert.equal(row.defaultModel, "gpt-x");
});

test("a reused node prefix raises a typed conflict on create and update", async () => {
  await providers.createProviderNode({ id: "pn-1", type: "openai-compatible", name: "A", prefix: "Zed" });
  await assert.rejects(
    () => providers.createProviderNode({ id: "pn-2", type: "openai-compatible", name: "B", prefix: "zed " }),
    (err: unknown) => isProviderNodePrefixConflictError(err)
  );
  await providers.createProviderNode({ id: "pn-3", type: "openai-compatible", name: "C", prefix: "other" });
  await assert.rejects(
    () => providers.updateProviderNode("pn-3", { prefix: "ZED" }),
    (err: unknown) => isProviderNodePrefixConflictError(err)
  );
  assert.equal(((await providers.getProviderNodeById("pn-3")) as Row).prefix, "other");
});

test("U+0000 from upstream text is stripped instead of failing the write", async () => {
  const conn = await apiKeyConnection("openai", "nul");
  await providers.updateProviderConnection(conn.id, { lastError: "bad\u0000byte" });
  await providers.updateProviderConnection(conn.id, { providerSpecificData: { x: "a\u0000b" } });
  await mergeConnectionProviderSpecificData(conn.id, { y: "a\u0000b" });
  const row = (await providers.getProviderConnectionById(conn.id)) as Row;
  assert.equal(row.lastError, "badbyte");
  assert.equal(row.providerSpecificData.x, "ab");
  assert.equal(row.providerSpecificData.y, "ab");

  await setProviderLimitsCache(conn.id, {
    quotas: { a: "x\u0000y" },
    plan: null,
    message: null,
    fetchedAt: new Date().toISOString(),
  });
  assert.deepEqual((await getProviderLimitsCache(conn.id))?.quotas, { a: "xy" });
});
