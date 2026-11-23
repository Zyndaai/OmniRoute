import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omni-cache-binding-14484-"));
const { getDatabaseSettingsSection } = await import("../../../src/lib/db/databaseSettingsSections.ts");
const { setConfigValue } = await import("../../../src/lib/db/configEntries.ts");
const { encryptCacheValue } = await import("../../../src/lib/db/cacheSecrets.ts");
const { ensureSemanticCacheDbBridge, refreshSemanticCacheDbBridge } =
  await import("../../../src/lib/cache/semanticCacheDbBridge.ts");
const { PUT } = await import("../../../src/app/api/settings/cache-config/route.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
test.after(() => resetDbInstance());

/** Writes cache settings the way the cache-config route does, then refreshes the resolver snapshot. */
async function setCacheSettings(cache: Record<string, unknown>) {
  await ensureSemanticCacheDbBridge();
  for (const [key, value] of Object.entries(cache)) {
    await setConfigValue("databaseSettings", `cache.${key}`, encryptCacheValue(key, value));
  }
  await refreshSemanticCacheDbBridge();
}

for (const key of [undefined, "********"]) {
  test(`changing provider cannot transfer the previous explicit key (${key ?? "omitted"})`, async () => {
    await setCacheSettings({
      semanticCacheEmbeddingProvider: "fixture-provider-a",
      semanticCacheEmbeddingBaseUrl: "",
      semanticCacheEmbeddingApiKey: "fixture-only-key-a",
    });
    const response = await PUT(
      new Request("http://localhost/api/settings/cache-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          semanticCacheEmbeddingProvider: "fixture-provider-b",
          semanticCacheEmbeddingApiKey: key,
        }),
      }) as never
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await getDatabaseSettingsSection("cache")).semanticCacheEmbeddingProvider,
      "fixture-provider-a"
    );
  });
}
