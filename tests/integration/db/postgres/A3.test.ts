import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../../../../src/lib/db/pg.ts";
import { truncateAll } from "../../../helpers/postgres.ts";
import * as freeProxies from "../../../../src/lib/db/freeProxies.ts";
import * as proxies from "../../../../src/lib/db/proxies.ts";
import * as oneproxy from "../../../../src/lib/db/oneproxy.ts";
import * as upstream from "../../../../src/lib/db/upstreamProxy.ts";
import * as operatorEgress from "../../../../src/lib/db/proxyOperatorEgress.ts";
import * as guards from "../../../../src/lib/db/proxies/guards.ts";
import * as rotation from "../../../../src/lib/db/proxies/rotation.ts";
import * as subs from "../../../../src/lib/proxySubscription/subscriptionService.ts";
import { removeStaleSubscriptionNodes } from "../../../../src/lib/proxySubscription/staleNodes.ts";
import { readControlSecret } from "../../../../src/lib/proxySubscription/reloadSecret.ts";
import { resolveSelectorAllowlist } from "../../../../src/lib/proxySubscription/selectorGuard.ts";
import { maybeSwitchOnSetAside } from "../../../../src/lib/proxySubscription/selectorTrigger.ts";
import { encrypt } from "../../../../src/lib/db/encryption.ts";

type Row = Record<string, any>;

beforeEach(async () => {
  await truncateAll(db());
  rotation.__resetHotEgressCacheForTesting();
});

async function manualProxy(host: string, extra: Partial<Parameters<typeof proxies.createProxy>[0]> = {}) {
  return (await proxies.createProxy({
    name: `p-${host}`,
    type: "http",
    host,
    port: 8080,
    username: "u",
    password: "secret",
    ...extra,
  })) as Row;
}

// ───────────────────────── free_proxies ─────────────────────────

test("free proxies: upsert, list filters, stats, prune and clear", async () => {
  const item = (host: string, quality: number) => ({
    source: "1proxy" as const,
    host,
    port: 3128,
    type: "http" as const,
    countryCode: "DE",
    qualityScore: quality,
    latencyMs: 100 + quality,
    anonymity: "elite",
    lastValidated: null,
  });

  const created = await freeProxies.upsertFreeProxy(item("a.example", 50));
  assert.equal(created.action, "created");
  const updated = await freeProxies.upsertFreeProxy({ ...item("a.example", 70), type: "socks5" });
  assert.equal(updated.action, "updated");
  assert.equal(updated.id, created.id);

  await freeProxies.upsertFreeProxy(item("b.example", 90));
  await freeProxies.upsertFreeProxy({ ...item("c.example", 10), countryCode: null, qualityScore: null });

  const byQuality = await freeProxies.listFreeProxies();
  assert.deepEqual(
    byQuality.map((p) => p.host),
    ["b.example", "a.example", "c.example"],
    "NULL quality sorts last"
  );
  assert.equal((await freeProxies.getFreeProxyById(created.id))?.type, "socks5");
  assert.equal(await freeProxies.countFreeProxies({ protocol: "http" }), 2);
  assert.equal((await freeProxies.listFreeProxies({ search: "B.EXA" })).length, 1);
  assert.equal((await freeProxies.listFreeProxies({ minQuality: 60, country: "de" })).length, 2);
  assert.equal(
    (await freeProxies.listFreeProxiesBySource("1proxy", { limit: 1 })).length,
    1
  );
  assert.equal((await freeProxies.listFreeProxies({ sortBy: "latency", limit: 1, offset: 1 })).length, 1);

  // Promote one into the registry: it becomes "in pool".
  const poolId = await freeProxies.promoteFreeProxyToPool(created.id, {
    name: "promoted",
    type: "socks5",
    host: "a.example",
    port: 3128,
    source: "free-1proxy",
  });
  assert.ok(poolId);
  const promoted = await freeProxies.getFreeProxyById(created.id);
  assert.equal(promoted?.inPool, true);
  assert.equal(promoted?.poolProxyId, poolId);
  assert.equal(await freeProxies.promoteFreeProxyToPool("missing", {
    name: "x", type: "http", host: "x", port: 1, source: "s",
  }), null);
  assert.equal(await freeProxies.countFreeProxies({ onlyInPool: true }), 1);
  assert.equal(await freeProxies.countFreeProxies({ onlyNotInPool: true }), 2);

  // Prune keeps pooled rows; clear removes only the not-pooled ones.
  const pruned = await freeProxies.pruneStaleFreeProxies("1proxy", new Set(["b.example:3128"]));
  assert.equal(pruned, 1, "c.example is stale, a.example is pooled");
  assert.equal(await freeProxies.clearFreeProxiesBySource("1proxy"), 1);
  assert.equal(await freeProxies.countFreeProxies(), 1);

  // Deleting the registry row clears the link (FK SET NULL) instead of failing.
  await proxies.deleteProxyById(poolId as string);
  assert.equal((await freeProxies.getFreeProxyById(created.id))?.inPool, false);
  assert.equal(await freeProxies.deleteFreeProxy(created.id), true);
  assert.equal(await freeProxies.deleteFreeProxy(created.id), false);
});

test("free proxies: concurrent upserts of one key give one row; concurrent promotion one registry row", async () => {
  const item = {
    source: "proxifly" as const,
    host: "race.example",
    port: 80,
    type: "http" as const,
    countryCode: null,
    qualityScore: 1,
    latencyMs: 1,
    anonymity: null,
    lastValidated: null,
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => freeProxies.upsertFreeProxy(item)));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(results.filter((r) => r.action === "created").length, 1);
  assert.equal(await freeProxies.countFreeProxies(), 1);

  const payload = { name: "r", type: "http", host: "race.example", port: 80, source: "free" };
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => freeProxies.promoteFreeProxyToPool(results[0].id, payload))
  );
  assert.equal(new Set(ids).size, 1);
  const { total } = await proxies.listProxies();
  assert.equal(total, 1);
});

test("free proxies: sync timestamp and per-source errors", async () => {
  const empty = await freeProxies.getFreeProxyStats();
  assert.equal(empty.total, 0);
  assert.equal(empty.lastSyncAt, null);

  await freeProxies.upsertFreeProxy({
    source: "iplocate",
    host: "s.example",
    port: 1,
    type: "http",
    countryCode: null,
    qualityScore: 40,
    latencyMs: null,
    anonymity: null,
    lastValidated: "2026-01-02T03:04:05.000Z",
  });
  let stats = await freeProxies.getFreeProxyStats();
  assert.equal(stats.total, 1);
  assert.equal(stats.avgQuality, 40);
  assert.equal(stats.lastSyncAt, "2026-01-02T03:04:05.000Z", "derived from last_validated");
  assert.deepEqual(stats.bySource, [{ source: "iplocate", count: 1 }]);

  const at = await freeProxies.recordFreeProxySync("2026-02-03T00:00:00.000Z");
  assert.equal(at, "2026-02-03T00:00:00.000Z");
  stats = await freeProxies.getFreeProxyStats();
  assert.equal(stats.lastSyncAt, "2026-02-03T00:00:00.000Z");
  const raw = await db().queryOne<{ value: string }>(
    "SELECT value #>> '{}' AS value FROM config_entries WHERE namespace = 'job_state' AND key = 'free_proxies.last_sync_at'"
  );
  assert.equal(raw?.value, "2026-02-03T00:00:00.000Z");

  await freeProxies.recordFreeProxySyncErrors("iplocate", ["boom", "bang"]);
  await freeProxies.recordFreeProxySyncErrors("iplocate", ["only"]);
  await freeProxies.recordFreeProxySyncErrors("1proxy", []);
  assert.deepEqual(await freeProxies.getFreeProxySyncErrors(), { iplocate: ["only"], "1proxy": [] });
  await freeProxies.clearFreeProxySyncErrors("iplocate");
  assert.deepEqual(await freeProxies.getFreeProxySyncErrors(), { "1proxy": [] });
});

// ───────────────────────── proxy_registry / assignments ─────────────────────────

test("registry: create, read, redact, update, upsert identity, delete", async () => {
  const created = await manualProxy("one.example");
  assert.equal(created.username, "***");
  const withSecrets = await proxies.getProxyById(created.id, { includeSecrets: true });
  assert.equal(withSecrets?.username, "u");
  assert.equal(withSecrets?.password, "secret");
  assert.equal(withSecrets?.family, "auto");
  assert.equal(typeof withSecrets?.createdAt, "string");

  const updated = await proxies.updateProxy(created.id, { name: "renamed", region: "eu" });
  assert.equal(updated?.name, "renamed");
  assert.equal(
    (await proxies.getProxyById(created.id, { includeSecrets: true }))?.password,
    "secret",
    "omitted credentials are preserved"
  );
  assert.equal(await proxies.updateProxy("missing", { name: "x" }), null);
  await assert.rejects(
    () => proxies.updateProxy(created.id, { subscriptionId: "no-such-sub" }),
    (error: Row) => error.status === 404
  );

  // upsert by (host, port, username): second call updates, new username creates.
  const again = await proxies.upsertProxy({ name: "n2", host: "one.example", port: 8080, username: "u" });
  assert.equal(again.action, "updated");
  assert.equal(again.proxy?.id, created.id);
  const other = await proxies.upsertProxy({ name: "n3", host: "one.example", port: 8080, username: "v" });
  assert.equal(other.action, "created");

  const list = await proxies.listProxies({ limit: 1 });
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 1);

  assert.equal(await proxies.deleteProxyById(other.proxy!.id), true);
  assert.equal(await proxies.deleteProxyById(other.proxy!.id), false);
});

test("registry: concurrent upserts of one identity give one row", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      proxies.upsertProxy({ name: `n${i}`, host: "same.example", port: 9000, username: "z" })
    )
  );
  assert.equal(results.filter((r) => r.action === "created").length, 1);
  assert.equal(new Set(results.map((r) => r.proxy?.id)).size, 1);
  assert.equal((await proxies.listProxies()).total, 1);
});

test("assignments: replace semantics, pools, rotation strategy, where-used, delete", async () => {
  const a = await manualProxy("a.example");
  const b = await manualProxy("b.example");
  const c = await manualProxy("c.example");

  const single = await proxies.assignProxyToScope("provider", "openai", a.id);
  assert.equal(single?.proxyId, a.id);
  assert.equal(single?.scopeId, "openai");
  await proxies.assignProxyToScope("provider", "openai", b.id);
  assert.equal((await proxies.getScopeProxyPool("provider", "openai")).length, 1, "assign replaces");

  await assert.rejects(() => proxies.assignProxyToScope("provider", null, a.id), /scopeId is required/);
  await assert.rejects(() => proxies.assignProxyToScope("provider", "openai", "missing"), /not found/);

  const global = await proxies.assignProxyToScope("global", null, a.id);
  assert.equal(global?.scope, "global");
  assert.equal(global?.scopeId, null);

  // Pool building: idempotent add, appended positions, batch add.
  await proxies.addProxyToScopePool("provider", "openai", a.id);
  await proxies.addProxyToScopePool("provider", "openai", a.id);
  const added = await proxies.addProxiesToScopePool("provider", "openai", [c.id, a.id, c.id]);
  assert.equal(added, 1);
  const pool = await proxies.getScopeProxyPool("provider", "openai");
  assert.deepEqual(pool.map((p) => p.proxyId), [b.id, a.id, c.id]);
  assert.deepEqual(pool.map((p) => p.position), [0, 1, 2]);

  assert.equal(await proxies.removeProxyFromScopePool("provider", "openai", a.id), true);
  assert.equal(await proxies.removeProxyFromScopePool("provider", "openai", a.id), false);

  assert.equal(await proxies.getScopeRotationStrategy("provider", "openai"), "round-robin");
  assert.equal(await proxies.setScopeRotationStrategy("provider", "openai", "sticky", { stickyWindowMinutes: 5 }), "sticky");
  assert.equal(await proxies.setScopeRotationStrategy("provider", "openai", "nonsense"), "round-robin");
  assert.equal(await proxies.getScopeRotationStrategy("provider", "openai"), "round-robin");

  const where = await proxies.getProxyWhereUsed(b.id);
  assert.equal(where.assignmentCount, 1);
  await assert.rejects(
    () => proxies.deleteProxyById(b.id),
    (error: Row) => error.status === 409 && error.code === "proxy_in_use"
  );
  assert.equal(await proxies.deleteProxyById(b.id, { force: true }), true);

  assert.equal((await proxies.getProxyAssignments({ scope: "global" })).length, 1);
  assert.equal((await proxies.getProxyAssignments({ proxyId: c.id })).length, 1);
  assert.ok((await proxies.getProxyAssignments()).length >= 2);

  // Unassign clears the pool and its rotation row.
  assert.equal(await proxies.assignProxyToScope("provider", "openai", null), null);
  assert.equal((await proxies.getScopeProxyPool("provider", "openai")).length, 0);
  const left = await db().queryOne("SELECT 1 AS one FROM proxy_scope_rotation WHERE scope = 'provider'");
  assert.equal(left, undefined);

  const bulk = await proxies.bulkAssignProxyToScope("provider", ["p1", "p2", "p1"], a.id);
  assert.equal(bulk.updated, 2);
  assert.equal(bulk.failed.length, 0);
});

test("assignments: concurrent batch adds never duplicate a member", async () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await manualProxy(`h${i}.example`)).id);
  const counts = await Promise.all([
    proxies.addProxiesToScopePool("global", null, ids),
    proxies.addProxiesToScopePool("global", null, ids.slice(2)),
    proxies.addProxiesToScopePool("global", null, ids.slice(0, 4)),
  ]);
  assert.equal(counts.reduce((sum, n) => sum + n, 0), 6, "each member inserted exactly once");
  assert.equal((await proxies.getScopeProxyPool("global")).length, 6);
});

test("registry: create-and-assign clears the legacy proxy config in the same transaction", async () => {
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES
       ('proxyConfig', 'global', '{"host":"legacy","port":1}'::jsonb),
       ('proxyConfig', 'providers', '{"openai":{"host":"x","port":2},"claude":{"host":"y","port":3}}'::jsonb)`
  );
  const first = await proxies.createProxyAndAssign(
    { name: "g", type: "http", host: "g.example", port: 1 },
    { scope: "global" }
  );
  assert.equal(first.assignment?.scope, "global");
  const global = await db().queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace = 'proxyConfig' AND key = 'global'"
  );
  assert.equal(global?.value, null, "legacy global is nulled");

  const second = await proxies.createProxyAndAssign(
    { name: "o", type: "http", host: "o.example", port: 2 },
    { scope: "provider", scopeId: "openai" }
  );
  assert.equal(second.assignment?.scopeId, "openai");
  const map = await db().queryOne<{ value: Row }>(
    "SELECT value FROM config_entries WHERE namespace = 'proxyConfig' AND key = 'providers'"
  );
  assert.deepEqual(Object.keys(map?.value ?? {}), ["claude"]);

  const moved = await proxies.updateProxyAndAssign(
    second.proxy.id,
    { name: "o2" },
    { scope: "provider", scopeId: "claude" }
  );
  assert.equal(moved?.proxy.name, "o2");
  assert.equal(moved?.assignment?.scopeId, "claude");
  assert.equal(
    await proxies.updateProxyAndAssign("missing", {}, { scope: "global" }),
    null
  );
  // The failed transaction left nothing behind.
  await assert.rejects(() =>
    proxies.createProxyAndAssign(
      { name: "bad", type: "http", host: "bad.example", port: 3 },
      { scope: "provider", scopeId: "" }
    )
  );
  assert.equal(
    (await db().queryOne<{ n: number }>("SELECT count(*) AS n FROM proxy_registry WHERE host = 'bad.example'"))?.n,
    0
  );
});

test("legacy proxy config migrates into the registry", async () => {
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES
       ('proxyConfig', 'global', '"http://user:pw@legacy.example:3128"'::jsonb),
       ('proxyConfig', 'providers', '{"openai":{"host":"p.example","port":8081,"type":"socks5"}}'::jsonb)`
  );
  const result = await proxies.migrateLegacyProxyConfigToRegistry();
  assert.equal(result.migrated, 2);
  assert.equal((await proxies.listProxies()).total, 2);
  const again = await proxies.migrateLegacyProxyConfigToRegistry();
  assert.equal(again.skipped, true);
});

// ───────────────────────── guards and resolution ─────────────────────────

test("guards: dead assigned pool blocks, proxy toggles allow direct egress", async () => {
  const dead = await manualProxy("dead.example", { status: "dead" });
  await proxies.assignProxyToScope("provider", "openai", dead.id);
  assert.equal(await guards.hasBlockingProxyAssignmentForProvider("openai"), true);
  assert.equal(await guards.hasBlockingProxyAssignment("conn-1", "openai"), true);
  assert.equal(await guards.hasBlockingProxyAssignment("conn-1", "claude", null), false);

  // A combo-scoped dead pool blocks too.
  await proxies.assignProxyToScope("combo", "my-combo", dead.id);
  assert.equal(await guards.hasBlockingProxyAssignment("conn-1", "claude", "my-combo"), true);

  const alive = await manualProxy("alive.example");
  await proxies.addProxyToScopePool("provider", "openai", alive.id);
  assert.equal(
    await guards.hasBlockingProxyAssignmentForProvider("openai"),
    false,
    "an alive member lifts the provider guard"
  );
  assert.equal(await guards.hasBlockingProxyAssignment("conn-1", "openai"), true);
});

test("guards: alive pool does not block; global toggle and connection toggle bypass", async () => {
  const dead = await manualProxy("dead2.example", { status: "error" });
  const alive = await manualProxy("alive2.example");
  await proxies.assignProxyToScope("provider", "claude", alive.id);
  assert.equal(await guards.hasBlockingProxyAssignmentForProvider("claude"), false);

  await proxies.assignProxyToScope("provider", "gemini", dead.id);
  assert.equal(await guards.hasBlockingProxyAssignmentForProvider("gemini"), true);

  await db().execute(
    `INSERT INTO provider_connections (id, provider, auth_type, name, proxy_enabled) VALUES ('c-off', 'gemini', 'apikey', 'off', false)`
  );
  assert.equal(await guards.hasBlockingProxyAssignment("c-off"), false);

  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('settings', 'proxyEnabled', 'false'::jsonb)`
  );
  assert.equal(await guards.isGlobalProxyEnabled(), false);
  assert.equal(await guards.hasBlockingProxyAssignmentForProvider("gemini"), false);
});

test("rotation: round-robin cycles, concurrent picks are distinct, sticky holds, random stays in pool", async () => {
  const members = [];
  for (let i = 0; i < 3; i++) members.push(await manualProxy(`rr${i}.example`));
  for (const m of members) await proxies.addProxyToScopePool("provider", "rr", m.id);

  const host = async () =>
    (await proxies.resolveProxyForScopeFromRegistry("provider", "rr"))?.proxy.host as string;
  const sequence = [await host(), await host(), await host(), await host()];
  assert.deepEqual(sequence, ["rr0.example", "rr1.example", "rr2.example", "rr0.example"]);

  // Concurrent picks claim distinct cursor values (atomic fetch-and-add).
  await db().execute("UPDATE proxy_scope_rotation SET cursor = 0 WHERE scope = 'provider'");
  const picked = await Promise.all([host(), host(), host()]);
  assert.equal(new Set(picked).size, 3, `concurrent picks differ: ${picked.join(",")}`);
  const cursor = await db().queryOne<{ cursor: number }>(
    "SELECT cursor FROM proxy_scope_rotation WHERE scope = 'provider' AND scope_id = 'rr'"
  );
  assert.equal(cursor?.cursor, 3);

  await proxies.setScopeRotationStrategy("provider", "rr", "sticky", { stickyWindowMinutes: 60 });
  const first = await host();
  const second = await host();
  const third = await host();
  assert.equal(second, first, "held within the window");
  assert.equal(third, first);

  // Expired window: concurrent pickers advance the cursor exactly once.
  await db().execute(
    "UPDATE proxy_scope_rotation SET rotated_at = now() - interval '2 hours' WHERE scope = 'provider' AND scope_id = 'rr'"
  );
  const before = (await db().queryOne<{ cursor: number }>(
    "SELECT cursor FROM proxy_scope_rotation WHERE scope = 'provider' AND scope_id = 'rr'"
  ))!.cursor;
  const after = await Promise.all([host(), host(), host(), host()]);
  assert.equal(new Set(after).size, 1, "all pickers agree on the new member");
  const advanced = (await db().queryOne<{ cursor: number }>(
    "SELECT cursor FROM proxy_scope_rotation WHERE scope = 'provider' AND scope_id = 'rr'"
  ))!.cursor;
  assert.equal(advanced, before + 1);

  await proxies.setScopeRotationStrategy("provider", "rr", "random");
  const names = new Set(members.map((m) => m.host));
  for (let i = 0; i < 5; i++) assert.ok(names.has(await host()));

  await proxies.setScopeRotationStrategy("provider", "rr", "latency");
  assert.ok(names.has(await host()));
});

test("rotation: connection resolution falls from account to provider to global; dead members are skipped", async () => {
  const p = await manualProxy("prov.example");
  const g = await manualProxy("glob.example");
  const dead = await manualProxy("deadmember.example", { status: "dead" });
  await db().execute(
    `INSERT INTO provider_connections (id, provider, auth_type, name) VALUES ('conn-9', 'openai', 'apikey', 'c9')`
  );
  await proxies.assignProxyToScope("global", null, g.id);
  assert.equal((await proxies.resolveProxyForConnectionFromRegistry("conn-9"))?.proxy.host, "glob.example");
  await proxies.assignProxyToScope("provider", "openai", p.id);
  assert.equal((await proxies.resolveProxyForConnectionFromRegistry("conn-9"))?.proxy.host, "prov.example");
  assert.equal((await proxies.resolveProxyForProvider("openai"))?.host, "prov.example");
  await proxies.assignProxyToScope("account", "conn-9", dead.id);
  assert.equal(
    (await proxies.resolveProxyForConnectionFromRegistry("conn-9"))?.proxy.host,
    "prov.example",
    "a dead account pool is skipped for resolution"
  );
  const rows = await proxies.getScopePoolEgressRows("provider", "openai");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, "prov.example");
  assert.equal((await proxies.getScopePoolEgressRows("global", null)).length, 1);
  assert.equal((await proxies.resolveProxyForScopeFromRegistry("provider", "unknown")), null);
});

test("health stats and provider upstream summary read proxy_logs", async () => {
  const p = await manualProxy("health.example");
  const now = new Date();
  const insertLog = (id: string, status: string, upstream: number | null, target: string) =>
    db().execute(
      `INSERT INTO proxy_logs (id, "timestamp", status, proxy_type, proxy_host, proxy_port, provider, target_url, latency_ms, upstream_status)
       VALUES ($1, $2, $3, 'http', 'health.example', 8080, 'openai', $4, 120, $5)`,
      [id, now.toISOString(), status, target, upstream]
    );
  await insertLog("l1", "success", 200, "https://api.openai.com/v1/chat");
  await insertLog("l2", "error", 503, "https://api.openai.com/v1/chat");
  await insertLog("l3", "success", 200, "https://x/connection-test");

  const stats = await proxies.getProxyHealthStats({ hours: 1 });
  assert.equal(stats.length, 1);
  assert.equal(stats[0].proxyId, p.id);
  assert.equal(stats[0].totalRequests, 3);
  assert.equal(stats[0].connectionTests, 1);
  assert.equal(stats[0].realRequests, 2);
  assert.equal(stats[0].upstream5xx, 1);
  assert.equal(stats[0].avgLatencyMs, 120);
  assert.equal(typeof stats[0].lastSeenAt, "string");

  const summary = await proxies.getProviderUpstreamSummary(new Date(now.getTime() - 60_000).toISOString());
  assert.equal(summary.length, 1);
  assert.equal(summary[0].provider, "openai");
  assert.equal(summary[0].attempts, 2);
  assert.equal(summary[0].serverErrors, 1);
  assert.deepEqual(summary[0].exits, [{ exit: "health.example:8080", attempts: 2, serverErrors: 1 }]);
});

// ───────────────────────── oneproxy ─────────────────────────

test("oneproxy lists active registry rows of its source", async () => {
  await db().execute(
    `INSERT INTO proxy_registry (id, name, type, host, port, source, status, quality_score, country_code, google_access)
     VALUES ('o1', 'one', 'http', 'o1.example', 80, 'oneproxy', 'active', 90, 'US', true),
            ('o2', 'two', 'socks5', 'o2.example', 81, 'oneproxy', 'active', NULL, 'DE', false),
            ('o3', 'off', 'http', 'o3.example', 82, 'oneproxy', 'inactive', 95, 'US', false),
            ('o4', 'man', 'http', 'o4.example', 83, 'manual', 'active', 99, 'US', false)`
  );
  const all = await oneproxy.listOneproxyProxies();
  assert.deepEqual(all.map((p) => p.id), ["o1", "o2"], "NULL quality last, inactive and manual excluded");
  assert.equal(all[0].googleAccess, true);
  assert.equal(all[0].countryCode, "US");
  assert.equal((await oneproxy.listOneproxyProxies({ protocol: "socks5" })).length, 1);
  assert.equal((await oneproxy.listOneproxyProxies({ minQuality: 50, limit: 5 })).length, 1);
  assert.equal((await oneproxy.listOneproxyProxies({ countryCode: "DE" })).length, 1);
});

// ───────────────────────── proxy_operator_egress ─────────────────────────

test("operator egress: upsert keeps the freshest timestamp, rejects bad rows, reads fresh rows", async () => {
  await manualProxy("egress.example");
  const t1 = new Date(Date.now() - 2 * 60_000).toISOString();
  const t2 = new Date(Date.now() - 60_000).toISOString();

  const r1 = await operatorEgress.upsertOperatorEgress([
    { host: "Egress.Example", port: 8080, addresses: ["203.0.113.7", "not-an-ip"], observedAt: t2 },
    { host: "unknown.example", port: 1, addresses: ["198.51.100.1"], observedAt: t2 },
    { host: "", port: 1, addresses: ["198.51.100.2"], observedAt: t2 },
    { host: "egress.example", port: 8080, addresses: ["198.51.100.9"], observedAt: "garbage" },
  ]);
  assert.equal(r1.stored, 2);
  assert.equal(r1.ignored, 1);
  assert.deepEqual(r1.rejected.map((r) => r.reason).sort(), [
    "invalid-member",
    "invalid-observed-at",
    "unusable-address",
  ]);

  // An older push for the same address does not rewind the timestamp.
  await operatorEgress.upsertOperatorEgress([
    { host: "egress.example", port: 8080, addresses: ["203.0.113.7"], observedAt: t1 },
  ]);
  const read = await operatorEgress.readOperatorEgressForMember("egress.example", 8080);
  assert.deepEqual([...read.addresses], ["203.0.113.7"]);
  assert.equal(read.freshest?.at, t2);

  assert.equal(await operatorEgress.isKnownProxyMember("EGRESS.example", 8080), true);
  assert.equal(await operatorEgress.isKnownProxyMember("nope.example", 8080), false);
  const none = await operatorEgress.readOperatorEgressForMember("nope.example", 1);
  assert.equal(none.addresses.size, 0);
  assert.equal(none.freshest, null);
});

test("operator egress: per-member cap evicts the oldest and concurrent pushes stay consistent", async () => {
  const base = Date.now() - 3_600_000;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    host: "cap.example",
    port: 443,
    addresses: [`203.0.113.${i + 1}`],
    observedAt: new Date(base + i * 1000).toISOString(),
  }));
  const result = await operatorEgress.upsertOperatorEgress(rows);
  assert.equal(result.stored, 12);
  const evicted = result.rejected.filter((r) => r.reason === "cap-evicted");
  assert.deepEqual(evicted.map((r) => r.address).sort(), ["203.0.113.1", "203.0.113.2"]);
  const stored = await db().query("SELECT address FROM proxy_operator_egress WHERE host = 'cap.example'");
  assert.equal(stored.length, 10);

  const pushes = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      operatorEgress.upsertOperatorEgress([
        { host: "race.example", port: 80, addresses: [`198.51.100.${i + 1}`, "198.51.100.200"], observedAt: new Date().toISOString() },
      ])
    )
  );
  assert.equal(pushes.reduce((n, r) => n + r.stored, 0), 12);
  const raced = await db().query("SELECT address FROM proxy_operator_egress WHERE host = 'race.example'");
  assert.equal(raced.length, 7, "six distinct addresses plus the shared one");
});

// ───────────────────────── upstream_proxy_config ─────────────────────────

test("upstream proxy config: upsert, update, list by mode, fallback chain, delete", async () => {
  assert.equal(await upstream.getUpstreamProxyConfig("openai"), null);

  const created = await upstream.upsertUpstreamProxyConfig({
    providerId: "openai",
    mode: "cliproxyapi",
    cliproxyapiModelMapping: { "gpt-5": "x/gpt-5" },
    cliproxyapiPriority: 5,
  });
  assert.equal(created?.mode, "cliproxyapi");
  assert.deepEqual(created?.cliproxyapiModelMapping, { "gpt-5": "x/gpt-5" });
  assert.equal(created?.enabled, true);
  assert.equal(created?.nativePriority, 1);
  assert.equal(created?.fallbackBackend, "cliproxyapi");
  assert.equal(typeof created?.createdAt, "string");

  const replaced = await upstream.upsertUpstreamProxyConfig({
    providerId: "openai",
    mode: "fallback",
    fallbackBackend: "dario",
    enabled: false,
  });
  assert.equal(replaced?.mode, "fallback");
  assert.equal(replaced?.cliproxyapiModelMapping, null);
  assert.equal(replaced?.enabled, false);
  assert.equal(replaced?.fallbackBackend, "dario");

  await upstream.upsertUpstreamProxyConfig({ providerId: "claude", mode: "fallback" });
  assert.deepEqual((await upstream.getProvidersByMode("fallback")).map((c) => c.providerId), ["claude"]);

  const patched = await upstream.updateUpstreamProxyConfig("openai", {
    enabled: true,
    cliproxyapiModelMapping: null,
    family: "ipv4",
    nativePriority: 7,
  });
  assert.equal(patched?.enabled, true);
  assert.equal(patched?.family, "ipv4");
  assert.equal(patched?.nativePriority, 7);
  await assert.rejects(() => upstream.updateUpstreamProxyConfig("nope", { mode: "native" }), /not found/);

  assert.deepEqual(await upstream.getFallbackChainForProvider("openai"), [
    { executor: "dario", priority: 2 },
    { executor: "native", priority: 7 },
  ]);
  assert.deepEqual(await upstream.getFallbackChainForProvider("none"), []);

  assert.equal(await upstream.deleteUpstreamProxyConfig("openai"), true);
  assert.equal(await upstream.deleteUpstreamProxyConfig("openai"), false);
  assert.equal(upstream.validateProxyUrl("http://example.com").valid, true);
});

// ───────────────────────── proxy_subscriptions ─────────────────────────

const FEED = "https://subscription.example.invalid/feed";

test("subscriptions: create, read, update, list, delete", async () => {
  const created = await subs.createSubscription({
    name: "Sub A",
    url: FEED,
    mirrorUrls: ["https://mirror.example.invalid/feed"],
    enabled: false,
    mode: "rule",
    ruleProviders: ["openai", "claude"],
    controlUrl: "http://127.0.0.1:9090",
    controlSecret: "hunter2",
    selectorMinGapSeconds: 30,
  });
  assert.equal(created.status, "empty");
  assert.equal(created.enabled, false);
  assert.equal(created.mode, "rule");
  assert.deepEqual(created.ruleProviders, ["openai", "claude"]);
  assert.deepEqual(created.mirrorUrls, ["https://mirror.example.invalid/feed"]);
  assert.equal(created.hasControlSecret, true);
  assert.equal(created.selectorMinGapSeconds, 30);
  assert.equal(created.lastNodes, null);
  assert.equal(created.createdAt.length > 0, true);

  const secret = await readControlSecret(created.id);
  assert.equal(secret, "hunter2");
  assert.equal(await readControlSecret("missing"), null);

  const updated = await subs.updateSubscription(created.id, {
    name: "Sub A2",
    ruleProviders: null,
    mode: "global",
    mirrorUrls: null,
  });
  assert.equal(updated?.name, "Sub A2");
  assert.equal(updated?.ruleProviders, null);
  assert.equal(updated?.mode, "global");
  assert.deepEqual(updated?.mirrorUrls, []);
  assert.equal(updated?.hasControlSecret, true, "an absent secret is preserved");
  assert.equal(await subs.updateSubscription("missing", { name: "x" }), null);

  await subs.createSubscription({ name: "Sub B", url: `${FEED}-b`, enabled: false });
  assert.equal((await subs.listSubscriptions()).length, 2);
  assert.equal((await subs.getSubscriptionById(created.id))?.name, "Sub A2");

  assert.equal(await subs.deleteSubscription(created.id), true);
  assert.equal(await subs.deleteSubscription(created.id), false);
  assert.equal(await subs.getSubscriptionById(created.id), null);
});

test("subscriptions: apply/unapply bind the pool and recompute proxyEnabled; stale nodes are removed", async () => {
  const sub = await subs.createSubscription({ name: "Pool", url: FEED, enabled: false });
  await db().execute("UPDATE proxy_subscriptions SET enabled = true WHERE id = $1", [sub.id]);

  const keep = await proxies.upsertProxy(
    { name: "k", host: "keep.example", port: 1080, source: "subscription", subscriptionId: sub.id },
    { claimOwnership: true }
  );
  const drop = await proxies.upsertProxy(
    { name: "d", host: "drop.example", port: 1080, source: "subscription", subscriptionId: sub.id },
    { claimOwnership: true }
  );
  const manual = await manualProxy("manual.example", { subscriptionId: sub.id });

  // Sync-style upsert never takes over a row owned elsewhere.
  const skipped = await proxies.upsertProxy(
    { name: "m", host: "manual.example", port: 8080, username: "u", source: "subscription", subscriptionId: sub.id },
    { claimOwnership: false }
  );
  assert.equal(skipped.action, "skipped");

  await subs.applySubscription(sub.id);
  const pool = await proxies.getScopeProxyPool("global");
  assert.equal(pool.length, 3);
  const flag = await db().queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace = 'settings' AND key = 'proxyEnabled'"
  );
  assert.equal(flag?.value, true);

  await removeStaleSubscriptionNodes(db(), sub.id, [keep.proxy!.id]);
  assert.equal(await proxies.getProxyById(drop.proxy!.id), null, "synced row removed");
  assert.ok(await proxies.getProxyById(keep.proxy!.id));
  assert.ok(await proxies.getProxyById(manual.id), "manual attached row kept");

  // Unapply detaches the rows the sync wrote; the manual row stays bound.
  await subs.unapplySubscription(sub.id);
  const remaining = await proxies.getScopeProxyPool("global");
  assert.deepEqual(remaining.map((m) => m.proxyId), [manual.id]);
  await proxies.removeProxyFromScopePool("global", null, manual.id);
  await subs.unapplySubscription(sub.id);
  const off = await db().queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace = 'settings' AND key = 'proxyEnabled'"
  );
  assert.equal(off?.value, false);

  // Deleting the subscription deletes synced rows and detaches manual ones.
  await subs.deleteSubscription(sub.id);
  assert.equal(await proxies.getProxyById(keep.proxy!.id), null);
  assert.equal((await proxies.getProxyById(manual.id))?.subscriptionId, null);
});

test("subscriptions: switch outcomes merge per selector under concurrency and surface as a warning", async () => {
  const sub = await subs.createSubscription({
    name: "Sel",
    url: FEED,
    enabled: false,
    localCoreEndpoint: "socks5://127.0.0.1:1080 selector=group-a\nsocks5://127.0.0.1:1081 selector=group-b",
    controlUrl: "http://127.0.0.1:9090",
  });
  assert.equal(await subs.readStaleSwitchWarning(sub.id), null);

  await Promise.all([
    subs.recordSelectorSwitchOutcome({ subscriptionId: sub.id, selector: "group-a", result: "ok", member: "n1", kind: "ip_quota_429" }),
    subs.recordSelectorSwitchOutcome({ subscriptionId: sub.id, selector: "group-b", result: "ok", member: "n2", kind: "transport" }),
  ]);
  const after = await subs.getSubscriptionById(sub.id);
  assert.deepEqual(Object.keys(after?.selectorLastSwitchBySelector ?? {}).sort(), ["group-a", "group-b"]);
  assert.equal(after?.selectorLastSwitchBySelector?.["group-b"]?.member, "n2");
  assert.equal(after?.selectorLastSwitchResult, "ok");
  assert.equal(await subs.readStaleSwitchWarning(sub.id), null);

  await db().execute("UPDATE proxy_subscriptions SET status = 'ok' WHERE id = $1", [sub.id]);
  await subs.recordSelectorSwitchOutcome({ subscriptionId: sub.id, selector: "group-a", result: "network-error" });
  const failed = await subs.getSubscriptionById(sub.id);
  assert.match(failed?.error ?? "", /SELECTOR_SWITCH_FAILED/);
  assert.match((await subs.readStaleSwitchWarning(sub.id)) ?? "", /SELECTOR_SWITCH_FAILED/);

  // The trigger resolves nothing for an unknown key and a registry row for a known one.
  assert.equal((await maybeSwitchOnSetAside("http://@nowhere:1")).switched, false);
});

test("selector allow-list reads the feature_flags config entry", async () => {
  delete process.env.SELECTOR_CONTROL_ALLOWLIST;
  assert.deepEqual(await resolveSelectorAllowlist(), []);
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('feature_flags', 'SELECTOR_CONTROL_ALLOWLIST', to_jsonb($1::text))`,
    ["192.168.1.5, 10.0.0.9"]
  );
  assert.deepEqual(await resolveSelectorAllowlist(), ["192.168.1.5", "10.0.0.9"]);
});

test("control secrets round-trip through encryption", async () => {
  const sub = await subs.createSubscription({ name: "Sec", url: FEED, enabled: false });
  await db().execute("UPDATE proxy_subscriptions SET control_secret_enc = $1 WHERE id = $2", [
    encrypt("s3cr3t"),
    sub.id,
  ]);
  assert.equal(await readControlSecret(sub.id), "s3cr3t");
});

// ───────────────────────── review fixes ─────────────────────────

test("registry: password is stored as an envelope, read back as plaintext, never double-encrypted", async () => {
  const created = await manualProxy("enc.example", { password: "pw-1" });
  const raw = await db().queryOne<{ password: string }>(
    "SELECT password FROM proxy_registry WHERE id = $1",
    [created.id]
  );
  if (process.env.STORAGE_ENCRYPTION_KEY) {
    assert.ok(raw!.password.startsWith("enc:v1:"), "stored encrypted");
  }
  assert.equal((await proxies.getProxyById(created.id, { includeSecrets: true }))?.password, "pw-1");

  // A rename merges the decrypted password and re-encrypts it once.
  await proxies.updateProxy(created.id, { name: "enc-renamed" });
  assert.equal((await proxies.getProxyById(created.id, { includeSecrets: true }))?.password, "pw-1");
  await proxies.updateProxy(created.id, { password: "pw-2" });
  assert.equal((await proxies.getProxyById(created.id, { includeSecrets: true }))?.password, "pw-2");

  // A row the transfer already encrypted resolves to the plaintext for the dispatcher.
  await db().execute("UPDATE proxy_registry SET password = $1 WHERE id = $2", [
    encrypt("transferred"),
    created.id,
  ]);
  await proxies.addProxyToScopePool("provider", "enc", created.id);
  const resolved = await proxies.resolveProxyForScopeFromRegistry("provider", "enc");
  assert.equal(resolved?.proxy.password, "transferred");
});

test("U+0000 from upstream feeds is stripped at the write boundary", async () => {
  const proxy = await manualProxy("nul.example", { name: "a\u0000b", username: "u\u0000v" });
  assert.equal(proxy.name, "ab");
  const sub = await subs.createSubscription({ name: "s\u0000ub", url: `${FEED}-nul`, enabled: false });
  assert.equal(sub.name, "sub");
  const freeId = await freeProxies.upsertFreeProxy({
    source: "1proxy",
    host: "nul\u0000.example",
    port: 1,
    type: "http",
    countryCode: null,
    qualityScore: null,
    latencyMs: null,
    anonymity: "x\u0000y",
    lastValidated: null,
  });
  assert.equal(freeId.action, "created");
});

test("free proxies: fractional quality and latency are rounded, not rejected", async () => {
  await freeProxies.upsertFreeProxy({
    source: "1proxy",
    host: "frac.example",
    port: 1,
    type: "http",
    countryCode: null,
    qualityScore: 55.5,
    latencyMs: 120.7,
    anonymity: null,
    lastValidated: null,
  });
  const row = await db().queryOne<{ quality_score: number; latency_ms: number }>(
    "SELECT quality_score, latency_ms FROM free_proxies WHERE host = 'frac.example'"
  );
  assert.equal(row?.quality_score, 56);
  assert.equal(row?.latency_ms, 121);
});

test("rotation: the cursor wraps instead of overflowing int4", async () => {
  const members = [];
  for (let i = 0; i < 3; i++) members.push(await manualProxy(`wrap${i}.example`));
  for (const m of members) await proxies.addProxyToScopePool("provider", "wrap", m.id);
  await proxies.resolveProxyForScopeFromRegistry("provider", "wrap");
  await db().execute(
    "UPDATE proxy_scope_rotation SET cursor = 999999999 WHERE scope = 'provider' AND scope_id = 'wrap'"
  );
  const picked = await proxies.resolveProxyForScopeFromRegistry("provider", "wrap");
  assert.ok(picked, "pick at the wrap boundary succeeds");
  const row = await db().queryOne<{ cursor: number }>(
    "SELECT cursor FROM proxy_scope_rotation WHERE scope = 'provider' AND scope_id = 'wrap'"
  );
  assert.equal(row?.cursor, 0);
});

test("subscriptions and upstream config: out-of-range numbers are normalised, not 500s", async () => {
  const sub = await subs.createSubscription({
    name: "Interval",
    url: `${FEED}-int`,
    enabled: false,
    updateIntervalMinutes: 1.5,
  });
  assert.equal(sub.updateIntervalMinutes, 2);
  const patched = await subs.updateSubscription(sub.id, { updateIntervalMinutes: -3 });
  assert.equal(patched?.updateIntervalMinutes, 1);

  const cfg = await upstream.upsertUpstreamProxyConfig({
    providerId: "prio",
    nativePriority: 1.5,
    cliproxyapiPriority: 2.4,
  });
  assert.equal(cfg?.nativePriority, 2);
  assert.equal(cfg?.cliproxyapiPriority, 2);
  const upd = await upstream.updateUpstreamProxyConfig("prio", { nativePriority: 3.7 });
  assert.equal(upd?.nativePriority, 4);
});
