import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getCacheMetrics } from "../../../src/lib/db/settings.ts";
import { getTestBackend } from "../../helpers/postgres.ts";

const INSERT_USAGE = `
  INSERT INTO usage_history (provider, model, connection_id, api_key_id, api_key_name,
    tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
    status, success, latency_ms, ttft_ms, error_code, "timestamp")
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
`;

describe("Cache Metrics Database", () => {
  let db: ReturnType<typeof getTestBackend>;

  before(() => {
    db = getTestBackend();
  });

  after(async () => {
    // Clean up test data
    await db.execute("DELETE FROM usage_history WHERE provider = 'test-provider'");
  });

  describe("getCacheMetrics", () => {
    test("returns metrics even with no cache activity", async () => {
      // Verify the function works even if usage_history has data but no cache activity
      const metrics = await getCacheMetrics();

      assert.ok(metrics.totalRequests >= 0);
      assert.ok(metrics.totalInputTokens >= 0);
      assert.ok(metrics.totalCachedTokens >= 0);
      assert.ok(metrics.totalCacheCreationTokens >= 0);
      assert.ok(metrics.tokensSaved >= 0);
      assert.ok(metrics.lastUpdated);
    });

    test("returns aggregated metrics from usage_history", async () => {
      // Clean up any existing test data first
      await db.execute("DELETE FROM usage_history WHERE provider = 'test-provider'");

      const now = new Date().toISOString();

      await db.execute(INSERT_USAGE, [
        "test-provider",
        "test-model",
        "test-connection",
        "test-key-id",
        "test-key",
        1000, // tokens_input
        500, // tokens_output
        400, // tokens_cache_read
        200, // tokens_cache_creation
        0, // tokens_reasoning
        "200", // status
        true, // success
        100, // latency_ms
        50, // ttft_ms
        null, // error_code
        now, // timestamp
      ]);

      // Insert another row
      await db.execute(INSERT_USAGE, [
        "test-provider",
        "test-model",
        "test-connection",
        "test-key-id",
        "test-key",
        500, // tokens_input
        300, // tokens_output
        200, // tokens_cache_read
        100, // tokens_cache_creation
        0, // tokens_reasoning
        "200", // status
        true, // success
        80, // latency_ms
        40, // ttft_ms
        null, // error_code
        now, // timestamp
      ]);

      const metrics = await getCacheMetrics();

      // Should have at least the 2 test requests with cache activity
      assert.ok(metrics.requestsWithCacheControl >= 2);
      assert.ok(metrics.totalInputTokens >= 1500);
      assert.ok(metrics.totalCachedTokens >= 600);
      assert.ok(metrics.totalCacheCreationTokens >= 300);
      assert.ok(metrics.tokensSaved >= 600);

      // Check provider breakdown
      assert.ok(metrics.byProvider["test-provider"]);
      assert.ok(metrics.byProvider["test-provider"].requests >= 2);
      assert.ok(metrics.byProvider["test-provider"].totalRequests >= 2);
      assert.ok(metrics.byProvider["test-provider"].cachedRequests >= 2);
      assert.ok(metrics.byProvider["test-provider"].inputTokens >= 1500);
      assert.ok(metrics.byProvider["test-provider"].cachedTokens >= 600);
      assert.ok(metrics.byProvider["test-provider"].cacheCreationTokens >= 300);

      // Clean up
      await db.execute("DELETE FROM usage_history WHERE provider = 'test-provider'");
    });
  });
});
