import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CavemanConfig } from "../../../open-sse/services/compression/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-caveman-db-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

describe("compression DB module", () => {
  beforeEach(async () => {
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
  });

  afterEach(async () => {
    await core.resetDbInstance();
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

  it("should return default config", async () => {
    const config = await getCompressionSettings();
    assert.equal(config.defaultMode, "off");
    assert.equal(config.enabled, false);
    assert.equal(config.autoTriggerTokens, 0);
    assert.equal(config.cacheMinutes, 5);
    assert.equal(config.preserveSystemPrompt, true);
    assert.ok(config.cavemanConfig);
    // Fresh installs take their defaults from the code constants (DEFAULT_CAVEMAN_CONFIG): the
    // PostgreSQL init seeds only the rows the app needs (0001_init.sql section 6), not SQLite
    // migration 035's `enabled: true` row. Existing installs keep their stored value via transfer.
    assert.equal(config.cavemanConfig.enabled, false);
    assert.deepEqual(config.cavemanConfig.compressRoles, ["user"]);
    assert.equal(config.cavemanConfig.minMessageLength, 50);
  });

  it("should update and retrieve settings", async () => {
    await updateCompressionSettings({ enabled: true, defaultMode: "standard" });
    const config = await getCompressionSettings();
    assert.equal(config.enabled, true);
    assert.equal(config.defaultMode, "standard");

    await updateCompressionSettings({ enabled: false, defaultMode: "off" });
    const reset = await getCompressionSettings();
    assert.equal(reset.enabled, false);
    assert.equal(reset.defaultMode, "off");
  });

  it("should update cavemanConfig", async () => {
    const customConfig: Partial<CavemanConfig> = {
      enabled: true,
      compressRoles: ["user", "system"],
      minMessageLength: 100,
    };
    await updateCompressionSettings({ cavemanConfig: customConfig as CavemanConfig });
    const config = await getCompressionSettings();
    assert.deepEqual(config.cavemanConfig?.compressRoles, ["user", "system"]);
    assert.equal(config.cavemanConfig?.minMessageLength, 100);
  });
});
