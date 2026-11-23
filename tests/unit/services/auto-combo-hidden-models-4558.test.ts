/**
 * #4558 — Auto-combo must respect model visibility (isHidden).
 *
 * When an operator hides a model with the EYE/visibility toggle
 * (`mergeModelCompatOverride(provider, model, { isHidden: true })`, stored in the
 * stored as a model compat override), that model must be excluded from the
 * AUTO-combo candidate pool. Both auto paths consume the same seam:
 *   - `open-sse/services/combo.ts::buildAutoCandidates` (combo.ts:322,520-521)
 *   - `open-sse/services/autoCombo/virtualFactory.ts` (virtualFactory.ts:239,256-257)
 * via the bulk `getHiddenModelsByProvider()` map (single query, not N+1).
 *
 * This guards that seam: a hidden model is present in the map's per-provider set
 * while a visible sibling is not, and that toggling visibility back off
 * (`isHidden: null`) removes it from the map again. Without the fix the map is
 * empty and the auto pool would keep serving hidden models.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Hermetic data dir for the file-based parts of the app; the model overrides
// themselves live in the PostgreSQL database isolated per test file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-hidden-4558-"));
process.env.DATA_DIR = tmpDir;

const {
  addCustomModel,
  getHiddenModelsByProvider,
  getModelIsHidden,
  mergeModelCompatOverride,
  updateCustomModel,
} = await import("@/lib/db/models");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

before(async () => {
  await resetTestDb();
});

after(async () => {
  await resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const PROVIDER = "openai";
const HIDDEN_MODEL = "gpt-hidden-preview";
const VISIBLE_MODEL = "gpt-visible-4o";

test("getHiddenModelsByProvider: empty before any model is hidden", async () => {
  const map = await getHiddenModelsByProvider();
  assert.equal(map.get(PROVIDER)?.has(HIDDEN_MODEL) ?? false, false);
});

test("a hidden model lands in the provider's hidden set; a visible sibling does not", async () => {
  // Hide one model, leave a sibling visible (overridden for an unrelated reason).
  await mergeModelCompatOverride(PROVIDER, HIDDEN_MODEL, { isHidden: true });
  await mergeModelCompatOverride(PROVIDER, VISIBLE_MODEL, { normalizeToolCallId: true });

  // Sanity: the per-model read agrees.
  assert.equal(await getModelIsHidden(PROVIDER, HIDDEN_MODEL), true);
  assert.equal(await getModelIsHidden(PROVIDER, VISIBLE_MODEL), false);

  const map = await getHiddenModelsByProvider();
  const hiddenForProvider = map.get(PROVIDER);
  assert.ok(hiddenForProvider, "expected an entry for the provider");
  assert.equal(hiddenForProvider.has(HIDDEN_MODEL), true, "hidden model must be in the set");
  assert.equal(
    hiddenForProvider.has(VISIBLE_MODEL),
    false,
    "visible model must NOT be in the hidden set"
  );
});

test("un-hiding a model (isHidden: null) removes it from the map", async () => {
  await mergeModelCompatOverride(PROVIDER, HIDDEN_MODEL, { isHidden: null });
  const map = await getHiddenModelsByProvider();
  assert.equal(
    map.get(PROVIDER)?.has(HIDDEN_MODEL) ?? false,
    false,
    "un-hidden model must drop out of the hidden set"
  );
});

test("an explicit visible custom-model setting overrides a hidden compat fallback", async () => {
  const modelId = "gpt-custom-visible-override";
  await mergeModelCompatOverride(PROVIDER, modelId, { isHidden: true });
  await addCustomModel(PROVIDER, modelId);
  await updateCustomModel(PROVIDER, modelId, { isHidden: false });

  assert.equal(await getModelIsHidden(PROVIDER, modelId), false);
  const map = await getHiddenModelsByProvider();
  assert.equal(map.get(PROVIDER)?.has(modelId) ?? false, false);
});
