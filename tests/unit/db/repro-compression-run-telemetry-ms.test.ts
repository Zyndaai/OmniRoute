/**
 * compression_run_telemetry cleanup cutoff.
 *
 * cleanupCompressionRunTelemetry() used to compute its cutoff in epoch seconds while the
 * writer stamped epoch milliseconds (the same defect as domain_cost_history, #9625), so the
 * retention sweep never deleted anything. On PostgreSQL the column is timestamptz and both
 * the writer and the cutoff use real timestamps, so the sweep must delete the old rows.
 *
 * The seed rows go through the real writer, then are backdated to simulate age.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-crt-ms-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { cleanupCompressionRunTelemetry } = await import("../../../src/lib/db/cleanup.ts");
const { insertCompressionRunTelemetryRow } =
  await import("../../../src/lib/db/compressionRunTelemetry.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

test.before(async () => {
  await resetTestDb();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const DAY_MS = 86_400_000;

async function seedRow(requestId: string): Promise<void> {
  await insertCompressionRunTelemetryRow({
    requestId,
    model: "m",
    provider: "p",
    source: "s",
    tokensBefore: 100,
    tokensAfter: 50,
    ratio: 0.5,
  });
}

test("the writer stamps the current time as a timestamptz", async () => {
  await seedRow("req-unit-probe");
  const row = await getTestBackend().queryOne<{ ts: string }>(
    `SELECT "timestamp"::text AS ts FROM compression_run_telemetry WHERE request_id = $1`,
    ["req-unit-probe"]
  );
  assert.ok(row, "the writer must insert a row");
  const stampedMs = Date.parse(row.ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  assert.ok(
    Math.abs(stampedMs - Date.now()) < 60_000,
    `timestamp ${row.ts} must be within a minute of now`
  );
});

test("cleanupCompressionRunTelemetry deletes rows older than the retention window", async () => {
  const backend = getTestBackend();
  await backend.execute("DELETE FROM compression_run_telemetry");

  const now = Date.now();
  const backdate = (id: string, ageDays: number) =>
    backend.execute(`UPDATE compression_run_telemetry SET "timestamp" = $1 WHERE request_id = $2`, [
      new Date(now - ageDays * DAY_MS).toISOString(),
      id,
    ]);

  for (const id of ["old-1", "old-2", "old-3"]) {
    await seedRow(id);
    await backdate(id, 40);
  }
  for (const id of ["new-1", "new-2"]) {
    await seedRow(id);
    await backdate(id, 5);
  }

  const result = await cleanupCompressionRunTelemetry();

  assert.strictEqual(result.deleted, 3, "should delete the 3 rows aged 40 days");
  assert.strictEqual(result.errors, 0);

  const remaining = await backend.queryOne<{ cnt: number }>(
    "SELECT COUNT(*)::int AS cnt FROM compression_run_telemetry"
  );
  assert.strictEqual(remaining?.cnt, 2, "should keep the 2 rows aged 5 days");
});
