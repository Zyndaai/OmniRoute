import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-issue-14060-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
delete process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiAuth = await import("../../src/shared/utils/apiAuth.ts");
const { loadHomeSettings } = await import("../../src/app/(dashboard)/home/loadHomeSettings.ts");

test.after(async () => {
  await restoreSettingsTable();
  await core.resetDbInstance();
  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const RENAMED_SETTINGS_TABLE = "config_entries_issue_14060";

/**
 * Makes every settings read fail, the same way a damaged settings page did on SQLite. The table is
 * renamed away in this test file's own PostgreSQL database (each test file has its own), and the
 * read caches and pool are reset so the next read reaches the database.
 */
async function breakSettingsTable() {
  await getTestBackend().execute(
    `ALTER TABLE config_entries RENAME TO ${RENAMED_SETTINGS_TABLE}`
  );
  await core.resetDbInstance();
}

async function restoreSettingsTable() {
  await core.resetDbInstance();
  const backend = getTestBackend();
  const renamed = await backend.queryOne<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [RENAMED_SETTINGS_TABLE]
  );
  if (renamed?.exists) {
    await backend.execute(`ALTER TABLE ${RENAMED_SETTINGS_TABLE} RENAME TO config_entries`);
  }
  await core.resetDbInstance();
}

test("#14060: unreadable settings keep auth fail-closed and Home degrades without crashing", async () => {
  await breakSettingsTable();
  try {
    // (a) Auth gate stays fail-closed: a loopback request on a protected path, with no
    // password configured, must still require auth when settings cannot be read.
    // Swallowing the error inside getSettings() returned password-less defaults and
    // made this `false` (auth disabled for loopback).
    const loopbackRequest = new Request("http://localhost:20128/api/providers");
    assert.equal(
      await apiAuth.isAuthRequired(loopbackRequest, { loopback: true }),
      true,
      "isAuthRequired() must fail closed when settings are unreadable"
    );
    // The first-password bootstrap write must not open up either.
    const bootstrapWrite = new Request("http://localhost:20128/api/settings/require-login", {
      method: "POST",
    });
    assert.equal(await apiAuth.isAuthRequired(bootstrapWrite, { loopback: true }), true);

    // getSettings() must keep surfacing the read error — its auth callers depend on it.
    await assert.rejects(() => settingsDb.getSettings());

    // (b) Home degrades to defaults instead of rejecting (the original 500).
    const homeSettings = await loadHomeSettings();
    assert.deepEqual(homeSettings, { setupComplete: false });
  } finally {
    await restoreSettingsTable();
  }
});

test("loadHomeSettings passes healthy settings through untouched", async () => {
  const result = await loadHomeSettings(async () => ({ setupComplete: true }));
  assert.deepEqual(result, { setupComplete: true });
});
