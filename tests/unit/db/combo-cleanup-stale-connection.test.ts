import test from "node:test";
import assert from "node:assert/strict";

const combosDb = await import("../../../src/lib/db/combos.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

type Step = Record<string, unknown>;

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb().catch(() => {});
});

async function stepsOf(id: unknown): Promise<Step[]> {
  const combo = await combosDb.getComboById(String(id));
  assert.ok(combo, "combo exists");
  return combo.models as unknown as Step[];
}

test("a step that pins a deleted account keeps its pin, so the dead pin fails locally", async () => {
  const combo = await combosDb.createCombo({
    name: "pinned-route",
    models: [
      { provider: "openai", model: "gpt-4.1", connectionId: "conn-keep" },
      { provider: "openai", model: "gpt-4.1-mini", connectionId: "conn-delete" },
    ],
  });

  const touched = await combosDb.cleanupComboConnectionRefs("conn-delete");
  assert.equal(touched, 0, "nothing to rewrite: pins are left in place");

  const steps = await stepsOf((combo as Step).id);
  assert.equal(steps[0].connectionId, "conn-keep");
  assert.equal(steps[1].connectionId, "conn-delete");
});

test("the deleted id is removed from an allowedConnectionIds scope in the stored combo", async () => {
  const combo = await combosDb.createCombo({
    name: "scoped-route",
    models: [
      {
        provider: "openai",
        model: "gpt-4.1",
        allowedConnectionIds: ["conn-a", "conn-delete", "conn-b"],
      },
    ],
  });

  assert.equal(await combosDb.cleanupComboConnectionRefs("conn-delete"), 1);
  const steps = await stepsOf((combo as Step).id);
  assert.deepEqual(steps[0].allowedConnectionIds, ["conn-a", "conn-b"]);
});

test("a scope that would become empty is kept, so it never widens to the whole pool", async () => {
  const combo = await combosDb.createCombo({
    name: "only-dead-scope",
    models: [{ provider: "openai", model: "gpt-4.1", allowedConnectionIds: ["conn-delete"] }],
  });

  assert.equal(await combosDb.cleanupComboConnectionRefs("conn-delete"), 0);
  const steps = await stepsOf((combo as Step).id);
  assert.deepEqual(steps[0].allowedConnectionIds, ["conn-delete"]);
});

test("combos that do not reference the connection are untouched, several ids at once work", async () => {
  const unrelated = await combosDb.createCombo({
    name: "unrelated",
    models: [{ provider: "openai", model: "gpt-4.1", allowedConnectionIds: ["conn-other"] }],
  });
  const scoped = await combosDb.createCombo({
    name: "multi",
    models: [
      { provider: "openai", model: "gpt-4.1", allowedConnectionIds: ["d1", "keep", "d2"] },
    ],
  });

  assert.equal(await combosDb.cleanupComboConnectionRefs(["d1", "d2"]), 1);
  assert.deepEqual((await stepsOf((scoped as Step).id))[0].allowedConnectionIds, ["keep"]);
  assert.deepEqual((await stepsOf((unrelated as Step).id))[0].allowedConnectionIds, [
    "conn-other",
  ]);
  assert.equal(await combosDb.cleanupComboConnectionRefs([]), 0);
});
