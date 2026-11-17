import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-display-catalog-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = "display-catalog-test-secret";
const core = await import("../../src/lib/db/core.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("../../src/lib/db/models.ts");
const { getActiveSyncedCatalog } = await import("../../src/lib/db/models/activeSyncedCatalog.ts");

const { getTestBackend } = await import("../helpers/postgres.ts");

async function setCustomModelsRow(provider: string, models: unknown[]) {
  await getTestBackend().execute(
    `INSERT INTO provider_model_catalog (provider, custom_models) VALUES ($1, $2::jsonb)
     ON CONFLICT (provider) DO UPDATE SET custom_models = EXCLUDED.custom_models`,
    [provider, JSON.stringify(models)]
  );
}

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("display snapshot unions active connections, excludes inactive catalogs and custom/import overlays", async () => {
  const db = getTestBackend();
  const now = new Date().toISOString();
  for (const [id, active] of [
    ["active-a", true],
    ["active-b", true],
    ["inactive", false],
  ] as const) {
    await db.execute(
      "INSERT INTO provider_connections (id,provider,is_active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5)",
      [id, "nvidia", active, now, now]
    );
    await replaceSyncedAvailableModelsForConnection("nvidia", id, [
      { id: `${id}-model`, name: id },
    ]);
  }
  await setCustomModelsRow("nvidia", [
    { id: "manual", source: "custom" },
    { id: "old-import", source: "imported" },
  ]);
  const catalog = await getActiveSyncedCatalog("nvidia", false);
  assert.equal(catalog.authoritative, true);
  assert.deepEqual(catalog.models.map((m) => m.id).sort(), ["active-a-model", "active-b-model"]);
});

test("custom rows alone cannot establish an authoritative discovery snapshot", async () => {
  await setCustomModelsRow("openai", [{ id: "manual", source: "custom" }]);
  const catalog = await getActiveSyncedCatalog("openai", false);
  assert.equal(catalog.authoritative, false);
  assert.equal(catalog.models.length, 0);
});
