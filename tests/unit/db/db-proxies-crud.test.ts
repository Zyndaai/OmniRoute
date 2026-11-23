import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const providersDb = await import("../../../src/lib/db/providers.ts");
const proxiesDb = await import("../../../src/lib/db/proxies.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test("proxy CRUD redacts secrets by default and preserves stored credentials when omitted", async () => {
  const created = await proxiesDb.createProxy({
    name: "Primary Proxy",
    type: "http",
    host: "proxy.local",
    port: 8080,
    username: "user-a",
    password: "pass-a",
    region: "sa-east-1",
    source: "dashboard-custom",
  });

  assert.equal(created.username, "***");
  assert.equal(created.password, "***");
  assert.equal(created.source, "dashboard-custom");

  const withSecrets = await proxiesDb.getProxyById(created.id, { includeSecrets: true });
  const updated = await proxiesDb.updateProxy(created.id, {
    host: "proxy-updated.local",
    notes: "updated",
  });
  const updatedWithSecrets = await proxiesDb.getProxyById(created.id, { includeSecrets: true });
  const { items: listed } = await proxiesDb.listProxies();

  assert.equal(withSecrets.username, "user-a");
  assert.equal(withSecrets.password, "pass-a");
  assert.equal(updated.host, "proxy-updated.local");
  assert.equal(updated.notes, "updated");
  assert.equal(updatedWithSecrets.username, "user-a");
  assert.equal(updatedWithSecrets.password, "pass-a");
  assert.equal(updatedWithSecrets.source, "dashboard-custom");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].username, "***");
  assert.equal(listed[0].password, "***");
  assert.equal(listed[0].source, "dashboard-custom");
});

test("proxy CRUD clears stored credentials when blanks are explicitly provided", async () => {
  const created = await proxiesDb.createProxy({
    name: "Clearable Proxy",
    type: "http",
    host: "clearable.local",
    port: 8080,
    username: "user-a",
    password: "pass-a",
  });

  const updated = await proxiesDb.updateProxy(created.id, {
    username: "",
    password: "",
  });
  const updatedWithSecrets = await proxiesDb.getProxyById(created.id, { includeSecrets: true });
  const { items: listed } = await proxiesDb.listProxies();

  assert.equal(updated.username, "");
  assert.equal(updated.password, "");
  assert.equal(updatedWithSecrets.username, "");
  assert.equal(updatedWithSecrets.password, "");
  assert.equal(listed[0].username, "");
  assert.equal(listed[0].password, "");
});

test("proxy assignments resolve by account, provider and global scope", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Proxy Target",
    apiKey: "sk-proxy",
  });
  const globalProxy = await proxiesDb.createProxy({
    name: "Global",
    type: "http",
    host: "global.local",
    port: 8080,
  });
  const providerProxy = await proxiesDb.createProxy({
    name: "Provider",
    type: "https",
    host: "provider.local",
    port: 443,
  });
  const accountProxy = await proxiesDb.createProxy({
    name: "Account",
    type: "socks5",
    host: "account.local",
    port: 1080,
  });

  await proxiesDb.assignProxyToScope("global", null, globalProxy.id);
  await proxiesDb.assignProxyToScope("provider", "openai", providerProxy.id);

  const providerResolved = await proxiesDb.resolveProxyForProvider("openai");
  const beforeAccount = await proxiesDb.resolveProxyForConnectionFromRegistry(
    (connection as any).id
  );

  await proxiesDb.assignProxyToScope("key", (connection as any).id, accountProxy.id);

  const assignmentsForAccountProxy = await proxiesDb.getProxyAssignments({
    proxyId: accountProxy.id,
  });
  const accountResolved = await proxiesDb.resolveProxyForConnectionFromRegistry(
    (connection as any).id
  );
  const usage = await proxiesDb.getProxyWhereUsed(accountProxy.id);

  assert.equal(providerResolved.host, "provider.local");
  assert.equal(beforeAccount.level, "provider");
  assert.equal(assignmentsForAccountProxy.length, 1);
  assert.equal(assignmentsForAccountProxy[0].scope, "account");
  assert.equal(accountResolved.level, "account");
  assert.equal(accountResolved.proxy.host, "account.local");
  assert.equal(usage.count, 1);
});

test("bulk assignment deduplicates scope ids and reports failures for missing proxies", async () => {
  const first = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Bulk One",
    apiKey: "sk-bulk-1",
  });
  const second = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Bulk Two",
    apiKey: "sk-bulk-2",
  });
  const proxy = await proxiesDb.createProxy({
    name: "Bulk Proxy",
    type: "http",
    host: "bulk.local",
    port: 8080,
  });

  const success = await proxiesDb.bulkAssignProxyToScope(
    "account",
    [first.id, second.id, first.id, " "],
    proxy.id
  );
  const failure = await proxiesDb.bulkAssignProxyToScope(
    "account",
    [first.id, second.id],
    "missing-proxy"
  );

  assert.equal(success.updated, 2);
  assert.deepEqual(success.failed, []);
  assert.equal(failure.updated, 0);
  assert.equal(failure.failed.length, 2);
  assert.match(failure.failed[0].reason, /Proxy not found/);
});

test("proxy health stats aggregate proxy_logs and force delete removes assignments", async () => {
  const proxy = await proxiesDb.createProxy({
    name: "Stats Proxy",
    type: "http",
    host: "stats.local",
    port: 8080,
  });

  await proxiesDb.assignProxyToScope("global", null, proxy.id);

  const backend = getTestBackend();
  const now = new Date().toISOString();
  const insertLog = (id: string, status: string, latencyMs: number) =>
    backend.execute(
      `INSERT INTO proxy_logs (
        id, "timestamp", status, proxy_type, proxy_host, proxy_port, latency_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, now, status, "http", "stats.local", 8080, latencyMs]
    );
  await insertLog("proxy-log-1", "success", 100);
  await insertLog("proxy-log-2", "error", 250);
  await insertLog("proxy-log-3", "timeout", 400);

  const stats = await proxiesDb.getProxyHealthStats({ hours: 2 });

  assert.deepEqual(stats[0], {
    proxyId: proxy.id,
    name: "Stats Proxy",
    type: "http",
    host: "stats.local",
    port: 8080,
    status: "active",
    totalRequests: 3,
    successCount: 1,
    errorCount: 1,
    timeoutCount: 1,
    successRate: 33.33,
    connectionTests: 0,
    connectionTestSuccess: 0,
    realRequests: 3,
    measuredRequests: 0,
    measured: false,
    transportOk: 1,
    transportFailures: 2,
    transportRate: null,
    slowAbandoned: 0,
    clientAborted: 0,
    upstream4xx: 0,
    upstream5xx: 0,
    avgLatencyMs: 250,
    lastSeenAt: now,
  });

  assert.equal(await proxiesDb.deleteProxyById(proxy.id, { force: true }), true);
  assert.equal((await proxiesDb.getProxyAssignments()).length, 0);
  assert.equal(await proxiesDb.getProxyById(proxy.id), null);
});

test("assignProxyToScope normalizes key scope, supports removal, and blocks deleting in-use proxies", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Assigned Account",
    apiKey: "sk-assigned",
  });
  const proxy = await proxiesDb.createProxy({
    name: "Assigned Proxy",
    type: "http",
    host: "assigned.local",
    port: 8080,
  });

  const assignment = await proxiesDb.assignProxyToScope("key", (connection as any).id, proxy.id);

  assert.equal(assignment.scope, "account");
  assert.equal((await proxiesDb.getProxyAssignments({ scope: "key" })).length, 1);

  await assert.rejects(
    () => proxiesDb.deleteProxyById(proxy.id),
    /Remove assignments or account references first, or use force=true/
  );

  const removed = await proxiesDb.assignProxyToScope("key", (connection as any).id, null);

  assert.equal(removed, null);
  assert.equal((await proxiesDb.getProxyAssignments({ scope: "account" })).length, 0);
  assert.equal(await proxiesDb.deleteProxyById(proxy.id), true);
});

test("legacy proxy config migrates into the registry and subsequent runs can be skipped", async () => {
  const backend = getTestBackend();
  const seedLegacyProxyConfig = (key: string, value: unknown) =>
    backend.execute(
      `INSERT INTO config_entries (namespace, key, value) VALUES ('proxyConfig', $1, $2::jsonb)`,
      [key, JSON.stringify(value)]
    );

  await seedLegacyProxyConfig("global", "http://global-user:global-pass@global.local:8080");
  await seedLegacyProxyConfig("providers", {
    openai: "https://provider.local:8443",
    broken: "not a proxy url",
  });
  await seedLegacyProxyConfig("combos", {
    "combo-1": {
      type: "socks5",
      host: "combo.local",
      port: 1080,
    },
  });
  await seedLegacyProxyConfig("keys", {
    "conn-1": {
      type: "http",
      host: "account.local",
      port: 9000,
    },
  });

  const migrated = await proxiesDb.migrateLegacyProxyConfigToRegistry();
  const assignments = await proxiesDb.getProxyAssignments();
  const { items: proxies } = await proxiesDb.listProxies({ includeSecrets: true });
  const skipped = await proxiesDb.migrateLegacyProxyConfigToRegistry();

  assert.equal(migrated.skipped, false);
  assert.equal(migrated.migrated, 4);
  assert.equal(proxies.length, 4);
  assert.equal(assignments.length, 4);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "registry_not_empty");
});

test("provider resolution falls back to the global assignment and health stats stay nullable without logs", async () => {
  const globalProxy = await proxiesDb.createProxy({
    name: "Global Only",
    type: "http",
    host: "fallback.local",
    port: 8080,
  });

  await proxiesDb.assignProxyToScope("global", null, globalProxy.id);

  const resolved = await proxiesDb.resolveProxyForProvider("missing-provider");
  const stats = await proxiesDb.getProxyHealthStats({ hours: 24 * 400 });

  assert.equal(resolved.host, "fallback.local");
  assert.equal(stats[0].proxyId, globalProxy.id);
  assert.equal(stats[0].totalRequests, 0);
  assert.equal(stats[0].successRate, null);
  assert.equal(stats[0].avgLatencyMs, null);
  assert.equal((await proxiesDb.resolveProxyForProvider("openai")).host, "fallback.local");
});
