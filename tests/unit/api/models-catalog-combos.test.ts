// @ts-nocheck
// /v1/models catalog: combo metadata (context window, max input/output tokens, modalities, hidden
// leaves, active seats), quota-exclusive keys, and /api/models agreement.
//
// Merged from 10 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// resets the database and the catalog cache in its own hooks (each former file started from a
// fresh process); the database handle is closed once at the end of the file.
//
// Not merged: quota-exclusive-catalog-short-circuit.test.ts. It counts the OpenRouter catalog
// fetch and needs the process-wide OpenRouter 24h cache to be cold, which no merged file can
// promise.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-catalog-combos-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";
// Cold catalog builds are bounded by this (8s default); a loaded host would trip it.
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const overridesDb = await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const contextOverrides = await import("../../../src/lib/db/modelContextOverrides.ts");
const poolsDb = await import("../../../src/lib/db/quotaPools.ts");
const groupsDb = await import("../../../src/lib/db/quotaGroups.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("@/lib/db/models");
const modelsDevSync = await import("../../../src/lib/modelsDevSync.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const modelsRoute = await import("../../../src/app/api/models/route.ts");
const {
  buildAliasMaps,
  getComboTargetModelId,
  prefixRoutesToProvider,
  prefixRoutesToCanonicalProvider,
} = await import("../../../src/app/api/v1/models/catalogProviderMaps.ts");
const { intersectKnownStringArrays } =
  await import("../../../src/app/api/v1/models/catalogHelpers.ts");
const { openRouterCapabilityEntry } =
  await import("../../../src/app/api/v1/models/catalogOpenrouter.ts");
const { getSourcedTokenLimit, resolveTokenLimit, getTokenLimit } =
  await import("../../../open-sse/services/contextManager.ts");
const { computeComboContextLength } = await import("../../../src/lib/combos/comboContext.ts");
const { syncQuotaCombos } = await import("../../../src/lib/quota/quotaCombos.ts");
const { quotaGroupSlug, isQuotaModelName, parseQuotaModelName } =
  await import("../../../src/lib/quota/quotaModelNaming.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

after(async () => {
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Fresh database, API-key state and catalog cache: what each former file started with. */
async function resetAll() {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

describe("16515-combo-max-output-override", () => {
  function capability(limitOutput: number) {
    return {
      tool_call: true,
      reasoning: null,
      attachment: null,
      structured_output: null,
      temperature: null,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: null,
      limit_context: 1_000_000,
      limit_input: null,
      limit_output: limitOutput,
      interleaved_field: null,
    };
  }

  before(resetAll);

  test("#16515 a combo's max_output_tokens honours a member's max_output_tokens override", async () => {
    await modelsDevSync.saveModelsDevCapabilities({
      openai: { "override-member": capability(1_048_576) },
      gemini: { "plain-member": capability(384_000) },
    });
    assert.equal(
      await overridesDb.setModelCapabilityOverride(
        "openai/override-member",
        "max_output_tokens",
        65_536
      ),
      true
    );
    await combosDb.createCombo({
      name: "override-router",
      strategy: "priority",
      models: ["openai/override-member", "gemini/plain-member"],
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; max_output_tokens?: number }>;
    };
    const combo = body.data.find((item) => item.id === "override-router");

    assert.equal(response.status, 200);
    assert.ok(combo);
    // min(65536 after the override, 384000), not min(1048576 raw, 384000)
    assert.equal(combo.max_output_tokens, 65_536);
  });
});

describe("combo-catalog-cloudflare-context-17881", () => {
  // #17881: a combo with Cloudflare Workers AI llama-3.3-70b-instruct-fp8-fast (24k window)
  // must advertise 24000, not an unknown window or the larger sibling's 262144.
  const catalog = v1ModelsCatalog;

  const LLAMA_FP8_FAST = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const KIMI = "@cf/moonshotai/kimi-k2.6";

  async function getComboEntry(name: string): Promise<Record<string, unknown> | undefined> {
    catalog.__resetCatalogBuilderRunsForTest();
    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    return body.data.find((item) => item.id === name);
  }

  describe("Cloudflare Workers AI combo context window (#17881)", () => {
    before(resetAll);

    it("single-member combo advertises the fp8-fast 24k window", async () => {
      await providersDb.createProviderConnection({
        provider: "cloudflare-ai",
        authType: "apikey",
        name: "cf-test-conn",
        apiKey: "cf-test-key",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { accountId: "test-account" },
      });

      await combosDb.createCombo({
        name: "cf-llama-fp8-combo",
        strategy: "priority",
        models: [{ model: `cf/${LLAMA_FP8_FAST}`, providerId: "cloudflare-ai" }],
      });

      const combo = await getComboEntry("cf-llama-fp8-combo");
      assert.ok(combo, "combo should exist in models list");
      assert.equal(combo?.context_length, 24000);
      assert.equal(combo?.max_input_tokens, 24000);
    });

    it("mixed combo advertises the smallest member window, not the larger sibling's", async () => {
      await combosDb.createCombo({
        name: "cf-llama-kimi-combo",
        strategy: "priority",
        models: [
          { model: `cf/${LLAMA_FP8_FAST}`, providerId: "cloudflare-ai" },
          { model: `cf/${KIMI}`, providerId: "cloudflare-ai" },
        ],
      });

      const combo = await getComboEntry("cf-llama-kimi-combo");
      assert.ok(combo, "combo should exist in models list");
      assert.equal(combo?.context_length, 24000);
      assert.equal(combo?.max_input_tokens, 24000);
    });
  });
});

describe("combo-catalog-max-input-tokens", () => {
  const catalog = v1ModelsCatalog;

  describe("Combo catalog max_input_tokens and provider prefix stripping", () => {
    before(resetAll);

    it("prefixRoutesToCanonicalProvider recognizes aliases resolving to their canonical provider (#13994)", () => {
      // "opencode" routes to canonical "opencode-zen" -- only the alias-aware
      // variant used by the combo prefix-stripping path recognizes this.
      assert.equal(prefixRoutesToCanonicalProvider("opencode", "opencode-zen"), true);
      assert.equal(prefixRoutesToCanonicalProvider("opencode-zen", "opencode-zen"), true);
      // unrelated prefix does not route to openrouter
      assert.equal(prefixRoutesToCanonicalProvider("nvidia", "openrouter"), false);
    });

    it("prefixRoutesToProvider (catalog.ts anti-collision guard) stays strict for self-aliased no-auth providers", () => {
      // #11433/7db430a3: the guard at catalog.ts:1121/1896 must keep failing
      // for a self-aliased provider whose id differs from its canonical
      // routing target, or the catalog would start publishing a
      // provider-prefixed id ("opencode/<model>") that actually routes to a
      // DIFFERENT provider ("opencode-zen") at request time.
      assert.equal(prefixRoutesToProvider("opencode", "opencode"), false);
      assert.equal(prefixRoutesToProvider("opencode-zen", "opencode-zen"), true);
      assert.equal(prefixRoutesToProvider("nvidia", "openrouter"), false);
    });

    it("getComboTargetModelId strips opencode/ prefix from target model string", () => {
      const maps = buildAliasMaps();
      // A combo step stored with the legacy `opencode` provider id (the removed keyless
      // provider) still resolves to opencode-zen through the manual `opencode/` override.
      const resolved = getComboTargetModelId(maps, {
        providerId: "opencode",
        modelStr: "opencode/nemotron-3-ultra-free",
      });

      assert.ok(resolved);
      assert.equal(resolved?.providerId, "opencode-zen");
      assert.equal(resolved?.modelId, "nemotron-3-ultra-free");
    });

    it("builds combo metadata with 1M max_input_tokens for 1M targets and explicit context", async () => {
      await providersDb.createProviderConnection({
        provider: "opencode-zen",
        authType: "apikey",
        name: "opencode-test-conn",
        apiKey: "opencode-test-key",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      });

      await combosDb.createCombo({
        name: "free-1m-test-combo",
        strategy: "priority",
        context_length: 1000000,
        models: [
          {
            model: "opencode/nemotron-3-ultra-free",
            providerId: "opencode-zen",
          },
        ],
      });

      catalog.__resetCatalogBuilderRunsForTest();

      const response = await catalog.getUnifiedModelsResponse(
        new Request("http://localhost/api/v1/models")
      );
      assert.equal(response.status, 200);

      const body = (await response.json()) as { data: Array<Record<string, unknown>> };
      const combo = body.data.find((item) => item.id === "free-1m-test-combo");

      assert.ok(combo, "combo should exist in models list");
      assert.equal(combo?.context_length, 1000000, "context_length should be 1,000,000");
      assert.equal(
        combo?.max_input_tokens,
        1000000,
        "max_input_tokens should be 1,000,000, not 200,000"
      );
    });

    it("clamps max_input_tokens to explicit context_length when targets have larger limits", async () => {
      await combosDb.createCombo({
        name: "clamped-target-500k-combo",
        strategy: "priority",
        context_length: 500000,
        models: [
          {
            model: "opencode/nemotron-3-ultra-free",
            providerId: "opencode-zen",
          },
        ],
      });

      catalog.__resetCatalogBuilderRunsForTest();

      const response = await catalog.getUnifiedModelsResponse(
        new Request("http://localhost/api/v1/models")
      );
      assert.equal(response.status, 200);

      const body = (await response.json()) as { data: Array<Record<string, unknown>> };
      const combo = body.data.find((item) => item.id === "clamped-target-500k-combo");

      assert.ok(combo);
      assert.equal(combo?.context_length, 500000);
      assert.equal(combo?.max_input_tokens, 500000);
    });
  });
});

describe("combo-context-generic-default-10734", () => {
  const catalog = v1ModelsCatalog;

  before(resetAll);

  test("#10734: resolveTokenLimit marks the generic 128k catch-all as specific:false", async () => {
    const resolved = await resolveTokenLimit("not-a-real-provider", "no-such-model");
    assert.equal(resolved.limit, 128000);
    assert.equal(resolved.specific, false);
  });

  test("#10734: getSourcedTokenLimit omits the generic 128k catch-all", async () => {
    assert.equal(await getSourcedTokenLimit("not-a-real-provider", "no-such-model"), undefined);
    assert.equal(await getTokenLimit("not-a-real-provider", "no-such-model"), 128000);
  });

  test("#10734: getSourcedTokenLimit keeps an explicit canonical window", async () => {
    assert.equal(
      await getSourcedTokenLimit("not-a-real-provider", "no-such-model", 500000),
      500000
    );
  });

  test("#10734: getSourcedTokenLimit keeps provider-specific defaults (claude)", async () => {
    const sourced = await getSourcedTokenLimit("claude", "claude-sonnet-4");
    assert.equal(typeof sourced, "number");
    assert.ok(sourced && sourced > 128000);
    assert.equal((await resolveTokenLimit("claude", "claude-sonnet-4")).specific, true);
  });

  test("#10734: combo min() ignores unsourced members instead of advertising 128k", async () => {
    const combo = {
      name: "large-plus-unknown",
      models: ["glm/glm-5.2", "not-a-real-provider/no-such-model"],
    };
    const result = await computeComboContextLength(combo, []);
    assert.equal(
      result,
      1000000,
      "glm-5.2 is a sourced 1M window; the generic-default member must not pull min() to 128k"
    );
  });

  test("#10734: nested combo-ref inherits sourced min(), not 128k", async () => {
    const inner = {
      name: "inner-large",
      models: ["glm/glm-5.2", "not-a-real-provider/no-such-model"],
    };
    const wrapper = {
      name: "wrapper-large",
      models: [{ kind: "combo-ref", comboName: "inner-large" }],
    };
    const result = await computeComboContextLength(wrapper, [inner, wrapper]);
    assert.equal(result, 1000000);
  });

  test("#10734: GET /v1/models does not advertise 128k for a 500k combo plus an unsourced member", async () => {
    const modelId = "gpt-5.6-terra";
    assert.equal(await contextOverrides.setModelContextOverride("codex", modelId, 500000), true);

    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "codex-10734-large-window",
      accessToken: "codex-test-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    await combosDb.createCombo({
      name: "large-context-combo-10734",
      strategy: "priority",
      models: [`codex/${modelId}`, "not-a-real-provider/no-such-model"],
    });

    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const combo = body.data.find((item) => item.id === "large-context-combo-10734");

    assert.equal(response.status, 200);
    assert.ok(combo, "combo should be published in /v1/models");
    assert.notEqual(
      combo.context_length,
      128000,
      "generic 128k must not win min() over the 500k sourced member"
    );
    assert.equal(combo.context_length, 500000);
  });
});

describe("combo-openrouter-modalities-12613", () => {
  /**
   * #12613 — combo LCD must degrade unknown/empty-modality targets instead of
   * dropping the whole intersection. OpenRouter architecture.input_modalities
   * must also land in the canonical snapshot so a later combo walk can see them.
   */
  const catalog = v1ModelsCatalog;

  type CatalogEntry = {
    id: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    catalog.__resetCatalogBuilderRunsForTest();
  }

  function capability(overrides: Record<string, unknown> = {}) {
    return {
      tool_call: null,
      reasoning: null,
      attachment: null,
      structured_output: null,
      temperature: null,
      modalities_input: JSON.stringify([]),
      modalities_output: JSON.stringify([]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: null,
      limit_context: null,
      limit_input: null,
      limit_output: null,
      interleaved_field: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetStorage();
  });

  after(async () => {
    // The former file left the capability snapshot empty for whoever runs next.
    await resetTestDb();
  });

  test("#12613 intersectKnownStringArrays ignores empty unknown arrays", () => {
    assert.deepEqual(intersectKnownStringArrays([["text", "image"], []]), ["text", "image"]);
    assert.deepEqual(intersectKnownStringArrays([["text", "image"], ["text"]]), ["text"]);
    assert.deepEqual(intersectKnownStringArrays([[], []]), []);
    assert.deepEqual(intersectKnownStringArrays([]), []);
  });

  test("#12613 combo with one unknown target keeps known vision modalities", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-12613",
      apiKey: "sk-test-12613",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });

    await modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "gpt-4o": capability({
          tool_call: true,
          reasoning: false,
          attachment: true,
          structured_output: true,
          temperature: true,
          modalities_input: JSON.stringify(["text", "image"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 128000,
          limit_input: 128000,
          limit_output: 16384,
        }),
      },
    });

    await combosDb.createCombo({
      name: "vision-plus-unknown-12613",
      strategy: "priority",
      models: ["openai/gpt-4o", "openai/totally-unknown-model-12613"],
    });

    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    if (response.status !== 200) {
      const errBody = await response.text();
      assert.fail(`catalog ${response.status}: ${errBody.slice(0, 500)}`);
    }
    const body = (await response.json()) as { data: CatalogEntry[] };
    const combo = body.data.find((m) => m.id === "vision-plus-unknown-12613");
    assert.ok(combo, "combo must be listed");
    assert.ok(
      Array.isArray(combo.input_modalities) && combo.input_modalities.includes("image"),
      `unknown target must not drop combo image modality, got ${JSON.stringify(combo.input_modalities)}`
    );
    assert.ok(
      Array.isArray(combo.output_modalities) && combo.output_modalities.includes("text"),
      `unknown target must not drop combo text output, got ${JSON.stringify(combo.output_modalities)}`
    );
  });

  test("#12613 upsertSyncedCapabilities writes OpenRouter modalities without wiping others", async () => {
    await modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "gpt-4o": capability({
          modalities_input: JSON.stringify(["text", "image"]),
          modalities_output: JSON.stringify(["text"]),
        }),
      },
    });
    await modelsDevSync.upsertSyncedCapabilities("openrouter", {
      "openai/gpt-4o": capability({
        tool_call: true,
        modalities_input: JSON.stringify(["text", "image"]),
        modalities_output: JSON.stringify(["text"]),
      }),
    });
    const caps = await modelsDevSync.getSyncedCapabilities();
    assert.ok(caps.openai?.["gpt-4o"], "openai rows must survive upsert");
    assert.deepEqual(JSON.parse(caps.openrouter["openai/gpt-4o"].modalities_input), [
      "text",
      "image",
    ]);
  });

  test("#12613 openRouterCapabilityEntry rejects non-positive limits", () => {
    const entry = openRouterCapabilityEntry(
      { id: "x", context_length: -1, top_provider: { max_completion_tokens: Number.NaN } },
      ["text"],
      ["text"],
      { tool_calling: true }
    );
    assert.equal(entry?.limit_context, null);
    assert.equal(entry?.limit_output, null);
  });

  test("#12613 upsertSyncedCapabilities refreshes limit_output on conflict", async () => {
    await modelsDevSync.upsertSyncedCapabilities("openrouter", {
      "openai/gpt-4o": {
        ...capability(),
        modalities_input: JSON.stringify(["text"]),
        modalities_output: JSON.stringify(["text"]),
        limit_output: 100,
      },
    });
    await modelsDevSync.upsertSyncedCapabilities("openrouter", {
      "openai/gpt-4o": {
        ...capability(),
        modalities_input: JSON.stringify(["text", "image"]),
        modalities_output: JSON.stringify(["text"]),
        limit_output: 200,
      },
    });
    const caps = await modelsDevSync.getSyncedCapabilities("openrouter", "openai/gpt-4o");
    assert.equal(caps.openrouter["openai/gpt-4o"].limit_output, 200);
    assert.deepEqual(JSON.parse(caps.openrouter["openai/gpt-4o"].modalities_input), [
      "text",
      "image",
    ]);
  });
});

describe("models-catalog-combo-active-seat-limits", () => {
  // A combo's advertised context/output limits are the minimum over its targets. A target whose
  // provider has no active connection is never routed to, so it must not drag that minimum down
  // (a disabled 128k seat would otherwise cap a combo that in practice only serves a 1M model).
  const catalog = v1ModelsCatalog;

  const SMALL = "openai/gpt-4o";
  const LARGE = "gemini/gemini-2.5-flash";

  type CatalogRow = Record<string, unknown>;

  async function fetchCatalog(): Promise<CatalogRow[]> {
    catalog.__resetCatalogBuilderRunsForTest();
    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: CatalogRow[] };
    return body.data;
  }

  async function setConnectionActive(id: string, isActive: boolean) {
    await providersDb.updateProviderConnection(id, { isActive });
  }

  const comboModels = [
    { model: SMALL, providerId: "openai" },
    { model: LARGE, providerId: "gemini" },
  ];

  describe("combo catalog limits ignore seats without an active connection", () => {
    let openaiId = "";
    let geminiId = "";
    let smallOnly: CatalogRow | undefined;
    let largeOnly: CatalogRow | undefined;

    before(async () => {
      await resetAll();
      const openai = await providersDb.createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "openai-seat",
        apiKey: "sk-openai-seat",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      });
      const gemini = await providersDb.createProviderConnection({
        provider: "gemini",
        authType: "apikey",
        name: "gemini-seat",
        apiKey: "gemini-seat-key",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      });
      openaiId = String(openai.id);
      geminiId = String(gemini.id);

      await combosDb.createCombo({
        name: "seat-small-only",
        strategy: "priority",
        models: [comboModels[0]],
      });
      await combosDb.createCombo({
        name: "seat-large-only",
        strategy: "priority",
        models: [comboModels[1]],
      });
      await combosDb.createCombo({
        name: "seat-mixed",
        strategy: "priority",
        models: comboModels,
      });
      await combosDb.createCombo({
        name: "seat-mixed-explicit",
        strategy: "priority",
        context_length: 64000,
        models: comboModels,
      });

      const rows = await fetchCatalog();
      smallOnly = rows.find((row) => row.id === "seat-small-only");
      largeOnly = rows.find((row) => row.id === "seat-large-only");
    });

    it("fixture targets publish distinct context windows", () => {
      assert.ok(smallOnly && largeOnly, "single-seat combos must be listed");
      assert.equal(typeof smallOnly.context_length, "number");
      assert.equal(typeof largeOnly.context_length, "number");
      assert.ok(
        (largeOnly.context_length as number) > (smallOnly.context_length as number),
        `expected ${LARGE} window > ${SMALL} window`
      );
    });

    it("keeps the minimum across seats when every provider is active", async () => {
      const mixed = (await fetchCatalog()).find((row) => row.id === "seat-mixed");
      assert.ok(mixed);
      assert.equal(mixed.context_length, smallOnly?.context_length);
      assert.equal(mixed.max_input_tokens, smallOnly?.max_input_tokens);
    });

    it("drops the inactive provider's seat from the limit calculation", async () => {
      await setConnectionActive(openaiId, false);
      try {
        const rows = await fetchCatalog();
        const mixed = rows.find((row) => row.id === "seat-mixed");
        assert.ok(mixed, "combo stays listed while one seat is inactive");
        assert.equal(mixed.context_length, largeOnly?.context_length);
        assert.equal(mixed.max_input_tokens, largeOnly?.max_input_tokens);
        assert.equal(mixed.max_output_tokens, largeOnly?.max_output_tokens);

        // An operator-set combo context_length still wins over target limits.
        const explicit = rows.find((row) => row.id === "seat-mixed-explicit");
        assert.ok(explicit);
        assert.equal(explicit.context_length, 64000);
        assert.equal(explicit.max_input_tokens, 64000);
      } finally {
        await setConnectionActive(openaiId, true);
      }
    });

    it("falls back to every seat when no provider has an active connection", async () => {
      await setConnectionActive(openaiId, false);
      await setConnectionActive(geminiId, false);
      try {
        const mixed = (await fetchCatalog()).find((row) => row.id === "seat-mixed");
        assert.ok(mixed, "combo stays listed with every seat inactive");
        assert.equal(mixed.context_length, smallOnly?.context_length);
        assert.equal(mixed.max_input_tokens, smallOnly?.max_input_tokens);
      } finally {
        await setConnectionActive(openaiId, true);
        await setConnectionActive(geminiId, true);
      }
    });

    it("treats a seat pinned to an inactive connection as inactive", async () => {
      const spare = await providersDb.createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: "openai-spare",
        apiKey: "sk-openai-spare",
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      });
      await combosDb.createCombo({
        name: "seat-pinned",
        strategy: "priority",
        models: [{ ...comboModels[0], connectionId: openaiId }, comboModels[1]],
      });
      await setConnectionActive(openaiId, false);
      try {
        const pinned = (await fetchCatalog()).find((row) => row.id === "seat-pinned");
        assert.ok(pinned);
        assert.equal(pinned.context_length, largeOnly?.context_length);
      } finally {
        await setConnectionActive(openaiId, true);
        await setConnectionActive(String(spare.id), false);
      }
    });

    it("keeps a noAuth seat (no connection rows) in the limit calculation", async () => {
      const noAuthSeat = { model: "auggie/sonnet4.6", providerId: "auggie" };
      await combosDb.createCombo({
        name: "seat-noauth-only",
        strategy: "priority",
        models: [noAuthSeat],
      });
      await combosDb.createCombo({
        name: "seat-noauth-mixed",
        strategy: "priority",
        models: [comboModels[1], noAuthSeat],
      });
      const rows = await fetchCatalog();
      const noAuthOnly = rows.find((row) => row.id === "seat-noauth-only");
      const mixed = rows.find((row) => row.id === "seat-noauth-mixed");
      assert.ok(noAuthOnly && mixed);
      assert.equal(typeof noAuthOnly.context_length, "number");
      assert.ok((noAuthOnly.context_length as number) < (largeOnly?.context_length as number));
      assert.equal(mixed.context_length, noAuthOnly.context_length);
    });
  });
});

describe("models-catalog-hidden-combo-leaves", () => {
  type CatalogModel = {
    id: string;
    context_length?: number;
    max_output_tokens?: number;
  };

  function capability(limitContext: number, limitOutput: number) {
    return {
      tool_call: null,
      reasoning: null,
      attachment: null,
      structured_output: null,
      temperature: null,
      modalities_input: JSON.stringify([]),
      modalities_output: JSON.stringify([]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: null,
      limit_context: limitContext,
      limit_input: null,
      limit_output: limitOutput,
      interleaved_field: null,
    };
  }

  async function getCatalogData(): Promise<CatalogModel[]> {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body: { data: CatalogModel[] } = await response.json();
    assert.equal(response.status, 200);
    return body.data;
  }

  beforeEach(async () => {
    await resetTestDb();
    await core.resetDbInstance();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  });

  after(async () => {
    await modelsDevSync.saveModelsDevCapabilities({});
  });

  test("v1 models catalog keeps partially hidden combos and derives metadata from visible targets", async () => {
    await modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "catalog-hidden-leaf": capability(1000, 100),
        "catalog-visible-leaf": capability(8000, 800),
      },
    });
    await modelsDb.mergeModelCompatOverride("openai", "catalog-hidden-leaf", { isHidden: true });
    await combosDb.createCombo({
      name: "partially-hidden-router",
      strategy: "priority",
      models: ["openai/catalog-hidden-leaf", "openai/catalog-visible-leaf"],
    });

    const combo = (await getCatalogData()).find((item) => item.id === "partially-hidden-router");

    assert.ok(combo);
    assert.equal(combo.context_length, 8000);
    assert.equal(combo.max_output_tokens, 800);
  });

  test("v1 models catalog omits combos when every resolved target is hidden", async () => {
    await modelsDb.mergeModelCompatOverride("openai", "catalog-hidden-alpha", { isHidden: true });
    await modelsDb.mergeModelCompatOverride("openai", "catalog-hidden-beta", { isHidden: true });
    await combosDb.createCombo({
      name: "fully-hidden-router",
      strategy: "priority",
      models: ["openai/catalog-hidden-alpha", "openai/catalog-hidden-beta"],
    });

    const data = await getCatalogData();

    assert.equal(
      data.some((item) => item.id === "fully-hidden-router"),
      false
    );
  });

  test("v1 models catalog applies hidden leaf filtering through nested combos", async () => {
    await modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "nested-hidden-leaf": capability(2000, 200),
        "nested-visible-leaf": capability(16000, 1600),
        "nested-hidden-only": capability(4000, 400),
      },
    });
    await modelsDb.mergeModelCompatOverride("openai", "nested-hidden-leaf", { isHidden: true });
    await modelsDb.mergeModelCompatOverride("openai", "nested-hidden-only", { isHidden: true });
    await combosDb.createCombo({
      name: "partially-hidden-child",
      strategy: "priority",
      models: ["openai/nested-hidden-leaf", "openai/nested-visible-leaf"],
    });
    await combosDb.createCombo({
      name: "partially-hidden-parent",
      strategy: "priority",
      models: ["partially-hidden-child"],
    });
    await combosDb.createCombo({
      name: "fully-hidden-child",
      strategy: "priority",
      models: ["openai/nested-hidden-only"],
    });
    await combosDb.createCombo({
      name: "fully-hidden-parent",
      strategy: "priority",
      models: ["fully-hidden-child"],
    });

    const data = await getCatalogData();
    const parent = data.find((item) => item.id === "partially-hidden-parent");

    assert.ok(parent);
    assert.equal(parent.context_length, 16000);
    assert.equal(parent.max_output_tokens, 1600);
    assert.equal(
      data.some((item) => item.id === "fully-hidden-child"),
      false
    );
    assert.equal(
      data.some((item) => item.id === "fully-hidden-parent"),
      false
    );
  });

  test("v1 models catalog canonicalizes aliases before deciding that a combo is fully hidden", async () => {
    await modelsDb.mergeModelCompatOverride("github", "claude-opus-4-5-20251101", {
      isHidden: true,
    });
    await combosDb.createCombo({
      name: "hidden-alias-router",
      strategy: "priority",
      models: ["gh/claude-4.5-opus"],
    });

    const data = await getCatalogData();

    assert.equal(
      data.some((item) => item.id === "hidden-alias-router"),
      false
    );
  });

  test("v1 models catalog preserves explicit providers for slashful model ids", async () => {
    await modelsDb.mergeModelCompatOverride("nvidia", "openai/gpt-oss-120b", { isHidden: true });
    await combosDb.createCombo({
      name: "hidden-slashful-router",
      strategy: "priority",
      models: [{ model: "openai/gpt-oss-120b", providerId: "nvidia" }],
    });

    const data = await getCatalogData();

    assert.equal(
      data.some((item) => item.id === "hidden-slashful-router"),
      false
    );
  });

  test("v1 models catalog omits combos with no resolved targets", async () => {
    await combosDb.createCombo({
      name: "empty-router",
      strategy: "priority",
      models: [],
    });

    const data = await getCatalogData();

    assert.equal(
      data.some((item) => item.id === "empty-router"),
      false
    );
  });
});

describe("quota-exclusive-catalog-4806", () => {
  /**
   * Regression for #4806 — "[BUG] Cota Exclusiva: modelos virtuais param de
   * listar após ativação".
   *
   * When an API key is scoped to a quota pool (allowedQuotas non-empty — the
   * "Cota exclusiva" state), GET /v1/models must list that pool's
   * qtSd/<group>/<provider>/<model> virtual models. Clients such as Claude
   * Desktop build their model picker from /v1/models, so an empty list shows
   * "0 modelo encontrado" and the key cannot be used.
   *
   * Root cause (before the fix): getUnifiedModelsResponse filtered the *base*
   * catalog list with filterModelsToQuotaPools(), but the base list never
   * contains qtSd/* combos — they are isHidden:true and skipped while the base
   * list is built (catalog.ts: `if (combo.isHidden === true) continue;`). The
   * filter only KEEPS qtSd/* names, so filtering a list that has none returns
   * [] → 0 models for every quota-exclusive key.
   *
   * Uses "glm" as the provider because it has a small, stable model list in the
   * static registry (same convention as quota-combos-sync.test.ts).
   */
  beforeEach(resetAll);

  test("#4806 quota-exclusive key lists its qtSd/* virtual models in GET /v1/models", async () => {
    // Group "Times" → slug "times"; combos will be qtSd/times/glm/<model>.
    const group = await groupsDb.createGroup("Times");

    const conn = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "quota-4806-glm",
      apiKey: "sk-glm-4806",
    });
    const connId = (conn as Record<string, unknown>).id as string;
    assert.ok(connId, "connection should have an id");

    const pool = await poolsDb.createPool({
      connectionId: connId,
      name: "Times",
      groupId: group.id,
    });
    await syncQuotaCombos(pool.id); // mint the hidden qtSd/times/glm/* combos

    // Make the key "quota exclusive" by scoping it to the pool.
    const created = await apiKeysDb.createApiKey("Quota-4806 Key", "machine-4806");
    await apiKeysDb.updateApiKeyPermissions(created.id, { allowedQuotas: [pool.id] });

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ id: string }> };

    const slug = quotaGroupSlug("Times"); // "times"
    const qtsdForKey = body.data.filter(
      (m) => isQuotaModelName(m.id) && parseQuotaModelName(m.id)?.groupSlug === slug
    );

    assert.ok(
      qtsdForKey.length > 0,
      `quota-exclusive key must see its qtSd/${slug}/glm/* models in /v1/models; ` +
        `got ${body.data.length} total, ${qtsdForKey.length} qtSd. ` +
        `ids=${JSON.stringify(body.data.map((m) => m.id).slice(0, 8))}`
    );

    // Every returned model must belong to the key's group (no leakage of other pools/raw models).
    for (const m of body.data) {
      assert.ok(
        isQuotaModelName(m.id) && parseQuotaModelName(m.id)?.groupSlug === slug,
        `quota-exclusive key should only see its own qtSd/${slug}/* models; leaked: ${m.id}`
      );
    }
  });

  test("#4806 quota-exclusive key does NOT see qtSd/* of a group it is not allocated to", async () => {
    // Group A (glm) — the key's group.
    const groupA = await groupsDb.createGroup("Alpha");
    const connA = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "quota-4806-glm-a",
      apiKey: "sk-glm-4806-a",
    });
    const poolA = await poolsDb.createPool({
      connectionId: (connA as Record<string, unknown>).id as string,
      name: "Alpha",
      groupId: groupA.id,
    });
    await syncQuotaCombos(poolA.id);

    // Group B (codex) — a DIFFERENT group the key is NOT allocated to.
    const groupB = await groupsDb.createGroup("Beta");
    const connB = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "quota-4806-codex-b",
      apiKey: "sk-codex-4806-b",
    });
    const poolB = await poolsDb.createPool({
      connectionId: (connB as Record<string, unknown>).id as string,
      name: "Beta",
      groupId: groupB.id,
    });
    await syncQuotaCombos(poolB.id);

    // Key scoped ONLY to group A's pool.
    const created = await apiKeysDb.createApiKey("Quota-4806 Key A", "machine-4806-a");
    await apiKeysDb.updateApiKeyPermissions(created.id, { allowedQuotas: [poolA.id] });

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { Authorization: `Bearer ${created.key}` },
      })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ id: string }> };

    const slugA = quotaGroupSlug("Alpha");
    const slugB = quotaGroupSlug("Beta");

    assert.ok(
      body.data.some((m) => parseQuotaModelName(m.id)?.groupSlug === slugA),
      "key must see its own group A qtSd/* models"
    );
    const leakedFromB = body.data.filter((m) => parseQuotaModelName(m.id)?.groupSlug === slugB);
    assert.equal(
      leakedFromB.length,
      0,
      `key in group A must NOT see group B (${slugB}) models; leaked: ${JSON.stringify(
        leakedFromB.map((m) => m.id)
      )}`
    );
  });
});

describe("quota-exclusive-combo-metadata", () => {
  /**
   * A quota-exclusive key's qtSd/* combos must describe their own targets.
   *
   * Both quota paths in the catalog built combo metadata from the full combo list
   * instead of the combo's resolved targets, so every target lookup missed and the
   * entry lost `effort_tiers`, `vision` and the target's token limits. The fix gives
   * the quota path the same target resolution as an ordinary combo, so a visible
   * copy of each qtSd/* combo (same targets, same connection pin) is the oracle.
   */
  type CatalogRow = Record<string, unknown> & { id: string };

  async function listModels(key: string): Promise<Map<string, CatalogRow>> {
    v1ModelsCatalog.__expireCatalogCacheForTest(
      v1ModelsCatalog.CATALOG_STALE_WHILE_REVALIDATE_MS + 1_000
    );
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      })
    );
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: CatalogRow[] };
    return new Map(data.map((row) => [row.id, row]));
  }

  const MIRROR_PREFIX = "quota-mirror/";
  const DESCRIBED_FIELDS = [
    "context_length",
    "max_input_tokens",
    "max_output_tokens",
    "input_modalities",
    "capabilities",
  ] as const;

  before(resetAll);

  test("qtSd/* combos carry the same target metadata as an ordinary combo", async () => {
    const group = await groupsDb.createGroup("Meta");
    const conn = await providersDb.createProviderConnection({
      provider: "anthropic",
      authType: "apikey",
      name: "quota-meta-anthropic",
      apiKey: "sk-ant-quota-meta",
    });
    const pool = await poolsDb.createPool({
      connectionId: (conn as Record<string, unknown>).id as string,
      name: "Meta",
      groupId: group.id,
    });
    await syncQuotaCombos(pool.id);

    const quotaCombos = (await combosDb.getCombos()).filter((combo) =>
      isQuotaModelName(String(combo.name))
    );
    assert.ok(quotaCombos.length > 0, "the pool must generate qtSd/* combos");
    for (const combo of quotaCombos) {
      const { id: _id, ...copy } = combo as Record<string, unknown>;
      await combosDb.createCombo({
        ...copy,
        name: `${MIRROR_PREFIX}${combo.name}`,
        isHidden: false,
      });
    }

    const quotaKey = await apiKeysDb.createApiKey("Quota key", "machine-quota-meta");
    await apiKeysDb.updateApiKeyPermissions(quotaKey.id, { allowedQuotas: [pool.id] });
    const normalKey = await apiKeysDb.createApiKey("Normal key", "machine-normal-meta");

    const quotaRows = await listModels(quotaKey.key);
    const normalRows = await listModels(normalKey.key);

    let withTiers = 0;
    for (const combo of quotaCombos) {
      const quotaRow = quotaRows.get(String(combo.name));
      const mirrorRow = normalRows.get(`${MIRROR_PREFIX}${combo.name}`);
      assert.ok(quotaRow && mirrorRow, `both listings must contain ${combo.name}`);
      for (const field of DESCRIBED_FIELDS) {
        assert.deepEqual(quotaRow[field], mirrorRow[field], `${combo.name}.${field}`);
      }
      const capabilities = quotaRow.capabilities as Record<string, unknown> | undefined;
      if (Array.isArray(capabilities?.effort_tiers)) withTiers++;
    }
    assert.ok(withTiers > 0, "at least one qtSd/* combo must advertise effort_tiers");
  });
});

describe("api-models-v1-models-mismatch-10615", () => {
  const localDb = { replaceSyncedAvailableModelsForConnection };

  before(resetAll);

  test("#10615: /api/models must agree with /v1/models on exclusive synced-listing coverage", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "cursor",
      authType: "oauth",
      name: "cursor-main",
      accessToken: "cursor-access-token",
      isActive: true,
    });

    const apiModelsRes = await modelsRoute.GET(new Request("http://localhost/api/models"));
    const apiModelsBody = (await apiModelsRes.json()) as {
      models: Array<{ provider: string; model: string; fullModel: string; available: boolean }>;
    };
    const staticRow = apiModelsBody.models.find((m) => m.fullModel === "cu/composer-2.5");
    assert.ok(staticRow, "/api/models must list the static cursor model");
    assert.equal(staticRow!.available, true);

    await localDb.replaceSyncedAvailableModelsForConnection("cursor", connection.id, [
      { id: "composer-3", name: "Composer 3" },
    ]);
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();

    const v1Res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const v1Body = (await v1Res.json()) as { data: Array<{ id: string }> };
    const v1Ids = v1Body.data.map((m) => m.id);

    assert.equal(v1Res.status, 200);
    assert.ok(v1Ids.includes("cu/composer-3"));
    assert.equal(v1Ids.includes("cu/composer-2.5"), false);

    const apiModelsAfterRes = await modelsRoute.GET(new Request("http://localhost/api/models"));
    const apiModelsAfterBody = (await apiModelsAfterRes.json()) as {
      models: Array<{ fullModel: string; available: boolean }>;
    };
    const staticRowAfter = apiModelsAfterBody.models.find((m) => m.fullModel === "cu/composer-2.5");
    assert.ok(staticRowAfter);
    assert.equal(
      staticRowAfter!.available,
      false,
      "/api/models must mark a synced-superseded static model as unavailable"
    );
  });
});
