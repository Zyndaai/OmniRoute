import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-copilot-retired-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");

// Synced model lists belong to a provider connection (foreign key), so each test connection is
// created first. Inserts are idempotent so tests can share a connection id.
async function ensureConnection(connectionId: string, provider: string): Promise<void> {
  await getTestBackend().execute(
    "INSERT INTO provider_connections (id, provider) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [connectionId, provider]
  );
}

// Writes a synced-model list straight into connection_model_sync, the way a cache written before
// the retirement rule existed would look. Readers must still hide retired models from it.
async function writeLegacySyncedModels(connectionId: string, provider: string, models: unknown[]) {
  await ensureConnection(connectionId, provider);
  await getTestBackend().execute(
    `INSERT INTO connection_model_sync (connection_id, provider, models)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (connection_id) DO UPDATE SET provider = EXCLUDED.provider, models = EXCLUDED.models`,
    [connectionId, provider, JSON.stringify(models)]
  );
}

before(async () => {
  await resetTestDb();
});

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("GitHub Copilot sync rejects retired Gemini models", async () => {
  await ensureConnection("copilot-current", "github");
  await modelsDb.replaceSyncedAvailableModelsForConnection("github", "copilot-current", [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ]);

  const ids = (await modelsDb.getSyncedAvailableModels("github")).map((model) => model.id);
  assert.deepEqual(ids, ["gemini-3.8-flash"]);
});

test("GitHub Copilot readers hide retired models from legacy synced caches", async () => {
  await writeLegacySyncedModels("copilot-legacy", "github", [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ]);

  const connectionIds = (
    await modelsDb.getSyncedAvailableModelsForConnection("github", "copilot-legacy")
  ).map((model) => model.id);
  const providerIds = (await modelsDb.getSyncedAvailableModels("github")).map((model) => model.id);
  const allProviderIds = (await modelsDb.getAllSyncedAvailableModels()).github.map(
    (model) => model.id
  );

  assert.deepEqual(connectionIds, ["gemini-3.8-flash"]);
  assert.deepEqual(providerIds, ["gemini-3.8-flash"]);
  assert.deepEqual(allProviderIds, ["gemini-3.8-flash"]);
});

test("provider inference does not route retired Gemini models to GitHub Copilot", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "github",
    authType: "oauth",
    name: "copilot-retired-routing",
    accessToken: "github-test-token",
    isActive: true,
    testStatus: "active",
  });
  await writeLegacySyncedModels(connection.id, "github", [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ]);

  assert.deepEqual(await modelsDb.getActiveProvidersWithSyncedModel("gemini-2.5-pro"), []);
  assert.deepEqual(await modelsDb.getActiveProvidersWithSyncedModel("gemini-3.8-flash"), [
    "github",
  ]);
});

test("retirement remains scoped to GitHub Copilot", async () => {
  await ensureConnection("gemini-direct", "gemini");
  await modelsDb.replaceSyncedAvailableModelsForConnection("gemini", "gemini-direct", [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  ]);

  const ids = (await modelsDb.getSyncedAvailableModels("gemini")).map((model) => model.id);
  assert.deepEqual(ids, ["gemini-2.5-pro", "gemini-3-flash"]);
});

test("locally removed Copilot models cannot return through cached or newly synced data", async () => {
  const rows = [
    "gpt-5.4",
    "gpt-5.5",
    "claude-fable-5",
    "claude-sonnet-4.6",
    "grok-4.5",
    "gemini-3.7-flash",
    "mai-code-1-flash",
    "kimi-k2.7-code",
    "gpt-6-astra",
  ].map((id) => ({ id, name: id }));
  await writeLegacySyncedModels("curated-legacy", "github", rows);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModelsForConnection("github", "curated-legacy")).map(
      (m) => m.id
    ),
    ["gpt-6-astra"]
  );
  await ensureConnection("curated-new", "github");
  await modelsDb.replaceSyncedAvailableModelsForConnection("github", "curated-new", rows);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModelsForConnection("github", "curated-new")).map(
      (m) => m.id
    ),
    ["gpt-6-astra"]
  );
});
