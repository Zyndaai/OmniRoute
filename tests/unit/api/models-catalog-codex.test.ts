// Codex in the /v1/models catalog and its account routing: per-account inventories, discovered
// reasoning tiers, the bare GPT-6 ids, the live-catalog route and the Codex CLI refresh shape.
//
// Merged from 6 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// resets the database, the API-key state and the catalog cache in its own hooks (each former file
// started from an empty store); the database handle is closed once at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-catalog-codex-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const { normalizeCodexModelsResponse, clearCodexGithubCatalogCacheForTests } =
  await import("../../../src/app/api/providers/[id]/models/discovery/codex.ts");
const { persistDiscoveredModels, getCachedDiscoveredModels } =
  await import("../../../src/lib/providerModels/modelDiscovery.ts");
const { mergeProviderModelListing } =
  await import("../../../src/lib/providers/mergeProviderModelListing.ts");
const { getModelInfo } = await import("../../../src/sse/services/model.ts");
const { resolveExecutionCredentials } =
  await import("../../../open-sse/handlers/chatCore/executionCredentials.ts");
const { CodexExecutor } = await import("../../../open-sse/executors/codex.ts");
const { CODEX_NATIVE_UNPREFIXED_MODELS, getModelInfoCore } =
  await import("../../../open-sse/services/model.ts");
const { getProviderModels } = await import("../../../open-sse/config/providerModels.ts");
const { getPricingForModel } = await import("../../../src/shared/constants/pricing.ts");
const { GET } = await import("../../../src/app/api/providers/[id]/models/route.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const catalogCacheMod = await import("../../../src/app/api/v1/models/catalogCache.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

/** Start a describe from an empty database, API-key state, data dir and catalog cache. */
async function resetAll() {
  await core.resetDbInstance();
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await catalogCacheMod.__flushCatalogBackgroundRefreshForTest();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("codex-account-catalog-routing", () => {
  const PROVIDER = "codex";

  async function createConnection(data: Record<string, unknown>): Promise<string> {
    const created = (await providersDb.createProviderConnection(data)) as { id: string };
    return created.id;
  }

  /** The connection id the selector handed back, or null if it returned no account. */
  function selectedConnectionId(selected: unknown): string | null {
    if (!selected || typeof selected !== "object") return null;
    const id = (selected as { connectionId?: unknown }).connectionId;
    return typeof id === "string" ? id : null;
  }

  /** Create accounts with shared and subscription-specific model inventories. */
  async function seedTwoAccounts(options: { proRateLimitedUntil?: string } = {}) {
    const proId = await createConnection({
      provider: PROVIDER,
      authType: "oauth",
      accessToken: "test-codex-token",
      name: "Pro account",
      priority: 1,
      isActive: true,
    });
    const plusId = await createConnection({
      provider: PROVIDER,
      authType: "oauth",
      accessToken: "test-codex-token",
      name: "Plus account",
      priority: 2,
      isActive: true,
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, proId, [
      { id: "gpt-shared-test", name: "gpt-shared-test" },
      { id: "gpt-pro-only-test", name: "gpt-pro-only-test" },
    ]);
    await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, plusId, [
      { id: "gpt-shared-test", name: "gpt-shared-test" },
    ]);

    if (options.proRateLimitedUntil) {
      await providersDb.updateProviderConnection(proId, {
        rateLimitedUntil: options.proRateLimitedUntil,
      });
    }

    return { proId, plusId };
  }

  beforeEach(resetAll);

  test("Codex selects only the account whose synced inventory advertises the model", async () => {
    const { proId, plusId } = await seedTwoAccounts();

    // Exclude pro to force the selector to look elsewhere. Plus account does not
    // advertise gpt-pro-only-test, so it must NOT be handed back.
    const selected = await auth.getProviderCredentials(PROVIDER, proId, null, "gpt-pro-only-test");

    assert.notEqual(
      selectedConnectionId(selected),
      plusId,
      "plus never synced gpt-pro-only-test and must not be selected for it"
    );
  });

  test("Codex does not preemptively fail over to an account lacking the model when the owner is cooling", async () => {
    const coolingUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { plusId } = await seedTwoAccounts({ proRateLimitedUntil: coolingUntil });

    const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-pro-only-test");

    assert.notEqual(
      selectedConnectionId(selected),
      plusId,
      "a cooling pro must surface a cooldown, not silently route to an account without the model"
    );
  });

  test("Codex keeps the connection that does advertise the model selectable", async () => {
    const { proId } = await seedTwoAccounts();

    const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-pro-only-test");

    assert.equal(
      selectedConnectionId(selected),
      proId,
      "pro advertises gpt-pro-only-test and must be selected"
    );
  });

  test("Codex a model advertised by every account leaves both connections eligible", async () => {
    const { proId, plusId } = await seedTwoAccounts();

    const first = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-shared-test");
    assert.equal(
      selectedConnectionId(first),
      proId,
      "fill-first prefers priority 1 for a shared model"
    );

    // Excluding pro (the normal account-fallback path) must still reach plus,
    // because plus genuinely advertises gpt-shared-test.
    const second = await auth.getProviderCredentials(PROVIDER, proId, null, "gpt-shared-test");
    assert.equal(
      selectedConnectionId(second),
      plusId,
      "plus advertises gpt-shared-test and must remain a valid failover"
    );
  });

  test("Codex does not fall back to an unsynchronized account once an inventory exists", async () => {
    const { proId, plusId } = await seedTwoAccounts();
    await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, plusId, []);
    const selected = await auth.getProviderCredentials(PROVIDER, proId, null, "gpt-pro-only-test");
    assert.equal(selectedConnectionId(selected), null);
  });

  test("Codex preserves bootstrap selection when no account has a synced catalog", async () => {
    const id = await createConnection({
      provider: PROVIDER,
      authType: "oauth",
      accessToken: "test-token",
      isActive: true,
    });
    assert.equal(
      selectedConnectionId(
        await auth.getProviderCredentials(PROVIDER, null, null, "gpt-shared-test")
      ),
      id
    );
  });

  test("Codex image models bypass the synced chat inventory (it never lists image models)", async () => {
    // The Codex live catalog (`/backend-api/codex/models`) only returns chat models, so a
    // synced Codex inventory never contains gpt-image-*. Filtering an image request against it
    // leaves no eligible account: /v1/images/generations -> "No credentials for image provider".
    const { proId } = await seedTwoAccounts();
    for (const imageModel of ["gpt-image-2", "gpt-image-2.5-flare"]) {
      const selected = await auth.getProviderCredentials(PROVIDER, null, null, imageModel);
      assert.equal(
        selectedConnectionId(selected),
        proId,
        `${imageModel} is a registered Codex image model and must not be filtered by the chat inventory`
      );
    }
  });

  test("Codex image models are not blocked by an empty account inventory; chat models still are", async () => {
    const { plusId } = await seedTwoAccounts();
    await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, plusId, []);
    assert.equal(
      selectedConnectionId(
        await auth.getProviderCredentials(PROVIDER, null, [plusId], "gpt-image-2")
      ),
      plusId
    );
    assert.equal(
      selectedConnectionId(
        await auth.getProviderCredentials(PROVIDER, null, [plusId], "gpt-pro-only-test")
      ),
      null,
      "chat models still honour the account inventory"
    );
  });

  test("Codex forced and API-key restricted selection cannot bypass the account inventory", async () => {
    const { plusId } = await seedTwoAccounts();
    const restricted = await auth.getProviderCredentials(
      PROVIDER,
      null,
      [plusId],
      "gpt-pro-only-test"
    );
    assert.equal(selectedConnectionId(restricted), null);
    const pinned = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-pro-only-test", {
      forcedConnectionId: plusId,
    });
    assert.equal(selectedConnectionId(pinned), null);
  });

  test("the public catalog keeps the union of active Codex account inventories", async () => {
    await seedTwoAccounts();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = new Set(body.data.map((model) => model.id));
    assert.ok(ids.has("cx/gpt-pro-only-test"));
    assert.ok(ids.has("cx/gpt-shared-test"));
  });

  test("Codex reasoning-suffix aliases select the account that advertises the base model", async () => {
    const proId = await createConnection({
      provider: PROVIDER,
      authType: "oauth",
      accessToken: "test-codex-token",
      name: "Pro account",
      priority: 1,
      isActive: true,
    });
    const plusId = await createConnection({
      provider: PROVIDER,
      authType: "oauth",
      accessToken: "test-codex-token",
      name: "Plus account",
      priority: 2,
      isActive: true,
    });
    // The synced inventories hold base ids only; the effort suffix is split off later, in the executor.
    await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, proId, [
      { id: "gpt-6-sol", name: "gpt-6-sol" },
      { id: "gpt-6-luna", name: "gpt-6-luna" },
    ]);
    await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, plusId, [
      { id: "gpt-6-luna", name: "gpt-6-luna" },
    ]);

    for (const suffixed of [
      "gpt-6-sol-high",
      "gpt-6-sol-xhigh",
      "gpt-6-sol-max",
      "gpt-6-sol-ultra",
      "cx/gpt-6-sol-high",
    ]) {
      const selected = await auth.getProviderCredentials(PROVIDER, null, null, suffixed);
      assert.equal(
        selectedConnectionId(selected),
        proId,
        `${suffixed} must select the account advertising gpt-6-sol`
      );
      // Plus never advertised gpt-6-sol, so excluding pro must not fall back to it.
      const failover = await auth.getProviderCredentials(PROVIDER, proId, null, suffixed);
      assert.equal(
        selectedConnectionId(failover),
        null,
        `${suffixed} must not fail over to an account without gpt-6-sol`
      );
    }
  });

  test("Codex suffixed request for a model no account advertises stays filtered", async () => {
    const { proId, plusId } = await seedTwoAccounts();

    for (const accountId of [proId, plusId]) {
      const selected = await auth.getProviderCredentials(
        PROVIDER,
        null,
        [accountId],
        "gpt-unadvertised-test-high"
      );
      assert.equal(selectedConnectionId(selected), null);
    }
  });

  test("Codex keeps matching an inventory id that already carries a reasoning suffix", async () => {
    const proId = await createConnection({
      provider: PROVIDER,
      authType: "oauth",
      accessToken: "test-codex-token",
      name: "Pro account",
      priority: 1,
      isActive: true,
    });
    await modelsDb.replaceSyncedAvailableModelsForConnection(PROVIDER, proId, [
      { id: "gpt-6-sol-high", name: "gpt-6-sol-high" },
    ]);

    const selected = await auth.getProviderCredentials(PROVIDER, null, null, "gpt-6-sol-high");
    assert.equal(selectedConnectionId(selected), proId);
  });
});

describe("codex-discovered-reasoning", () => {
  const modelId = "future-codex-preview";
  const efforts = ["minimal", "low", "high", "max", "ultra"];
  let connectionId: string;
  before(async () => {
    await resetAll();
    const c = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "test",
      accessToken: "test",
      isActive: true,
    });
    connectionId = c.id;
  });

  async function sync() {
    const models = normalizeCodexModelsResponse({
      models: [
        {
          slug: modelId,
          supported_reasoning_levels: [
            ...efforts.map((effort) => ({ effort })),
            { effort: "max" },
            null,
            { effort: 5 },
          ],
          default_reasoning_level: "max",
        },
        {
          slug: "future-codex-max",
          supported_reasoning_levels: ["low", "high"],
          default_reasoning_level: "low",
        },
        {
          slug: "future-codex-high",
          supported_reasoning_levels: ["low", "high"],
          default_reasoning_level: "low",
        },
      ],
    });
    await persistDiscoveredModels("codex", connectionId, models);
    return modelsDb.getSyncedAvailableModelsForConnection("codex", connectionId);
  }

  test("Codex discovery and repeated sync retain exact native tiers and default", async () => {
    await sync();
    const saved = await sync();
    assert.equal(saved.length, 3);
    assert.deepEqual(saved[0].supportedThinkingEfforts, efforts);
    assert.equal(saved[0].defaultThinkingEffort, "max");
  });

  test("dashboard and public catalog expose future model wire tiers without client-only Ultra", async () => {
    const saved = await sync();
    const listing = mergeProviderModelListing({
      providerId: "codex",
      registryModels: [{ id: "gpt-5.6-sol-ultra" }],
      syncedModels: saved,
      customModels: [],
    });
    for (const tier of efforts.filter((e) => e !== "ultra"))
      assert.ok(
        listing.some((m) => m.id === `${modelId}-${tier}`),
        tier
      );
    assert.ok(!listing.some((m) => m.id === `${modelId}-ultra`));
    // #15132: the account's live inventory is authoritative for Codex, so a static
    // registry row it does not advertise is no longer listed next to it.
    assert.ok(!listing.some((m) => m.id === "gpt-5.6-sol-ultra"));
    assert.equal(new Set(listing.map((m) => m.id)).size, listing.length);
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const catalog = await response.json();
    assert.ok(catalog.data.some((m: { id: string }) => m.id === `cx/${modelId}-max`));
    assert.ok(!catalog.data.some((m: { id: string }) => m.id === `cx/${modelId}-ultra`));
  });

  async function capture(model: string, body: Record<string, unknown> = {}) {
    const info = await getModelInfo(`cx/${model}`);
    const credentials = resolveExecutionCredentials({
      credentials: { accessToken: "test", connectionId },
      nativeCodexPassthrough: false,
      endpointPath: "/responses",
      targetFormat: "openai-responses",
      provider: "codex",
      ccSessionId: null,
      modelInfo: info,
    });
    const executor = new CodexExecutor();
    const captured: Array<{ model: string; reasoning: { effort: string } }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "resp_test", object: "response" }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      await executor.execute({
        model: info.model,
        body: { model: info.model, input: [], ...body },
        stream: true,
        credentials,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(captured.length, 1);
    return captured[0];
  }

  test("resolved future max alias wins over client default and reaches actual upstream body", async () => {
    await sync();
    const body = await capture(`${modelId}-max`, { reasoning: { effort: "low" } });
    assert.equal(body.model, modelId);
    assert.equal(body.reasoning.effort, "max");
  });

  test("future base default and explicit max are forwarded without xhigh clamping", async () => {
    await sync();
    assert.equal((await capture(modelId)).reasoning.effort, "max");
    assert.equal((await capture(modelId, { reasoning_effort: "max" })).reasoning.effort, "max");
    // A caller's unsupported wire value is left for upstream validation, never silently lowered.
    assert.equal((await capture(modelId, { reasoning_effort: "ultra" })).reasoning.effort, "ultra");
  });

  test("exact discovered ids ending in max or high remain literal upstream model ids", async () => {
    await sync();
    for (const id of ["future-codex-max", "future-codex-high"]) {
      const body = await capture(id);
      assert.equal(body.model, id);
      assert.equal(body.reasoning.effort, "low");
    }
    assert.equal(
      (await capture("gpt-5.1-codex-max", { reasoning_effort: "high" })).model,
      "gpt-5.1-codex-max"
    );
  });

  test("chat route preserves the declared native max through Responses translation", async () => {
    await sync();
    const { POST } = await import("../../../src/app/api/v1/chat/completions/route.ts");
    const originalFetch = globalThis.fetch;
    const captured: Array<{ model: string; reasoning: { effort: string } }> = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
      captured.push(JSON.parse(String(init?.body)));
      const response = {
        id: "resp_test",
        object: "response",
        status: "completed",
        model: modelId,
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "5" }] },
        ],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      };
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "5", output_index: 0, content_index: 0 })}\n\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    };
    try {
      for (const payload of [{ reasoning_effort: "max" }, {}]) {
        const result = await POST(
          new Request("http://localhost/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: `cx/${modelId}`,
              messages: [{ role: "user", content: "2+3?" }],
              stream: true,
              ...payload,
            }),
          })
        );
        await result.text();
        assert.equal(result.status, 200);
        assert.equal(captured.at(-1)?.reasoning.effort, "max");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resync replaces changed tiers and default without stale variants", async () => {
    await sync();
    await persistDiscoveredModels(
      "codex",
      connectionId,
      normalizeCodexModelsResponse({
        models: [
          {
            slug: modelId,
            supported_reasoning_levels: ["low", "high"],
            default_reasoning_level: "high",
          },
        ],
      })
    );
    const saved = await modelsDb.getSyncedAvailableModelsForConnection("codex", connectionId);
    const listing = mergeProviderModelListing({
      providerId: "codex",
      registryModels: [],
      syncedModels: saved,
      customModels: [],
    });
    assert.equal(listing.length, 3);
    assert.ok(!listing.some((m) => m.id === `${modelId}-max`));
    const info = await getModelInfo(`cx/${modelId}`);
    assert.deepEqual(info.supportedThinkingEfforts, ["low", "high"]);
    assert.equal(info.defaultThinkingEffort, "high");
  });

  test("malformed defaults are not advertised and literal max metadata remains native", () => {
    const models = normalizeCodexModelsResponse({
      models: [
        {
          slug: "unlisted-default",
          supported_reasoning_levels: ["high"],
          default_reasoning_level: "max",
        },
        {
          slug: "string-tiers",
          supported_reasoning_levels: [" high ", "max", "max"],
          default_reasoning_level: "max",
        },
      ],
    });
    assert.equal(models[0].defaultThinkingEffort, undefined);
    assert.deepEqual(models[1].supportedThinkingEfforts, ["high", "max"]);
    assert.equal(models[1].defaultThinkingEffort, "max");
  });
});

describe("codex-gpt6-astra-bare-id", () => {
  // GPT-6 Astra is a Codex-native model like the gpt-5.6 tiers, but its ids were
  // missing from CODEX_NATIVE_UNPREFIXED_MODELS. With both a Codex and an OpenAI
  // connection active, bare `gpt-6-astra` went to OpenAI while bare `gpt-5.6-sol`
  // went to Codex, and /v1/models never listed the bare Astra ids.

  // The base id and its effort tiers, as registered for the codex provider.
  const ASTRA_IDS = getProviderModels("codex")
    .map((model) => model.id)
    .filter((id) => /^gpt-6-astra(?:-(?:ultra|max|xhigh|high|medium|low))?$/.test(id));
  assert.ok(ASTRA_IDS.length >= 7, `expected the Astra effort tiers, got ${ASTRA_IDS}`);

  async function seedConnection(provider: "codex" | "openai") {
    await providersDb.createProviderConnection({
      provider,
      authType: provider === "codex" ? "oauth" : "apikey",
      name: `${provider}-gpt6-bare`,
      email: provider === "codex" ? "codex@example.com" : undefined,
      apiKey: provider === "openai" ? "sk-openai-gpt6-bare" : undefined,
      accessToken: provider === "codex" ? "codex-gpt6-bare-access" : undefined,
      isActive: true,
      testStatus: "active",
      providerSpecificData: provider === "codex" ? { workspaceId: "ws-gpt6-bare" } : {},
    });
  }

  beforeEach(resetAll);

  test("every GPT-6 Astra id in the Codex catalog is Codex-native when unprefixed", () => {
    for (const id of ASTRA_IDS) {
      assert.equal(CODEX_NATIVE_UNPREFIXED_MODELS.has(id), true, id);
    }
  });

  test("bare gpt-6-astra routes to Codex when Codex and OpenAI are both active", async () => {
    await seedConnection("codex");
    await seedConnection("openai");

    for (const id of ["gpt-6-astra", "gpt-5.6-sol"]) {
      const info = await getModelInfoCore(id, null);
      assert.equal(info.provider, "codex", id);
      assert.equal(info.model, id);
    }
  });

  test("bare gpt-6-astra stays on OpenAI when no Codex connection is active", async () => {
    await seedConnection("openai");

    const info = await getModelInfoCore("gpt-6-astra", null);
    assert.equal(info.provider, "openai");
    assert.equal(info.model, "gpt-6-astra");
  });

  test("/v1/models lists the bare GPT-6 Astra ids under their codex/ rows", async () => {
    await seedConnection("codex");

    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; parent?: string | null }>;
    };
    const parentById = new Map(body.data.map((row) => [row.id, row.parent ?? null]));

    for (const id of ASTRA_IDS) {
      assert.equal(parentById.get(id), `codex/${id}`, id);
    }
  });
});

describe("codex-gpt61-sol-bare-id", () => {
  // GPT-6.1 Sol is a Codex-native model like gpt-6-astra and the gpt-5.6 tiers.
  // Its ids must be in CODEX_NATIVE_UNPREFIXED_MODELS, otherwise with both a Codex
  // and an OpenAI connection active the bare `gpt-6.1-sol` id is ambiguous (or goes
  // to OpenAI) and /v1/models never lists the bare Codex rows.

  const MODEL = "gpt-6.1-sol";
  const EFFORTS = ["ultra", "max", "xhigh", "high", "medium", "low"];
  const EXPECTED_IDS = [MODEL, ...EFFORTS.map((effort) => `${MODEL}-${effort}`)];

  // The base id and its effort tiers, as registered for the codex provider.
  const SOL_IDS = getProviderModels("codex")
    .map((model) => model.id)
    .filter((id) => id === MODEL || id.startsWith(`${MODEL}-`));

  async function seedConnection(provider: "codex" | "openai") {
    await providersDb.createProviderConnection({
      provider,
      authType: provider === "codex" ? "oauth" : "apikey",
      name: `${provider}-gpt61-bare`,
      email: provider === "codex" ? "codex@example.com" : undefined,
      apiKey: provider === "openai" ? "sk-openai-gpt61-bare" : undefined,
      accessToken: provider === "codex" ? "codex-gpt61-bare-access" : undefined,
      isActive: true,
      testStatus: "active",
      providerSpecificData: provider === "codex" ? { workspaceId: "ws-gpt61-bare" } : {},
    });
  }

  beforeEach(resetAll);

  test("the Codex catalog registers exactly the base GPT-6.1 Sol id and its six effort tiers", () => {
    assert.deepEqual([...SOL_IDS].sort(), [...EXPECTED_IDS].sort());
  });

  test("every GPT-6.1 Sol id in the Codex catalog is Codex-native when unprefixed", () => {
    for (const id of SOL_IDS) {
      assert.equal(CODEX_NATIVE_UNPREFIXED_MODELS.has(id), true, id);
    }
  });

  test("every GPT-6.1 Sol Codex id resolves a non-zero pricing row", () => {
    for (const id of SOL_IDS) {
      const price = getPricingForModel("cx", id);
      assert.ok(price, `cx/${id}`);
      assert.ok(price.input > 0 && price.output > 0, `cx/${id} must not resolve to $0`);
    }
  });

  test("bare gpt-6.1-sol routes to Codex when Codex and OpenAI are both active", async () => {
    await seedConnection("codex");
    await seedConnection("openai");

    for (const id of [MODEL, `${MODEL}-ultra`, `${MODEL}-low`]) {
      const info = await getModelInfoCore(id, null);
      assert.equal(info.provider, "codex", id);
      assert.equal(info.model, id);
    }
  });

  test("bare gpt-6.1-sol stays on OpenAI when no Codex connection is active", async () => {
    await seedConnection("openai");

    const info = await getModelInfoCore(MODEL, null);
    assert.equal(info.provider, "openai");
    assert.equal(info.model, MODEL);
  });

  test("/v1/models lists the bare GPT-6.1 Sol ids under their codex/ rows", async () => {
    await seedConnection("codex");

    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; parent?: string | null }>;
    };
    const parentById = new Map(body.data.map((row) => [row.id, row.parent ?? null]));

    for (const id of SOL_IDS) {
      assert.equal(parentById.get(id), `codex/${id}`, id);
    }
  });
});

describe("codex-live-catalog-route", () => {
  const originalFetch = globalThis.fetch;
  before(resetAll);
  after(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearCodexGithubCatalogCacheForTests();
  });
  const call = async (id: string, refresh = true) => {
    const response = await GET(
      new Request(`http://localhost/api/providers/${id}/models?refresh=${refresh}&chatOnly=true`),
      { params: { id } }
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const ids = (body: { models: Array<{ id: string }> }) => body.models.map((model) => model.id);
  const connection = () =>
    providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "catalog test",
      isActive: true,
      accessToken: "test-token",
      providerSpecificData: { autoFetchModels: false },
    });

  test("live IDs replace stale account cache without adding static or GitHub-only models", async () => {
    const c = await connection();
    let modelId = "codex-live-before";
    globalThis.fetch = async (input) =>
      Response.json({
        models: [
          {
            slug: String(input).includes("chatgpt.com") ? modelId : "github-only-model",
            visibility: "list",
            supported_in_api: true,
          },
        ],
      });
    assert.deepEqual(ids(await call(c.id)), [modelId]);
    modelId = "codex-live-after";
    assert.deepEqual(ids(await call(c.id)), [modelId]);
    assert.deepEqual(
      (await getCachedDiscoveredModels("codex", c.id)).map((m) => m.id),
      [modelId]
    );
    assert.deepEqual(ids(await call(c.id, false)), [modelId]);
    globalThis.fetch = async (input) =>
      String(input).includes("chatgpt.com")
        ? new Response("unavailable", { status: 503 })
        : Response.json({
            models: [{ slug: "github-only-model", visibility: "list", supported_in_api: true }],
          });
    const fallback = await call(c.id);
    assert.equal(fallback.source, "cache");
    assert.deepEqual(ids(fallback), [modelId]);
  });

  test("unsynchronized accounts retain an explicit static fallback with auto-fetch off", async () => {
    const c = await connection();
    globalThis.fetch = async () => {
      throw new Error("must not fetch");
    };
    const fallback = await call(c.id, false);
    assert.equal(fallback.source, "local_catalog");
    assert.ok(fallback.models.length > 0);
  });

  test("a live catalog containing only retired models does not resurrect static models", async () => {
    const c = await connection();
    globalThis.fetch = async () =>
      Response.json({
        models: [{ slug: "gpt-5.4", visibility: "list", supported_in_api: true }],
      });
    const body = await call(c.id);
    assert.equal(body.source, "api");
    assert.deepEqual(ids(body), []);
  });

  test("the public Codex catalog does not reintroduce static-only IDs after live sync", async () => {
    const c = await connection();
    globalThis.fetch = async () =>
      Response.json({
        models: [{ slug: "codex-live-public", visibility: "list", supported_in_api: true }],
      });
    await call(c.id);
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = new Set(body.data.map((model) => model.id));
    assert.ok(ids.has("cx/codex-live-public"));
    assert.ok(!ids.has("cx/auto"));
    assert.ok(!ids.has("cx/auto-cost"));
    assert.ok(!ids.has("cx/gpt-5.6-sol"));
    assert.ok(!ids.has("cx/gpt-5.3-codex-spark"));
  });

  test("Codex dashboard rows preserve ownership and never gain Cursor auto aliases", async () => {
    const rows = mergeProviderModelListing({
      providerId: "codex",
      registryModels: [{ id: "stale" }],
      syncedModels: [{ id: "codex-live" }],
      customModels: [],
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["codex-live"]
    );
    assert.equal(rows[0].owned_by, "codex");
  });
});

describe("codex-models-catalog-refresh", () => {
  // Codex CLI compatibility for GET /v1/models.
  //
  // The Codex CLI model-catalog refresh (codex_models_manager) does
  //   GET /v1/models?client_version=<v>
  // and decodes a JSON object with a TOP-LEVEL `models` array. OmniRoute answers in the
  // OpenAI-standard `{ object: "list", data: [...] }` shape, so codex's serde fails with
  //   failed to decode models response: missing field `models`
  // and logs "failed to refresh available models" on every startup (verified live against
  // codex 0.137 with a request-capturing stub).
  //
  // Fix: when the caller is a codex client (identified by the `originator` /
  // `user-agent` = `codex_*` headers that codex sends), add an EMPTY top-level
  // `models: []` so the decode succeeds and the error disappears. Non-codex OpenAI clients
  // keep the byte-identical `{object,data}` response (no `models` key).
  //
  // Why EMPTY and not the real catalog: codex replaces its built-in per-model agent prompt
  // (`base_instructions`, ~21k chars) with whatever a populated `models` entry carries for
  // the selected model. Emitting our models with an empty/foreign `base_instructions` was
  // empirically shown to drop codex's agent prompt to 0 chars, breaking its agent behavior.
  // An empty array keeps codex on its built-in model info (same inference as today, minus
  // the error).

  type CatalogResponse = {
    data?: Array<{ id: string; visibility?: string }>;
  };

  beforeEach(resetAll);

  test("codex client (originator: codex_exec) receives a top-level `models` array so the catalog refresh decodes", async () => {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models?client_version=0.137.0", {
        headers: {
          originator: "codex_exec",
          "user-agent":
            "codex_exec/0.137.0 (Ubuntu 24.4.0; x86_64) vscode/3.7.19 (codex_exec; 0.137.0)",
        },
      })
    );

    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;

    // OpenAI-standard fields are preserved for any OpenAI consumer of the same response.
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data), "data[] must still be present for OpenAI clients");

    // The codex-required top-level `models` array is present (and empty by design).
    assert.ok(Array.isArray(body.models), "codex clients must receive a top-level `models` array");
    assert.equal(
      (body.models as unknown[]).length,
      0,
      "`models` must be empty so codex keeps its built-in per-model base_instructions"
    );
  });

  test("codex TUI (user-agent: codex_cli_rs) is detected via user-agent too", async () => {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models", {
        headers: { "user-agent": "codex_cli_rs/0.137.0 (Ubuntu 24.4.0; x86_64)" },
      })
    );

    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.models), "codex user-agent must also get the `models` array");
  });

  test("non-codex OpenAI client keeps the unchanged {object,data} shape (no `models` key)", async () => {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models", {
        headers: { "user-agent": "OpenAI/Python 1.99.0" },
      })
    );

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
    assert.ok(
      !("models" in body),
      "non-codex clients must NOT receive a `models` key (response stays byte-identical)"
    );
  });

  test("v1 models catalog exposes remote-only Codex IDs from the discovery cache", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "codex-curated-catalog",
      accessToken: "codex-access-token",
      isActive: true,
      testStatus: "active",
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
      {
        id: "codex-auto-review",
        name: "Codex Auto Review Remote",
        source: "imported",
        visibility: "hide",
        supportedInApi: true,
        supportedEndpoints: ["responses"],
      },
      {
        id: "future-codex-model",
        name: "Future Codex Model",
        source: "imported",
        supportedEndpoints: ["responses"],
      },
      {
        id: "gpt-5.4-mini",
        name: "Retired GPT-5.4 Mini",
        source: "imported",
        supportedEndpoints: ["responses"],
      },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as CatalogResponse;
    const ids = new Set((body.data || []).map((item) => item.id));

    assert.equal(response.status, 200);
    assert.equal(ids.has("cx/codex-auto-review"), true);
    assert.equal(
      (body.data || []).find((item) => item.id === "cx/codex-auto-review")?.visibility,
      "hide"
    );
    assert.equal(ids.has("cx/future-codex-model"), true);
    assert.equal(ids.has("codex/future-codex-model"), true);
    assert.equal(ids.has("cx/gpt-5.4-mini"), false);
    assert.equal(ids.has("codex/gpt-5.4-mini"), false);
  });
});
