import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

/**
 * #5217 — `trimCallLogsToMaxRows()` deleted up to batchSize=5000 ids in a single
 * `DELETE … IN (?, ?, …)`. A statement caps its bound parameters (SQLite ~999, PostgreSQL
 * 65535), so any trim that needed to delete many rows threw "too many SQL variables",
 * aborting the trim and blocking the Request-log table from being persisted/pruned. The
 * delete must chunk the keys so a large trim succeeds instead of throwing.
 */

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-trim-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");

/** Bulk-inserts `total` rows, one second apart from 2026-01-01, with ids `<prefix>-00000…`. */
async function insertCallLogs(prefix: string, total: number) {
  await getTestBackend().execute(
    `INSERT INTO call_logs (id, "timestamp", method, path, status, model, provider, detail_state)
     SELECT $1::text || '-' || lpad(i::text, 5, '0'),
            timestamptz '2026-01-01T00:00:00Z' + i * interval '1 second',
            'POST', '/v1/chat/completions', 200, 'openai/gpt-4.1', 'openai', 'none'
       FROM generate_series(0, $2::int - 1) AS i`,
    [prefix, total]
  );
}

async function countCallLogs(): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM call_logs"
  );
  return Number(row?.cnt);
}

test.beforeEach(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("trimCallLogsToMaxRows deletes >999 rows in one pass without 'too many SQL variables'", async () => {
  const total = 1500;
  await insertCallLogs("trim", total);

  assert.equal(await countCallLogs(), total);

  // Trim to 10 rows → 1490 keys must be deleted in a single trim batch (batchSize=5000),
  // which without chunking would exceed a statement's bound-parameter limit and throw.
  let result: { deletedRows: number; deletedArtifacts: number } | undefined;
  await assert.doesNotReject(async () => {
    result = await callLogs.trimCallLogsToMaxRows(10);
  });

  assert.equal(result!.deletedRows, total - 10, "all overflow rows must be deleted (chunked)");
  assert.equal(await countCallLogs(), 10, "exactly maxRows rows must remain");
});

test("deleteCallLogsBefore deletes a batch larger than a statement's parameter limit without throwing", async () => {
  // deleteCallLogsBefore passes EVERY matching key (2 params each) to the delete, in pages of
  // 5000: un-chunked, that is 10000+ parameters per statement. 35k rows spans several pages
  // and exceeds the 32766 cap of newer SQLite builds that this test was written against.
  const total = 35000;
  await insertCallLogs("old", total);

  let result: { deletedRows: number } | undefined;
  await assert.doesNotReject(async () => {
    result = await callLogs.deleteCallLogsBefore("2030-01-01T00:00:00.000Z");
  });

  assert.equal(result!.deletedRows, total, "every row before the cutoff must be deleted");
  assert.equal(await countCallLogs(), 0);
});
