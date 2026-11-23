import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-16929-model-endpoints-"));
process.env.DATA_DIR = folder;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../../src/lib/db/core.ts");
const models = await import("../../../src/lib/db/models.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

test.beforeEach(async () => {
  await resetTestDb();
  core.resetDbInstance();
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
});
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(folder, { recursive: true, force: true });
});

// connection_model_sync has a foreign key to provider_connections: sync needs a real parent row.
async function makeConnection(name: string): Promise<string> {
  const connection = await providersDb.createProviderConnection({
    provider: "deepseek",
    authType: "apikey",
    name,
    apiKey: "sk-test",
    isActive: true,
  });
  return String((connection as { id: string }).id);
}

test("#16929: a virtual endpoint override resets without deleting discovered model", async () => {
  const connection1 = await makeConnection("deepseek-1");
  await models.replaceSyncedAvailableModelsForConnection("deepseek", connection1, [
    {
      id: "model-stt",
      name: "Speech",
      apiFormat: "audio-transcriptions",
      supportedEndpoints: ["audio-transcriptions"],
      endpointCapabilitySource: "declared",
    },
  ]);
  // The dashboard PUT route edits a synced-only model with createIfMissing.
  const edited = await models.updateCustomModel(
    "deepseek",
    "model-stt",
    { supportedEndpoints: ["chat"] },
    { createIfMissing: true }
  );
  assert.equal(edited?.source, "endpoint-override");
  assert.equal(edited?.endpointCapabilitySource, "operator");
  const { getActiveSyncedCatalog } = await import("../../../src/lib/db/models/activeSyncedCatalog.ts");
  const active = await getActiveSyncedCatalog("deepseek");
  const observed = active.models.find((row) => row.id === "model-stt");
  assert.equal(observed?.name, "Speech");
  assert.equal(observed?.apiFormat, "audio-transcriptions");
  assert.deepEqual(observed?.supportedEndpoints, ["chat"]);
  await models.replaceSyncedAvailableModelsForConnection("deepseek", connection1, [
    {
      id: "model-stt",
      name: "New upstream name",
      supportedEndpoints: ["audio-transcriptions"],
      endpointCapabilitySource: "declared",
    },
  ]);
  assert.deepEqual((await models.getCustomModels("deepseek"))[0].supportedEndpoints, ["chat"]);
  assert.equal(await models.resetModelEndpointOverride("deepseek", "model-stt"), true);
  assert.deepEqual(await models.getCustomModels("deepseek"), []);
  assert.deepEqual((await models.getSyncedAvailableModels("deepseek"))[0].supportedEndpoints, [
    "audio-transcriptions",
  ]);
});

test("#16929: reset only endpoints and preserves unrelated operator settings", async () => {
  const connection2 = await makeConnection("deepseek-2");
  await models.replaceSyncedAvailableModelsForConnection("deepseek", connection2, [
    {
      id: "model-rerank",
      name: "Rerank",
      supportedEndpoints: ["rerank"],
      endpointCapabilitySource: "inferred",
    },
  ]);
  await models.addCustomModel("deepseek", "model-rerank", "Own alias", "imported", "rerank", [
    "rerank",
  ]);
  await models.updateCustomModel("deepseek", "model-rerank", {
    supportedEndpoints: ["chat"],
    normalizeToolCallId: true,
  });
  await models.replaceCustomModels("deepseek", [
    {
      id: "model-rerank",
      name: "Fresh sync",
      source: "imported",
      supportedEndpoints: ["rerank"],
    },
  ]);
  assert.deepEqual((await models.getCustomModels("deepseek"))[0].supportedEndpoints, ["chat"]);
  assert.equal(await models.resetModelEndpointOverride("deepseek", "model-rerank"), true);
  const [restored] = await models.getCustomModels("deepseek");
  assert.deepEqual(restored.supportedEndpoints, ["rerank"]);
  assert.equal(restored.endpointCapabilitySource, "inferred");
  assert.equal(restored.normalizeToolCallId, true);
  assert.equal(await models.resetModelEndpointOverride("deepseek", "model-rerank"), false);
});
