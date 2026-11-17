import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #16929 follow-up: /api/models must bulk-read the `customModels` namespace once per
// request. The capability snapshot owns that read and the live listing reuses it.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-shared-custom-read-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");
const { writeCatalogColumn } = await import("../../src/lib/db/models/catalogRow.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const activeSynced = await import("../../src/lib/db/models/activeSyncedCatalog.ts");
const snapshotModule = await import("../../src/lib/modelCapabilityResolutionSnapshot.ts");

const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");

/**
 * Counts the statements that read the custom-models document of `provider_model_catalog`.
 * The catalog is served from a process snapshot (readCache loadModelMetadataSnapshot), so
 * `cold` drops it first: the count then shows how many reads one cold call costs.
 */
async function countCustomModelReads<T>(
  run: () => Promise<T>,
  { cold = true } = {}
): Promise<{ result: T; reads: number }> {
  if (cold) invalidateDbCache("model-capabilities");
  const backend = getTestBackend() as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originalQuery = backend.query;
  const originalQueryOne = backend.queryOne;
  let reads = 0;
  const wrap =
    (original: (...args: unknown[]) => unknown) =>
    (sql: string, ...rest: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, " ");
      if (
        normalized.includes("custom_models") &&
        normalized.includes("FROM provider_model_catalog")
      ) {
        reads++;
      }
      return original(sql, ...rest);
    };
  backend.query = wrap(originalQuery) as typeof originalQuery;
  backend.queryOne = wrap(originalQueryOne) as typeof originalQueryOne;
  try {
    const result = await run();
    return { result, reads };
  } finally {
    backend.query = originalQuery;
    backend.queryOne = originalQueryOne;
  }
}

test.before(async () => {
  await writeCatalogColumn("custom_models", "openai", [
    { id: "gpt-4o", supportsVision: false },
    { id: "no-flag" },
    { id: "vision-on", supportsVision: true },
  ]);
  // Malformed JSON text can no longer be stored (the column is jsonb); an empty document is.
  await writeCatalogColumn("custom_models", "empty", []);
});

test.after(async () => {
  await core.resetDbInstance();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
});

test("readCustomModelsByProvider reads every non-empty row in one query and skips empty documents", async () => {
  const { result: rows, reads } = await countCustomModelReads(() =>
    modelsDb.readCustomModelsByProvider()
  );
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(rows).sort(), ["openai"]);
  assert.equal((rows.openai as unknown[]).length, 3);
});

test("buildCustomModelVisionOverrides from pre-read rows equals the direct bulk read", async () => {
  const direct = await modelsDb.listCustomModelVisionOverrides();
  const derived = modelsDb.buildCustomModelVisionOverrides(
    await modelsDb.readCustomModelsByProvider()
  );
  assert.deepEqual(
    [...derived].map(([p, m]) => [p, [...m]]),
    [...direct].map(([p, m]) => [p, [...m]])
  );
  assert.equal(derived.get("openai")?.get("gpt-4o"), false);
  assert.equal(derived.get("openai")?.get("vision-on"), true);
  assert.equal(derived.get("openai")?.has("no-flag"), false);
});

test("the capability snapshot reads customModels once and exposes the rows", async () => {
  const { result: snapshot, reads } = await countCustomModelReads(async () =>
    snapshotModule.createModelCapabilityResolutionSnapshot()
  );
  assert.equal(reads, 1, "one bulk read per snapshot");
  assert.ok(snapshot.customModelsByProvider, "snapshot must expose the rows it read");
  assert.equal(snapshot.customVisionOverrides.get("openai")?.get("gpt-4o"), false);
  assert.equal((snapshot.customModelsByProvider?.openai as unknown[]).length, 3);
});

test("getAllActiveSyncedModels reuses the snapshot rows instead of re-reading", async () => {
  const snapshot = await snapshotModule.createModelCapabilityResolutionSnapshot();
  // Cold, so a 0 proves the pre-read map was used rather than the process snapshot.
  const shared = await countCustomModelReads(() =>
    activeSynced.getAllActiveSyncedModels({
      customModelsByProvider: snapshot.customModelsByProvider,
    })
  );
  assert.equal(shared.reads, 0, "a pre-read map must suppress the second namespace read");

  const standalone = await countCustomModelReads(() => activeSynced.getAllActiveSyncedModels());
  assert.equal(standalone.reads, 1, "without a caller snapshot the listing still bulk-reads once");
  assert.deepEqual(shared.result, standalone.result);
});
