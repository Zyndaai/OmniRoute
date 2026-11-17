import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-puter-removed-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers.ts");
const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.ts");
const { hasSpecializedExecutor } = await import("../../open-sse/executors/index.ts");
const core = await import("../../src/lib/db/core.ts");

// Regression guard: the Puter provider (id `puter`, alias `pu`,
// https://puter.com) was removed at the request of Puter's owner
// (Nariman Jelveh). It must stay out of every provider catalog, the
// executor map and the free model catalog.

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("puter provider is removed from the chat registry (id and alias)", () => {
  assert.equal(REGISTRY["puter"], undefined);
  assert.equal(REGISTRY["pu"], undefined);
});

test("puter provider is removed from the API-key provider presets", () => {
  assert.equal((APIKEY_PROVIDERS as Record<string, unknown>)["puter"], undefined);
});

test("puter has no entries in the free model catalog", () => {
  const offenders = FREE_MODEL_BUDGETS.filter((b) => b.provider === "puter");
  assert.deepEqual(offenders, []);
});

test("puter executor is removed from the executor map (id and alias)", () => {
  assert.equal(hasSpecializedExecutor("puter"), false);
  assert.equal(hasSpecializedExecutor("pu"), false);
});
