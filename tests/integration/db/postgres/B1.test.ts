/**
 * Group B1 against a real PostgreSQL: key-value config namespaces (config_entries), settings,
 * secrets, LKGP pins, session affinity, muse ownership, cc-discovery counters.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";

const backend = getTestBackend();

const settings = await import("../../../../src/lib/db/settings.ts");
const lkgp = await import("../../../../src/lib/db/settings/lkgp.ts");
const affinity = await import("../../../../src/lib/db/sessionAffinity/sqliteStore.ts");
const muse = await import("../../../../src/lib/db/museSessionOwnership.ts");
const metrics = await import("../../../../src/lib/db/ccDiscoveryMetrics.ts");
const flags = await import("../../../../src/lib/db/featureFlags.ts");
const ccAliases = await import("../../../../src/lib/db/ccDiscoveryAliases.ts");
const gateway = await import("../../../../src/lib/db/functionalGatewayMirrors.ts");
const secrets = await import("../../../../src/lib/db/secrets.ts");
const notion = await import("../../../../src/lib/db/notion.ts");
const obsidian = await import("../../../../src/lib/db/obsidian.ts");
const obsidianApi = await import("../../../../src/lib/obsidian/api.ts");
const localCorpus = await import("../../../../src/lib/db/localCorpus.ts");
const conductor = await import("../../../../src/lib/db/conductorBridge.ts");
const cliTool = await import("../../../../src/lib/db/cliToolState.ts");
const credit = await import("../../../../src/lib/db/creditBalance.ts");
const serviceModels = await import("../../../../src/lib/db/serviceModels.ts");
const paramFilters = await import("../../../../src/lib/db/paramFilters.ts");
const interception = await import("../../../../src/lib/db/interceptionRules.ts");
const pii = await import("../../../../src/lib/db/piiSettings.ts");
const compression = await import("../../../../src/lib/db/compression.ts");
const rootLayout = await import("../../../../src/lib/db/rootLayoutSettings.ts");
const ipFilter = await import("../../../../open-sse/services/ipFilter.ts");
const gemini = await import("../../../../open-sse/services/geminiThoughtSignatureStore.ts");

test.beforeEach(async () => {
  await truncateAll(backend);
  flags.clearFeatureFlagOverrideCache();
  pii.clearPiiSettingsCache();
  ipFilter.resetIPFilter();
  gemini.clearGeminiThoughtSignatureMemoryForTests();
});

test("settings: write, read, defaults, encrypted keys, revision conflict", async () => {
  const before = await settings.getSettings();
  assert.equal(before.requireLogin, true);
  assert.equal(await settings.getSettingsRevision(), 0);

  await settings.updateSettings({ comboStrategy: "round-robin", customSystemPrompt: "hi" });
  const after = await settings.getSettings();
  assert.equal(after.comboStrategy, "round-robin");
  assert.equal(after.customSystemPrompt, "hi");
  assert.equal(await settings.getSettingsRevision(), 1);

  await settings.updateSettings({ oidcClientSecret: "s3cret", skillsmpApiKey: "k" });
  const stored = await backend.queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace='settings' AND key='skillsmpApiKey'"
  );
  assert.equal(typeof stored?.value, "string");
  assert.equal((await settings.getSettings()).oidcClientSecret, "s3cret");
  assert.equal((await settings.getSettings()).skillsmpApiKey, "k");

  const revision = await settings.getSettingsRevision();
  await assert.rejects(
    settings.updateSettings({ debugMode: true }, { expectedRevision: revision - 1 }),
    (error: { code?: string }) => error.code === "SETTINGS_REVISION_CONFLICT"
  );
  assert.equal((await settings.getSettings()).debugMode, false);
});

test("settings: concurrent updates never lose a revision", async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => settings.updateSettings({ [`flag${index}`]: index }))
  );
  assert.equal(await settings.getSettingsRevision(), 8);
  const all = await settings.getSettings();
  for (let index = 0; index < 8; index++) assert.equal(all[`flag${index}`], index);
});

test("settings: concurrent updates with the same expectedRevision let exactly one win", async () => {
  await settings.updateSettings({ seed: 1 });
  const revision = await settings.getSettingsRevision();
  const results = await Promise.allSettled([
    settings.updateSettings({ a: 1 }, { expectedRevision: revision }),
    settings.updateSettings({ b: 1 }, { expectedRevision: revision }),
    settings.updateSettings({ c: 1 }, { expectedRevision: revision }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await settings.getSettingsRevision(), revision + 1);
});

test("proxy config: set, merge, delete", async () => {
  await settings.setProxyForLevel("global", null, { type: "http", host: "h", port: "1" });
  await settings.setProxyForLevel("provider", "openai", { type: "socks5", host: "p", port: "2" });
  let config = await settings.getProxyConfig();
  assert.equal((config.global as { host: string }).host, "h");
  assert.equal((config.providers.openai as { host: string }).host, "p");

  await settings.setProxyConfig({ providers: { claude: { type: "http", host: "c", port: "3" } } });
  config = await settings.getProxyConfig();
  assert.deepEqual(Object.keys(config.providers).sort(), ["claude", "openai"]);

  await settings.deleteProxyForLevel("provider", "openai");
  config = await settings.getProxyConfig();
  assert.deepEqual(Object.keys(config.providers), ["claude"]);
});

test("lkgp: set, get, clear, prefix delete with wildcards, delete by connection", async () => {
  await lkgp.setLKGP("combo", "m1", "openai", "conn-1");
  await lkgp.setLKGP("combo", "m2", "claude");
  await lkgp.setLKGP("combo_x", "m1", "gemini", "conn-2");
  await lkgp.setLKGP("comboXy", "m1", "gemini", "conn-3");

  assert.deepEqual(await lkgp.getLKGP("combo", "m1"), { provider: "openai", connectionId: "conn-1" });
  assert.deepEqual(await lkgp.getLKGP("combo", "m2"), { provider: "claude" });
  assert.equal(await lkgp.getLKGP("combo", "none"), null);

  await lkgp.setLKGP("combo", "m1", "openai-2");
  assert.deepEqual(await lkgp.getLKGP("combo", "m1"), { provider: "openai-2" });

  await lkgp.clearLKGP("combo", "m2");
  assert.equal(await lkgp.getLKGP("combo", "m2"), null);

  // "_" in the combo name is not a LIKE wildcard: "comboXy" must survive deleting "combo_x".
  assert.equal(await lkgp.deleteLKGPByComboName("combo_x"), 1);
  assert.notEqual(await lkgp.getLKGP("comboXy", "m1"), null);

  assert.equal(await lkgp.deleteLKGPByConnectionIds(["conn-3", "missing"]), 1);
  assert.equal(await lkgp.getLKGP("comboXy", "m1"), null);
  assert.equal(await lkgp.deleteLKGPByConnectionIds([]), 0);

  await lkgp.clearAllLKGP();
  assert.equal(await lkgp.getLKGP("combo", "m1"), null);
});

test("session affinity: upsert, get, touch, evict, expiry, cleanup", async () => {
  const now = Date.now();
  const ttl = 60_000;
  await affinity.upsertSessionAccountAffinity("sess", "codex", "conn-a", now, ttl);
  const first = await affinity.getSessionAccountAffinity("sess", "codex", ttl, now + 1);
  assert.equal(first?.connectionId, "conn-a");
  assert.equal(first?.createdAt, new Date(now).toISOString());

  // A later upsert re-points the pin but keeps the creation time of the live row.
  await affinity.upsertSessionAccountAffinity("sess", "codex", "conn-b", now + 10, ttl);
  const second = await affinity.getSessionAccountAffinity("sess", "codex", ttl, now + 11);
  assert.equal(second?.connectionId, "conn-b");
  assert.equal(second?.createdAt, first?.createdAt);

  await affinity.touchSessionAccountAffinity("sess", "codex", now + 1000, ttl);
  const touched = await affinity.getSessionAccountAffinity("sess", "codex", ttl, now + 1001);
  assert.equal(touched?.lastUsedAt, new Date(now + 1000).toISOString());
  assert.equal(touched?.expiresAt, new Date(now + 1000 + ttl).toISOString());

  // Evict only when the pin points at the given connection.
  assert.equal(await affinity.evictSessionAccountAffinityForConnection("sess", "codex", "other"), false);
  assert.equal(await affinity.evictSessionAccountAffinityForConnection("sess", "codex", "conn-b"), true);
  assert.equal(await affinity.getSessionAccountAffinity("sess", "codex", ttl, now), null);

  // Expired rows read as a miss, restart their creation time, and are swept.
  await affinity.upsertSessionAccountAffinity("old", "codex", "conn-a", now - 2 * ttl, ttl);
  assert.equal(await affinity.getSessionAccountAffinity("old", "codex", ttl, now), null);
  await affinity.upsertSessionAccountAffinity("old2", "codex", "conn-a", now - 2 * ttl, ttl);
  await affinity.upsertSessionAccountAffinity("live", "codex", "conn-a", now, ttl);
  assert.equal(await affinity.cleanupStaleSessionAccountAffinities(0, now), 1);
  assert.notEqual(await affinity.getSessionAccountAffinity("live", "codex", ttl, now), null);

  const serialized = await affinity.getSessionAccountAffinitySerialized("live", "codex");
  assert.ok(serialized);
  assert.equal(await affinity.deleteSessionAccountAffinityIfValue("live", "codex", "{}"), false);
  assert.equal(
    await affinity.deleteSessionAccountAffinityIfValue("live", "codex", serialized!),
    true
  );
  assert.equal(await affinity.getSessionAccountAffinitySerialized("live", "codex"), null);
});

test("session affinity: concurrent upserts keep one row", async () => {
  const now = Date.now();
  await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      affinity.upsertSessionAccountAffinity("s", "p", `conn-${index}`, now + index, 60_000)
    )
  );
  const rows = await backend.query("SELECT 1 FROM session_affinities");
  assert.equal(rows.length, 1);
});

test("muse ownership: values, touched pruning, atomic transaction", async () => {
  await muse.writeMuseOwnershipValue("session:a", '{"connectionId":"c1"}');
  assert.equal(await muse.readMuseOwnershipValue("session:a"), '{"connectionId":"c1"}');
  assert.equal(await muse.readMuseOwnershipValue("session:zz"), undefined);
  await muse.writeMuseOwnershipValue("session:a", '{"connectionId":"c2"}');
  assert.equal(await muse.readMuseOwnershipValue("session:a"), '{"connectionId":"c2"}');

  await muse.writeMuseOwnershipValue("opaque:a:h1", "gen");
  assert.equal(await muse.museScopeHasRecordedItems("a"), true);
  assert.equal(await muse.museScopeHasRecordedItems("b"), false);

  const now = Date.now();
  await muse.touchMuseOwnershipScope("a", now - muse.MUSE_SESSION_IDLE_TTL_MS - 1000);
  await muse.writeMuseOwnershipValue("session:b", "x");
  await muse.touchMuseOwnershipScope("b", now);
  assert.equal(await muse.pruneIdleMuseOwnershipScopes(now), 1);
  assert.equal(await muse.readMuseOwnershipValue("session:a"), undefined);
  assert.equal(await muse.readMuseOwnershipValue("opaque:a:h1"), undefined);
  assert.equal(await muse.readMuseOwnershipValue("session:b"), "x");

  // Concurrent claims are serialised: a read-increment-write cursor never loses a step.
  await Promise.all(
    Array.from({ length: 10 }, () =>
      muse.runMuseOwnershipTransaction(async (tx) => {
        const cursor = Number((await muse.readMuseOwnershipValue("cursor", tx)) ?? "0");
        await muse.writeMuseOwnershipValue("cursor", String(cursor + 1), tx);
      })
    )
  );
  assert.equal(await muse.readMuseOwnershipValue("cursor"), "10");

  // A throwing callback rolls everything back.
  await assert.rejects(
    muse.runMuseOwnershipTransaction(async (tx) => {
      await muse.writeMuseOwnershipValue("session:rollback", "x", tx);
      throw new Error("boom");
    })
  );
  assert.equal(await muse.readMuseOwnershipValue("session:rollback"), undefined);
});

test("cc discovery metrics: concurrent increments add up", async () => {
  await Promise.all([
    ...Array.from({ length: 12 }, () => metrics.incrementCcAliasRequestCount("kimi/k2")),
    ...Array.from({ length: 5 }, () => metrics.incrementCcDiscoveryHitCount()),
  ]);
  assert.deepEqual(await metrics.getCcDiscoveryMetrics(), {
    aliasRequests: 12,
    discoveryHits: 5,
    byModel: { "kimi/k2": 12 },
  });
});

test("feature flags: set, get, enum validation, remove, clear", async () => {
  assert.equal(await flags.getFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES"), undefined);
  await flags.setFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES", "true");
  assert.equal(await flags.getFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES"), "true");
  await assert.rejects(flags.setFeatureFlagOverride("NOT_A_REAL_FLAG", "true"));
  assert.deepEqual(await flags.getFeatureFlagOverrides(), { EXPOSE_CC_DISCOVERY_ALIASES: "true" });

  // Raw text is stored as a JSON string.
  const row = await backend.queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace='feature_flags'"
  );
  assert.equal(row?.value, "true");

  await flags.removeFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES");
  assert.equal(await flags.getFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES"), undefined);
  await flags.setFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES", "1");
  await flags.clearAllFeatureFlagOverrides();
  assert.deepEqual(await flags.getFeatureFlagOverrides(), {});
});

test("cc discovery aliases and functional gateway mirrors: per-provider and per-model gates", async () => {
  await ccAliases.setCcAliasProviderSetting("kimi", "on");
  await ccAliases.setCcAliasModelSetting("kimi", "k2", "off");
  assert.equal(await ccAliases.getCcAliasProviderSetting("kimi"), "on");
  assert.equal(await ccAliases.getCcAliasModelSetting("kimi", "k2"), "off");
  const bulk = await ccAliases.getCcAliasSettingsBulk();
  assert.equal(bulk.providers.get("kimi"), "on");
  assert.equal(bulk.models.get("kimi/k2"), "off");
  await ccAliases.setCcAliasProviderSetting("kimi", null);
  assert.equal(await ccAliases.getCcAliasProviderSetting("kimi"), null);

  assert.deepEqual(await ccAliases.getCcAliasGlobalState(), { enabled: false, source: "default" });
  await flags.setFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES", "true");
  assert.deepEqual(await ccAliases.getCcAliasGlobalState(), { enabled: true, source: "db" });

  await gateway.setFunctionalGatewayProviderSetting("openai", "on");
  await gateway.setFunctionalGatewayModelSetting("openai/gpt", "off");
  assert.equal(await gateway.getFunctionalGatewayProviderSetting("openai"), "on");
  assert.equal(await gateway.getFunctionalGatewayModelSetting("openai/gpt"), "off");
  const gatewayBulk = await gateway.getFunctionalGatewaySettingsBulk();
  assert.equal(gatewayBulk.models.get("openai/gpt"), "off");
  await gateway.setFunctionalGatewayModelSetting("openai/gpt", null);
  assert.equal(await gateway.getFunctionalGatewayModelSetting("openai/gpt"), null);
});

test("secrets: first writer wins, value round-trips", async () => {
  assert.equal(await secrets.getPersistedSecret("JWT_SECRET"), null);
  await Promise.all([
    secrets.persistSecret("JWT_SECRET", "one"),
    secrets.persistSecret("JWT_SECRET", "two"),
    secrets.persistSecret("JWT_SECRET", "three"),
  ]);
  const first = await secrets.getPersistedSecret("JWT_SECRET");
  assert.ok(["one", "two", "three"].includes(first as string));
  await secrets.persistSecret("JWT_SECRET", "later");
  assert.equal(await secrets.getPersistedSecret("JWT_SECRET"), first);
});

test("notion, obsidian, local corpus, conductor, sync token", async () => {
  assert.equal(await notion.getNotionToken(), null);
  await notion.setNotionToken("secret_1");
  assert.deepEqual(await notion.getNotionConfig(), { token: "secret_1", connected: true });
  await notion.clearNotionToken();
  assert.equal(await notion.getNotionToken(), null);

  assert.equal(await obsidian.getObsidianBaseUrl(), "http://127.0.0.1:27123");
  await obsidian.setObsidianToken("tok");
  await obsidian.setObsidianBaseUrl("http://x:1");
  await obsidian.setObsidianVaultPath("/vault");
  await obsidian.setWebdavUsername("u");
  await obsidian.setWebdavPassword("p");
  await obsidian.setWebdavEnabled(true);
  assert.deepEqual(await obsidian.getObsidianConfig(), {
    token: "tok",
    connected: true,
    baseUrl: "http://x:1",
    vaultPath: "/vault",
  });
  assert.equal(await obsidian.getWebdavUsername(), "u");
  assert.equal(await obsidian.getWebdavPassword(), "p");
  assert.equal(await obsidian.getWebdavEnabled(), true);
  assert.equal((await obsidian.getObsidianConfigForApiKey(null)).source, "global");
  await obsidian.clearWebdavEnabled();
  await obsidian.clearObsidianToken();
  assert.equal(await obsidian.getWebdavEnabled(), false);
  assert.equal(await obsidian.getObsidianToken(), null);

  await obsidianApi.setSyncToken("sync-1");
  assert.equal(await obsidianApi.getSyncToken(), "sync-1");
  await obsidianApi.setSyncToken("sync-2");
  assert.equal(await obsidianApi.getSyncToken(), "sync-2");
  await obsidianApi.setSyncToken(null);
  assert.equal(await obsidianApi.getSyncToken(), null);

  assert.deepEqual(await localCorpus.getLocalCorpusConfig(), { rootPath: null, configured: false });
  await localCorpus.setLocalCorpusRoot("/corpus");
  assert.deepEqual(await localCorpus.getLocalCorpusConfig(), {
    rootPath: "/corpus",
    configured: true,
  });
  await localCorpus.clearLocalCorpusRoot();
  assert.equal(await localCorpus.getLocalCorpusRoot(), null);

  assert.equal(await conductor.getConductorCursor(), null);
  await conductor.setConductorCursor("evt-9");
  assert.equal(await conductor.getConductorCursor(), "evt-9");
});

test("cli tool state, credit balance, service models", async () => {
  await cliTool.saveCliToolLastConfigured("claude", "2026-01-01T00:00:00.000Z");
  assert.equal(await cliTool.getCliToolLastConfigured("claude"), "2026-01-01T00:00:00.000Z");
  assert.deepEqual(await cliTool.getAllCliToolLastConfigured(), {
    claude: "2026-01-01T00:00:00.000Z",
  });
  await cliTool.deleteCliToolLastConfigured("claude");
  assert.equal(await cliTool.getCliToolLastConfigured("claude"), null);

  assert.equal(await cliTool.saveCliToolInitialConfig("codex", { a: 1 }), true);
  assert.equal(await cliTool.saveCliToolInitialConfig("codex", { a: 2 }), false);
  assert.deepEqual(await cliTool.getCliToolInitialConfig("codex"), { a: 1 });
  await cliTool.deleteCliToolInitialConfig("codex");
  assert.equal(await cliTool.getCliToolInitialConfig("codex"), null);

  await credit.persistCreditBalance("acct", 42);
  await credit.persistCreditBalance("acct2", 7);
  assert.equal(await credit.getPersistedCreditBalance("acct"), 42);
  assert.deepEqual([...(await credit.getAllPersistedCreditBalances())].sort(), [
    ["acct", 42],
    ["acct2", 7],
  ]);

  await serviceModels.saveServiceModels("9router", [{ id: "a" }, { id: "b" }]);
  await serviceModels.saveServiceModels("9router", [{ id: "b" }, { id: "c" }]);
  const stored = await serviceModels.getServiceModels("9router");
  assert.deepEqual(
    Object.fromEntries(stored.map((m) => [m.id, m.available])),
    { a: false, b: true, c: true }
  );
  await serviceModels.markAllUnavailable("9router");
  assert.ok((await serviceModels.getServiceModels("9router")).every((m) => m.available === false));
  await serviceModels.saveServiceModels("empty", []);
  assert.deepEqual(await serviceModels.getServiceModels("empty"), []);
});

test("param filters: concurrent auto-learn keeps every param", async () => {
  await paramFilters.setParamFilterConfig("openai", { block: ["a"], allow: [] });
  await Promise.all(
    ["p1", "p2", "p3", "p4", "p5"].map((name) => paramFilters.addParamToBlocklist("openai", name))
  );
  const config = await paramFilters.getParamFilterConfig("openai");
  assert.deepEqual([...(config?.block ?? [])].sort(), ["a", "p1", "p2", "p3", "p4", "p5"]);

  await paramFilters.addParamToBlocklist("claude", "temperature", "opus");
  assert.deepEqual((await paramFilters.getParamFilterConfig("claude"))?.models?.opus?.block, [
    "temperature",
  ]);

  assert.equal(await paramFilters.isAutoLearnGloballyEnabled(), false);
  await paramFilters.setGlobalAutoLearnEnabled(true);
  assert.equal(await paramFilters.isAutoLearnGloballyEnabled(), true);
  await paramFilters.deleteParamFilterConfig("openai");
  assert.equal(await paramFilters.getParamFilterConfig("openai"), null);
});

test("interception rules and pii settings", async () => {
  await interception.setInterceptionRules("openai", {
    interceptSearch: true,
    models: { "gpt-x": { interceptSearch: false } },
  });
  assert.equal(await interception.resolveInterceptSearch("openai", "gpt-x"), false);
  assert.equal(await interception.resolveInterceptSearch("openai", "other"), true);
  assert.equal(await interception.resolveInterceptFetch("openai", "other"), undefined);
  await interception.deleteInterceptionRules("openai");
  assert.equal(await interception.getInterceptionRules("openai"), null);

  assert.deepEqual(await pii.getPiiSettings(), { enabledTypes: null, customPatterns: [] });
  const updated = await pii.setPiiSettings({
    enabledTypes: ["email"],
    customPatterns: [{ pattern: "x+", name: "x" } as never],
  });
  assert.deepEqual(updated.enabledTypes, ["email"]);
  assert.equal(updated.customPatterns.length, 1);
  assert.equal((await pii.setPiiSettings({ enabledTypes: null })).enabledTypes, null);
});

test("compression settings: partial merges, mcp accessibility, proactive ratio", async () => {
  const defaults = await compression.getCompressionSettings();
  assert.equal(typeof defaults.enabled, "boolean");

  await compression.updateCompressionSettings({ enabled: true, cacheMinutes: 9 });
  const after = await compression.getCompressionSettings();
  assert.equal(after.enabled, true);
  assert.equal(after.cacheMinutes, 9);

  await compression.updateCompressionSettings({
    lite: { compressToolResults: true, maxToolLength: 5000 },
  });
  await compression.updateCompressionSettings({ lite: { compressToolResults: false } });
  const lite = (await compression.getCompressionSettings()).lite;
  assert.equal(lite.compressToolResults, false);
  assert.equal(lite.maxToolLength, 5000);

  await compression.updateCompressionSettings({ engines: { caveman: { enabled: true } } });
  assert.equal((await compression.getCompressionSettings()).engines.caveman.enabled, true);

  await compression.setMcpAccessibilityConfig({ enabled: true });
  assert.equal((await compression.getMcpAccessibilityConfig()).enabled, true);

  assert.equal(await compression.getProactiveCompressionRatio(), 0.7);
});

test("root layout settings fall back to defaults and read stored values", async () => {
  assert.equal((await rootLayout.getRootLayoutSettings()).instanceName, "OmniRoute");
  await settings.updateSettings({ instanceName: "Acme", customFaviconUrl: "https://x/f.ico" });
  const layout = await rootLayout.getRootLayoutSettings();
  assert.equal(layout.instanceName, "Acme");
  assert.equal(layout.customFaviconUrl, "https://x/f.ico");
});

test("ip filter: persisted config, concurrent list edits, reset reloads", async () => {
  await ipFilter.configureIPFilter({ enabled: true, mode: "blacklist", blacklist: ["1.2.3.4"] });
  assert.deepEqual((await ipFilter.checkIP("1.2.3.4")).allowed, false);
  assert.deepEqual((await ipFilter.checkIP("9.9.9.9")).allowed, true);

  await Promise.all(
    Array.from({ length: 6 }, (_, index) => ipFilter.addToBlacklist(`10.0.0.${index}`))
  );
  ipFilter.resetIPFilter();
  const config = await ipFilter.getIPFilterConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.blacklist.length, 7);

  await ipFilter.removeFromBlacklist("1.2.3.4");
  assert.equal((await ipFilter.checkIP("1.2.3.4")).allowed, true);
});

test("gemini thought signatures: persist, reload after memory clear, expiry, clear", async () => {
  await gemini.storeGeminiThoughtSignature("call-1", "RsigA");
  gemini.clearGeminiThoughtSignatureMemoryForTests();
  assert.equal(await gemini.getGeminiThoughtSignature("call-1"), "RsigA");

  await gemini.storeGeminiThoughtSignature("call-1", "RsigB");
  gemini.clearGeminiThoughtSignatureMemoryForTests();
  assert.equal(await gemini.resolveGeminiThoughtSignature("call-1"), "RsigB");

  await backend.execute(
    "UPDATE gemini_thought_signatures SET expires_at = now() - interval '1 minute'"
  );
  gemini.clearGeminiThoughtSignatureMemoryForTests();
  assert.equal(await gemini.getGeminiThoughtSignature("call-1"), null);
  assert.equal((await backend.query("SELECT 1 FROM gemini_thought_signatures")).length, 0);

  await gemini.storeGeminiThoughtSignature("call-2", "RsigC");
  await gemini.clearGeminiThoughtSignatures();
  assert.equal(await gemini.getGeminiThoughtSignature("call-2"), null);
});

test("settings: job-state keys live in job_state and never bump the revision", async () => {
  await settings.updateSettings({ comboStrategy: "round-robin" });
  const revision = await settings.getSettingsRevision();

  await settings.updateSettings({
    model_sync_last_run: "2026-01-01T00:00:00.000Z",
    learnedRateLimits: '{"a":1}',
  });
  assert.equal(await settings.getSettingsRevision(), revision);
  const rows = await backend.query<{ namespace: string; key: string }>(
    "SELECT namespace, key FROM config_entries WHERE key IN ('model_sync_last_run','learnedRateLimits')"
  );
  assert.deepEqual(
    rows.map((r) => r.namespace),
    ["job_state", "job_state"]
  );
  const all = await settings.getSettings();
  assert.equal(all.model_sync_last_run, "2026-01-01T00:00:00.000Z");
  assert.equal(all.learnedRateLimits, '{"a":1}');

  // Mixed update: the regular key bumps the revision once, the marker still goes to job_state.
  await settings.updateSettings({ debugMode: true, codex_catalog_revalidated_version: "9" });
  assert.equal(await settings.getSettingsRevision(), revision + 1);
  assert.equal((await settings.getSettings()).codex_catalog_revalidated_version, "9");
  assert.equal(
    (
      await backend.query(
        "SELECT 1 FROM config_entries WHERE namespace='settings' AND key='codex_catalog_revalidated_version'"
      )
    ).length,
    0
  );

  // A stale row left in the settings namespace never shadows the job_state value.
  await backend.execute(
    "INSERT INTO config_entries (namespace, key, value) VALUES ('settings','model_sync_last_run','\"old\"'::jsonb)"
  );
  assert.equal((await settings.getSettings()).model_sync_last_run, "2026-01-01T00:00:00.000Z");
});

test("proxy config: concurrent edits of different providers both land", async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      settings.setProxyForLevel("provider", `prov${index}`, {
        type: "http",
        host: `h${index}`,
        port: "1",
      })
    )
  );
  const config = await settings.getProxyConfig();
  assert.equal(Object.keys(config.providers).length, 8);

  await Promise.all([
    settings.setProxyConfig({ providers: { extra: { type: "http", host: "e", port: "2" } } }),
    settings.setProxyForLevel("provider", "prov0", null),
  ]);
  const after = await settings.getProxyConfig();
  assert.equal(after.providers.extra !== undefined, true);
  assert.equal(after.providers.prov0, undefined);
  assert.equal(Object.keys(after.providers).length, 8);
});

test("param filters: the cache is not invalidated before the write commits", async () => {
  await paramFilters.setParamFilterConfig("openai", { block: [], allow: [] });
  // Warm the cache, then learn a param while a reader keeps reloading in parallel.
  await paramFilters.getParamFilterConfig("openai");
  const readers = Array.from({ length: 20 }, () => paramFilters.getParamFilterConfig("openai"));
  await Promise.all([paramFilters.addParamToBlocklist("openai", "top_k"), ...readers]);
  assert.deepEqual((await paramFilters.getParamFilterConfig("openai"))?.block, ["top_k"]);
});

test("interception rules: a write during a load is never overwritten by the stale load", async () => {
  await interception.setInterceptionRules("openai", { interceptSearch: false });
  const reads = Array.from({ length: 10 }, () => interception.getInterceptionRules("openai"));
  await Promise.all([interception.setInterceptionRules("openai", { interceptSearch: true }), ...reads]);
  assert.equal((await interception.getInterceptionRules("openai"))?.interceptSearch, true);
});

test("ip filter: a slow load cannot overwrite a finished edit", async () => {
  await ipFilter.configureIPFilter({ enabled: true, mode: "blacklist", blacklist: [] });
  ipFilter.resetIPFilter();
  await ipFilter.configureIPFilter({ enabled: true, mode: "blacklist" });
  // Force a reload (TTL expired) that overlaps a mutation.
  ipFilter.resetIPFilter();
  await ipFilter.getIPFilterConfig();
  const load = ipFilter.getIPFilterConfig();
  await ipFilter.addToBlacklist("7.7.7.7");
  await load;
  assert.equal((await ipFilter.checkIP("7.7.7.7")).allowed, false);
});

test("redis session affinity store awaits its database fallback", async () => {
  const { RedisSessionAffinityStore } = await import(
    "../../../../src/lib/db/sessionAffinity/redisStore.ts"
  );
  const down = {
    get: async () => {
      throw new Error("down");
    },
    set: async () => {
      throw new Error("down");
    },
    del: async () => {
      throw new Error("down");
    },
    eval: async () => {
      throw new Error("down");
    },
  };
  const store = new RedisSessionAffinityStore(
    async () => down,
    affinity.sqliteSessionAffinityStore,
    500
  );
  await store.upsert("s1", "openai", "conn-1", Date.now(), 60_000);
  assert.equal((await store.get("s1", "openai", 60_000))?.connectionId, "conn-1");
  assert.equal(await store.evict("s1", "openai", "conn-1"), true);
  assert.equal(await store.get("s1", "openai", 60_000), null);

  // Redis answers "no such key": the local row is cleared (awaited) before the call resolves.
  await affinity.upsertSessionAccountAffinity("s2", "openai", "conn-2", Date.now(), 60_000);
  const up = { ...down, eval: async () => [false, -2] };
  const healthy = new RedisSessionAffinityStore(
    async () => up,
    affinity.sqliteSessionAffinityStore,
    500
  );
  assert.equal(await healthy.get("s2", "openai", 60_000), null);
  assert.equal(await affinity.getSessionAccountAffinity("s2", "openai", 60_000), null);
});
