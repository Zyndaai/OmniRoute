import assert from "node:assert/strict";
import test from "node:test";

const models = await import("../../../src/lib/db/models.ts");
const readCache = await import("../../../src/lib/db/readCache.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

function catalogVersion() {
  return readCache.getModelCatalogCacheVersion();
}

/** Rows are the only write evidence Postgres gives: a skipped write leaves updated_at alone. */
async function syncedRow(connectionId: string) {
  return (
    (await getTestBackend().queryOne<{ updated_at: string; models: unknown }>(
      "SELECT updated_at, models FROM connection_model_sync WHERE connection_id = $1",
      [connectionId]
    )) ?? null
  );
}

// connection_model_sync rows have a foreign key to provider_connections, so a sync for an
// unknown connection is dropped. Each test connection must exist first.
async function ensureConnection(providerId: string, connectionId: string) {
  await getTestBackend().execute(
    "INSERT INTO provider_connections (id, provider) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [connectionId, providerId]
  );
}

async function seedSynced(providerId: string, connectionId: string, value: unknown) {
  await ensureConnection(providerId, connectionId);
  await getTestBackend().execute(
    `INSERT INTO connection_model_sync (connection_id, provider, models) VALUES ($1, $2, $3::jsonb)`,
    [connectionId, providerId, JSON.stringify(value)]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
});

test("replace invalidates only for canonical persisted changes", async () => {
  await ensureConnection("openai", "a");
  const initialVersion = catalogVersion();

  await models.replaceSyncedAvailableModelsForConnection("openai", "a", [
    {
      id: "gpt-b",
      name: " GPT B ",
      source: "ignored",
      supportedEndpoints: ["responses", "chat", "chat"],
    },
    { id: "gpt-a", name: "GPT A" },
  ]);
  assert.equal(catalogVersion(), initialVersion + 1);

  const beforeIdenticalRow = await syncedRow("a");
  const beforeIdenticalVersion = catalogVersion();
  await models.replaceSyncedAvailableModelsForConnection("openai", "a", [
    {
      id: "gpt-b",
      name: "GPT B",
      source: "imported",
      supportedEndpoints: ["chat", "responses"],
    },
    { id: "gpt-a", name: "GPT A", source: "imported" },
  ]);
  assert.deepEqual(
    await syncedRow("a"),
    beforeIdenticalRow,
    "canonical equality must skip the DB write"
  );
  assert.equal(catalogVersion(), beforeIdenticalVersion, "canonical equality must not invalidate");

  await models.replaceSyncedAvailableModelsForConnection("openai", "a", [
    { id: "gpt-a", name: "GPT A" },
    { id: "gpt-b", name: "GPT B", supportedEndpoints: ["chat", "responses"] },
  ]);
  assert.equal(catalogVersion(), beforeIdenticalVersion + 1, "ordering changes are persisted");

  await models.replaceSyncedAvailableModelsForConnection("openai", "a", [
    { id: "gpt-a", name: "GPT A renamed" },
    { id: "gpt-b", name: "GPT B", supportedEndpoints: ["chat", "responses"] },
  ]);
  assert.equal(catalogVersion(), beforeIdenticalVersion + 2, "content changes are persisted");
});

test("replace handles empty and normalized models without phantom writes", async () => {
  await ensureConnection("openai", "absent");
  await ensureConnection("openai", "present");
  const startVersion = catalogVersion();

  await models.replaceSyncedAvailableModelsForConnection("openai", "absent", []);
  assert.equal(await syncedRow("absent"), null, "absent-to-empty replacement must be a no-op");
  assert.equal(catalogVersion(), startVersion);

  await models.replaceSyncedAvailableModelsForConnection("openai", "absent", [
    { id: "restored", name: "Restored" },
  ]);
  assert.deepEqual(
    (await models.getSyncedAvailableModelsForConnection("openai", "absent")).map(
      (model) => model.id
    ),
    ["restored"]
  );

  await seedSynced("openai", "present", [{ id: "existing", name: "Existing" }]);
  const beforeDeleteVersion = catalogVersion();
  await models.replaceSyncedAvailableModelsForConnection("openai", "present", []);
  assert.equal(catalogVersion(), beforeDeleteVersion + 1, "present-to-empty must invalidate");
  assert.deepEqual(await models.getSyncedAvailableModelsForConnection("openai", "present"), []);
});

test("remove and connection/provider deletes invalidate only when rows actually change", async () => {
  let version = catalogVersion();
  assert.equal(await models.removeSyncedAvailableModel("openai", "missing"), false);
  assert.equal(catalogVersion(), version);

  await seedSynced("openai", "a", [
    { id: "gpt-a", name: "GPT A" },
    { id: "gpt-b", name: "GPT B" },
  ]);
  assert.equal(await models.removeSyncedAvailableModel("openai", "gpt-a"), true);
  assert.equal(catalogVersion(), ++version);
  assert.equal(await models.removeSyncedAvailableModel("openai", "gpt-a"), false);
  assert.equal(catalogVersion(), version);

  await models.deleteSyncedAvailableModelsForConnection("openai", "missing");
  assert.equal(catalogVersion(), version);
  await models.deleteSyncedAvailableModelsForConnection("openai", "a");
  assert.equal(catalogVersion(), ++version);

  assert.equal(await models.deleteSyncedAvailableModelsForProvider("openai"), 0);
  assert.equal(catalogVersion(), version);
  await seedSynced("openai", "b", [{ id: "gpt-b", name: "GPT B" }]);
  await seedSynced("openai", "c", [{ id: "gpt-c", name: "GPT C" }]);
  assert.equal(await models.deleteSyncedAvailableModelsForProvider("openai"), 2);
  assert.equal(catalogVersion(), ++version);
});

test("prune uses affected rows and the delegated provider delete invalidates exactly once", async () => {
  await seedSynced("openai", "keep", [{ id: "gpt-a", name: "GPT A" }]);
  await seedSynced("openai", "stale", [{ id: "gpt-b", name: "GPT B" }]);
  let version = catalogVersion();

  assert.equal(
    await models.pruneStaleSyncedAvailableModelsForProvider("openai", ["keep", "stale"]),
    0
  );
  assert.equal(catalogVersion(), version);

  assert.equal(await models.pruneStaleSyncedAvailableModelsForProvider("openai", ["keep"]), 1);
  assert.equal(catalogVersion(), ++version);

  assert.equal(await models.pruneStaleSyncedAvailableModelsForProvider("openai", []), 1);
  assert.equal(catalogVersion(), ++version, "delegated provider delete must invalidate once");

  assert.equal(await models.pruneStaleSyncedAvailableModelsForProvider("openai", []), 0);
  assert.equal(catalogVersion(), version);
});
