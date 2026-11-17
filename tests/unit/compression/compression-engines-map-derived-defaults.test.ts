import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-compression-derived-engines-")
);
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { ensureDbInitialized, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

before(async () => {
  await ensureDbInitialized();
});

beforeEach(async () => {
  await resetTestDb();
});

after(async () => {
  await resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

// `value` is JSON text, as the settings module stores it in config_entries (jsonb).
// The settings read keeps a 5s in-process cache that raw writes do not clear; an empty
// update clears it (and re-reads), so the next read sees the raw row.
async function setRow(key: string, valueJson: string) {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('compression', $1, $2::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [key, valueJson]
  );
  await updateCompressionSettings({});
}

test("no engines row: derived map keeps aggressive off by default", async () => {
  const cfg = await getCompressionSettings();
  assert.equal(cfg.enginesExplicit, false);
  assert.equal(cfg.engines.aggressive.enabled, false);
});

test("no engines row: defaultMode 'aggressive' is the only signal that turns it on", async () => {
  await setRow("defaultMode", '"aggressive"');
  const cfg = await getCompressionSettings();
  assert.equal(cfg.enginesExplicit, false);
  assert.equal(cfg.engines.aggressive.enabled, true);
});

test("no engines row: a stored aggressive.enabled=true outside the schema is ignored", async () => {
  await setRow("aggressive", '{"enabled":true}');
  const cfg = await getCompressionSettings();
  assert.equal(cfg.enginesExplicit, false);
  assert.equal(cfg.engines.aggressive.enabled, false);
});
