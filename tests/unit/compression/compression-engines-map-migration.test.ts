import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-engines-"));
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

async function setRow(key: string, valueJson: string) {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('compression', $1, $2::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [key, valueJson]
  );
}

test("migration backfills engines map from prior defaultMode + default combo", async () => {
  // simulate a pre-102 install: master on, defaultMode 'standard', caveman enabled
  await setRow("enabled", "true");
  await setRow("defaultMode", '"standard"');
  await setRow("cavemanConfig", '{"enabled":true}');
  const cfg = await getCompressionSettings();
  assert.equal(cfg.engines.caveman.enabled, true);
  assert.equal(cfg.activeComboId, null);
  // No stored engines row → backfilled map is display-only; dispatch stays on the legacy path.
  assert.equal(cfg.enginesExplicit, false);
});

test("engines map persists round-trip + activeComboId", async () => {
  await updateCompressionSettings({
    enabled: true,
    engines: {
      rtk: { enabled: true, level: "standard" },
      caveman: { enabled: true, level: "full" },
    },
    activeComboId: null,
  });
  const cfg = await getCompressionSettings();
  assert.equal(cfg.engines.rtk.enabled, true);
  assert.equal(cfg.engines.rtk.level, "standard");
  assert.equal(cfg.engines.caveman.level, "full");
  // A stored engines row exists → the panel configured engines; dispatch trusts the map.
  assert.equal(cfg.enginesExplicit, true);
});
