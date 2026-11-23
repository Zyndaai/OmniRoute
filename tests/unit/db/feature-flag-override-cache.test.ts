import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend } from "../../helpers/postgres.ts";

// Flag overrides are read on hot paths once per string leaf of a request body,
// so getFeatureFlagOverride caches the SELECT. The cache must still reflect
// every write that goes through this module immediately, and must not survive
// a reopened database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-flag-cache-"));
process.env.DATA_DIR = tmpDir;

const core = await import("../../../src/lib/db/core.ts");
const {
  getFeatureFlagOverride,
  setFeatureFlagOverride,
  removeFeatureFlagOverride,
  clearAllFeatureFlagOverrides,
  clearFeatureFlagOverrideCache,
} = await import("../../../src/lib/db/featureFlags.ts");

const FLAG = "PII_RESPONSE_SANITIZATION";
const NAMESPACE = "feature_flags";

// Writes the store directly, bypassing this module's cache (config_entries.value is jsonb).
async function writeRaw(value: string) {
  await getTestBackend().execute(
    "INSERT INTO config_entries (namespace, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value",
    [NAMESPACE, FLAG, JSON.stringify(value)]
  );
}

test("feature flag override cache", async (t) => {
  await t.test("writes through this module are visible immediately", async () => {
    await clearAllFeatureFlagOverrides();
    assert.equal(await getFeatureFlagOverride(FLAG), undefined);
    await setFeatureFlagOverride(FLAG, "true");
    assert.equal(await getFeatureFlagOverride(FLAG), "true");
    await setFeatureFlagOverride(FLAG, "false");
    assert.equal(await getFeatureFlagOverride(FLAG), "false");
    await removeFeatureFlagOverride(FLAG);
    assert.equal(await getFeatureFlagOverride(FLAG), undefined);
  });

  await t.test("repeated reads are served from the cache until invalidated", async () => {
    await setFeatureFlagOverride(FLAG, "true");
    assert.equal(await getFeatureFlagOverride(FLAG), "true");
    await writeRaw("false");
    assert.equal(
      await getFeatureFlagOverride(FLAG),
      "true",
      "raw store edit is not seen while cached"
    );
    clearFeatureFlagOverrideCache(FLAG);
    assert.equal(await getFeatureFlagOverride(FLAG), "false");
    await clearAllFeatureFlagOverrides();
    assert.equal(await getFeatureFlagOverride(FLAG), undefined);
  });

  await t.test("a reopened database is read fresh once the cache TTL lapses", async () => {
    // Postgres has no per-file reopen: resetDbInstance() closes the pool but does not clear this
    // module's override cache, so the bound is the short TTL (OVERRIDE_CACHE_TTL_MS = 1000).
    await setFeatureFlagOverride(FLAG, "true");
    assert.equal(await getFeatureFlagOverride(FLAG), "true");
    await writeRaw("false");
    await core.resetDbInstance();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await getFeatureFlagOverride(FLAG), "false");
  });
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
