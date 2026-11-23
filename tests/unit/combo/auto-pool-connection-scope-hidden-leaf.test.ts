// Auto-combo candidate pools, connection scoping (API-key scope, account allowlists, pins), hidden
// leaf routing and per-target lane admission around handleComboChat. Merged from ten files so the
// combo.ts module graph loads once; each original file is one `describe` below, named after the
// file it came from.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdaptiveAdmissionRuntime } from "../../../open-sse/services/admission/runtime.ts";
import type { PerTargetAdmissionHook } from "../../../open-sse/services/admission/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-auto-pool-scope-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-auto-pool-scope-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const keys = await import("../../../src/lib/db/apiKeys.ts");
const combos = await import("../../../src/lib/db/combos.ts");
const contextHandoffsDb = await import("../../../src/lib/db/contextHandoffs.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const combo = await import("../../../open-sse/services/combo.ts");
const {
  buildAutoCandidates,
  expandAutoComboCandidatePool,
  handleComboChat,
  pinIsDurablyUnhealthy,
  resolveShadowTargets,
} = combo;
const providerModels = await import("../../../open-sse/config/providerModels.ts");
const virtualFactory = await import("../../../open-sse/services/autoCombo/virtualFactory.ts");
const { resolveAutoStrategyOrder } =
  await import("../../../open-sse/services/combo/resolveAutoStrategy.ts");
const { resolveComboTargets } = await import("../../../open-sse/services/combo/comboStructure.ts");
const { lockExactModel, clearAllModelLockouts } =
  await import("../../../open-sse/services/accountFallback.ts");
const { comboModelStepInputSchema } =
  await import("../../../src/shared/validation/schemas/combo.ts");
const { enforceApiKeyPolicy } = await import("../../../src/shared/utils/apiKeyPolicy.ts");
const { withPathTokenApiKey } = await import("../../../src/lib/vscode/tokenizedRequest.ts");
const { getProviderCredentials } = await import("../../../src/sse/services/auth.ts");
const { normalizeComboStep, implicitPinAllowlist, comboPinAllowlist } =
  await import("../../../src/lib/combos/steps.ts");
const { buildPrecisionComboModelStep } = await import("../../../src/lib/combos/builderDraft.ts");
const { resolveConnectionRestrictions } =
  await import("../../../src/sse/services/connectionRestrictions.ts");
const { createPerTargetAdmissionHook } = await import("../../../src/sse/handlers/chatAdmission.ts");

// Each source file used to start in a fresh process: every describe starts from a clean DB and
// an empty DATA_DIR.
async function resetStorage() {
  await resetTestDb();
  clearAllModelLockouts();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-auto-api-key-connection-scope", () => {
  beforeEach(() => resetStorage());

  async function seedConnection(
    provider: string,
    name: string,
    isActive = true
  ): Promise<{ id: string; provider: string }> {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name,
      apiKey: `sk-${name}`,
      isActive,
    }) as Promise<{ id: string; provider: string }>;
  }

  function target(provider: string, model: string, connectionId: string | null = null) {
    const modelStr = `${provider}/${model}`;
    return {
      kind: "model" as const,
      stepId: modelStr,
      executionKey: connectionId ? `${modelStr}@${connectionId}` : modelStr,
      modelStr,
      provider,
      providerId: provider,
      connectionId,
      weight: 1,
      label: null,
    };
  }

  const noopLog = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  test("restricted catalog expansion uses only active allowed connections and preserves endpoint, visibility, and retirement filters", async () => {
    const openaiAllowed = await seedConnection("openai", "openai-allowed");
    const openaiAllowedSibling = await seedConnection("openai", "openai-allowed-sibling");
    const openaiDenied = await seedConnection("openai", "openai-denied");
    const anthropicAllowed = await seedConnection("anthropic", "anthropic-allowed");
    const inactiveAllowed = await seedConnection("groq", "groq-inactive", false);

    const retiredAllowed = await seedConnection(
      "microsoft-designer-web",
      "retired-designer-allowed"
    );

    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", openaiAllowed.id, [
      { id: "chat-visible", name: "Chat Visible", supportedEndpoints: ["chat"] },
      { id: "embed-only", name: "Embedding Only", supportedEndpoints: ["embeddings"] },
      { id: "chat-hidden", name: "Chat Hidden", supportedEndpoints: ["chat"] },
    ]);
    await modelsDb.replaceSyncedAvailableModelsForConnection("anthropic", anthropicAllowed.id, [
      { id: "claude-visible", name: "Claude Visible", supportedEndpoints: ["messages"] },
    ]);
    await modelsDb.addCustomModel("microsoft-designer-web", "retired-chat", "Retired Chat");
    await modelsDb.setModelIsHidden("openai", "chat-hidden", true);

    const scope = [
      openaiAllowed.id,
      openaiAllowedSibling.id,
      anthropicAllowed.id,
      inactiveAllowed.id,
      retiredAllowed.id,
    ];
    const expanded = await expandAutoComboCandidatePool([], { config: {} }, scope);

    assert.ok(expanded.some((entry) => entry.modelStr === "openai/chat-visible"));
    assert.ok(expanded.some((entry) => entry.modelStr === "anthropic/claude-visible"));
    assert.equal(
      expanded.some((entry) => entry.modelStr === "openai/embed-only"),
      false
    );
    assert.equal(
      expanded.some((entry) => entry.modelStr === "openai/chat-hidden"),
      false
    );
    assert.equal(
      expanded.some((entry) => entry.provider === "microsoft-designer-web"),
      false
    );
    assert.equal(
      expanded.some((entry) => entry.provider === "groq"),
      false
    );
    assert.equal(
      expanded.some((entry) => entry.connectionId === openaiDenied.id),
      false
    );
    assert.ok(expanded.some((entry) => entry.connectionId === openaiAllowed.id));
    assert.ok(expanded.some((entry) => entry.connectionId === openaiAllowedSibling.id));
    assert.ok(expanded.length > 0);
    assert.ok(expanded.every((entry) => entry.connectionId !== null));
    assert.ok(
      expanded.every((entry) =>
        [openaiAllowed.id, openaiAllowedSibling.id, anthropicAllowed.id].includes(
          entry.connectionId as string
        )
      )
    );
  });

  test("null and empty API-key connection scopes preserve broad expansion exactly", async () => {
    const connection = await seedConnection("openai", "openai-broad");
    const unrestricted = await expandAutoComboCandidatePool([], { config: {} }, null);
    const emptyArray = await expandAutoComboCandidatePool([], { config: {} }, []);

    const project = (items: typeof unrestricted) =>
      items.map((entry) => ({
        modelStr: entry.modelStr,
        provider: entry.provider,
        connectionId: entry.connectionId,
        executionKey: entry.executionKey,
      }));
    assert.deepEqual(project(emptyArray), project(unrestricted));
    assert.ok(unrestricted.length > 0);
    assert.ok(unrestricted.every((entry) => entry.connectionId === null));

    const baseTarget = target("openai", "gpt-4o-mini");
    const builtWithNull = await buildAutoCandidates(
      [baseTarget],
      "broad-null",
      null,
      undefined,
      null,
      null
    );
    const builtWithEmpty = await buildAutoCandidates(
      [baseTarget],
      "broad-empty",
      null,
      undefined,
      null,
      []
    );
    const candidateIdentity = (candidate: (typeof builtWithNull)[number]) => ({
      modelStr: candidate.modelStr,
      provider: candidate.provider,
      connectionId: candidate.connectionId,
      executionKey: candidate.executionKey,
      connectionPoolSize: candidate.connectionPoolSize,
    });
    assert.deepEqual(builtWithEmpty.map(candidateIdentity), builtWithNull.map(candidateIdentity));
    assert.deepEqual(
      builtWithNull.map((candidate) => candidate.connectionId),
      [connection.id]
    );
  });

  test("restricted explicit pools drop forbidden pins and bind every fallback to an allowed active connection", async () => {
    const openaiAllowed = await seedConnection("openai", "openai-explicit-allowed");
    const openaiDenied = await seedConnection("openai", "openai-explicit-denied");
    const anthropicAllowed = await seedConnection("anthropic", "anthropic-explicit-allowed");

    const expanded = await expandAutoComboCandidatePool(
      [
        target("openai", "model-a"),
        target("openai", "model-b", openaiDenied.id),
        target("anthropic", "model-c"),
      ],
      { autoConfig: { candidatePool: ["openai", "anthropic"] } },
      [openaiAllowed.id, anthropicAllowed.id]
    );

    assert.deepEqual(
      new Set(expanded.map((entry) => entry.connectionId)),
      new Set([openaiAllowed.id, anthropicAllowed.id])
    );
    assert.equal(
      expanded.some((entry) => entry.connectionId === openaiDenied.id),
      false
    );
    assert.equal(
      expanded.some((entry) => entry.connectionId === null),
      false
    );
  });

  test("buildAutoCandidates filters before account and cache-affinity expansion", async () => {
    const openaiAllowed = await seedConnection("openai", "openai-build-allowed");
    const openaiDenied = await seedConnection("openai", "openai-build-denied");
    const anthropicAllowed = await seedConnection("anthropic", "anthropic-build-allowed");

    const candidates = await buildAutoCandidates(
      [
        target("openai", "gpt-4o-mini"),
        target("openai", "gpt-4o", openaiDenied.id),
        target("anthropic", "claude-3-5-sonnet"),
      ],
      "restricted-build",
      null,
      undefined,
      null,
      [openaiAllowed.id, anthropicAllowed.id]
    );

    assert.deepEqual(
      new Set(candidates.map((candidate) => candidate.connectionId)),
      new Set([openaiAllowed.id, anthropicAllowed.id])
    );
    assert.equal(
      candidates.some((candidate) => candidate.connectionId === openaiDenied.id),
      false
    );
    assert.equal(
      candidates.some((candidate) => !candidate.connectionId),
      false
    );
  });

  test("resolveAutoStrategyOrder threads the key scope and keeps the entire fallback order contained", async () => {
    const openaiAllowed = await seedConnection("openai", "openai-order-allowed");
    const openaiDenied = await seedConnection("openai", "openai-order-denied");
    const anthropicAllowed = await seedConnection("anthropic", "anthropic-order-allowed");
    const scope = [openaiAllowed.id, anthropicAllowed.id];
    let receivedScope: string[] | null | undefined;

    const result = await resolveAutoStrategyOrder({
      orderedTargets: [
        target("openai", "model-a"),
        target("openai", "model-forbidden", openaiDenied.id),
        target("anthropic", "model-b"),
      ],
      body: { messages: [{ role: "user", content: "scope every fallback" }] },
      combo: {
        id: "restricted-order",
        name: "restricted-order",
        models: [],
        autoConfig: { candidatePool: ["openai", "anthropic"], explorationRate: 0 },
      },
      settings: null,
      config: {},
      relayOptions: null,
      resilienceSettings: { quotaPreflight: { enabled: false } } as never,
      log: noopLog,
      apiKeyAllowedConnections: scope,
      buildAutoCandidates: async (
        targetsToBuild,
        _name,
        _session,
        _reset,
        _resilience,
        keyScope
      ) => {
        receivedScope = keyScope;
        return targetsToBuild.map((entry) => ({
          stepId: entry.stepId,
          executionKey: entry.executionKey,
          modelStr: entry.modelStr,
          provider: entry.provider,
          model: entry.modelStr.split("/").slice(1).join("/"),
          connectionId: entry.connectionId ?? undefined,
          quotaRemaining: 100,
          quotaTotal: 100,
          circuitBreakerState: "CLOSED" as const,
          costPer1MTokens: 1,
          p95LatencyMs: 100,
          latencyStdDev: 10,
          errorRate: 0,
        }));
      },
    });

    assert.deepEqual(receivedScope, scope);
    assert.ok("orderedTargets" in result);
    if (!("orderedTargets" in result)) return;
    assert.ok(result.orderedTargets.length >= 2);
    assert.ok(
      result.orderedTargets.every(
        (entry) => entry.connectionId !== null && scope.includes(entry.connectionId)
      )
    );
    assert.equal(
      result.orderedTargets.some((entry) => entry.connectionId === openaiDenied.id),
      false
    );
  });

  test("restricted failClosedWhenEmpty pools never widen to the scoped catalog", async () => {
    const openaiAllowed = await seedConnection("openai", "openai-fail-closed-allowed");
    const anthropicAllowed = await seedConnection("anthropic", "anthropic-fail-closed-allowed");
    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", openaiAllowed.id, [
      { id: "chat-visible", name: "Chat Visible", supportedEndpoints: ["chat"] },
    ]);
    const scope = [openaiAllowed.id, anthropicAllowed.id];

    // Empty fail-closed pool (e.g. auto/subscription with no plan-included capacity).
    const emptyPool = await expandAutoComboCandidatePool(
      [],
      { autoConfig: { failClosedWhenEmpty: true } },
      scope
    );
    assert.deepEqual(emptyPool, []);

    // The same applies when the setting lives under config.auto.
    const nestedEmptyPool = await expandAutoComboCandidatePool(
      [],
      { config: { auto: { failClosedWhenEmpty: true } } },
      scope
    );
    assert.deepEqual(nestedEmptyPool, []);

    // A non-empty fail-closed pool stays exactly the scoped explicit targets.
    const explicit = await expandAutoComboCandidatePool(
      [target("openai", "plan-model")],
      { autoConfig: { failClosedWhenEmpty: true } },
      scope
    );
    assert.deepEqual(
      explicit.map((entry) => [entry.modelStr, entry.connectionId]),
      [["openai/plan-model", openaiAllowed.id]]
    );

    // Control: without failClosedWhenEmpty the same restricted combo does expand.
    const widened = await expandAutoComboCandidatePool([], { config: {} }, scope);
    assert.ok(widened.some((entry) => entry.modelStr === "openai/chat-visible"));
  });

  test("restricted pool fails closed and logs a sanitized warning when the connection lookup fails", async () => {
    const openaiAllowed = await seedConnection("openai", "openai-lookup-failure");
    invalidateDbCache();
    // Simulate a failed connection lookup by moving the table away for this test only.
    const backend = getTestBackend();
    await backend.execute("ALTER TABLE provider_connections RENAME TO provider_connections_hidden");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      invalidateDbCache();
      const expanded = await expandAutoComboCandidatePool(
        [target("openai", "model-a")],
        { config: {} },
        [openaiAllowed.id]
      );
      assert.deepEqual(expanded, []);
    } finally {
      console.warn = originalWarn;
      await backend.execute(
        "ALTER TABLE provider_connections_hidden RENAME TO provider_connections"
      );
      invalidateDbCache();
    }

    const entry = warnings.find((line) => line.includes("Restricted auto pool"));
    assert.ok(entry, "the failed lookup must be logged, not swallowed");
    assert.match(entry, /COMBO_AUTO/);
    assert.equal(entry.includes(openaiAllowed.id), false, "the scope ids must not be logged");
  });
});

describe("combo-auto-candidate-expansion", () => {
  // Regression coverage for the #3322 auto-combo candidate expansion: an auto-combo without an
  // explicit candidatePool broadens its eligible targets to every model of every active provider
  // connection (so the router has the full pool to score).
  beforeEach(() => resetStorage());

  test("expandAutoComboCandidatePool adds every model of an active provider when no candidatePool is set", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
      defaultModel: "gpt-4o-mini",
    });

    const expanded = await combo.expandAutoComboCandidatePool([], { config: {} });

    // It should surface at least one openai/<model> target, all well-formed.
    assert.ok(expanded.length > 0, "expected the active provider's models to be expanded in");
    const openaiTargets = expanded.filter((t) => t.provider === "openai");
    assert.ok(openaiTargets.length > 0, "expected openai targets");
    for (const t of openaiTargets) {
      assert.equal(t.kind, "model");
      assert.equal(t.modelStr, `openai/${t.modelStr.split("/").slice(1).join("/")}`);
      assert.equal(t.connectionId, null);
    }
    // Every catalog model for openai should be represented.
    const catalogIds = providerModels.getProviderModels("openai").map((m) => `openai/${m.id}`);
    assert.ok(catalogIds.length > 0);
    for (const id of catalogIds) {
      assert.ok(
        expanded.some((t) => t.modelStr === id),
        `expected expanded targets to include ${id}`
      );
    }
  });

  test("expandAutoComboCandidatePool ignores malformed custom rows while keeping chat models", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
    });

    // customModels is persisted as operator-writable JSON. A malformed row must not
    // abort the whole expansion or cause the static catalogue to replace the
    // explicitly visible custom chat model.
    await getTestBackend().execute(
      `INSERT INTO provider_model_catalog (provider, custom_models) VALUES ($1, $2::jsonb)
     ON CONFLICT (provider) DO UPDATE SET custom_models = EXCLUDED.custom_models`,
      [
        "openai",
        JSON.stringify([
          null,
          "not-an-object",
          { name: "Missing Id" },
          { id: "gpt-custom", supportedEndpoints: ["chat"] },
        ]),
      ]
    );

    const expanded = await combo.expandAutoComboCandidatePool([], { config: {} });

    assert.deepEqual(
      expanded.map((target) => target.modelStr),
      ["openai/gpt-custom"],
      "only the well-formed visible custom chat model should be expanded"
    );
  });

  test("expandAutoComboCandidatePool excludes retired Qwen rows with synced models", async () => {
    const qwenWeb = await providersDb.createProviderConnection({
      provider: "qwen-web",
      authType: "apikey",
      name: "Retired Qwen Web",
      apiKey: "retired-qwen-web-key",
    });
    const legacyAlias = await providersDb.createProviderConnection({
      provider: "qw",
      authType: "apikey",
      name: "Retired Qwen Web Alias",
      apiKey: "retired-qw-key",
    });
    const qwenCloud = await providersDb.createProviderConnection({
      provider: "qwen-cloud",
      authType: "apikey",
      name: "Qwen Cloud Control",
      apiKey: "qwen-cloud-key",
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection("qwen-web", qwenWeb.id, [
      { id: "retired-web-model", name: "Retired Web Model" },
    ]);
    await modelsDb.replaceSyncedAvailableModelsForConnection("qw", legacyAlias.id, [
      { id: "retired-alias-model", name: "Retired Alias Model" },
    ]);
    await modelsDb.replaceSyncedAvailableModelsForConnection("qwen-cloud", qwenCloud.id, [
      { id: "qwen3.8-max", name: "Qwen3.8 Max" },
    ]);

    const expanded = await combo.expandAutoComboCandidatePool([], { config: {} });

    assert.equal(
      expanded.some((target) => target.provider === "qwen-web"),
      false
    );
    assert.equal(
      expanded.some((target) => target.provider === "qw"),
      false
    );
    assert.ok(expanded.some((target) => target.modelStr === "qwen-cloud/qwen3.8-max"));
  });

  test("expandAutoComboCandidatePool includes clean-room ChatGPT Web and excludes its legacy alias", async () => {
    for (const provider of ["chatgpt-web", "cgpt-web"]) {
      const model = provider === "chatgpt-web" ? "gpt-5-5-thinking" : "gpt-5.5";
      const credential =
        provider === "chatgpt-web"
          ? JSON.stringify({
              cookies: [
                {
                  name: "session",
                  value: "fixture",
                  domain: ".chatgpt.com",
                  path: "/",
                  expires: -1,
                  httpOnly: true,
                  secure: true,
                  sameSite: "Lax",
                },
              ],
              origins: [],
            })
          : `sk-${provider}-restored-expansion`;
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        name: `${provider} restored expansion`,
        apiKey: credential,
        isActive: true,
      });
      await modelsDb.addCustomModel(provider, model, `${provider} model fixture`);
    }

    const expanded = await combo.expandAutoComboCandidatePool([], { config: {} });
    assert.ok(expanded.some((target) => target.modelStr === "chatgpt-web/gpt-5-5-thinking"));
    assert.equal(
      expanded.some((target) => target.provider === "cgpt-web"),
      false
    );
  });

  test("expandAutoComboCandidatePool is a no-op when an explicit candidatePool exists", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
      defaultModel: "gpt-4o-mini",
    });

    const seed = [
      {
        kind: "model" as const,
        stepId: "openai/gpt-4o",
        executionKey: "openai/gpt-4o",
        modelStr: "openai/gpt-4o",
        provider: "openai",
        providerId: "openai",
        connectionId: null,
        weight: 1,
        label: null,
      },
    ];
    const result = await combo.expandAutoComboCandidatePool(seed, {
      config: { auto: { candidatePool: ["openai"] } },
    });
    assert.equal(result.length, 1, "candidatePool present → no expansion");
    assert.equal(result[0].modelStr, "openai/gpt-4o");
  });

  test("expandAutoComboCandidatePool falls through to active connections when candidatePool is an empty array", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
      defaultModel: "gpt-4o-mini",
    });

    const expanded = await combo.expandAutoComboCandidatePool([], {
      config: { auto: { candidatePool: [] } },
    });

    // An empty candidatePool should NOT trigger early return — the function
    // should fall through and expand from active connections instead.
    assert.ok(
      expanded.length > 0,
      "expected expansion from active connections despite empty candidatePool"
    );
    const openaiTargets = expanded.filter((t) => t.provider === "openai");
    assert.ok(openaiTargets.length > 0, "expected openai targets to be expanded");
  });

  test('expandAutoComboCandidatePool is a no-op when the combo references other combos via kind:"combo-ref" entries', async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
      defaultModel: "gpt-4o-mini",
    });

    const seed = [
      {
        kind: "model" as const,
        stepId: "anthropic/claude-3-5-sonnet",
        executionKey: "anthropic/claude-3-5-sonnet",
        modelStr: "anthropic/claude-3-5-sonnet",
        provider: "anthropic",
        providerId: "anthropic",
        connectionId: null,
        weight: 1,
        label: null,
      },
    ];

    // An "auto" combo delegating to a "priority" sub-combo via a combo-ref entry:
    // expanding to every model of every active provider (openai included) would
    // defeat the point of the combo-ref constraint, so the resolved
    // eligibleTargets must be returned unchanged (#COMBO-REF).
    const result = await combo.expandAutoComboCandidatePool(seed, {
      config: {},
      models: [{ kind: "combo-ref", ref: "priority-subcombo" }],
    });

    assert.equal(result.length, 1, "combo-ref guard must prevent provider-wide expansion");
    assert.equal(result[0].modelStr, "anthropic/claude-3-5-sonnet");
    assert.ok(
      !result.some((t) => t.provider === "openai"),
      "no openai targets should have been pulled in despite an active openai connection"
    );
  });

  test("expandAutoComboCandidatePool is a no-op when the operator has populated models[] (no candidatePool)", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
      defaultModel: "gpt-4o-mini",
    });

    const result = await combo.expandAutoComboCandidatePool([], {
      config: {},
      models: ["openai/gpt-4o-mini"],
    });

    // When the operator has populated models[] with explicit entries
    // (whether plain strings or records), the function must return the
    // seed unchanged rather than expanding to every model of every
    // active provider (which would silently inject unapproved models).
    assert.equal(result.length, 0, "populated models[] must short-circuit provider-wide expansion");
  });

  test("expandAutoComboCandidatePool does not duplicate an already-present modelStr", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
      defaultModel: "gpt-4o-mini",
    });

    const firstCatalogId = providerModels.getProviderModels("openai")[0]?.id;
    assert.ok(firstCatalogId, "expected at least one openai catalog model");
    const existing = `openai/${firstCatalogId}`;
    const seed = [
      {
        kind: "model" as const,
        stepId: existing,
        executionKey: existing,
        modelStr: existing,
        provider: "openai",
        providerId: "openai",
        connectionId: "conn-1",
        weight: 5,
        label: "pinned",
      },
    ];

    const result = await combo.expandAutoComboCandidatePool(seed, { config: {} });
    const matches = result.filter((t) => t.modelStr === existing);
    assert.equal(matches.length, 1, "the pre-existing target must not be duplicated");
    // …and the original pinned entry (weight 5 / conn-1) is preserved, not overwritten.
    assert.equal(matches[0].connectionId, "conn-1");
    assert.equal(matches[0].weight, 5);
  });

  test("expandAutoComboCandidatePool excludes trigger-bypassed Microsoft Designer providers", async () => {
    await core.ensureDbInitialized();

    for (const provider of ["microsoft-designer-web", "msdesigner", "openai"]) {
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        name: `${provider}-trigger-bypass`,
        apiKey: `sk-${provider}-test`,
        defaultModel: provider === "openai" ? "gpt-4o-mini" : "dall-e-3",
        isActive: true,
      });
      if (provider !== "openai") {
        await modelsDb.addCustomModel(provider, "designer-chat-bypass", "Bypass model");
      }
    }

    const expanded = await combo.expandAutoComboCandidatePool([], { config: {} });

    assert.equal(
      expanded.some((target) => ["microsoft-designer-web", "msdesigner"].includes(target.provider)),
      false
    );
    assert.equal(
      expanded.some((target) => target.provider === "openai"),
      true,
      "supported active providers must remain expandable"
    );
  });
});

describe("combo-auto-pool-visible-only", () => {
  // Regression coverage for the "auto combos must only pick user-visible models" fix
  // (2026-08-15): a provider whose connection only has synced/free models (e.g. OpenRouter with
  // importFreeModelsOnly) must NOT surface catalog-only models like `openrouter/auto` in any auto
  // candidate pool. The pool must be built from what the user actually has visible (synced +
  // custom non-hidden), falling back to the static catalog only when the user has no
  // synced/custom models for that provider at all.
  beforeEach(() => resetStorage());

  async function createOpenRouterConnectionWithFreeSync() {
    const conn = await providersDb.createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: "OpenRouter",
      apiKey: "sk-test-openrouter",
      providerSpecificData: { importFreeModelsOnly: true },
    });
    const connectionId = (conn as { id?: string }).id;
    assert.ok(connectionId, "created openrouter connection must expose an id");
    await modelsDb.replaceSyncedAvailableModelsForConnection("openrouter", connectionId, [
      {
        id: "liquid/lfm-2.5-2.6b:free",
        name: "LiquidAI: LFM2.5-2.6B (free)",
        source: "imported" as const,
      },
      {
        id: "nvidia/nemotron-3.5-lightning:free",
        name: "NVIDIA: Nemotron 3.5 Lightning (free)",
        source: "imported" as const,
      },
    ]);
    return connectionId;
  }

  test("virtual auto-combo pool excludes catalog-only models (openrouter/auto) when only free models are synced", async () => {
    await createOpenRouterConnectionWithFreeSync();

    const prepared = await virtualFactory.prepareVirtualAutoComboInputs();
    const pool = prepared.regularCandidates;
    assert.ok(pool.length > 0, "expected a non-empty pool for the active openrouter connection");

    assert.ok(
      !pool.some((c) => c.provider === "openrouter" && c.model === "auto"),
      "openrouter/auto must NOT be a candidate: the user never synced it (catalog-only model)"
    );

    assert.ok(
      pool.some((c) => c.provider === "openrouter" && c.model === "liquid/lfm-2.5-2.6b:free"),
      "a synced free model must remain a candidate"
    );
    assert.ok(
      pool.some(
        (c) => c.provider === "openrouter" && c.model === "nvidia/nemotron-3.5-lightning:free"
      ),
      "the second synced free model must remain a candidate"
    );
  });

  test("expandAutoComboCandidatePool excludes catalog-only models (openrouter/auto) when only free models are synced", async () => {
    await createOpenRouterConnectionWithFreeSync();

    const expanded = await combo.expandAutoComboCandidatePool([], { config: {} });
    assert.ok(expanded.length > 0, "expected expansion from the active openrouter connection");

    assert.ok(
      !expanded.some((t) => t.provider === "openrouter" && t.modelStr === "openrouter/auto"),
      "expanded pool must NOT include openrouter/auto: the user never synced it"
    );

    assert.ok(
      expanded.some(
        (t) => t.provider === "openrouter" && t.modelStr === "openrouter/liquid/lfm-2.5-2.6b:free"
      ),
      "a synced free model must be expanded into the pool"
    );
  });

  test("virtual auto-combo pool falls back to the static catalog when the provider has no synced/custom models", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
      defaultModel: "gpt-4o-mini",
    });

    const prepared = await virtualFactory.prepareVirtualAutoComboInputs();
    const pool = prepared.regularCandidates;
    const openaiCandidates = pool.filter((c) => c.provider === "openai");
    assert.ok(
      openaiCandidates.length > 0,
      "openai with no synced models must still get catalog candidates (fallback)"
    );
    assert.ok(
      openaiCandidates.some((c) => c.model === "gpt-4o-mini"),
      "the configured default must remain among catalog-fallback candidates"
    );
  });
  test("virtual auto-combo pool filters EVERY provider with partial sync, not just openrouter", async () => {
    // openai: sync only gpt-4o-mini (gpt-4o and gpt-4o-turbo exist in the static
    // catalog but are NOT synced → must be absent). kilocode: 359 synced models,
    // all with the kilocode provider prefix in the static registry → must be the
    // only kilocode candidates.
    const openaiConn = await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
    });
    const kilocodeConn = await providersDb.createProviderConnection({
      provider: "kilocode",
      authType: "apikey",
      name: "KiloCode",
      apiKey: "sk-test-kilocode",
    });
    const openaiId = (openaiConn as { id?: string }).id;
    const kilocodeId = (kilocodeConn as { id?: string }).id;
    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", openaiId, [
      { id: "gpt-4o-mini", name: "GPT-4o mini", source: "imported" as const },
    ]);
    await modelsDb.replaceSyncedAvailableModelsForConnection("kilocode", kilocodeId, [
      { id: "kilocode/gpt-oss-120b", name: "GPT-OSS 120B", source: "imported" as const },
      { id: "kilocode/qwen3-coder", name: "Qwen3 Coder", source: "imported" as const },
    ]);

    const prepared = await virtualFactory.prepareVirtualAutoComboInputs();
    const pool = prepared.regularCandidates;

    const openaiCandidates = pool.filter((c) => c.provider === "openai");
    assert.ok(
      openaiCandidates.some((c) => c.model === "gpt-4o-mini"),
      "synced openai model must be a candidate"
    );
    assert.ok(
      !openaiCandidates.some((c) => c.model !== "gpt-4o-mini"),
      `only the synced openai model may be a candidate, got: ${openaiCandidates.map((c) => c.model).join(", ")}`
    );

    const kilocodeCandidates = pool.filter((c) => c.provider === "kilocode");
    assert.deepEqual(
      kilocodeCandidates.map((c) => c.model).sort(),
      ["kilocode/gpt-oss-120b", "kilocode/qwen3-coder"],
      "kilocode pool must contain exactly the two synced models"
    );
  });

  test("virtual auto-combo pool survives a malformed customModels row", async () => {
    // The `customModels` key_value blob is operator-writable and is read back as raw
    // parsed JSON, so a row can be null / a non-object / carry no id. Before the guard
    // in prepareVirtualAutoComboInputs those rows threw
    // "Cannot read properties of null (reading 'id')" and EVERY auto/* combo failed to
    // materialize ("[catalog] Could not materialize built-in auto model auto/<id>").
    const conn = await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI",
      apiKey: "sk-test-openai",
    });
    const connectionId = (conn as { id?: string }).id;
    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connectionId, [
      { id: "gpt-4o-mini", name: "GPT-4o mini", source: "imported" as const },
    ]);
    await getTestBackend().execute(
      `INSERT INTO provider_model_catalog (provider, custom_models) VALUES ($1, $2::jsonb)
     ON CONFLICT (provider) DO UPDATE SET custom_models = EXCLUDED.custom_models`,
      [
        "openai",
        JSON.stringify([null, "not-an-object", { name: "Missing Id" }, { id: "operator-custom" }]),
      ]
    );

    const prepared = await virtualFactory.prepareVirtualAutoComboInputs();
    const openaiCandidates = prepared.regularCandidates.filter((c) => c.provider === "openai");
    assert.ok(
      openaiCandidates.some((c) => c.model === "gpt-4o-mini"),
      "the synced model must still reach the pool despite the malformed custom rows"
    );
    assert.ok(
      openaiCandidates.some((c) => c.model === "operator-custom"),
      "the one well-formed custom row must still reach the pool"
    );
  });
});

describe("combo-account-allowlist-3266", () => {
  // #3266 — Per-combo account allowlist.
  //
  // A combo model step can carry a first-class `allowedConnectionIds` so a round-robin /
  // weighted strategy is scoped to a subset of a provider's connections (e.g. {foo1, foo2})
  // without hand-pinning one step per account.
  //
  // Acceptance (owner): a round-robin scoped to {foo1, foo2} over an active pool {foo1..foo4}
  // never selects foo3/foo4 on real chat requests.
  //
  // Coverage:
  //   1. steps.ts parses `allowedConnectionIds` (trim + drop empty).
  //   2. handleComboChat propagates the step allowlist onto target.allowedConnectionIds.
  //   3. getProviderCredentials never hands back a connection outside the allowlist.
  function createLog() {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }

  function okResponse(content: string) {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async function seedConn(name: string, tags?: string[]) {
    return providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name,
      apiKey: `sk-${name}`,
      isActive: true,
      ...(tags ? { providerSpecificData: { tags } } : {}),
    });
  }

  beforeEach(async () => {
    await resetStorage();
  });

  // ── 1. Schema parse ──

  test("normalizeComboStep parses allowedConnectionIds (trim + drop empty)", () => {
    const step = normalizeComboStep({
      kind: "model",
      model: "openai/gpt-4o-mini",
      allowedConnectionIds: [" foo1 ", "foo2", "", "   "],
    });
    assert.ok(step && step.kind === "model");
    assert.deepEqual((step as { allowedConnectionIds?: string[] }).allowedConnectionIds, [
      "foo1",
      "foo2",
    ]);
  });

  test("normalizeComboStep omits allowedConnectionIds when absent or all-empty", () => {
    const bare = normalizeComboStep({ kind: "model", model: "openai/gpt-4o-mini" });
    assert.ok(bare && bare.kind === "model");
    assert.equal((bare as { allowedConnectionIds?: string[] }).allowedConnectionIds, undefined);

    const emptyish = normalizeComboStep({
      kind: "model",
      model: "openai/gpt-4o-mini",
      allowedConnectionIds: ["", "  "],
    });
    assert.equal((emptyish as { allowedConnectionIds?: string[] }).allowedConnectionIds, undefined);
  });

  test("buildPrecisionComboModelStep carries an allowlist when auto-selecting (#3266)", () => {
    const step = buildPrecisionComboModelStep({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      connectionId: null,
      allowedConnectionIds: [" a ", "b", "", "b"],
    });
    // trims, drops empty, dedupes
    assert.deepEqual((step as { allowedConnectionIds?: string[] }).allowedConnectionIds, [
      "a",
      "b",
    ]);
  });

  test("buildPrecisionComboModelStep drops the allowlist when a single account is pinned (#3266)", () => {
    const step = buildPrecisionComboModelStep({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      connectionId: "pinned-1",
      allowedConnectionIds: ["a", "b"],
    });
    // a forced connectionId wins — allowlist is meaningless and must not be carried
    assert.equal(step.connectionId, "pinned-1");
    assert.equal((step as { allowedConnectionIds?: string[] }).allowedConnectionIds, undefined);
  });

  // ── 2. Propagation onto the resolved combo target ──

  test("handleComboChat propagates a step allowlist onto target.allowedConnectionIds (#3266)", async () => {
    const foo1 = await seedConn("foo1");
    const foo2 = await seedConn("foo2");
    await seedConn("foo3");
    await seedConn("foo4");

    let captured: string[] | null = null;
    const response = await handleComboChat({
      body: { model: "rr", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "rr",
        strategy: "round-robin",
        models: [
          {
            kind: "model",
            model: "openai/gpt-4o-mini",
            allowedConnectionIds: [foo1.id, foo2.id],
          },
        ],
      },
      handleSingleModel: async (
        _body: unknown,
        modelStr: string,
        target: { allowedConnectionIds?: unknown }
      ) => {
        captured = Array.isArray(target?.allowedConnectionIds) ? target.allowedConnectionIds : null;
        return okResponse(modelStr);
      },
      log: createLog(),
    });

    assert.equal(response.status, 200);
    assert.ok(captured, "target.allowedConnectionIds must be populated from the step");
    assert.deepEqual([...captured!].sort(), [foo1.id, foo2.id].sort());
  });

  test("buildAutoCandidates expands dynamic auto steps only within allowedConnectionIds", async () => {
    const foo1 = await seedConn("foo1");
    const foo2 = await seedConn("foo2");
    const foo3 = await seedConn("foo3");
    const foo4 = await seedConn("foo4");
    const allowed = new Set([foo1.id, foo2.id]);
    const forbidden = new Set([foo3.id, foo4.id]);

    const candidates = await buildAutoCandidates(
      [
        {
          kind: "model",
          stepId: "openai/gpt-4o-mini",
          executionKey: "openai/gpt-4o-mini",
          modelStr: "openai/gpt-4o-mini",
          provider: "openai",
          providerId: "openai",
          connectionId: null,
          allowedConnectionIds: [foo1.id, foo2.id],
          weight: 1,
          label: null,
        },
      ],
      "auto-allowlist"
    );

    const connectionIds = candidates.map((candidate) => candidate.connectionId).filter(Boolean);
    assert.deepEqual([...connectionIds].sort(), [foo1.id, foo2.id].sort());
    assert.ok(connectionIds.every((connectionId) => allowed.has(connectionId!)));
    assert.ok(connectionIds.every((connectionId) => !forbidden.has(connectionId!)));
  });

  // ── 3. Acceptance: the credential selector never escapes the allowlist ──

  test("getProviderCredentials never selects a connection outside the step allowlist (#3266)", async () => {
    const foo1 = await seedConn("foo1");
    const foo2 = await seedConn("foo2");
    const foo3 = await seedConn("foo3");
    const foo4 = await seedConn("foo4");
    const allowed = [foo1.id, foo2.id];
    const forbidden = new Set([foo3.id, foo4.id]);

    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const cred = (await getProviderCredentials("openai", null, allowed)) as {
        connectionId?: string;
      } | null;
      assert.ok(cred && cred.connectionId, "a credential within the allowlist must be returned");
      assert.ok(
        allowed.includes(cred!.connectionId!),
        `selected ${cred!.connectionId} which is outside the allowlist`
      );
      assert.ok(!forbidden.has(cred!.connectionId!), "must never select foo3/foo4");
      seen.add(cred!.connectionId!);
    }
    // Both allowed accounts should be reachable (round-robin spreads across the subset).
    assert.ok(seen.size >= 1 && [...seen].every((id) => allowed.includes(id)));
  });

  // ── 4. Step allowlist + tag routing → most-restrictive (intersection) ──

  test("a step allowlist intersects with tag routing — most-restrictive wins (#3266)", async () => {
    await seedConn("foo1", ["us"]);
    const foo2 = await seedConn("foo2", ["eu"]);
    const foo3 = await seedConn("foo3", ["eu"]);
    await seedConn("foo4", ["us"]);

    let captured: string[] | null = null;
    const response = await handleComboChat({
      body: {
        model: "rr",
        messages: [{ role: "user", content: "hi" }],
        metadata: { tags: ["eu"] },
      },
      combo: {
        name: "rr",
        strategy: "priority",
        models: [
          {
            kind: "model",
            model: "openai/gpt-4o-mini",
            // allowlist excludes foo4; tags=[eu] match foo2+foo3 → intersection {foo2,foo3}
            allowedConnectionIds: [foo2.id, foo3.id, "nonexistent-but-allowed"],
          },
        ],
      },
      handleSingleModel: async (
        _body: unknown,
        modelStr: string,
        target: { allowedConnectionIds?: unknown }
      ) => {
        captured = Array.isArray(target?.allowedConnectionIds) ? target.allowedConnectionIds : null;
        return okResponse(modelStr);
      },
      log: createLog(),
    });

    assert.equal(response.status, 200);
    assert.ok(captured, "target.allowedConnectionIds must be the intersection");
    assert.deepEqual([...captured!].sort(), [foo2.id, foo3.id].sort());
  });
});

describe("combo-hidden-leaf-routing", () => {
  const noop = (..._args: unknown[]) => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };

  function okResponse(): Response {
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  }

  beforeEach(() => resetStorage());

  test("handleComboChat never routes hidden leaves in priority, weighted, or round-robin combos", async () => {
    await modelsDb.mergeModelCompatOverride("openai", "hidden-combo-leaf", { isHidden: true });

    for (const strategy of ["priority", "weighted", "round-robin"] as const) {
      const calls: string[] = [];
      const result = await handleComboChat({
        body: {},
        combo: {
          name: `hidden-${strategy}`,
          strategy,
          models: [
            { model: "openai/hidden-combo-leaf", weight: 100 },
            { model: "openai/visible-combo-leaf", weight: 1 },
          ],
          config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
        },
        handleSingleModel: async (_body: unknown, modelStr: string) => {
          calls.push(modelStr);
          return okResponse();
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        relayOptions: null,
        allCombos: null,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(calls, ["openai/visible-combo-leaf"]);
    }
  });

  test("handleComboChat preserves explicit providers for custom slashful model ids", async () => {
    await modelsDb.mergeModelCompatOverride("nvidia", "vendor/model-x", { isHidden: true });
    const calls: string[] = [];

    const result = await handleComboChat({
      body: {},
      combo: {
        name: "structured-custom-slashful",
        strategy: "priority",
        models: [
          { model: "vendor/model-x", providerId: "nvidia" },
          { model: "openai/visible-sibling", providerId: "openai" },
        ],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/visible-sibling"]);
  });

  test("handleComboChat filters hidden leaves through nested flatten and execute modes", async () => {
    await modelsDb.mergeModelCompatOverride("openai", "hidden-nested-leaf", { isHidden: true });
    const child = {
      name: "hidden-leaf-child",
      strategy: "priority",
      models: ["openai/hidden-nested-leaf", "openai/visible-nested-leaf"],
    };

    for (const nestedComboMode of ["flatten", "execute"] as const) {
      const calls: string[] = [];
      const parent = {
        name: `hidden-leaf-parent-${nestedComboMode}`,
        strategy: "priority",
        models: [{ kind: "combo-ref", comboName: child.name }],
        config: { nestedComboMode, maxRetries: 0 },
      };
      const result = await handleComboChat({
        body: {},
        combo: parent,
        handleSingleModel: async (_body: unknown, modelStr: string) => {
          calls.push(modelStr);
          return okResponse();
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        relayOptions: null,
        allCombos: [parent, child],
      });

      assert.equal(result.ok, true);
      assert.deepEqual(calls, ["openai/visible-nested-leaf"]);
    }
  });

  test("handleComboChat auto pipeline never dispatches hidden combo leaves", async () => {
    await modelsDb.mergeModelCompatOverride("openai", "o3", { isHidden: true });
    const calls: string[] = [];
    const result = await handleComboChat({
      body: {
        messages: [
          {
            role: "user",
            content:
              "Analyze this complex distributed systems failure and produce a rigorous implementation plan with explicit tradeoffs, invariants, edge cases, and verification steps for every stage.",
          },
        ],
      },
      combo: {
        name: "auto/smart",
        strategy: "auto",
        models: ["openai/o3", "openai/gpt-4o-mini"],
        config: {
          pipeline_enabled: true,
          skip_pipeline_for_tokens_under: 0,
          max_reflection_loops: 0,
        },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.ok(calls.length > 0);
    assert.deepEqual(new Set(calls), new Set(["openai/gpt-4o-mini"]));
  });

  test("handleComboChat drops a context-cache pin when the pinned model becomes hidden", async () => {
    const sessionId = "hidden-pin-session";
    const comboName = "hidden-pin-combo";
    await modelsDb.mergeModelCompatOverride("openai", "hidden-pinned-leaf", { isHidden: true });
    await contextHandoffsDb.recordSessionModelUsage(
      sessionId,
      comboName,
      "openai/hidden-pinned-leaf",
      "openai"
    );
    const calls: string[] = [];

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "continue" }] },
      combo: {
        name: comboName,
        strategy: "priority",
        models: ["openai/hidden-pinned-leaf", "openai/visible-pinned-leaf"],
        context_cache_protection: true,
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: { sessionId },
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/visible-pinned-leaf"]);
  });

  test("resolveShadowTargets excludes hidden leaves before applying the target limit", async () => {
    await modelsDb.mergeModelCompatOverride("openai", "hidden-shadow-leaf", { isHidden: true });
    // Production passes the hidden-model snapshot in (combo.ts), so the test does too.
    const hiddenModelsByProvider = new Map([["openai", new Set(["hidden-shadow-leaf"])]]);
    const targets = resolveShadowTargets(
      { name: "hidden-shadow-combo", models: [] },
      {
        shadowRouting: {
          enabled: true,
          targets: ["openai/hidden-shadow-leaf", "openai/visible-shadow-leaf"],
          sampleRate: 1,
          maxTargets: 1,
        },
      },
      null,
      hiddenModelsByProvider
    );

    assert.deepEqual(
      targets.map((target) => target.modelStr),
      ["openai/visible-shadow-leaf"]
    );
  });

  test("handleComboChat canonicalizes provider and model aliases before filtering hidden leaves", async () => {
    await modelsDb.mergeModelCompatOverride("github", "claude-opus-4-5-20251101", {
      isHidden: true,
    });
    const calls: string[] = [];

    const result = await handleComboChat({
      body: {},
      combo: {
        name: "hidden-alias-leaf",
        strategy: "priority",
        models: ["gh/claude-4.5-opus", "openai/visible-alias-sibling"],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/visible-alias-sibling"]);
  });

  test("handleComboChat preserves an explicit provider for slashful model ids", async () => {
    await modelsDb.mergeModelCompatOverride("nvidia", "openai/gpt-oss-120b", { isHidden: true });
    const calls: string[] = [];

    const result = await handleComboChat({
      body: {},
      combo: {
        name: "hidden-structured-leaf",
        strategy: "priority",
        models: [
          { model: "openai/gpt-oss-120b", providerId: "nvidia" },
          { model: "openai/visible-structured-sibling", providerId: "openai" },
        ],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/visible-structured-sibling"]);
  });

  test("handleComboChat reuses one hidden-model snapshot through nested execute mode", async () => {
    await modelsDb.mergeModelCompatOverride("openai", "hidden-snapshot-leaf", { isHidden: true });
    const child = {
      name: "hidden-snapshot-child",
      strategy: "priority",
      models: ["openai/hidden-snapshot-leaf", "openai/visible-snapshot-leaf"],
      config: { nestedComboMode: "execute", maxRetries: 0 },
    };
    const parent = {
      name: "hidden-snapshot-parent",
      strategy: "priority",
      models: [{ kind: "combo-ref", comboName: child.name }],
      config: { nestedComboMode: "execute", maxRetries: 0 },
    };
    // The SQLite version counted prepare() calls on the handle. PostgreSQL reads do not pass
    // through DbBackend.query, so the snapshot-count guard is not observable here; the routing
    // assertions below still cover the hidden-leaf filtering through nested execute mode.
    {
      const calls: string[] = [];
      const result = await handleComboChat({
        body: {},
        combo: parent,
        handleSingleModel: async (_body: unknown, modelStr: string) => {
          calls.push(modelStr);
          return okResponse();
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        relayOptions: null,
        allCombos: [parent, child],
      });

      assert.equal(result.ok, true);
      assert.deepEqual(calls, ["openai/visible-snapshot-leaf"]);
    }
  });
});

describe("combo-family-key-policy-16406", () => {
  const high = "codex/gpt-6-astra-high";
  const max = "codex/gpt-6-astra-max";
  const log = { info() {}, warn() {}, error() {}, debug() {} };

  before(async () => {
    await resetStorage();
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "fixture",
      apiKey: "fixture-key",
    });
  });

  for (const transport of ["bearer", "path-token"] as const) {
    for (const mode of ["implicit-denied", "explicit-target", "directly-allowed"] as const) {
      test(`stored combo grant: ${mode} via ${transport}`, async () => {
        const name = `family-policy-${mode}-${transport}`;
        const models = mode === "explicit-target" ? [high, max] : [high];
        const storedCombo = await combos.createCombo({ name, strategy: "priority", models });
        const key = await keys.createApiKey(name, "fixture-machine", [], {
          modelAccessMode: "restricted",
          allowedModels: mode === "directly-allowed" ? [max] : ["gemini/*"],
          blockedModels: mode === "directly-allowed" ? [high] : [high, max],
          allowedCombos: [name],
        });
        const headers =
          transport === "bearer"
            ? new Headers({ authorization: `Bearer ${key.key}` })
            : withPathTokenApiKey(
                new Request(
                  `http://localhost/api/v1/vscode/${encodeURIComponent(key.key)}/chat/completions`
                )
              ).headers;
        const admitted = await enforceApiKeyPolicy(
          new Request("http://localhost/v1/chat/completions", { headers }),
          name
        );
        assert.equal(admitted.rejection, null, "the stored combo itself is permitted");
        assert.equal(
          await keys.isModelAllowedForKey(key.key, max, max),
          mode === "directly-allowed"
        );
        const sent: string[] = [];
        const result = await handleComboChat({
          combo: { ...storedCombo, config: { maxRetries: 0 } },
          body: { messages: [{ role: "user", content: "hello" }], stream: false },
          requestHeaders: headers,
          // The dispatch callback has the server-owned explicit-combo grant. Family
          // recovery must enforce direct model policy before extending that grant.
          handleSingleModel: async (_body, model) => {
            sent.push(model);
            return Response.json({
              choices: [{ message: { content: model === high ? "" : "OK" } }],
            });
          },
          isModelAvailable: async () => true,
          log,
        });
        if (mode === "implicit-denied") {
          assert.deepEqual(sent, [high]);
          assert.equal(result.ok, false);
        } else {
          assert.deepEqual(sent, [high, max]);
          assert.equal(result.ok, true);
        }
      });
    }
  }
});

describe("combo-family-selected-connection-16223", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };

  before(async () => {
    await resetStorage();
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "family-connection-fixture",
      apiKey: "fixture-key",
    });
  });
  beforeEach(() => clearAllModelLockouts());
  after(() => clearAllModelLockouts());

  for (const lockedConnection of ["selected-account", "other-account"]) {
    test(`unpinned quality fallback honors lockouts on ${lockedConnection}`, async () => {
      lockExactModel("codex", lockedConnection, "gpt-6-astra-max", "rate_limit", 60_000);
      const sentModels: string[] = [];
      const result = await handleComboChat({
        body: { messages: [{ role: "user", content: "hello" }], stream: false },
        combo: {
          name: `family-selected-${lockedConnection}`,
          strategy: "priority",
          models: ["codex/gpt-6-astra-high"],
          config: { maxRetries: 0 },
        },
        handleSingleModel: async (_body: unknown, model: string) => {
          sentModels.push(model);
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: sentModels.length === 1 ? "" : "recovered" } }],
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "X-OmniRoute-Selected-Connection-Id": "selected-account",
              },
            }
          );
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        allCombos: null,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(sentModels, [
        "codex/gpt-6-astra-high",
        lockedConnection === "selected-account"
          ? "codex/gpt-6-astra-ultra"
          : "codex/gpt-6-astra-max",
      ]);
    });
  }
});

describe("combo-pin-health-gate", () => {
  // ccp pin health gate — drop a context-cache pin when its provider is DURABLY down so the
  // session fails over instead of pounding a dead account, while tolerating transient cooldowns
  // so an unstable provider does not churn the pin.
  //
  // Incident 2026-06-22: a session pinned to a throttled/credits-exhausted account stayed pinned
  // forever (strategy bypassed, no failover) because the pin was only dropped when the model
  // LEFT the combo, never on connection health.
  const NOW = 1_900_000_000_000;
  const opts = { backoffLevel: 2, graceMs: 20_000 };
  const healthy = { testStatus: "active", backoffLevel: 0, rateLimitedUntil: null };

  test("keeps pin when a healthy connection exists", () => {
    assert.equal(pinIsDurablyUnhealthy("CLOSED", [healthy], NOW, opts), false);
  });

  test("drops pin when circuit is OPEN", () => {
    assert.equal(pinIsDurablyUnhealthy("OPEN", [healthy], NOW, opts), true);
  });

  test("drops pin when there are no active connections", () => {
    assert.equal(pinIsDurablyUnhealthy("CLOSED", [], NOW, opts), true);
  });

  test("drops pin when the only connection has credits exhausted (terminal)", () => {
    const conn = { testStatus: "credits_exhausted", backoffLevel: 0, rateLimitedUntil: null };
    assert.equal(pinIsDurablyUnhealthy("CLOSED", [conn], NOW, opts), true);
  });

  test("drops pin on banned/expired terminal status", () => {
    assert.equal(
      pinIsDurablyUnhealthy("CLOSED", [{ testStatus: "banned", backoffLevel: 0 }], NOW, opts),
      true
    );
    assert.equal(
      pinIsDurablyUnhealthy("CLOSED", [{ testStatus: "expired", backoffLevel: 0 }], NOW, opts),
      true
    );
  });

  test("drops pin once backoffLevel reaches the threshold (repeated failures)", () => {
    assert.equal(
      pinIsDurablyUnhealthy("CLOSED", [{ testStatus: "active", backoffLevel: 2 }], NOW, opts),
      true
    );
  });

  test("anti-flap: keeps pin on a brief transient cooldown (low backoff, short rate-limit)", () => {
    const conn = {
      testStatus: "active",
      backoffLevel: 1,
      rateLimitedUntil: new Date(NOW + 4_000).toISOString(), // 4s out — within grace
    };
    assert.equal(pinIsDurablyUnhealthy("CLOSED", [conn], NOW, opts), false);
  });

  test("drops pin on a long rate-limit window (beyond grace)", () => {
    const conn = {
      testStatus: "active",
      backoffLevel: 0,
      rateLimitedUntil: new Date(NOW + 60_000).toISOString(), // 60s out — durable
    };
    assert.equal(pinIsDurablyUnhealthy("CLOSED", [conn], NOW, opts), true);
  });

  test("keeps pin if ANY connection is usable (terminal + healthy mix)", () => {
    const conns = [{ testStatus: "credits_exhausted", backoffLevel: 0 }, healthy];
    assert.equal(pinIsDurablyUnhealthy("CLOSED", conns, NOW, opts), false);
  });
});

describe("combo-pin-implicit-allowlist", () => {
  // A combo step with connectionId and no allowedConnectionIds is a pin, not a hint. After that
  // account 502/429s, dropping forcedConnectionId must NOT scan the rest of the provider pool
  // (offical-fable 20X -> sibling Pro).
  //
  // Implicit allowlist = [connectionId] when the step omitted one.
  function createLog() {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }

  function okResponse(content: string) {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  test("resolveComboTargets treats a pin-only step as implicit allowlist [connectionId]", async () => {
    const targets = await resolveComboTargets(
      {
        name: "offical-fable",
        strategy: "priority",
        models: [
          {
            kind: "model",
            model: "claude/claude-code",
            connectionId: "20x-account",
          },
        ],
      },
      null
    );
    assert.equal(targets.length, 1);
    assert.equal(targets[0].connectionId, "20x-account");
    assert.deepEqual(targets[0].allowedConnectionIds, ["20x-account"]);
  });

  test("resolveComboTargets treats an empty allowlist plus a pin as [connectionId]", async () => {
    const targets = await resolveComboTargets(
      {
        name: "empty-list-pin",
        strategy: "priority",
        models: [
          {
            kind: "model",
            model: "claude/claude-code",
            connectionId: "20x-account",
            allowedConnectionIds: [],
          },
        ],
      },
      null
    );
    assert.deepEqual(targets[0].allowedConnectionIds, ["20x-account"]);
  });

  test("resolveComboTargets keeps an explicit allowlist even when a pin is also set", async () => {
    const targets = await resolveComboTargets(
      {
        name: "multi",
        strategy: "priority",
        models: [
          {
            kind: "model",
            model: "claude/claude-code",
            connectionId: "primary",
            allowedConnectionIds: ["primary", "secondary"],
          },
        ],
      },
      null
    );
    assert.equal(targets[0].connectionId, "primary");
    assert.deepEqual(targets[0].allowedConnectionIds, ["primary", "secondary"]);
  });

  test("resolveComboTargets does not invent an allowlist for an unpinned step", async () => {
    const targets = await resolveComboTargets(
      {
        name: "open-pool",
        strategy: "round-robin",
        models: [{ kind: "model", model: "claude/claude-code" }],
      },
      null
    );
    assert.equal(targets[0].connectionId, null);
    assert.equal(targets[0].allowedConnectionIds, undefined);
  });

  test("handleComboChat passes the implicit pin allowlist into handleSingleModel", async () => {
    let captured: string[] | null | undefined = undefined;
    const response = await handleComboChat({
      body: { model: "rr", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "rr",
        strategy: "priority",
        models: [
          {
            kind: "model",
            model: "openai/gpt-4o-mini",
            connectionId: "pinned-20x",
          },
        ],
      },
      handleSingleModel: async (
        _body: unknown,
        modelStr: string,
        target: { allowedConnectionIds?: unknown }
      ) => {
        captured = Array.isArray(target?.allowedConnectionIds) ? target.allowedConnectionIds : null;
        return okResponse(modelStr);
      },
      log: createLog(),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(captured, ["pinned-20x"]);
  });

  test("comboModelStepInputSchema keeps allowedConnectionIds on parse", () => {
    const parsed = comboModelStepInputSchema.parse({
      kind: "model",
      model: "claude/claude-code",
      connectionId: "20x-account",
      allowedConnectionIds: ["20x-account"],
    });
    assert.deepEqual(parsed.allowedConnectionIds, ["20x-account"]);
  });

  test("implicitPinAllowlist treats omitted allowlist as [connectionId]", () => {
    assert.deepEqual(implicitPinAllowlist(" 20x ", undefined), ["20x"]);
    assert.deepEqual(implicitPinAllowlist("20x", null), ["20x"]);
    assert.deepEqual(implicitPinAllowlist("20x", ["a", "b"]), ["a", "b"]);
    assert.deepEqual(implicitPinAllowlist("20x", []), ["20x"]);
    assert.deepEqual(implicitPinAllowlist(null, []), []);
    assert.equal(implicitPinAllowlist(null, undefined), null);
  });

  test("comboPinAllowlist does not invent an allowlist for header-forced pins", () => {
    assert.equal(comboPinAllowlist(false, "header-pin", undefined), null);
    assert.equal(comboPinAllowlist(false, "header-pin", null), null);
    assert.deepEqual(comboPinAllowlist(false, "header-pin", ["a"]), ["a"]);
    assert.deepEqual(comboPinAllowlist(true, "combo-pin", undefined), ["combo-pin"]);
  });

  test("checkModelAvailable resolves combo restrictions before credential preflight", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { resolve } = await import("node:path");
    const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    const src = readFileSync(resolve(repoRoot, "src/sse/handlers/chat.ts"), "utf8");
    const start = src.indexOf("const checkModelAvailable = async");
    const end = src.indexOf("isModelAvailable: checkModelAvailable");
    assert.ok(start >= 0 && end > start, "checkModelAvailable body must be locatable");
    const body = src.slice(start, end);
    assert.match(
      body,
      /resolveConnectionRestrictions\(apiKeyInfo, target, true\)/,
      "combo preflight caches credentials; a pin without allowlist must not scan the pool"
    );
    const pinAt = body.search(/resolveConnectionRestrictions\s*\(/);
    const credsAt = body.search(/getProviderCredentialsWithQuotaPreflight\s*\(/);
    assert.ok(
      pinAt >= 0 && credsAt > pinAt,
      "pin allowlist must be computed before preflight lookup"
    );
  });

  test("combo restrictions preserve an implicit pin and fail closed on an API-key conflict", () => {
    assert.deepEqual(resolveConnectionRestrictions(null, { connectionId: "pinned" }, true), {
      allowedConnections: ["pinned"],
      sources: ["combo_pin"],
    });
    assert.deepEqual(
      resolveConnectionRestrictions(
        { allowedConnections: ["other"] },
        { connectionId: "pinned" },
        true
      ),
      {
        allowedConnections: [],
        sources: ["api_key_allowlist", "combo_pin"],
      }
    );
    assert.deepEqual(resolveConnectionRestrictions(null, { connectionId: "header-pin" }, false), {
      allowedConnections: null,
      sources: [],
    });
  });
});

describe("combo-lane-awareness-9654", () => {
  // #9654 Wave 2 — combo/fusion per-target lane-aware admission.
  //
  // Combo and fusion fan-out dispatch N targets without ever consulting the adaptive-admission
  // layer: the parent request holds one lease, but each fan-out target is dispatched
  // unconditionally. With virtual lanes enabled (OMNIROUTE_CHAT_VIRTUAL_LANES=1), a tenant whose
  // lane queue is full should SKIP additional fan-out targets instead of piling more queued work
  // onto an already-congested lane.
  //
  // The per-target probe (`PerTargetAdmissionHook`, built by `createPerTargetAdmissionHook`) is:
  //   - strictly non-blocking (maxWaitMs 0 — skip, never queue)
  //   - a no-op when virtual lanes are off (the shared queue is the only gate, and the parent
  //     request already holds one lease — probing there would double-count and reject combo
  //     targets)
  //   - routed to the PARENT's tenantKey so it gates the same per-tenant lane
  //   - release-immediately on admit: the probe is a capacity gate, not a hold (the parent's
  //     lease covers the fan-out; holding N more would inflate shared active cost and reject
  //     other sessions)
  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  type Body = Record<string, unknown>;

  function okResponse(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  function priorityCombo(models: string[]) {
    return {
      name: "test-lane-combo",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  function rrCombo(models: string[]) {
    return {
      name: "test-lane-rr-combo",
      strategy: "round-robin",
      models: models.map((m) => ({ model: m })),
    };
  }

  function fusionCombo(models: string[], extra: Record<string, unknown> = {}) {
    return {
      name: "test-lane-fusion",
      strategy: "fusion",
      models: models.map((m) => ({ model: m })),
      config: extra,
    };
  }

  // ── Factory unit tests: hook semantics in isolation ──

  function fakeRuntime(opts: {
    virtualLanes: boolean;
    acquireResult?: {
      status: "admitted" | "rejected";
      lease?: { released: boolean; release: (outcome?: string) => void };
    };
    acquireError?: Error;
  }): AdaptiveAdmissionRuntime & { acquireCalls: Array<Record<string, unknown>> } {
    const acquireCalls: Array<Record<string, unknown>> = [];
    const runtime = {
      acquireCalls,
      async acquire(input: Record<string, unknown>) {
        acquireCalls.push(input);
        if (opts.acquireError) throw opts.acquireError;
        if (opts.acquireResult) return opts.acquireResult;
        throw new Error("fake runtime: acquireResult not configured");
      },
      snapshot() {
        return { virtualLanes: opts.virtualLanes };
      },
    } as unknown as AdaptiveAdmissionRuntime & { acquireCalls: Array<Record<string, unknown>> };
    return runtime;
  }

  test("probe is a no-op when virtual lanes are off (never calls acquire)", async () => {
    const runtime = fakeRuntime({ virtualLanes: false });
    const hook = createPerTargetAdmissionHook(runtime, "tenant-a");
    const ok = await hook({ modelStr: "p/model", executionKey: "k1", body: {} });
    assert.equal(ok, true, "lanes off must pass every target through");
    assert.equal(runtime.acquireCalls.length, 0, "no acquire when lanes are off");
  });

  test("probe is strictly non-blocking: maxWaitMs 0, parent tenantKey, release-on-admit", async () => {
    let released = false;
    const runtime = fakeRuntime({
      virtualLanes: true,
      acquireResult: {
        status: "admitted",
        lease: {
          released: false,
          release: () => {
            released = true;
          },
        },
      },
    });
    const hook = createPerTargetAdmissionHook(runtime, "tenant-parent", null);
    const ok = await hook({ modelStr: "p/model", executionKey: "k1", body: { messages: [] } });

    assert.equal(ok, true, "admitted probe must proceed");
    assert.equal(runtime.acquireCalls.length, 1);
    assert.equal(runtime.acquireCalls[0].tenantKey, "tenant-parent", "must gate the parent's lane");
    assert.equal(runtime.acquireCalls[0].maxWaitMs, 0, "strictly non-blocking: never queue");
    assert.deepEqual(
      runtime.acquireCalls[0].body,
      { messages: [] },
      "probe must estimate cost from the real target body"
    );
    assert.equal(
      runtime.acquireCalls[0].streaming,
      false,
      "absent stream flag must price the target like the parent path (non-streaming class)"
    );
    assert.equal(
      released,
      true,
      "probe lease must be released immediately (capacity gate, not a hold)"
    );
  });

  test("probe prices the request class the target will actually dispatch", async () => {
    const runtime = fakeRuntime({
      virtualLanes: true,
      acquireResult: { status: "admitted", lease: { released: false, release: () => {} } },
    });
    const hook = createPerTargetAdmissionHook(runtime, "tenant-parent");

    await hook({ modelStr: "p/model", executionKey: "k1", body: { stream: true } });
    assert.equal(
      runtime.acquireCalls[0].streaming,
      true,
      "stream:true fan-out must be priced at streaming class (1)"
    );

    await hook({ modelStr: "p/model", executionKey: "k2", body: { stream: false } });
    assert.equal(
      runtime.acquireCalls[1].streaming,
      false,
      "stream:false fan-out (e.g. fusion panel) must be priced at non-streaming class (2)"
    );

    await hook({ modelStr: "p/model", executionKey: "k3", body: { messages: [] } });
    assert.equal(
      runtime.acquireCalls[2].streaming,
      false,
      "absent stream flag must match the parent path (non-streaming class)"
    );
  });

  test("probe skips the target when its lane is full (rejected acquire)", async () => {
    const runtime = fakeRuntime({
      virtualLanes: true,
      acquireResult: {
        status: "rejected",
        lease: undefined,
      },
    });
    const hook = createPerTargetAdmissionHook(runtime, "tenant-parent");
    const ok = await hook({ modelStr: "p/model", executionKey: "k1", body: {} });
    assert.equal(ok, false, "lane-full probe must skip the target");
  });

  test("probe fails open when the admission layer throws (never fails the fan-out)", async () => {
    const runtime = fakeRuntime({
      virtualLanes: true,
      acquireError: new Error("admission layer hiccup"),
    });
    const hook = createPerTargetAdmissionHook(runtime, "tenant-parent");
    const ok = await hook({ modelStr: "p/model", executionKey: "k1", body: {} });
    assert.equal(ok, true, "an admission-layer error must let the target dispatch ungated");
  });

  test("probe forwards the abort signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const runtime = fakeRuntime({
      virtualLanes: true,
      acquireResult: { status: "rejected", lease: undefined },
    });
    const hook = createPerTargetAdmissionHook(runtime, "tenant-parent", ac.signal);
    await hook({ modelStr: "p/model", executionKey: "k1", body: {} });
    assert.equal(runtime.acquireCalls[0].signal, ac.signal, "probe must forward the parent signal");
  });

  // ── Integration: combo priority skips lane-full targets ──

  test("priority combo: lane-full target is skipped before dispatch, healthy target serves", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return okResponse(`ans-${m}`);
    };
    // Lane full for the FIRST target only → it must be skipped, second serves.
    const perTargetAdmission: PerTargetAdmissionHook = async (t) => t.modelStr !== "p/first";

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: priorityCombo(["p/first", "p/second"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
      perTargetAdmission,
    });

    assert.deepEqual(calls, ["p/second"], "lane-full first target must be skipped");
    assert.equal(res.status, 200);
  });

  test("priority combo: all targets lane-full falls through to the exhausted path", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return okResponse(`ans-${m}`);
    };
    const perTargetAdmission: PerTargetAdmissionHook = async () => false; // every target skipped

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: priorityCombo(["p/first", "p/second"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
      perTargetAdmission,
    });

    assert.equal(calls.length, 0, "no target may be dispatched when every lane is full");
    assert.ok(
      [503, 502].includes(res.status),
      `expected a service-unavailable status, got ${res.status}`
    );
  });

  // ── Integration: round-robin skips lane-full targets ──

  test("round-robin: lane-full target is skipped, next target serves", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return okResponse(`ans-${m}`);
    };
    const perTargetAdmission: PerTargetAdmissionHook = async (t) => t.modelStr !== "p/first";

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: rrCombo(["p/first", "p/second"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
      perTargetAdmission,
    });

    assert.deepEqual(calls, ["p/second"], "round-robin must skip the lane-full first target");
    assert.equal(res.status, 200);
  });

  // ── Integration: fusion drops lane-full panel members before fan-out ──

  test("fusion: lane-full panel member is dropped before fan-out, judge still runs", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      if (m === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${m}`);
    };
    const perTargetAdmission = async (t: { modelStr: string }) => t.modelStr !== "p/dropped";

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["p/keep", "p/dropped"], { judgeModel: "p/judge" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
      perTargetAdmission,
    });

    assert.ok(!calls.includes("p/dropped"), "lane-full panel member must never be dispatched");
    assert.ok(calls.includes("p/keep"), "healthy panel member must still fan out");
    assert.ok(calls.includes("p/judge"), "judge synthesis must still run");
    assert.equal(res.status, 200);
  });

  test("fusion: all panel members lane-full returns 503 before any fan-out", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return okResponse(`ans-${m}`);
    };
    const perTargetAdmission: PerTargetAdmissionHook = async () => false; // every member skipped

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["p/keep", "p/other"], { judgeModel: "p/judge" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
      perTargetAdmission,
    });

    assert.equal(calls.length, 0, "no panel member may dispatch when every lane is full");
    assert.equal(
      res.status,
      503,
      "all-skipped fusion must return 503, not synthesize with nothing"
    );
  });

  test("fusion: no hook passed behaves exactly as before (no lane awareness)", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      if (m === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${m}`);
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["p/keep", "p/other"], { judgeModel: "p/judge" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.deepEqual(
      calls.sort(),
      ["p/judge", "p/keep", "p/other"],
      "no hook = full panel fan-out"
    );
    assert.equal(res.status, 200);
  });
});
