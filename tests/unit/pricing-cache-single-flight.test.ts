import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pricing-single-flight-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const readCache = await import("../../src/lib/db/readCache.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const { rollupUsageHistoryBeforeDate } = await import("../../src/lib/usage/aggregateHistory.ts");

// getPricing() reads the three pricing sources (litellm, models_dev, user): one
// model_pricing query each per load.
const PRICING_READ_MARKER = "FROM model_pricing WHERE source";

/** Counts the pricing-table queries issued through the process database backend. */
function countPricingReads() {
  const backend = getTestBackend();
  const original = backend.query.bind(backend);
  const counter = { reads: 0 };
  backend.query = ((sql: string, params?: unknown[]) => {
    if (sql.includes(PRICING_READ_MARKER)) counter.reads++;
    return original(sql, params as never);
  }) as typeof backend.query;
  return {
    counter,
    restore: () => {
      backend.query = original as typeof backend.query;
    },
  };
}

test.beforeEach(async () => {
  await resetTestDb();
  readCache.invalidateDbCache();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("concurrent getCachedPricing misses share one pricing load", async () => {
  const spy = countPricingReads();
  try {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => readCache.getCachedPricing())
    );
    assert.equal(spy.counter.reads, 3);
    assert.ok(results.every((pricing) => pricing === results[0]));
  } finally {
    spy.restore();
  }
});

test("invalidation during an in-flight pricing load starts a fresh load", async () => {
  const spy = countPricingReads();
  try {
    const before = readCache.getCachedPricing();
    readCache.invalidateDbCache("pricing");
    const after = readCache.getCachedPricing();
    const [stale, fresh] = await Promise.all([before, after]);
    assert.notEqual(stale, fresh);
    assert.equal(spy.counter.reads, 6);
    assert.equal(await readCache.getCachedPricing(), fresh);
    assert.equal(spy.counter.reads, 6);
  } finally {
    spy.restore();
  }
});

test("a failed shared pricing load rejects every waiter and is not cached", async () => {
  const backend = getTestBackend();
  const original = backend.query.bind(backend);
  let failures = 0;
  backend.query = ((sql: string, params?: unknown[]) => {
    if (sql.includes(PRICING_READ_MARKER) && failures === 0) {
      failures++;
      return Promise.reject(new Error("pricing read failed"));
    }
    return original(sql, params as never);
  }) as typeof backend.query;
  try {
    const waiters = Array.from({ length: 10 }, () => readCache.getCachedPricing());
    const settled = await Promise.allSettled(waiters);
    assert.equal(failures, 1);
    assert.ok(settled.every((result) => result.status === "rejected"));
  } finally {
    backend.query = original as typeof backend.query;
  }

  // The slot was cleared on error: the next call starts a fresh load and succeeds.
  const spy = countPricingReads();
  try {
    const pricing = await readCache.getCachedPricing();
    assert.equal(typeof pricing, "object");
    assert.equal(spy.counter.reads, 3);
    assert.equal(await readCache.getCachedPricing(), pricing);
    assert.equal(spy.counter.reads, 3);
  } finally {
    spy.restore();
  }
});

test("usage_history rollup reads pricing once for a day of distinct token shapes", async () => {
  await getTestBackend().execute(
    `INSERT INTO usage_history (provider, model, connection_id, tokens_input, tokens_output, success, latency_ms, "timestamp")
     SELECT 'openai', 'gpt-4o', 'conn-1', 1000 + i, 50 + i, true, 100, '2026-01-01T12:00:00.000Z'::timestamptz
     FROM generate_series(0, 199) AS i`
  );

  const spy = countPricingReads();
  try {
    const result = await rollupUsageHistoryBeforeDate("2026-01-02");
    assert.equal(result.errors, 0);
    assert.equal(result.processed, 200);
    assert.equal(spy.counter.reads, 3);
  } finally {
    spy.restore();
  }
});
