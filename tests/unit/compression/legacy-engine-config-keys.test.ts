/**
 * Legacy per-engine settings rows (aggressiveConfig / ultraConfig / headroomConfig) share
 * their read case with the current keys (aggressive / ultra / headroom) in
 * getCompressionSettings. When both rows exist the current key must win, whatever the
 * order the rows are read in.
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_AGGRESSIVE_CONFIG,
  DEFAULT_HEADROOM_CONFIG,
  DEFAULT_ULTRA_CONFIG,
} from "../../../open-sse/services/compression/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-legacy-keys-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

// Simulates a legacy row left by manual SQL, an outside tool, or a database from another
// build — no app write path creates these keys. `value` is stored as jsonb.
async function seedRow(key: string, value: unknown): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('compression', $1, $2::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
  // Clear the 5s in-process settings cache so the next read sees the raw row.
  await updateCompressionSettings({});
}

before(async () => {
  await core.ensureDbInitialized();
});

beforeEach(async () => {
  await resetTestDb();
});

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

describe("current engine settings rows win over legacy rows", () => {
  it("aggressive beats legacy aggressiveConfig after a save", async () => {
    await seedRow("aggressiveConfig", { ...DEFAULT_AGGRESSIVE_CONFIG, maxTokensPerMessage: 1111 });
    await seedRow("aggressive", { ...DEFAULT_AGGRESSIVE_CONFIG, maxTokensPerMessage: 2222 });

    await updateCompressionSettings({
      aggressive: { ...DEFAULT_AGGRESSIVE_CONFIG, maxTokensPerMessage: 4096 },
    });

    const settings = await getCompressionSettings();
    assert.equal(settings.aggressive?.maxTokensPerMessage, 4096);
  });

  it("ultra beats legacy ultraConfig after a save", async () => {
    await seedRow("ultraConfig", { ...DEFAULT_ULTRA_CONFIG, compressionRate: 0.1 });
    await seedRow("ultra", { ...DEFAULT_ULTRA_CONFIG, compressionRate: 0.2 });

    await updateCompressionSettings({ ultra: { ...DEFAULT_ULTRA_CONFIG, compressionRate: 0.9 } });

    const settings = await getCompressionSettings();
    assert.equal(settings.ultra?.compressionRate, 0.9);
  });

  it("headroom beats legacy headroomConfig after a save", async () => {
    await seedRow("headroomConfig", { minRows: 3 });
    await seedRow("headroom", { minRows: 4 });

    await updateCompressionSettings({ headroom: { minRows: 50 } });

    const settings = await getCompressionSettings();
    assert.equal(settings.headroom?.minRows, 50);
  });

  it("legacy aggressiveConfig still applies when no current row exists", async () => {
    await seedRow("aggressiveConfig", { ...DEFAULT_AGGRESSIVE_CONFIG, maxTokensPerMessage: 1111 });

    const settings = await getCompressionSettings();
    assert.equal(settings.aggressive?.maxTokensPerMessage, 1111);
  });

  it("legacy ultraConfig still applies when no current row exists", async () => {
    await seedRow("ultraConfig", { ...DEFAULT_ULTRA_CONFIG, compressionRate: 0.1 });

    const settings = await getCompressionSettings();
    assert.equal(settings.ultra?.compressionRate, 0.1);
  });

  it("legacy headroomConfig still applies when no current row exists", async () => {
    await seedRow("headroomConfig", { minRows: 7 });

    const settings = await getCompressionSettings();
    assert.equal(settings.headroom?.minRows, 7);
  });

  it("a corrupt current row still shadows a valid legacy row (deliberate)", async () => {
    // Presence, not usability: a current row holding an unusable value (a bare string here,
    // the jsonb stand-in for the #13456 corruption mode) is skipped by the read loop but still
    // suppresses the legacy row — the engine resets to defaults and the corruption warn is the
    // operator's signal to re-save.
    await seedRow("aggressiveConfig", { ...DEFAULT_AGGRESSIVE_CONFIG, maxTokensPerMessage: 1111 });
    await seedRow("aggressive", "corrupt-blob");

    const settings = await getCompressionSettings();
    assert.equal(
      settings.aggressive?.maxTokensPerMessage,
      DEFAULT_AGGRESSIVE_CONFIG.maxTokensPerMessage
    );
  });

  it("an unusable text current row still shadows a valid legacy row (deliberate)", async () => {
    // The other #13456 corruption mode: a text value that is not a usable engine object is
    // skipped by the read loop, but the key is still "present" — so the legacy row stays suppressed.
    await seedRow("aggressiveConfig", { ...DEFAULT_AGGRESSIVE_CONFIG, maxTokensPerMessage: 1111 });
    await seedRow("aggressive", "{not valid json");

    const settings = await getCompressionSettings();
    assert.equal(
      settings.aggressive?.maxTokensPerMessage,
      DEFAULT_AGGRESSIVE_CONFIG.maxTokensPerMessage
    );
  });

  it("an unusable text legacy row resets the engine to defaults", async () => {
    await seedRow("ultraConfig", "{not valid json");

    const settings = await getCompressionSettings();
    assert.equal(settings.ultra?.compressionRate, DEFAULT_ULTRA_CONFIG.compressionRate);
  });

  it("non-object legacy value resets the engine to defaults", async () => {
    await seedRow("headroomConfig", 5);

    const settings = await getCompressionSettings();
    assert.equal(settings.headroom?.minRows, DEFAULT_HEADROOM_CONFIG.minRows);
  });
});
