import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  getSyncedPricing,
  saveSyncedPricing,
  clearSyncedPricing,
} from "../../../src/lib/pricingSync.ts";
import { getTestBackend } from "../../helpers/postgres.ts";

describe("getSyncedPricing memoization", () => {
  before(async () => {
    await saveSyncedPricing({
      openai: {
        "gpt-4o": { input: 2.5, output: 10 },
      },
    });
  });

  after(async () => {
    try {
      await clearSyncedPricing();
    } catch {
      // ignore
    }
  });

  it("returns the same object reference for repeated reads within the same cache version", async () => {
    const first = await getSyncedPricing();
    const second = await getSyncedPricing();
    const third = await getSyncedPricing();
    // The saturation bug rebuilt a fresh object on every call; resolveCatalogPricing()
    // calls this per model, so a fresh object per call re-ran the SELECT + JSON.parse
    // and rebuilt the findInsensitive() lowercase index per lookup (~400 warnings/s).
    assert.equal(second, first);
    assert.equal(third, first);
  });

  it("hits the DB once for repeated reads within the same cache version", async () => {
    const backend = getTestBackend();
    const originalQuery = backend.query.bind(backend);
    let queries = 0;
    backend.query = ((sql: string, params?: unknown[]) => {
      if (sql.includes("FROM model_pricing")) queries++;
      return originalQuery(sql, params as never);
    }) as typeof backend.query;

    try {
      await getSyncedPricing();
      await getSyncedPricing();
      await getSyncedPricing();
    } finally {
      backend.query = originalQuery as typeof backend.query;
    }

    // Memoized, 3 calls should cost at most 1 real DB round-trip (0 if a prior
    // test already warmed the cache at the same version).
    assert.ok(queries <= 1, `expected at most 1 model_pricing query across 3 reads, got ${queries}`);
  });

  it("returns a new reference with fresh data after a pricing write invalidates the cache", async () => {
    const warm = await getSyncedPricing(); // warm the memo at the current cache version
    await saveSyncedPricing({
      anthropic: { "claude-x": { input: 1, output: 2 } },
    });
    const pricing = await getSyncedPricing();
    assert.notEqual(pricing, warm, "invalidation must rebuild, not reuse the stale object");
    assert.ok(pricing.anthropic, "cache should reflect the write, not a stale snapshot");
    assert.equal(pricing.anthropic["claude-x"].input, 1);
  });
});
