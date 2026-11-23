import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pricing-13891-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const { getPricingForModel, updatePricing } = await import("../../../src/lib/db/settings/pricing.ts");

describe("getPricingForModel — issue #13891 (uncached getPricing rebuild per call)", () => {
  before(async () => {
    await resetTestDb();
  });

  after(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("hits the DB at most once across many repeated lookups (simulating usageStats' 531 groups/request)", async () => {
    const backend = getTestBackend();
    const originalQuery = backend.query.bind(backend);
    let pricingQueries = 0;
    backend.query = ((sql: string, params?: unknown[]) => {
      if (sql.includes("FROM model_pricing WHERE source")) pricingQueries++;
      return originalQuery(sql, params as never);
    }) as typeof backend.query;

    try {
      for (let i = 0; i < 20; i++) {
        await getPricingForModel("openai", "gpt-4o");
      }
    } finally {
      backend.query = originalQuery as typeof backend.query;
    }

    assert.ok(
      pricingQueries <= 3,
      `expected getPricingForModel() to be served from the pricing cache after the ` +
        `first call (<=3 pricing queries across 20 lookups), but it re-queried the ` +
        `DB ${pricingQueries} times`
    );
  });

  it("picks up fresh pricing immediately after a write invalidates the cache", async () => {
    // Warm the cache with the pre-write price.
    const before = await getPricingForModel("acme-test-provider", "acme-test-model");
    assert.equal(before, null);

    // A pricing write (updatePricing -> touchPricing -> invalidateDbCache("pricing"))
    // must invalidate the 30s TTL cache so the very next lookup is not stale.
    await updatePricing({
      "acme-test-provider": {
        "acme-test-model": { inputCostPerToken: 0.000123, outputCostPerToken: 0.000456 },
      },
    });

    const after = await getPricingForModel("acme-test-provider", "acme-test-model");
    assert.ok(after, "expected fresh pricing to be visible right after updatePricing()");
    assert.equal((after as { inputCostPerToken?: number }).inputCostPerToken, 0.000123);
  });
});
