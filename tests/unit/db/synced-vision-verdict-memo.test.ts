/**
 * Synced vision verdict memo: on-demand reads must not re-read the whole
 * provider catalog on every resolution.
 *
 * The memo is gated on the shared model-catalog cache version and rebuilt
 * after each catalog write. A failed bulk read is never stored.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-synced-vision-memo-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const models = await import("../../../src/lib/db/models.ts");
const readCache = await import("../../../src/lib/db/readCache.ts");
const vision = await import("../../../src/lib/db/models/syncedAvailableModelVision.ts");

// Counts the reads of the synced-catalog table issued through the process backend.
let catalogReads = 0;
let trackedBackend: ReturnType<typeof getTestBackend> | null = null;

function patchQueryCounter() {
  const backend = getTestBackend();
  if (trackedBackend === backend) return;
  const original = backend.query.bind(backend);
  backend.query = ((sql: string, ...rest: unknown[]) => {
    if (typeof sql === "string" && sql.includes("connection_model_sync")) catalogReads += 1;
    return (original as (...args: unknown[]) => unknown)(sql, ...rest);
  }) as typeof backend.query;
  trackedBackend = backend;
}

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // Synced catalog rows belong to a provider connection (foreign key), so the
  // connection ids used below must exist.
  for (const id of ["conn-a", "conn-b", "keep", "stale"]) {
    await getTestBackend().execute(
      "INSERT INTO provider_connections (id, provider, auth_type) VALUES ($1, 'acme', 'apikey') ON CONFLICT (id) DO NOTHING",
      [id]
    );
  }
  catalogReads = 0;
  vision.resetSyncedVisionVerdictMemoForTests();
  patchQueryCounter();
}

async function seedSynced(providerId: string, connectionId: string, value: unknown) {
  await models.replaceSyncedAvailableModelsForConnection(
    providerId,
    connectionId,
    value as Parameters<typeof models.replaceSyncedAvailableModelsForConnection>[2]
  );
}

function memoEntries(): number {
  return vision.getSyncedVisionVerdictMemoSizeForTests();
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("serves repeated lookups from one read after the first", async () => {
  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
    { id: "plain-model", name: "Plain Model" },
  ]);
  catalogReads = 0;

  const lookups = 5;
  for (let i = 0; i < lookups; i += 1) {
    assert.equal(await vision.getSyncedAvailableModelVision("acme", "vision-model"), true);
    assert.equal(await vision.getSyncedAvailableModelVision("acme", "plain-model"), null);
  }

  assert.equal(catalogReads, 1);
  assert.equal(memoEntries(), 1);
  assert.equal(await vision.getSyncedAvailableModelVision("", "vision-model"), null);
  assert.equal(await vision.getSyncedAvailableModelVision("acme", ""), null);
});

test("refreshes the verdict after every writer path", async () => {
  const read = () => vision.getSyncedAvailableModelVision("acme", "vision-model");

  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  assert.equal(await read(), true);

  assert.equal(await models.removeSyncedAvailableModel("acme", "vision-model"), true);
  assert.equal(await read(), null);

  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  assert.equal(await read(), true);
  await models.deleteSyncedAvailableModelsForConnection("acme", "conn-a");
  assert.equal(await read(), null);

  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  assert.equal(await read(), true);
  assert.equal(await models.deleteSyncedAvailableModelsForProvider("acme"), 1);
  assert.equal(await read(), null);

  await models.replaceSyncedAvailableModelsForConnection("acme", "keep", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  await seedSynced("acme", "stale", [{ id: "vision-model", name: "Vision Model" }]);
  assert.equal(await models.pruneStaleSyncedAvailableModelsForProvider("acme", ["keep"]), 1);
  assert.equal(await read(), true);
});

test("serves a stale verdict when a write bypasses the shared exit", async () => {
  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  assert.equal(await vision.getSyncedAvailableModelVision("acme", "vision-model"), true);

  await getTestBackend().execute(
    "UPDATE connection_model_sync SET models = $1::jsonb WHERE connection_id = $2",
    [JSON.stringify([{ id: "vision-model", name: "Vision Model" }]), "conn-a"]
  );

  assert.equal(
    await vision.getSyncedAvailableModelVision("acme", "vision-model"),
    true,
    "unbumped direct write must keep serving the stored verdict"
  );
});

test("does not store failed singleton reads", async () => {
  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  assert.equal(await vision.getSyncedAvailableModelVision("acme", "vision-model"), true);
  vision.resetSyncedVisionVerdictMemoForTests();
  const versionBefore = readCache.getModelCatalogCacheVersion();

  // Make the bulk read fail by moving the table away, then restore it.
  const backend = getTestBackend();
  await backend.execute("ALTER TABLE connection_model_sync RENAME TO connection_model_sync_hidden");
  try {
    assert.equal(await vision.getSyncedAvailableModelVision("acme", "vision-model"), null);
    assert.equal(vision.getSyncedVisionVerdictMemoSizeForTests(), 0);
    assert.equal(readCache.getModelCatalogCacheVersion(), versionBefore);
  } finally {
    await backend.execute(
      "ALTER TABLE connection_model_sync_hidden RENAME TO connection_model_sync"
    );
  }

  await resetStorage();
  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  assert.equal(await vision.getSyncedAvailableModelVision("acme", "vision-model"), true);
  assert.equal(vision.getSyncedVisionVerdictMemoSizeForTests(), 1);
});

test("bypasses the memo for an empty bulk map and stores the empty map", async () => {
  assert.equal(
    await vision.getSyncedAvailableModelVision("acme", "vision-model", new Map()),
    null
  );

  catalogReads = 0;
  assert.equal(await vision.getSyncedAvailableModelVision("acme", "vision-model"), null);
  assert.equal(await vision.getSyncedAvailableModelVision("acme", "other-model"), null);
  assert.equal(catalogReads, 1);
  assert.equal(memoEntries(), 1);
});

test("resolves a wildcard provider id exactly", async () => {
  await seedSynced("acme", "conn-a", [{ id: "vision-model", name: "Vision Model", supportsVision: true }]);
  await seedSynced("acme%", "conn-b", [
    { id: "other-model", name: "Other Model", supportsVision: true },
  ]);

  assert.equal(await vision.getSyncedAvailableModelVision("acme%", "vision-model"), null);
  assert.equal(await vision.getSyncedAvailableModelVision("acme%", "other-model"), true);
});

test("keeps a single stored generation after reads and writes", async () => {
  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
  ]);
  for (let i = 0; i < 5; i += 1) {
    await vision.getSyncedAvailableModelVision("acme", "vision-model");
  }
  await models.replaceSyncedAvailableModelsForConnection("acme", "conn-a", [
    { id: "vision-model", name: "Vision Model", supportsVision: true },
    { id: "second-vision-model", name: "Second", supportsVision: true },
  ]);
  for (let i = 0; i < 5; i += 1) {
    await vision.getSyncedAvailableModelVision("acme", "second-vision-model");
  }
  assert.equal(memoEntries(), 1);
});
