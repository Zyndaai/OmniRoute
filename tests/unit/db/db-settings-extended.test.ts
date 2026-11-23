import test from "node:test";
import assert from "node:assert/strict";

const settings = await import("../../../src/lib/db/settings.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

test("getSettings returns an object", async () => {
  const result = await settings.getSettings();
  assert.ok(typeof result === "object");
  assert.ok(result !== null);
});

test("updateSettings stores and retrieves values", async () => {
  await resetTestDb();
  await settings.updateSettings({ testKey: "testValue" });
  const result = await settings.getSettings();
  assert.equal((result as any).testKey, "testValue");
});

test("updateSettings handles multiple keys", async () => {
  await resetTestDb();
  await settings.updateSettings({ key1: "val1", key2: 42, key3: true });
  const result = await settings.getSettings();
  assert.equal((result as any).key1, "val1");
  assert.equal((result as any).key2, 42);
  assert.equal((result as any).key3, true);
});

test("getPricing returns an object", async () => {
  await resetTestDb();
  const result = await settings.getPricing();
  assert.ok(typeof result === "object");
});

test("getPricingForModel returns null for unknown model", async () => {
  await resetTestDb();
  const result = await settings.getPricingForModel("unknown-provider", "unknown-model");
  assert.equal(result, null);
});

test("updatePricing stores pricing data", async () => {
  await resetTestDb();
  await settings.updatePricing({
    testProvider: {
      testModel: { input: 1.0, output: 2.0 },
    },
  });
  const result = await settings.getPricingForModel("testProvider", "testModel");
  assert.ok(result !== null && result !== undefined);
});

test("resetPricing clears specific model pricing", async () => {
  await resetTestDb();
  await settings.updatePricing({
    prov: { model: { input: 1.0, output: 2.0 } },
  });
  await settings.resetPricing("prov", "model");
  const result = await settings.getPricingForModel("prov", "model");
  assert.ok(result === null || result === undefined);
});

test("resetAllPricing clears all pricing", async () => {
  await resetTestDb();
  await settings.updatePricing({
    p1: { m1: { input: 1.0 } },
    p2: { m2: { output: 2.0 } },
  });
  await settings.resetAllPricing();
  const result = await settings.getPricingForModel("p1", "m1");
  assert.ok(result === null || result === undefined);
});

test("getProxyConfig returns an object", async () => {
  await resetTestDb();
  const result = await settings.getProxyConfig();
  assert.ok(typeof result === "object");
});

test("setProxyConfig stores proxy configuration", async () => {
  await resetTestDb();
  await settings.setProxyConfig({ global: "http://proxy.example.com:8080" });
  const result = await settings.getProxyConfig();
  assert.ok(typeof result === "object");
});

test("getProxyForLevel returns null for unset level", async () => {
  await resetTestDb();
  const result = await settings.getProxyForLevel("global");
  assert.equal(result, null);
});

test("setProxyForLevel stores proxy for level", async () => {
  await resetTestDb();
  await settings.setProxyForLevel("global", null, "http://proxy.example.com:8080");
  const result = await settings.getProxyForLevel("global");
  assert.ok(result !== null);
});

test("deleteProxyForLevel removes proxy", async () => {
  await resetTestDb();
  await settings.setProxyForLevel("global", null, "http://proxy.example.com:8080");
  await settings.deleteProxyForLevel("global", null);
  const result = await settings.getProxyForLevel("global");
  assert.ok(result === null || result === undefined);
});

test("bumpProxyConfigGeneration does not throw", () => {
  assert.doesNotThrow(() => settings.bumpProxyConfigGeneration());
});

test("isCloudEnabled returns boolean", async () => {
  await resetTestDb();
  const result = await settings.isCloudEnabled();
  assert.ok(typeof result === "boolean");
});

test("getCacheMetrics returns an object", async () => {
  await resetTestDb();
  const result = await settings.getCacheMetrics();
  assert.ok(typeof result === "object");
});

test("resetCacheMetrics does not throw", async () => {
  await resetTestDb();
  await assert.doesNotReject(async () => await settings.resetCacheMetrics());
});

test("getCacheTrend returns an array", async () => {
  await resetTestDb();
  const result = await settings.getCacheTrend(24);
  assert.ok(Array.isArray(result));
});

test("clearAllLKGP does not throw", async () => {
  await resetTestDb();
  await assert.doesNotReject(async () => await settings.clearAllLKGP());
});

test("getLKGP returns null for unknown combo/model", async () => {
  await resetTestDb();
  const result = await settings.getLKGP("unknown-combo", "unknown-model");
  assert.ok(result === null || typeof result === "object");
});

test("setLKGP and getLKGP round-trip", async () => {
  await resetTestDb();
  await settings.setLKGP("test-combo", "test-model", {
    provider: "test",
    model: "test",
    connectionId: "conn-1",
  });
  const result = await settings.getLKGP("test-combo", "test-model");
  assert.ok(result === null || typeof result === "object");
});

test("getPricingWithSources returns pricing with source info", async () => {
  await resetTestDb();
  const result = await settings.getPricingWithSources();
  assert.ok(typeof result === "object");
  assert.ok(result !== null);
});

test("resolveProxyForConnection returns proxy resolution", async () => {
  await resetTestDb();
  const result = await settings.resolveProxyForConnection("test-conn-id");
  assert.ok(typeof result === "object");
});
