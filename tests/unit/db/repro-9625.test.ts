/**
 * Issue #9625 — domain_cost_history cleanup cutoff unit mismatch.
 *
 * cleanupDomainCostHistory() used to compute its cutoff in epoch seconds
 * (Math.floor(Date.now() / 1000)) while the timestamp column held epoch
 * milliseconds. On PostgreSQL the column is timestamptz, so the unit mismatch
 * cannot recur: both sides are real timestamps. This test seeds rows the way
 * production writes them and asserts the retention sweep deletes the old ones.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9625-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { cleanupDomainCostHistory } = await import("../../../src/lib/db/cleanup.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

test.before(async () => {
  await resetTestDb();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const DAY_MS = 86_400_000; // milliseconds

test("#9625 cleanupDomainCostHistory: cutoff matches production timestamps", async () => {
  const backend = getTestBackend();
  const now = Date.now();
  const insert = (cost: number, ageDays: number) =>
    backend.execute(
      `INSERT INTO domain_cost_history (api_key_id, cost, "timestamp") VALUES ($1, $2, $3)`,
      ["key1", cost, new Date(now - ageDays * DAY_MS).toISOString()]
    );

  // 3 old rows: 40 days ago (should be deleted)
  await insert(1.0, 40);
  await insert(2.0, 40);
  await insert(3.0, 40);
  // 2 recent rows: 5 days ago (should be kept)
  await insert(4.0, 5);
  await insert(5.0, 5);

  const result = await cleanupDomainCostHistory();

  assert.strictEqual(result.deleted, 3, "Should delete 3 old rows (40 days old)");
  assert.strictEqual(result.errors, 0);

  const remaining = await backend.queryOne<{ cnt: number }>(
    "SELECT COUNT(*)::int AS cnt FROM domain_cost_history"
  );
  assert.strictEqual(remaining?.cnt, 2, "Should keep 2 recent rows (5 days old)");
});

test("#9625 unit mismatch: seconds cutoff would NOT match ms timestamps", () => {
  // Demonstrate the arithmetic bug: a cutoff in seconds is ~1000×
  // smaller than a millisecond timestamp, so the WHERE clause never
  // matches production data.
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const retentionDays = 30;
  const cutoffSec = nowSec - retentionDays * 86_400; // seconds
  const cutoffMs = nowMs - retentionDays * 86_400_000; // milliseconds

  // A row inserted 40 days ago with a millisecond timestamp:
  const oldRowMs = nowMs - 40 * 86_400_000; // ~1.7e12

  // With seconds cutoff: oldRowMs (1.7e12) < cutoffSec (1.7e9) is FALSE
  // because 1.7e12 > 1.7e9 — the row is never matched.
  assert.ok(
    oldRowMs > cutoffSec,
    "Bug: ms timestamp is NOT less than seconds cutoff, so row is never deleted"
  );

  // With milliseconds cutoff: oldRowMs (1.7e12) < cutoffMs (1.7e12) is TRUE
  assert.ok(
    oldRowMs < cutoffMs,
    "Fix: ms timestamp IS less than ms cutoff, so row is correctly deleted"
  );
});
