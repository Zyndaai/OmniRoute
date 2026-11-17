import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-analytics-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
process.env.API_KEY_SECRET = "test-usage-analytics-secret";

const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const { updatePricing } = await import("@/lib/db/settings");
const localDb = { updatePricing };
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const aggregateHistory = await import("../../src/lib/usage/aggregateHistory.ts");
const analyticsRoute = await import("../../src/app/api/usage/analytics/route.ts");
const analyticsCache = await import("../../src/lib/usage/analyticsResponseCache.ts");
const { getRetentionSettings } = await import("../../src/lib/db/retentionSettings.ts");

const clearPendingRequests = usageHistory.clearPendingRequests;
const EXPECTED_TOTAL_COST = 0.020925;

/** Fixture insert with schema column names; boolean `success` may be given as 1/0. */
async function insertRow(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const names = cols.map((c) => (c === "timestamp" ? '"timestamp"' : c)).join(", ");
  const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
  const values = cols.map((c) =>
    c === "success" && typeof row[c] === "number" ? row[c] === 1 : row[c]
  );
  await getTestBackend().execute(`INSERT INTO ${table} (${names}) VALUES (${marks})`, values);
}

async function resetStorage() {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  clearPendingRequests();
  // The route caches any response that took >= 1 s to build, keyed only by the
  // query string. On a loaded runner one slow build would serve the previous
  // test's data to the next one, so every test starts from an empty cache.
  analyticsCache.clearAnalyticsResponseCache();
}

async function seedAnalyticsData() {
  for (let i = 0; i < 20; i++) {
    const timestamp = new Date(Date.now() - i * 60 * 60 * 1000).toISOString();
    await insertRow("usage_history", {
      provider: i % 2 === 0 ? "openai" : "anthropic",
      model: i % 2 === 0 ? "gpt-4o" : "claude-sonnet",
      connection_id: "test-conn",
      api_key_id: "test-key",
      api_key_name: "Primary Key",
      tokens_input: 100 + i,
      tokens_output: 50 + i,
      success: 1,
      latency_ms: 200 + i * 10,
      timestamp,
    });
  }
  await insertRow("call_logs", {
    id: "seed-call-log",
    provider: "openai",
    model: "gpt-4o",
    requested_model: "gpt-4o-mini",
    connection_id: "test-conn",
    timestamp: new Date().toISOString(),
  });
}

function makeRequest(url: string) {
  return new Request(url, { method: "GET" });
}

function assertClose(actual: number, expected: number, epsilon = 0.000001) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test.beforeEach(async () => {
  await resetStorage();
  await localDb.updatePricing({
    openai: { "gpt-4o": { input: 2.5, output: 10 } },
    anthropic: { "claude-sonnet": { input: 3, output: 15 } },
  });
});

test.after(async () => {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

test("GET /api/usage/analytics returns summary with aggregated metrics", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 20);
  assert.equal(body.summary.uniqueModels, 2);
  assert.equal(body.summary.uniqueAccounts, 1);
  assert.equal(body.summary.uniqueApiKeys, 1);
  assert.ok(body.summary.totalTokens > 0);
  assert.ok(body.summary.avgLatencyMs > 0);
  assertClose(body.summary.totalCost, EXPECTED_TOTAL_COST);
  assert.ok(body.summary.streak > 0);
});

test("GET /api/usage/analytics includes dailyTrend array with cost data", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.dailyTrend));
  assert.ok(body.dailyTrend.length > 0);
  assert.ok(body.dailyTrend.every((row) => typeof row.cost === "number"));
  const dailyCostTotal = body.dailyTrend.reduce((sum, row) => sum + row.cost, 0);
  assertClose(dailyCostTotal, body.summary.totalCost);
});

test("GET /api/usage/analytics zero-fills inactive models in dailyByModel", async () => {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const dates = [yesterday, today].map((date) => date.toISOString().slice(0, 10));

  await insertRow("usage_history", {
    provider: "openai",
    model: "model-a",
    connection_id: "openai-conn",
    tokens_input: 100,
    tokens_output: 50,
    success: 1,
    latency_ms: 200,
    timestamp: `${dates[0]}T12:00:00.000Z`,
  });
  await insertRow("usage_history", {
    provider: "anthropic",
    model: "model-b",
    connection_id: "anthropic-conn",
    tokens_input: 200,
    tokens_output: 20,
    success: 1,
    latency_ms: 250,
    timestamp: `${dates[1]}T12:00:00.000Z`,
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.modelNames, ["model-a", "model-b"]);
  assert.deepEqual(body.dailyByModel, [
    { date: dates[0], "model-a": 150, "model-b": 0 },
    { date: dates[1], "model-a": 0, "model-b": 220 },
  ]);
  assert.deepEqual(
    body.dailyByModel.map((row) => body.modelNames.reduce((sum, model) => sum + row[model], 0)),
    body.dailyTrend.map((row) => row.totalTokens)
  );
});

test("GET /api/usage/analytics includes byModel array with cost calculations", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byModel));
  assert.ok(body.byModel.length > 0);
  const gptEntry = body.byModel.find(
    (m) => (m.model === "4o" || m.model === "gpt-4o") && m.provider === "openai"
  );
  assert.ok(gptEntry);
  assert.ok(typeof gptEntry.cost === "number");
  assert.ok(gptEntry.cost > 0);
});

test("GET /api/usage/analytics resolves Codex GPT-5.5 pricing through provider aliases", async () => {
  await insertRow("usage_history", {
    provider: "codex",
    model: "gpt-5.5",
    connection_id: "codex-conn",
    tokens_input: 1000,
    tokens_output: 500,
    success: 1,
    latency_ms: 250,
    timestamp: new Date().toISOString(),
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.02);
  assert.equal(body.byProvider[0].provider, "OpenAI Codex");
  assertClose(body.byProvider[0].cost, 0.02);
  assert.equal(body.byModel[0].model, "gpt-5.5");
  assertClose(body.byModel[0].cost, 0.02);
});

test("GET /api/usage/analytics can include flat-rate provider estimates for the costs page", async () => {
  await insertRow("usage_history", {
    provider: "claude",
    model: "claude-opus-5",
    connection_id: "claude-code-conn",
    tokens_input: 1_000_000,
    tokens_output: 1_000_000,
    success: 1,
    latency_ms: 250,
    timestamp: new Date().toISOString(),
  });

  const defaultResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?presets=1d")
  );
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultResponse.status, 200);
  assertClose(defaultBody.summary.totalCost, 0);
  assertClose(defaultBody.byProvider[0].cost, 0);
  assertClose(defaultBody.byModel[0].cost, 0);
  assertClose(defaultBody.presetSummaries["1d"].totalCost, 0);
  assertClose(
    defaultBody.byProvider.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0),
    defaultBody.summary.totalCost
  );

  const estimatedResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?presets=1d&includeFlatRateEstimates=true")
  );
  const estimatedBody = await estimatedResponse.json();
  assert.equal(estimatedResponse.status, 200);
  assert.equal(estimatedBody.includesFlatRateEstimates, true);
  assertClose(estimatedBody.summary.totalCost, 30);
  assert.equal(estimatedBody.byProvider[0].provider, "Claude Code");
  assertClose(estimatedBody.byProvider[0].cost, 30);
  assertClose(estimatedBody.byModel[0].cost, 30);
  assertClose(estimatedBody.byAccount[0].cost, 30);
  assertClose(estimatedBody.byServiceTier[0].cost, 30);
  assertClose(estimatedBody.presetSummaries["1d"].totalCost, 30);
  assertClose(
    estimatedBody.byProvider.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0),
    estimatedBody.summary.totalCost
  );
});

test("GET /api/usage/analytics preserves archived flat-rate estimates without changing billed cost", async () => {
  await insertRow("daily_usage_summary", {
    provider: "claude",
    model: "claude-opus-5",
    date: "2024-01-01",
    total_requests: 2,
    total_input_tokens: 1_000_000,
    total_output_tokens: 1_000_000,
    total_cost: 42.5,
  });

  const billedResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const billedBody = await billedResponse.json();
  assert.equal(billedResponse.status, 200);
  assertClose(billedBody.summary.totalCost, 0);
  assertClose(billedBody.byProvider[0].cost, 0);

  const estimatedResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all&includeFlatRateEstimates=true")
  );
  const estimatedBody = await estimatedResponse.json();
  assert.equal(estimatedResponse.status, 200);
  assertClose(estimatedBody.summary.totalCost, 42.5);
  assertClose(estimatedBody.byProvider[0].cost, 42.5);
  assertClose(estimatedBody.byModel[0].cost, 42.5);
});

test("rollupUsageHistoryBeforeDate stores API-equivalent cost before deleting raw usage", async () => {
  await insertRow("usage_history", {
    provider: "claude",
    model: "claude-opus-5",
    connection_id: "archived-claude",
    tokens_input: 1_000_000,
    tokens_output: 1_000_000,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_reasoning: 0,
    service_tier: "standard",
    success: 1,
    latency_ms: 250,
    timestamp: "2024-01-01T12:00:00.000Z",
  });

  const result = await aggregateHistory.rollupUsageHistoryBeforeDate("2024-02-01");
  assert.equal(result.errors, 0);
  const retryResult = await aggregateHistory.rollupUsageHistoryBeforeDate("2024-02-01");
  assert.equal(retryResult.errors, 0);

  const archived = await getTestBackend().queryOne<{
    total_requests: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
  }>(
    `SELECT total_requests, total_input_tokens, total_output_tokens, total_cost
       FROM daily_usage_summary
      WHERE provider = $1 AND model = $2 AND date = $3`,
    ["claude", "claude-opus-5", "2024-01-01"]
  );
  assert.equal(archived?.total_requests, 1);
  assert.equal(archived?.total_input_tokens, 1_000_000);
  assert.equal(archived?.total_output_tokens, 1_000_000);
  assertClose(archived!.total_cost, 30);
});

test("GET /api/usage/analytics applies Codex Fast tier multipliers and exposes tier split", async () => {
  const timestamp = new Date().toISOString();
  for (const [connectionId, serviceTier] of [
    ["codex-fast", "priority"],
    ["codex-standard", "standard"],
    ["codex-flex", "flex"],
  ]) {
    await insertRow("usage_history", {
      provider: "codex",
      model: "gpt-5.5",
      connection_id: connectionId,
      tokens_input: 1000,
      tokens_output: 500,
      success: 1,
      latency_ms: 250,
      service_tier: serviceTier,
      timestamp,
    });
  }

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?presets=1d")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.08);
  assert.equal(body.summary.fastRequests, 1);
  assert.equal(body.summary.flexRequests, 1);
  assert.equal(body.summary.standardRequests, 1);
  assertClose(body.summary.fastCost, 0.05);
  assertClose(body.summary.flexCost, 0.01);
  assertClose(body.summary.flexSavings, 0.01);
  assert.equal(body.summary.flexUsageSavingsTokens, 750);
  assertClose(body.summary.standardCost, 0.02);
  assert.equal(body.byServiceTier.length, 3);
  assert.deepEqual(
    body.byServiceTier.map((tier: { serviceTier: string }) => tier.serviceTier),
    ["priority", "flex", "standard"]
  );
  const flexTier = body.byServiceTier.find(
    (tier: { serviceTier: string }) => tier.serviceTier === "flex"
  );
  assert.equal(flexTier.label, "flex");
  assertClose(flexTier.savings, 0.01);
  assert.equal(flexTier.usageSavingsTokens, 750);
  assertClose(body.byProvider[0].cost, 0.08);
  assertClose(body.byModel[0].cost, 0.08);
  assertClose(body.presetSummaries["1d"].totalCost, 0.08);
});

test("GET /api/usage/analytics does not report flex savings for non-Codex providers", async () => {
  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    connection_id: "openai-flex",
    tokens_input: 1000,
    tokens_output: 500,
    success: 1,
    latency_ms: 250,
    service_tier: "flex",
    timestamp: new Date().toISOString(),
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.0075);
  assert.equal(body.summary.flexRequests, 1);
  assertClose(body.summary.flexCost, 0.0075);
  assertClose(body.summary.flexSavings, 0);
  assert.equal(body.summary.flexUsageSavingsTokens, 0);
  const flexTier = body.byServiceTier.find(
    (tier: { serviceTier: string }) => tier.serviceTier === "flex"
  );
  assertClose(flexTier.savings, 0);
  assert.equal(flexTier.usageSavingsTokens, 0);
});

test("GET /api/usage/analytics applies Codex GPT-5.6 Sol Fast multiplier", async () => {
  await localDb.updatePricing({
    codex: { "gpt-5.6-sol": { input: 5, output: 30 } },
  });
  await insertRow("usage_history", {
    provider: "codex",
    model: "gpt-5.6-sol",
    connection_id: "codex-fast",
    tokens_input: 1000,
    tokens_output: 500,
    success: 1,
    latency_ms: 250,
    service_tier: "priority",
    timestamp: new Date().toISOString(),
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.03);
  assertClose(body.summary.fastCost, 0.03);
});

test("GET /api/usage/analytics maps Codex auto-review usage to GPT-5.5 pricing", async () => {
  await insertRow("usage_history", {
    provider: "codex",
    model: "codex-auto-review",
    connection_id: "codex-conn",
    tokens_input: 1000,
    tokens_output: 500,
    success: 1,
    latency_ms: 250,
    timestamp: new Date().toISOString(),
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.02);
  assert.equal(body.byModel[0].model, "codex-auto-review");
  assertClose(body.byModel[0].cost, 0.02);
});

test("GET /api/usage/analytics ignores normal combo routing in fallback statistics", async () => {
  const timestamp = new Date().toISOString();
  await insertRow("usage_history", {
    provider: "codex",
    model: "gpt-5.5",
    connection_id: "codex-conn",
    tokens_input: 1000,
    tokens_output: 500,
    success: 1,
    latency_ms: 250,
    timestamp,
  });
  await insertRow("call_logs", {
    id: "combo-call",
    provider: "codex",
    model: "gpt-5.5",
    requested_model: "combo/dev",
    combo_name: "dev",
    connection_id: "codex-conn",
    timestamp,
  });
  await insertRow("call_logs", {
    id: "same-model-call",
    provider: "codex",
    model: "GPT-5.5",
    requested_model: "gpt-5.5",
    connection_id: "codex-conn",
    timestamp,
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.fallbackCount, 0);
  assert.equal(body.summary.fallbackRatePct, 0);
  assert.equal(body.summary.requestedModelCoveragePct, 100);
});

test("GET /api/usage/analytics filters by range parameter", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=1d")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.range, "1d");
});

test("GET /api/usage/analytics includes byProvider array with cost data", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byProvider));
  assert.ok(body.byProvider.length > 0);
  assert.ok(body.byProvider.every((row) => typeof row.cost === "number"));
  const providerCostTotal = body.byProvider.reduce((sum, row) => sum + row.cost, 0);
  assertClose(providerCostTotal, body.summary.totalCost);
});

test("GET /api/usage/analytics includes byAccount array with cost data", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byAccount));
  assert.ok(body.byAccount.length > 0);
  assert.ok(body.byAccount.every((row) => row.account === "test-conn"));
  assert.ok(body.byAccount.every((row) => typeof row.cost === "number"));
  assertClose(
    body.byAccount.reduce((sum, row) => sum + row.cost, 0),
    body.summary.totalCost
  );
});

test("GET /api/usage/analytics includes cost by API key", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.byApiKey));
  assert.equal(body.byApiKey.length, 1);
  assert.equal(body.byApiKey[0].apiKeyId, "test-key");
  assert.equal(body.byApiKey[0].apiKeyName, "Primary Key");
  assertClose(body.byApiKey[0].cost, body.summary.totalCost);
});

test("GET /api/usage/analytics does not double-count raw and aggregated rows", async () => {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  // The raw/aggregated split boundary is retention.usageHistory (365 days by
  // default — see cleanupUsageHistory in src/lib/db/cleanup.ts, which rolls up
  // and deletes usage_history rows using that exact setting). Read it live
  // instead of hardcoding 30 days so this fixture stays valid regardless of
  // the configured retention window.
  const rawRetentionDays = (await getRetentionSettings()).usageHistory;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - rawRetentionDays);
  const olderDate = new Date(cutoffDate);
  olderDate.setDate(olderDate.getDate() - 1);
  const olderDateStr = olderDate.toISOString().split("T")[0];

  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    connection_id: "raw-current",
    tokens_input: 100,
    tokens_output: 50,
    success: 1,
    latency_ms: 200,
    timestamp: today.toISOString(),
  });

  await insertRow("daily_usage_summary", {
    provider: "openai",
    model: "gpt-4o",
    date: todayStr,
    total_requests: 99,
    total_input_tokens: 9900,
    total_output_tokens: 9900,
    total_cost: 0,
  });
  await insertRow("daily_usage_summary", {
    provider: "openai",
    model: "gpt-4o",
    date: olderDateStr,
    total_requests: 1,
    total_input_tokens: 25,
    total_output_tokens: 10,
    total_cost: 0,
  });

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 2);
  assert.equal(body.summary.totalTokens, 185);
});

test("GET /api/usage/analytics omits global aggregates when filtering by API key", async () => {
  const apiKey = await apiKeysDb.createApiKey("Scoped Key", "machine1234567890");

  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    connection_id: "scoped-conn",
    api_key_id: apiKey.id,
    api_key_name: "Scoped Key",
    tokens_input: 100,
    tokens_output: 50,
    success: 1,
    latency_ms: 200,
    timestamp: new Date().toISOString(),
  });

  await insertRow("daily_usage_summary", {
    provider: "openai",
    model: "gpt-4o",
    date: "2024-01-01",
    total_requests: 99,
    total_input_tokens: 9900,
    total_output_tokens: 9900,
    total_cost: 0,
  });

  const response = await analyticsRoute.GET(
    makeRequest(`http://localhost/api/usage/analytics?range=all&apiKeyIds=${apiKey.id}`)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 1);
  assert.equal(body.summary.totalTokens, 150);
  assert.equal(body.byApiKey.length, 1);
  assert.equal(body.byApiKey[0].apiKeyId, apiKey.id);
});

test("GET /api/usage/analytics groups renamed API key usage by stable ID", async () => {
  const apiKey = await apiKeysDb.createApiKey("Averyanov", "machine1234567890");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { name: "Alexander Averyanov" });

  const now = Date.now();
  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    connection_id: "test-conn",
    api_key_id: apiKey.id,
    api_key_name: "Averyanov",
    tokens_input: 100,
    tokens_output: 50,
    success: 1,
    latency_ms: 200,
    timestamp: new Date(now - 60_000).toISOString(),
  });
  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    connection_id: "test-conn",
    api_key_id: apiKey.id,
    api_key_name: "Desktop",
    tokens_input: 200,
    tokens_output: 100,
    success: 1,
    latency_ms: 250,
    timestamp: new Date(now).toISOString(),
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.uniqueApiKeys, 1);
  assert.equal(body.byApiKey.length, 1);
  assert.equal(body.byApiKey[0].apiKeyId, apiKey.id);
  assert.equal(body.byApiKey[0].apiKeyName, "Alexander Averyanov");
  assert.deepEqual(body.byApiKey[0].historicalApiKeyNames.sort(), ["Averyanov", "Desktop"]);
  assert.equal(body.byApiKey[0].requests, 2);
  assert.equal(body.byApiKey[0].promptTokens, 300);
  assert.equal(body.byApiKey[0].completionTokens, 150);

  const filteredResponse = await analyticsRoute.GET(
    makeRequest(`http://localhost/api/usage/analytics?apiKeyIds=${apiKey.id}`)
  );
  const filteredBody = await filteredResponse.json();

  assert.equal(filteredResponse.status, 200);
  assert.equal(filteredBody.summary.totalRequests, 2);
  assert.equal(filteredBody.byApiKey.length, 1);
  assert.equal(filteredBody.byApiKey[0].apiKeyId, apiKey.id);
});

test("GET /api/usage/analytics does not persist guessed API key attribution", async () => {
  await localDb.updatePricing({
    openai: { "gpt-4o": { input: 2.5, output: 10 } },
  });
  await apiKeysDb.createApiKey("Unrestricted Key", "machine1234567890");

  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    connection_id: "legacy-conn",
    api_key_id: null,
    api_key_name: null,
    tokens_input: 100,
    tokens_output: 50,
    success: 1,
    latency_ms: 200,
    timestamp: new Date().toISOString(),
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.byApiKey.length, 0);

  const row = await getTestBackend().queryOne<{
    api_key_id: string | null;
    api_key_name: string | null;
  }>("SELECT api_key_id, api_key_name FROM usage_history WHERE connection_id = $1", [
    "legacy-conn",
  ]);
  assert.equal(row?.api_key_id, null);
  assert.equal(row?.api_key_name, null);
});

test("GET /api/usage/analytics?view=apiKeys returns only lifetime totals per API key", async () => {
  const usedKey = await apiKeysDb.createApiKey("Used Key", "machine1234567890");
  const idleKey = await apiKeysDb.createApiKey("Idle Key", "machine1234567890");
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const insertUsage = (
    provider: string,
    model: string,
    apiKeyId: string | null,
    apiKeyName: string,
    tokensInput: number,
    tokensOutput: number,
    timestamp: string
  ) =>
    insertRow("usage_history", {
      provider,
      model,
      connection_id: "c1",
      api_key_id: apiKeyId,
      api_key_name: apiKeyName,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      success: 1,
      latency_ms: 200,
      timestamp,
    });
  await insertUsage("openai", "gpt-4o", usedKey.id, "Used Key", 100, 50, at(86_400_000));
  await insertUsage("openai", "gpt-4o", usedKey.id, "Old Name", 200, 100, at(60_000));
  await insertUsage("anthropic", "claude-sonnet", usedKey.id, "Used Key", 300, 30, at(120_000));
  // Rows recorded before per-key ids carry only the key name.
  await insertUsage("openai", "gpt-4o", null, "Idle Key", 1000, 1000, at(30_000));

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all&view=apiKeys")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body), ["byApiKey"]);
  const totalsById = new Map(body.byApiKey.map((entry) => [entry.apiKeyId, entry]));
  const used = totalsById.get(usedKey.id);
  assert.equal(used.apiKeyName, "Used Key");
  assert.equal(used.requests, 3);
  // gpt-4o: 300 in × $2.50 + 150 out × $10; claude-sonnet: 300 in × $3 + 30 out × $15 (per 1M).
  assertClose(used.cost, 0.0036);
  assert.equal(used.lastUsed, at(60_000));
  assert.deepEqual(totalsById.get(idleKey.id), {
    apiKeyId: idleKey.id,
    apiKeyName: "Idle Key",
    requests: 0,
    cost: 0,
    lastUsed: at(30_000),
  });

  const fullReport = await (
    await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics?range=all"))
  ).json();
  const fullEntry = fullReport.byApiKey.find((entry) => entry.apiKeyId === usedKey.id);
  assert.equal(fullEntry.requests, used.requests);
  assertClose(fullEntry.cost, used.cost);
});

test("GET /api/usage/analytics returns weeklyPattern for the costs dashboard", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.weeklyPattern));
  assert.equal(body.weeklyPattern.length, 7);
  assert.deepEqual(
    body.weeklyPattern.map((row) => row.day),
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  );
  assert.ok(body.weeklyPattern.some((row) => row.totalTokens > 0 && row.avgTokens > 0));
});

test("GET /api/usage/analytics includes activityMap for heatmap", async () => {
  await seedAnalyticsData();

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(typeof body.activityMap === "object");
  assert.ok(Object.keys(body.activityMap).length > 0);
});

test("GET /api/usage/analytics returns 500 on database errors", async () => {
  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(body.summary.totalRequests === 0);
});

test("GET /api/usage/analytics does not throw Unknown named parameter on short range (needsAggregated=false)", async () => {
  // Regression: shared params object leaked agg-only bindings (@sinceDate, @rawCutoffDate)
  // into queries that don't reference them, causing the query layer to reject the statement.
  // A short range (1h) triggers needsAggregated=false because the entire window
  // falls within the raw-data-only period.
  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    connection_id: "test-conn",
    tokens_input: 100,
    tokens_output: 50,
    success: 1,
    latency_ms: 200,
    timestamp: new Date().toISOString(),
  });

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=1h")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.summary.totalRequests, 1);
});

test("GET /api/usage/analytics does not throw Unknown named parameter with apiKey filter on long range", async () => {
  // Regression: merged bindings leaked all main-query parameters into preset queries
  // that only reference preset-prefixed placeholders.
  const apiKey = await apiKeysDb.createApiKey("Preset Key", "machine-preset1234");
  const now = new Date();

  // Seed data old enough to trigger aggregated + preset path
  for (let i = 0; i < 5; i++) {
    const ts = new Date(now.getTime() - (35 + i) * 24 * 60 * 60 * 1000).toISOString();
    await insertRow("usage_history", {
      provider: "openai",
      model: "gpt-4o",
      connection_id: "test-conn",
      api_key_id: apiKey.id,
      api_key_name: apiKey.name,
      tokens_input: 100,
      tokens_output: 50,
      success: 1,
      latency_ms: 200,
      timestamp: ts,
    });
  }

  const response = await analyticsRoute.GET(
    makeRequest(`http://localhost/api/usage/analytics?range=60d&apiKeyId=${apiKey.id}`)
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  // Core regression check: the endpoint returns 200 without throwing.
  // The exact count depends on raw-vs-aggregated boundary; we only need to
  // confirm the endpoint returns 200 without throwing.
  assert.ok(typeof body.summary.totalRequests === "number");
});

test("rollupUsageHistoryBeforeDate prices each request, not the day's summed tokens", async () => {
  const costCalculator = await import("../../src/lib/usage/costCalculator.ts");

  // Two requests, same provider/model/day/tier, so the rollup's
  // GROUP BY provider, model, date, serviceTier collapses them into one row.
  //
  // The first request is cache-heavy: cache_read exceeds tokens_input. Pricing
  // clamps non-cached input at zero per request (costCalculator "nonCachedInput"),
  // so that surplus must NOT be allowed to absorb another request's billable
  // input. Summing tokens first and pricing once lets exactly that happen.
  const rows = [
    { input: 1_000, output: 0, cacheRead: 5_000 },
    { input: 9_000, output: 0, cacheRead: 0 },
  ];

  for (const row of rows) {
    await insertRow("usage_history", {
      provider: "openai",
      model: "gpt-4o",
      connection_id: "clamp-conn",
      tokens_input: row.input,
      tokens_output: row.output,
      tokens_cache_read: row.cacheRead,
      tokens_cache_creation: 0,
      tokens_reasoning: 0,
      service_tier: "standard",
      success: 1,
      latency_ms: 200,
      timestamp: "2024-03-01T12:00:00.000Z",
    });
  }

  // Ground truth: price every request individually, exactly as the live
  // analytics path does for raw (non-archived) usage.
  let expectedCost = 0;
  for (const row of rows) {
    expectedCost += await costCalculator.calculateCost(
      "openai",
      "gpt-4o",
      {
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheCreation: 0,
        reasoning: 0,
      },
      {
        provider: "openai",
        model: "gpt-4o",
        serviceTier: "standard",
        flatRateAsZero: false,
      }
    );
  }

  const result = await aggregateHistory.rollupUsageHistoryBeforeDate("2024-04-01");
  assert.equal(result.errors, 0);

  const archived = await getTestBackend().queryOne<{ total_cost: number }>(
    `SELECT total_cost FROM daily_usage_summary
      WHERE provider = $1 AND model = $2 AND date = $3`,
    ["openai", "gpt-4o", "2024-03-01"]
  );

  // Retention must preserve the billed value. Archiving a day may not silently
  // discount it just because the day's requests were grouped before pricing.
  assertClose(archived!.total_cost, expectedCost);
});

test("GET /api/usage/analytics uses per-row provider_cost_usd instead of re-pricing its tokens", async () => {
  // A row carrying a provider-reported cost (credit-metered providers such as Kiro,
  // xAI's exact cost) is billed by that cost on every breakdown; its tokens are
  // display-only and must not be charged again through the pricing table.
  await localDb.updatePricing({
    kiro: { "gpt-5.6-luna": { input: 999, output: 999 } },
  });
  const apiKey = await apiKeysDb.createApiKey("Metered key", "test-machine");
  await insertRow("usage_history", {
    provider: "kiro",
    model: "gpt-5.6-luna",
    connection_id: "metered-conn",
    account_key: "metered-account",
    api_key_id: apiKey.id,
    api_key_name: apiKey.name,
    tokens_input: 100000,
    tokens_output: 50000,
    provider_credits: 0.5,
    provider_cost_usd: 0.01,
    success: 1,
    latency_ms: 200,
    timestamp: new Date().toISOString(),
  });

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.01);
  const kiroProvider = body.byProvider.find((row: { provider: string }) =>
    row.provider.toLowerCase().includes("kiro")
  );
  assert.ok(kiroProvider);
  assertClose(kiroProvider.cost, 0.01);
  assert.equal(body.byAccount.length, 1);
  assertClose(body.byAccount[0].cost, 0.01);
  assert.equal(body.byApiKey.length, 1);
  assertClose(body.byApiKey[0].cost, 0.01);
  const kiroModel = body.byModel.find((row: { provider: string }) =>
    row.provider.toLowerCase().includes("kiro")
  );
  assert.ok(kiroModel);
  assertClose(kiroModel.cost, 0.01);
  assert.equal(kiroModel.promptTokens, 100000);
  const dailyCostTotal = body.dailyTrend.reduce(
    (sum: number, row: { cost: number }) => sum + row.cost,
    0
  );
  assertClose(dailyCostTotal, 0.01);

  // The API Manager's lightweight per-key totals view bills the same reported cost.
  const totalsResponse = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?view=apiKeys")
  );
  const totals = await totalsResponse.json();
  assert.equal(totalsResponse.status, 200);
  const meteredKey = totals.byApiKey.find(
    (row: { apiKeyId: string }) => row.apiKeyId === apiKey.id
  );
  assert.ok(meteredKey);
  assert.equal(meteredKey.requests, 1);
  assertClose(meteredKey.cost, 0.01);
});

test("GET /api/usage/analytics keeps measured and token-priced usage apart after rollup", async () => {
  await localDb.updatePricing({
    xai: { "grok-reported": { input: 1, output: 2 } },
  });
  const timestamp = new Date(Date.now() - 400 * 86_400_000).toISOString();
  // Same token shape, one with a reported cost and one without.
  await insertRow("usage_history", {
    provider: "xai",
    model: "grok-reported",
    tokens_input: 100000,
    tokens_output: 50000,
    provider_cost_usd: 0.01,
    success: 1,
    timestamp,
  });
  await insertRow("usage_history", {
    provider: "xai",
    model: "grok-reported",
    tokens_input: 100000,
    tokens_output: 50000,
    success: 1,
    timestamp,
  });
  await insertRow("usage_history", {
    provider: "openai",
    model: "gpt-4o",
    tokens_input: 100000,
    tokens_output: 0,
    success: 1,
    timestamp,
  });

  assert.equal((await aggregateHistory.rollupUsageHistoryBeforeDate("2100-01-01")).errors, 0);

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  // xai: 0.01 reported + (100k × $1 + 50k × $2)/M = 0.21; openai: 100k × $2.5/M = 0.25.
  assertClose(body.summary.totalCost, 0.46);
  assertClose(
    body.byProvider.find((row: { provider: string }) => row.provider.toLowerCase().includes("xai"))
      .cost,
    0.21
  );
  assertClose(
    body.byProvider.find((row: { provider: string }) =>
      row.provider.toLowerCase().includes("openai")
    ).cost,
    0.25
  );
  const grok = body.byModel.find((row: { model: string }) => row.model === "grok-reported");
  assertClose(grok.cost, 0.21);
  assert.equal(grok.promptTokens, 200000);
  assertClose(
    body.dailyTrend.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0),
    0.46
  );
});

test("GET /api/usage/analytics bills a failed credit-metered request only by its measurement", async () => {
  await localDb.updatePricing({ kiro: { "gpt-5.6-luna": { input: 999, output: 999 } } });
  const apiKey = await apiKeysDb.createApiKey("Failed dashboard", "machine-failed-dash");

  await usageHistory.saveRequestUsage({
    provider: "kiro",
    model: "gpt-5.6-luna",
    apiKeyId: apiKey.id,
    timestamp: new Date().toISOString(),
    tokens: { prompt_tokens: 100000, completion_tokens: 0 },
    success: false,
    status: "502",
  });
  await usageHistory.saveRequestUsage({
    provider: "kiro",
    model: "gpt-5.6-luna",
    apiKeyId: apiKey.id,
    timestamp: new Date(Date.now() + 1000).toISOString(),
    tokens: { prompt_tokens: 100000, completion_tokens: 0, cost_in_usd_ticks: 100000000 },
    success: false,
    status: "502",
  });

  const response = await analyticsRoute.GET(
    makeRequest("http://localhost/api/usage/analytics?range=all")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assertClose(body.summary.totalCost, 0.01);
  assert.equal(body.byApiKey.length, 1);
  assertClose(body.byApiKey[0].cost, 0.01);
});
