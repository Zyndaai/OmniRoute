// Two dashboard pages write the `engines` map: the Omniglyph page and the context settings
// panel. A write that carries only the engine it changed must leave every other engine as it
// was, or a toggle on one page turns off what the other page (or a failed GET) never loaded.
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-engines-partial-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

type SettingsUpdate = Parameters<typeof updateCompressionSettings>[0];

// Writes a raw `engines` row (JSON text) and clears the 5s settings cache so reads see it.
async function setRawEnginesRow(valueJson: string) {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('compression', 'engines', $1::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [valueJson]
  );
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

describe("updateCompressionSettings engines partial writes", () => {
  it("keeps the other stored engines when a write carries one engine", async () => {
    await updateCompressionSettings({
      engines: {
        rtk: { enabled: true, level: "standard" },
        caveman: { enabled: true, level: "full" },
      },
    });

    await updateCompressionSettings({ engines: { omniglyph: { enabled: true } } });

    const { engines, enginesExplicit } = await getCompressionSettings();
    assert.deepEqual(engines.rtk, { enabled: true, level: "standard" });
    assert.deepEqual(engines.caveman, { enabled: true, level: "full" });
    assert.deepEqual(engines.omniglyph, { enabled: true });
    assert.equal(enginesExplicit, true);
  });

  it("keeps a toggle made on one page when the other page writes a different engine", async () => {
    await updateCompressionSettings({ engines: { rtk: { enabled: true } } });
    // The Omniglyph page turns its engine on after the panel loaded the map...
    await updateCompressionSettings({ engines: { omniglyph: { enabled: true } } });
    // ...then the panel turns caveman on.
    await updateCompressionSettings({ engines: { caveman: { enabled: true } } });

    const { engines } = await getCompressionSettings();
    assert.equal(engines.omniglyph.enabled, true);
    assert.equal(engines.rtk.enabled, true);
    assert.equal(engines.caveman.enabled, true);
  });

  it("keeps a stored engine level when a write only sets enabled", async () => {
    await updateCompressionSettings({ engines: { caveman: { enabled: true, level: "ultra" } } });

    await updateCompressionSettings({ engines: { caveman: { enabled: false } } });

    const { engines } = await getCompressionSettings();
    assert.deepEqual(engines.caveman, { enabled: false, level: "ultra" });
  });

  it("keeps the engines derived from legacy settings on the first engines write", async () => {
    await updateCompressionSettings({ cavemanConfig: { enabled: true } } as SettingsUpdate);
    const before = await getCompressionSettings();
    assert.equal(before.enginesExplicit, false);
    assert.equal(before.engines.caveman.enabled, true);

    await updateCompressionSettings({ engines: { omniglyph: { enabled: true } } });

    const after = await getCompressionSettings();
    assert.equal(after.enginesExplicit, true);
    assert.equal(after.engines.caveman.enabled, true);
    assert.equal(after.engines.omniglyph.enabled, true);
  });

  it("treats a stored non-object engines row as absent and merges over the legacy-derived map", async () => {
    await updateCompressionSettings({ cavemanConfig: { enabled: true } } as SettingsUpdate);

    // A non-object value in the engines key: the read path treats it as unusable, so the write
    // path must not pick it up as a merge base either and falls back to the derived map.
    await setRawEnginesRow(JSON.stringify("not-an-engines-map"));

    const before = await getCompressionSettings();
    assert.equal(before.enginesExplicit, false);
    assert.equal(before.engines.caveman.enabled, true);

    await updateCompressionSettings({ engines: { omniglyph: { enabled: true } } });

    const after = await getCompressionSettings();
    assert.equal(after.engines.caveman.enabled, true);
    assert.equal(after.engines.omniglyph.enabled, true);
    assert.equal(after.enginesExplicit, true);
  });
});
