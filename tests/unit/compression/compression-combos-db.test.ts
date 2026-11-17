import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compression-combos-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/compressionCombos.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

before(async () => {
  await core.ensureDbInitialized();
});

beforeEach(async () => {
  await resetTestDb();
});

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

test("creates default compression combo automatically", async () => {
  const combos = await combosDb.listCompressionCombos();
  const combo = combos.find((item) => item.id === "default-caveman");

  assert.equal(combo?.isDefault, true);
  assert.equal(combo?.description, "Default lossless dedup and whitespace compression");
  assert.deepEqual(combo?.pipeline, [{ engine: "session-dedup" }, { engine: "lite" }]);
});

// The default combo is seeded lazily by the domain module (not by migrations), so seed it first.
async function seedDefaultCombo(): Promise<void> {
  await combosDb.listCompressionCombos();
}

test("upgrades the legacy seeded default compression combo pipeline", async () => {
  await seedDefaultCombo();
  await getTestBackend().execute(
    "UPDATE compression_combos SET description = $1, pipeline = $2::jsonb WHERE id = $3",
    [
      "Default Caveman compression pipeline",
      JSON.stringify([{ engine: "caveman", intensity: "full" }]),
      "default-caveman",
    ]
  );

  const combo = await combosDb.getDefaultCompressionCombo();
  assert.equal(combo?.id, "default-caveman");
  assert.equal(combo?.description, "Default lossless dedup and whitespace compression");
  assert.deepEqual(combo?.pipeline, [{ engine: "session-dedup" }, { engine: "lite" }]);
});

test("upgrades an untouched RTK + Caveman seed to the lossless default", async () => {
  await seedDefaultCombo();
  await getTestBackend().execute(
    "UPDATE compression_combos SET description = $1, pipeline = $2::jsonb WHERE id = $3",
    [
      "Default RTK + Caveman compression pipeline",
      JSON.stringify([
        { engine: "rtk", intensity: "standard" },
        { engine: "caveman", intensity: "full" },
      ]),
      "default-caveman",
    ]
  );

  const combo = await combosDb.getDefaultCompressionCombo();
  assert.equal(combo?.description, "Default lossless dedup and whitespace compression");
  assert.deepEqual(combo?.pipeline, [{ engine: "session-dedup" }, { engine: "lite" }]);
});

test("does not overwrite a customized default compression combo", async () => {
  await seedDefaultCombo();
  await getTestBackend().execute(
    "UPDATE compression_combos SET name = $1, description = $2, pipeline = $3::jsonb WHERE id = $4",
    [
      "Custom Default",
      "User changed",
      JSON.stringify([{ engine: "caveman", intensity: "lite" }]),
      "default-caveman",
    ]
  );

  const combo = await combosDb.getDefaultCompressionCombo();
  assert.equal(combo?.id, "default-caveman");
  assert.equal(combo?.name, "Custom Default");
  assert.equal(combo?.description, "User changed");
  assert.deepEqual(combo?.pipeline, [{ engine: "caveman", intensity: "lite" }]);
});

test("creates, updates and protects default compression combos", async () => {
  const combo = await combosDb.createCompressionCombo({
    name: "RTK first",
    pipeline: [{ engine: "rtk", intensity: "standard" }],
    languagePacks: ["en", "pt-BR"],
  });
  assert.equal(combo.name, "RTK first");
  assert.equal(combo.pipeline[0].engine, "rtk");

  const updated = await combosDb.updateCompressionCombo(combo.id, {
    description: "Updated",
    isDefault: true,
  });
  assert.equal(updated?.description, "Updated");
  assert.equal((await combosDb.getDefaultCompressionCombo())?.id, combo.id);

  assert.equal(await combosDb.deleteCompressionCombo("default-caveman"), true);
  assert.equal(await combosDb.deleteCompressionCombo(combo.id), false);
});

test("assigns routing combos to compression combos", async () => {
  const combo = await combosDb.createCompressionCombo({
    name: "Stacked",
    pipeline: [
      { engine: "rtk", intensity: "standard" },
      { engine: "caveman", intensity: "full" },
    ],
  });

  assert.equal(await combosDb.assignRoutingCombo(combo.id, "routing-a"), true);
  assert.equal((await combosDb.getCompressionComboForRoutingCombo("routing-a"))?.id, combo.id);
  assert.deepEqual(
    (await combosDb.getAssignmentsForCompressionCombo(combo.id)).map(
      (assignment) => assignment.routingComboId
    ),
    ["routing-a"]
  );

  assert.equal(await combosDb.updateAssignments(combo.id, ["routing-b", "routing-c"]), true);
  assert.equal(await combosDb.getCompressionComboForRoutingCombo("routing-a"), null);
  assert.equal((await combosDb.getCompressionComboForRoutingCombo("routing-b"))?.id, combo.id);
});
