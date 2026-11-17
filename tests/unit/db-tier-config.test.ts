import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  saveTierConfig,
  loadTierConfigFromDb,
  loadTierConfig,
} from "../../src/lib/db/tierConfig.ts";
import { DEFAULT_TIER_CONFIG } from "../../open-sse/services/tierConfig.ts";
import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

/**
 * Writes the raw `tier_config` value. The column is jsonb, so a non-JSON text cannot be
 * stored at all; the same corrupted content is stored as a JSON string, which the loader
 * reads through once and then fails to parse (the double-encoded path).
 */
async function writeRawTierValue(value: unknown) {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('tier', 'tier_config', $1::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(value)]
  );
}

describe("tierConfig DB module", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("loadTierConfigFromDb returns null when no config saved", async () => {
    const result = await loadTierConfigFromDb();
    assert.equal(result, null, "should return null when no config exists");
  });

  it("saveTierConfig persists and loadTierConfigFromDb retrieves", async () => {
    const config = { ...DEFAULT_TIER_CONFIG };
    await saveTierConfig(config);
    const loaded = await loadTierConfigFromDb();
    assert.ok(loaded, "should return saved config");
    assert.ok(loaded!.freeProviders, "should have freeProviders");
  });

  it("loadTierConfig returns DEFAULT_TIER_CONFIG when no DB entry", async () => {
    // loadTierConfig falls back to DEFAULT_TIER_CONFIG
    const result = await loadTierConfig();
    assert.ok(result, "should return a config");
    assert.equal(typeof result.freeProviders, "object", "freeProviders should be an object");
  });

  it("saveTierConfig overwrites previous config", async () => {
    const config1 = { ...DEFAULT_TIER_CONFIG };
    await saveTierConfig(config1);
    const config2 = { ...DEFAULT_TIER_CONFIG };
    await saveTierConfig(config2);
    const loaded = await loadTierConfigFromDb();
    assert.ok(loaded, "should return config after overwrite");
  });

  it("loadTierConfigFromDb handles corrupted JSON gracefully (#4517)", async () => {
    // Reproduce the bug report: a hand-edited / partially written value is not JSON.
    // We expect null + a warning, NOT a thrown error.
    await writeRawTierValue("not-valid-json{{{");

    // Spy on the logger to confirm we emit a warning that operators can spot.
    const loggerModule = await import("@omniroute/open-sse/utils/logger.ts");
    const warnSpy = mock.method(loggerModule.defaultLogger, "warn", () => {});

    try {
      const result = await loadTierConfigFromDb();
      assert.equal(result, null, "should return null for corrupted JSON");
      assert.ok(
        warnSpy.mock.calls.length > 0,
        "should emit at least one warning so operators can spot the corruption"
      );
      // Sanity: loadTierConfig() still returns DEFAULT_TIER_CONFIG.
      const fallback = await loadTierConfig();
      assert.deepEqual(fallback.freeProviders, DEFAULT_TIER_CONFIG.freeProviders);
    } finally {
      warnSpy.mock.restore();
    }
  });

  it("loadTierConfigFromDb handles valid JSON that fails Zod (#4517)", async () => {
    // JSON parses fine, but the shape doesn't match the schema (freeThreshold = -1
    // violates the min(0) constraint).
    const badShape = {
      version: "1.0.0",
      defaults: { freeThreshold: -1, cheapThreshold: 1.0 },
      providerOverrides: [],
      modelOverrides: [],
      freeProviders: [],
    };
    await writeRawTierValue(badShape);

    const loggerModule = await import("@omniroute/open-sse/utils/logger.ts");
    const warnSpy = mock.method(loggerModule.defaultLogger, "warn", () => {});

    try {
      const result = await loadTierConfigFromDb();
      assert.equal(result, null, "should return null for Zod-failing config");
      assert.ok(warnSpy.mock.calls.length > 0, "should log a warning on Zod failure");
    } finally {
      warnSpy.mock.restore();
    }
  });

  it("loadTierConfigFromDb truncates very long corrupted values in the warning preview (#4517)", async () => {
    // 1000 chars of garbage — the warning preview must truncate to avoid log floods.
    const long = "{".repeat(1000);
    await writeRawTierValue(long);

    const loggerModule = await import("@omniroute/open-sse/utils/logger.ts");
    const warnSpy = mock.method(loggerModule.defaultLogger, "warn", () => {});

    try {
      const result = await loadTierConfigFromDb();
      assert.equal(result, null);
      assert.ok(warnSpy.mock.calls.length > 0);
      // defaultLogger.warn(tag, message, context): the preview lives in the context object.
      const context = warnSpy.mock.calls[0].arguments[2] as Record<string, unknown>;
      const preview = typeof context?.value === "string" ? context.value : "";
      assert.ok(preview.length > 0, "warning context must carry the value preview");
      assert.ok(
        preview.length <= 250,
        `warning preview should be truncated, got length=${preview.length}`
      );
    } finally {
      warnSpy.mock.restore();
    }
  });
});
