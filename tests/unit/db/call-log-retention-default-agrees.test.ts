// One effective call-log age for display, scheduled cleanup and request-log rotation. Rotation
// falls back to CALL_LOG_RETENTION_DAYS, else 7 days, when the operator saved none; the settings
// reader used the shipped 30, so the Data Retention page and the scheduled cleanup disagreed
// with rotation. A value the operator saved still wins everywhere.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-retention-agree-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const SAVED_ENV = process.env.CALL_LOG_RETENTION_DAYS;

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { db } = await import("../../../src/lib/db/pg.ts");
const { getRetentionSettings } = await import("../../../src/lib/db/retentionSettings.ts");
const { resolveCallLogRetentionDays } = await import("../../../src/lib/usage/callLogRetention.ts");

test.beforeEach(async () => {
  await resetTestDb();
  delete process.env.CALL_LOG_RETENTION_DAYS;
});

test.after(async () => {
  if (SAVED_ENV === undefined) delete process.env.CALL_LOG_RETENTION_DAYS;
  else process.env.CALL_LOG_RETENTION_DAYS = SAVED_ENV;
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("an unsaved install shows the same call-log age that rotation enforces", async () => {
  const displayed = (await getRetentionSettings()).callLogs;
  assert.equal(displayed, await resolveCallLogRetentionDays());
  assert.equal(displayed, 7, "the documented default applies when nothing is saved");
});

test("an unsaved install follows CALL_LOG_RETENTION_DAYS in the display too", async () => {
  process.env.CALL_LOG_RETENTION_DAYS = "14";
  assert.equal((await getRetentionSettings()).callLogs, 14);
  assert.equal(await resolveCallLogRetentionDays(), 14);
});

test("a saved call-log age wins", async () => {
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value)
     VALUES ('databaseSettings', 'retention.callLogs', '45'::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`
  );
  assert.equal((await getRetentionSettings()).callLogs, 45);
});
