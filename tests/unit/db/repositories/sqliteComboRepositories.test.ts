import assert from "node:assert/strict";
import test from "node:test";

import { registerComboRepositoryConformance } from "../../../helpers/persistence/comboRepositoryConformance.ts";
import { getTestBackend, resetTestDb } from "../../../helpers/postgres.ts";

const { comboRepository } = await import("../../../../src/lib/db/repositories/comboRepository.ts");
const { modelComboMappingRepository } =
  await import("../../../../src/lib/db/repositories/modelComboMappingRepository.ts");
const combosDb = await import("../../../../src/lib/db/combos.ts");

async function resetStorage(): Promise<void> {
  await resetTestDb();
}

registerComboRepositoryConformance(async () => ({
  combos: comboRepository,
  mappings: modelComboMappingRepository,
  reset: resetStorage,
  async corruptComboPayload(comboId: string): Promise<void> {
    // combos.data is jsonb NOT NULL; a non-object payload stands in for the old empty-string corruption.
    await getTestBackend().execute("UPDATE combos SET data = $1::jsonb WHERE id = $2", [
      JSON.stringify("corrupt"),
      comboId,
    ]);
  },
}));

test("legacy combo count facade resolves to the stored count", async () => {
  await resetStorage();

  assert.ok(combosDb.getCombosCount() instanceof Promise);
  assert.equal(await combosDb.getCombosCount(), 0);
  await comboRepository.create({ name: "Counted", models: [] });
  assert.equal(await combosDb.getCombosCount(), 1);
});

test.after(async () => {
  await resetTestDb();
});
