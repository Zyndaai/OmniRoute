import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelCapabilityEntry } from "../../../src/lib/modelsDevSync.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capability-modality-sets-"));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  API_KEY_SECRET: "capability-modality-fixture-secret",
  APP_LOG_TO_FILE: "false",
});
const core = await import("../../../src/lib/db/core.ts");
const {
  upsertSyncedCapabilities,
  saveModelsDevCapabilities,
  getSyncedCapabilities,
  loadAllSyncedCapabilitiesUncached,
} = await import("../../../src/lib/modelsDevSync.ts");
const { getModelCatalogCacheVersion } = await import("../../../src/lib/db/readCache.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function capability(overrides: Partial<ModelCapabilityEntry> = {}): ModelCapabilityEntry {
  return {
    tool_call: null,
    reasoning: null,
    reasoning_efforts: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: '["image","text"]',
    modalities_output: '["audio","text"]',
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...overrides,
  };
}

for (const field of ["modalities_input", "modalities_output"] as const) {
  for (const [label, stored] of [
    ["malformed JSON", "["],
    ["scalar JSON", '"text"'],
    ["object JSON", '{"text":true}'],
    ["numeric member", '["text",1]'],
    ["null member", '["text",null]'],
  ]) {
    test(`${field}: ${label} is repaired, not treated as an equivalent set`, async () => {
      const modelId = `${field}/${label}`;
      await upsertSyncedCapabilities("fixture", { [modelId]: capability({ [field]: stored }) });
      const before = getModelCatalogCacheVersion();
      const valid = capability();

      await upsertSyncedCapabilities("fixture", { [modelId]: valid });
      const after = getModelCatalogCacheVersion();
      assert.notEqual(after, before);
      assert.deepEqual((await loadAllSyncedCapabilitiesUncached()).fixture[modelId], valid);
      await upsertSyncedCapabilities("fixture", { [modelId]: valid });
      assert.equal(getModelCatalogCacheVersion(), after);
    });
  }
}

test("stored set preservation is scoped to both provider and model", async () => {
  const legacy = capability({ modalities_input: '["text","image","text"]' });
  const anotherModel = capability({ modalities_input: '["video"]' });
  const anotherProvider = capability({ modalities_input: '["audio"]' });
  await upsertSyncedCapabilities("scope-a", { same: legacy, other: anotherModel });
  await upsertSyncedCapabilities("scope-b", { same: anotherProvider });
  const before = getModelCatalogCacheVersion();

  await upsertSyncedCapabilities("scope-a", { same: capability() });
  assert.equal(getModelCatalogCacheVersion(), before);
  const rows = await loadAllSyncedCapabilitiesUncached();
  assert.deepEqual(rows["scope-a"].same, legacy);
  assert.deepEqual(rows["scope-a"].other, anotherModel);
  assert.deepEqual(rows["scope-b"].same, anotherProvider);

  await upsertSyncedCapabilities("scope-b", { same: capability() });
  assert.notEqual(getModelCatalogCacheVersion(), before);
  assert.deepEqual((await loadAllSyncedCapabilitiesUncached())["scope-b"].same, capability());
});

test("full-sync legacy sets remain stable on discovery with a warm read cache", async () => {
  const legacy = capability({
    modalities_input: '["text","image","text"]',
    modalities_output: '["text","audio","audio"]',
  });
  await saveModelsDevCapabilities({ "sync-fixture": { model: legacy } });
  assert.deepEqual((await getSyncedCapabilities())["sync-fixture"].model, legacy);
  const before = getModelCatalogCacheVersion();

  await upsertSyncedCapabilities("sync-fixture", { model: capability() });
  assert.equal(getModelCatalogCacheVersion(), before);
  assert.deepEqual((await loadAllSyncedCapabilitiesUncached())["sync-fixture"].model, legacy);
  assert.deepEqual((await getSyncedCapabilities())["sync-fixture"].model, legacy);

  await upsertSyncedCapabilities("sync-fixture", {
    model: capability({ modalities_output: "[]" }),
  });
  assert.notEqual(getModelCatalogCacheVersion(), before);
  const expected = { ...legacy, modalities_output: "[]" };
  assert.deepEqual((await loadAllSyncedCapabilitiesUncached())["sync-fixture"].model, expected);
  assert.deepEqual((await getSyncedCapabilities())["sync-fixture"].model, expected);
});
