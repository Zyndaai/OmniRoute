import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const combosDb = await import("../../../src/lib/db/combos.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const proxiesDb = await import("../../../src/lib/db/proxies.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");

/** Raw write of one config_entries row (the table behind settings, proxyConfig, ...). */
async function seedConfig(namespace: string, key: string, value: unknown) {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [namespace, key, JSON.stringify(value)]
  );
}

/** Raw write of one pricing layer row: source is 'litellm' | 'models_dev' | 'user'. */
async function seedPricing(source: string, provider: string, models: unknown) {
  await getTestBackend().execute(
    `INSERT INTO model_pricing (source, provider, models) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (source, provider) DO UPDATE SET models = EXCLUDED.models`,
    [source, provider, JSON.stringify(models)]
  );
}

async function setConnectionProxyEnabled(connectionId: string) {
  await getTestBackend().execute("UPDATE provider_connections SET proxy_enabled = true WHERE id = $1", [
    connectionId,
  ]);
}

test.beforeEach(async () => {
  await resetTestDb();
  delete process.env.INITIAL_PASSWORD;
});

test.after(async () => {
  delete process.env.INITIAL_PASSWORD;
});

test("getSettings exposes defaults and updateSettings persists typed values", async () => {
  const defaults = await settingsDb.getSettings();
  const updated = await settingsDb.updateSettings({
    requireLogin: false,
    cloudEnabled: true,
    stickyRoundRobinLimit: 7,
    requestRetry: 5,
    maxRetryIntervalSec: 12,
    label: "task-303",
  });

  assert.equal(defaults.cloudEnabled, false);
  assert.equal(defaults.requireLogin, true);
  assert.deepEqual(defaults.hiddenSidebarItems, []);
  assert.deepEqual(defaults.hiddenSidebarGroupLabels, []);
  assert.equal(defaults.idempotencyWindowMs, 5000);
  assert.equal(defaults.requestRetry, 3);
  assert.equal(defaults.maxRetryIntervalSec, 30);
  assert.equal(defaults.antigravitySignatureCacheMode, "enabled");
  assert.equal(defaults.comboConfigMode, "guided");
  assert.equal(defaults.mcpEnabled, true);
  assert.equal(defaults.mcpTransport, "streamable-http");
  assert.equal(defaults.a2aEnabled, false);
  assert.equal(updated.requireLogin, false);
  assert.equal(updated.cloudEnabled, true);
  assert.equal(updated.stickyRoundRobinLimit, 7);
  assert.equal(updated.requestRetry, 5);
  assert.equal(updated.maxRetryIntervalSec, 12);
  assert.equal(updated.antigravitySignatureCacheMode, "enabled");
  assert.equal(updated.label, "task-303");
  assert.equal(await settingsDb.isCloudEnabled(), true);

  const reread = await settingsDb.getSettings();
  assert.equal(reread.cloudEnabled, true);
  const stored = await getTestBackend().queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace = 'settings' AND key = 'cloudEnabled'"
  );
  assert.equal(stored?.value, true);
});

test("INITIAL_PASSWORD marks onboarding as complete on first read", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";

  const settings = await settingsDb.getSettings();
  const stored = await settingsDb.getSettings();

  assert.equal(settings.setupComplete, true);
  assert.equal(settings.requireLogin, true);
  assert.equal(stored.setupComplete, true);
});

test("pricing layers merge synced, models.dev and user overrides", async () => {
  await seedPricing("litellm", "layered-provider", {
    "model-a": { prompt: 1, completion: 2 },
  });
  await seedPricing("models_dev", "layered-provider", {
    "model-a": { completion: 5, cached: 3 },
  });

  await settingsDb.updatePricing({
    "layered-provider": {
      "model-a": { prompt: 9, custom: 42 },
      "model-b": { prompt: 7 },
    },
  });

  const pricing = await settingsDb.getPricing();
  const direct = await settingsDb.getPricingForModel("layered-provider", "model-a");
  const cnFallback = await settingsDb.getPricingForModel("openai-cn", "gpt-4o");

  assert.deepEqual(pricing["layered-provider"]["model-a"], {
    prompt: 9,
    completion: 5,
    cached: 3,
    custom: 42,
  });
  assert.deepEqual(direct, {
    prompt: 9,
    completion: 5,
    cached: 3,
    custom: 42,
  });
  assert.ok(cnFallback);

  const afterModelReset = await settingsDb.resetPricing("layered-provider", "model-a");
  assert.equal(afterModelReset["layered-provider"]["model-a"], undefined);

  const afterProviderReset = await settingsDb.resetPricing("layered-provider");
  assert.equal(afterProviderReset["layered-provider"], undefined);

  await settingsDb.updatePricing({
    temp: { model: { prompt: 1 } },
  });
  assert.deepEqual(await settingsDb.resetAllPricing(), {});
});

test("getPricingWithSources reports the winning layer for each provider/model", async () => {
  await seedPricing("litellm", "layer-source", {
    "model-litellm": { prompt: 1, completion: 2 },
    "model-user": { prompt: 3 },
  });
  await seedPricing("models_dev", "layer-source", {
    "model-modelsdev": { prompt: 4, completion: 5 },
    "model-user": { completion: 6 },
  });

  await settingsDb.updatePricing({
    "layer-source": {
      "model-user": { cached: 7 },
    },
  });

  const { pricing, sourceMap } = await settingsDb.getPricingWithSources();

  assert.deepEqual(pricing["layer-source"]["model-litellm"], {
    prompt: 1,
    completion: 2,
  });
  assert.deepEqual(pricing["layer-source"]["model-modelsdev"], {
    prompt: 4,
    completion: 5,
  });
  assert.deepEqual(pricing["layer-source"]["model-user"], {
    prompt: 3,
    completion: 6,
    cached: 7,
  });
  assert.equal(sourceMap["layer-source"]["model-litellm"], "litellm");
  assert.equal(sourceMap["layer-source"]["model-modelsdev"], "modelsDev");
  assert.equal(sourceMap["layer-source"]["model-user"], "user");
  assert.equal(sourceMap.openai["gpt-4o"], "default");
});

test("LKGP values can be set, read and cleared", async () => {
  assert.equal(await settingsDb.getLKGP("combo-a", "model-a"), null);

  await settingsDb.setLKGP("combo-a", "model-a", "openai");
  await settingsDb.setLKGP("combo-a", "model-b", "anthropic");

  assert.deepEqual(await settingsDb.getLKGP("combo-a", "model-a"), { provider: "openai" });
  assert.deepEqual(await settingsDb.getLKGP("combo-a", "model-b"), { provider: "anthropic" });

  await settingsDb.clearAllLKGP();

  assert.equal(await settingsDb.getLKGP("combo-a", "model-a"), null);
});

test("LKGP stores and retrieves connectionId", async () => {
  await settingsDb.setLKGP("combo-c", "model-c", "openai", "conn-abc123");

  const record = await settingsDb.getLKGP("combo-c", "model-c");
  assert.deepEqual(record, { provider: "openai", connectionId: "conn-abc123" });
});

test("LKGP without connectionId omits the field", async () => {
  await settingsDb.setLKGP("combo-d", "model-d", "anthropic");

  const record = await settingsDb.getLKGP("combo-d", "model-d");
  assert.deepEqual(record, { provider: "anthropic" });
  assert.equal("connectionId" in (record as object), false);
});

test("LKGP overwrites connectionId when updated without one", async () => {
  await settingsDb.setLKGP("combo-e", "model-e", "openai", "conn-old");
  await settingsDb.setLKGP("combo-e", "model-e", "openai");

  const record = await settingsDb.getLKGP("combo-e", "model-e");
  assert.deepEqual(record, { provider: "openai" });
});

test("clearLKGP deletes only the targeted combo/model key", async () => {
  await settingsDb.setLKGP("combo-f", "model-f", "openai");
  await settingsDb.setLKGP("combo-f", "model-g", "anthropic");

  await settingsDb.clearLKGP("combo-f", "model-f");

  assert.equal(await settingsDb.getLKGP("combo-f", "model-f"), null);
  // A sibling key under the same combo must survive.
  assert.deepEqual(await settingsDb.getLKGP("combo-f", "model-g"), { provider: "anthropic" });
});

test("clearLKGP on a key with no existing pin does not throw", async () => {
  await assert.doesNotReject(() => settingsDb.clearLKGP("combo-never-set", "model-never-set"));
  assert.equal(await settingsDb.getLKGP("combo-never-set", "model-never-set"), null);
});

test("pricing helpers ignore malformed synced data and LKGP falls back to raw values", async () => {
  // model_pricing.models is jsonb: a malformed synced layer can only be a non-object JSON value.
  await seedPricing("models_dev", "broken-provider", "not-an-object");
  await seedPricing("user", "alias-provider", {
    "model-a": { prompt: 7 },
  });
  await getTestBackend().execute(
    "INSERT INTO lkgp_pins (pin_key, provider, connection_id) VALUES ($1, $2, NULL)",
    ["combo-raw:model-raw", "raw-provider-id"]
  );

  const pricing = await settingsDb.getPricing();

  assert.equal(pricing["broken-provider"], undefined);
  assert.equal(await settingsDb.getPricingForModel("alias-provider", "missing-model"), null);
  assert.deepEqual(await settingsDb.getLKGP("combo-raw", "model-raw"), {
    provider: "raw-provider-id",
  });
});

test("pricing helpers resolve aliased providers and tolerate no-op resets", async () => {
  await seedPricing("user", "cc", {
    "claude-3-5-sonnet": { prompt: 4, completion: 6 },
  });

  const aliasPricing = await settingsDb.getPricingForModel("claude", "claude-3-5-sonnet");
  const missingPricing = await settingsDb.getPricingForModel("missing-provider", "missing-model");
  const afterUnknownReset = await settingsDb.resetPricing("missing-provider", "missing-model");

  assert.deepEqual(aliasPricing, { prompt: 4, completion: 6 });
  assert.equal(missingPricing, null);
  assert.equal(afterUnknownReset["missing-provider"], undefined);
});

test("proxy config migrates legacy strings and supports bulk merge updates", async () => {
  await seedConfig("proxyConfig", "global", "http://user:pass@global.local:8080");
  await seedConfig("proxyConfig", "providers", {
    openai: "https://provider.local:8443",
  });

  const migrated = await settingsDb.getProxyConfig();
  assert.deepEqual(migrated.global, {
    type: "http",
    host: "global.local",
    port: "8080",
    username: "user",
    password: "pass",
  });
  assert.deepEqual(migrated.providers.openai, {
    type: "https",
    host: "provider.local",
    port: "8443",
    username: "",
    password: "",
  });

  const merged = await settingsDb.setProxyConfig({
    providers: {
      openai: null,
      anthropic: {
        type: "http",
        host: "anthropic.local",
        port: 9000,
      },
    },
    keys: {
      key123: {
        type: "socks5",
        host: "key.local",
        port: 1080,
      },
    },
  });

  assert.equal(merged.providers.openai, undefined);
  assert.equal(merged.providers.anthropic.host, "anthropic.local");
  assert.equal((await settingsDb.getProxyForLevel("key", "key123")).host, "key.local");

  await settingsDb.deleteProxyForLevel("key", "key123");

  assert.equal(await settingsDb.getProxyForLevel("key", "key123"), null);
});

test("proxy config migrates socks5 and host-only entries while preserving plural lookups", async () => {
  await seedConfig("proxyConfig", "global", "fallback-only-host");
  await seedConfig("proxyConfig", "providers", {
    claude: "socks5://sockshost",
  });

  const migrated = await settingsDb.getProxyConfig();
  assert.deepEqual(migrated.global, {
    type: "http",
    host: "fallback-only-host",
    port: "8080",
    username: "",
    password: "",
  });
  assert.deepEqual(migrated.providers.claude, {
    type: "socks5",
    host: "sockshost",
    port: "1080",
    username: "",
    password: "",
  });
  assert.equal((await settingsDb.getProxyForLevel("providers", "claude")).host, "sockshost");

  const updated = await settingsDb.setProxyConfig({
    global: null,
    providers: {},
  });

  assert.equal(updated.global, null);
  assert.equal(await settingsDb.getProxyForLevel("global"), null);

  await settingsDb.deleteProxyForLevel("provider", null);

  assert.equal((await settingsDb.getProxyForLevel("provider", "claude")).host, "sockshost");
});

test("proxy helpers resolve key, provider, global, and direct paths while tolerating malformed combo rows", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Proxy Resolution Target",
    apiKey: "sk-proxy-resolution",
  });
  await setConnectionProxyEnabled((connection as any).id);

  await settingsDb.setProxyConfig({
    level: "global",
    proxy: {
      type: "http",
      host: "global.local",
      port: 8080,
    },
  });
  await settingsDb.setProxyForLevel("provider", "openai", {
    type: "https",
    host: "provider.local",
    port: 8443,
  });
  await settingsDb.setProxyForLevel("combo", "combo-broken", {
    type: "socks5",
    host: "combo.local",
    port: 1080,
  });
  const combo = await combosDb.createCombo({
    name: "combo-broken",
    models: ["openai/gpt-4o-mini"],
    strategy: "priority",
  });
  // combos.data is jsonb: a malformed combo record is a non-object JSON value.
  await getTestBackend().execute("UPDATE combos SET data = $1::jsonb WHERE id = $2", [
    JSON.stringify("not-a-combo-record"),
    combo.id,
  ]);

  const providerResolved = await settingsDb.resolveProxyForConnection((connection as any).id);

  assert.equal(providerResolved.level, "provider");
  assert.equal(providerResolved.proxy.host, "provider.local");
  assert.deepEqual(await settingsDb.getProxyForLevel("combo", "combo-broken"), {
    type: "socks5",
    host: "combo.local",
    port: 1080,
  });

  await settingsDb.deleteProxyForLevel("provider", "openai");

  const globalResolved = await settingsDb.resolveProxyForConnection((connection as any).id);

  assert.equal(globalResolved.level, "global");
  assert.equal(globalResolved.proxy.host, "global.local");

  await settingsDb.setProxyForLevel("key", (connection as any).id, {
    type: "http",
    host: "key.local",
    port: 3128,
  });

  const keyResolved = await settingsDb.resolveProxyForConnection((connection as any).id);

  assert.equal(keyResolved.level, "key");
  assert.equal(keyResolved.proxy.host, "key.local");

  await settingsDb.deleteProxyForLevel("key", (connection as any).id);
  await settingsDb.deleteProxyForLevel("global", null);

  const directResolved = await settingsDb.resolveProxyForConnection((connection as any).id);

  assert.equal(directResolved.level, "direct");
  assert.equal(directResolved.proxy, null);
});

test("proxy resolution skips combos without serialized data and falls back to provider proxies", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "Proxy Null Combo",
    apiKey: "sk-claude-proxy",
  });
  await setConnectionProxyEnabled((connection as any).id);

  await settingsDb.setProxyForLevel("provider", "claude", {
    type: "https",
    host: "provider-claude.local",
    port: 443,
  });

  const combo = await combosDb.createCombo({
    name: "combo-null-data",
    models: ["claude/claude-3-5-sonnet"],
    strategy: "priority",
  });
  await settingsDb.setProxyForLevel("combo" as any, (combo as any).id, {
    type: "http",
    host: "combo-null.local",
    port: 8080,
  });
  await getTestBackend().execute("UPDATE combos SET data = $1::jsonb WHERE id = $2", [
    "0",
    combo.id,
  ]);

  const resolved = await settingsDb.resolveProxyForConnection((connection as any).id);

  assert.equal(resolved.level, "provider");
  assert.equal(resolved.proxy.host, "provider-claude.local");
});

test("proxy resolution matches combo proxies through aliased model entries", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "Proxy Alias Combo",
    apiKey: "sk-claude-alias",
  });
  // Enable proxy on this connection so legacy combo/provider proxy checks work
  await setConnectionProxyEnabled((connection as any).id);

  const combo = await combosDb.createCombo({
    name: "combo-aliased-model",
    models: [{ model: "cc/claude-3-5-sonnet" }],
    strategy: "priority",
  });
  await settingsDb.setProxyForLevel("combo", (combo as any).id, {
    type: "https",
    host: "combo-alias.local",
    port: 443,
  });

  const resolved = await settingsDb.resolveProxyForConnection((connection as any).id);

  assert.equal(resolved.level, "combo");
  assert.equal(resolved.levelId, combo.id);
  assert.equal(resolved.proxy.host, "combo-alias.local");
});

test("proxy resolution prefers legacy key and provider proxies over registry global fallback (#2601)", async () => {
  const keyConnection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Legacy Key Override",
    apiKey: "sk-key-override",
  });
  const providerConnection = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "apikey",
    name: "Legacy Provider Override",
    apiKey: "sk-provider-override",
  });

  const registryGlobal = await proxiesDb.createProxy({
    name: "Registry Global Fallback",
    type: "http",
    host: "registry-global.local",
    port: 8080,
  });
  await proxiesDb.assignProxyToScope("global", null, registryGlobal.id);

  // Enable proxy on both connections so legacy key/provider proxy checks work
  await setConnectionProxyEnabled((keyConnection as any).id);
  await setConnectionProxyEnabled((providerConnection as any).id);

  await settingsDb.setProxyForLevel("key", (keyConnection as any).id, {
    type: "http",
    host: "legacy-key-override.local",
    port: 3128,
  });
  await settingsDb.setProxyForLevel("provider", "claude", {
    type: "https",
    host: "legacy-provider-override.local",
    port: 443,
  });

  const keyResolved = await settingsDb.resolveProxyForConnection((keyConnection as any).id);
  const providerResolved = await settingsDb.resolveProxyForConnection(
    (providerConnection as any).id
  );

  assert.equal(keyResolved.level, "key");
  assert.equal(keyResolved.proxy.host, "legacy-key-override.local");
  assert.equal(providerResolved.level, "provider");
  assert.equal(providerResolved.proxy.host, "legacy-provider-override.local");
});

test("proxy readers normalize legacy rows and coerce invalid globals to null", async () => {
  await seedConfig(
    "proxyConfig",
    "global",
    "https://user%40name:pass%2Fword@proxy.example"
  );
  await seedConfig("proxyConfig", "providers", {
    openai: "http://provider.example",
  });
  await seedConfig("proxyConfig", "combos", "not-a-map");
  await seedConfig("proxyConfig", "keys", null);

  const config = await settingsDb.getProxyConfig();
  assert.deepEqual(config.global, {
    type: "https",
    host: "proxy.example",
    port: "443",
    username: "user@name",
    password: "pass/word",
  });
  assert.deepEqual(config.providers.openai, {
    type: "http",
    host: "provider.example",
    port: "8080",
    username: "",
    password: "",
  });
  assert.equal(await settingsDb.getProxyForLevel("combo", "missing"), null);

  const updated = await settingsDb.setProxyConfig({ level: 123, id: 456, proxy: 0 } as any);
  assert.equal(updated.global, null);
  assert.equal(await settingsDb.getProxyForLevel("global"), null);
});

test("cache metrics, trend and no-op update/reset methods read from usage_history", async () => {
  const backend = getTestBackend();
  const now = new Date().toISOString();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const insertUsage = (row: unknown[]) =>
    backend.execute(
      `INSERT INTO usage_history (
        provider, model, connection_id, api_key_id, api_key_name,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation,
        tokens_reasoning, status, success, latency_ms, ttft_ms, error_code, "timestamp"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      row
    );

  await insertUsage([
    "openai",
    "gpt-4.1",
    "conn-1",
    "key-1",
    "Primary",
    1000,
    400,
    300,
    120,
    0,
    "200",
    true,
    100,
    40,
    null,
    oneHourAgo,
  ]);
  await insertUsage([
    "anthropic",
    "claude-3-7-sonnet",
    "conn-2",
    "key-2",
    "Secondary",
    700,
    280,
    200,
    80,
    0,
    "200",
    true,
    90,
    30,
    null,
    now,
  ]);

  const metrics = await settingsDb.getCacheMetrics();
  const trend = await settingsDb.getCacheTrend(4);
  const updateNoOp = await settingsDb.updateCacheMetrics({ anything: true });
  const resetNoOp = await settingsDb.resetCacheMetrics();

  assert.ok(metrics.totalRequests >= 2);
  assert.ok(metrics.requestsWithCacheControl >= 2);
  assert.ok(metrics.byProvider.openai);
  assert.ok(metrics.byProvider.anthropic);
  assert.ok(trend.length >= 1);
  assert.equal(updateNoOp.totalCachedTokens, metrics.totalCachedTokens);
  assert.equal(resetNoOp.totalCachedTokens, metrics.totalCachedTokens);
});
