/**
 * #9199 — build-local ModelCapabilityResolutionSnapshot parity.
 *
 * Snapshot-backed resolution must match ordinary on-demand resolvers for the
 * same pure chain (synced + max_token override + context override + alias
 * fallback + missing data). The snapshot must not flip models.dev's module-
 * global all-row cache.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cap-snapshot-9199-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? "cap-snapshot-9199-secret";
// Isolate getTokenLimit from host env CONTEXT_LENGTH_* overrides.
const originalContextLengthEnv = new Map(
  Object.entries(process.env).filter(([key]) => key.startsWith("CONTEXT_LENGTH_"))
);
for (const key of originalContextLengthEnv.keys()) delete process.env[key];

const modelsDevSync = await import("../../../src/lib/modelsDevSync.ts");
const capabilityOverrides = await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const contextOverrides = await import("../../../src/lib/db/modelContextOverrides.ts");
const modelCapabilities = await import("../../../src/lib/modelCapabilities.ts");
const contextManager = await import("../../../open-sse/services/contextManager.ts");
const model = await import("../../../open-sse/services/model.ts");
const { MODEL_SPECS } = await import("../../../src/shared/constants/modelSpecs.ts");
const { REGISTRY } = await import("../../../open-sse/config/providerRegistry.ts");

test.after(async () => {
  await resetTestDb();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CONTEXT_LENGTH_")) delete process.env[key];
  }
  for (const [key, value] of originalContextLengthEnv) process.env[key] = value;
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup
  }
});

async function seedFixture() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  await modelsDevSync.saveModelsDevCapabilities({
    // Direct provider/model hit used by ordinary + snapshot paths.
    "parity-provider": {
      "parity-model": {
        tool_call: true,
        reasoning: true,
        attachment: false,
        structured_output: null,
        temperature: true,
        modalities_input: '["text"]',
        modalities_output: '["text"]',
        knowledge_cutoff: null,
        release_date: null,
        last_updated: null,
        status: null,
        family: null,
        open_weights: null,
        limit_context: 111111,
        limit_input: 100000,
        limit_output: 2222,
        interleaved_field: null,
      },
    },
    // Alias-side storage only — canonical `opencode` must still resolve via fallback.
    "opencode-zen": {
      "zen-only-model": {
        tool_call: true,
        reasoning: false,
        attachment: false,
        structured_output: null,
        temperature: true,
        modalities_input: '["text"]',
        modalities_output: '["text"]',
        knowledge_cutoff: null,
        release_date: null,
        last_updated: null,
        status: null,
        family: null,
        open_weights: null,
        limit_context: 333333,
        limit_input: 300000,
        limit_output: 4444,
        interleaved_field: null,
      },
    },
  });

  assert.equal(
    await capabilityOverrides.setModelCapabilityOverride(
      "parity-provider/parity-model",
      "max_output_tokens",
      99999
    ),
    true
  );
  // Malformed capability override row must be filtered from list/bulk maps.
  await getTestBackend().execute(
    `INSERT INTO model_capability_overrides (provider, model_id, override_key, override_value)
     VALUES ($1, $2, $3, $4::jsonb)`,
    ["parity-provider", "parity-model-bad", "max_output_tokens", JSON.stringify("not-a-number")]
  );

  // Collision pairs that a delimiter-composed key would merge: (a, b<sep>c) vs (a<sep>b, c).
  // Postgres text cannot hold a NUL byte, so the separator is \u0001.
  assert.equal(
    await capabilityOverrides.setModelCapabilityOverride("a/b\u0001c", "max_output_tokens", 10101),
    true
  );
  assert.equal(
    await capabilityOverrides.setModelCapabilityOverride("a\u0001b/c", "max_output_tokens", 20202),
    true
  );
  assert.equal(
    await contextOverrides.setModelContextOverride("a", "b\u0001c", 30303, "manual"),
    true
  );
  assert.equal(
    await contextOverrides.setModelContextOverride("a\u0001b", "c", 40404, "manual"),
    true
  );

  // Real provider-model alias from open-sse/services/model.ts PROVIDER_MODEL_ALIASES.
  // Override is stored only under the raw alias id, not the canonical model.
  const aliasCanonical = model.resolveCanonicalProviderModel("github", "claude-4.5-opus");
  assert.equal(aliasCanonical.provider, "github");
  assert.equal(aliasCanonical.model, "claude-opus-4-5-20251101");
  assert.notEqual(aliasCanonical.model, "claude-4.5-opus");
  assert.equal(
    await capabilityOverrides.setModelCapabilityOverride(
      "github/claude-4.5-opus",
      "max_output_tokens",
      77777
    ),
    true
  );
  assert.equal(
    await capabilityOverrides.getModelCapabilityOverride(
      "github",
      "claude-opus-4-5-20251101",
      "max_output_tokens"
    ),
    null,
    "override must exist only under the raw alias model id"
  );

  assert.equal(
    await contextOverrides.setModelContextOverride(
      "parity-provider",
      "parity-model",
      555555,
      "manual"
    ),
    true
  );
}

async function insertRawCapability(provider: string, modelId: string): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO model_capabilities
       (provider, model_id, tool_call, reasoning, attachment, structured_output, temperature,
        modalities_input, modalities_output, knowledge_cutoff, release_date, last_updated,
        status, family, open_weights, limit_context, limit_input, limit_output, interleaved_field,
        last_synced)
     VALUES ($1, $2, true, true, false, NULL, true, '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL,
        NULL, NULL, NULL, 111111, 100000, 2222, NULL, now())
     ON CONFLICT (provider, model_id) DO UPDATE SET limit_context = EXCLUDED.limit_context,
        limit_input = EXCLUDED.limit_input, limit_output = EXCLUDED.limit_output`,
    [provider, modelId]
  );
}

type ResolvedCaps = Awaited<ReturnType<typeof modelCapabilities.getResolvedModelCapabilities>>;

function pickParityFields(resolved: ResolvedCaps) {
  return {
    provider: resolved.provider,
    model: resolved.model,
    rawModel: resolved.rawModel,
    toolCalling: resolved.toolCalling,
    reasoning: resolved.reasoning,
    supportsThinking: resolved.supportsThinking,
    supportsTools: resolved.supportsTools,
    supportsVision: resolved.supportsVision,
    contextWindow: resolved.contextWindow,
    maxInputTokens: resolved.maxInputTokens,
    maxOutputTokens: resolved.maxOutputTokens,
    attachment: resolved.attachment,
    modalitiesInput: resolved.modalitiesInput,
    modalitiesOutput: resolved.modalitiesOutput,
  };
}

async function assertOrdinarySnapshotParity(
  provider: string,
  modelId: string,
  snapshot: modelCapabilities.ModelCapabilityResolutionSnapshot,
  label: string
) {
  const ordinaryCaps = await modelCapabilities.getResolvedModelCapabilities({
    provider,
    model: modelId,
  });
  const snapshotCaps = await modelCapabilities.getResolvedModelCapabilities(
    { provider, model: modelId },
    snapshot
  );
  assert.deepEqual(
    pickParityFields(snapshotCaps),
    pickParityFields(ordinaryCaps),
    `${label}: getResolvedModelCapabilities parity`
  );

  const ordinaryLimit = await contextManager.getTokenLimit(provider, modelId);
  const snapshotLimit = await contextManager.getTokenLimit(provider, modelId, snapshot);
  assert.equal(
    snapshotLimit,
    ordinaryLimit,
    `${label}: getTokenLimit parity (got ${snapshotLimit}, want ${ordinaryLimit})`
  );

  const ordinaryContext = await modelCapabilities.getModelContextLimit(provider, modelId);
  const snapshotContext = await modelCapabilities.getModelContextLimit(
    provider,
    modelId,
    snapshot
  );
  assert.equal(snapshotContext, ordinaryContext, `${label}: getModelContextLimit parity`);
}

test("#9199 bulk capability rows treat prototype-shaped keys as data", async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  await insertRawCapability("__proto__", "polluted-model");
  await insertRawCapability("prototype-provider", "__proto__");
  assert.equal(Object.hasOwn(Object.prototype, "polluted-model"), false);

  const ordinary = await modelsDevSync.getSyncedCapability("__proto__", "polluted-model");
  assert.equal(ordinary?.limit_context, 111111, "ordinary point lookup must support the row");
  assert.equal(Object.hasOwn(Object.prototype, "polluted-model"), false);

  try {
    const bulk = await modelsDevSync.loadAllSyncedCapabilitiesUncached();
    assert.equal(Object.hasOwn(bulk, "__proto__"), true);
    assert.equal(bulk["__proto__"]?.["polluted-model"]?.limit_output, 2222);
    assert.equal(Object.hasOwn(bulk["prototype-provider"], "__proto__"), true);
    assert.equal(bulk["prototype-provider"]?.["__proto__"]?.limit_context, 111111);
    assert.equal(Object.hasOwn(Object.prototype, "polluted-model"), false);
  } finally {
    delete (Object.prototype as Record<string, unknown>)["polluted-model"];
  }
});

test("#9199 uncached bulk load does not mutate models.dev all-row cache", async () => {
  await seedFixture();
  // clearModelsDevCapabilities leaves cachedCapabilitiesLoadedAll=true with {}.
  await modelsDevSync.clearModelsDevCapabilities();
  assert.equal(
    await modelsDevSync.getSyncedCapability("parity-provider", "parity-model"),
    null
  );

  // Insert behind the module-global cache via raw SQL.
  await insertRawCapability("parity-provider", "parity-model");

  // Ordinary path still sees the empty module cache.
  assert.equal(
    await modelsDevSync.getSyncedCapability("parity-provider", "parity-model"),
    null
  );

  const bulk = await modelsDevSync.loadAllSyncedCapabilitiesUncached();
  assert.equal(bulk["parity-provider"]?.["parity-model"]?.limit_context, 111111);

  // Uncached bulk must not publish into the module-global cache.
  assert.equal(
    await modelsDevSync.getSyncedCapability("parity-provider", "parity-model"),
    null,
    "loadAllSyncedCapabilitiesUncached must not flip cachedCapabilitiesLoadedAll data"
  );

  // Count the statements that snapshot creation issues against the three source tables.
  // The read cache is invalidated first so the measured call is a cold read.
  const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
  invalidateDbCache("model-capabilities");
  const backend = getTestBackend() as unknown as Record<
    "query" | "queryOne" | "execute",
    (sql: string, ...rest: unknown[]) => Promise<unknown>
  >;
  const counts = { synced: 0, capabilityOverrides: 0, contextOverrides: 0 };
  const originals = {
    query: backend.query,
    queryOne: backend.queryOne,
    execute: backend.execute,
  };
  const countSql = (sql: string) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (normalized.includes("FROM model_capabilities")) counts.synced++;
    if (normalized.includes("FROM model_capability_overrides")) counts.capabilityOverrides++;
    if (normalized.includes("FROM model_context_overrides")) counts.contextOverrides++;
  };
  for (const name of ["query", "queryOne", "execute"] as const) {
    const original = originals[name];
    backend[name] = function (sql: string, ...rest: unknown[]) {
      countSql(sql);
      return original.call(backend, sql, ...rest);
    };
  }

  try {
    const snapshot = await modelCapabilities.createModelCapabilityResolutionSnapshot();
    assert.equal(snapshot.synced["parity-provider"]?.["parity-model"]?.limit_output, 2222);
  } finally {
    backend.query = originals.query;
    backend.queryOne = originals.queryOne;
    backend.execute = originals.execute;
  }

  assert.deepEqual(counts, { synced: 1, capabilityOverrides: 1, contextOverrides: 1 });
  assert.equal(
    await modelsDevSync.getSyncedCapability("parity-provider", "parity-model"),
    null,
    "snapshot creation must remain build-local"
  );
});

test("#9199 nested override maps keep delimiter-colliding pairs distinct", async () => {
  await seedFixture();
  const snapshot = await modelCapabilities.createModelCapabilityResolutionSnapshot();

  // Delimiter-composed keys would merge these pairs; nested maps must not.
  assert.equal(snapshot.maxTokenOverrides.get("a")?.get("b\u0001c"), 10101);
  assert.equal(snapshot.maxTokenOverrides.get("a\u0001b")?.get("c"), 20202);
  assert.notEqual(
    snapshot.maxTokenOverrides.get("a")?.get("b\u0001c"),
    snapshot.maxTokenOverrides.get("a\u0001b")?.get("c")
  );

  assert.equal(snapshot.contextOverrides.get("a")?.get("b\u0001c"), 30303);
  assert.equal(snapshot.contextOverrides.get("a\u0001b")?.get("c"), 40404);
  assert.notEqual(
    snapshot.contextOverrides.get("a")?.get("b\u0001c"),
    snapshot.contextOverrides.get("a\u0001b")?.get("c")
  );

  assert.equal(
    await capabilityOverrides.getModelCapabilityOverride(
      "a",
      "b\u0001c",
      "max_output_tokens",
      snapshot.maxTokenOverrides
    ),
    10101
  );
  assert.equal(
    await capabilityOverrides.getModelCapabilityOverride(
      "a\u0001b",
      "c",
      "max_output_tokens",
      snapshot.maxTokenOverrides
    ),
    20202
  );
  assert.equal(
    await contextOverrides.getModelContextOverride("a", "b\u0001c", snapshot.contextOverrides),
    30303
  );
  assert.equal(
    await contextOverrides.getModelContextOverride("a\u0001b", "c", snapshot.contextOverrides),
    40404
  );

  await assertOrdinarySnapshotParity("a", "b\u0001c", snapshot, "collision pair (a, b\\u0001c)");
  await assertOrdinarySnapshotParity(
    "a\u0001b",
    "c",
    snapshot,
    "collision pair (a\\u0001b, c)"
  );

  assert.equal(
    (
      await modelCapabilities.getResolvedModelCapabilities(
        { provider: "a", model: "b\u0001c" },
        snapshot
      )
    ).maxOutputTokens,
    10101
  );
  assert.equal(
    (
      await modelCapabilities.getResolvedModelCapabilities(
        { provider: "a\u0001b", model: "c" },
        snapshot
      )
    ).maxOutputTokens,
    20202
  );
  assert.equal(await modelCapabilities.getModelContextLimit("a", "b\u0001c", snapshot), 30303);
  assert.equal(await modelCapabilities.getModelContextLimit("a\u0001b", "c", snapshot), 40404);
});

test("#9199 snapshot-backed resolution matches ordinary resolvers across resolution paths", async () => {
  await seedFixture();
  const snapshot = await modelCapabilities.createModelCapabilityResolutionSnapshot();

  // Static MODEL_SPECS pin (not seeded in models.dev / overrides).
  const staticSpec = MODEL_SPECS["gpt-4o-mini"];
  assert.ok(staticSpec, "gpt-4o-mini must remain a real MODEL_SPECS entry");
  assert.equal(typeof staticSpec.maxOutputTokens, "number");
  assert.equal(typeof staticSpec.contextWindow, "number");
  assert.equal(
    MODEL_SPECS["glm-5-turbo"],
    undefined,
    "glm-5-turbo must stay absent from MODEL_SPECS so its case exercises PROVIDER_MODELS"
  );

  // Provider registry defaultContextLength path: no per-model catalog hit.
  const defaultContextProvider = "gitlab-duo";
  const defaultContextModel = "no-catalog-model-9199";
  assert.equal(
    REGISTRY[defaultContextProvider]?.defaultContextLength,
    128000,
    "gitlab-duo must keep a real provider-registry defaultContextLength"
  );
  assert.equal(
    await modelCapabilities.getModelContextLimit(defaultContextProvider, defaultContextModel),
    null,
    "default-context path requires no resolved per-model contextWindow"
  );

  // Model-name heuristic path: unknown provider with a claude-shaped model id.
  const heuristicProvider = "unknown-provider-9199";
  const heuristicModel = "custom-claude-lab";
  assert.equal(REGISTRY[heuristicProvider], undefined);
  assert.equal(
    await modelCapabilities.getModelContextLimit(heuristicProvider, heuristicModel),
    null,
    "heuristic path requires no resolved per-model contextWindow"
  );

  const cases: Array<{ provider: string; model: string; label: string }> = [
    { provider: "parity-provider", model: "parity-model", label: "direct synced + both overrides" },
    { provider: "opencode", model: "zen-only-model", label: "alias fallback to opencode-zen" },
    {
      provider: "github",
      model: "claude-4.5-opus",
      label: "canonical model alias with rawModel-only max_token override",
    },
    {
      provider: "glm",
      model: "glm-5-turbo",
      label: "registry-backed model (PROVIDER_MODELS context/output limits)",
    },
    {
      provider: "missing-provider",
      model: "gpt-4o-mini",
      label: "static MODEL_SPECS-backed model",
    },
    {
      provider: defaultContextProvider,
      model: defaultContextModel,
      label: "provider registry defaultContextLength path",
    },
    {
      provider: heuristicProvider,
      model: heuristicModel,
      label: "model-name heuristic/default path",
    },
    { provider: "missing-provider", model: "missing-model", label: "missing synced + overrides" },
  ];

  for (const entry of cases) {
    await assertOrdinarySnapshotParity(entry.provider, entry.model, snapshot, entry.label);
  }

  // Explicit override/precedence pins so the test is not only structural.
  assert.equal(
    (
      await modelCapabilities.getResolvedModelCapabilities(
        { provider: "parity-provider", model: "parity-model" },
        snapshot
      )
    ).maxOutputTokens,
    99999,
    "max_token override must win over synced limit_output"
  );
  assert.equal(
    await modelCapabilities.getModelContextLimit("parity-provider", "parity-model", snapshot),
    555555,
    "context override must win over synced limit_context / resolved contextWindow"
  );
  assert.equal(
    (
      await modelCapabilities.getResolvedModelCapabilities(
        { provider: "opencode", model: "zen-only-model" },
        snapshot
      )
    ).contextWindow,
    333333,
    "canonical opencode must resolve capabilities stored under opencode-zen"
  );

  const aliasResolved = await modelCapabilities.getResolvedModelCapabilities(
    { provider: "github", model: "claude-4.5-opus" },
    snapshot
  );
  assert.equal(aliasResolved.rawModel, "claude-4.5-opus");
  assert.equal(aliasResolved.model, "claude-opus-4-5-20251101");
  assert.equal(
    aliasResolved.maxOutputTokens,
    77777,
    "max_token override stored only under rawModel must still apply after alias resolution"
  );
  const canonicalOnly = await modelCapabilities.getResolvedModelCapabilities(
    { provider: "github", model: "claude-opus-4-5-20251101" },
    snapshot
  );
  assert.equal(canonicalOnly.rawModel, "claude-opus-4-5-20251101");
  assert.equal(canonicalOnly.model, "claude-opus-4-5-20251101");
  assert.notEqual(
    canonicalOnly.maxOutputTokens,
    77777,
    "canonical id alone must not invent the rawModel-only max_token override"
  );

  // Registry-backed pins: glm-5-turbo is absent from MODEL_SPECS.
  const registryResolved = await modelCapabilities.getResolvedModelCapabilities(
    { provider: "glm", model: "glm-5-turbo" },
    snapshot
  );
  assert.equal(registryResolved.contextWindow, 200000);
  assert.equal(registryResolved.maxOutputTokens, 131072);

  // Static MODEL_SPECS pin without a provider registry hit for this missing provider.
  const missingResolved = await modelCapabilities.getResolvedModelCapabilities(
    { provider: "missing-provider", model: "gpt-4o-mini" },
    snapshot
  );
  assert.equal(missingResolved.maxOutputTokens, staticSpec.maxOutputTokens);
  assert.equal(missingResolved.contextWindow, staticSpec.contextWindow);

  // Provider defaultContextLength path (getTokenLimit step 3).
  assert.equal(
    await contextManager.getTokenLimit(defaultContextProvider, defaultContextModel, snapshot),
    128000
  );

  // Model-name heuristic path (getTokenLimit step 4 → DEFAULT_LIMITS.claude).
  assert.equal(
    await contextManager.getTokenLimit(heuristicProvider, heuristicModel, snapshot),
    200000
  );

  // Missing path remains a pure default/fallback, not a catalog hit.
  const missingModelResolved = await modelCapabilities.getResolvedModelCapabilities(
    { provider: "missing-provider", model: "missing-model" },
    snapshot
  );
  assert.equal(missingModelResolved.contextWindow, null);
  assert.equal(
    await contextManager.getTokenLimit("missing-provider", "missing-model", snapshot),
    128000
  );

  assert.equal(
    snapshot.maxTokenOverrides.get("parity-provider")?.has("parity-model-bad") ?? false,
    false,
    "malformed max_token rows must be filtered from the bulk map"
  );
});
