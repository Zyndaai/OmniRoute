import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const settingsDb = await import("../../../src/lib/db/settings.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");

async function importFresh(modulePath) {
  const url = pathToFileURL(path.resolve(modulePath)).href;
  return import(`${url}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test.beforeEach(async () => {
  await resetTestDb();
});

test("getCachedSettings returns cached data until TTL expires or cache is invalidated", async () => {
  const readCache = await importFresh("src/lib/db/readCache.ts");
  const backend = getTestBackend();
  const writeSetting = (key: string, value: unknown) =>
    backend.execute(
      `INSERT INTO config_entries (namespace, key, value) VALUES ('settings', $1, $2::jsonb)
       ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)]
    );

  await settingsDb.updateSettings({ label: "initial" });
  assert.equal((await readCache.getCachedSettings()).label, "initial");

  await writeSetting("label", "stale-write");

  assert.equal((await readCache.getCachedSettings()).label, "initial");

  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 6_000;
    assert.equal((await readCache.getCachedSettings()).label, "stale-write");
  } finally {
    Date.now = originalNow;
  }

  await writeSetting("label", "after-invalidate");
  readCache.invalidateDbCache("settings");

  assert.equal((await readCache.getCachedSettings()).label, "after-invalidate");
});

test("getCachedPricing caches results and refreshes after invalidation", async () => {
  const readCache = await importFresh("src/lib/db/readCache.ts");
  const backend = getTestBackend();

  await backend.execute(
    "INSERT INTO model_pricing (source, provider, models) VALUES ('user', $1, $2::jsonb)",
    ["cache-provider", JSON.stringify({ "model-a": { prompt: 1 } })]
  );

  assert.equal((await readCache.getCachedPricing())["cache-provider"]["model-a"].prompt, 1);

  await backend.execute(
    "UPDATE model_pricing SET models = $1::jsonb WHERE source = 'user' AND provider = $2",
    [JSON.stringify({ "model-a": { prompt: 9 } }), "cache-provider"]
  );

  assert.equal((await readCache.getCachedPricing())["cache-provider"]["model-a"].prompt, 1);

  readCache.invalidateDbCache("pricing");

  assert.equal((await readCache.getCachedPricing())["cache-provider"]["model-a"].prompt, 9);
});

test("getCachedProviderConnections caches only the unfiltered query", async () => {
  const readCache = await import("../../../src/lib/db/readCache.ts");
  const now = new Date().toISOString();

  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Primary",
    apiKey: "sk-primary",
  });
  const firstRead = await readCache.getCachedProviderConnections();

  await getTestBackend().execute(
    `INSERT INTO provider_connections (
      id, provider, auth_type, name, is_active, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ["direct-insert", "openai", "apikey", "Secondary", true, now, now]
  );

  const cachedAll = await readCache.getCachedProviderConnections();
  const filtered = await readCache.getCachedProviderConnections({ provider: "openai" });

  assert.equal(firstRead.length, 1);
  assert.equal(cachedAll.length, 1);
  assert.equal(filtered.length, 2);

  readCache.invalidateDbCache("connections");

  assert.equal((await readCache.getCachedProviderConnections()).length, 2);
});

test("resetDbInstance invalidates provider connection read caches", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Reset Cache Test",
    apiKey: "sk-reset-cache",
  });

  assert.equal((await providersDb.getProviderConnections()).length, 1);

  await resetTestDb();

  assert.equal((await providersDb.getProviderConnections()).length, 0);
});

test("createProviderConnection upsert invalidates the provider connection read cache", async () => {
  const readCache = await import("../../../src/lib/db/readCache.ts");
  const original = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: "cache-upsert@example.com",
    accessToken: "token-a",
    refreshToken: "refresh-a",
    testStatus: "active",
  });

  const primed = await readCache.getCachedProviderConnectionById(original.id);
  assert.equal(primed?.testStatus, "active");

  await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: "cache-upsert@example.com",
    accessToken: "token-b",
    refreshToken: "refresh-b",
    testStatus: "retrying",
  });

  const refreshed = await readCache.getCachedProviderConnectionById(original.id);
  assert.equal(refreshed?.testStatus, "retrying");
});

test("cached LKGP values refresh only after the specific key is invalidated", async () => {
  const readCache = await importFresh("src/lib/db/readCache.ts");
  const comboName = `combo-${Date.now()}`;
  const modelId = `model-${Date.now()}`;
  const lkgpKey = `${comboName}:${modelId}`;

  await settingsDb.setLKGP(comboName, modelId, "openai");
  assert.deepEqual(await readCache.getCachedLKGP(comboName, modelId), { provider: "openai" });

  await getTestBackend().execute("UPDATE lkgp_pins SET provider = $1 WHERE pin_key = $2", [
    "anthropic",
    lkgpKey,
  ]);

  assert.deepEqual(await readCache.getCachedLKGP(comboName, modelId), { provider: "openai" });

  await readCache.setCachedLKGP(comboName, modelId, "gemini");

  assert.deepEqual(await readCache.getCachedLKGP(comboName, modelId), { provider: "gemini" });
});

test("staleness regression: getProviderConnections returns fresh data after connection deleted", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Staleness Test",
    apiKey: "sk-stale-test",
  });

  const before = await providersDb.getProviderConnections();
  assert.ok(before.length > 0);
  assert.ok(before.some((c) => c.name === "Staleness Test"));

  await providersDb.deleteProviderConnection(conn.id);

  const after = await providersDb.getProviderConnections();
  assert.equal(after.filter((c) => c.name === "Staleness Test").length, 0);
});

test("staleness regression: getProviderConnections returns fresh data after deleteProviderConnectionsByProvider", async () => {
  await providersDb.createProviderConnection({
    provider: "test-stale-batch",
    authType: "apikey",
    name: "Batch Stale Conn",
    apiKey: "sk-batch-stale",
  });

  const before = await providersDb.getProviderConnections();
  assert.ok(before.some((c) => c.provider === "test-stale-batch"));

  await providersDb.deleteProviderConnectionsByProvider("test-stale-batch");

  const after = await providersDb.getProviderConnections();
  assert.equal(after.filter((c) => c.provider === "test-stale-batch").length, 0);
});

test("getCachedProviderConnectionById caches result and invalidates on connections write", async () => {
  const readCache = await importFresh("src/lib/db/readCache.ts");

  await providersDb.createProviderConnection({
    provider: "anthropic",
    authType: "apikey",
    name: "Cached Conn",
    apiKey: "sk-cached-conn",
  });

  const allConns = await providersDb.getProviderConnections();
  const id = allConns[allConns.length - 1].id;

  const firstRead = await readCache.getCachedProviderConnectionById(id);
  assert.ok(firstRead);
  assert.equal(firstRead.name, "Cached Conn");

  await getTestBackend().execute("UPDATE provider_connections SET name = $1 WHERE id = $2", [
    "Stale",
    id,
  ]);

  const cachedRead = await readCache.getCachedProviderConnectionById(id);
  assert.equal(cachedRead.name, "Cached Conn");

  readCache.invalidateDbCache("connections");

  const freshRead = await readCache.getCachedProviderConnectionById(id);
  assert.ok(freshRead);
  assert.equal(freshRead.name, "Stale");
});

test("getCachedProviderNodes caches results and invalidates on nodes write", async () => {
  const readCache = await importFresh("src/lib/db/readCache.ts");
  const nodesDb = await importFresh("src/lib/db/providers/nodes.ts");
  const now = new Date().toISOString();

  // provider_nodes.type is restricted to the compatible node types in the PostgreSQL schema.
  await nodesDb.createProviderNode({
    id: "node-cache-test",
    type: "openai-compatible",
    name: "Cached Node",
    baseUrl: "https://cached.example.com",
    createdAt: now,
    updatedAt: now,
  });

  const firstRead = await readCache.getCachedProviderNodes();
  const matching = firstRead.filter((n) => n.id === "node-cache-test");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].name, "Cached Node");

  await getTestBackend().execute(
    "INSERT INTO provider_nodes (id, type, name, base_url, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      "node-direct-test",
      "openai-compatible",
      "Direct Insert Node",
      "https://direct.example.com",
      now,
      now,
    ]
  );

  const cachedNodes = await readCache.getCachedProviderNodes();
  const matchingCached = cachedNodes.filter((n) => n.id === "node-direct-test");
  assert.equal(matchingCached.length, 0);

  readCache.invalidateDbCache("nodes");

  const freshNodes = await readCache.getCachedProviderNodes();
  const matchingFresh = freshNodes.filter((n) => n.id === "node-direct-test");
  assert.equal(matchingFresh.length, 1);
  assert.equal(matchingFresh[0].name, "Direct Insert Node");
});
