import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-llamacpp-delete-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { db } = await import("../../../src/lib/db/pg.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");

const CONNECTION_IDS = ["conn-a", "conn-b", "conn-x", "conn-y", "conn-ok", "broken"];

async function resetStorage() {
  await resetTestDb();
  // Synced model rows reference provider_connections (FK), so each connection needs one.
  for (const id of CONNECTION_IDS) {
    await db().execute("INSERT INTO provider_connections (id, provider) VALUES ($1, $2)", [
      id,
      "llama-cpp",
    ]);
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function syncedModelsFor(connectionId: string): Promise<unknown> {
  const row = await db().queryOne<{ models: unknown }>(
    "SELECT models FROM connection_model_sync WHERE connection_id = $1",
    [connectionId]
  );
  return row?.models;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("removeSyncedAvailableModel deletes a single model from syncedAvailableModels", async () => {
  // Seed two connections with models
  await modelsDb.replaceSyncedAvailableModelsForConnection("llama-cpp", "conn-a", [
    { id: "model-a", name: "Model A" },
    { id: "model-b", name: "Model B" },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection("llama-cpp", "conn-b", [
    { id: "model-b", name: "Model B" },
    { id: "model-c", name: "Model C" },
  ]);

  // Remove model-b from all connections
  const removed = await modelsDb.removeSyncedAvailableModel("llama-cpp", "model-b");
  assert.equal(removed, true, "should report removal");

  // Verify model-b is gone
  const remaining = await modelsDb.getSyncedAvailableModels("llama-cpp");
  const ids = remaining.map((m) => m.id);
  assert.deepEqual(ids.sort(), ["model-a", "model-c"]);

  // Verify conn-a still has model-a
  const modelsA = (await syncedModelsFor("conn-a")) as Array<{ id: string }>;
  assert.equal(modelsA.length, 1);
  assert.equal(modelsA[0].id, "model-a");

  // Verify conn-b still has model-c
  const modelsB = (await syncedModelsFor("conn-b")) as Array<{ id: string }>;
  assert.equal(modelsB.length, 1);
  assert.equal(modelsB[0].id, "model-c");
});

test("removeSyncedAvailableModel empties a connection once its last model is removed", async () => {
  await modelsDb.replaceSyncedAvailableModelsForConnection("llama-cpp", "conn-x", [
    { id: "only-model", name: "Only Model" },
  ]);

  const removed = await modelsDb.removeSyncedAvailableModel("llama-cpp", "only-model");
  assert.equal(removed, true);

  assert.deepEqual(
    await syncedModelsFor("conn-x"),
    [],
    "the connection keeps no models once its only model is removed"
  );
});

test("removeSyncedAvailableModel returns false when model does not exist", async () => {
  await modelsDb.replaceSyncedAvailableModelsForConnection("llama-cpp", "conn-y", [
    { id: "model-1", name: "Model 1" },
  ]);

  const removed = await modelsDb.removeSyncedAvailableModel("llama-cpp", "nonexistent");
  assert.equal(removed, false);

  const remaining = await modelsDb.getSyncedAvailableModels("llama-cpp");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "model-1");
});

test("removeSyncedAvailableModel skips malformed syncedAvailableModels rows", async () => {
  await modelsDb.replaceSyncedAvailableModelsForConnection("llama-cpp", "conn-ok", [
    { id: "model-ok", name: "Model OK" },
    { id: "model-delete", name: "Model Delete" },
  ]);
  // The models column is jsonb, so the malformed entry is a valid JSON value that is
  // not an array (the only shape removal has to skip).
  await db().execute(
    "INSERT INTO connection_model_sync (connection_id, provider, models) VALUES ($1, $2, $3::jsonb)",
    ["broken", "llama-cpp", '{"not":"an array"}']
  );

  const removed = await modelsDb.removeSyncedAvailableModel("llama-cpp", "model-delete");
  assert.equal(removed, true);

  const validModels = (await syncedModelsFor("conn-ok")) as Array<{ id: string }>;
  assert.deepEqual(
    validModels.map((m) => m.id),
    ["model-ok"]
  );

  assert.deepEqual(await syncedModelsFor("broken"), { not: "an array" });
});
