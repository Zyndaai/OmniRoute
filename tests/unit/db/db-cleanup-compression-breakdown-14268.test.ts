/**
 * Issue #14268 — Retention pruning and reset for compression_engine_breakdown.
 *
 * Verifies that:
 * 1. cleanupCompressionEngineBreakdown() deletes rows older than the retention window
 *    (retention.compressionAnalytics, default 30 days) and preserves rows within the window.
 * 2. cleanupCompressionEngineBreakdown() handles a missing table gracefully.
 * 3. runAutoCleanup() calls cleanupCompressionEngineBreakdown() and surfaces results.
 * 4. resetUsageHistory() prunes compression_engine_breakdown on period resets and wipes on "all".
 */

import test from "node:test";
import assert from "node:assert/strict";

const { cleanupCompressionEngineBreakdown, runAutoCleanup, resetUsageHistory } =
  await import("../../../src/lib/db/cleanup.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

const DAY_MS = 86_400_000;

async function insertBreakdown(
  timestamp: string,
  engine: string,
  originalTokens: number,
  compressedTokens: number,
  tokensSaved: number
): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO compression_engine_breakdown
       ("timestamp", engine, original_tokens, compressed_tokens, tokens_saved)
     VALUES ($1, $2, $3, $4, $5)`,
    [timestamp, engine, originalTokens, compressedTokens, tokensSaved]
  );
}

async function countBreakdown(): Promise<number> {
  const row = await getTestBackend().queryOne<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM compression_engine_breakdown"
  );
  return row?.c ?? 0;
}

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb().catch(() => {});
});

test("#14268 cleanupCompressionEngineBreakdown: deletes rows older than retention window", async () => {
  const now = Date.now();

  // 3 old (45 days ago), 2 recent (5 days ago)
  const oldIso = new Date(now - 45 * DAY_MS).toISOString();
  const recentIso = new Date(now - 5 * DAY_MS).toISOString();

  await insertBreakdown(oldIso, "rtk", 1000, 400, 600);
  await insertBreakdown(oldIso, "caveman", 600, 300, 300);
  await insertBreakdown(oldIso, "rtk", 2000, 800, 1200);
  await insertBreakdown(recentIso, "rtk", 1500, 600, 900);
  await insertBreakdown(recentIso, "caveman", 900, 400, 500);

  const initialCount = await countBreakdown();
  assert.strictEqual(initialCount, 5, "seeded 5 rows");

  const result = await cleanupCompressionEngineBreakdown();

  assert.strictEqual(result.errors, 0, "no errors during cleanup");
  assert.strictEqual(result.deleted, 3, "deleted 3 rows older than 30 days");

  const remaining = await getTestBackend().query<{ timestamp: string; engine: string }>(
    "SELECT \"timestamp\", engine FROM compression_engine_breakdown"
  );
  assert.strictEqual(remaining.length, 2, "2 recent rows remain");
  for (const row of remaining) {
    // Postgres returns timestamptz as an ISO string; compare the instant.
    assert.strictEqual(Date.parse(row.timestamp), Date.parse(recentIso), "remaining row has recent timestamp");
  }
});

test("#14268 cleanupCompressionEngineBreakdown: gracefully returns if table does not exist", async () => {
  const b = getTestBackend();
  await b.execute("ALTER TABLE compression_engine_breakdown RENAME TO compression_engine_breakdown_unavailable");
  try {
    const result = await cleanupCompressionEngineBreakdown();
    assert.deepStrictEqual(result, { deleted: 0, errors: 0 });
  } finally {
    await b.execute("ALTER TABLE compression_engine_breakdown_unavailable RENAME TO compression_engine_breakdown");
  }
});

test("#14268 runAutoCleanup: includes compressionEngineBreakdown in results", async () => {
  const now = Date.now();
  const oldIso = new Date(now - 45 * DAY_MS).toISOString();

  await insertBreakdown(oldIso, "rtk", 1000, 400, 600);

  const autoResult = await runAutoCleanup();
  assert.ok(
    autoResult.results.compressionEngineBreakdown,
    "compressionEngineBreakdown present in results"
  );
  assert.strictEqual(autoResult.results.compressionEngineBreakdown.deleted, 1);
});

test("#14268 resetUsageHistory: prunes compression_engine_breakdown on period reset and wipes on all", async () => {
  const now = Date.now();
  const oldIso = new Date(now - 2 * DAY_MS).toISOString();
  const recentIso = new Date(now - 3600_000).toISOString();

  await insertBreakdown(oldIso, "rtk", 1000, 500, 500);
  await insertBreakdown(recentIso, "rtk", 2000, 1000, 1000);

  // 1d period reset deletes row older than 1 day
  const periodResult = await resetUsageHistory("1d");
  assert.strictEqual(periodResult.deletedCompressionEngineBreakdown, 1);

  assert.strictEqual(await countBreakdown(), 1);

  // "all" wipes remaining
  const allResult = await resetUsageHistory("all");
  assert.strictEqual(allResult.deletedCompressionEngineBreakdown, 1);

  assert.strictEqual(await countBreakdown(), 0);
});
