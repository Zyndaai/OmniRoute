/**
 * Issue #6848 — Auto-cleanup for telemetry tables that grow without bound.
 *
 * domain_cost_history, compression_cache_stats and
 * compression_run_telemetry had no retention cleanup, causing unbounded
 * DB growth and OOM crashes on relays with heavy traffic.
 *
 * These tests call the REAL cleanup functions against the PostgreSQL test
 * database (isolated per test file by tests/_setup/isolatePostgres.ts).
 * If the production DELETE logic breaks, these tests WILL fail.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-6848-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const {
  cleanupDomainCostHistory,
  cleanupCompressionCacheStats,
  cleanupCompressionRunTelemetry,
} = await import("../../src/lib/db/cleanup.ts");

const { getTestBackend } = await import("../helpers/postgres.ts");

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const DAY_MS = 86_400_000;

async function count(table: string): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM ${table}`
  );
  return Number(row?.cnt ?? 0);
}

test.beforeEach(async () => {
  for (const table of [
    "domain_cost_history",
    "compression_cache_stats",
    "compression_run_telemetry",
  ]) {
    await getTestBackend().execute(`DELETE FROM ${table}`);
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────

test("#6848 cleanupDomainCostHistory: deletes rows older than retention window", async () => {
  const backend = getTestBackend();
  const now = Date.now();
  const insert = (cost: number, ts: number) =>
    backend.execute(
      'INSERT INTO domain_cost_history (api_key_id, cost, "timestamp") VALUES ($1, $2, $3)',
      ["key1", cost, new Date(ts).toISOString()]
    );

  // 3 old (40 days ago), 2 recent (5 days ago)
  await insert(1.0, Date.now() - 40 * DAY_MS);
  await insert(2.0, Date.now() - 40 * DAY_MS);
  await insert(3.0, Date.now() - 40 * DAY_MS);
  await insert(4.0, now - 5 * DAY_MS);
  await insert(5.0, now - 5 * DAY_MS);

  const result = await cleanupDomainCostHistory();

  assert.strictEqual(result.deleted, 3);
  assert.strictEqual(result.errors, 0);
  assert.strictEqual(await count("domain_cost_history"), 2);
});

test("#6848 cleanupCompressionCacheStats: deletes rows older than retention window", async () => {
  const backend = getTestBackend();
  const oldDate = new Date(Date.now() - 40 * DAY_MS).toISOString();
  const recentDate = new Date(Date.now() - 5 * DAY_MS).toISOString();
  const insert = (provider: string, createdAt: string) =>
    backend.execute(
      "INSERT INTO compression_cache_stats (provider, compression_mode, created_at) VALUES ($1, $2, $3)",
      [provider, "auto", createdAt]
    );

  await insert("openai", oldDate);
  await insert("openai", oldDate);
  await insert("anthropic", recentDate);

  const result = await cleanupCompressionCacheStats();

  assert.strictEqual(result.deleted, 2);
  assert.strictEqual(result.errors, 0);
  assert.strictEqual(await count("compression_cache_stats"), 1);
});

test("#6848 cleanupCompressionRunTelemetry: deletes rows older than retention window", async () => {
  const backend = getTestBackend();
  const now = Date.now();
  const insert = (ts: number, before: number, after: number) =>
    backend.execute(
      'INSERT INTO compression_run_telemetry ("timestamp", tokens_before, tokens_after) VALUES ($1, $2, $3)',
      [new Date(ts).toISOString(), before, after]
    );

  await insert(now - 40 * DAY_MS, 1000, 500);
  await insert(now - 40 * DAY_MS, 2000, 800);
  await insert(now - 5 * DAY_MS, 1500, 600);

  const result = await cleanupCompressionRunTelemetry();

  assert.strictEqual(result.deleted, 2);
  assert.strictEqual(result.errors, 0);
  assert.strictEqual(await count("compression_run_telemetry"), 1);
});

test("#6848 cleanupCompressionRunTelemetry: contains delete failures", async (t) => {
  const backend = getTestBackend();
  const failing = (sql: string) => {
    if (String(sql).includes("compression_run_telemetry")) {
      throw new Error("injected delete failure");
    }
  };
  const originalExecute = backend.execute.bind(backend);
  t.mock.method(backend, "execute", (sql: string, params?: unknown[]) => {
    failing(sql);
    return originalExecute(sql, params as never);
  });
  t.mock.method(console, "error", () => {});

  const result = await cleanupCompressionRunTelemetry();

  assert.deepStrictEqual(result, { deleted: 0, errors: 1 });
});

test("#6848 no rows deleted when all data is within retention window (calls all 3 real functions)", async () => {
  const backend = getTestBackend();
  const nowMilliseconds = Date.now();
  const recentISO = new Date().toISOString();

  await backend.execute(
    'INSERT INTO domain_cost_history (api_key_id, cost, "timestamp") VALUES ($1, $2, $3)',
    ["k", 1, new Date(nowMilliseconds - DAY_MS).toISOString()]
  );
  await backend.execute(
    "INSERT INTO compression_cache_stats (provider, compression_mode, created_at) VALUES ($1, $2, $3)",
    ["p", "auto", recentISO]
  );
  await backend.execute(
    'INSERT INTO compression_run_telemetry ("timestamp", tokens_before, tokens_after) VALUES ($1, $2, $3)',
    [new Date(nowMilliseconds - DAY_MS).toISOString(), 100, 50]
  );

  const r1 = await cleanupDomainCostHistory();
  const r2 = await cleanupCompressionCacheStats();
  const r3 = await cleanupCompressionRunTelemetry();

  assert.strictEqual(r1.deleted, 0);
  assert.strictEqual(r2.deleted, 0);
  assert.strictEqual(r3.deleted, 0);
});
