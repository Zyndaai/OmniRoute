/**
 * TDD: setEngineInDefaultCombo + normalizePipeline (new engines).
 *
 * DB isolation: tests/_setup/isolatePostgres.ts gives this file its own database;
 * resetTestDb() empties it between tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const { getDefaultCompressionCombo, setEngineInDefaultCombo, getCompressionCombo } =
  await import("../../../src/lib/db/compressionCombos.ts");

// ─── lifecycle ────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetTestDb();
});

// ─── tests ────────────────────────────────────────────────────────────────────

test("Fix #1: normalizePipeline passes through new engine IDs (headroom, session-dedup, ccr)", async () => {
  // The default combo is seeded with [session-dedup, lite]. Directly update the DB
  // to include new engine IDs, then read back via getCompressionCombo to verify
  // normalizePipeline no longer strips them.
  const backend = getTestBackend();

  // Ensure the default combo exists.
  const combo = await getDefaultCompressionCombo();
  assert.ok(combo, "default combo should exist after table init");

  const newPipeline = JSON.stringify([
    { engine: "session-dedup" },
    { engine: "ccr" },
    { engine: "headroom" },
    { engine: "caveman", intensity: "full" },
    // Removed engine: stored pipelines naming it load fine and the step is dropped.
    { engine: "llmlingua" },
  ]);
  await backend.execute("UPDATE compression_combos SET pipeline = $1::jsonb WHERE id = $2", [
    newPipeline,
    combo.id,
  ]);

  const reloaded = await getCompressionCombo(combo.id);
  assert.ok(reloaded, "should reload the combo");
  const engineIds: string[] = reloaded.pipeline.map((s) => s.engine);
  assert.ok(engineIds.includes("headroom"), `expected headroom in pipeline, got: ${engineIds}`);
  assert.ok(
    engineIds.includes("session-dedup"),
    `expected session-dedup in pipeline, got: ${engineIds}`
  );
  assert.ok(engineIds.includes("ccr"), `expected ccr in pipeline, got: ${engineIds}`);
  assert.ok(!engineIds.includes("llmlingua"), `llmlingua must be dropped, got: ${engineIds}`);
  assert.equal(
    reloaded.pipeline.length,
    4,
    `expected 4 steps, got ${reloaded.pipeline.length}: ${engineIds}`
  );
});

test("enabling headroom adds it to the pipeline sorted by stackPriority", async () => {
  // Default pipeline is [session-dedup(3), lite(5)] since #14529 moved the seed off the lossy
  // rtk + caveman pair. headroom has stackPriority=15, so it must land after both.
  const result = await setEngineInDefaultCombo("headroom", true);
  assert.ok(result, "should return the updated combo");

  const engineIds = result.pipeline.map((s) => s.engine);
  const dedupIdx = engineIds.indexOf("session-dedup");
  const liteIdx = engineIds.indexOf("lite");
  const headroomIdx = engineIds.indexOf("headroom");

  assert.ok(dedupIdx >= 0, "session-dedup should be in the pipeline");
  assert.ok(liteIdx >= 0, "lite should be in the pipeline");
  assert.ok(headroomIdx >= 0, "headroom should be in the pipeline");

  assert.ok(
    dedupIdx < liteIdx,
    `session-dedup(3) should come before lite(5), got order: ${engineIds}`
  );
  assert.ok(
    liteIdx < headroomIdx,
    `lite(5) should come before headroom(15), got order: ${engineIds}`
  );
});

test("enabling an engine with config persists the config", async () => {
  const customConfig = { minRows: 5 };
  const result = await setEngineInDefaultCombo("headroom", true, customConfig);
  assert.ok(result, "should return the updated combo");

  const headroomStep = result.pipeline.find((s) => s.engine === "headroom");
  assert.ok(headroomStep, "headroom step should be present");
  assert.deepEqual(
    headroomStep.config,
    customConfig,
    "config should be persisted on the pipeline step"
  );
});

test("updating config on an already-present engine merges correctly", async () => {
  // First enable headroom
  await setEngineInDefaultCombo("headroom", true);
  // Then re-enable with a config — should update the existing step, not add a duplicate
  const result = await setEngineInDefaultCombo("headroom", true, { minRows: 8 });
  assert.ok(result, "should return the updated combo");

  const headroomSteps = result.pipeline.filter((s) => s.engine === "headroom");
  assert.equal(headroomSteps.length, 1, "should not duplicate the headroom step");
  assert.deepEqual(headroomSteps[0].config, { minRows: 8 });
});

test("disabling an engine removes it from the pipeline", async () => {
  await setEngineInDefaultCombo("headroom", true);
  const before = await getDefaultCompressionCombo();
  assert.ok(
    before?.pipeline.some((s) => s.engine === "headroom"),
    "headroom should be in pipeline before disabling"
  );

  const result = await setEngineInDefaultCombo("headroom", false);
  assert.ok(result, "should return the updated combo");
  assert.ok(
    !result.pipeline.some((s) => s.engine === "headroom"),
    "headroom should be removed from pipeline"
  );
});

test("Fix #8: setEngineInDefaultCombo with unknown engineId returns null and does not modify the pipeline", async () => {
  const before = await getDefaultCompressionCombo();
  assert.ok(before, "default combo must exist");
  const originalPipeline = JSON.stringify(before.pipeline);

  const result = await setEngineInDefaultCombo("not-a-real-engine", true);
  assert.equal(result, null, "should return null for unknown engine id");

  // The combo must be unchanged
  const after = await getDefaultCompressionCombo();
  assert.ok(after, "default combo should still exist");
  assert.equal(
    JSON.stringify(after.pipeline),
    originalPipeline,
    "pipeline should be unmodified when unknown engineId is rejected"
  );
});

test("Fix #2: disabling last engine produces an empty pipeline (not silently reverted to default)", async () => {
  // Start with a pipeline that only has one engine by disabling everything except headroom.
  // First set a pipeline with only one known engine via a raw DB update.
  const backend = getTestBackend();
  const combo = await getDefaultCompressionCombo();
  assert.ok(combo, "default combo must exist");

  await backend.execute("UPDATE compression_combos SET pipeline = $1::jsonb WHERE id = $2", [
    JSON.stringify([{ engine: "headroom" }]),
    combo.id,
  ]);

  // Now disable headroom — result should be empty pipeline, not a fallback.
  const result = await setEngineInDefaultCombo("headroom", false);
  assert.ok(result, "should return the updated combo");
  assert.equal(
    result.pipeline.length,
    0,
    `expected empty pipeline after disabling last engine, got: ${JSON.stringify(result.pipeline)}`
  );
});
