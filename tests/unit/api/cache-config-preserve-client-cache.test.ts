import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression guard: PUT /api/settings/cache-config must persist
// `alwaysPreserveClientCache` into the FLAT general settings key, which is the
// one the runtime (getCacheControlSettings → getSettings) reads. This test proves
// the value written through the route is the one the cache-control policy consumes.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cache-config-flat-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetTestDb } = await import("../../helpers/postgres.ts");

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function makeJsonRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/settings/cache-config", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
});

test("alwaysPreserveClientCache set via cache-config reaches the runtime read path", async (t) => {
  const cacheConfigRoute = await import("../../../src/app/api/settings/cache-config/route.ts");
  const { getSettings } = await import("../../../src/lib/db/settings.ts");
  const { getCacheControlSettings, invalidateCacheControlSettingsCache } =
    await import("../../../src/lib/cacheControlSettings.ts");

  await t.test("PUT persists to the flat settings the runtime reads", async () => {
    const putResponse = await cacheConfigRoute.PUT(
      makeJsonRequest("PUT", { alwaysPreserveClientCache: "always" }) as never
    );
    assert.equal(putResponse.status, 200);

    // The runtime read path: getCacheControlSettings() → getSettings() (flat).
    const flatSettings = await getSettings();
    assert.equal(flatSettings.alwaysPreserveClientCache, "always");

    invalidateCacheControlSettingsCache();
    assert.equal(await getCacheControlSettings(), "always");
  });

  await t.test("invalid persisted cache mode falls back to auto", async () => {
    const { updateSettings } = await import("../../../src/lib/db/settings.ts");
    const { getCacheControlSettings, invalidateCacheControlSettingsCache } =
      await import("../../../src/lib/cacheControlSettings.ts");
    await updateSettings({ alwaysPreserveClientCache: "unexpected" } as never);
    invalidateCacheControlSettingsCache();
    assert.equal(await getCacheControlSettings(), "auto");
  });

  await t.test(
    "the generic settings PATCH accepts Gemini mode and rejects invalid mode",
    async () => {
      const settingsRoute = await import("../../../src/app/api/settings/route.ts");
      const { getSettings } = await import("../../../src/lib/db/settings.ts");
      const patch = (value: unknown) =>
        settingsRoute.PATCH(
          new Request("http://localhost/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ geminiPromptCacheMode: value }),
          })
        );
      const valid = await patch("implicit");
      assert.notEqual(valid.status, 400);
      assert.equal((await getSettings()).geminiPromptCacheMode, "implicit");
      assert.equal((await patch("invalid")).status, 400);
    }
  );

  await t.test("GET reports the flat value, not the ignored cache-section copy", async () => {
    // Seed a stale value in the databaseSettings "cache" section — the store
    // the runtime never reads for this key. GET must not surface it.
    const { setConfigValue } = await import("../../../src/lib/db/configEntries.ts");
    await setConfigValue("databaseSettings", "cache.alwaysPreserveClientCache", "never");

    const putResponse = await cacheConfigRoute.PUT(
      makeJsonRequest("PUT", { alwaysPreserveClientCache: "always" }) as never
    );
    assert.equal(putResponse.status, 200);

    const getResponse = await cacheConfigRoute.GET(makeJsonRequest("GET") as never);
    const body = await getResponse.json();
    assert.equal(getResponse.status, 200);
    assert.equal(body.alwaysPreserveClientCache, "always");
  });
});
