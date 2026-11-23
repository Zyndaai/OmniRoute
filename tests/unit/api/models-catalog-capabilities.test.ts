// Model capabilities in the /v1/models catalog: vision detection, catalog helpers, synced
// reasoning efforts (effort_tiers and `-{effort}` aliases), specialty model routes, hidden flags and
// token-limit overrides.
//
// Merged from 12 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// that touches the store resets the database, the API-key state, the learned reasoning-effort caps
// and the catalog cache in its own hooks (each former file started from an empty store); the
// database handle is closed once at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-models-catalog-capabilities-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";
// A cold catalog build can exceed the 8s default bound on a loaded host and answer 503
// `catalog_build_timeout` instead of the catalog under test.
process.env.CATALOG_BUILD_TIMEOUT_MS = process.env.CATALOG_BUILD_TIMEOUT_MS || "120000";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const contextOverrides = await import("../../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const modelDiscovery = await import("../../../src/lib/providerModels/modelDiscovery.ts");
const { getModelInfo } = await import("../../../src/sse/services/model.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const catalogCacheMod = await import("../../../src/app/api/v1/models/catalogCache.ts");
const catalogHelpers = await import("../../../src/app/api/v1/models/catalogHelpers.ts");
const catalogOpenrouter = await import("../../../src/app/api/v1/models/catalogOpenrouter.ts");
const catalogVision = await import("../../../src/app/api/v1/models/catalogVision.ts");
const catalogProviderMaps = await import("../../../src/app/api/v1/models/catalogProviderMaps.ts");
const { isCodexModelCatalogClient } =
  await import("../../../src/app/api/v1/models/catalogRequest.ts");
const { isVisionModelId } = await import("../../../src/shared/constants/visionModels.ts");
const { modelIdLikelyVision } = await import("../../../src/lib/modelCapabilities.ts");
const { replaceImageUrls } = await import("../../../open-sse/services/compression/lite.ts");
const imageRoute = await import("../../../src/app/api/v1/images/generations/route.ts");
const embeddingsRoute = await import("../../../src/app/api/v1/embeddings/route.ts");
const videoRoute = await import("../../../src/app/api/v1/videos/generations/route.ts");
const musicRoute = await import("../../../src/app/api/v1/music/generations/route.ts");
const syncModelsRoute = await import("../../../src/app/api/providers/[id]/sync-models/route.ts");
const overrideRoute = await import("../../../src/app/api/model-capability-overrides/route.ts");
const { buildModelSyncInternalHeaders } =
  await import("../../../src/shared/services/modelSyncScheduler.ts");
const { splitSyncedEffortSuffix } = await import("../../../open-sse/services/model.ts");
const {
  appendSyncedEffortVariants,
  shouldExposeSyncedEffortVariants,
  SYNCED_EFFORT_SKIP_PROVIDERS,
} = await import("../../../open-sse/utils/syncedEffortVariants.ts");
const { applyDefaultReasoningEffort } =
  await import("../../../open-sse/services/defaultReasoningEffort.ts");
const { recordLearnedReasoningEffort, __test_resetLearnedReasoningEffortCaps } =
  await import("../../../open-sse/services/learnedReasoningEffortCaps.ts");
const { REGISTRY } = await import("../../../open-sse/config/providerRegistry.ts");
const { sanitizeReasoningEffortForProvider } = await import("../../../open-sse/executors/base.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

const originalFetch = globalThis.fetch;

/** Start a describe from an empty database, API-key state, data dir, fetch and catalog cache. */
async function resetAll() {
  globalThis.fetch = originalFetch;
  __test_resetLearnedReasoningEffortCaps();
  await core.resetDbInstance();
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await catalogCacheMod.__flushCatalogBackgroundRefreshForTest();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

after(async () => {
  globalThis.fetch = originalFetch;
  __test_resetLearnedReasoningEffortCaps();
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seedProviderConnection(provider: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: `${provider}-key`,
    isActive: true,
    testStatus: "active",
  });
}

describe("llm-selector-custom-vision-models", () => {
  /**
   * Custom vision models in the LLM selector / `/v1/models` catalog
   * (port of upstream decolua/9router 5e5e78d3 — "fix: show custom vision
   * models in LLM selector and model list").
   *
   * Upstream stored an `imageToText` kind on user-added custom models and the
   * selector hid them from the default LLM list. OmniRoute already keeps custom
   * chat models in the LLM list, but the equivalent gap is the `supportsVision`
   * flag on a custom model: the catalog used to only set `capabilities.vision`
   * when the model id matched the conservative `isVisionModelId` heuristic
   * (`pixtral`, `llava`, `qwen-vl`, …). A user who registered a custom chat
   * model called e.g. `my-vision-llm` and explicitly checked "vision-capable"
   * still saw no `capabilities.vision` in `/v1/models`, so the LLM selector and
   * downstream routing treated it as text-only.
   *
   * This file pins the OmniRoute-flavoured behaviour:
   *   • a custom chat model with `supportsVision: true` MUST surface
   *     `capabilities: { vision: true }` via the catalog helper, regardless of
   *     whether the model id matches the static vision heuristic.
   *   • the existing id-based heuristic (`isVisionModelId`) still works.
   *   • when neither signal is present, no vision fields are emitted (no false
   *     positives — same conservative guard #4071 / #4072).
   */
  type VisionFields = { capabilities: { vision: true } } | null;
  type Helper = (entry: unknown, ...candidateIds: Array<string | null | undefined>) => VisionFields;

  const getCustomVisionCapabilityFields = (
    v1ModelsCatalog as unknown as { getCustomVisionCapabilityFields?: Helper }
  ).getCustomVisionCapabilityFields;

  test("custom vision helper is exported from the catalog module", () => {
    assert.equal(
      typeof getCustomVisionCapabilityFields,
      "function",
      "expected getCustomVisionCapabilityFields to be exported from src/app/api/v1/models/catalog.ts"
    );
  });

  test("supportsVision flag on a custom model surfaces capabilities.vision (LLM selector unblock)", () => {
    const helper = getCustomVisionCapabilityFields as Helper;
    const entry = { id: "my-vision-llm", supportsVision: true };
    const fields = helper(entry, "openai-compat/my-vision-llm", "my-vision-llm");
    assert.ok(fields, "supportsVision=true must yield vision fields");
    assert.equal(fields?.capabilities.vision, true);
  });

  test("id-based isVisionModelId heuristic still works when supportsVision is unset", () => {
    const helper = getCustomVisionCapabilityFields as Helper;
    const entry = { id: "pixtral-12b" };
    const fields = helper(entry, "openai-compat/pixtral-12b", "pixtral-12b");
    assert.ok(fields, "well-known vision model id must yield vision fields");
    assert.equal(fields?.capabilities.vision, true);
  });

  test("no signal → no vision fields (avoids #4071-style false positives)", () => {
    const helper = getCustomVisionCapabilityFields as Helper;
    const entry = { id: "plain-text-llm" };
    const fields = helper(entry, "openai-compat/plain-text-llm", "plain-text-llm");
    assert.equal(fields, null);
  });

  test("explicit supportsVision=false is respected (text-only override)", () => {
    const helper = getCustomVisionCapabilityFields as Helper;
    // Even if the id matches the heuristic, an explicit false flag wins so the
    // user can downgrade a mis-classified model.
    const entry = { id: "pixtral-12b", supportsVision: false };
    const fields = helper(entry, "alias/pixtral-12b", "pixtral-12b");
    assert.equal(fields, null);
  });

  // ─── catalog.ts:1613/1569 vision-branch narrowing (TS2367 fix) ──────────────
  // The production expression `!modelType || modelType === "chat"` was reduced to
  // `!modelType` because classifyModelSupportedEndpoints() can never return
  // "chat". These asserts pin that invariant so a future union widening forces a
  // revisit of the call sites instead of silently changing /v1/models output.

  test("classifyModelSupportedEndpoints never yields type 'chat'", async () => {
    const { classifyModelSupportedEndpoints } =
      await import("../../../src/shared/constants/modelSupportedEndpoints.ts");
    const endpointSets = [
      [],
      ["chat"],
      ["chat", "completions"],
      ["responses"],
      ["embeddings"],
      ["rerank"],
      ["images"],
      ["videos"],
      ["video"],
      ["audio-speech"],
      ["audio-transcriptions"],
      ["audio"],
      ["chat", "images"],
      ["fim"],
      ["totally-unknown-endpoint"],
    ];
    for (const endpoints of endpointSets) {
      const { type } = classifyModelSupportedEndpoints(endpoints);
      assert.notEqual(
        type,
        "chat" as never,
        `type must never be "chat" for [${endpoints.join(", ")}] — the catalog vision branch relies on !modelType covering chat-type models`
      );
    }
  });

  test("custom chat-type models keep their vision fields after the TS2367 narrowing", async () => {
    const { classifyModelSupportedEndpoints } =
      await import("../../../src/shared/constants/modelSupportedEndpoints.ts");
    const helper = getCustomVisionCapabilityFields as Helper;
    // A user-registered custom model with no specialty endpoints classifies as
    // plain chat (modelType === undefined) and checked "vision-capable".
    const classification = classifyModelSupportedEndpoints(["chat"]);
    const modelType = classification.type; // undefined by the invariant above
    const fields = helper({ supportsVision: true }, "my-vision-llm");
    assert.ok(fields, "supportsVision:true custom model must surface vision fields");
    // The exact production expression after the narrowing:
    const visionFields = !modelType ? fields : null;
    assert.ok(visionFields, "chat-type (modelType=undefined) keeps vision fields");
    assert.equal(visionFields?.capabilities.vision, true);
  });
});

describe("vision-detection-consistency", () => {
  /**
   * #4072 — one shared vision-detection source.
   *
   * Three code paths kept independent vision-model lists and drifted apart, giving
   * the same model id up to three different verdicts:
   *   - `src/lib/modelCapabilities.ts` (`modelIdLikelyVision`) — routing fallback (#4071)
   *   - `src/app/api/v1/models/catalog.ts` (`isVisionModelId`) — /v1/models listing
   *   - `open-sse/services/compression/lite.ts` (`replaceImageUrls`) — lite image strip
   *
   * The two concrete bugs:
   *   - lite stripped images for real vision models it didn't know (pixtral, llava,
   *     qwen-vl, glm-4v, kimi-vl, mistral-medium-3) → blinded them;
   *   - catalog flagged text models as vision (`gemma`, bare `kimi` like `kimi-k2`).
   *
   * After unification all three delegate to `@/shared/constants/visionModels`.
   */
  const catalogIsVisionModelId = v1ModelsCatalog.isVisionModelId;

  const VISION = [
    "mistral/pixtral-12b-latest",
    "llava-1.5-7b",
    "qwen-vl-max",
    "gpt-4o",
    "claude-fable-5",
    "glm-4v",
    "kimi-vl-a3b",
    "mistral-medium-3",
  ];
  const NOT_VISION = ["ministral-14b-latest", "mistral-large-latest", "gemma-2-9b", "kimi-k2"];

  function imageBody() {
    return {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
        },
      ],
    };
  }

  // `replaceImageUrls` strips the image (applied=true) only when the model is NOT a
  // vision model. So `applied === !isVision`.
  function liteStripsImage(modelId: string): boolean {
    return replaceImageUrls(imageBody(), modelId).applied;
  }

  describe("#4072 vision detection is consistent across all three sources", () => {
    for (const id of VISION) {
      it(`treats ${id} as vision everywhere`, () => {
        assert.equal(isVisionModelId(id), true, `shared isVisionModelId(${id})`);
        assert.equal(catalogIsVisionModelId(id), true, `catalog isVisionModelId(${id})`);
        assert.equal(modelIdLikelyVision(id), true, `modelCapabilities modelIdLikelyVision(${id})`);
        assert.equal(liteStripsImage(id), false, `lite must KEEP the image for ${id}`);
      });
    }

    for (const id of NOT_VISION) {
      it(`treats ${id} as non-vision everywhere`, () => {
        assert.equal(isVisionModelId(id), false, `shared isVisionModelId(${id})`);
        assert.equal(catalogIsVisionModelId(id), false, `catalog isVisionModelId(${id})`);
        assert.equal(
          modelIdLikelyVision(id),
          false,
          `modelCapabilities modelIdLikelyVision(${id})`
        );
        assert.equal(liteStripsImage(id), true, `lite must STRIP the image for ${id}`);
      });
    }

    it("preserves the MiniMax M3 #3328 carve-out and Gemini 3 multimodal", () => {
      for (const id of ["minimax-m3", "minimax-m3-free", "oc/minimax-m3-free", "gemini-3-pro"]) {
        assert.equal(isVisionModelId(id), true, `${id} should be vision`);
        assert.equal(liteStripsImage(id), false, `lite must keep the image for ${id}`);
      }
    });
  });
});

describe("catalog-helpers-extraction", () => {
  /**
   * Characterization tests for the catalog helper extraction (BLOCO E2 of the
   * god-files campaign). The pure, dependency-free helpers and the request/vision/
   * provider-map helpers were lifted out of `src/app/api/v1/models/catalog.ts`
   * verbatim into cohesive leaf modules so the catalog host shrinks toward the
   * file-size cap. These tests pin the behavior of each extracted helper AND guard
   * the host module's preserved public API (re-exports relied on by other tests).
   */
  const {
    isPositiveFiniteNumber,
    parseJsonStringArray,
    intersectStringArrays,
    minKnownNumber,
    maybeOmitCatalogModelName,
    getThinkingCapabilityFields,
    getConnectionScopedEffortTiers,
  } = catalogHelpers;
  const {
    qualifyOpenRouterModelId,
    normalizeOpenRouterModalities,
    getOpenRouterModelType,
    isZeroPrice,
    isOpenRouterFreeModel,
    getOpenRouterDisplayName,
  } = catalogOpenrouter;
  const { getVisionCapabilityFields, getCustomVisionCapabilityFields } = catalogVision;
  const { FALLBACK_ALIAS_TO_PROVIDER, buildAliasMaps } = catalogProviderMaps;

  test("catalogHelpers: isPositiveFiniteNumber", () => {
    assert.equal(isPositiveFiniteNumber(1), true);
    assert.equal(isPositiveFiniteNumber(0), false);
    assert.equal(isPositiveFiniteNumber(-1), false);
    assert.equal(isPositiveFiniteNumber(Number.NaN), false);
    assert.equal(isPositiveFiniteNumber(Infinity), false);
    assert.equal(isPositiveFiniteNumber("5"), false);
    assert.equal(isPositiveFiniteNumber(undefined), false);
  });

  test("catalogHelpers: parseJsonStringArray keeps only non-empty strings", () => {
    assert.deepEqual(parseJsonStringArray('["a","b"]'), ["a", "b"]);
    assert.deepEqual(parseJsonStringArray('["a", 1, "", "c"]'), ["a", "c"]);
    assert.deepEqual(parseJsonStringArray("not json"), []);
    assert.deepEqual(parseJsonStringArray(""), []);
    assert.deepEqual(parseJsonStringArray('{"x":1}'), []);
    assert.deepEqual(parseJsonStringArray(null), []);
  });

  test("catalogHelpers: intersectStringArrays (dedup + common)", () => {
    assert.deepEqual(
      intersectStringArrays([
        ["a", "b", "c"],
        ["b", "c", "d"],
      ]),
      ["b", "c"]
    );
    assert.deepEqual(
      intersectStringArrays([
        ["a", "a", "b"],
        ["a", "b"],
      ]),
      ["a", "b"]
    );
    assert.deepEqual(intersectStringArrays([]), []);
    assert.deepEqual(intersectStringArrays([["a"], []]), []);
  });

  test("catalogHelpers: Kiro GPT-5.6 models expose the native Max tier", () => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      assert.deepEqual(getThinkingCapabilityFields("kr", model, true), {
        thinking: true,
        supportsThinking: true,
        effort_tiers: ["none", "low", "medium", "high", "xhigh", "max"],
      });
    }
  });

  test("catalogHelpers: connection-scoped combo efforts honor dynamic, pinned, and allowlisted scopes", () => {
    const modelsByConnection = {
      first: [{ id: "grok-4.6", supportedThinkingEfforts: ["low", "medium", "high"] }],
      second: [{ id: "grok-4.6", supportedThinkingEfforts: ["medium", "high"] }],
      unknown: [{ id: "other-model", supportedThinkingEfforts: ["low"] }],
    };

    assert.deepEqual(
      getConnectionScopedEffortTiers("grok-4.6", {}, ["first", "second"], modelsByConnection),
      ["medium", "high"]
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers(
        "grok-4.6",
        { connectionId: "first" },
        ["first", "second"],
        modelsByConnection
      ),
      ["low", "medium", "high"]
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers(
        "grok-4.6",
        { allowedConnectionIds: ["second"] },
        ["first", "second"],
        modelsByConnection
      ),
      ["medium", "high"]
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers("grok-4.6", {}, undefined, modelsByConnection),
      [],
      "a dynamic target fails closed when any catalog-backed connection lacks the model"
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers("grok-4.6", {}, ["first", "unknown"], modelsByConnection),
      []
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers("grok-4.6", {}, ["first", "no-tiers"], {
        ...modelsByConnection,
        "no-tiers": [{ id: "grok-4.6" }],
      }),
      []
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers("grok-4.6", {}, ["unknown"], modelsByConnection),
      []
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers("missing-model", {}, undefined, {
        nodeCatalog: [{ id: "other-model" }],
      }),
      []
    );
    assert.equal(getConnectionScopedEffortTiers("grok-4.6", {}, ["first"], {}), undefined);
    assert.deepEqual(
      getConnectionScopedEffortTiers("grok-4.6", { connectionId: "stale" }, ["first"], {}),
      []
    );
    assert.deepEqual(
      getConnectionScopedEffortTiers(
        "grok-4.6",
        { allowedConnectionIds: ["stale"] },
        ["first"],
        {}
      ),
      []
    );
    assert.deepEqual(getConnectionScopedEffortTiers("grok-4.6", {}, [], {}), []);
  });

  test("catalogHelpers: minKnownNumber ignores non-positive/unknown", () => {
    assert.equal(minKnownNumber([3, 1, 2]), 1);
    assert.equal(minKnownNumber([undefined, 0, -5, 7]), 7);
    assert.equal(minKnownNumber([undefined, undefined]), undefined);
    assert.equal(minKnownNumber([]), undefined);
  });

  test("catalogHelpers: maybeOmitCatalogModelName drops name only when excluding", () => {
    const model = { id: "x", name: "X" };
    assert.deepEqual(maybeOmitCatalogModelName(model, true), { id: "x", name: "X" });
    assert.deepEqual(maybeOmitCatalogModelName(model, false), { id: "x" });
    // No `name` key -> returned unchanged regardless of flag.
    assert.deepEqual(maybeOmitCatalogModelName({ id: "y" }, false), { id: "y" });
  });

  test("catalogOpenrouter: qualify + modality normalization + type", () => {
    assert.equal(qualifyOpenRouterModelId("foo/bar"), "openrouter/foo/bar");
    assert.equal(qualifyOpenRouterModelId("openrouter/foo"), "openrouter/foo");
    assert.deepEqual(normalizeOpenRouterModalities(["text", 1, "", "image"]), ["text", "image"]);
    assert.deepEqual(normalizeOpenRouterModalities("nope"), []);
    assert.equal(getOpenRouterModelType(["text"], ["image"]), "image");
    assert.equal(getOpenRouterModelType(["text"], ["audio"]), "audio");
    assert.equal(getOpenRouterModelType(["text"], ["embedding"]), "embedding");
    assert.equal(getOpenRouterModelType(["text"], ["text"]), "chat");
  });

  test("catalogOpenrouter: free-model detection + display name", () => {
    assert.equal(isZeroPrice(0), true);
    assert.equal(isZeroPrice("0"), true);
    assert.equal(isZeroPrice("0.5"), false);
    assert.equal(isZeroPrice("x"), false);
    assert.equal(isOpenRouterFreeModel({ id: "z/model:free" }), true);
    assert.equal(
      isOpenRouterFreeModel({ id: "z/model", pricing: { prompt: "0", completion: "0" } }),
      true
    );
    assert.equal(
      isOpenRouterFreeModel({ id: "z/model", pricing: { prompt: "0.1", completion: "0" } }),
      false
    );
    assert.equal(getOpenRouterDisplayName({ id: "z/m", name: "Some Model" }), "Some Model");
    assert.equal(
      getOpenRouterDisplayName({ id: "z/m:free", name: "Free Model" }),
      "Free Model (Grátis)"
    );
    // Already labelled "grátis" is not double-tagged.
    assert.equal(
      getOpenRouterDisplayName({ id: "z/m:free", name: "Modelo Grátis" }),
      "Modelo Grátis"
    );
  });

  test("catalogVision: re-exports isVisionModelId and derives capability fields", () => {
    assert.equal(typeof catalogVision.isVisionModelId, "function");
    // id-based heuristic
    const visionFields = getVisionCapabilityFields("gpt-4o");
    assert.ok(visionFields, "gpt-4o must be detected as vision-capable");
    const typedVisionFields: {
      capabilities: { vision: true };
      input_modalities: string[];
      output_modalities: string[];
    } | null = visionFields;
    assert.equal(typedVisionFields?.capabilities.vision, true);
    assert.equal(visionFields?.capabilities.vision, true);
    assert.equal(getVisionCapabilityFields("kimi-k2"), null);
  });

  test("catalogVision: getCustomVisionCapabilityFields honours explicit flag", () => {
    // explicit true wins
    assert.equal(
      getCustomVisionCapabilityFields({ supportsVision: true }, "x")?.capabilities.vision,
      true
    );
    // explicit false wins even for a vision-looking id
    assert.equal(getCustomVisionCapabilityFields({ supportsVision: false }, "gpt-4o"), null);
    // no flag -> falls back to id heuristic
    assert.equal(getCustomVisionCapabilityFields(null, "gpt-4o")?.capabilities.vision, true);
    assert.equal(getCustomVisionCapabilityFields(null, "kimi-k2"), null);
  });

  test("catalogProviderMaps: buildAliasMaps seeds the fallback aliases", () => {
    const { aliasToProviderId, providerIdToAlias } = buildAliasMaps();
    assert.equal(typeof aliasToProviderId, "object");
    assert.equal(typeof providerIdToAlias, "object");
    // Fallback entries are always present even if upstream maps loaded partially.
    for (const [alias, providerId] of Object.entries(FALLBACK_ALIAS_TO_PROVIDER)) {
      assert.equal(aliasToProviderId[alias], providerId, `alias ${alias} -> ${providerId}`);
    }
    assert.equal(aliasToProviderId["cx"], "codex");
    assert.equal(aliasToProviderId["kr"], "kiro");
  });

  test("catalogRequest: isCodexModelCatalogClient detects codex originator/user-agent", () => {
    const byOriginator = new Request("https://x/v1/models", {
      headers: { originator: "codex_cli_rs" },
    });
    assert.equal(isCodexModelCatalogClient(byOriginator), true);
    const byUserAgent = new Request("https://x/v1/models", {
      headers: { "user-agent": "codex_exec/0.137" },
    });
    assert.equal(isCodexModelCatalogClient(byUserAgent), true);
    const other = new Request("https://x/v1/models", {
      headers: { "user-agent": "curl/8.0" },
    });
    assert.equal(isCodexModelCatalogClient(other), false);
  });

  test("host catalog.ts preserves its public API after the extraction", async () => {
    const host = v1ModelsCatalog as Record<string, unknown>;
    assert.equal(
      typeof host.getUnifiedModelsResponse,
      "function",
      "getUnifiedModelsResponse export"
    );
    assert.equal(
      typeof host.getCustomVisionCapabilityFields,
      "function",
      "getCustomVisionCapabilityFields re-export (llm-selector-custom-vision-models describe in models-catalog-capabilities.test.ts)"
    );
    assert.equal(
      typeof host.isVisionModelId,
      "function",
      "isVisionModelId re-export (vision-detection-consistency describe in models-catalog-capabilities.test.ts)"
    );
  });
});

describe("openrouter-vision-sync-4264", () => {
  // #4264: When a provider key is imported and its models are synced, the synced
  // model records dropped the vision capability — OpenRouter (and other catalogs)
  // declare image input via `architecture.input_modalities` / `architecture.modality`,
  // but `SyncedAvailableModel` never captured it, and the `/v1/models` catalog only
  // derived vision from the OpenRouter live block, which is SKIPPED once a provider
  // has synced models. So vision-capable models showed up as non-vision after import.

  beforeEach(resetAll);

  test("#4264 normalizeDiscoveredModels captures vision from OpenRouter architecture", () => {
    const out = modelDiscovery.normalizeDiscoveredModels([
      {
        id: "nex-agi/nex-n2-pro:free",
        name: "Nex N2 Pro (free)",
        architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
      },
      {
        // string-form modality only (no input_modalities array)
        id: "modality/string-only",
        name: "Str modality",
        architecture: { modality: "text+image->text" },
      },
      {
        id: "some/text-only",
        name: "Text Only",
        architecture: { modality: "text->text", input_modalities: ["text"] },
      },
      {
        // top-level input_modalities (no architecture wrapper)
        id: "toplevel/vision",
        name: "Top-level modalities",
        input_modalities: ["text", "image"],
      },
    ]);
    const byId = Object.fromEntries(out.map((m: any) => [m.id, m]));

    assert.equal(byId["nex-agi/nex-n2-pro:free"].supportsVision, true);
    assert.equal(byId["modality/string-only"].supportsVision, true);
    assert.equal(byId["toplevel/vision"].supportsVision, true);
    assert.equal(byId["some/text-only"].supportsVision, undefined);
  });

  test("#4264 synced OpenRouter vision model surfaces capabilities.vision in /v1/models", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: "openrouter-test",
      apiKey: "sk-or-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });

    // Simulate "import models": persist the raw OpenRouter /models entries (with
    // architecture) through the real discovery path. Having synced models makes the
    // catalog use the synced path (the OpenRouter live-enrichment block is skipped),
    // which is exactly the path that dropped vision before this fix.
    await modelDiscovery.persistDiscoveredModels("openrouter", connection.id, [
      {
        id: "nex-agi/nex-n2-pro:free",
        name: "Nex AGI: Nex-N2-Pro (free)",
        architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
        context_length: 262144,
      },
      {
        id: "some/text-only-model",
        name: "Text Only Model",
        architecture: { modality: "text->text", input_modalities: ["text"] },
        context_length: 32768,
      },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;

    const visionModel = body.data.find((m: any) =>
      String(m.id).endsWith("nex-agi/nex-n2-pro:free")
    );
    assert.ok(visionModel, `expected the synced vision model in the catalog`);
    // RED before the fix: synced models carried no capabilities at all.
    assert.equal(visionModel.capabilities?.vision, true);

    const textModel = body.data.find((m: any) => String(m.id).endsWith("some/text-only-model"));
    assert.ok(textModel, `expected the synced text-only model in the catalog`);
    assert.ok(
      !textModel.capabilities || textModel.capabilities.vision !== true,
      `text-only model must not be marked vision-capable`
    );
  });
});

describe("cc-compatible-model-catalog", () => {
  beforeEach(resetAll);

  test("v1 models exposes CC-compatible fallback models under the provider node prefix", async () => {
    await providersDb.createProviderNode({
      id: "anthropic-compatible-cc-cm",
      type: "anthropic-compatible",
      name: "Claude Max",
      prefix: "cm",
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/messages?beta=true",
      modelsPath: "/v1/models",
    });

    await providersDb.createProviderConnection({
      provider: "anthropic-compatible-cc-cm",
      authType: "apikey",
      name: "cm-main",
      apiKey: "sk-test",
      isActive: true,
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/messages?beta=true",
        modelsPath: "/v1/models",
      },
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { method: "GET" })
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    const ids = new Set(body.data.map((item) => item.id));

    assert.ok(ids.has("cm/claude-opus-4-7"));
    assert.ok(ids.has("cm/claude-opus-4-6"));
    assert.ok(ids.has("cm/claude-sonnet-4-6"));
    assert.equal(
      [...ids].some((id) => (id as any).startsWith("anthropic-compatible-cc-cm/")),
      false
    );
  });
});

describe("openference-sync-e2e-15762", () => {
  const UPSTREAM = {
    object: "list",
    data: [
      {
        id: "GLM-5.3",
        object: "model",
        capabilities: { tool_calling: true, vision: false, attachment: false },
        reasoning: {
          supported: true,
          control: "effort",
          supported_efforts: ["max", "high", "low"],
        },
      },
    ],
  };

  beforeEach(resetAll);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const [provider, authType] of [
    ["openference", "oauth"],
    ["openference-api", "apikey"],
  ] as const) {
    test(`${provider}: sync-models then /v1/models exposes effort_tiers`, async () => {
      v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
      const conn = await providersDb.createProviderConnection({
        provider,
        authType,
        name: `${provider}-e2e`,
        ...(authType === "oauth" ? { accessToken: "jwt" } : { apiKey: "sk-x" }),
        isActive: true,
        testStatus: "active",
        providerSpecificData: { autoFetchModels: true },
      });
      const calls: string[] = [];
      globalThis.fetch = async (url: unknown) => {
        const u = String(url);
        calls.push(u);
        if (u.includes("api.openference.com/v1/models")) return Response.json(UPSTREAM);
        if (u.includes("__readiness_probe__")) return new Response("", { status: 404 });
        throw new Error("force in-process fallback: " + u);
      };
      const res = await syncModelsRoute.POST(
        new Request(`http://127.0.0.1/api/providers/${conn.id}/sync-models`, {
          method: "POST",
          headers: buildModelSyncInternalHeaders(),
        }),
        { params: Promise.resolve({ id: conn.id }) }
      );
      assert.equal(res.status, 200);
      globalThis.fetch = originalFetch;
      const response = await v1ModelsCatalog.getUnifiedModelsResponse(
        new Request("http://localhost/api/v1/models")
      );
      const body = (await response.json()) as {
        data: Array<{ id: string; capabilities?: { effort_tiers?: string[] } }>;
      };
      const glm = body.data.filter((m) => m.id.endsWith("/GLM-5.3"));
      assert.ok(glm.length > 0);
      assert.deepEqual(glm[0].capabilities?.effort_tiers, ["max", "high", "low"]);
    });
  }
});

describe("sync-reasoning-supported-efforts-7694", () => {
  /**
   * #7694 — capture upstream `reasoning.supported_efforts` at sync, surface it as
   * `capabilities.effort_tiers` in the catalog, and support `<prefix>/<model>-{effort}`
   * request-time alias resolution.
   *
   * Mirrors the #6879 per-model reasoning-effort precedent
   * (open-sse/services/defaultReasoningEffort.ts): captures/exposes what the provider
   * already declared and threads it through the EXISTING `supportedThinkingEfforts`
   * plumbing (`SyncedAvailableModel`, `src/sse/services/model.ts` `RuntimeModelMeta`) —
   * no parallel storage mechanism.
   */
  const { normalizeDiscoveredModels, detectSupportedThinkingEfforts } = modelDiscovery;

  beforeEach(resetAll);

  // ---------------------------------------------------------------------------
  // Step 1+2: sync-time capture of the nested `reasoning.supported_efforts` shape,
  // normalized onto the canonical vocabulary. Hard Rule #7 — Zod-validated.
  // ---------------------------------------------------------------------------

  test("normalizeDiscoveredModels: captures nested reasoning.supported_efforts (no flat field) and preserves canonical 'max'", () => {
    const [model] = normalizeDiscoveredModels([
      {
        id: "some/model-7694",
        reasoning: { supported_efforts: ["low", "medium", "max"] },
      },
    ]);
    assert.deepEqual(model.supportedThinkingEfforts, ["low", "medium", "max"]);
  });

  test("normalizeDiscoveredModels: pre-existing flat supportedThinkingEfforts field wins verbatim over nested (regression)", () => {
    const [model] = normalizeDiscoveredModels([
      {
        id: "some/model-flat",
        supportedThinkingEfforts: ["low", "max"], // byte-identical pass-through, no normalization
        reasoning: { supported_efforts: ["high"] }, // must be ignored — flat field wins
      },
    ]);
    assert.deepEqual(model.supportedThinkingEfforts, ["low", "max"]);
  });

  test("normalizeDiscoveredModels: an unrecognized provider-native tier passes through unchanged (e.g. codex-style 'ultra')", () => {
    const [model] = normalizeDiscoveredModels([
      { id: "some/model-ultra", reasoning: { supported_efforts: ["ultra"] } },
    ]);
    assert.deepEqual(model.supportedThinkingEfforts, ["ultra"]);
  });

  test("normalizeDiscoveredModels: graceful degradation — reasoning:{} (no supported_efforts key) produces no supportedThinkingEfforts field, does not throw", () => {
    const [model] = normalizeDiscoveredModels([
      { id: "some/model-empty-reasoning", reasoning: {} },
    ]);
    assert.equal("supportedThinkingEfforts" in model, false);
  });

  test("normalizeDiscoveredModels: graceful degradation — reasoning entirely absent produces no supportedThinkingEfforts field, does not throw", () => {
    const [model] = normalizeDiscoveredModels([{ id: "some/model-no-reasoning" }]);
    assert.equal("supportedThinkingEfforts" in model, false);
  });

  test("detectSupportedThinkingEfforts: Hard Rule #7 — malformed upstream payload (supported_efforts is a string, not an array) is rejected by Zod and degrades to undefined without throwing", () => {
    assert.doesNotThrow(() => {
      const result = detectSupportedThinkingEfforts({
        reasoning: { supported_efforts: "high" as unknown },
      });
      assert.equal(result, undefined);
    });
  });

  test("detectSupportedThinkingEfforts: malformed upstream payload (reasoning is a string, not an object) is rejected by Zod and degrades to undefined without throwing", () => {
    assert.doesNotThrow(() => {
      const result = detectSupportedThinkingEfforts({ reasoning: "not-an-object" as unknown });
      assert.equal(result, undefined);
    });
  });

  // ---------------------------------------------------------------------------
  // Step 3: catalog surfaces capabilities.effort_tiers for synced models.
  // ---------------------------------------------------------------------------

  test("#7694 catalog: GET /api/v1/models surfaces capabilities.effort_tiers for a synced model with nested reasoning.supported_efforts", async () => {
    const connection = await seedProviderConnection("huggingface");

    await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", connection.id, [
      {
        id: "some-org/reasoning-model-7694",
        name: "Reasoning Model 7694",
        supportedThinkingEfforts: ["low", "medium", "high"],
      },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      data: Array<{ id: string; capabilities?: { effort_tiers?: string[] } }>;
    };
    const entry = body.data.find((m) => m.id.endsWith("some-org/reasoning-model-7694"));
    assert.ok(entry, "synced reasoning model must appear in the catalog");
    assert.deepEqual(entry!.capabilities?.effort_tiers, ["low", "medium", "high"]);
  });

  test("#7694 catalog: a synced model with no supportedThinkingEfforts gets no capabilities.effort_tiers (graceful degradation)", async () => {
    const connection = await seedProviderConnection("huggingface");

    await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", connection.id, [
      { id: "some-org/no-reasoning-model-7694", name: "No Reasoning Model 7694" },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; capabilities?: { effort_tiers?: string[] } }>;
    };
    const entry = body.data.find((m) => m.id.endsWith("some-org/no-reasoning-model-7694"));
    assert.ok(entry);
    assert.equal(entry!.capabilities?.effort_tiers, undefined);
  });

  // ---------------------------------------------------------------------------
  // Step 4: catalog generates `-{effort}` alias ids per declared tier.
  // ---------------------------------------------------------------------------

  test("#7694 catalog: GET /api/v1/models advertises a <model>-<tier> alias id per declared effort tier", async () => {
    const connection = await seedProviderConnection("huggingface");

    await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", connection.id, [
      {
        id: "some-org/reasoning-model-alias-7694",
        name: "Reasoning Model Alias 7694",
        supportedThinkingEfforts: ["low", "high"],
      },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const baseEntry = body.data.find((m) => m.id.endsWith("some-org/reasoning-model-alias-7694"));
    assert.ok(baseEntry, "base model must appear in the catalog");

    const highVariant = body.data.find((m) => m.id === `${baseEntry!.id}-high`);
    const lowVariant = body.data.find((m) => m.id === `${baseEntry!.id}-low`);
    assert.ok(highVariant, `expected a "${baseEntry!.id}-high" alias entry`);
    assert.ok(lowVariant, `expected a "${baseEntry!.id}-low" alias entry`);
  });

  // ---------------------------------------------------------------------------
  // shouldExposeSyncedEffortVariants / appendSyncedEffortVariants — pure unit tests.
  // ---------------------------------------------------------------------------

  test("shouldExposeSyncedEffortVariants: exposes declared Codex tiers and skips Kimi native suffixes", () => {
    assert.equal(
      shouldExposeSyncedEffortVariants({
        id: "codex/gpt-5.5",
        owned_by: "codex",
        capabilities: { effort_tiers: ["low", "high"] },
      }),
      true
    );
    assert.equal(
      shouldExposeSyncedEffortVariants({
        id: "kimi/kimi-k3",
        owned_by: "kimi-coding",
        capabilities: { effort_tiers: ["low", "high"] },
      }),
      false
    );
    assert.equal(
      shouldExposeSyncedEffortVariants({
        id: "kimi/kimi-k3",
        owned_by: "kimi-coding-apikey",
        capabilities: { effort_tiers: ["low", "high"] },
      }),
      false
    );
    assert.ok(!SYNCED_EFFORT_SKIP_PROVIDERS.has("codex"));
  });

  test("shouldExposeSyncedEffortVariants: skips a model id that already ends in a token matching a canonical effort value (collision guard)", () => {
    assert.equal(
      shouldExposeSyncedEffortVariants({
        id: "someprovider/my-model-high", // legitimately ends in "-high"
        owned_by: "someprovider",
        capabilities: { effort_tiers: ["low", "high"] },
      }),
      false
    );
  });

  test("shouldExposeSyncedEffortVariants: exposes a plain synced model carrying effort_tiers", () => {
    assert.equal(
      shouldExposeSyncedEffortVariants({
        id: "someprovider/my-model",
        owned_by: "someprovider",
        capabilities: { effort_tiers: ["low", "high"] },
      }),
      true
    );
  });

  test("appendSyncedEffortVariants: generates one variant per tier, inheriting the base model's fields", () => {
    const base = {
      id: "someprovider/my-model",
      owned_by: "someprovider",
      root: "my-model",
      capabilities: { effort_tiers: ["low", "high"] },
      hidden: false,
    };
    const result = appendSyncedEffortVariants([base]);
    assert.equal(result.length, 3);
    const high = result.find((m) => m.id === "someprovider/my-model-high");
    assert.ok(high);
    assert.equal(high!.root, "my-model-high");
    assert.equal(high!.hidden, false); // inherited, not re-derived
  });

  // ---------------------------------------------------------------------------
  // Step 5: request-time `<prefix>/<model>-{effort}` alias resolution.
  // ---------------------------------------------------------------------------

  test("splitSyncedEffortSuffix: strips a known trailing effort token for a candidate's own declared tiers", () => {
    const result = splitSyncedEffortSuffix("my-model-high", ["low", "medium", "high"]);
    assert.deepEqual(result, { baseModel: "my-model", effort: "high" });
  });

  test("splitSyncedEffortSuffix: leaves an unsupported effort token untouched (not a known tier for this model)", () => {
    const result = splitSyncedEffortSuffix("my-model-ultrahigh", ["low", "medium", "high"]);
    assert.deepEqual(result, { baseModel: "my-model-ultrahigh", effort: null });
  });

  test("splitSyncedEffortSuffix: no known efforts list -> untouched", () => {
    const result = splitSyncedEffortSuffix("my-model-high", undefined);
    assert.deepEqual(result, { baseModel: "my-model-high", effort: null });
  });

  const EFFORT_CONN_ID = "openai-compatible-chat-7694-effort-probe";
  const EFFORT_PREFIX = "pfx7694";
  const EFFORT_BASE_MODEL = "reasoning-model-7694";

  async function seedEffortSuffixNode() {
    await providersDb.createProviderNode({
      id: EFFORT_CONN_ID,
      type: "openai-compatible",
      name: "7694 effort-suffix probe",
      prefix: EFFORT_PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    // connection_model_sync has a foreign key to provider_connections: the synced catalog
    // needs a real connection row (the node itself is not one).
    const connection = await seedProviderConnection(EFFORT_CONN_ID);
    await modelsDb.replaceSyncedAvailableModelsForConnection(EFFORT_CONN_ID, connection.id, [
      {
        id: EFFORT_BASE_MODEL,
        name: "Reasoning Model 7694",
        supportedThinkingEfforts: ["low", "medium", "high"],
      },
    ]);
  }

  test("#7694 RED->GREEN: <prefix>/<model>-high resolves to the base model id and derives 'high' as the effort", async () => {
    await seedEffortSuffixNode();

    const info = (await getModelInfo(`${EFFORT_PREFIX}/${EFFORT_BASE_MODEL}-high`)) as {
      provider?: string;
      model?: string;
      resolvedThinkingEffort?: string;
    };
    assert.equal(info.provider, EFFORT_CONN_ID);
    assert.equal(
      info.model,
      EFFORT_BASE_MODEL,
      "suffix must be stripped back to the base model id"
    );
    assert.equal(info.resolvedThinkingEffort, "high");
  });

  test("#7694: an unsupported effort suffix is NOT stripped (treated as a literal/unknown model id — collision-risk guard holds)", async () => {
    await seedEffortSuffixNode();

    const info = (await getModelInfo(`${EFFORT_PREFIX}/${EFFORT_BASE_MODEL}-ultrahigh`)) as {
      provider?: string;
      model?: string;
      resolvedThinkingEffort?: string;
    };
    assert.equal(info.provider, EFFORT_CONN_ID);
    assert.equal(
      info.model,
      `${EFFORT_BASE_MODEL}-ultrahigh`,
      "unknown suffix must pass through literally, not be silently stripped"
    );
    assert.equal(info.resolvedThinkingEffort, undefined);
  });

  test("#7694: the base model id (no suffix) still resolves normally and carries its full tier list", async () => {
    await seedEffortSuffixNode();

    const info = (await getModelInfo(`${EFFORT_PREFIX}/${EFFORT_BASE_MODEL}`)) as {
      provider?: string;
      model?: string;
      supportedThinkingEfforts?: string[];
      resolvedThinkingEffort?: string;
    };
    assert.equal(info.provider, EFFORT_CONN_ID);
    assert.equal(info.model, EFFORT_BASE_MODEL);
    assert.deepEqual(info.supportedThinkingEfforts, ["low", "medium", "high"]);
    assert.equal(info.resolvedThinkingEffort, undefined);
  });

  // ---------------------------------------------------------------------------
  // applyDefaultReasoningEffort: the suffix-resolved effort (#7694) takes priority over
  // the static per-model ModelSpec default (#6879), and an explicit client value still
  // always wins over both.
  // ---------------------------------------------------------------------------

  test("applyDefaultReasoningEffort: a suffix-resolved effort (#7694) is injected as reasoning_effort", () => {
    const body = { model: "some-model", messages: [] };
    const result = applyDefaultReasoningEffort(body, "some-model", "high");
    assert.equal(result.reasoning_effort, "high");
  });

  test("applyDefaultReasoningEffort: an explicit client reasoning_effort still wins over the suffix-resolved effort", () => {
    const body = { model: "some-model", messages: [], reasoning_effort: "low" };
    const result = applyDefaultReasoningEffort(body, "some-model", "high");
    assert.equal(result.reasoning_effort, "low");
  });

  test("applyDefaultReasoningEffort: no suffix effort and no ModelSpec default -> no injection (regression, same reference)", () => {
    const body = { model: "some-model-untouched", messages: [] };
    const result = applyDefaultReasoningEffort(body, "some-model-untouched", null);
    assert.equal(result, body);
  });
});

describe("deepseek-thinking-efforts", () => {
  beforeEach(resetAll);

  test("DeepSeek registries declare none/low/high/max on both V4 models", () => {
    const expectedEfforts = ["none", "low", "high", "max"];
    for (const providerId of ["deepseek", "opencode-go"]) {
      const models = new Map(
        (REGISTRY[providerId]?.models || []).map((model) => [model.id, model])
      );
      for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
        assert.deepEqual(models.get(modelId)?.supportedThinkingEfforts, expectedEfforts);
        for (const effort of expectedEfforts) {
          assert.equal(
            models.has(`${modelId}-${effort}`),
            false,
            `${providerId} should derive ${modelId}-${effort} from the base model metadata`
          );
        }
      }
    }
  });

  test("DeepSeek catalog exposes only the declared effort aliases", async () => {
    await providersDb.createProviderConnection({
      provider: "deepseek",
      authType: "apikey",
      name: "deepseek-efforts",
      apiKey: "deepseek-test-key",
      isActive: true,
      testStatus: "active",
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = new Set(body.data.map((model) => model.id));

    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-none")));
    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-low")));
    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-high")));
    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-flash-max")));
    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-none")));
    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-low")));
    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-high")));
    assert.ok([...ids].some((id) => id.endsWith("deepseek-v4-pro-max")));
  });

  test("OpenCode Go catalog derives the declared V4 effort aliases from base models", async () => {
    await providersDb.createProviderConnection({
      provider: "opencode-go",
      authType: "apikey",
      name: "opencode-go-deepseek-efforts",
      apiKey: "opencode-go-test-key",
      isActive: true,
      testStatus: "active",
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; capabilities?: { effort_tiers?: string[] } }>;
    };
    const models = new Map(body.data.map((model) => [model.id, model]));
    const expectedEfforts = ["none", "low", "high", "max"];

    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const baseId = `opencode-go/${modelId}`;
      assert.deepEqual(models.get(baseId)?.capabilities?.effort_tiers, expectedEfforts);
      for (const effort of expectedEfforts) {
        assert.ok(models.has(`${baseId}-${effort}`), `${baseId}-${effort} must be advertised`);
      }
      assert.equal(models.has(`${baseId}-medium`), false);
    }
  });
  test("Crof synced reasoning metadata exposes exactly none/low/medium/high/max aliases", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "crof",
      authType: "apikey",
      name: "crof-live-efforts",
      apiKey: "crof-test-key",
      isActive: true,
      testStatus: "active",
    });
    const modelId = "crof-live-reasoning-model";

    await modelDiscovery.persistDiscoveredModels("crof", connection.id, [
      { id: modelId, name: "Crof Live Reasoning Model", reasoning_effort: true },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const aliases = new Set(
      body.data.map((model) => model.id).filter((id) => id.startsWith(`crof/${modelId}-`))
    );
    assert.deepEqual(
      aliases,
      new Set([
        `crof/${modelId}-none`,
        `crof/${modelId}-low`,
        `crof/${modelId}-medium`,
        `crof/${modelId}-high`,
        `crof/${modelId}-max`,
      ])
    );
  });

  test("Crof static GLM 5.2 effort aliases survive a stale synced cache", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "crof",
      authType: "apikey",
      name: "crof-stale-glm-5-2",
      apiKey: "crof-stale-glm-5-2-key",
      isActive: true,
      testStatus: "active",
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection("crof", connection.id, [
      {
        id: "glm-5.2",
        name: "GLM 5.2",
        supportedEndpoints: ["chat"],
      },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const aliases = new Set(
      body.data.map((model) => model.id).filter((id) => id.startsWith("crof/glm-5.2-"))
    );

    assert.deepEqual(
      aliases,
      new Set([
        "crof/glm-5.2-none",
        "crof/glm-5.2-low",
        "crof/glm-5.2-medium",
        "crof/glm-5.2-high",
        "crof/glm-5.2-max",
      ])
    );
  });

  test("Crof synced effort aliases resolve to the base model at request time", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "crof",
      authType: "apikey",
      name: "crof-runtime-efforts",
      apiKey: "crof-runtime-key",
      isActive: true,
      testStatus: "active",
    });
    const modelId = "crof-runtime-reasoning-model";

    await modelDiscovery.persistDiscoveredModels("crof", connection.id, [
      { id: modelId, reasoning_effort: true },
    ]);

    const info = await getModelInfo(`crof/${modelId}-medium`);
    assert.equal(info.provider, "crof");
    assert.equal(info.model, modelId);
    assert.equal(info.resolvedThinkingEffort, "medium");

    const maxInfo = await getModelInfo(`crof/${modelId}-max`);
    assert.equal(maxInfo.model, modelId);
    assert.equal(maxInfo.resolvedThinkingEffort, "max");
  });

  test("hardcoded DeepSeek effort suffixes resolve through the static registry", async () => {
    const flashLow = await getModelInfo("ds/deepseek-v4-flash-low");
    assert.equal(flashLow.provider, "deepseek");
    assert.equal(flashLow.model, "deepseek-v4-flash");
    assert.equal(flashLow.resolvedThinkingEffort, "low");

    const flashNone = await getModelInfo("deepseek/deepseek-v4-flash-none");
    assert.equal(flashNone.model, "deepseek-v4-flash");
    assert.equal(flashNone.resolvedThinkingEffort, "none");

    const proLow = await getModelInfo("ds/deepseek-v4-pro-low");
    assert.equal(proLow.model, "deepseek-v4-pro");
    assert.equal(proLow.resolvedThinkingEffort, "low");
  });

  test("OpenCode Go V4 suffixes resolve from base-model effort metadata", async () => {
    for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      for (const effort of ["none", "low", "high", "max"]) {
        const info = await getModelInfo(`opencode-go/${modelId}-${effort}`);
        assert.equal(info.provider, "opencode-go");
        assert.equal(info.model, modelId);
        assert.equal(info.resolvedThinkingEffort, effort);
      }
    }
  });

  test("native DeepSeek preserves the documented low effort for Flash and Pro", () => {
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const body = { model, reasoning_effort: "low" };
      assert.equal(
        sanitizeReasoningEffortForProvider(body, "deepseek", model),
        body,
        `${model} must pass low through unchanged`
      );
    }
  });

  test("non-DeepSeek static reasoning models do not advertise unresolvable effort aliases", async () => {
    // cheaperinference declares deepseek-v4-flash/pro with supportsReasoning: true
    // but no supportedThinkingEfforts — the catalog must NOT synthesize
    // cheaperinference/deepseek-v4-flash-{low,high,...} ids for them (#9485 review #1).
    await providersDb.createProviderConnection({
      provider: "cheaperinference",
      authType: "apikey",
      name: "cheaperinference-blast-radius",
      apiKey: "cheaperinference-test-key",
      isActive: true,
      testStatus: "active",
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((model) => model.id);

    // Static base models for cheaperinference should still be present
    assert.ok(
      ids.some((id) => id.endsWith("cheaperinference/deepseek-v4-flash")),
      "cheaperinference/deepseek-v4-flash base entry should still be present"
    );
    // But NO effort-suffixed aliases should be synthesized
    assert.equal(
      ids.some((id) =>
        /cheaperinference\/deepseek-v4-flash-(none|low|medium|high|max|xhigh)$/.test(id)
      ),
      false,
      "cheaperinference static reasoning models must not advertise unresolvable effort aliases"
    );
    assert.equal(
      ids.some((id) =>
        /cheaperinference\/deepseek-v4-pro-(none|low|medium|high|max|xhigh)$/.test(id)
      ),
      false,
      "cheaperinference static reasoning models must not advertise unresolvable effort aliases"
    );
  });

  test("custom model named deepseek-v4-flash-low is not rewritten by registry suffix resolution", async () => {
    // A custom (DB) model literally named deepseek-v4-flash-low on the deepseek
    // provider must not be silently rewritten to deepseek-v4-flash + effort low,
    // which would drop its custom apiFormat/targetFormat metadata (#9485 review #3).
    await modelsDb.addCustomModel(
      "deepseek",
      "deepseek-v4-flash-low",
      "deepseek-v4-flash-low",
      "manual",
      "responses",
      ["chat"],
      "responses"
    );

    const info = await getModelInfo("ds/deepseek-v4-flash-low");
    // The model id should be preserved as the literal custom id, not rewritten
    assert.equal(info.model, "deepseek-v4-flash-low");
    // The custom apiFormat must survive (not dropped by registry rewriting)
    assert.equal(info.apiFormat, "responses");
    // No resolved effort should be injected — this is a distinct custom model
    assert.equal(info.resolvedThinkingEffort, undefined);
  });

  test("none effort resolves and stays explicit through provider sanitation", async () => {
    // The format translator subsequently carries this as reasoning.effort:"none"
    // on DeepSeek's default Responses route, which disables thinking.
    const flashNone = await getModelInfo("ds/deepseek-v4-flash-none");
    assert.equal(flashNone.model, "deepseek-v4-flash");
    assert.equal(flashNone.resolvedThinkingEffort, "none");

    const sanitized = sanitizeReasoningEffortForProvider(
      { model: "deepseek-v4-flash", reasoning_effort: "none" },
      "deepseek",
      "deepseek-v4-flash"
    ) as Record<string, unknown>;
    assert.equal(sanitized.reasoning_effort, "none");
  });

  test("suffixed Flash low remains valid before alias resolution", () => {
    // Preserve low even if a future route sanitizes the raw suffixed id before
    // resolving it to the registered base model.
    const sanitizedSuffixed = sanitizeReasoningEffortForProvider(
      { model: "deepseek-v4-flash-low", reasoning_effort: "low" },
      "deepseek",
      "deepseek-v4-flash-low"
    ) as Record<string, unknown>;
    assert.equal(sanitizedSuffixed.reasoning_effort, "low");
  });
});

describe("effort-tiers-loop-catalog-e2e", () => {
  /**
   * effort_tiers loop — I1 end-to-end proof: a set recorded through the REAL
   * record path (executor-style connection key) surfaces in the REAL catalog
   * response (/api/v1/models), including the learned-only variant entry.
   * Never "fix" this test by injecting the same string on both sides.
   */
  beforeEach(resetAll);
  // The learned caps are process-global: do not let them leak into later describes.
  afterEach(() => {
    __test_resetLearnedReasoningEffortCaps();
  });

  test("learned set flows end-to-end into /v1/models capabilities and variant entries", async () => {
    // Non-namespaced id on purpose: mirrors the real incident model
    // (x-preview-f-free) where sm.id === the executor-visible post-strip id.
    const MODEL_ID = "loop-model-e2e";
    const connection = await seedProviderConnection("huggingface");
    await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", connection.id, [
      {
        id: MODEL_ID,
        name: "Loop Model E2E",
        supportedThinkingEfforts: ["none", "low", "medium", "high"],
      },
    ]);

    // Simulate the real 400 learning path (base.ts calls exactly this, with the
    // executor's CONNECTION id as provider key):
    recordLearnedReasoningEffort("openai-compatible-chat-eaff6869", MODEL_ID, [
      "low",
      "high",
      "max",
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: Array<{ id: string; capabilities?: { effort_tiers?: string[] } }>;
    };

    const baseEntry = body.data.find((m) => m.id.endsWith(MODEL_ID));
    assert.ok(baseEntry, "base entry present");
    assert.deepEqual(baseEntry!.capabilities?.effort_tiers, ["low", "high", "max"]);

    const maxVariant = body.data.find((m) => m.id === `${baseEntry!.id}-max`);
    assert.ok(maxVariant, "learned-only tier synthesized as a variant entry");
  });

  test("excluded provider (glm) never surfaces effort_tiers, learned or synced", async () => {
    const MODEL_ID = "glm-4-flash";
    const connection = await seedProviderConnection("glm");
    await modelsDb.replaceSyncedAvailableModelsForConnection("glm", connection.id, [
      {
        id: MODEL_ID,
        name: "GLM 4 Flash",
        supportedThinkingEfforts: ["none", "low", "medium", "high"],
      },
    ]);
    recordLearnedReasoningEffort("glm-connection-1", MODEL_ID, ["low", "high"]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: Array<{ id: string; capabilities?: { effort_tiers?: string[] } }>;
    };

    const baseEntry = body.data.find((m) => m.id.endsWith(MODEL_ID));
    assert.ok(baseEntry, "base entry present");
    assert.equal(
      baseEntry!.capabilities?.effort_tiers,
      undefined,
      "glm owns its own -{effort} suffix mechanism — the catalog must not also expose effort_tiers"
    );
  });
});

describe("specialty-model-catalog-routes", () => {
  async function seedConnection(provider: string) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: "test-key",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  async function listedIds(
    route: { GET: (request?: Request) => Promise<Response> },
    pathname: string
  ) {
    const response = await route.GET(new Request(`http://localhost${pathname}`));
    const body = (await response.json()) as { data?: Array<{ id: string }> };
    assert.equal(response.status, 200);
    return (body.data || []).map((model) => model.id);
  }

  // These routes all derive from the shared unified catalog (getUnifiedModelsResponse),
  // which #6408 wrapped in a 1.5s TTL response cache keyed only by (prefix, isCodex
  // client, apiKey) — NOT by DB state. Every test in this file hits that same cache key,
  // so without clearing it between test cases a test running within the TTL window of
  // a previous one gets served the previous test's stale catalog instead of a fresh
  // build reflecting this test's own seeded connections (resetAll clears it).
  beforeEach(resetAll);

  test("image catalog GET uses the unified active-credential model list", async () => {
    await seedConnection("codex");

    const ids = await listedIds(imageRoute, "/v1/images/generations");

    // #14976 added the Codex GPT Image models (dedicated Codex Images API route)
    // after the GPT-5.6 hosted-tool ids; see tests/unit/config/image-registry-gpt56.test.ts.
    assert.deepEqual(
      ids.filter((id) => id.startsWith("codex/")),
      [
        "codex/gpt-5.6-sol-image",
        "codex/gpt-5.6-terra-image",
        "codex/gpt-5.6-luna-image",
        "codex/gpt-image-2.5-flare",
        "codex/gpt-image-2.5-sunburst",
        "codex/gpt-image-2",
      ]
    );
    assert.ok(!ids.includes("openai/gpt-image-2"));
  });

  test("specialty catalog GET preserves unified catalog headers", async () => {
    await seedConnection("codex");

    const response = await imageRoute.GET(
      new Request("http://localhost/v1/images/generations", {
        headers: { "x-request-id": "specialty-catalog-test" },
      })
    );
    await response.json();

    assert.equal(response.headers.get("x-request-id"), "specialty-catalog-test");
    assert.ok(response.headers.get("x-model-catalog-version"));
    assert.match(response.headers.get("content-type") || "", /application\/json/);
  });

  test("embedding catalog GET hides providers without active credentials", async () => {
    await seedConnection("cohere");

    const ids = await listedIds(embeddingsRoute, "/v1/embeddings");

    assert.ok(ids.includes("cohere/embed-v4.0"));
    assert.ok(!ids.includes("openai/text-embedding-3-small"));
  });

  test("video catalog GET hides credential-backed providers without credentials", async () => {
    await seedConnection("kie");

    const ids = await listedIds(videoRoute, "/v1/videos/generations");

    assert.ok(ids.includes("kie/veo/veo-3-1"));
    assert.ok(!ids.includes("vertex/veo-3.0-generate-001"));
  });

  test("music catalog GET hides providers without active credentials", async () => {
    await seedConnection("kie");

    const ids = await listedIds(musicRoute, "/v1/music/generations");

    assert.ok(ids.includes("kie/suno-v4.0"));
    assert.ok(!ids.includes("vertex/lyria-002"));
  });
});

describe("specialty-model-hidden-openrouter-9293", () => {
  /**
   * #9293 — specialty model catalog ignores hidden OpenRouter model flags.
   *
   * The specialty model loops (image, rerank, audio, moderation, video, music)
   * in catalog.ts reduce OpenRouter model IDs to only the final path segment
   * via .split("/").pop() before calling getModelIsHidden(), so stored hidden
   * flags with full provider-relative paths (e.g. openrouter+google/chirp-3)
   * are never matched. The embedding loop correctly strips only the provider prefix
   * rather than taking the last segment.
   *
   * This test: seeds an OpenRouter connection, hides two OpenRouter specialty
   * models (audio: google/chirp-3, image: black-forest-labs/flux.2-pro), then
   * verifies the hidden models are excluded from the /v1/models catalog while
   * non-hidden models still appear.
   */
  const { mergeModelCompatOverride, getModelIsHidden } = modelsDb;

  beforeEach(resetAll);

  test("#9293 hidden OpenRouter specialty models are excluded from /v1/models catalog", async () => {
    // Create an active OpenRouter connection
    const connection = await providersDb.createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: "openrouter-test",
      apiKey: "sk-or-test-9293",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    assert.ok(connection?.id, "OpenRouter connection created");

    // Confirm the hidden flag is not set yet
    assert.equal(
      await getModelIsHidden("openrouter", "google/chirp-3"),
      false,
      "chirp-3 is initially visible"
    );
    assert.equal(
      await getModelIsHidden("openrouter", "black-forest-labs/flux.2-pro"),
      false,
      "flux.2-pro is initially visible"
    );

    // Hide two OpenRouter specialty models: one audio, one image
    await mergeModelCompatOverride("openrouter", "google/chirp-3", { isHidden: true });
    await mergeModelCompatOverride("openrouter", "black-forest-labs/flux.2-pro", {
      isHidden: true,
    });

    // Confirm the hidden flags are stored correctly
    assert.equal(
      await getModelIsHidden("openrouter", "google/chirp-3"),
      true,
      "chirp-3 is now hidden"
    );
    assert.equal(
      await getModelIsHidden("openrouter", "black-forest-labs/flux.2-pro"),
      true,
      "flux.2-pro is now hidden"
    );

    // Fetch the full catalog
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string; type?: string }> };
    assert.ok(Array.isArray(body.data), "response has data array");

    // Find audio and image models
    const audioModels = body.data.filter((m) => m.type === "audio");
    const imageModels = body.data.filter((m) => m.type === "image");

    // chirp-3 model ID from the audio registry is openrouter/google/chirp-3
    const hiddenAudio = audioModels.find((m) => String(m.id).endsWith("google/chirp-3"));
    assert.equal(
      hiddenAudio,
      undefined,
      "#9293 RED: hidden audio model openrouter/google/chirp-3 should NOT appear in catalog"
    );

    // flux.2-pro model ID from the image registry is openrouter/black-forest-labs/flux.2-pro
    const hiddenImage = imageModels.find((m) =>
      String(m.id).endsWith("black-forest-labs/flux.2-pro")
    );
    assert.equal(
      hiddenImage,
      undefined,
      "#9293 RED: hidden image model openrouter/black-forest-labs/flux.2-pro should NOT appear in catalog"
    );

    // Verify non-hidden audio models from OpenRouter still appear
    // deepgram/nova-3 is not hidden, so it should be present
    const visibleAudio = audioModels.find((m) => String(m.id).endsWith("deepgram/nova-3"));
    assert.ok(
      visibleAudio,
      "non-hidden audio model deepgram/nova-3 should still appear in catalog"
    );
  });
});

describe("model-token-limit-catalog", () => {
  const TARGET = "openai/gpt-5.6";
  const LIMITS = { context: 372000, input: 353400, output: 128000 };

  beforeEach(resetAll);

  async function getModel(target = TARGET) {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200, "model catalog must be available before projecting limits");
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    return body.data.find((model) => model.id === target);
  }

  test("v1 model catalog projects effective context, input, and output overrides and invalidates on delete", async () => {
    assert.equal(
      await contextOverrides.setModelContextOverride("openai", "gpt-5.6", LIMITS.context),
      true
    );
    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        TARGET,
        "max_input_tokens",
        LIMITS.input
      ),
      true
    );
    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        TARGET,
        "max_output_tokens",
        LIMITS.output
      ),
      true
    );
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "api_key",
      name: "token-limit-catalog",
      apiKey: "sk-test",
    });

    const initial = await getModel();
    assert.ok(initial);
    assert.deepEqual(
      {
        context_length: initial.context_length,
        max_input_tokens: initial.max_input_tokens,
        max_output_tokens: initial.max_output_tokens,
      },
      {
        context_length: LIMITS.context,
        max_input_tokens: LIMITS.input,
        max_output_tokens: LIMITS.output,
      }
    );

    const sentinelOutput = 111111;
    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        TARGET,
        "max_output_tokens",
        sentinelOutput
      ),
      true
    );
    assert.equal((await getModel())?.max_output_tokens, sentinelOutput);
    assert.equal(
      await capabilityOverrides.removeModelCapabilityOverride(TARGET, "max_output_tokens"),
      true
    );
    assert.notEqual((await getModel())?.max_output_tokens, sentinelOutput);
  });

  test("v1 model catalog projects a synced Codex context to both public aliases", async () => {
    const target = "codex/gpt-5.6-sol";
    const connection = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "codex-token-limit-catalog",
      accessToken: "test-access-token",
    });
    assert.equal(typeof connection.id, "string");
    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id as string, [
      {
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        source: "provider",
        supportedEndpoints: ["responses"],
        inputTokenLimit: 272000,
        outputTokenLimit: 128000,
      },
    ]);
    assert.equal(
      await contextOverrides.setModelContextOverride("codex", "gpt-5.6-sol", LIMITS.context),
      true
    );
    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        target,
        "max_input_tokens",
        LIMITS.input
      ),
      true
    );
    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        target,
        "max_output_tokens",
        LIMITS.output
      ),
      true
    );

    for (const publicId of ["cx/gpt-5.6-sol", "codex/gpt-5.6-sol"]) {
      const projected = await getModel(publicId);
      assert.ok(projected, `expected ${publicId} in the public catalog`);
      assert.deepEqual(
        {
          context_length: projected.context_length,
          max_input_tokens: projected.max_input_tokens,
          max_output_tokens: projected.max_output_tokens,
        },
        {
          context_length: LIMITS.context,
          max_input_tokens: LIMITS.input,
          max_output_tokens: LIMITS.output,
        },
        `${publicId} must retain the persisted Codex token-limit overrides`
      );
    }

    const canonical = await getModel("codex/gpt-5.6-sol");
    assert.equal(canonical?.type, undefined, "the canonical chat ID must not be shadowed by image");
    const image = await getModel("codex/gpt-5.6-sol-image");
    assert.equal(image?.type, "image");
    assert.deepEqual(image?.output_modalities, ["image"]);
    assert.ok(Array.isArray(image?.supported_sizes));
    assert.equal(image?.context_length, undefined, "chat overrides must not leak to the image ID");

    assert.equal(await contextOverrides.removeModelContextOverride("codex", "gpt-5.6-sol"), true);
    assert.equal(
      (await getModel("codex/gpt-5.6-sol-image"))?.context_length,
      undefined,
      "the specialty row must not inherit the synced chat context after override removal"
    );
    assert.equal((await getModel("codex/gpt-5.6-sol"))?.context_length, 872000);
    assert.equal((await getModel("cx/gpt-5.6-sol"))?.context_length, 272000);
  });

  test("v1 model catalog projects an exact raw-alias context override", async () => {
    const target = "github/claude-opus-4.8";
    assert.equal(
      await contextOverrides.setModelContextOverride("github", "claude-opus-4.8", 333333),
      true
    );
    await providersDb.createProviderConnection({
      provider: "github",
      authType: "api_key",
      name: "raw-alias-token-limit-catalog",
      apiKey: "ghp-test",
    });

    assert.equal(
      (await getModel(target))?.context_length,
      333333,
      "the catalog entry keeps its raw alias and must project that exact override"
    );
  });

  test("v1 model catalog projects a compatible provider prefix override stored under its node id", async () => {
    const nodeId = "openai-compatible-chat-context-override";
    const prefix = "wawapi-openai";
    const modelId = "grok-4.6";
    const contextWindow = 500000;
    await providersDb.createProviderNode({
      id: nodeId,
      type: "openai-compatible",
      prefix,
      name: "WawAPI (OpenAI)",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
    });
    const connection = await providersDb.createProviderConnection({
      provider: nodeId,
      authType: "api_key",
      name: "compatible-provider-token-limit-catalog",
      apiKey: "sk-test",
    });
    assert.equal(typeof connection.id, "string");
    await modelsDb.replaceSyncedAvailableModelsForConnection(nodeId, connection.id as string, [
      { id: modelId, name: modelId, source: "imported" },
    ]);

    const patch = await overrideRoute.PATCH(
      new Request("http://localhost/api/model-capability-overrides", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: `${prefix}/${modelId}`,
          key: "context_length",
          value: contextWindow,
        }),
      })
    );
    assert.equal(patch.status, 200);
    assert.equal(
      (await contextOverrides.getModelContextOverrideRecord(nodeId, modelId))?.realContext,
      contextWindow,
      "the public prefix target must persist under the internal provider node id"
    );

    assert.equal(
      (await getModel(`${prefix}/${modelId}`))?.context_length,
      contextWindow,
      "the public catalog row must read the override stored under the internal provider node id"
    );
  });

  test("v1 model catalog overlays same-id custom metadata before final overrides", async () => {
    const providerId = "openai-compatible-chat-custom-precedence";
    const prefix = "custom-precedence";
    const modelId = "shared-model";
    await providersDb.createProviderNode({
      id: providerId,
      type: "openai-compatible",
      prefix,
      name: "Custom Precedence",
      apiType: "chat",
      baseUrl: "https://example.com/v1",
    });
    const connection = await providersDb.createProviderConnection({
      provider: providerId,
      authType: "api_key",
      name: "custom-precedence-catalog",
      apiKey: "sk-test",
    });
    await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, connection.id as string, [
      {
        id: modelId,
        name: "Discovered name",
        source: "imported",
        inputTokenLimit: 128000,
        supportsVision: true,
      },
    ]);
    await modelsDb.addCustomModel(
      providerId,
      modelId,
      "Operator name",
      "manual",
      "chat-completions",
      ["chat"],
      undefined,
      { outputTokenLimit: 32000 },
      false
    );

    const customProjected = await getModel(`${prefix}/${modelId}`);
    assert.ok(customProjected);
    assert.equal(customProjected.max_output_tokens, 32000);

    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        `${prefix}/${modelId}`,
        "max_output_tokens",
        64000
      ),
      true
    );
    assert.equal(await contextOverrides.setModelContextOverride(providerId, modelId, 500000), true);

    const projected = await getModel(`${prefix}/${modelId}`);
    assert.ok(projected);
    assert.equal(projected.name, "Operator name");
    assert.equal(projected.context_length, 500000);
    assert.equal(projected.max_output_tokens, 64000);
    assert.equal((projected.capabilities as Record<string, unknown>)?.vision, false);
    assert.deepEqual(projected.input_modalities, ["text"]);
  });
});
