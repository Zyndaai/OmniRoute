/**
 * Tests for src/lib/db/serviceModels.ts
 *
 * Uses the per-process Postgres test database (tests/_setup/isolatePostgres.ts),
 * emptied between tests with resetTestDb().
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-service-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const { getServiceModels, saveServiceModels, markAllUnavailable } =
  await import("../../../src/lib/db/serviceModels.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function writeRawValue(tool: string, value: unknown): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('serviceModels', $1, $2::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [tool, JSON.stringify(value)]
  );
}

test("getServiceModels — returns [] when no row exists", async () => {
  const result = await getServiceModels("9router");
  assert.deepEqual(result, []);
});

test("saveServiceModels + getServiceModels — round-trips a list (with available flag)", async () => {
  const models = [
    { id: "9r/gemma-3n-e4b", name: "Gemma 3n", object: "model", owned_by: "google" },
    { id: "9r/llama-3.3-70b", name: "Llama 3.3 70B", object: "model", owned_by: "meta" },
  ];
  await saveServiceModels("9router", models);
  const result = await getServiceModels("9router");
  assert.equal(result.length, 2);
  // Models are enriched with available: true on save.
  assert.equal(result[0].id, "9r/gemma-3n-e4b");
  assert.equal(result[0].available, true);
  assert.equal(result[1].id, "9r/llama-3.3-70b");
  assert.equal(result[1].available, true);
});

test("saveServiceModels — incoming model replaces old; old model pruned to available=false", async () => {
  await saveServiceModels("9router", [{ id: "old-model" }]);
  await saveServiceModels("9router", [{ id: "new-model" }]);
  const result = await getServiceModels("9router");
  // Both old and new are present — old is pruned (available=false), new is active.
  const byId = Object.fromEntries(result.map((m) => [m.id, m]));
  assert.ok("old-model" in byId, "old-model should persist (soft delete)");
  assert.equal(byId["old-model"].available, false);
  assert.ok("new-model" in byId, "new-model should be present");
  assert.equal(byId["new-model"].available, true);
});

test("saveServiceModels — saving empty list marks previous models as unavailable (no hard delete)", async () => {
  await saveServiceModels("9router", [{ id: "some-model" }]);
  await saveServiceModels("9router", []);
  const result = await getServiceModels("9router");
  // Pruning keeps the model around as unavailable rather than deleting.
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "some-model");
  assert.equal(result[0].available, false);
});

test("models are scoped by tool — different tools don't interfere", async () => {
  await saveServiceModels("9router", [{ id: "nr-model" }]);
  await saveServiceModels("cliproxyapi", [{ id: "cli-model" }]);

  assert.equal((await getServiceModels("9router"))[0].id, "nr-model");
  assert.equal((await getServiceModels("cliproxyapi"))[0].id, "cli-model");
});

test("getServiceModels — returns [] when stored value is not an array", async () => {
  await writeRawValue("9router", { id: "not-an-array" });

  const result = await getServiceModels("9router");
  assert.deepEqual(result, []);
});

test("saveServiceModels — pruning: models missing from new payload have available=false", async () => {
  // Initial save with 3 models.
  await saveServiceModels("9router", [
    { id: "9router/model-a" },
    { id: "9router/model-b" },
    { id: "9router/model-c" },
  ]);

  // Second save — model-b is missing (pruned), model-c stays, model-d is new.
  await saveServiceModels("9router", [{ id: "9router/model-c" }, { id: "9router/model-d" }]);

  const result = await getServiceModels("9router");

  const byId = Object.fromEntries(result.map((m) => [m.id, m]));

  // model-a was in first payload but not second, should be pruned
  assert.ok("9router/model-a" in byId, "pruned model-a should still exist (soft delete)");
  assert.equal(byId["9router/model-a"].available, false, "pruned model-a should be unavailable");

  // model-b was in first payload but not second, should be pruned
  assert.ok("9router/model-b" in byId, "pruned model-b should still exist (soft delete)");
  assert.equal(byId["9router/model-b"].available, false, "pruned model-b should be unavailable");

  // model-c was in both payloads — should be available
  assert.equal(byId["9router/model-c"].available, true, "model-c should be available");

  // model-d is new — should be available
  assert.equal(byId["9router/model-d"].available, true, "model-d should be available");
});

test("saveServiceModels — incoming models are marked available=true", async () => {
  await saveServiceModels("9router", [{ id: "9router/cx/gpt-5-mini", name: "GPT-5 mini" }]);
  const result = await getServiceModels("9router");
  assert.equal(result.length, 1);
  assert.equal(result[0].available, true);
});

test("markAllUnavailable — flips all rows for the given tool to available=false", async () => {
  await saveServiceModels("9router", [{ id: "9router/model-x" }, { id: "9router/model-y" }]);

  await markAllUnavailable("9router");

  const result = await getServiceModels("9router");
  assert.equal(result.length, 2);
  for (const m of result) {
    assert.equal(m.available, false, `${m.id} should be unavailable after markAllUnavailable`);
  }
});

test("markAllUnavailable — does not affect other tools", async () => {
  await saveServiceModels("9router", [{ id: "9router/model-x" }]);
  await saveServiceModels("cliproxy", [{ id: "cliproxy/model-z" }]);

  await markAllUnavailable("9router");

  const cliproxyModels = await getServiceModels("cliproxy");
  assert.equal(cliproxyModels.length, 1);
  // cliproxy models should not have been touched
  assert.notEqual(cliproxyModels[0].available, false, "cliproxy model should not be affected");
});

test("markAllUnavailable — is a no-op when no models stored", async () => {
  await assert.doesNotReject(() => markAllUnavailable("9router"));
  const result = await getServiceModels("9router");
  assert.deepEqual(result, []);
});

test("available field exists on ServiceModel interface (structural check)", async () => {
  await saveServiceModels("9router", [{ id: "9router/test-model", available: true }]);
  const result = await getServiceModels("9router");
  assert.ok("available" in result[0], "available field should be present in stored model");
});
