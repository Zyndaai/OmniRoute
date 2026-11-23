import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-usage-analytics-model-dedup-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;
process.env.API_KEY_SECRET = "test-usage-analytics-model-dedup-secret";

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const usageHistory = await import("../../../src/lib/usage/usageHistory.ts");
const analyticsRoute = await import("../../../src/app/api/usage/analytics/route.ts");
const { normalizeModelName } = await import("../../../src/lib/usage/costCalculator.ts");

function makeRequest(url: string) {
  return new Request(url, { method: "GET" });
}

test.beforeEach(async () => {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  usageHistory.clearPendingRequests();
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

test("#7535: byModel must not list the same logical model twice under one raw/one prefixed id", async () => {
  const now = new Date();
  const backend = getTestBackend();
  const insertSql = `INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name, tokens_input, tokens_output, success, latency_ms, "timestamp")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

  await backend.execute(insertSql, [
    "zai",
    "glm-5.2",
    "test-conn",
    "test-key",
    "Primary Key",
    100,
    50,
    true,
    200,
    now.toISOString(),
  ]);
  await backend.execute(insertSql, [
    "zai",
    "z-ai/glm-5.2",
    "test-conn",
    "test-key",
    "Primary Key",
    80,
    40,
    true,
    150,
    new Date(now.getTime() - 60_000).toISOString(),
  ]);

  assert.equal(normalizeModelName("glm-5.2"), "glm-5.2");
  assert.equal(normalizeModelName("z-ai/glm-5.2"), "glm-5.2");

  const response = await analyticsRoute.GET(makeRequest("http://localhost/api/usage/analytics"));
  const body = await response.json();

  assert.equal(response.status, 200);
  const glmEntries = body.byModel.filter((row: { model: string }) => row.model === "glm-5.2");
  assert.equal(
    glmEntries.length,
    1,
    `expected exactly one "glm-5.2" row in byModel, got ${glmEntries.length}: ${JSON.stringify(glmEntries)} (#7535)`
  );
  assert.equal(
    glmEntries[0].requests,
    2,
    "the two raw spellings should merge into one aggregated row"
  );
});
