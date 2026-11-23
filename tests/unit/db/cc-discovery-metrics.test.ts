import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cc-discovery-metrics-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetTestDb } = await import("../../helpers/postgres.ts");

test.beforeEach(async () => {
  await resetTestDb();
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(async () => {
  await resetTestDb();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup
  }
});

test("getCcDiscoveryMetrics starts at zero", async () => {
  const { getCcDiscoveryMetrics } = await import("../../../src/lib/db/ccDiscoveryMetrics.ts");
  const metrics = await getCcDiscoveryMetrics();
  assert.deepEqual(metrics, { aliasRequests: 0, discoveryHits: 0, byModel: {} });
});

test("incrementCcAliasRequestCount bumps total and per-model counters", async () => {
  const { incrementCcAliasRequestCount, getCcDiscoveryMetrics } =
    await import("../../../src/lib/db/ccDiscoveryMetrics.ts");

  await incrementCcAliasRequestCount("kimi/kimi-k2.6");
  await incrementCcAliasRequestCount("kimi/kimi-k2.6");
  await incrementCcAliasRequestCount("openai/gpt-5.2");

  const metrics = await getCcDiscoveryMetrics();
  assert.equal(metrics.aliasRequests, 3);
  assert.deepEqual(metrics.byModel, {
    "kimi/kimi-k2.6": 2,
    "openai/gpt-5.2": 1,
  });
});

test("incrementCcDiscoveryHitCount bumps the discovery-hit counter", async () => {
  const { incrementCcDiscoveryHitCount, getCcDiscoveryMetrics } =
    await import("../../../src/lib/db/ccDiscoveryMetrics.ts");

  await incrementCcDiscoveryHitCount();
  await incrementCcDiscoveryHitCount();
  await incrementCcDiscoveryHitCount();

  const metrics = await getCcDiscoveryMetrics();
  assert.equal(metrics.discoveryHits, 3);
});

test("getCcDiscoveryMetrics aggregates both counters together and repeated increments sum", async () => {
  const { incrementCcAliasRequestCount, incrementCcDiscoveryHitCount, getCcDiscoveryMetrics } =
    await import("../../../src/lib/db/ccDiscoveryMetrics.ts");

  const before = await getCcDiscoveryMetrics();

  await incrementCcAliasRequestCount("combo/my-combo");
  await incrementCcAliasRequestCount("combo/my-combo");
  await incrementCcAliasRequestCount("combo/my-combo");
  await incrementCcDiscoveryHitCount();

  const after = await getCcDiscoveryMetrics();
  assert.equal(after.aliasRequests - before.aliasRequests, 3);
  assert.equal(after.discoveryHits - before.discoveryHits, 1);
  assert.equal(after.byModel["combo/my-combo"], 3);
});
