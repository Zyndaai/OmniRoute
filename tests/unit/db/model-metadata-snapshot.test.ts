/**
 * Model metadata snapshots (perf, 2026-11-17): provider_model_catalog and the model
 * capability/context override tables are read from one whole-table snapshot per table.
 * Writes through the domain modules must be visible at once; callers must not be able to
 * corrupt the snapshot by mutating what they were given.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
import { invalidateDbCache, loadModelMetadataSnapshot } from "../../../src/lib/db/readCache.ts";
import {
  readAllCatalogColumn,
  readCatalogColumn,
  writeCatalogColumn,
} from "../../../src/lib/db/models/catalogRow.ts";
import { addCustomModel, getCustomModels } from "../../../src/lib/db/models.ts";
import {
  getModelCapabilityOverride,
  getReasoningEffortsOverride,
  removeModelCapabilityOverride,
  setModelCapabilityOverride,
} from "../../../src/lib/db/modelCapabilityOverrides.ts";
import {
  getModelContextOverride,
  removeModelContextOverride,
  setModelContextOverride,
} from "../../../src/lib/db/modelContextOverrides.ts";

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetDbInstance();
});

test("a write through the catalog module is visible to the next read", async () => {
  assert.equal(await readCatalogColumn("custom_models", "openai"), undefined);
  await addCustomModel("openai", "my-model", "My Model");
  const models = (await getCustomModels("openai")) as Array<{ id: string }>;
  assert.deepEqual(
    models.map((m) => m.id),
    ["my-model"]
  );
});

test("mutating a returned document does not change the snapshot", async () => {
  await writeCatalogColumn("custom_models", "openai", [{ id: "a", name: "A" }]);
  const first = (await readCatalogColumn("custom_models", "openai")) as Array<{ name: string }>;
  first[0].name = "changed";
  first.push({ name: "extra" });
  const all = await readAllCatalogColumn("custom_models");
  (all[0].value as Array<{ name: string }>)[0].name = "changed again";

  assert.deepEqual(await readCatalogColumn("custom_models", "openai"), [{ id: "a", name: "A" }]);
});

test("readAllCatalogColumn skips empty documents like the old SQL filter", async () => {
  await writeCatalogColumn("custom_models", "openai", [{ id: "a" }]);
  await writeCatalogColumn("provider_aliases", "anthropic", { short: "claude-x" });
  // anthropic's custom_models and openai's provider_aliases are their empty defaults.
  assert.deepEqual(
    (await readAllCatalogColumn("custom_models")).map((r) => r.provider),
    ["openai"]
  );
  assert.deepEqual(
    (await readAllCatalogColumn("provider_aliases")).map((r) => r.provider),
    ["anthropic"]
  );
});

test("a raw write is seen after invalidateDbCache('model-capabilities')", async () => {
  await writeCatalogColumn("custom_models", "openai", [{ id: "a" }]);
  assert.deepEqual(await readCatalogColumn("custom_models", "openai"), [{ id: "a" }]);
  await getTestBackend().execute(
    "UPDATE provider_model_catalog SET custom_models = $1::jsonb WHERE provider = 'openai'",
    [JSON.stringify([{ id: "b" }])]
  );
  // Another process's write: served from the snapshot until invalidation (or the TTL).
  assert.deepEqual(await readCatalogColumn("custom_models", "openai"), [{ id: "a" }]);
  invalidateDbCache("model-capabilities");
  assert.deepEqual(await readCatalogColumn("custom_models", "openai"), [{ id: "b" }]);
});

test("capability overrides: set and remove take effect at once", async () => {
  assert.equal(await getModelCapabilityOverride("openai", "gpt-x", "max_output_tokens"), null);
  assert.equal(await setModelCapabilityOverride("openai/gpt-x", "max_output_tokens", 4096), true);
  assert.equal(await getModelCapabilityOverride("openai", "gpt-x", "max_output_tokens"), 4096);
  assert.equal(await getModelCapabilityOverride("openai", "gpt-x", "max_input_tokens"), null);

  assert.equal(
    await setModelCapabilityOverride("openai/gpt-x", "reasoning_efforts", ["low", "high"]),
    true
  );
  const efforts = await getReasoningEffortsOverride("openai", "gpt-x");
  assert.deepEqual(efforts, ["low", "high"]);
  (efforts as string[]).push("medium");
  assert.deepEqual(await getReasoningEffortsOverride("openai", "gpt-x"), ["low", "high"]);

  assert.equal(await removeModelCapabilityOverride("openai/gpt-x", "max_output_tokens"), true);
  assert.equal(await getModelCapabilityOverride("openai", "gpt-x", "max_output_tokens"), null);
});

test("context overrides: set and remove take effect at once", async () => {
  assert.equal(await getModelContextOverride("openai", "gpt-x"), null);
  assert.equal(await setModelContextOverride("openai", "gpt-x", 200_000), true);
  assert.equal(await getModelContextOverride("openai", "gpt-x"), 200_000);
  assert.equal(await removeModelContextOverride("openai", "gpt-x"), true);
  assert.equal(await getModelContextOverride("openai", "gpt-x"), null);
});

test("loadModelMetadataSnapshot shares one load and does not keep a failed one", async () => {
  let calls = 0;
  const loader = async () => {
    calls++;
    return calls;
  };
  const [a, b] = await Promise.all([
    loadModelMetadataSnapshot("test-shared", loader),
    loadModelMetadataSnapshot("test-shared", loader),
  ]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  invalidateDbCache("model-capabilities");
  assert.equal(await loadModelMetadataSnapshot("test-shared", loader), 2);

  let failNext = true;
  const flaky = async () => {
    if (failNext) {
      failNext = false;
      throw new Error("db down");
    }
    return "ok";
  };
  await assert.rejects(loadModelMetadataSnapshot("test-flaky", flaky), /db down/);
  assert.equal(await loadModelMetadataSnapshot("test-flaky", flaky), "ok");
});
