import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { getTestBackend } from "../helpers/postgres.ts";
import {
  getModelsDevPricing,
  saveModelsDevPricing,
  clearModelsDevPricing,
  type PricingByProvider,
} from "../../src/lib/modelsDevSync.ts";

describe("getModelsDevPricing memoization (#8697)", () => {
  before(async () => {
    const pricing: PricingByProvider = {
      openai: {
        "gpt-4o": { input: 2.5, output: 10 },
      },
    };
    await saveModelsDevPricing(pricing);
  });

  after(async () => {
    try {
      await clearModelsDevPricing();
    } catch {
      // ignore
    }
  });

  it("hits the DB once for repeated reads within the same cache version", async () => {
    // Count every statement the backend issues while the three reads run.
    const backend = getTestBackend() as unknown as Record<
      "query" | "queryOne" | "execute",
      (sql: string, ...rest: unknown[]) => Promise<unknown>
    >;
    const originals = {
      query: backend.query,
      queryOne: backend.queryOne,
      execute: backend.execute,
    };
    let statements = 0;
    for (const name of ["query", "queryOne", "execute"] as const) {
      const original = originals[name];
      backend[name] = function (sql: string, ...rest: unknown[]) {
        statements++;
        return original.call(backend, sql, ...rest);
      };
    }

    try {
      await getModelsDevPricing();
      await getModelsDevPricing();
      await getModelsDevPricing();
    } finally {
      backend.query = originals.query;
      backend.queryOne = originals.queryOne;
      backend.execute = originals.execute;
    }

    // The N+1 bug re-runs the SELECT + JSON.parse on every call — memoized,
    // 3 calls should cost at most 1 real DB round-trip (0 if a prior test
    // already warmed the cache at the same version).
    assert.ok(
      statements <= 1,
      `expected at most 1 db statement across 3 reads, got ${statements}`
    );
  });

  it("returns fresh data after a write invalidates the cache", async () => {
    await getModelsDevPricing(); // warm the cache
    await saveModelsDevPricing({
      anthropic: { "claude-x": { input: 1, output: 2 } },
    });
    const pricing = await getModelsDevPricing();
    assert.ok(pricing.anthropic, "cache should reflect the write, not a stale snapshot");
    assert.equal(pricing.anthropic["claude-x"].input, 1);
  });
});
