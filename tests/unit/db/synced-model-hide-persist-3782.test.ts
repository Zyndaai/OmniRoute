/**
 * #3782 — "Auto Sync Enabling all Models".
 *
 * The eye toggle persists isHidden independently of synced discovery data.
 * Re-sync therefore keeps a hidden model in the synced list without making it
 * visible again, while genuinely new models default to visible.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Hermetic DB: this test writes overrides into the model compat overrides
// namespace. Point DATA_DIR at a throwaway dir before any import that opens the
// DB handle, so the state never leaks into a shared database.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-synced-hide-"));
process.env.DATA_DIR = tmpDir;

const {
  replaceSyncedAvailableModelsForConnection,
  getSyncedAvailableModels,
  mergeModelCompatOverride,
  getModelIsHidden,
} = await import("@/lib/db/models");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

const PROVIDER = "llama-cpp";
// Synced model rows hang off a real provider connection (foreign key), so the id is
// created in `before` and shared by both cases (case B builds on case A's state).
let CONNECTION = "";

before(async () => {
  await resetTestDb();
  const conn = await providersDb.createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    name: "llama-cpp-3782",
    apiKey: "sk-llama-cpp-3782",
  });
  CONNECTION = conn.id as string;
});

after(async () => {
  // Release the DB pool so the Node test runner can exit, then remove the
  // throwaway DATA_DIR (CLAUDE.md "Database Handles in Tests").
  await resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("A: an EYE-hidden synced model is preserved (listed-but-hidden) across re-import", async () => {
  // Initial sync brings in three models, all visible.
  await replaceSyncedAvailableModelsForConnection(PROVIDER, CONNECTION, [
    { id: "A", name: "Alpha" },
    { id: "B", name: "Bravo" },
    { id: "C", name: "Charlie" },
  ]);
  let synced = (await getSyncedAvailableModels(PROVIDER)).map((m) => m.id);
  assert.deepEqual(synced.sort(), ["A", "B", "C"], "all three present after first sync");
  assert.equal(await getModelIsHidden(PROVIDER, "B"), false, "B is visible before eye-hide");

  // Operator hides B with the EYE toggle (visibility only, NOT a delete).
  await mergeModelCompatOverride(PROVIDER, "B", { isHidden: true });
  assert.equal(await getModelIsHidden(PROVIDER, "B"), true, "B is eye-hidden");

  // Auto-fetch re-imports the SAME upstream list (still advertising B).
  await replaceSyncedAvailableModelsForConnection(PROVIDER, CONNECTION, [
    { id: "A", name: "Alpha" },
    { id: "B", name: "Bravo" },
    { id: "C", name: "Charlie" },
  ]);

  synced = (await getSyncedAvailableModels(PROVIDER)).map((m) => m.id);
  assert.ok(synced.includes("B"), "#3782: eye-hidden B STAYS in the synced list after re-sync");
  assert.equal(
    await getModelIsHidden(PROVIDER, "B"),
    true,
    "#3782: eye-hidden B is NOT re-enabled (stays hidden) after re-sync"
  );
  assert.equal(await getModelIsHidden(PROVIDER, "A"), false, "A stays visible");
  assert.equal(await getModelIsHidden(PROVIDER, "C"), false, "C stays visible");
  assert.ok(synced.includes("A") && synced.includes("C"), "A and C still present");
});

test("B: a genuinely-new model on re-sync defaults to VISIBLE", async () => {
  // Continue from Test A state (B eye-hidden); add a new model D.
  await replaceSyncedAvailableModelsForConnection(PROVIDER, CONNECTION, [
    { id: "A", name: "Alpha" },
    { id: "B", name: "Bravo" },
    { id: "C", name: "Charlie" },
    { id: "D", name: "Delta" },
  ]);

  const synced = (await getSyncedAvailableModels(PROVIDER)).map((m) => m.id);
  assert.ok(synced.includes("D"), "new model D is imported");
  assert.equal(await getModelIsHidden(PROVIDER, "D"), false, "new model D defaults to visible");
  // Eye-hidden B is still preserved + hidden.
  assert.ok(synced.includes("B"), "eye-hidden B still present");
  assert.equal(await getModelIsHidden(PROVIDER, "B"), true, "eye-hidden B still hidden");
});
