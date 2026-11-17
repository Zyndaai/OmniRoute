import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../../../../src/lib/db/pg.ts";
import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";
import {
  invalidateDbCache,
  invalidateModelCatalogCache,
} from "../../../../src/lib/db/readCache.ts";
import {
  addCustomModel,
  cleanupProviderModelsAfterConnectionDelete,
  deleteImportedCustomModels,
  deleteModelAlias,
  deleteModelAliasesForProvider,
  deleteSyncedAvailableModelsForConnection,
  getActiveProvidersWithSyncedModel,
  getAllCustomModels,
  getAllSyncedAvailableModels,
  getCustomModels,
  getHiddenModelsByProvider,
  getManagedModelAliasNames,
  getMitmAlias,
  getModelAliases,
  getModelIsHidden,
  getModelNormalizeToolCallId,
  getModelUpstreamExtraHeaders,
  getSyncedAvailableModels,
  getSyncedAvailableModelsByConnection,
  getSyncedAvailableModelsForConnection,
  markManagedModelAlias,
  mergeModelCompatOverride,
  getModelCompatOverrides,
  pruneStaleSyncedAvailableModelsForProvider,
  removeCustomModel,
  removeModelCompatOverride,
  removeSyncedAvailableModel,
  replaceCustomModels,
  replaceSyncedAvailableModelsForConnection,
  resetModelEndpointOverride,
  setMitmAliasAll,
  setModelAlias,
  setModelIsHidden,
  updateCustomModel,
  deleteSyncedAvailableModelsForProvider,
  unmarkManagedModelAlias,
} from "../../../../src/lib/db/models.ts";
import {
  getProviderAliases,
  removeProviderAlias,
  setProviderAlias,
} from "../../../../src/lib/db/models/aliases.ts";
import { getModelPreserveVideoUrl } from "../../../../src/lib/db/models/modelPreserveVideoUrl.ts";
import {
  getCustomModelVisionOverride,
  listCustomModelVisionOverrides,
} from "../../../../src/lib/db/models/customVisionOverride.ts";
import {
  getSyncedAvailableModelVision,
  listSyncedAvailableModelVision,
  resetSyncedVisionVerdictMemoForTests,
} from "../../../../src/lib/db/models/syncedAvailableModelVision.ts";
import { listModelCompatVisionOverrides } from "../../../../src/lib/db/models/compat.ts";
import {
  deleteDiscoveryStatesForConnections,
  deleteDiscoveryStatesForProvider,
  getDiscoveryStatesForConnections,
  saveDiscoveryState,
} from "../../../../src/lib/db/discoveryState.ts";
import { loadCatalogOverrides } from "../../../../src/lib/db/catalogOverrides.ts";
import {
  getPricing,
  getPricingForModel,
  getPricingWithSources,
  resetAllPricing,
  resetPricing,
  updatePricing,
} from "../../../../src/lib/db/settings/pricing.ts";
import {
  invalidateUserPricingMemo,
  readUserPricingMemoized,
  readUserPricingSync,
} from "../../../../src/lib/catalogUserPricing.ts";
import {
  clearSyncedPricing,
  getSyncedPricing,
  getSyncStatus as getPricingSyncStatus,
  saveSyncedPricing,
} from "../../../../src/lib/pricingSync.ts";
import {
  clearModelsDevCapabilities,
  clearModelsDevPricing,
  getModelsDevPricing,
  getSyncedCapabilities,
  getSyncedCapability,
  loadAllSyncedCapabilitiesUncached,
  saveModelsDevCapabilities,
  saveModelsDevPricing,
  upsertSyncedCapabilities,
} from "../../../../src/lib/modelsDevSync.ts";
import type { ModelCapabilityEntry } from "../../../../src/lib/modelsDevSync/transform.ts";
import {
  applyArenaEloRefresh,
  bulkUpsertModelIntelligence,
  deleteExpiredIntelligence,
  deleteModelIntelligence,
  deleteModelIntelligenceBySource,
  getLatestSyncedAt,
  getModelIntelligence,
  getModelIntelligenceBySource,
  listModelIntelligence,
  upsertModelIntelligence,
} from "../../../../src/lib/db/modelIntelligence.ts";
import {
  clearUserFitnessOverride,
  getModelsDevTierFitness,
  getTaskFitness,
  getTaskFitnessWithSource,
  setUserFitnessOverride,
  invalidateCapabilitiesCache,
} from "../../../../open-sse/services/autoCombo/taskFitness.ts";
import {
  clearSyncedIntelligence,
  getArenaEloSyncStatus,
} from "../../../../src/lib/arenaEloSync.ts";
import {
  getModelCapabilityOverride,
  getReasoningEffortsOverride,
  listModelCapabilityOverrides,
  removeModelCapabilityOverride,
  setModelCapabilityOverride,
} from "../../../../src/lib/db/modelCapabilityOverrides.ts";
import {
  getModelContextOverride,
  getModelContextOverrideRecord,
  listModelContextOverrides,
  removeModelContextOverride,
  setModelContextOverride,
} from "../../../../src/lib/db/modelContextOverrides.ts";
import {
  assertValidationSnapshot,
  commitValidatedModel,
  createValidationSnapshot,
} from "../../../../src/lib/db/validatedModels.ts";
import { classifyTier, clearTierCache } from "../../../../open-sse/services/tierResolver.ts";

const backend = () => getTestBackend();

function resetMemos() {
  invalidateModelCatalogCache();
  invalidateDbCache("pricing");
  invalidateUserPricingMemo();
  resetSyncedVisionVerdictMemoForTests();
  invalidateCapabilitiesCache();
}

beforeEach(async () => {
  await truncateAll(backend());
  resetMemos();
});

function cap(overrides: Partial<ModelCapabilityEntry> = {}): ModelCapabilityEntry {
  return {
    tool_call: true,
    reasoning: false,
    attachment: null,
    structured_output: null,
    temperature: true,
    modalities_input: '["text","image"]',
    modalities_output: '["text"]',
    knowledge_cutoff: "2025-03",
    release_date: "2025-04-01",
    last_updated: "2025-05-01",
    status: null,
    family: "test",
    open_weights: false,
    limit_context: 200000,
    limit_input: null,
    limit_output: 8192,
    interleaved_field: null,
    reasoning_efforts: null,
    ...overrides,
  };
}

async function seedConnection(id: string, provider: string, isActive = true) {
  await db().execute(
    "INSERT INTO provider_connections (id, provider, is_active, name) VALUES ($1, $2, $3, $4)",
    [id, provider, isActive, id]
  );
}

// ───────────────────────── provider_model_catalog ─────────────────────────

test("custom models: add, read, update, remove and the empty-column shape", async () => {
  assert.deepEqual(await getCustomModels("p1"), []);
  const added = await addCustomModel("p1", "m1", "Model One");
  assert.equal(added.id, "m1");
  // adding the same id again returns the stored model and does not duplicate it
  assert.equal((await addCustomModel("p1", "m1", "Other")).name, "Model One");
  await addCustomModel("p1", "m2");
  assert.equal(((await getCustomModels("p1")) as unknown[]).length, 2);
  assert.deepEqual(Object.keys(await getAllCustomModels()), ["p1"]);

  const updated = await updateCustomModel("p1", "m1", { modelName: "Renamed", isHidden: true });
  assert.equal(updated?.name, "Renamed");
  assert.equal(await updateCustomModel("p1", "nope", { modelName: "x" }), null);
  const created = await updateCustomModel("p1", "m3", { supportedEndpoints: ["embeddings"] }, {
    createIfMissing: true,
  });
  assert.equal(created?.source, "endpoint-override");

  assert.equal(await removeCustomModel("p1", "m2"), true);
  assert.equal(await removeCustomModel("p1", "m2"), false);
  assert.equal(await removeCustomModel("unknown", "m2"), false);

  const replaced = await replaceCustomModels("p1", [{ id: "m1" }, { id: "m9", name: "Nine" }]);
  assert.deepEqual(
    replaced.map((m) => m.id),
    ["m1", "m9"]
  );
  // an empty replacement without allowEmpty is refused
  assert.equal((await replaceCustomModels("p1", [])).length, 2);
  await replaceCustomModels("p1", [], { allowEmpty: true });
  assert.deepEqual(await getCustomModels("p1"), []);
  // the emptied provider no longer shows up in the all-providers read
  assert.deepEqual(await getAllCustomModels(), {});
});

test("two concurrent first writes for a fresh provider keep both models", async () => {
  await Promise.all([addCustomModel("race", "a"), addCustomModel("race", "b")]);
  const ids = ((await getCustomModels("race")) as Array<{ id: string }>).map((m) => m.id).sort();
  assert.deepEqual(ids, ["a", "b"]);

  const many = Array.from({ length: 8 }, (_, i) => addCustomModel("race2", `m${i}`));
  await Promise.all(many);
  assert.equal(((await getCustomModels("race2")) as unknown[]).length, 8);
});

test("concurrent first writes to the compat and alias columns keep every entry", async () => {
  await Promise.all([
    mergeModelCompatOverride("race-compat", "a", { normalizeToolCallId: true }),
    mergeModelCompatOverride("race-compat", "b", { normalizeToolCallId: true }),
    mergeModelCompatOverride("race-compat", "c", { isHidden: true }),
  ]);
  assert.deepEqual(
    (await getModelCompatOverrides("race-compat")).map((e) => e.id).sort(),
    ["a", "b", "c"]
  );

  await Promise.all([
    setProviderAlias("race-alias", "one", "up-1"),
    setProviderAlias("race-alias", "two", "up-2"),
    setProviderAlias("race-alias", "three", "up-3"),
  ]);
  assert.deepEqual(await getProviderAliases("race-alias"), {
    one: "up-1",
    two: "up-2",
    three: "up-3",
  });
});

test("clearing one catalog column never touches the other two", async () => {
  await addCustomModel("iso", "m1");
  await mergeModelCompatOverride("iso", "m1", { normalizeToolCallId: true });
  await setProviderAlias("iso", "fast", "upstream-fast");

  await replaceCustomModels("iso", [], { allowEmpty: true });
  assert.deepEqual(await getCustomModels("iso"), []);
  assert.equal((await getModelCompatOverrides("iso")).length, 1);
  assert.deepEqual(await getProviderAliases("iso"), { fast: "upstream-fast" });

  await removeModelCompatOverride("iso", "m1");
  assert.deepEqual(await getModelCompatOverrides("iso"), []);
  assert.deepEqual(await getProviderAliases("iso"), { fast: "upstream-fast" });

  await removeProviderAlias("iso", "fast");
  assert.deepEqual(await getProviderAliases("iso"), {});
  await removeProviderAlias("never-existed", "x");
  const rows = await db().query("SELECT provider FROM provider_model_catalog WHERE provider = 'never-existed'");
  assert.equal(rows.length, 0);
});

test("deleteImportedCustomModels keeps manual models and cleans their compat rows", async () => {
  await addCustomModel("imp", "manual-one", undefined, "manual");
  await addCustomModel("imp", "synced-one", undefined, "auto-sync");
  await mergeModelCompatOverride("imp", "synced-one", { normalizeToolCallId: true });
  const removed = await deleteImportedCustomModels("imp");
  assert.deepEqual(removed, ["synced-one"]);
  assert.deepEqual(
    ((await getCustomModels("imp")) as Array<{ id: string }>).map((m) => m.id),
    ["manual-one"]
  );
  assert.deepEqual(await getModelCompatOverrides("imp"), []);
  assert.deepEqual(await deleteImportedCustomModels("imp"), []);
});

test("compat overrides, hidden models and per-model flags resolve in order", async () => {
  await mergeModelCompatOverride("cp", "m1", {
    normalizeToolCallId: true,
    upstreamHeaders: { "X-Test": "1" },
    compatByProtocol: { claude: { preserveVideoUrl: true } },
  });
  assert.equal(await getModelNormalizeToolCallId("cp", "m1"), true);
  assert.equal(await getModelNormalizeToolCallId("cp", "other"), false);
  assert.deepEqual(await getModelUpstreamExtraHeaders("cp", "m1"), { "X-Test": "1" });
  assert.equal(await getModelPreserveVideoUrl("cp", "m1", "claude"), true);
  assert.equal(await getModelPreserveVideoUrl("cp", "m1", "openai"), undefined);

  await setModelIsHidden("cp", "m1", true);
  assert.equal(await getModelIsHidden("cp", "m1"), true);
  await setModelIsHidden("cp", "m1", false);
  assert.equal(await getModelIsHidden("cp", "m1"), false);

  // custom model rows win over compat rows for visibility
  await addCustomModel("cp", "c1");
  await setModelIsHidden("cp", "c1", true);
  await mergeModelCompatOverride("cp", "c1", { isHidden: false });
  await mergeModelCompatOverride("cp", "c2", { isHidden: true });
  const hidden = await getHiddenModelsByProvider();
  assert.deepEqual([...(hidden.get("cp") ?? [])].sort(), ["c1", "c2"]);

  await mergeModelCompatOverride("cp", "m1", { supportsVision: true });
  const vision = await listModelCompatVisionOverrides();
  assert.equal(vision.get("cp")?.get("m1"), true);
});

test("custom-model vision overrides read from the catalog row", async () => {
  await updateCustomModel("vp", "vm", { supportsVision: true }, { createIfMissing: true });
  assert.equal(await getCustomModelVisionOverride("vp", "vm"), true);
  assert.equal(await getCustomModelVisionOverride("vp", "missing"), null);
  const map = await listCustomModelVisionOverrides();
  assert.equal(map.get("vp")?.get("vm"), true);
});

// ───────────────────────── model_aliases ─────────────────────────

test("model aliases: set, read, managed marker survives re-set, cascade delete", async () => {
  await setModelAlias("fast", "prov/fast-model");
  await setModelAlias("other", { provider: "x", model: "y" });
  await markManagedModelAlias("fast");
  await markManagedModelAlias("ghost"); // no row: ignored
  assert.deepEqual([...(await getManagedModelAliasNames())], ["fast"]);

  await setModelAlias("fast", "prov/faster-model");
  assert.equal((await getModelAliases()).fast, "prov/faster-model");
  assert.deepEqual([...(await getManagedModelAliasNames())], ["fast"]);
  assert.deepEqual((await getModelAliases()).other, { provider: "x", model: "y" });

  await unmarkManagedModelAlias("fast");
  assert.equal((await getManagedModelAliasNames()).size, 0);

  await setModelAlias("a1", "prov/one");
  await setModelAlias("a2", "provider2/two");
  assert.deepEqual((await deleteModelAliasesForProvider("prov")).sort(), ["a1", "fast"]);
  assert.deepEqual(Object.keys(await getModelAliases()).sort(), ["a2", "other"]);
  await deleteModelAlias("a2");
  assert.deepEqual(Object.keys(await getModelAliases()), ["other"]);
});

test("mitm aliases are rows of agent_bridge_mappings", async () => {
  assert.deepEqual(await getMitmAlias("tool"), {});
  await setMitmAliasAll("tool", { "gpt-4": "prov/a", "*": "prov/b" });
  await setMitmAliasAll("other", { x: "y" });
  assert.deepEqual(await getMitmAlias("tool"), { "gpt-4": "prov/a", "*": "prov/b" });
  assert.deepEqual(await getMitmAlias(), {
    tool: { "gpt-4": "prov/a", "*": "prov/b" },
    other: { x: "y" },
  });
  await setMitmAliasAll("tool", { "gpt-4": "prov/c" });
  assert.deepEqual(await getMitmAlias("tool"), { "gpt-4": "prov/c" });
  await setMitmAliasAll("tool", {});
  assert.deepEqual(await getMitmAlias("tool"), {});
  assert.deepEqual(await getMitmAlias("other"), { x: "y" });
});

test("mitm aliases accept the structured entries the dashboard sends", async () => {
  await setMitmAliasAll("tool", { keep: "prov/keep" });
  await setMitmAliasAll("tool", {
    a: { model: "prov/x", reasoningEffort: "high" },
    b: "prov/y",
    c: { reasoningEffort: "low" },
  });
  assert.deepEqual(await getMitmAlias("tool"), { a: "prov/x", b: "prov/y" });
  // a malformed payload is not a request to clear the agent
  await setMitmAliasAll("tool", null);
  await setMitmAliasAll("tool", ["x"]);
  assert.deepEqual(await getMitmAlias("tool"), { a: "prov/x", b: "prov/y" });
});

test("upstream U+0000 does not fail catalog, sync-list or discovery writes", async () => {
  await replaceCustomModels("nul", [{ id: "m\u0000", name: "bad\u0000name" }]);
  assert.equal(((await getCustomModels("nul")) as Array<{ name: string }>)[0].name, "badname");
  await seedConnection("nulc", "nul");
  await replaceSyncedAvailableModelsForConnection("nul", "nulc", [{ id: "a\u0000b" }] as never);
  assert.equal((await getSyncedAvailableModels("nul"))[0].id, "ab");
  await saveDiscoveryState("nul", "nulc", { status: "degraded", cause: "x\u0000y" });
  const states = await getDiscoveryStatesForConnections([{ provider: "nul", id: "nulc" }]);
  assert.equal(states.get("nul:nulc")?.cause, "xy");
});

// ───────────────────────── connection_model_sync ─────────────────────────

test("synced models: replace, read, prune, remove and delete", async () => {
  await seedConnection("c1", "sp");
  await seedConnection("c2", "sp");
  await replaceSyncedAvailableModelsForConnection("sp", "c1", [
    { id: "a", name: "A", supportsVision: true },
    { id: "b", name: "B" },
  ] as never);
  await replaceSyncedAvailableModelsForConnection("sp", "c2", [{ id: "b", name: "B" }, { id: "c" }] as never);

  assert.deepEqual(
    (await getSyncedAvailableModelsForConnection("sp", "c1")).map((m) => m.id),
    ["a", "b"]
  );
  assert.deepEqual(
    (await getSyncedAvailableModels("sp")).map((m) => m.id).sort(),
    ["a", "b", "c"]
  );
  const byConnection = await getSyncedAvailableModelsByConnection("sp");
  assert.deepEqual(Object.keys(byConnection).sort(), ["c1", "c2"]);
  assert.deepEqual(Object.keys(await getAllSyncedAvailableModels()), ["sp"]);
  // stamping the sync time happened through providers.touchConnectionSyncedModelsAt
  const stamped = await db().queryOne<{ synced_models_at: string | null }>(
    "SELECT synced_models_at FROM provider_connections WHERE id = 'c1'"
  );
  assert.ok(stamped?.synced_models_at);

  assert.deepEqual(await getActiveProvidersWithSyncedModel("a"), ["sp"]);
  assert.deepEqual(await getActiveProvidersWithSyncedModel("zzz"), []);
  await addCustomModel("sp", "custom-only");
  assert.deepEqual(await getActiveProvidersWithSyncedModel("custom-only"), ["sp"]);

  resetSyncedVisionVerdictMemoForTests();
  assert.equal(await getSyncedAvailableModelVision("sp", "a"), true);
  assert.equal(await getSyncedAvailableModelVision("sp", "b"), null);
  assert.equal((await listSyncedAvailableModelVision()).get("sp")?.has("a"), true);

  assert.equal(await removeSyncedAvailableModel("sp", "b"), true);
  assert.equal(await removeSyncedAvailableModel("sp", "b"), false);
  assert.deepEqual(
    (await getSyncedAvailableModelsForConnection("sp", "c2")).map((m) => m.id),
    ["c"]
  );

  // an unchanged list is not rewritten
  const before = await db().queryOne<{ updated_at: string }>(
    "SELECT updated_at FROM connection_model_sync WHERE connection_id = 'c2'"
  );
  await replaceSyncedAvailableModelsForConnection("sp", "c2", [{ id: "c" }] as never);
  const after = await db().queryOne<{ updated_at: string }>(
    "SELECT updated_at FROM connection_model_sync WHERE connection_id = 'c2'"
  );
  assert.equal(after?.updated_at, before?.updated_at);

  assert.equal(await pruneStaleSyncedAvailableModelsForProvider("sp", ["c1"]), 1);
  assert.deepEqual(Object.keys(await getSyncedAvailableModelsByConnection("sp")), ["c1"]);

  await deleteSyncedAvailableModelsForConnection("sp", "c1");
  assert.deepEqual(await getSyncedAvailableModels("sp"), []);
  const left = await db().query("SELECT connection_id FROM connection_model_sync");
  assert.equal(left.length, 0, "rows with no models and no discovery verdict are dropped");

  await replaceSyncedAvailableModelsForConnection("sp", "c1", [{ id: "z" }] as never);
  assert.equal(await deleteSyncedAvailableModelsForProvider("sp"), 1);
  assert.equal(await deleteSyncedAvailableModelsForProvider("sp"), 0);
});

test("concurrent synced-model writes for different connections both land", async () => {
  await seedConnection("x1", "rp");
  await seedConnection("x2", "rp");
  await Promise.all([
    replaceSyncedAvailableModelsForConnection("rp", "x1", [{ id: "m1" }] as never),
    replaceSyncedAvailableModelsForConnection("rp", "x2", [{ id: "m2" }] as never),
    replaceSyncedAvailableModelsForConnection("rp", "x1", [{ id: "m1" }] as never),
  ]);
  assert.deepEqual(
    (await getSyncedAvailableModels("rp")).map((m) => m.id).sort(),
    ["m1", "m2"]
  );
});

test("cleanupProviderModelsAfterConnectionDelete drops imported models with the last connection", async () => {
  await seedConnection("k1", "cp2");
  await addCustomModel("cp2", "imported", undefined, "auto-sync");
  await replaceSyncedAvailableModelsForConnection("cp2", "k1", [{ id: "s" }] as never);
  const first = await cleanupProviderModelsAfterConnectionDelete("cp2", "k1");
  assert.equal(first.remainingConnections, 1);
  assert.deepEqual(first.removedImportedModelIds, []);
  await db().execute("DELETE FROM provider_connections WHERE id = 'k1'");
  const last = await cleanupProviderModelsAfterConnectionDelete("cp2", "k1");
  assert.equal(last.remainingConnections, 0);
  assert.deepEqual(last.removedImportedModelIds, ["imported"]);
});

test("resetModelEndpointOverride restores the discovered endpoints", async () => {
  await seedConnection("e1", "ep");
  await replaceSyncedAvailableModelsForConnection("ep", "e1", [
    { id: "em", supportedEndpoints: ["chat"], endpointCapabilitySource: "declared" },
  ] as never);
  await updateCustomModel("ep", "em", { supportedEndpoints: ["embeddings"] }, { createIfMissing: true });
  assert.equal(await resetModelEndpointOverride("ep", "em"), true);
  assert.deepEqual(await getCustomModels("ep"), []);
  assert.equal(await resetModelEndpointOverride("ep", "em"), false);
});

test("a sync result for a connection that no longer exists is dropped", async () => {
  await replaceSyncedAvailableModelsForConnection("gone", "missing", [{ id: "m" }] as never);
  await saveDiscoveryState("gone", "missing", { status: "healthy", cause: null });
  const rows = await db().query("SELECT connection_id FROM connection_model_sync");
  assert.equal(rows.length, 0);

  // deleting the connection cascades to its sync row
  await seedConnection("gone1", "gone");
  await replaceSyncedAvailableModelsForConnection("gone", "gone1", [{ id: "m" }] as never);
  await db().execute("DELETE FROM provider_connections WHERE id = 'gone1'");
  assert.deepEqual(await getSyncedAvailableModels("gone"), []);
});

test("discovery state shares the sync row with the model list", async () => {
  for (const id of ["d1", "d2", "d3"]) await seedConnection(id, "dp");
  await saveDiscoveryState("dp", "d1", { status: "degraded", cause: "timeout" });
  await saveDiscoveryState("dp", "d2", { status: "healthy", cause: null });
  const states = await getDiscoveryStatesForConnections([
    { provider: "dp", id: "d1" },
    { provider: "dp", id: "d2" },
    { provider: "dp", id: "d3" },
  ]);
  assert.equal(states.size, 2);
  assert.equal(states.get("dp:d1")?.status, "degraded");
  assert.equal(states.get("dp:d1")?.cause, "timeout");
  assert.equal(states.get("dp:d2")?.cause, null);
  assert.ok(Number.isFinite(Date.parse(states.get("dp:d1")!.at)));

  await replaceSyncedAvailableModelsForConnection("dp", "d1", [{ id: "m" }] as never);
  await saveDiscoveryState("dp", "d1", { status: "healthy", cause: null });
  assert.equal((await getSyncedAvailableModelsForConnection("dp", "d1")).length, 1);

  // clearing the models keeps the verdict, clearing the verdict keeps the models
  await deleteSyncedAvailableModelsForConnection("dp", "d1");
  assert.equal((await getDiscoveryStatesForConnections([{ provider: "dp", id: "d1" }])).size, 1);
  await replaceSyncedAvailableModelsForConnection("dp", "d1", [{ id: "m" }] as never);
  assert.equal(await deleteDiscoveryStatesForConnections([{ provider: "dp", id: "d1" }]), 1);
  assert.equal((await getSyncedAvailableModelsForConnection("dp", "d1")).length, 1);

  assert.equal(await deleteDiscoveryStatesForProvider("dp"), 1);
  assert.equal((await getDiscoveryStatesForConnections([{ provider: "dp", id: "d2" }])).size, 0);
  const rows = await db().query("SELECT connection_id FROM connection_model_sync ORDER BY connection_id");
  assert.deepEqual(
    rows.map((r) => (r as { connection_id: string }).connection_id),
    ["d1"]
  );
});

test("catalog on/off overrides read the J-raw config entries", async () => {
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES
       ('ccDiscoveryAliases', 'provider:openai', to_jsonb('on'::text)),
       ('ccDiscoveryAliases', 'model:gpt-x', to_jsonb('off'::text)),
       ('ccDiscoveryAliases', 'provider:bad', to_jsonb('maybe'::text)),
       ('functionalGatewayMirrors', 'provider:other', to_jsonb('on'::text))`
  );
  const { providers, models } = await loadCatalogOverrides("ccDiscoveryAliases");
  assert.deepEqual([...providers], [["openai", "on"]]);
  assert.deepEqual([...models], [["gpt-x", "off"]]);
});

// ───────────────────────── model_pricing ─────────────────────────

test("user pricing: update merges per provider, reset removes, layers merge by priority", async () => {
  await updatePricing({ prov: { m1: { input: 1, output: 2 } } });
  const merged = await updatePricing({ prov: { m2: { input: 3, output: 4 } } });
  assert.deepEqual(Object.keys(merged.prov).sort(), ["m1", "m2"]);
  // an update of an existing model replaces that model's object
  await updatePricing({ prov: { m1: { input: 10, output: 20 } } });
  assert.deepEqual((await readUserPricingSync()).prov.m1, { input: 10, output: 20 });
  assert.equal(await readUserPricingMemoized(), await readUserPricingMemoized());

  await saveSyncedPricing({ prov: { m1: { input: 100, output: 100 }, lm: { input: 5, output: 5 } } });
  await saveModelsDevPricing({ prov: { m1: { input: 50, output: 50 }, md: { input: 7, output: 7 } } });
  const { pricing, sourceMap } = await getPricingWithSources();
  assert.equal(pricing.prov.m1.input, 10, "user wins over models.dev and litellm");
  assert.equal(pricing.prov.lm.input, 5);
  assert.equal(pricing.prov.md.input, 7);
  assert.equal(sourceMap.prov.m1, "user");
  assert.equal(sourceMap.prov.lm, "litellm");
  assert.equal(sourceMap.prov.md, "modelsDev");
  assert.equal(((await getPricing()) as Record<string, Record<string, { input: number }>>).prov.md.input, 7);
  assert.equal((await getPricingForModel("prov", "m1"))?.input, 10);

  const afterModelReset = (await resetPricing("prov", "m1")) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(afterModelReset.prov), ["m2"]);
  await resetPricing("prov", "m2");
  assert.equal((await readUserPricingSync()).prov, undefined);
  assert.equal((await getPricingForModel("prov", "m1"))?.input, 50);

  await updatePricing({ other: { x: { input: 1, output: 1 } } });
  assert.deepEqual(await resetAllPricing(), {});
  assert.deepEqual(await readUserPricingSync(), {});
});

test("concurrent price updates for one provider keep every model", async () => {
  await Promise.all(
    Array.from({ length: 6 }, (_, i) => updatePricing({ race: { [`m${i}`]: { input: i, output: i } } }))
  );
  assert.deepEqual(Object.keys((await readUserPricingSync()).race).sort(), [
    "m0",
    "m1",
    "m2",
    "m3",
    "m4",
    "m5",
  ]);
});

test("synced pricing sources replace and clear independently", async () => {
  await saveSyncedPricing({ a: { m: { input: 1, output: 1 } }, b: { m: { input: 2, output: 2 } } });
  assert.deepEqual(Object.keys(await getSyncedPricing()).sort(), ["a", "b"]);
  await saveSyncedPricing({ a: { m: { input: 9, output: 9 } } });
  assert.deepEqual(Object.keys(await getSyncedPricing()), ["a"]);
  assert.equal((await getSyncedPricing()).a.m.input, 9);

  await saveModelsDevPricing({ z: { m: { input: 4, output: 4 } } });
  assert.deepEqual(Object.keys(await getModelsDevPricing()), ["z"]);
  await clearModelsDevPricing();
  assert.deepEqual(await getModelsDevPricing(), {});
  assert.deepEqual(Object.keys(await getSyncedPricing()), ["a"], "litellm rows untouched");
  await clearSyncedPricing();
  assert.deepEqual(await getSyncedPricing(), {});
  assert.equal((await getPricingSyncStatus()).lastSync, null);
});

test("pricing writes refresh the tier snapshot used by classifyTier", async () => {
  await updatePricing({ tierprov: { tiermodel: { input: 0, output: 0 } } });
  await clearTierCache();
  assert.equal(classifyTier("tierprov", "tiermodel").tier, "free");
  await updatePricing({ tierprov: { tiermodel: { input: 500, output: 500 } } });
  assert.equal(classifyTier("tierprov", "tiermodel").tier, "premium");
});

// ───────────────────────── model_capabilities ─────────────────────────

test("model capabilities: cold read, full replace, upsert with modality preservation", async () => {
  // cold path first: no in-memory cache has been loaded in this process yet
  await db().execute(
    `INSERT INTO model_capabilities (provider, model_id, tool_call, reasoning, modalities_input, limit_context)
     VALUES ('cold', 'cm', true, NULL, '["text"]'::jsonb, 1000)`
  );
  const coldHit = await getSyncedCapability("cold", "cm");
  assert.equal(coldHit?.tool_call, true);
  assert.equal(coldHit?.reasoning, null);
  assert.equal(coldHit?.modalities_input, '["text"]');
  assert.equal(coldHit?.limit_context, 1000);
  assert.equal(await getSyncedCapability("cold", "missing"), null);

  await saveModelsDevCapabilities({
    p1: { m1: cap(), m2: cap({ tool_call: null, reasoning_efforts: ["low", "high"] }) },
    p2: { m1: cap({ reasoning: true }) },
  });
  const stored = await loadAllSyncedCapabilitiesUncached();
  assert.deepEqual(Object.keys(stored).sort(), ["p1", "p2"], "full replace removed the cold row");
  assert.equal(stored.p1.m1.modalities_input, '["text","image"]');
  assert.deepEqual(stored.p1.m2.reasoning_efforts, ["low", "high"]);
  assert.equal(stored.p1.m2.tool_call, null);
  assert.equal(stored.p2.m1.reasoning, true);
  assert.equal((await getSyncedCapabilities("p1", "m1")).p1.m1.family, "test");

  // an equivalent modality set in another order keeps the stored order
  await upsertSyncedCapabilities("p1", {
    m1: cap({ modalities_input: '["image","text"]', family: "changed" }),
    m3: cap(),
  });
  const after = await loadAllSyncedCapabilitiesUncached();
  assert.equal(after.p1.m1.modalities_input, '["text","image"]');
  assert.equal(after.p1.m1.family, "changed");
  assert.ok(after.p1.m3);
  assert.equal((await getSyncedCapability("p1", "m3"))?.family, "test");

  const before = await db().queryOne<{ last_synced: string }>(
    "SELECT last_synced FROM model_capabilities WHERE provider = 'p1' AND model_id = 'm3'"
  );
  await upsertSyncedCapabilities("p1", { m3: cap() });
  const unchanged = await db().queryOne<{ last_synced: string }>(
    "SELECT last_synced FROM model_capabilities WHERE provider = 'p1' AND model_id = 'm3'"
  );
  assert.equal(unchanged?.last_synced, before?.last_synced, "an identical upsert does not touch the row");

  // capabilities feed the tier layer of task fitness (reasoning => premium)
  invalidateCapabilitiesCache();
  assert.equal(await getModelsDevTierFitness("m1", "coding"), 0.92);

  await clearModelsDevCapabilities();
  assert.deepEqual(await loadAllSyncedCapabilitiesUncached(), {});
});

// ───────────────────────── model_intelligence ─────────────────────────

test("model intelligence: resolution order, expiry, bulk, refresh prune and delete", async () => {
  await upsertModelIntelligence({
    model: "mi",
    source: "arena_elo",
    category: "coding",
    score: 0.7,
    eloRaw: 1234.6,
    confidence: "high",
    expiresAt: null,
  });
  await upsertModelIntelligence({
    model: "mi",
    source: "user_override",
    category: "coding",
    score: 0.9,
    eloRaw: null,
    confidence: null,
    expiresAt: null,
  });
  assert.equal((await getModelIntelligence("mi", "coding"))?.source, "user_override");
  const arena = await getModelIntelligenceBySource("mi", "arena_elo", "coding");
  assert.equal(arena?.eloRaw, 1235);
  assert.ok(Number.isFinite(Date.parse(arena!.syncedAt)));
  assert.equal(await getModelIntelligenceBySource("mi", "arena_elo", "review"), null);

  await upsertModelIntelligence({
    model: "old",
    source: "arena_elo",
    category: "coding",
    score: 0.5,
    eloRaw: null,
    confidence: null,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(await getModelIntelligence("old", "coding"), null, "expired rows are invisible");
  assert.equal(await deleteExpiredIntelligence("arena_elo"), 1);

  assert.equal(
    await bulkUpsertModelIntelligence([
      { model: "b1", source: "arena_elo", category: "coding", score: 0.4, eloRaw: null, confidence: null, expiresAt: null },
      { model: "b1", source: "arena_elo", category: "coding", score: 0.6, eloRaw: null, confidence: null, expiresAt: null },
      { model: "b2", source: "arena_elo", category: "review", score: 0.2, eloRaw: null, confidence: null, expiresAt: null },
    ]),
    3
  );
  assert.equal((await getModelIntelligenceBySource("b1", "arena_elo", "coding"))?.score, 0.6);
  // a non-finite score is skipped instead of aborting the whole batch
  await bulkUpsertModelIntelligence([
    { model: "nan", source: "arena_elo", category: "coding", score: Number.NaN, eloRaw: null, confidence: null, expiresAt: null },
    { model: "fin", source: "arena_elo", category: "coding", score: 0.3, eloRaw: null, confidence: null, expiresAt: null },
  ]);
  assert.equal(await getModelIntelligenceBySource("nan", "arena_elo", "coding"), null);
  assert.equal((await getModelIntelligenceBySource("fin", "arena_elo", "coding"))?.score, 0.3);
  await deleteModelIntelligence("fin", "arena_elo", "coding");
  assert.equal((await listModelIntelligence({ source: "arena_elo" })).length, 3);
  assert.equal((await listModelIntelligence({ category: "review" })).length, 1);
  assert.ok(await getLatestSyncedAt("arena_elo"));
  assert.equal(await getLatestSyncedAt("models_dev_tier"), null);

  const refreshed = await applyArenaEloRefresh([
    { model: "b1", source: "arena_elo", category: "coding", score: 0.65, eloRaw: 1200, confidence: "low", expiresAt: null },
    { model: "n1", source: "arena_elo", category: "coding", score: 0.3, eloRaw: null, confidence: null, expiresAt: null },
  ]);
  assert.deepEqual(refreshed, { upserted: 2, pruned: 2 });
  assert.deepEqual(
    (await listModelIntelligence({ source: "arena_elo" })).map((e) => e.model),
    ["b1", "n1"]
  );
  assert.equal((await getModelIntelligence("mi", "coding"))?.source, "user_override", "other sources untouched");

  assert.equal(await deleteModelIntelligence("mi", "user_override", "coding"), true);
  assert.equal(await deleteModelIntelligence("mi", "user_override", "coding"), false);
  assert.equal(await deleteModelIntelligenceBySource("arena_elo"), 2);
});

test("task fitness resolves user overrides and clears them again", async () => {
  const baseline = await getTaskFitnessWithSource("never-heard-of-model", "coding");
  assert.equal(baseline.source, "wildcard_boost");
  await setUserFitnessOverride("Never-Heard-Of-Model", "Coding", 0.77);
  const overridden = await getTaskFitnessWithSource("never-heard-of-model", "coding");
  assert.deepEqual(overridden, { score: 0.77, source: "user_override" });
  assert.equal(await getTaskFitness("NEVER-HEARD-OF-MODEL", "coding"), 0.77);
  await clearUserFitnessOverride("never-heard-of-model", "coding");
  assert.equal((await getTaskFitnessWithSource("never-heard-of-model", "coding")).source, "wildcard_boost");
});

test("arena sync status reads the job_state entries and clearing removes the dataset", async () => {
  await bulkUpsertModelIntelligence([
    { model: "x", source: "arena_elo", category: "coding", score: 0.5, eloRaw: null, confidence: null, expiresAt: null },
  ]);
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES
       ('job_state', 'arena_elo.lastError', to_jsonb('boom'::text)),
       ('job_state', 'arena_elo.activeSource', to_jsonb('huggingface'::text)),
       ('job_state', 'arena_elo.datasetDate', to_jsonb('2026-11-01'::text))`
  );
  const status = await getArenaEloSyncStatus();
  assert.equal(status.lastError, "boom");
  assert.equal(status.activeSource, "huggingface");
  assert.equal(status.datasetDate, "2026-11-01");
  assert.equal(status.lastFailedAt, null);
  assert.ok(status.lastSync && Number.isFinite(Date.parse(status.lastSync)));
  await clearSyncedIntelligence();
  assert.equal(await getLatestSyncedAt("arena_elo"), null);
});

// ───────────────────────── overrides ─────────────────────────

test("capability overrides: validate, upsert, read, list and remove", async () => {
  assert.equal(await setModelCapabilityOverride("prov/model", "max_output_tokens", 4096), true);
  assert.equal(await setModelCapabilityOverride("prov/model", "max_output_tokens", -1), false);
  assert.equal(await setModelCapabilityOverride("nomodel", "max_output_tokens", 5), false);
  assert.equal(await getModelCapabilityOverride("prov", "model", "max_output_tokens"), 4096);
  assert.equal(await setModelCapabilityOverride("prov/model", "max_output_tokens", 8192), true);
  assert.equal(await getModelCapabilityOverride("prov", "model", "max_output_tokens"), 8192);
  assert.equal(await getModelCapabilityOverride("prov", "model", "max_input_tokens"), null);

  assert.equal(await setModelCapabilityOverride("prov/model", "reasoning_efforts", "low,high"), true);
  assert.deepEqual(await getReasoningEffortsOverride("prov", "model"), ["low", "high"]);
  assert.equal(await setModelCapabilityOverride("prov/model", "reasoning_efforts", ["nonsense-effort"]), false);

  const listed = await listModelCapabilityOverrides();
  assert.equal(listed.length, 2);
  assert.ok(Number.isFinite(Date.parse(listed[0].refreshedAt)));
  assert.equal(await removeModelCapabilityOverride("prov/model", "max_output_tokens"), true);
  assert.equal(await removeModelCapabilityOverride("prov/model", "max_output_tokens"), false);
  assert.equal(await getModelCapabilityOverride("prov", "model", "max_output_tokens"), null);
});

test("context overrides: manual and auto sources, bulk lookup and removal", async () => {
  assert.equal(await setModelContextOverride("prov", "model", 123456), true);
  assert.equal(await setModelContextOverride("prov", "model", 0), false);
  assert.equal(await setModelContextOverride("prov", "model", 1.5), false);
  assert.equal(await getModelContextOverride("prov", "model"), 123456);
  assert.equal((await getModelContextOverrideRecord("prov", "model"))?.source, "manual");
  assert.equal(await setModelContextOverride("prov", "model", 200000, "auto:discovery", { invalidate: false }), true);
  const record = await getModelContextOverrideRecord("prov", "model");
  assert.equal(record?.realContext, 200000);
  assert.equal(record?.source, "auto:discovery");
  assert.ok(Number.isFinite(Date.parse(record!.refreshedAt)));
  assert.equal(await getModelContextOverride("prov", "missing"), null);
  assert.equal((await listModelContextOverrides()).length, 1);
  assert.equal(await removeModelContextOverride("prov", "model"), true);
  assert.equal(await removeModelContextOverride("prov", "model"), false);
});

// ───────────────────────── validated models ─────────────────────────

test("validated models commit under a snapshot and reject a changed configuration", async () => {
  await seedConnection("vc1", "vprov");
  const input = {
    provider: "vprov",
    modelId: "vmodel",
    connectionId: "vc1",
    allowInference: true as const,
    apiFormat: "chat-completions" as const,
    max_output_tokens: 4096,
  };
  const snapshot = await createValidationSnapshot(input);
  await assertValidationSnapshot(snapshot);
  const model = await commitValidatedModel(snapshot, input, { ok: true, latencyMs: 12 });
  assert.equal(model.id, "vmodel");
  const stored = (await getCustomModels("vprov")) as Array<Record<string, unknown>>;
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].validation, { ok: true, latencyMs: 12 });
  assert.equal(stored[0].outputTokenLimit, 4096);

  // the same model now exists: a new snapshot is refused
  await assert.rejects(createValidationSnapshot(input), /Custom model already exists/);

  // a configuration change between snapshot and commit is refused
  const other = { ...input, modelId: "vmodel2" };
  const staleSnapshot = await createValidationSnapshot(other);
  await db().execute("UPDATE provider_connections SET test_status = 'banned' WHERE id = 'vc1'");
  await assert.rejects(commitValidatedModel(staleSnapshot, other, { ok: true }), /unavailable/);
  assert.equal(((await getCustomModels("vprov")) as unknown[]).length, 1);
});
