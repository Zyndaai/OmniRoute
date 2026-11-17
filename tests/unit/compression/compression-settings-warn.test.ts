/**
 * Tests for #13456: compression settings row warnings for unreadable values.
 *
 * Before the fix, unusable settings rows were silently ignored. Operators had no way to
 * diagnose config drift from the panel vs. the runtime.
 *
 * Postgres stores these rows as jsonb, so a BLOB value or unparseable JSON text can no
 * longer be written at all; only the "engines row is not a usable object" warning still
 * has a reachable input.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-warn-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { ensureDbInitialized, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

const warnings: string[] = [];
const originalWarn = console.warn;

async function setEnginesRow(valueJson: string) {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('compression', 'engines', $1::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [valueJson]
  );
  // Clear the 5s in-process settings cache so the read sees the raw row.
  await updateCompressionSettings({});
}

before(async () => {
  await ensureDbInitialized();
});

beforeEach(async () => {
  warnings.length = 0;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  await resetTestDb();
});

after(async () => {
  console.warn = originalWarn;
  await resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

test("warns when the 'engines' row is not a usable object", async () => {
  await setEnginesRow("42");

  await getCompressionSettings();

  assert.ok(
    warnings.some((w) => w.includes("'engines'") && w.includes("unreadable")),
    `expected an unreadable-engines warning, got: ${JSON.stringify(warnings)}`
  );
});

test("does NOT warn when the 'engines' row is a valid but empty object", async () => {
  await setEnginesRow("{}");

  await getCompressionSettings();

  assert.equal(
    warnings.some((w) => w.includes("'engines'")),
    false,
    `a deliberately empty (but valid) engines map must not warn, got: ${JSON.stringify(warnings)}`
  );
});
