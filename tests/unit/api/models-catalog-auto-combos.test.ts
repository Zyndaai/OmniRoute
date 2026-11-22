// @ts-nocheck
// /v1/models catalog: the built-in `auto/*` combos (advertisement, suffix variants, modalities,
// hide / block / disable switches, empty-pool filtering) and the provider-grouped ordering contract.
//
// Merged from 9 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// resets the database and the catalog cache in its own hooks (the former files each started from a
// fresh process); the database handle is closed once at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-catalog-auto-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-auto-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const advertisedAuto = await import("../../../src/app/api/v1/models/autoCatalogIds.ts");
const combosAutoRoute = await import("../../../src/app/api/combos/auto/route.ts");
const suffix = await import("../../../open-sse/services/autoCombo/suffixComposition.ts");
const modePacks = await import("../../../open-sse/services/autoCombo/modePacks.ts");
const builtinCatalog = await import("../../../open-sse/services/autoCombo/builtinCatalog.ts");
const autoPrefix = await import("../../../open-sse/services/autoCombo/autoPrefix.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

after(async () => {
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("11947-auto-combo-modalities", () => {
  /**
   * #11947 — built-in auto combo entries in /v1/models must include
   * `capabilities.vision`, `input_modalities`, and `output_modalities` when
   * every model in the effective target pool supports those modalities.
   *
   * The dashboard/combos page already computes the correct LCD-aggregated
   * capabilities (e.g. shows vision tags), but before this fix the catalog
   * serialization for auto/* entries hardcoded a baseline capabilities map
   * without vision/modalities — so OpenAI-compatible clients (e.g. OpenCode)
   * could not detect vision support for combo models.
   */
  const catalog = v1ModelsCatalog;

  type CatalogEntry = {
    id: string;
    owned_by?: string;
    capabilities?: Record<string, boolean | string[]>;
    input_modalities?: string[];
    output_modalities?: string[];
    context_length?: number;
  };

  async function resetStorage(): Promise<void> {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("11947 auto entries include capabilities object (baseline)", async () => {
    // Baseline: every auto entry must at minimum carry a capabilities object
    // with the hardcoded baseline fields. This is the pre-existing behavior from
    // #4189 — the fix must not regress it.
    await settingsDb.updateSettings({ requireLogin: false });
    for (const provider of ["openai", "anthropic", "gemini", "groq", "deepseek", "mistral"]) {
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        apiKey: `sk-test-11947-${provider}`,
        name: `test-11947-${provider}`,
        isActive: true,
      });
    }
    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: CatalogEntry[] };
    const isAutoId = (id: string) => id === "auto" || id.startsWith("auto/");
    const autoEntries = body.data.filter((m) => isAutoId(m.id));
    assert.ok(autoEntries.length > 0, "sanity: at least one auto entry listed");
    assert.ok(
      autoEntries.some((m) => m.id === "auto"),
      "the bare auto id is advertised with the same baseline block"
    );

    for (const entry of autoEntries) {
      assert.ok(
        entry.capabilities && typeof entry.capabilities === "object",
        `${entry.id} must have a capabilities object`
      );
      assert.equal(entry.capabilities?.tool_calling, true, `${entry.id} tool_calling`);
      assert.equal(entry.capabilities?.reasoning, true, `${entry.id} reasoning`);
    }
  });

  test("#11947 auto/* vision entries carry capabilities.vision when pool is vision-capable", async () => {
    // The vision auto combos (auto/best-vision, auto/pro-vision, auto/vision)
    // filter their candidate pool to only vision-capable models. When the pool
    // resolves with vision metadata available, the catalog entry must surface
    // capabilities.vision so clients can detect multimodal support.
    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: CatalogEntry[] };

    const visionAutoIds = ["auto/best-vision", "auto/pro-vision", "auto/vision"];
    const visionEntries = body.data.filter((m) => visionAutoIds.includes(m.id));

    // Not every test environment will materialize all vision auto combos (depends
    // on available noAuth providers), so we only assert on entries that exist.
    for (const entry of visionEntries) {
      // When the pool has vision-capable models with known modalities, the entry
      // must include them. If vision is present, modalities should also be present.
      if (entry.capabilities?.vision === true) {
        assert.ok(
          Array.isArray(entry.input_modalities) && entry.input_modalities.includes("image"),
          `${entry.id} with vision:true must include "image" in input_modalities`
        );
        assert.ok(
          Array.isArray(entry.output_modalities) && entry.output_modalities.length > 0,
          `${entry.id} with vision:true must include output_modalities`
        );
      }
    }
  });

  test("#11947 user-defined combo with vision targets includes modalities in catalog", async () => {
    // Use a user-defined combo targeting a known vision model to verify the LCD
    // aggregation emits modalities. This tests the buildComboCatalogMetadata path
    // which the auto/* path now mirrors.
    const { saveModelsDevCapabilities } = await import("../../../src/lib/modelsDevSync.ts");

    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-11947-vision-test",
      apiKey: "test-key-11947",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });

    // Seed synced capabilities marking gpt-4o as vision-capable with image modalities.
    await saveModelsDevCapabilities({
      openai: {
        "gpt-4o": {
          tool_call: true,
          reasoning: false,
          attachment: true,
          structured_output: true,
          temperature: true,
          modalities_input: JSON.stringify(["text", "image"]),
          modalities_output: JSON.stringify(["text"]),
          knowledge_cutoff: null,
          release_date: null,
          last_updated: null,
          status: null,
          family: null,
          open_weights: false,
          limit_context: 128000,
          limit_input: 128000,
          limit_output: 16384,
          interleaved_field: null,
        },
      },
    });

    await combosDb.createCombo({
      name: "test-vision-combo-11947",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });

    const response = await catalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: CatalogEntry[] };
    const combo = body.data.find((m) => m.id === "test-vision-combo-11947");

    assert.ok(combo, "the user-defined vision combo must be listed");
    assert.ok(combo.capabilities?.vision === true, "combo capabilities must include vision: true");
    assert.ok(
      Array.isArray(combo.input_modalities) && combo.input_modalities.includes("image"),
      "combo must include 'image' in input_modalities"
    );
    assert.ok(
      Array.isArray(combo.output_modalities) && combo.output_modalities.includes("text"),
      "combo must include 'text' in output_modalities"
    );
  });
});

describe("auto-combos-suffixes-4235", () => {
  /**
   * #4235 Phase B — OpenRouter-style `auto/<category>:<tier>` suffix combos.
   *
   * Covers the pure composition layer (parse + tier→weights + candidate filter) and
   * the end-to-end advertisement of the curated suffix combos in `/v1/models`.
   */
  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  // Auto combos with zero candidates are no longer advertised — seed providers
  // so the materialized pools are non-empty where a matching model exists.
  async function seedProviders() {
    await settingsDb.updateSettings({ requireLogin: false });
    for (const provider of ["openai", "anthropic", "gemini", "groq", "deepseek", "mistral"]) {
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        apiKey: `sk-test-4235-${provider}`,
        name: `test-4235-${provider}`,
        isActive: true,
      });
    }
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#4235 parseAutoSuffix parses category and category:tier", () => {
    assert.deepEqual(suffix.parseAutoSuffix("coding:fast"), {
      valid: true,
      category: "coding",
      tier: "fast",
    });
    assert.deepEqual(suffix.parseAutoSuffix("vision"), { valid: true, category: "vision" });
    assert.deepEqual(suffix.parseAutoSuffix("reasoning:pro"), {
      valid: true,
      category: "reasoning",
      tier: "pro",
    });
    // floor is an accepted tier alias of cheap
    assert.equal(suffix.parseAutoSuffix("coding:floor").valid, true);
  });

  test("#4235 parseAutoSuffix rejects unknown categories/tiers and malformed input", () => {
    assert.equal(suffix.parseAutoSuffix("coding:bogus").valid, false);
    assert.equal(suffix.parseAutoSuffix("bogus:fast").valid, false);
    assert.equal(suffix.parseAutoSuffix("coding:fast:extra").valid, false);
    // a bare flat-variant token (fast/cheap/smart) is NOT a category — left to parseAutoPrefix
    assert.equal(suffix.parseAutoSuffix("fast").valid, false);
    assert.equal(suffix.parseAutoSuffix("").valid, false);
  });

  test("#4235 tierToWeightVariant maps tiers to scoring profiles", () => {
    assert.equal(suffix.tierToWeightVariant("fast"), "fast");
    assert.equal(suffix.tierToWeightVariant("cheap"), "cheap");
    assert.equal(suffix.tierToWeightVariant("floor"), "cheap");
    assert.equal(suffix.tierToWeightVariant("reliable"), "reliability");
    // free/pro carry no weight bias — the candidate filter does the work
    assert.equal(suffix.tierToWeightVariant("free"), undefined);
    assert.equal(suffix.tierToWeightVariant("pro"), undefined);
    assert.equal(suffix.tierToWeightVariant(undefined), undefined);
  });

  test("#4235 buildAutoCandidateFilter only filters when a constraint applies", () => {
    // coding/chat with no tier → no narrowing
    assert.equal(suffix.buildAutoCandidateFilter("coding", undefined), null);
    assert.equal(suffix.buildAutoCandidateFilter("chat", undefined), null);
    // category constraints (vision/reasoning/multimodal) and tier constraints (free/pro) → a filter fn
    assert.equal(typeof suffix.buildAutoCandidateFilter("vision", undefined), "function");
    assert.equal(typeof suffix.buildAutoCandidateFilter("reasoning", undefined), "function");
    assert.equal(typeof suffix.buildAutoCandidateFilter(undefined, "free"), "function");
    assert.equal(typeof suffix.buildAutoCandidateFilter("coding", "pro"), "function");
  });

  test("#4235 reliability-first mode pack exists and is normalized", () => {
    const pack = modePacks.MODE_PACKS["reliability-first"];
    assert.ok(pack, "reliability-first pack registered");
    const sum = Object.values(pack).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.01, `reliability-first weights sum to ~1.0 (got ${sum})`);
    // health + stability should dominate
    assert.ok(pack.health >= 0.3, "reliability-first leans on circuit-breaker health");
  });

  test("every pack carries quality>0 and reliability>0", () => {
    for (const [name, w] of Object.entries(modePacks.MODE_PACKS)) {
      const weights = w as { quality?: unknown; reliability?: unknown } & Record<string, unknown>;
      assert.ok(Number(weights.quality) > 0, `${name} quality>0`);
      assert.ok(Number(weights.reliability) > 0, `${name} reliability>0`);
      const sum = Object.values(weights).reduce((a: number, b: unknown) => a + Number(b), 0);
      assert.ok(Math.abs(sum - 0.9999) < 0.002, `${name} sum ~0.9999 got ${sum}`);
    }
  });

  // The tier weight overlay only applies to a non-empty pool (an empty pool returns
  // DEFAULT_WEIGHTS early). Since #15979 the keyless opencode pool is ToS-avoid and
  // excluded by default, so seed real connections instead of relying on it.
  test("#4235 createBuiltinAutoCombo composes tier weights for auto/coding:fast", async () => {
    await seedProviders();
    const combo = await builtinCatalog.createBuiltinAutoCombo("auto/coding:fast", "coding:fast");
    assert.ok(combo.models.length > 0, "auto/coding:fast must materialize candidates");
    assert.equal(combo.id, "auto/coding:fast");
    assert.equal(combo.strategy, "auto");
    assert.deepEqual(combo.weights, modePacks.MODE_PACKS["ship-fast"]);
    // The tier mapping resolves through the weight packs: the :fast tier must
    // follow the same pack the factory uses for the ship-fast mapping, and
    // :reliable the reliability-first mapping. Pinned by pack name via the
    // factory's own selection (tierToWeightVariant), not a numeric snapshot —
    // pack contents evolve as scoring factors are added.
    const { tierToWeightVariant } =
      await import("../../../open-sse/services/autoCombo/suffixComposition.ts");
    assert.equal(tierToWeightVariant("fast"), "fast");
    assert.equal(tierToWeightVariant("reliable"), "reliability");
    assert.ok(modePacks.MODE_PACKS["ship-fast"], "the ship-fast pack backs :fast");
    assert.ok(
      modePacks.MODE_PACKS["reliability-first"],
      "the reliability-first pack backs :reliable"
    );
  });

  test("#4235 createBuiltinAutoCombo composes reliability weights for auto/coding:reliable", async () => {
    await seedProviders();
    const combo = await builtinCatalog.createBuiltinAutoCombo(
      "auto/coding:reliable",
      "coding:reliable"
    );
    assert.ok(combo.models.length > 0, "auto/coding:reliable must materialize candidates");
    assert.equal(combo.id, "auto/coding:reliable");
    assert.equal(combo.strategy, "auto");
    assert.deepEqual(combo.weights, modePacks.MODE_PACKS["reliability-first"]);
  });

  test("4235 /v1/models advertises the curated auto/<category>:<tier> combos with candidates", async () => {
    await seedProviders();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
    const ids = new Set(body.data.map((m) => m.id));

    // An auto id is advertised iff its materialized pool is non-empty — ids
    // with zero candidates must be absent. The oracle iterates the source
    // suffix list plus the derived auto/lkgp id (kept independent of the
    // catalog derivation so a regression dropping a suffix still fails here).
    for (const autoId of [...builtinCatalog.AUTO_SUFFIX_VARIANTS, "auto/lkgp"]) {
      const virtual = await builtinCatalog.createBuiltinAutoCombo(
        autoId,
        autoId.slice("auto/".length)
      );
      assert.equal(
        ids.has(autoId),
        virtual.models.length > 0,
        `${autoId} must be advertised iff it has candidates (pool=${virtual.models.length})`
      );
    }
    const codingFast = body.data.find((m) => m.id === "auto/coding:fast");
    assert.equal(codingFast?.owned_by, "combo");
  });
});

describe("catalog-auto-routing-disabled-10831", () => {
  /**
   * #10831 — when auto routing is switched off, `auto/*` ids must not be
   * advertised in `/v1/models`.
   *
   * Unlike `hideAutoCombos` (#9418), which only unadvertises ids that still route
   * when a client sends them explicitly, `autoRoutingEnabled: false` makes the
   * router reject every `auto/*` id with
   * "Auto routing is disabled. Enable it in Settings > Routing." (see
   * src/sse/handlers/autoRouting.ts). Listing them therefore offers the picker a
   * choice that can only fail.
   */
  async function fetchCatalog(): Promise<Array<{ id: string }>> {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { method: "GET" })
    );
    if (res.status !== 200) {
      const body = await res.text();
      assert.fail(`Expected 200, got ${res.status}: ${body.slice(0, 500)}`);
    }
    const body = (await res.json()) as { data: Array<{ id: string }> };
    return body.data;
  }

  const isAutoId = (m: { id: string }) => m.id === "auto" || m.id.startsWith("auto/");

  // The former file ran on a fresh database and an empty catalog cache; its two tests share
  // state (the second reuses the connection the first one creates).
  before(async () => {
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  });

  test("autoRoutingEnabled=false removes auto/* ids from /v1/models", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-main",
      apiKey: "sk-test",
      isActive: true,
    });

    // Baseline: routing on, ids advertised (including the bare default id).
    await settingsDb.updateSettings({ autoRoutingEnabled: true, hideAutoCombos: false });
    const on = await fetchCatalog();
    const autoWhenOn = on.filter(isAutoId).map((m) => m.id);
    assert.equal(
      autoWhenOn.length > 0,
      true,
      `expected auto ids while auto routing is enabled, got ${autoWhenOn.length}`
    );
    assert.ok(
      autoWhenOn.includes("auto"),
      "the bare auto id must be advertised while routing is enabled"
    );

    // Routing off: none may remain.
    await settingsDb.updateSettings({ autoRoutingEnabled: false, hideAutoCombos: false });
    const off = await fetchCatalog();
    const leaked = off.filter(isAutoId).map((m) => m.id);
    assert.deepEqual(
      leaked,
      [],
      `auto ids leaked while auto routing is disabled: ${leaked.join(", ")}`
    );

    // Everything else must survive — this is a filter, not a catalog wipe.
    const hasProviderModel = off.some((m) => m.id.startsWith("openai/") || m.id.startsWith("oa/"));
    assert.equal(
      hasProviderModel,
      true,
      "provider models must remain when auto routing is disabled"
    );
  });

  test("re-enabling auto routing brings auto/* ids back (cache key varies on the flag)", async () => {
    await settingsDb.updateSettings({ autoRoutingEnabled: false, hideAutoCombos: false });
    const off = await fetchCatalog();
    assert.deepEqual(
      off.filter(isAutoId).map((m) => m.id),
      []
    );

    await settingsDb.updateSettings({ autoRoutingEnabled: true, hideAutoCombos: false });
    const back = await fetchCatalog();
    assert.equal(
      back.filter(isAutoId).length > 0,
      true,
      "auto ids must return once auto routing is re-enabled — a stale cached catalog would fail here"
    );
    assert.ok(
      back.some((m) => m.id === "auto"),
      "the bare auto id must return once auto routing is re-enabled"
    );
  });
});

describe("catalog-hide-auto-no-think", () => {
  /**
   * #9418 — `hideAutoCombos` and `hideNoThinkVariants` settings toggles filter
   * built-in `auto/*` virtual combos and `no-think/*` gateway variants from the
   * unified `/v1/models` catalog. Default false (opt-in, Rule #20 spirit).
   * Rule #18 regression guard for both toggles.
   */
  async function fetchCatalog(): Promise<Array<{ id: string; type?: string }>> {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { method: "GET" })
    );
    if (res.status !== 200) {
      const body = await res.text();
      assert.fail(`Expected 200, got ${res.status}: ${body.slice(0, 500)}`);
    }
    const body = (await res.json()) as { data: Array<{ id: string; type?: string }> };
    return body.data;
  }

  // The former file ran on a fresh database and an empty catalog cache; its tests share state.
  before(async () => {
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  });

  test("hideAutoCombos and hideNoThinkVariants default to false", async () => {
    const defaults = await settingsDb.getSettings();
    assert.equal(defaults.hideAutoCombos, false, "hideAutoCombos default must be false");
    assert.equal(defaults.hideNoThinkVariants, false, "hideNoThinkVariants default must be false");
  });

  test("hideAutoCombos=true removes auto/* ids from /v1/models", async () => {
    // Ensure at least one provider connection exists so the catalog has content
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-main",
      apiKey: "sk-test",
      isActive: true,
    });

    const isAutoId = (m: { id: string }) => m.id === "auto" || m.id.startsWith("auto/");

    await settingsDb.updateSettings({ hideAutoCombos: false, hideNoThinkVariants: false });
    const off = await fetchCatalog();
    const autoWhenOff = off.filter(isAutoId).map((m) => m.id);
    assert.equal(
      autoWhenOff.length > 0,
      true,
      `expected auto ids when toggle off, got ${autoWhenOff.length}`
    );
    assert.ok(
      autoWhenOff.includes("auto"),
      "the bare auto id must be advertised when the toggle is off"
    );

    await settingsDb.updateSettings({ hideAutoCombos: true, hideNoThinkVariants: false });
    const on = await fetchCatalog();
    const leaked = on.filter(isAutoId).map((m) => m.id);
    assert.deepEqual(
      leaked,
      [],
      `auto/* ids leaked when hideAutoCombos=true: ${leaked.join(", ")}`
    );

    // Original provider models must still be present
    const hasProviderModel = on.some((m) => m.id.startsWith("openai/") || m.id.startsWith("oa/"));
    assert.equal(
      hasProviderModel,
      true,
      "original provider models must remain when hideAutoCombos=true"
    );
  });

  test("hideNoThinkVariants=true removes no-think/* ids from /v1/models", async () => {
    // Add a claude provider connection so the catalog has no-think/* variants
    // (no-thinking variants are generated for Claude-family models that support thinking)
    await providersDb.createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "claude-main",
      apiKey: "sk-ant-test",
      isActive: true,
    });

    const isNoThinkId = (m: { id: string }) => m.id.startsWith("no-think/");

    await settingsDb.updateSettings({ hideAutoCombos: false, hideNoThinkVariants: false });
    const off = await fetchCatalog();
    const noThinkWhenOff = off.filter(isNoThinkId).map((m) => m.id);
    // If no no-think/* ids are present in the baseline catalog, the filter is
    // trivially correct — just verify the toggle doesn't break anything.
    if (noThinkWhenOff.length === 0) {
      // No no-think/* ids to filter — verify the toggle doesn't remove other models
      await settingsDb.updateSettings({ hideAutoCombos: false, hideNoThinkVariants: true });
      const on = await fetchCatalog();
      const hasProviderModel = on.some(
        (m) => m.id.startsWith("claude/") || m.id.startsWith("anthropic/")
      );
      assert.equal(
        hasProviderModel,
        true,
        "original provider models must remain when hideNoThinkVariants=true"
      );
      return;
    }

    await settingsDb.updateSettings({ hideAutoCombos: false, hideNoThinkVariants: true });
    const on = await fetchCatalog();
    const leaked = on.filter(isNoThinkId).map((m) => m.id);
    assert.deepEqual(
      leaked,
      [],
      `no-think/* ids leaked when hideNoThinkVariants=true: ${leaked.join(", ")}`
    );

    // Original provider models must still be present
    const hasProviderModel = on.some(
      (m) => m.id.startsWith("claude/") || m.id.startsWith("anthropic/")
    );
    assert.equal(
      hasProviderModel,
      true,
      "original provider models must remain when hideNoThinkVariants=true"
    );
  });

  test("both toggles on: neither auto nor no-think/* appear; original models present", async () => {
    const isAutoId = (m: { id: string }) => m.id === "auto" || m.id.startsWith("auto/");
    const isNoThinkId = (m: { id: string }) => m.id.startsWith("no-think/");
    await settingsDb.updateSettings({ hideAutoCombos: true, hideNoThinkVariants: true });
    const on = await fetchCatalog();
    const autoLeaked = on.filter(isAutoId).map((m) => m.id);
    const noThinkLeaked = on.filter(isNoThinkId).map((m) => m.id);
    assert.deepEqual(autoLeaked, [], `auto/* ids leaked: ${autoLeaked.join(", ")}`);
    assert.deepEqual(noThinkLeaked, [], `no-think/* ids leaked: ${noThinkLeaked.join(", ")}`);

    const hasProviderModel = on.some(
      (m) =>
        m.id.startsWith("openai/") ||
        m.id.startsWith("oa/") ||
        m.id.startsWith("claude/") ||
        m.id.startsWith("anthropic/")
    );
    assert.equal(
      hasProviderModel,
      true,
      "original provider models must remain when both toggles are on"
    );
  });
});

describe("models-catalog-auto-combos-4164", () => {
  /**
   * #4164 — the built-in `auto/*` combos must be advertised in `/v1/models`.
   *
   * OmniRoute ships a zero-setup `auto/*` catalog (auto/best-coding, auto/pro-
   * reasoning, …) that the dashboard advertises and that resolve on demand via
   * createBuiltinAutoCombo. But the `/v1/models` listing only emitted persisted DB
   * combos + provider models, so clients that build their model picker from
   * `/v1/models` (e.g. Hermes Agent) never saw any `auto/*` option.
   *
   * The catalog now emits every AUTO_TEMPLATE_VARIANTS id at the top of the list.
   */
  async function resetStorage() {
    await resetTestDb();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  // Auto combos with zero candidates are no longer advertised — these tests must
  // seed providers so the materialized pools are non-empty.
  async function seedProviders() {
    await settingsDb.updateSettings({ requireLogin: false });
    for (const provider of ["openai", "anthropic", "gemini", "groq", "deepseek", "mistral"]) {
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        apiKey: `sk-test-4164-${provider}`,
        name: `test-4164-${provider}`,
        isActive: true,
      });
    }
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#4164 /v1/models advertises exactly the built-in auto/* combos with candidates", async () => {
    await seedProviders();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };

    const ids = new Set(body.data.map((m) => m.id));
    const expected = advertisedAuto.getAdvertisedAutoIds();
    assert.ok(expected.length > 0, "sanity: there are built-in auto ids");

    // New contract: an auto id is advertised iff its materialized pool is
    // non-empty — ids with zero candidates must be absent.
    for (const autoId of expected) {
      const virtual = await advertisedAuto.materializeAdvertisedAutoCombo(
        autoId,
        autoId.replace(/^auto\/?/, "")
      );
      assert.equal(
        ids.has(autoId),
        virtual.models.length > 0,
        `${autoId} must be advertised iff it has candidates (pool=${virtual.models.length})`
      );
    }

    // Spot-check a couple of well-known ones and their owner tag.
    const bestCoding = body.data.find((m) => m.id === "auto/best-coding");
    assert.ok(bestCoding, "auto/best-coding should be listed");
    assert.equal(bestCoding?.owned_by, "combo");
  });

  test("#4164 auto/* combos appear at the top of the list", async () => {
    await seedProviders();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };

    // The advertised auto block stays at the top: the first N entries (N =
    // number of emitted auto ids) should all be auto ids.
    const isAutoId = (id: string) => id === "auto" || id.startsWith("auto/");
    const autoCount = body.data.filter((m) => isAutoId(m.id)).length;
    assert.ok(autoCount > 0, "sanity: seeded pool should yield auto entries");
    const head = body.data.slice(0, autoCount).map((m) => m.id);
    for (const id of head) {
      assert.match(id, /^auto(\/|$)/, `top-of-list entry ${id} should be an auto combo`);
    }
  });

  test("#4164 no duplicate auto ids even if a persisted combo shadows one", async () => {
    // Defensive: even if a DB combo were named like an auto id, the listing must
    // not emit the id twice.
    await seedProviders();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const autoIds = body.data
      .map((m) => m.id)
      .filter((id) => id === "auto" || id.startsWith("auto/"));
    assert.equal(autoIds.length, new Set(autoIds).size, "auto ids must be unique");
  });

  test("#4189 every auto/* entry exposes token limits + baseline capabilities", async () => {
    // #4164 emitted a bare auto/* entry (no token metadata). #4189 enriches each with
    // the combo's advertised context/output limits + baseline capabilities so
    // OpenAI-compatible clients that build their picker from /v1/models get a context
    // window before the first request. Without the fix these fields are absent.
    await seedProviders();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      data: Array<{
        id: string;
        context_length?: number;
        max_input_tokens?: number;
        max_output_tokens?: number;
        capabilities?: Record<string, boolean>;
      }>;
    };

    const autoEntries = body.data.filter((m) => m.id === "auto" || m.id.startsWith("auto/"));
    assert.ok(autoEntries.length > 0, "sanity: at least one auto entry is listed");

    for (const entry of autoEntries) {
      assert.equal(
        typeof entry.context_length,
        "number",
        `${entry.id} must expose a numeric context_length`
      );
      assert.ok((entry.context_length ?? 0) > 0, `${entry.id} context_length must be positive`);
      assert.equal(
        typeof entry.max_input_tokens,
        "number",
        `${entry.id} must expose max_input_tokens`
      );
      assert.equal(
        typeof entry.max_output_tokens,
        "number",
        `${entry.id} must expose max_output_tokens`
      );
      assert.ok(
        (entry.max_output_tokens ?? 0) > 0,
        `${entry.id} max_output_tokens must be positive`
      );
      assert.ok(
        entry.capabilities && typeof entry.capabilities === "object",
        `${entry.id} must expose a capabilities map`
      );
    }
  });
});

describe("models-catalog-auto-default-variant", () => {
  /**
   * The routable `auto` and `auto/lkgp` ids must be advertised in `/v1/models`.
   *
   * `parseAutoPrefix` accepts `auto` and every `auto/<variant>` in
   * `VALID_VARIANTS`, and the router materializes them on demand — but the
   * catalog loop only enumerates the template, suffix and family lists, so the
   * two ids are routable yet invisible to clients building their picker from
   * `/v1/models`. The catalog must announce every id the parser deems valid
   * (or exclude it explicitly), with the pool limits.
   */
  const autoIds = advertisedAuto;

  type CatalogEntry = {
    id: string;
    owned_by?: string;
    context_length?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
  };

  async function resetStorage() {
    await resetTestDb();
    core.resetDbInstance();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    await settingsDb.updateSettings({ requireLogin: false });
  }

  async function seedProviders() {
    for (const provider of ["openai", "anthropic", "gemini", "groq", "deepseek", "mistral"]) {
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        apiKey: `sk-test-autodefault-${provider}`,
        name: `test-autodefault-${provider}`,
        isActive: true,
      });
    }
  }

  async function fetchCatalog(headers?: Record<string, string>): Promise<CatalogEntry[]> {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { headers })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: CatalogEntry[] };
    return body.data;
  }

  function assertLimits(entry: CatalogEntry | undefined, id: string) {
    assert.ok(entry, `${id} must be listed`);
    assert.equal(typeof entry?.context_length, "number", `${id} must expose context_length`);
    assert.ok((entry?.context_length ?? 0) > 0, `${id} context_length must be positive`);
    assert.equal(typeof entry?.max_output_tokens, "number", `${id} must expose max_output_tokens`);
    assert.ok((entry?.max_output_tokens ?? 0) > 0, `${id} max_output_tokens must be positive`);
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("catalog derivation announces the bare default id with pool limits", async () => {
    await seedProviders();
    const advertised = autoIds.getAdvertisedAutoIds();
    assert.ok(advertised.includes("auto"), "the derivation must include the bare default id");
    const data = await fetchCatalog();
    assertLimits(
      data.find((m) => m.id === "auto"),
      "auto"
    );
  });

  test("catalog derivation announces auto/lkgp with pool limits", async () => {
    assert.ok(
      autoPrefix.VALID_VARIANTS.includes("lkgp"),
      "sanity: lkgp is a valid variant at the parser"
    );
    assert.ok(
      autoPrefix.parseAutoPrefix("auto/lkgp").valid,
      "sanity: auto/lkgp routes when sent explicitly"
    );
    await seedProviders();
    const advertised = autoIds.getAdvertisedAutoIds();
    assert.ok(advertised.includes("auto/lkgp"), "the derivation must include auto/lkgp");
    const data = await fetchCatalog();
    assertLimits(
      data.find((m) => m.id === "auto/lkgp"),
      "auto/lkgp"
    );
  });

  test("hideAutoCombos keeps the two ids unadvertised while they stay routable", async () => {
    await seedProviders();
    await settingsDb.updateSettings({ hideAutoCombos: true });
    const data = await fetchCatalog();
    const ids = new Set(data.map((m) => m.id));
    assert.equal(ids.has("auto"), false, "auto must not be advertised when hidden");
    assert.equal(ids.has("auto/lkgp"), false, "auto/lkgp must not be advertised when hidden");
    assert.ok(autoPrefix.parseAutoPrefix("auto").valid, "auto stays routable when sent explicitly");
    assert.ok(
      autoPrefix.parseAutoPrefix("auto/lkgp").valid,
      "auto/lkgp stays routable when sent explicitly"
    );
  });

  test("a key with allowAutoCombos=false is not offered the two ids", async () => {
    await seedProviders();
    const key = await apiKeysDb.createApiKey("auto-default-denied", "machine-auto-default");
    await apiKeysDb.updateApiKeyPermissions(key.id, { allowAutoCombos: false });
    const data = await fetchCatalog({ Authorization: `Bearer ${key.key}` });
    const ids = new Set(data.map((m) => m.id));
    assert.equal(ids.has("auto"), false, "auto must not be offered to an opted-out key");
    assert.equal(ids.has("auto/lkgp"), false, "auto/lkgp must not be offered to an opted-out key");
    assert.ok(data.length > 0, "the catalog must still list other models for the opted-out key");
  });

  test("hidePaidModels keeps both ids advertised (neither is a paid tier)", async () => {
    assert.equal(builtinCatalog.isPaidTierAutoId("auto"), false);
    assert.equal(builtinCatalog.isPaidTierAutoId("auto/lkgp"), false);
    await seedProviders();
    await settingsDb.updateSettings({ hidePaidModels: true });
    const data = await fetchCatalog();
    assertLimits(
      data.find((m) => m.id === "auto"),
      "auto"
    );
    assertLimits(
      data.find((m) => m.id === "auto/lkgp"),
      "auto/lkgp"
    );
  });

  test("a stored combo named auto does not shadow the built-in entry", async () => {
    await seedProviders();
    await combosDb.createCombo({
      name: "auto",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });
    const data = await fetchCatalog();
    const matches = data.filter((m) => m.id === "auto");
    assert.equal(matches.length, 1, "exactly one auto entry must be listed");
    assert.equal(matches[0]?.owned_by, "combo", "the built-in entry wins over the stored combo");
    assertLimits(matches[0], "auto");
  });
});

describe("models-catalog-block-auto-5192", () => {
  /**
   * #5192 — Blocking the "Auto (Zero-Config)" provider in Security settings must
   * remove the built-in `auto/*` combos from the `/v1/models` listing.
   *
   * The catalog advertises the built-in `auto/*` combos (#4164 / #4235) at the top
   * of `/v1/models`, but that injection loop ignored `settings.blockedProviders`,
   * so checking "Auto (Zero-Config)" in Security → Blocked Providers had no effect:
   * the model picker still showed `auto/*` entries. Blocking the system provider id
   * `auto` (its id and alias are both "auto") must suppress the whole `auto/*` block.
   */
  type ModelsResponseBody = { data: Array<{ id: string }> };

  async function resetStorage() {
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  async function getIds(): Promise<Set<string>> {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as ModelsResponseBody;
    return new Set(body.data.map((item) => item.id));
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#5192 baseline: built-in auto/* combos are listed when Auto is not blocked", async () => {
    // Combos with zero candidates are filtered from the catalog — seed providers
    // so auto/best-coding + auto/coding materialize with a non-empty pool.
    for (const provider of ["openai", "anthropic", "gemini", "groq", "deepseek", "mistral"]) {
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        apiKey: `sk-test-5192-${provider}`,
        name: `test-5192-${provider}`,
        isActive: true,
      });
    }
    const ids = await getIds();
    assert.ok(ids.has("auto/best-coding"), "auto/best-coding should be listed by default");
    assert.ok(ids.has("auto/coding"), "auto/coding should be listed by default");
  });

  test("#5192: blocking the Auto (Zero-Config) provider removes all auto/* combos", async () => {
    await settingsDb.updateSettings({ blockedProviders: ["auto"] });
    const ids = await getIds();
    const leaked = [...ids].filter((id) => id === "auto" || id.startsWith("auto/"));
    assert.deepEqual(
      leaked,
      [],
      `no auto/* combos should be listed when Auto is blocked, but got: ${leaked.join(", ")}`
    );
  });

  test("#5192: blocking via the 'auto' alias is honored too", async () => {
    // id and alias are both "auto"; the Security UI stores whichever the user clicked.
    await settingsDb.updateSettings({ blockedProviders: ["auto"] });
    const ids = await getIds();
    assert.equal(ids.has("auto/smart"), false, "auto/smart must be absent when Auto is blocked");
  });
});

describe("combos-auto-hide-empty-candidates", () => {
  /**
   * Auto combos with no live candidates must not be listed.
   *
   * `/api/combos/auto` (dashboard catalog source) and `/v1/models` (client-facing
   * catalog) advertised every built-in `auto/*` id unconditionally, including
   * families/categories with zero connected providers — cards showed "No matching
   * providers" and clients got ids that can never dispatch. Both listings now
   * skip combos whose materialized candidate pool is empty.
   *
   * Note: `opencode` is a no-auth provider, so even an "empty" DB has candidates
   * for the unconstrained combos (auto, auto/coding, ...) and for families its
   * oc/* models match (auto/mimo, auto/deepseek). Families with no matching
   * connected model — auto/minimax, auto/zai — still come back with an empty
   * pool and are the reliable negative cases.
   */

  // Families with no matching models in any seeded registry — the materialized
  // pool is empty, so these ids must be filtered from every listing.
  const EMPTY_FAMILY_IDS = ["auto/minimax", "auto/zai"];

  const SEEDED_PROVIDERS = ["openai", "anthropic", "gemini", "groq", "deepseek", "mistral"];

  type ComboEntry = { id: string; candidateCount: number };

  async function listCombos(): Promise<ComboEntry[]> {
    const res = await combosAutoRoute.GET(new Request("http://localhost/api/combos/auto"));
    const body = (await res.json()) as { combos: ComboEntry[] };
    return body.combos;
  }

  async function listModelIds(): Promise<Set<string>> {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await res.json()) as { data: Array<{ id: string }> };
    return new Set(body.data.map((m) => m.id));
  }

  async function resetStorage() {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    await settingsDb.updateSettings({ requireLogin: false });
  }

  async function seedProviders(prefix: string) {
    for (const provider of SEEDED_PROVIDERS) {
      await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        apiKey: `sk-test-${prefix}-${provider}`,
        name: `test-${prefix}-${provider}`,
        isActive: true,
      });
    }
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("/api/combos/auto lists only combos with candidates", async () => {
    const combos = await listCombos();
    assert.ok(combos.length > 0, "the no-auth opencode pool should yield candidates");
    for (const combo of combos) {
      assert.ok(
        combo.candidateCount > 0,
        `${combo.id} listed with ${combo.candidateCount} candidates — empty combos must be filtered`
      );
    }
    const ids = new Set(combos.map((c) => c.id));
    for (const emptyId of EMPTY_FAMILY_IDS) {
      assert.ok(!ids.has(emptyId), `${emptyId} has no matching model — must not be listed`);
    }
  });

  test("/v1/models does not advertise auto/* ids without candidates", async () => {
    const ids = await listModelIds();
    for (const emptyId of EMPTY_FAMILY_IDS) {
      assert.ok(!ids.has(emptyId), `${emptyId} has an empty pool — must not be advertised`);
    }
    // The derived ids obey the same announced-iff-materializable contract:
    // advertised exactly when their pool is non-empty.
    for (const derivedId of ["auto", "auto/lkgp"]) {
      const virtual = await advertisedAuto.materializeAdvertisedAutoCombo(
        derivedId,
        derivedId.replace(/^auto\/?/, ""),
        undefined
      );
      assert.equal(
        ids.has(derivedId),
        virtual.models.length > 0,
        `${derivedId} must be advertised iff it has candidates (pool=${virtual.models.length})`
      );
    }
  });

  test("seeded pool: every listed combo has candidates, empty families stay hidden", async () => {
    await seedProviders("hide-empty");
    const combos = await listCombos();
    for (const combo of combos) {
      assert.ok(
        combo.candidateCount > 0,
        `${combo.id} listed with ${combo.candidateCount} candidates — empty combos must be filtered`
      );
    }
    const ids = new Set(combos.map((c) => c.id));
    assert.ok(ids.has("auto/gemini"), "auto/gemini has a seeded provider and must stay listed");
    for (const emptyId of EMPTY_FAMILY_IDS) {
      assert.ok(!ids.has(emptyId), `${emptyId} has no matching model — must not be listed`);
    }
  });

  test("seeded pool: /v1/models advertises auto/* ids that have candidates only", async () => {
    await seedProviders("hide-empty-v1");
    const ids = await listModelIds();
    assert.ok(
      ids.has("auto/gemini"),
      "auto/gemini has candidates (seeded gemini provider) and must be advertised"
    );
    for (const emptyId of EMPTY_FAMILY_IDS) {
      assert.ok(!ids.has(emptyId), `${emptyId} has an empty pool — must not be advertised`);
    }
  });
});

describe("catalog-order-contract", () => {
  /**
   * Provider-grouped ordering contract for the unified model catalog.
   *
   * Red-first: proves the current tree publishes fragmented provider blocks.
   * Uses the same DB module set and reset pattern as models-catalog-route.test.ts.
   * /api/models, quota-short-circuit, and inbound-alias cases are split into
   * separate files to avoid extra module imports that break the sql.js lifecycle.
   */
  async function resetStorage() {
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  beforeEach(async () => {
    await resetStorage();
  });

  async function seedConnection(provider: string, overrides: Record<string, unknown> = {}) {
    return providersDb.createProviderConnection({
      provider,
      authType: (overrides.authType as string) || "apikey",
      name: `${provider}-test-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: (overrides.apiKey as string) || "sk-test",
      accessToken: overrides.accessToken as string | undefined,
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    }) as Promise<{ id: string }>;
  }

  function countProviderBlocks(ownedBySequence: string[]): number {
    const blocks: string[] = [];
    for (const ownedBy of ownedBySequence) {
      if (blocks.length === 0 || blocks[blocks.length - 1] !== ownedBy) {
        blocks.push(ownedBy);
      }
    }
    return blocks.length;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Exact provider-grouped order: blocks === distinct owned_by
  // ─────────────────────────────────────────────────────────────────────────────

  test("catalog /v1/models: exact provider-grouped order (blocks === distinct owned_by)", async () => {
    // Seed 3 providers with synced models to guarantee fragmentation if unsorted.
    // The static registry also emits models for active providers, so the catalog
    // will contain rows from openai, anthropic, and opencode from multiple loops.
    const conn1 = await seedConnection("openai");
    const conn2 = await seedConnection("anthropic");
    const conn3 = await seedConnection("opencode");

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "openai",
      (conn1 as { id: string }).id,
      [
        { id: "gpt-4", name: "GPT-4" },
        { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
      ]
    );
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "anthropic",
      (conn2 as { id: string }).id,
      [{ id: "claude-3-opus", name: "Claude 3 Opus" }]
    );
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "opencode",
      (conn3 as { id: string }).id,
      [
        { id: "kimi-k2", name: "Kimi K2" },
        { id: "glm-4", name: "GLM-4" },
      ]
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models?configuredOnly=true")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ owned_by: string }> };

    // Guarantee rows from all 3 seeded providers are present
    const ownedByValues = body.data.map((m) => m.owned_by);
    const distinctOwnedBy = new Set(ownedByValues);
    assert.ok(distinctOwnedBy.has("openai"), "openai rows present");
    assert.ok(distinctOwnedBy.has("anthropic"), "anthropic rows present");
    assert.ok(distinctOwnedBy.has("opencode"), "opencode rows present");

    // Exact invariant: each provider appears in exactly one contiguous block
    const blockCount = countProviderBlocks(ownedByValues);
    assert.equal(
      blockCount,
      distinctOwnedBy.size,
      `Fragmented: ${blockCount} blocks for ${distinctOwnedBy.size} distinct providers. ` +
        `Sequence: ${ownedByValues.join(", ")}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Combo block pinned first
  // ─────────────────────────────────────────────────────────────────────────────

  test("catalog /v1/models: combo block appears first", async () => {
    const conn = await seedConnection("openai");
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "openai",
      (conn as { id: string }).id,
      [{ id: "gpt-4", name: "GPT-4" }]
    );
    await combosDb.createCombo({
      name: "test-combo",
      modelIds: ["openai/gpt-4"],
      strategy: "fallback",
      isActive: true,
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models?configuredOnly=true")
    );
    const body = (await response.json()) as { data: Array<{ owned_by: string }> };

    const hasCombo = body.data.some((m) => m.owned_by === "combo");
    const hasNonCombo = body.data.some((m) => m.owned_by !== "combo");
    assert.ok(hasCombo, "combo rows present");
    assert.ok(hasNonCombo, "non-combo rows present");

    const firstNonComboIndex = body.data.findIndex((m) => m.owned_by !== "combo");
    const lastComboIndex = body.data.map((m) => m.owned_by).lastIndexOf("combo");
    assert.ok(
      lastComboIndex < firstNonComboIndex,
      `Combo block not first: last combo at ${lastComboIndex}, first non-combo at ${firstNonComboIndex}`
    );
  });
});
