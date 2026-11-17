import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-analytics-memo-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
process.env.API_KEY_SECRET = "test-usage-analytics-memoization-secret";

const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const { updatePricing } = await import("@/lib/db/settings");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const cache = await import("../../src/lib/usage/analyticsResponseCache.ts");
const analyticsRoute = await import("../../src/app/api/usage/analytics/route.ts");

async function resetStorage() {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  cache.clearAnalyticsResponseCache();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  usageHistory.clearPendingRequests();
}

/** Inserts `count` successful rows for one model, one second apart, in a single statement. */
async function seedHistory(provider: string, model: string, count: number, serviceTier?: string) {
  await getTestBackend().execute(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, service_tier, "timestamp")
     SELECT $1, $2, $3, 100 + i, 50, true, 200, $4, $5::timestamptz - make_interval(secs => i)
       FROM generate_series(0, $6::int - 1) AS i`,
    [provider, model, `${provider}-conn`, serviceTier ?? "standard", new Date().toISOString(), count]
  );
}

function makeRequest(url: string) {
  return new Request(url, { method: "GET" });
}

test.beforeEach(async () => {
  await resetStorage();
  process.env.OMNIROUTE_ANALYTICS_CACHE_TTL_MS = "0";
  process.env.OMNIROUTE_ANALYTICS_CACHE_MIN_COMPUTE_MS = "0";
});

test.after(async () => {
  cache.clearAnalyticsResponseCache();
  delete process.env.OMNIROUTE_ANALYTICS_CACHE_TTL_MS;
  delete process.env.OMNIROUTE_ANALYTICS_CACHE_MIN_COMPUTE_MS;
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

test("10000 rows over 5 models resolve pricing once per pair with identical amounts", async () => {
  await updatePricing({
    openai: {
      "memo-model-a": { input: 2.5, output: 10 },
      "memo-model-b": { input: 2.5, output: 10 },
      "memo-model-c": { input: 2.5, output: 10 },
      "memo-model-d": { input: 2.5, output: 10 },
      "memo-model-e": { input: 2.5, output: 10 },
    },
  });
  for (const model of [
    "memo-model-a",
    "memo-model-b",
    "memo-model-c",
    "memo-model-d",
    "memo-model-e",
  ]) {
    await seedHistory("openai", model, 2000);
  }
  const misses = { count: 0 };
  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?memo=t1"),
    { misses } as never
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(misses.count, 5);
  assert.ok(body.summary.totalCost > 0);

  const reference = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?memo=t1ref")
  );
  const referenceBody = await reference.json();
  assert.equal(referenceBody.summary.totalCost, body.summary.totalCost);
});

test("model without pricing costs zero with and without memoization", async () => {
  await updatePricing({ openai: { "memo-known": { input: 2.5, output: 10 } } });
  await seedHistory("openai", "memo-unknown-model", 5);
  const misses = { count: 0 };
  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?memo=t2"),
    { misses } as never
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.summary.totalCost, 0);
  assert.equal(misses.count, 1);
});

test("same model under two providers resolves two price grids", async () => {
  await updatePricing({
    openai: { "memo-shared": { input: 2.5, output: 10 } },
    anthropic: { "memo-shared": { input: 30, output: 150 } },
  });
  await seedHistory("openai", "memo-shared", 3);
  await seedHistory("anthropic", "memo-shared", 3);
  const misses = { count: 0 };
  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?memo=t3"),
    { misses } as never
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(misses.count, 2);
  assert.ok(body.summary.totalCost > 0);
});

test("priority service tier keeps the same amount with and without memoization", async () => {
  await updatePricing({ codex: { "memo-codex-model": { input: 5, output: 20 } } });
  await seedHistory("codex", "memo-codex-model", 2, "priority");
  const misses = { count: 0 };
  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?memo=t4"),
    { misses } as never
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.summary.totalCost > 0);

  const reference = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?memo=t4ref")
  );
  const referenceBody = await reference.json();
  assert.equal(referenceBody.summary.totalCost, body.summary.totalCost);
});
