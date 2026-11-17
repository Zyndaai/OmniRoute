/**
 * TDD: getPerEngineAnalytics — per-engine aggregation from compression_analytics.
 *
 * DB isolation: tests/_setup/isolatePostgres.ts gives this file its own database;
 * resetTestDb() empties it between tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const { insertCompressionAnalyticsRow, getPerEngineAnalytics } =
  await import("../../../src/lib/db/compressionAnalytics.ts");

// ─── lifecycle ────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetTestDb();
});

// ─── tests ────────────────────────────────────────────────────────────────────

test("getPerEngineAnalytics returns runs=0 and zeroed metrics for unknown engine", async () => {
  const result = await getPerEngineAnalytics("unknown-engine");
  assert.equal(result.engineId, "unknown-engine");
  assert.equal(result.runs, 0);
  assert.equal(result.tokensSaved, 0);
  assert.equal(result.avgSavingsPercent, 0);
  assert.equal(result.days, 7);
});

test("getPerEngineAnalytics returns correct aggregation for headroom rows only", async () => {
  const now = new Date().toISOString();

  // 2 headroom rows: original=1000/compressed=800/saved=200 and original=500/compressed=350/saved=150
  await insertCompressionAnalyticsRow({
    timestamp: now,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 1000,
    compressed_tokens: 800,
    tokens_saved: 200,
  });
  await insertCompressionAnalyticsRow({
    timestamp: now,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 500,
    compressed_tokens: 350,
    tokens_saved: 150,
  });

  // 1 caveman row that must NOT appear in headroom results
  await insertCompressionAnalyticsRow({
    timestamp: now,
    mode: "stacked",
    engine: "caveman",
    original_tokens: 800,
    compressed_tokens: 600,
    tokens_saved: 200,
  });

  const result = await getPerEngineAnalytics("headroom");

  assert.equal(result.engineId, "headroom");
  assert.equal(result.runs, 2, "should count only the 2 headroom rows");
  assert.equal(result.tokensSaved, 350, "should sum tokens_saved for headroom rows");

  // avgSavingsPercent = round(((1500 - 1150) / 1500) * 1000) / 10
  //                   = round((350/1500) * 1000) / 10
  //                   = round(233.33...) / 10
  //                   = 233 / 10 = 23.3
  assert.equal(result.avgSavingsPercent, 23.3, `expected 23.3%, got ${result.avgSavingsPercent}`);
  assert.equal(result.days, 7);
});

test("getPerEngineAnalytics excludes rows outside the days window", async () => {
  const recent = new Date().toISOString();
  // 30 days ago — outside the default 7-day window
  const old = new Date(Date.now() - 30 * 86400_000).toISOString();

  await insertCompressionAnalyticsRow({
    timestamp: recent,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 1000,
    compressed_tokens: 800,
    tokens_saved: 200,
  });
  await insertCompressionAnalyticsRow({
    timestamp: old,
    mode: "stacked",
    engine: "headroom",
    original_tokens: 2000,
    compressed_tokens: 1000,
    tokens_saved: 1000,
  });

  const result = await getPerEngineAnalytics("headroom", 7);
  assert.equal(result.runs, 1, "should only count the recent row within 7 days");
  assert.equal(result.tokensSaved, 200);
});

test("getPerEngineAnalytics falls back to mode column when engine is null (COALESCE behaviour)", async () => {
  const now = new Date().toISOString();

  // Insert a row where engine is explicitly NULL — insertCompressionAnalyticsRow writes
  // engine = row.engine ?? row.mode, so insert raw to simulate a pre-engine row.
  await getTestBackend().execute(
    `INSERT INTO compression_analytics (timestamp, mode, engine, original_tokens, compressed_tokens, tokens_saved)
     VALUES ($1, $2, NULL, $3, $4, $5)`,
    [now, "caveman", 600, 400, 200]
  );

  // COALESCE(engine, mode) = 'caveman' for the row above
  const result = await getPerEngineAnalytics("caveman");
  assert.equal(result.runs, 1, "COALESCE fallback should match engine=NULL, mode=caveman");
  assert.equal(result.tokensSaved, 200);
});

test("getPerEngineAnalytics accepts custom days parameter", async () => {
  const result = await getPerEngineAnalytics("headroom", 30);
  assert.equal(result.days, 30);
});
