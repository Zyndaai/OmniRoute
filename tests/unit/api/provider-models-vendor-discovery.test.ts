// Provider models route: vendor-specific live discovery (Cloudflare, DashScope, GLM, Kimi/Z.ai/Notion
// web, Muse, Cline, Claude, Cursor, Zed, Vertex, Antigravity). Merged from fifteen files so the
// heavy `src/app/api/providers/[id]/models/route.ts` module graph loads once; each original file
// is one `describe` below, named after the file it came from.
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pm-vendor-discovery-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// cline-models-discovery-route-15136 pinned the plugins dir inside its data dir before import.
process.env.OMNIROUTE_PLUGINS_DIR = path.join(TEST_DATA_DIR, "plugins");

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const { setProxyForLevel } = await import("../../../src/lib/db/settings.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const modelsRoute = await import("../../../src/app/api/providers/[id]/models/route.ts");
const { nextCloudflareModelsPageUrl, parseCloudflareModelsSearch } =
  await import("../../../src/app/api/providers/[id]/models/discovery/cloudflareModels.ts");
const notionModels = await import("../../../open-sse/services/notionWebModels.ts");
const zaiWebRegistry = await import("../../../open-sse/config/providers/registry/zai-web/index.ts");
const museCli = await import("../../../src/app/api/v1/muse-code/models/route.ts");
const museScoped = await import("../../../src/app/api/v1/providers/[provider]/models/route.ts");
const modelDiscovery = await import("../../../src/lib/providerModels/modelDiscovery.ts");
const { proxyFetch } = await import("../../../open-sse/utils/proxyFetch.ts");
const { __resetCursorApiKeyAuthForTest } =
  await import("../../../open-sse/services/cursorApiKeyAuth.ts");
const zedAuth = await import("../../../open-sse/shared/zedAuth.ts");
const antigravityVersion = await import("../../../open-sse/services/antigravityVersion.ts");
const { isDiscoverableAgyModelId, isUserVisibleAgyQuotaModelId } =
  await import("../../../open-sse/config/agyModels.ts");
const { isDiscoverableAntigravityModelId, isUserVisibleAntigravityQuotaModelId } =
  await import("../../../open-sse/config/antigravityModelAliases.ts");
const { isUsageQuotaKeyAllowed, normalizeUsageQuotaKey } =
  await import("../../../src/lib/usage/providerLimits/quotaNormalize.ts");
const { DEFAULT_PRICING_OAUTH } =
  await import("../../../src/shared/constants/pricing/oauth-subscriptions.ts");

const originalFetch = globalThis.fetch;

// Every describe starts (and, where the source had a beforeEach, every test starts) from an
// empty database and data dir with the real fetch restored.
async function resetStorage() {
  globalThis.fetch = originalFetch;
  await core.resetDbInstance();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  globalThis.fetch = originalFetch;
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("cloudflare-model-discovery-pagination", () => {
  // Cloudflare Workers AI `/ai/models/search` is page-numbered
  // (`result_info.page` / `total_pages`). Discovery used to read only page 1 and
  // imported every row, so embeddings, speech and classifier models showed up as
  // chat models. These tests drive the real route with a mocked fetch.
  type CfRow = { id: string; name: string; description?: string; task?: { name: string } };

  async function seedCloudflareConnection() {
    return providersDb.createProviderConnection({
      provider: "cloudflare-ai",
      authType: "apikey",
      name: `cloudflare-ai-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: "cf-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { accountId: "acc-123" },
    });
  }

  async function callRoute(connectionId: string) {
    return modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: { id: connectionId } }
    );
  }

  function chatRow(slug: string, uuid: string): CfRow {
    return { id: uuid, name: slug, task: { name: "Text Generation" } };
  }

  beforeEach(resetStorage);

  test("cloudflare-ai discovery follows result_info pagination across pages", async () => {
    const connection = await seedCloudflareConnection();
    const calledUrls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      calledUrls.push(href);
      const page = Number(new URL(href).searchParams.get("page") || "1");
      const rows =
        page === 1
          ? [chatRow("@cf/meta/llama-3.1-8b-instruct", "uuid-1")]
          : [
              chatRow("@cf/qwen/qwq-32b", "uuid-2"),
              // Same model repeated on a later page must not be imported twice.
              chatRow("@cf/meta/llama-3.1-8b-instruct", "uuid-1"),
            ];
      return Response.json({
        result: rows,
        result_info: { page, per_page: 100, total_pages: 2, total_count: 3 },
      });
    }) as typeof fetch;

    const response = await callRoute(connection.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, "api");
    const ids: string[] = body.models.map((m: { id: string }) => m.id);

    assert.equal(
      calledUrls.length,
      2,
      `expected 2 page fetches, got ${JSON.stringify(calledUrls)}`
    );
    assert.ok(calledUrls[0].includes("/accounts/acc-123/ai/models/search"));
    assert.equal(new URL(calledUrls[0]).searchParams.get("per_page"), "100");
    const second = new URL(calledUrls[1]);
    assert.equal(second.searchParams.get("page"), "2");
    assert.equal(second.searchParams.get("per_page"), "100");

    assert.deepEqual([...ids].sort(), ["@cf/meta/llama-3.1-8b-instruct", "@cf/qwen/qwq-32b"]);
  });

  test("cloudflare-ai discovery drops embeddings, speech and classifier models", async () => {
    const connection = await seedCloudflareConnection();
    const rows: CfRow[] = [
      chatRow("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "uuid-chat"),
      { id: "uuid-e1", name: "@cf/baai/bge-base-en-v1.5", task: { name: "Text Embeddings" } },
      // id fallback: no task metadata at all.
      { id: "uuid-e2", name: "@cf/baai/bge-m3" },
      { id: "uuid-e3", name: "@cf/google/embeddinggemma-300m" },
      {
        id: "uuid-s1",
        name: "@cf/openai/whisper",
        task: { name: "Automatic Speech Recognition" },
      },
      { id: "uuid-s2", name: "@cf/myshell-ai/melotts", task: { name: "Text-to-Speech" } },
      { id: "uuid-s3", name: "@cf/deepgram/aura-1" },
      {
        id: "uuid-c1",
        name: "@cf/huggingface/distilbert-sst-2-int8",
        task: { name: "Text Classification" },
      },
      { id: "uuid-c2", name: "@cf/microsoft/resnet-50", task: { name: "Image Classification" } },
      { id: "uuid-r1", name: "@cf/baai/bge-reranker-base" },
      { id: "uuid-t1", name: "@cf/meta/m2m100-1.2b", task: { name: "Translation" } },
      // Safety classifier published under the "Text Generation" task.
      chatRow("@cf/meta/llama-guard-3-8b", "uuid-g1"),
      {
        id: "uuid-i1",
        name: "@cf/black-forest-labs/flux-1-schnell",
        task: { name: "Text-to-Image" },
      },
    ];
    globalThis.fetch = (async () =>
      Response.json({
        result: rows,
        result_info: { page: 1, per_page: 100, total_pages: 1, total_count: rows.length },
      })) as typeof fetch;

    const response = await callRoute(connection.id);
    assert.equal(response.status, 200);
    const body = await response.json();
    const ids: string[] = body.models.map((m: { id: string }) => m.id);

    assert.ok(ids.includes("@cf/meta/llama-3.3-70b-instruct-fp8-fast"), JSON.stringify(ids));
    for (const dropped of [
      "@cf/baai/bge-base-en-v1.5",
      "@cf/baai/bge-m3",
      "@cf/google/embeddinggemma-300m",
      "@cf/openai/whisper",
      "@cf/myshell-ai/melotts",
      "@cf/deepgram/aura-1",
      "@cf/huggingface/distilbert-sst-2-int8",
      "@cf/microsoft/resnet-50",
      "@cf/baai/bge-reranker-base",
      "@cf/meta/m2m100-1.2b",
      "@cf/meta/llama-guard-3-8b",
    ]) {
      assert.ok(!ids.includes(dropped), `${dropped} must not reach the chat catalog`);
    }

    const image = body.models.find(
      (m: { id: string }) => m.id === "@cf/black-forest-labs/flux-1-schnell"
    );
    assert.ok(image, "text-to-image model stays importable");
    assert.equal(image.modelType, "image");
    assert.deepEqual(image.supportedEndpoints, ["images"]);
  });

  test("cloudflare-ai pagination is bounded and never re-requests the same page", async () => {
    const connection = await seedCloudflareConnection();
    const calledUrls: string[] = [];
    let n = 0;
    globalThis.fetch = (async (url: unknown) => {
      calledUrls.push(String(url));
      n++;
      // Claims 500 pages and always returns a fresh model so the loop cannot end
      // on an empty page — only the page cap can stop it.
      return Response.json({
        result: [chatRow(`@cf/vendor/model-${n}`, `uuid-${n}`)],
        result_info: { page: n, per_page: 100, total_pages: 500 },
      });
    }) as typeof fetch;

    const response = await callRoute(connection.id);
    assert.equal(response.status, 200);
    assert.equal(calledUrls.length, 20, "pagination stops at the 20-page safety cap");
    assert.equal(new Set(calledUrls).size, calledUrls.length, "no page URL is fetched twice");
  });

  test("nextCloudflareModelsPageUrl stops on the last page, a repeated page and an empty page", () => {
    const base = "https://api.cloudflare.com/client/v4/accounts/a/ai/models/search?per_page=100";
    const row = [chatRow("@cf/x/y", "u")];
    assert.equal(
      nextCloudflareModelsPageUrl({ result: row, result_info: { page: 2, total_pages: 2 } }, base),
      null
    );
    assert.equal(nextCloudflareModelsPageUrl({ result: row }, base), null);
    assert.equal(
      nextCloudflareModelsPageUrl({ result: [], result_info: { page: 1, total_pages: 3 } }, base),
      null
    );
    // total_count fallback when total_pages is missing.
    const next = nextCloudflareModelsPageUrl(
      { result: row, result_info: { page: 1, per_page: 100, total_count: 150 } },
      base
    );
    assert.ok(next);
    assert.equal(new URL(next).searchParams.get("page"), "2");
    assert.equal(new URL(next).searchParams.get("per_page"), "100");
  });

  test("parseCloudflareModelsSearch keeps the #4259 name-as-id mapping", () => {
    const models = parseCloudflareModelsSearch({
      result: [
        {
          id: "429b9e8b-d99e-44de-91ad-706cf8183658",
          name: "@cf/meta/llama-3.1-8b-instruct",
          description: "Llama 3.1 8B Instruct",
          task: { name: "Text Generation" },
        },
        { id: "no-name-uuid" },
      ],
    });
    assert.deepEqual(models, [
      {
        id: "@cf/meta/llama-3.1-8b-instruct",
        name: "@cf/meta/llama-3.1-8b-instruct",
        description: "Llama 3.1 8B Instruct",
      },
    ]);
  });
});

describe("cloudflare-models-uuid-4259", () => {
  // #4259: Cloudflare Workers AI `/ai/models/search` returns objects shaped like
  // `{ id: "<uuid>", name: "@cf/meta/llama-3.1-8b-instruct" }` — the human-usable
  // model identifier is `name`, while `id` is an internal UUID. Discovery must use
  // `name` as the callable model id; otherwise the dashboard/import shows UUIDs.
  async function seedConnection(provider: string, overrides: Record<string, any> = {}) {
    return providersDb.createProviderConnection({
      provider,
      authType: overrides.authType || "apikey",
      name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: overrides.apiKey,
      isActive: overrides.isActive ?? true,
      testStatus: overrides.testStatus || "active",
      providerSpecificData: overrides.providerSpecificData || {},
    });
  }

  async function callRoute(connectionId: string, search = "") {
    return modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
      { params: { id: connectionId } }
    );
  }

  beforeEach(resetStorage);

  test("#4259 cloudflare-ai discovery uses the model name (slug) as id, not the UUID", async () => {
    const connection = await seedConnection("cloudflare-ai", {
      apiKey: "cf-token",
      providerSpecificData: { accountId: "acc-123" },
    });

    const LLAMA_UUID = "429b9e8b-d99e-44de-91ad-706cf8183658";
    const QWEN_UUID = "f8703a00-ed54-4c83-bcd9-706cf8183999";

    let calledUrl = "";
    globalThis.fetch = (async (url: any) => {
      calledUrl = String(url);
      return Response.json({
        result: [
          {
            id: LLAMA_UUID,
            name: "@cf/meta/llama-3.1-8b-instruct",
            description: "Llama 3.1 8B Instruct",
            task: { name: "Text Generation" },
          },
          {
            id: QWEN_UUID,
            name: "@cf/qwen/qwen1.5-0.5b-chat",
            description: "Qwen 1.5 0.5B Chat",
            task: { name: "Text Generation" },
          },
        ],
      });
    }) as typeof fetch;

    const response = await callRoute(connection.id, "?refresh=true");
    assert.equal(response.status, 200);

    // Sanity: hit the Cloudflare models search endpoint with the configured account.
    assert.ok(
      calledUrl.includes("/accounts/acc-123/ai/models/search"),
      `unexpected discovery URL: ${calledUrl}`
    );

    const body = await response.json();
    assert.equal(body.source, "api");
    const ids: string[] = body.models.map((m: any) => m.id);

    // The human-usable slug must be the id (RED before the fix — id was the UUID).
    assert.ok(
      ids.includes("@cf/meta/llama-3.1-8b-instruct"),
      `expected slug id, got ${JSON.stringify(ids)}`
    );
    assert.ok(
      ids.includes("@cf/qwen/qwen1.5-0.5b-chat"),
      `expected slug id, got ${JSON.stringify(ids)}`
    );
    // The internal UUID must never be exposed as a callable model id.
    assert.ok(!ids.includes(LLAMA_UUID), "UUID must not be used as a model id");
    assert.ok(!ids.includes(QWEN_UUID), "UUID must not be used as a model id");
  });
});

describe("dashscope-text-models-discovery", () => {
  const ALIBABA_MODEL_STUDIO_MODEL_IDS = [
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "qwen3.6-27b",
    "qwen3.6-35b-a3b",
    "qwen3.5-plus",
    "qwen3.5-122b-a10b",
    "qwen3.5-397b-a17b",
    "glm-5.2",
    "glm-5.2-fast-preview",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "kimi-k2.7-code",
  ];

  const QWEN_CLOUD_TEXT_MODEL_IDS = [
    "qwen3.7-max-2026-06-08",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "qwen3.6-27b",
    "qwen3.6-35b-a3b",
    "qwen3.5-plus-2026-04-20",
    "qwen3.5-122b-a10b",
    "qwen3.5-397b-a17b",
    "glm-5.2",
    "glm-5.2-fast-preview",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "kimi-k2.7-code",
  ];

  const ALL_DASHSCOPE_TEXT_MODEL_IDS = [
    ...QWEN_CLOUD_TEXT_MODEL_IDS,
    ...ALIBABA_MODEL_STUDIO_MODEL_IDS,
    "qwen3-coder-next",
    "qwen-mt-plus",
    "MiniMax-M2.5",
  ];
  const UPSTREAM_TEXT_MODEL_IDS = [...ALL_DASHSCOPE_TEXT_MODEL_IDS].reverse();

  const MIXED_DASHSCOPE_MODELS = [
    ...UPSTREAM_TEXT_MODEL_IDS.map((id) => ({
      id,
      object: "model",
      owned_by: "system",
    })),
    { id: "qwen-image-2.0-pro", object: "model", owned_by: "system" },
    { id: "wan2.7-image-pro", object: "model", owned_by: "system" },
    { id: "qwen3-tts-flash", object: "model", owned_by: "system" },
    { id: "qwen3-asr-flash", object: "model", owned_by: "system" },
    { id: "qwen3.5-omni-plus", object: "model", owned_by: "system" },
    { id: "qwen3-vl-plus", object: "model", owned_by: "system" },
    { id: "qwen3-rerank", object: "model", owned_by: "system" },
    { id: "text-embedding-v4", object: "model", owned_by: "system" },
    { id: "qvq-max", object: "model", owned_by: "system" },
    { id: "ccai-pro", object: "model", owned_by: "system" },
  ];

  async function assertTextOnlyDiscovery({
    provider,
    region,
    expectedUrl,
    expectedModelIds,
  }: {
    provider: "alibaba" | "alibaba-cn" | "qwen-cloud";
    region?: "global-sg" | "china-beijing";
    expectedUrl: string;
    expectedModelIds: string[];
  }) {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider}-live-text`,
      apiKey: "test-dashscope-key",
      ...(region ? { providerSpecificData: { region } } : {}),
    });
    await modelsDb.replaceSyncedAvailableModelsForConnection(provider, connection.id, [
      { id: "qwen-image-stale", name: "Stale image model", source: "imported" },
    ]);

    let fetchCalls = 0;
    let requestedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      fetchCalls += 1;
      requestedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ object: "list", data: MIXED_DASHSCOPE_MODELS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, "api");
      assert.deepEqual(
        body.models.map((model: { id: string }) => model.id),
        expectedModelIds
      );
      assert.equal(requestedUrl, expectedUrl);
      assert.equal(fetchCalls, 1);

      const persisted = await modelsDb.getSyncedAvailableModelsForConnection(
        provider,
        connection.id
      );
      assert.deepEqual(
        persisted.map((model) => model.id),
        expectedModelIds
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("Qwen Cloud syncs only text models from the selected Beijing region", async () => {
    await assertTextOnlyDiscovery({
      provider: "qwen-cloud",
      region: "china-beijing",
      expectedUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
      expectedModelIds: QWEN_CLOUD_TEXT_MODEL_IDS,
    });
  });

  test("Alibaba syncs only text models from the selected Global region", async () => {
    await assertTextOnlyDiscovery({
      provider: "alibaba",
      region: "global-sg",
      expectedUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      expectedModelIds: ALIBABA_MODEL_STUDIO_MODEL_IDS,
    });
  });

  test("Alibaba syncs only text models from the selected Beijing region", async () => {
    await assertTextOnlyDiscovery({
      provider: "alibaba",
      region: "china-beijing",
      expectedUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
      expectedModelIds: ALIBABA_MODEL_STUDIO_MODEL_IDS,
    });
  });

  test("legacy Alibaba China connections also sync only Beijing text models", async () => {
    await assertTextOnlyDiscovery({
      provider: "alibaba-cn",
      expectedUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
      expectedModelIds: ALIBABA_MODEL_STUDIO_MODEL_IDS,
    });
  });

  test("Alibaba free billing mode syncs all live text models, not only the curated catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "alibaba",
      authType: "apikey",
      name: "alibaba-free-live",
      apiKey: "test-dashscope-key",
      providerSpecificData: { region: "global-sg", alibabaBillingMode: "free" },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ object: "list", data: MIXED_DASHSCOPE_MODELS }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof globalThis.fetch;

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(
        body.models.length > ALIBABA_MODEL_STUDIO_MODEL_IDS.length,
        "free billing mode should expose more than the curated catalog"
      );
      assert.ok(
        body.models.some((model: { id: string }) => model.id === "qwen3-coder-next"),
        "expected upstream-only free-tier model to be included"
      );
      assert.equal(
        body.models.some((model: { id: string }) => model.id === "qwen-image-2.0-pro"),
        false,
        "non-text models must still be filtered out"
      );
      assert.equal(
        body.models.some((model: { id: string }) => model.id === "kimi-k2.7-code"),
        false,
        "third-party paid-only models must be excluded from free billing discovery"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("glm-provider-model-import-route", () => {
  // #10603 made upstream model sync opt-in (isAutoFetchModelsEnabled() now requires
  // providerSpecificData.autoFetchModels === true) so remote discovery doesn't overwrite
  // manual catalog overrides by default. Every connection below sets it explicitly so the
  // mocked `fetch` in each test actually gets called — without it, the route short-circuits
  // to the local/cached catalog before ever reaching the network call these tests assert on.
  test("GLM import uses international coding endpoint when apiRegion is international", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-intl",
      apiKey: "glm-key",
      providerSpecificData: { apiRegion: "international", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), "https://api.z.ai/api/coding/paas/v4/models");
      assert.equal(init.headers.Authorization, "Bearer glm-key");
      assert.equal(init.headers["x-api-key"], undefined);
      assert.equal(init.headers["anthropic-version"], undefined);
      return Response.json({ data: [{ id: "glm-5", name: "GLM 5" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        provider: "glm",
        connectionId: connection.id,
        models: [{ id: "glm-5", name: "GLM 5" }],
        source: "api",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import normalizes custom coding models URLs without duplicating endpoints", async () => {
    await resetStorage();
    // Distinct apiKeys per connection: createProviderConnection dedups by decrypted
    // key value (#3023), so a shared key would collapse these two custom-endpoint
    // connections into one and the second would serve from the first's cached
    // catalog (only one discovery fetch instead of two).
    const cases = [
      {
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        expectedUrl: "https://api.z.ai/api/coding/paas/v4/models",
        apiKey: "glm-key-0",
      },
      {
        baseUrl: "https://api.z.ai/api/coding/paas/v4/models",
        expectedUrl: "https://api.z.ai/api/coding/paas/v4/models",
        apiKey: "glm-key-1",
      },
    ];

    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    const connections = [];

    for (const [index, testCase] of cases.entries()) {
      connections.push(
        await providersDb.createProviderConnection({
          provider: "glm",
          authType: "apikey",
          name: `glm-custom-${index}`,
          apiKey: testCase.apiKey,
          providerSpecificData: { baseUrl: testCase.baseUrl, autoFetchModels: true },
        })
      );
    }

    globalThis.fetch = async (url, init = {}) => {
      const expected = cases[seenUrls.length];
      assert.ok(expected, `unexpected GLM discovery call to ${String(url)}`);
      assert.equal(String(url), expected.expectedUrl);
      assert.equal(init.headers.Authorization, `Bearer ${expected.apiKey}`);
      assert.equal(init.headers["x-api-key"], undefined);
      assert.equal(init.headers["anthropic-version"], undefined);
      seenUrls.push(String(url));
      return Response.json({ data: [{ id: "glm-5", name: "GLM 5" }] });
    };

    try {
      for (const connection of connections) {
        const response = await modelsRoute.GET(
          new Request(`http://localhost/api/providers/${connection.id}/models`),
          { params: { id: connection.id } }
        );
        assert.equal(response.status, 200);
      }

      assert.deepEqual(
        seenUrls,
        cases.map((testCase) => testCase.expectedUrl)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import falls back to Anthropic model discovery when coding discovery fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-discovery-fallback",
      apiKey: "glm-key",
      providerSpecificData: { apiRegion: "international", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    globalThis.fetch = async (url, init = {}) => {
      seenUrls.push(String(url));
      if (seenUrls.length === 1) {
        assert.equal(String(url), "https://api.z.ai/api/coding/paas/v4/models");
        assert.equal(init.headers.Authorization, "Bearer glm-key");
        assert.equal(init.headers["x-api-key"], undefined);
        return new Response(JSON.stringify({ error: "bad gateway" }), { status: 502 });
      }

      assert.equal(String(url), "https://api.z.ai/api/anthropic/v1/models");
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.headers["x-api-key"], "glm-key");
      assert.equal(init.headers["anthropic-version"], "2023-06-01");
      return Response.json({ data: [{ id: "glm-5.1", name: "GLM 5.1" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        provider: "glm",
        connectionId: connection.id,
        models: [{ id: "glm-5.1", name: "GLM 5.1" }],
        source: "api",
      });
      assert.deepEqual(seenUrls, [
        "https://api.z.ai/api/coding/paas/v4/models",
        "https://api.z.ai/api/anthropic/v1/models",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import preserves auth failures instead of falling back across transports", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-auth-fail",
      apiKey: "bad-key",
      providerSpecificData: { apiRegion: "international", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    globalThis.fetch = async (url) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 401);
      assert.deepEqual(seenUrls, ["https://api.z.ai/api/coding/paas/v4/models"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLMT import shares the GLM coding models endpoint and surfaces provider metadata correctly", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glmt",
      authType: "apikey",
      name: "glmt-intl",
      apiKey: "glmt-key",
      providerSpecificData: { apiRegion: "international", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), "https://api.z.ai/api/coding/paas/v4/models");
      assert.equal(init.headers.Authorization, "Bearer glmt-key");
      return Response.json({ data: [{ id: "glm-5.1", name: "GLM 5.1" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        provider: "glmt",
        connectionId: connection.id,
        models: [{ id: "glm-5.1", name: "GLM 5.1" }],
        source: "api",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import uses China coding endpoint when apiRegion is china", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-cn",
      apiKey: "glm-cn-key",
      providerSpecificData: { apiRegion: "china", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), "https://open.bigmodel.cn/api/coding/paas/v4/models");
      assert.equal(init.headers.Authorization, "Bearer glm-cn-key");
      return Response.json({ data: [{ id: "glm-5", name: "GLM 5" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.provider, "glm");
      assert.equal(body.models.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM China provider import uses the specialized GLM discovery path", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm-cn",
      authType: "apikey",
      name: "glm-cn-provider",
      apiKey: "glm-cn-key",
      providerSpecificData: { autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), "https://open.bigmodel.cn/api/coding/paas/v4/models");
      assert.equal(init.headers.Authorization, "Bearer glm-cn-key");
      assert.equal(init.headers["x-api-key"], undefined);
      return Response.json({ data: [{ id: "glm-5", name: "GLM 5" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.provider, "glm-cn");
      assert.deepEqual(body.models, [{ id: "glm-5", name: "GLM 5" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import defaults to international endpoint when apiRegion is missing", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-default",
      apiKey: "glm-key",
      providerSpecificData: { autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://api.z.ai/api/coding/paas/v4/models");
      return Response.json({ data: [{ id: "glm-5", name: "GLM 5" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import defaults to international endpoint when apiRegion is invalid", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-bogus",
      apiKey: "glm-key",
      providerSpecificData: { apiRegion: "bogus", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://api.z.ai/api/coding/paas/v4/models");
      return Response.json({ data: [{ id: "glm-5", name: "GLM 5" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import prefers apiKey over accessToken and sends only Authorization Bearer", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-both-tokens",
      apiKey: "glm-api-key",
      accessToken: "glm-access-token",
      providerSpecificData: { apiRegion: "international", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(init.headers.Authorization, "Bearer glm-api-key");
      assert.equal(init.headers["x-api-key"], undefined);
      return Response.json({ data: [] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import falls back to accessToken when apiKey is absent", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-access-only",
      accessToken: "glm-access-token",
      providerSpecificData: { apiRegion: "international", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(init.headers.Authorization, "Bearer glm-access-token");
      return Response.json({ data: [] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("GLM import falls back to the local catalog on upstream non-OK status codes", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "glm-error",
      apiKey: "glm-key",
      providerSpecificData: { apiRegion: "international", autoFetchModels: true },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as any;
      assert.equal(body.provider, "glm");
      assert.equal(body.connectionId, connection.id);
      assert.equal(body.source, "local_catalog");
      assert.match(body.warning, /API unavailable/i);
      assert.ok(body.models.some((model) => model.id === "glm-5.1"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("kimi-web-models-discovery", () => {
  test("kimi-web uses the curated registry catalog without remote discovery", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "kimi-web",
      authType: "apikey",
      name: "kimi-web-curated",
      apiKey: "opaque-current-kimi-token",
    });
    await modelsDb.replaceSyncedAvailableModelsForConnection("kimi-web", connection.id, [
      { id: "unexpected-live-model", name: "Unexpected live model", source: "imported" },
    ]);

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("kimi-web curated catalog must not perform remote discovery");
    }) as typeof globalThis.fetch;

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, "local_catalog");
      assert.deepEqual(
        body.models.map((model: { id: string }) => model.id),
        ["k3", "k2d6"]
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("zai-web-models-discovery-7678", () => {
  const CURATED_ZAI_WEB_MODEL_IDS = ["glm-5.3-flash", "glm-5.3", "glm-5.2"];

  test("zai-web publishes the live reasoning and vision capabilities", () => {
    assert.deepEqual(
      zaiWebRegistry.zai_webProvider.models.map((model) => ({
        id: model.id,
        supportsReasoning: model.supportsReasoning === true,
        supportedThinkingEfforts: model.supportedThinkingEfforts,
        supportsVision: model.supportsVision === true,
        toolCalling: model.toolCalling === true,
      })),
      [
        {
          id: "glm-5.3-flash",
          supportsReasoning: true,
          supportedThinkingEfforts: ["low", "high", "max"],
          supportsVision: true,
          toolCalling: false,
        },
        {
          id: "glm-5.3",
          supportsReasoning: true,
          supportedThinkingEfforts: ["low", "high", "max"],
          supportsVision: false,
          toolCalling: false,
        },
        {
          id: "glm-5.2",
          supportsReasoning: true,
          supportedThinkingEfforts: ["high", "max"],
          supportsVision: false,
          toolCalling: false,
        },
      ]
    );
  });

  test("zai-web exposes only its curated public models without remote discovery", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "zai-web",
      authType: "apikey",
      name: "zai-web-curated",
      apiKey: "current-local-storage-token",
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection("zai-web", connection.id, [
      { id: "glm-4.6v", name: "GLM-4.6V", source: "imported" },
      { id: "0727-106B-API", name: "GLM-4.5-Air", source: "imported" },
      { id: "deep-research", name: "Z1-Rumination", source: "imported" },
    ]);
    await modelsDb.addCustomModel("zai-web", "glm-4-air-250414", "GLM-4-32B", "imported");
    await modelsDb.addCustomModel("zai-web", "manual-test-model", "Manual test model", "manual");

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("zai-web curated catalog must not perform remote discovery");
    }) as typeof globalThis.fetch;

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, "local_catalog");
      // #18018 made operator-added custom models listable on curated providers, so the
      // manual row now joins the curated lineup. The synced rows and the custom row a
      // discovery sync imported (glm-4-air-250414) are still left out (#8451).
      assert.deepEqual(
        body.models.map((model: { id: string }) => model.id),
        [...CURATED_ZAI_WEB_MODEL_IDS, "manual-test-model"]
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("notion-web-models-discovery", () => {
  const SAMPLE_RESPONSE = {
    models: [
      {
        model: "orange-mousse",
        modelMessage: "GPT-5.6 Sol",
        modelFamily: "openai",
        isDisabled: false,
        modelConfiguration: { supportedReasoningEfforts: ["medium", "high"] },
      },
      {
        model: "ambrosia-tart-high",
        modelMessage: "Opus 4.8",
        modelFamily: "anthropic",
        isDisabled: false,
      },
      {
        model: "disabled-model",
        modelMessage: "Hidden",
        modelFamily: "openai",
        isDisabled: true,
      },
    ],
  };

  test("parseNotionAvailableModels maps enabled models and skips disabled", () => {
    const models = notionModels.parseNotionAvailableModels(SAMPLE_RESPONSE);
    assert.equal(
      models.some((m) => m.id === "disabled-model" || m.id === "hidden"),
      false
    );
    // Catalog ids are real web-picker labels — NOT food codenames.
    assert.ok(models.some((m) => m.id === "gpt-5.6-sol" && m.name === "GPT-5.6 Sol"));
    assert.ok(models.some((m) => m.id === "opus-4.8" && m.name === "Opus 4.8"));
    assert.ok(models.some((m) => m.id === "notion-ai"));
    // Food codenames must not be primary catalog ids.
    assert.equal(
      models.some((m) => m.id === "orange-mousse"),
      false
    );
    assert.equal(
      models.some((m) => m.id === "ambrosia-tart-high"),
      false
    );
    const sol = models.find((m) => m.id === "gpt-5.6-sol");
    assert.equal(sol?.notionCodename, "orange-mousse");
    assert.equal(sol?.supportsReasoning, true);
    assert.equal(sol?.owned_by, "openai");
    const opus = models.find((m) => m.id === "opus-4.8");
    assert.equal(opus?.notionCodename, "ambrosia-tart-high");
  });

  test("resolveNotionCodename maps prefixes, slugs, and display names to food codenames", () => {
    assert.equal(notionModels.resolveNotionCodename("orange-mousse"), "orange-mousse");
    assert.equal(notionModels.resolveNotionCodename("notion-web/orange-mousse"), "orange-mousse");
    assert.equal(notionModels.resolveNotionCodename("nw/orange-mousse"), "orange-mousse");
    assert.equal(notionModels.resolveNotionCodename("gpt-5.6-sol"), "orange-mousse");
    assert.equal(notionModels.resolveNotionCodename("notion-web/gpt-5.6-sol"), "orange-mousse");
    assert.equal(notionModels.resolveNotionCodename("GPT-5.6 Sol"), "orange-mousse");
    assert.equal(notionModels.resolveNotionCodename("fable-5"), "acai-budino-high");
    assert.equal(notionModels.resolveNotionCodename("Fable 5"), "acai-budino-high");
    assert.equal(notionModels.resolveNotionCodename("acai-budino-high"), "acai-budino-high");
    assert.equal(notionModels.resolveNotionCodename("notion-ai"), "");
    assert.equal(notionModels.resolveNotionCodename(""), "");
  });

  test("listNotionDisabledModels surfaces plan-locked Fable 5 without listing it as enabled", () => {
    const payload = {
      models: [
        {
          model: "acai-budino-high",
          modelMessage: "Fable 5",
          modelFamily: "anthropic",
          isDisabled: true,
          disabledReason: "business_or_enterprise_plan_required",
        },
        {
          model: "orange-mousse",
          modelMessage: "GPT-5.6 Sol",
          modelFamily: "openai",
          isDisabled: false,
        },
      ],
    };
    const disabled = notionModels.listNotionDisabledModels(payload);
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0].id, "fable-5");
    assert.equal(disabled[0].name, "Fable 5");
    assert.equal(disabled[0].notionCodename, "acai-budino-high");
    assert.equal(disabled[0].reason, "business_or_enterprise_plan_required");

    const enabled = notionModels.parseNotionAvailableModels(payload);
    assert.equal(
      enabled.some((m) => m.id === "fable-5" || m.id === "acai-budino-high"),
      false
    );
    assert.ok(enabled.some((m) => m.id === "gpt-5.6-sol"));

    const warning = notionModels.formatNotionDisabledModelsWarning(disabled);
    assert.match(warning, /Fable 5/i);
    assert.match(warning, /business or enterprise/i);
  });

  test("parseNotionAvailableModels returns empty for invalid payloads", () => {
    assert.deepEqual(notionModels.parseNotionAvailableModels(null), []);
    assert.deepEqual(notionModels.parseNotionAvailableModels({}), []);
    assert.deepEqual(notionModels.parseNotionAvailableModels({ models: "nope" }), []);
  });

  test("cookie helpers extract space_id and user id", () => {
    const cookie =
      "token_v2=abc; space_id=5e43fbd2-c09b-815a-8045-000311a1f620; notion_user_id=28bd872b-594c-81cb-9638-0002a411fd83";
    assert.equal(
      notionModels.extractSpaceIdFromNotionCookie(cookie),
      "5e43fbd2-c09b-815a-8045-000311a1f620"
    );
    assert.equal(
      notionModels.extractNotionUserIdFromCookie(cookie),
      "28bd872b-594c-81cb-9638-0002a411fd83"
    );
    assert.equal(notionModels.normalizeNotionWebCookie("baretoken"), "token_v2=baretoken");
    // CamelCase spaceId= must still resolve (case-insensitive name match).
    assert.equal(
      notionModels.extractSpaceIdFromNotionCookie("token_v2=x; spaceId=space-camel"),
      "space-camel"
    );
    // Malformed % sequences must not throw.
    assert.equal(notionModels.readCookieValue("token_v2=%E0%A4%A", "token_v2"), "%E0%A4%A");
  });

  test("pickFirstSpaceId reads nested getSpaces shape", () => {
    const data = {
      "user-1": {
        space: {
          "space-aaa": { name: "Work" },
          "space-bbb": { name: "Personal" },
        },
      },
    };
    assert.equal(notionModels.pickFirstSpaceId(data), "space-aaa");
  });

  test("discoverNotionWebModels posts getAvailableModels with spaceId from cookie", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body || "") });
      return Response.json(SAMPLE_RESPONSE);
    }) as typeof fetch;

    const result = await notionModels.discoverNotionWebModels({
      token: "token_v2=xyz; space_id=space-from-cookie",
      fetchImpl,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, notionModels.NOTION_MODELS_URL);
    assert.equal(JSON.parse(calls[0].body).spaceId, "space-from-cookie");
    assert.ok(result.models.some((m) => m.id === "gpt-5.6-sol"));
    assert.equal(result.source, "api");
  });

  test("discoverNotionWebModels falls back to getSpaces when space_id missing", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).includes("getSpaces")) {
        return Response.json({
          u1: { space: { "resolved-space": { name: "WS" } } },
        });
      }
      return Response.json(SAMPLE_RESPONSE);
    }) as typeof fetch;

    const result = await notionModels.discoverNotionWebModels({
      token: "token_v2=xyz",
      fetchImpl,
    });

    assert.equal(calls[0], notionModels.NOTION_SPACES_URL);
    assert.ok(calls.some((u) => u === notionModels.NOTION_MODELS_URL));
    assert.equal(result.spaceId, "resolved-space");
    assert.ok(result.models.length >= 2);
    assert.equal(result.spaceIdFromGetSpaces, true);
  });

  test("parseNotionGetSpaces extracts userId and all space ids", () => {
    const data = {
      "user-aaa": {
        space: {
          "space-1": { name: "Work" },
          "space-2": { name: "Personal" },
        },
      },
    };
    const parsed = notionModels.parseNotionGetSpaces(data);
    assert.equal(parsed.userId, "user-aaa");
    assert.deepEqual(parsed.spaceIds, ["space-1", "space-2"]);
  });

  test("selectBestNotionSpaceId prefers the workspace with more enabled models", async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("getAvailableModels")) {
        const body = JSON.parse(String(init?.body || "{}"));
        if (body.spaceId === "rich-space") return Response.json(SAMPLE_RESPONSE);
        return Response.json({
          models: [
            {
              model: "only-one",
              modelMessage: "Tiny",
              modelFamily: "openai",
              isDisabled: false,
            },
          ],
        });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const best = await notionModels.selectBestNotionSpaceId({
      cookie: "token_v2=abc",
      spaceIds: ["poor-space", "rich-space"],
      fetchImpl,
    });
    assert.ok(best);
    assert.equal(best!.spaceId, "rich-space");
    assert.ok(best!.models.some((m) => m.id === "gpt-5.6-sol"));
  });

  test("selectBestNotionSpaceId prefers workspace where Fable is enabled over locked", async () => {
    const locked = {
      models: [
        {
          model: "orange-mousse",
          modelMessage: "GPT-5.6 Sol",
          modelFamily: "openai",
          isDisabled: false,
        },
        {
          model: "acai-budino-high",
          modelMessage: "Fable 5",
          modelFamily: "anthropic",
          isDisabled: true,
          disabledReason: "business_or_enterprise_plan_required",
        },
      ],
    };
    const unlocked = {
      models: [
        {
          model: "orange-mousse",
          modelMessage: "GPT-5.6 Sol",
          modelFamily: "openai",
          isDisabled: false,
        },
        {
          model: "acai-budino-high",
          modelMessage: "Fable 5",
          modelFamily: "anthropic",
          isDisabled: false,
        },
      ],
    };
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      // First space looks rich enough that a buggy early-exit would pick it.
      if (body.spaceId === "personal-locked") return Response.json(locked);
      if (body.spaceId === "business-unlocked") return Response.json(unlocked);
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    const best = await notionModels.selectBestNotionSpaceId({
      cookie: "token_v2=abc",
      spaceIds: ["personal-locked", "business-unlocked"],
      fetchImpl,
    });
    assert.ok(best);
    assert.equal(best!.spaceId, "business-unlocked");
    assert.ok(best!.models.some((m) => m.id === "fable-5"));
  });

  test("notion-web models route returns live getAvailableModels catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "notion-web",
      authType: "apikey",
      name: "notion-web-discovery",
      apiKey: "token_v2=sess; space_id=space-live-1",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("getAvailableModels")) {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body || "{}"));
        assert.equal(body.spaceId, "space-live-1");
        const headers = init?.headers as Record<string, string>;
        assert.match(String(headers.cookie || headers.Cookie || ""), /token_v2=sess/);
        // Browser fingerprint headers present on models-discovery requests.
        assert.ok(headers["sec-ch-ua"], "sec-ch-ua should be present");
        assert.ok(headers["sec-fetch-mode"], "sec-fetch-mode should be present");
        assert.equal(headers["sec-fetch-mode"], "cors");
        assert.equal(headers["cache-control"], "no-cache");
        return Response.json(SAMPLE_RESPONSE);
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof globalThis.fetch;

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, "api");
      const ids = body.models.map((m: { id: string }) => m.id);
      // Real picker labels, not food codenames.
      assert.ok(ids.includes("gpt-5.6-sol"));
      assert.ok(ids.includes("opus-4.8"));
      assert.equal(ids.includes("orange-mousse"), false);
      assert.equal(ids.includes("ambrosia-tart-high"), false);
      assert.equal(ids.includes("disabled-model"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("muse-live-catalog-16437", () => {
  const originalCatalog = museScoped.unifiedModels.load;
  type CatalogBody = {
    source?: string;
    intentional?: boolean;
    warning?: string;
    models?: { id: string }[];
    data?: { id: string; metadata?: { name: string } }[];
  };

  before(resetStorage);
  after(() => {
    globalThis.fetch = originalFetch;
    museScoped.unifiedModels.load = originalCatalog;
  });

  async function discover(authType: "apikey" | "oauth", status = 200) {
    const connection = await providersDb.createProviderConnection({
      provider: "muse-code",
      name: "fixture",
      authType,
      isActive: true,
      apiKey: authType === "apikey" ? "fixture-api-key" : null,
      accessToken: authType === "oauth" ? "fixture-minted-key" : null,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "muse-new-fixture" }] }, { status });
    };
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
      { params: Promise.resolve({ id: connection.id }) }
    );
    return { calls, response, body: (await response.json()) as CatalogBody };
  }

  test("a failed live request is an explicit fallback, not an intentional local-only catalog", async () => {
    const result = await discover("apikey", 503);
    assert.ok(result.calls.length > 0);
    assert.equal(result.body.source, "local_catalog");
    assert.notEqual(result.body.intentional, true);
    assert.ok(result.body.warning);
    assert.ok(result.body.models?.some((model) => model.id === "muse-spark-1.3"));
  });

  for (const mode of ["apikey", "oauth"] as const) {
    test(`discovery requests the live Muse catalog with the ${mode} connection token`, async () => {
      const result = await discover(mode);
      assert.ok(
        result.calls.some(
          (call) =>
            call.url === "https://api.meta.ai/v1/models" &&
            call.auth === `Bearer ${mode === "apikey" ? "fixture-api-key" : "fixture-minted-key"}`
        ),
        JSON.stringify(result)
      );
      assert.equal(result.body.source, "api");
      assert.ok(result.body.models?.some((model) => model.id === "muse-new-fixture"));
    });
  }

  test("CLI catalog follows the current authorized catalog and is not publicly cached", async () => {
    let current = "muse-new-fixture";
    museScoped.unifiedModels.load = async () =>
      Response.json({
        object: "list",
        data: [
          { id: `mc/${current}`, root: current, owned_by: "muse-code", name: "Live fixture" },
          { id: "openai/unrelated", root: "unrelated", owned_by: "openai" },
        ],
      });
    const request = new Request("http://localhost/api/v1/muse-code/models");
    const first = await museCli.GET(request);
    assert.deepEqual(
      ((await first.json()) as CatalogBody).data?.map((row) => row.id),
      [current]
    );
    assert.match(first.headers.get("cache-control") || "", /private|no-store/);
    current = "muse-next-fixture";
    const second = await museCli.GET(request);
    assert.deepEqual(
      ((await second.json()) as CatalogBody).data?.map((row) => row.id),
      [current]
    );
  });

  test("CLI catalog preserves the shared catalog authentication rejection", async () => {
    museScoped.unifiedModels.load = async () =>
      Response.json({ error: { message: "Authentication required" } }, { status: 401 });
    const response = await museCli.GET(new Request("http://localhost/api/v1/muse-code/models"));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { message: "Authentication required" } });
  });

  test("control: CLI preflight remains available", async () => {
    const response = await museCli.OPTIONS();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("access-control-allow-methods") || "", /GET/);
  });

  test("CLI preserves discovered capabilities without inventing unknown limits", async () => {
    museScoped.unifiedModels.load = async () =>
      Response.json({
        object: "list",
        data: [
          {
            id: "mc/muse-live-with-metadata",
            root: "muse-live-with-metadata",
            owned_by: "muse-code",
            context_length: 123456,
            capabilities: { vision: true, effort_tiers: ["high"] },
          },
          { id: "mc/muse-unknown", root: "muse-unknown", owned_by: "muse-code" },
        ],
      });
    const response = await museCli.GET(new Request("http://localhost/api/v1/muse-code/models"));
    const body = (await response.json()) as {
      data: { id: string; metadata: Record<string, unknown> }[];
    };
    const first = body.data.find((row) => row.id === "muse-live-with-metadata")!;
    assert.deepEqual(first.metadata.modalities, ["text", "image"]);
    assert.equal(first.metadata.reasoning, true);
    assert.equal(first.metadata.limit, 123456);
    const unknown = body.data.find((row) => row.id === "muse-unknown")!;
    assert.equal(unknown.metadata.limit, undefined);
    assert.equal(unknown.metadata.tool_call, undefined);
    assert.equal(unknown.metadata.cost, undefined);
  });
});

describe("cline-models-discovery-route-15136", () => {
  const fullCatalog = {
    data: [
      { id: "vendor/shared", name: "Paid Shared", architecture: { modality: "text->text" } },
      { id: "vendor/other", architecture: { modality: "text+image->text" } },
      { id: "cline-free/shared", architecture: { modality: "text->text" } },
      { id: "cline-pass/subscription", architecture: { modality: "text->text" } },
      { id: "vendor/image", architecture: { modality: "text->image" } },
    ],
  };
  const recommendedCatalog = {
    free: [{ id: "cline-free/shared", name: "Free Shared" }, { id: "cline-free/rotated-new" }],
    recommended: [{ id: "vendor/shared" }, { id: "cline-pass/subscription" }],
    clinePass: [{ id: "cline-pass/subscription" }],
  };

  async function connection(provider = "cline", autoFetchModels = true) {
    return providersDb.createProviderConnection({
      provider,
      authType: "oauth",
      name: "Cline fixture",
      accessToken: "fixture-not-a-real-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { autoFetchModels },
    });
  }

  function mockCatalogs(
    recommended: () => Response,
    full: () => Response = () => Response.json(fullCatalog)
  ) {
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      if (url === "https://api.cline.bot/api/v1/ai/cline/recommended-models") return recommended();
      if (url === "https://api.cline.bot/api/v1/ai/cline/models") return full();
      throw new Error("Unexpected outbound request in Cline fixture");
    };
    return calls;
  }

  async function request(id: string, refresh = true) {
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${id}/models${refresh ? "?refresh=true" : ""}`),
      { params: { id } }
    );
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      source: string;
      models: Array<{ id: string; name?: string }>;
    }>;
  }

  before(resetStorage);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("Cline discovery merges rotating free models first without collapsing paid namespaces", async () => {
    const row = await connection();
    const calls = mockCatalogs(() => Response.json(recommendedCatalog));
    const body = await request(row.id);
    assert.equal(body.source, "api");
    assert.deepEqual(
      body.models.map((model) => model.id),
      ["cline-free/shared", "cline-free/rotated-new", "vendor/shared", "vendor/other"]
    );
    assert.equal(body.models[0].name, "Free Shared");
    assert.equal(calls.length, 2);
    assert.ok(
      (await modelDiscovery.getCachedDiscoveredModels("cline", row.id)).some(
        (model) => model.id === "cline-free/rotated-new"
      )
    );
  });

  for (const [name, reply] of [
    ["HTTP failure", () => new Response("down", { status: 503 })],
    [
      "network failure",
      () => {
        throw new Error("fixture network failure");
      },
    ],
    ["invalid JSON", () => new Response("invalid", { status: 200 })],
    ["missing free bucket", () => Response.json({ recommended: [] })],
    ["malformed free bucket", () => Response.json({ free: {}, recommended: [] })],
    ["malformed free entry", () => Response.json({ free: [{ id: 42 }], recommended: [] })],
  ] as const) {
    test(`Cline preserves its previous complete cache on recommended ${name}`, async () => {
      const row = await connection();
      await modelDiscovery.persistDiscoveredModels("cline", row.id, [
        { id: "cline-free/previous" },
      ]);
      mockCatalogs(reply);
      const body = await request(row.id);
      assert.equal(body.source, "cache");
      assert.deepEqual(
        body.models.map((model) => model.id),
        ["cline-free/previous"]
      );
      assert.deepEqual(
        (await modelDiscovery.getCachedDiscoveredModels("cline", row.id)).map((model) => model.id),
        ["cline-free/previous"]
      );
    });
  }

  test("Cline preserves cache when the full catalog fails despite a valid free bucket", async () => {
    const row = await connection();
    await modelDiscovery.persistDiscoveredModels("cline", row.id, [{ id: "cline-free/previous" }]);
    mockCatalogs(
      () => Response.json(recommendedCatalog),
      () => Response.json({ error: "not a catalog" })
    );
    const body = await request(row.id);
    assert.equal(body.source, "cache");
    assert.deepEqual(
      (await modelDiscovery.getCachedDiscoveredModels("cline", row.id)).map((model) => model.id),
      ["cline-free/previous"]
    );
  });

  test("a valid empty free bucket expires removed free entries without dropping paid models", async () => {
    const row = await connection();
    await modelDiscovery.persistDiscoveredModels("cline", row.id, [{ id: "cline-free/previous" }]);
    mockCatalogs(
      () => Response.json({ free: [], recommended: [] }),
      () => Response.json({ data: [fullCatalog.data[0]] })
    );
    const body = await request(row.id);
    assert.equal(body.source, "api");
    assert.deepEqual(
      body.models.map((model) => model.id),
      ["vendor/shared"]
    );
    assert.deepEqual(
      (await modelDiscovery.getCachedDiscoveredModels("cline", row.id)).map((model) => model.id),
      ["vendor/shared"]
    );
  });

  test("Cline auto-fetch disabled performs no outbound request", async () => {
    const row = await connection("cline", false);
    const calls = mockCatalogs(() => Response.json(recommendedCatalog));
    await request(row.id, false);
    assert.equal(calls.length, 0);
  });

  test("ClinePass discovery remains confined to its subscription bucket", async () => {
    const row = await connection("clinepass");
    const calls = mockCatalogs(() => Response.json(recommendedCatalog));
    const body = await request(row.id);
    assert.equal(body.source, "api");
    assert.deepEqual(
      body.models.map((model) => model.id),
      ["cline-pass/subscription"]
    );
    assert.equal(calls.length, 1);
  });
});

describe("claude-model-discovery-route", () => {
  async function connection(oauth = true) {
    return providersDb.createProviderConnection({
      provider: "claude",
      authType: oauth ? "oauth" : "apikey",
      name: "Claude discovery",
      isActive: true,
      ...(oauth ? { accessToken: "test-oauth" } : { apiKey: "test-api-key" }),
      providerSpecificData: { autoFetchModels: false },
    });
  }
  const call = (id: string, refresh = true) =>
    modelsRoute.GET(
      new Request(`http://localhost/api/providers/${id}/models?refresh=${refresh}&chatOnly=true`),
      { params: { id } }
    );

  before(resetStorage);
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("Claude refresh discovers remote-only models with OAuth, paginates, and persists the cache", async () => {
    const c = await connection();
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      assert.equal(url.origin, "https://api.anthropic.com");
      assert.equal(url.pathname, "/v1/models");
      assert.equal(headers.get("authorization"), "Bearer test-oauth");
      assert.equal(headers.get("x-api-key"), null);
      assert.match(headers.get("anthropic-beta") || "", /oauth-2025-04-20/);
      calls++;
      if (calls === 1)
        return Response.json({
          data: [
            {
              id: "claude-opus-5-5",
              display_name: "Claude Opus 5.5",
              type: "model",
              max_input_tokens: 1000000,
              max_tokens: 128000,
            },
          ],
          has_more: true,
          last_id: "claude-opus-5-5",
        });
      assert.equal(url.searchParams.get("after_id"), "claude-opus-5-5");
      return Response.json({
        data: [{ id: "claude-fable-5-1", display_name: "Claude Fable 5.1", type: "model" }],
        has_more: false,
      });
    };
    const r = await call(c.id);
    const body = await r.json();
    assert.equal(body.source, "api");
    assert.equal(calls, 2);
    assert.deepEqual(
      body.models.map((m: { id: string }) => m.id),
      ["claude-opus-5-5", "claude-fable-5-1"]
    );
    assert.equal(body.models[0].inputTokenLimit, 1000000);
    assert.equal(body.models[0].outputTokenLimit, 128000);
    const cached = await modelDiscovery.getCachedDiscoveredModels("claude", c.id);
    assert.ok(cached.some((m) => m.id === "claude-opus-5-5"));
    globalThis.fetch = async () => {
      throw new Error("must use cache");
    };
    assert.equal((await (await call(c.id, false)).json()).source, "cache");
    const failed = await (await call(c.id)).json();
    assert.equal(failed.source, "cache");
    assert.match(failed.warning, /unavailable/i);
  });

  test("Claude API-key discovery uses x-api-key and reports HTTP failures without leaking upstream text", async () => {
    const c = await connection(false);
    globalThis.fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-api-key"), "test-api-key");
      assert.equal(headers.get("authorization"), null);
      return new Response("secret upstream stack at /private/key", { status: 403 });
    };
    const body = await (await call(c.id)).json();
    assert.equal(body.source, "local_catalog");
    assert.match(body.warning, /403/);
    assert.ok(!JSON.stringify(body).includes("/private/key"));
  });

  test("Claude auto-fetch disabled keeps the local fallback and performs no upstream request", async () => {
    const c = await connection();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("unexpected fetch");
    };
    const body = await (await call(c.id, false)).json();
    assert.equal(body.source, "local_catalog");
    assert.equal(calls, 0);
  });
});

describe("cursor-api-models-discovery", () => {
  // A cursor-api connection (crsr_ user key) must discover Cursor's live catalog
  // like an IDE-session `cursor` connection. Before this, the route had no
  // cursor-api branch and served the static registry as "local_catalog"; the
  // sync persisted that snapshot as the authoritative live catalog, so every
  // model Cursor added after the snapshot (e.g. claude-opus-5-5-*) was rejected
  // at dispatch as "not available in the active live catalog".
  const SESSION_TOKEN = "session-token-from-exchange";

  before(resetStorage);

  // Both cases replace global fetch. Keep them serial so a concurrent run cannot
  // swap the mock out from under the other case.
  describe("cursor-api model discovery", { concurrency: 1 }, () => {
    for (const USER_KEY of ["crsr_test_user_key", "grok_test_user_key"]) {
      test(`cursor-api discovers Cursor's live catalog with ${USER_KEY.slice(0, 5)}`, async () => {
        __resetCursorApiKeyAuthForTest();
        const connection = await providersDb.createProviderConnection({
          provider: "cursor-api",
          authType: "apikey",
          name: "cursor-api-live",
          apiKey: USER_KEY,
        });

        const calls: Array<{ url: string; authorization: string | null }> = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const authorization = new Headers(init?.headers).get("authorization");
          calls.push({ url, authorization });
          if (url.endsWith("/auth/exchange_user_api_key")) {
            return Response.json({ accessToken: SESSION_TOKEN, refreshToken: SESSION_TOKEN });
          }
          if (url.endsWith("/aiserver.v1.AiService/AvailableModels")) {
            return Response.json({
              models: [
                { name: "claude-opus-5-5-medium", displayName: "Claude Opus 5.5" },
                { name: "claude-4.6-opus-high", displayName: "Claude Opus 4.6" },
              ],
            });
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof globalThis.fetch;

        try {
          const response = await modelsRoute.GET(
            new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
            { params: { id: connection.id } }
          );
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.notEqual(body.source, "local_catalog");
          const ids = body.models.map((model: { id: string }) => model.id);
          assert.ok(ids.includes("claude-opus-5-5-medium"), ids.join(","));
          assert.ok(ids.includes("claude-4.6-opus-high"), ids.join(","));

          const discovery = calls.find((call) => call.url.endsWith("/AvailableModels"));
          assert.equal(discovery?.authorization, `Bearer ${SESSION_TOKEN}`);
          assert.ok(
            calls.every(
              (call) => call.authorization !== `Bearer ${USER_KEY}` || call.url.includes("exchange")
            ),
            "the raw user key is only ever sent to the exchange endpoint"
          );
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test("cursor discovery warnings do not leak stack paths", async () => {
        __resetCursorApiKeyAuthForTest();
        const connection = await providersDb.createProviderConnection({
          provider: "cursor-api",
          authType: "apikey",
          name: "cursor-api-discovery-error",
          apiKey: `${USER_KEY}_leak`,
        });

        const leak = "at /home/secret/file.ts:10";
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith("/auth/exchange_user_api_key")) {
            return Response.json({ accessToken: SESSION_TOKEN, refreshToken: SESSION_TOKEN });
          }
          if (url.endsWith("/aiserver.v1.AiService/AvailableModels")) {
            return new Response(`discovery failed ${leak}`, { status: 500 });
          }
          throw new Error(`unexpected fetch ${url}`);
        }) as typeof globalThis.fetch;

        try {
          const response = await modelsRoute.GET(
            new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
            { params: { id: connection.id } }
          );
          const body = await response.json();
          const warning = String(body.warning ?? body.error ?? "");
          assert.match(warning, /AvailableModels unavailable/);
          assert.equal(warning.includes("/home/secret/file.ts:10"), false);
          assert.equal(warning.includes("at /"), false);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  });
});

describe("cursor-model-import-proxy-route", () => {
  before(resetStorage);
  // The provider-level proxy is stored in the shared settings table; drop it with the DB.
  after(resetStorage);

  test("Cursor model import sends AvailableModels through the configured proxy", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "cursor",
      authType: "oauth",
      name: "Cursor discovery test",
      accessToken: "cursor-session-token",
      providerSpecificData: { autoFetchModels: true },
      isActive: true,
    });
    await setProxyForLevel("provider", "cursor", { type: "http", host: "127.0.0.1", port: 1 });
    let directRequests = 0;
    let proxiedRequests = 0;
    globalThis.fetch = (url, init) =>
      proxyFetch(url, init, {
        nativeFetch: async () => {
          directRequests++;
          return Response.json({ models: [{ name: "bypassed-proxy-model" }] });
        },
        undiciFetch: async () => {
          proxiedRequests++;
          return Response.json({ models: [{ name: "proxied-model" }] });
        },
      });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      const body = await response.json();
      assert.equal(directRequests, 0, "AvailableModels must not bypass the configured proxy");
      assert.ok(proxiedRequests > 0);
      assert.equal(body.source, "api");
      assert.ok(body.models?.some((model: { id: string }) => model.id === "proxied-model"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("zed-hosted-models-discovery-route", () => {
  type SeenRequest = {
    url: string;
    method: string;
    authorization: string | null;
    body: string | null;
  };

  type RouteBody = {
    provider?: string;
    models?: Array<{ id: string; name?: string; [key: string]: unknown }>;
    source?: string;
    warning?: string;
    error?: string;
  };

  // Zed's LLM-token + model caches are module-level and keyed by
  // `${userId}:${organizationId}:${accessToken.slice(-16)}`; each test uses its own
  // token AND clears the caches so no test can be served a neighbour's catalog.
  async function resetZedStorage() {
    zedAuth.clearZedCaches();
    await resetStorage();
  }

  async function seedZedConnection(accessToken: string) {
    return providersDb.createProviderConnection({
      provider: "zed-hosted",
      authType: "oauth",
      name: `zed-${Math.random().toString(16).slice(2, 8)}`,
      accessToken,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { userId: 4242, organizationId: "org-personal" },
    });
  }

  async function callRoute(connectionId: string, search = "?refresh=true") {
    return modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
      { params: { id: connectionId } }
    );
  }

  beforeEach(resetZedStorage);
  after(() => {
    zedAuth.clearZedCaches();
  });

  test("zed-hosted model discovery mints an LLM token and lists the live catalog", async () => {
    const accessToken = "zed-account-token-happy-path";
    const connection = await seedZedConnection(accessToken);
    const seen: SeenRequest[] = [];

    globalThis.fetch = async (url, init) => {
      const requestUrl = String(url);
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      seen.push({
        url: requestUrl,
        method: (init?.method || "GET").toUpperCase(),
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });

      if (requestUrl.endsWith("/client/llm_tokens")) {
        // Zed authorizes the mint with its own `<userId> <accessToken>` scheme.
        if (headers.get("authorization") !== `4242 ${accessToken}`) {
          return new Response("Invalid Authorization header", { status: 401 });
        }
        return Response.json({ token: "zed-llm-token-abc" });
      }

      if (requestUrl.endsWith("/models")) {
        // The catalog endpoint only accepts the minted LLM token.
        if (headers.get("authorization") !== "Bearer zed-llm-token-abc") {
          return new Response("Invalid Authorization header", { status: 401 });
        }
        return Response.json({
          models: [
            {
              id: "claude-sonnet-4.5",
              display_name: "Claude Sonnet 4.5",
              max_token_count: 200000,
              max_output_tokens: 64000,
              supports_tools: true,
              supports_images: true,
            },
            {
              id: "gpt-5",
              display_name: "GPT-5",
              max_token_count: 400000,
              supports_tools: true,
            },
            {
              id: "retired-model",
              display_name: "Retired",
              is_disabled: true,
            },
          ],
          default_model: "claude-sonnet-4.5",
        });
      }

      throw new Error(`Unexpected fetch: ${requestUrl}`);
    };

    const response = await callRoute(connection.id);
    const body = (await response.json()) as RouteBody;

    assert.equal(response.status, 200);
    assert.equal(body.source, "api", `expected live discovery, got ${JSON.stringify(body)}`);

    const ids = (body.models || []).map((model) => model.id);
    assert.deepEqual(ids.sort(), ["claude-sonnet-4.5", "gpt-5"]);

    const sonnet = (body.models || []).find((model) => model.id === "claude-sonnet-4.5");
    assert.equal(sonnet?.name, "Claude Sonnet 4.5");

    // The regression this guards: before the fix the route fell through to the
    // registry `modelsUrl` path, which sends `Bearer <accessToken>` straight to
    // cloud.zed.dev/models and always 401s. Assert the token exchange happened and
    // that the catalog call carried the minted LLM token, never the account token.
    const mint = seen.find((request) => request.url.endsWith("/client/llm_tokens"));
    assert.ok(mint, "expected POST /client/llm_tokens");
    assert.equal(mint.method, "POST");
    assert.equal(mint.authorization, `4242 ${accessToken}`);
    assert.equal(JSON.parse(mint.body || "{}").organization_id, "org-personal");

    const catalog = seen.find((request) => request.url.endsWith("/models"));
    assert.ok(catalog, "expected GET /models");
    assert.equal(catalog.authorization, "Bearer zed-llm-token-abc");
    assert.notEqual(catalog.authorization, `Bearer ${accessToken}`);
  });

  test("zed-hosted model discovery resolves the organization when the connection has none", async () => {
    // The OAuth import stores `organizationId: tokens.organization_id || undefined`
    // (src/lib/oauth/providers/zed-hosted.ts) — a connection can legitimately land
    // without one, in which case the mint has to discover it via /client/users/me.
    const accessToken = "zed-account-token-no-org";
    const connection = await providersDb.createProviderConnection({
      provider: "zed-hosted",
      authType: "oauth",
      name: `zed-${Math.random().toString(16).slice(2, 8)}`,
      accessToken,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { userId: 4242 },
    });
    const seen: string[] = [];

    globalThis.fetch = async (url, init) => {
      const requestUrl = String(url);
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      seen.push(requestUrl);

      if (requestUrl.endsWith("/client/users/me")) {
        return Response.json({
          id: 4242,
          organizations: [{ id: "org-discovered", is_personal: true }],
        });
      }
      if (requestUrl.endsWith("/client/llm_tokens")) {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
        if (body.organization_id !== "org-discovered") {
          return new Response("Unknown organization", { status: 403 });
        }
        return Response.json({ token: "zed-llm-token-xyz" });
      }
      if (requestUrl.endsWith("/models")) {
        if (headers.get("authorization") !== "Bearer zed-llm-token-xyz") {
          return new Response("Invalid Authorization header", { status: 401 });
        }
        return Response.json({ models: [{ id: "gpt-5", display_name: "GPT-5" }] });
      }
      throw new Error(`Unexpected fetch: ${requestUrl}`);
    };

    const response = await callRoute(connection.id);
    const body = (await response.json()) as RouteBody;

    assert.equal(response.status, 200);
    assert.equal(body.source, "api", `expected live discovery, got ${JSON.stringify(body)}`);
    assert.deepEqual(
      (body.models || []).map((model) => model.id),
      ["gpt-5"]
    );
    assert.ok(
      seen.some((url) => url.endsWith("/client/users/me")),
      "expected the organization lookup"
    );
  });

  test("zed-hosted model discovery degrades to the local catalog when Zed rejects the token", async () => {
    const accessToken = "zed-account-token-rejected";
    const connection = await seedZedConnection(accessToken);

    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/client/llm_tokens")) {
        return new Response("Invalid Authorization header", { status: 401 });
      }
      throw new Error(`Unexpected fetch: ${requestUrl}`);
    };

    const response = await callRoute(connection.id);
    const body = (await response.json()) as RouteBody;

    assert.notEqual(response.status, 500);
    assert.notEqual(body.source, "api");
    // Never leak a stack trace through the discovery error path (Hard Rule #12).
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("at /"), serialized);
    assert.ok(!serialized.includes(".ts:"), serialized);
  });
});

describe("vertex-models-route", () => {
  async function seedVertexConnection(options: {
    apiKey?: string;
    accessToken?: string;
    projectId?: string;
  }): Promise<{ id: string }> {
    return providersDb.createProviderConnection({
      provider: "vertex",
      authType: "apikey",
      name: `vertex-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: options.apiKey,
      accessToken: options.accessToken,
      projectId: options.projectId,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { autoFetchModels: true },
    });
  }

  async function callRoute(connectionId: string): Promise<Response> {
    return modelsRoute.GET(
      new Request(
        `http://localhost/api/providers/${connectionId}/models?refresh=true&chatOnly=true`
      ),
      { params: { id: connectionId } }
    );
  }

  beforeEach(resetStorage);

  test("Vertex Express probes only Gemini discovery and then uses the intentional Gemini catalog", async () => {
    const connection = await seedVertexConnection({ apiKey: "vertex-express-key" });
    let fetchCalls = 0;
    const headers: HeadersInit[] = [];
    globalThis.fetch = async (_url, init) => {
      fetchCalls += 1;
      headers.push(init?.headers || {});
      return Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 });
    };

    const response = await callRoute(connection.id);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.match(body.warning, /live catalog.*API key.*curated Express catalog/i);
    assert.equal(fetchCalls, 1);
    assert.ok(
      headers.every((header) => new Headers(header).get("x-goog-api-key") === "vertex-express-key")
    );
    assert.ok(body.models.some((model: { id?: string }) => model.id.startsWith("gemini-")));
    assert.ok(!body.models.some((model: { id?: string }) => model.id.includes("grok")));
  });

  test("Vertex API-key endpoint rejection remains intentional and names the HTTP failure", async () => {
    for (const status of [400, 403]) {
      const connection = await seedVertexConnection({ apiKey: "vertex-express-key" });
      globalThis.fetch = async () => Response.json({ error: { message: "Rejected" } }, { status });
      const response = await callRoute(connection.id);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.intentional, true);
      assert.match(body.warning, new RegExp("HTTP " + status));
    }
  });

  test("Vertex transient HTTP and network failures do not become intentional catalogs", async () => {
    for (const status of [429, 500, 503, 0]) {
      const connection = await seedVertexConnection({ apiKey: "vertex-express-key" });
      globalThis.fetch = async () => {
        if (!status) throw new Error("Fixture network failure");
        return Response.json({ error: { message: "Unavailable" } }, { status });
      };
      const response = await callRoute(connection.id);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.intentional, undefined);
      assert.match(body.warning, /temporarily unavailable/);
    }
  });

  test("Vertex authorization API key detects and persists its project for curated partner models", async () => {
    const connection = await seedVertexConnection({ apiKey: "vertex-authorization-key" });
    const calledUrls: string[] = [];
    globalThis.fetch = async (url, init) => {
      const calledUrl = String(url);
      calledUrls.push(calledUrl);
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "vertex-authorization-key");
      return Response.json(
        {
          error: {
            status: "PERMISSION_DENIED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_SERVICE_BLOCKED",
                metadata: { consumer: "projects/316081256616" },
              },
            ],
          },
        },
        { status: 403 }
      );
    };

    const response = await callRoute(connection.id);
    const body = await response.json();
    const byId = new Map(
      body.models.map((model: { id: string; targetFormat?: string }) => [model.id, model])
    );
    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.equal(body.projectIdAutoDetected, true);
    assert.equal(body.catalogMode, "curated_project");
    // #12328 — a projectId-configured connection whose live discovery fails must still name the
    // real failure reason instead of silently falling back to a 200 with no warning at all.
    assert.match(body.warning, /HTTP 403/);
    assert.equal(byId.get("xai/grok-4.6")?.targetFormat, "openai");
    assert.equal(byId.get("zai-org/glm-5-maas")?.targetFormat, "openai");
    assert.equal(byId.get("qwen/qwen3-next-80b-a3b-instruct-maas")?.targetFormat, "openai");
    assert.ok(!byId.has("GLM-5.1-FP8"));
    assert.ok(!byId.has("Qwen3.6-35B-A3B"));
    assert.equal(calledUrls.length, 1);
    // #12328 — Express-key discovery must validate against Vertex AI itself (aiplatform.googleapis.com),
    // never generativelanguage.googleapis.com (a different Google service that always rejects a
    // genuine Vertex Express key).
    assert.equal(new URL(calledUrls[0]).hostname, "aiplatform.googleapis.com");
    assert.ok(!calledUrls[0].includes("vertex-authorization-key"));

    const saved = await providersDb.getProviderConnectionById(connection.id);
    assert.equal(saved?.projectId, "316081256616");
  });

  // #12328 — a connection that already has a projectId configured (not auto-detected) previously
  // fell back to a silent 200 with NO warning at all when live discovery failed, which was even
  // less visible than the generic no-projectId message. The projectId-configured branch must
  // always carry a warning naming the real failure reason, same as the no-projectId branch.
  test("Vertex API key with a pre-configured projectId still surfaces a warning when discovery fails", async () => {
    const connection = await seedVertexConnection({
      apiKey: "vertex-preconfigured-key",
      projectId: "pre-existing-project",
    });
    globalThis.fetch = async () =>
      Response.json({ error: { message: "Rejected" } }, { status: 400 });

    const response = await callRoute(connection.id);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.equal(body.catalogMode, "curated_project");
    assert.equal(body.projectIdAutoDetected, false);
    assert.match(body.warning, /HTTP 400/);
    assert.match(body.warning, /curated Express catalog/i);

    const saved = await providersDb.getProviderConnectionById(connection.id);
    assert.equal(saved?.projectId, "pre-existing-project");
  });

  test("Vertex Service Account discovery merges Gemini and all partner transport catalogs", async () => {
    const connection = await seedVertexConnection({
      accessToken: "ya29.vertex-model-discovery",
    });
    const calledUrls: string[] = [];
    globalThis.fetch = async (url) => {
      const calledUrl = String(url);
      calledUrls.push(calledUrl);
      if (calledUrl.includes("generativelanguage.googleapis.com")) {
        return Response.json({
          models: [
            {
              name: "models/gemini-3.1-pro-preview",
              displayName: "Gemini 3.1 Pro Preview",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/gemini-3.7-flash",
              displayName: "Gemini 3.7 Flash",
              supportedGenerationMethods: ["generateContent"],
              inputTokenLimit: 900000,
              outputTokenLimit: 60000,
            },
          ],
        });
      }
      if (calledUrl.includes("/models/gemini/3-7-flash?hl=en")) {
        return new Response(
          `<table>
          <tr><th>Model ID</th><td>gemini-3.7-flash</td></tr>
          <tr><th>Token limits</th><td>Context window</td><td>1,048,576</td></tr>
          <tr><th>Maximum output tokens</th><td>65,536</td></tr>
        </table>`,
          { headers: { "Last-Modified": "Thu, 03 Sep 2026 10:00:00 GMT" } }
        );
      }
      if (calledUrl.includes("/publishers/google/models")) {
        return Response.json({
          publisherModels: [
            { name: "publishers/google/models/gemini-3.7-flash" },
            { name: "publishers/google/models/gemini-3.1-flash-image" },
          ],
        });
      }
      if (calledUrl.includes("/publishers/anthropic/models")) {
        return Response.json({
          publisherModels: [{ name: "publishers/anthropic/models/claude-sonnet-4-6" }],
        });
      }
      if (calledUrl.includes("/publishers/xai/models")) {
        return Response.json({
          publisherModels: [{ name: "publishers/xai/models/grok-4.6" }],
        });
      }
      if (calledUrl.includes("/publishers/mistralai/models")) {
        return Response.json({
          publisherModels: [{ name: "publishers/mistralai/models/mistral-medium-3" }],
        });
      }
      return new Response("unexpected discovery URL", { status: 500 });
    };

    const response = await callRoute(connection.id);
    const body = await response.json();
    const byId = new Map(
      body.models.map((model: { id: string; targetFormat?: string }) => [model.id, model])
    );
    const gemini37 = byId.get("gemini-3.7-flash") as
      | {
          contextWindow?: number;
          inputTokenLimit?: number;
          outputTokenLimit?: number;
          metadataProvenance?: { vertexDocs?: { source?: string } };
        }
      | undefined;

    assert.equal(response.status, 200);
    assert.equal(body.source, "api");
    assert.ok(byId.has("gemini-3.1-pro-preview"));
    assert.ok(byId.has("gemini-3.7-flash"));
    assert.equal(gemini37?.contextWindow, 1048576);
    assert.equal(gemini37?.inputTokenLimit, 900000);
    assert.equal(gemini37?.outputTokenLimit, 60000);
    assert.equal(gemini37?.metadataProvenance?.vertexDocs?.source, "google-cloud-docs");
    assert.ok(!byId.has("gemini-3.1-flash-image"));
    assert.equal(byId.get("claude-sonnet-4-6")?.targetFormat, "claude");
    assert.equal(byId.get("xai/grok-4.6")?.targetFormat, "openai");
    assert.equal(byId.get("mistral-medium-3")?.targetFormat, "openai");
    assert.ok(calledUrls.some((url) => url.includes("/v1beta1/publishers/xai/models")));
    assert.ok(calledUrls.some((url) => url.includes("/v1beta1/publishers/google/models")));
    assert.ok(
      calledUrls
        .filter((url) => url.includes("/v1beta1/publishers/"))
        .every((url) => url.includes("pageSize=300"))
    );
  });

  test("Vertex Service Account keeps usable xAI results when Gemini listing is blocked", async () => {
    const connection = await seedVertexConnection({ accessToken: "ya29.vertex-xai-only" });
    globalThis.fetch = async (url) => {
      const calledUrl = String(url);
      if (calledUrl.includes("generativelanguage.googleapis.com")) {
        return Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 });
      }
      if (calledUrl.includes("/publishers/xai/models")) {
        return Response.json({
          publisherModels: [{ name: "publishers/xai/models/grok-4.6" }],
        });
      }
      return Response.json({ publisherModels: [] });
    };

    const response = await callRoute(connection.id);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.source, "api");
    assert.ok(body.models.some((model: { id?: string }) => model.id === "xai/grok-4.6"));
    assert.equal(body.catalogMode, "live_vertex_catalog");
    assert.equal(body.warning, undefined);
  });
});

describe("antigravity-live-roster-catalog-12608", () => {
  /**
   * #12608 — the Antigravity/AGY catalog refresh must follow what `:fetchAvailableModels`
   * really serves, not what we assume it stopped serving.
   *
   * Contract source (hermetic stand-in for a live call): the 18-model roster an Antigravity
   * account imported in discussion #15568 (screenshot "Available Models", 2026-10), served in
   * the `{ models: { "<id>": { displayName } } }` shape the discovery normalizer parses
   * (open-sse/config/antigravityUpstream.ts → :fetchAvailableModels). A mocked roster proves
   * the code matches THIS shape; it cannot prove Google still answers that way.
   */
  // Ids from the #15568 screenshot (every row shown there is a model the upstream returned).
  const LIVE_ROSTER_IDS = [
    "claude-sonnet-4-6",
    "gemini-3.7-flash-tiered",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash-tiered",
    "gemini-3.1-pro-low",
    "gemini-3.8-flash-tiered",
    "claude-opus-4-6-thinking",
    "gemini-3-flash",
    "gemini-pro-agent",
    "gpt-oss-120b-medium",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-high",
    "claude-opus-5-5-low",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-low",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-high",
  ] as const;

  // Served-and-observed ids the refresh must NOT hide (the PR retired these three).
  const LIVE_FLASH_IDS_THAT_MUST_STAY = [
    "gemini-3.7-flash-tiered",
    "gemini-3.6-flash-tiered",
    "gemini-3-flash",
    "gemini-3.8-flash-tiered",
  ] as const;

  // Absent from the captured roster AND already retired/non-chat: must stay hidden.
  const STALE_IDS_THAT_STAY_HIDDEN = [
    "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low",
    "gemini-3.6-flash-high",
    "gemini-3.5-flash-high",
    "gemini-2.5-flash",
    "gemini-2.5-computer-use-preview-10-2025",
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-tts-preview",
  ] as const;

  function liveFetchStub() {
    const models: Record<string, { displayName: string }> = {};
    for (const id of [...LIVE_ROSTER_IDS, ...STALE_IDS_THAT_STAY_HIDDEN]) {
      models[id] = { displayName: `upstream:${id}` };
    }
    return async (url: string | URL | Request) => {
      if (String(url).includes(":loadCodeAssist") || String(url).includes(":onboardUser")) {
        return new Response("nope", { status: 503 });
      }
      return Response.json({ models });
    };
  }

  async function discover(provider: "antigravity" | "agy") {
    antigravityVersion.seedAntigravityIdeVersionCache("1.22.2");
    antigravityVersion.seedAntigravityCliVersionCache("1.22.2");
    const connection = await providersDb.createProviderConnection({
      provider,
      authType: "oauth",
      name: `${provider}-live-roster`,
      accessToken: `${provider}-access`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { autoFetchModels: true },
    });
    globalThis.fetch = liveFetchStub() as typeof fetch;
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as { source: string; models: Array<{ id: string }> };
    assert.equal(response.status, 200);
    assert.equal(body.source, "api", `${provider}: discovery must come from the stubbed live list`);
    return new Set(body.models.map((model) => model.id));
  }

  beforeEach(async () => {
    antigravityVersion.clearAntigravityVersionCaches();
    await resetStorage();
  });
  after(() => {
    antigravityVersion.clearAntigravityVersionCaches();
  });

  for (const provider of ["antigravity", "agy"] as const) {
    test(`#12608 ${provider}: discovery keeps every served shared -tiered/Flash id from the live roster`, async () => {
      const discovered = await discover(provider);
      for (const id of LIVE_FLASH_IDS_THAT_MUST_STAY) {
        assert.ok(
          discovered.has(id),
          `${provider}: ${id} is served live and must stay discoverable`
        );
      }
    });

    test(`#12608 ${provider}: discovery still hides stale / non-chat ids absent from the live roster`, async () => {
      const discovered = await discover(provider);
      for (const id of STALE_IDS_THAT_STAY_HIDDEN) {
        assert.equal(discovered.has(id), false, `${provider}: ${id} must stay hidden`);
      }
    });
  }

  test("#12608 the 3.7 display tiers alias to a -tiered id that discovery does not hide", async () => {
    const { resolveAntigravityModelId } =
      await import("../../../open-sse/config/antigravityModelAliases.ts");
    for (const display of ["gemini-3.7-flash", "gemini-3.7-flash-high", "gemini-3.7-flash-low"]) {
      const upstream = resolveAntigravityModelId(display);
      assert.equal(upstream, "gemini-3.7-flash-tiered");
      assert.equal(
        isDiscoverableAntigravityModelId(upstream),
        true,
        "alias target must stay listed"
      );
      assert.equal(isDiscoverableAgyModelId(upstream), true, "alias target must stay listed (agy)");
    }
  });

  test("#12608 AGY keeps the quota rows of image-only models (no regression from the chat-only pattern)", () => {
    for (const id of ["gemini-3.1-flash-image", "gemini-3-pro-image-preview"]) {
      // Chat discovery hides them on both surfaces…
      assert.equal(isDiscoverableAgyModelId(id), false, `${id} is not a chat model`);
      assert.equal(isDiscoverableAntigravityModelId(id), false, `${id} is not a chat model`);
      // …but their live quota buckets stay visible on both (Provider Limits).
      assert.equal(isUserVisibleAntigravityQuotaModelId(id), true);
      assert.equal(isUserVisibleAgyQuotaModelId(id), true, `${id} quota must stay visible on agy`);
      // Provider Limits normalization on agy keeps them too (it did on the release tip, where
      // agy only excluded the tab_* ids; the new chat-only pattern must not change that).
      assert.equal(isUsageQuotaKeyAllowed("agy", id), true, `${id} quota key must stay allowed`);
      assert.equal(normalizeUsageQuotaKey("agy", id), id, `${id} quota key must survive`);
    }
    // Retired/chat-irrelevant buckets are still dropped.
    assert.equal(isUserVisibleAgyQuotaModelId("gemini-3.5-flash-high"), false);
    assert.equal(isUserVisibleAgyQuotaModelId("gemini-3.1-flash-tts-preview"), false);
  });

  test("#12608 Gemini 3.8 Flash pricing is its own constant, pinned to the 3.7 promo rates on purpose", async () => {
    const shared = await import("../../../src/shared/constants/pricing/shared-tiers.ts");
    const rates = {
      input: 0.75,
      output: 3.75,
      cached: 0.075,
      reasoning: 3.75,
      cache_creation: 0.75,
    };
    // The release tip already publishes GEMINI_3_8_FLASH_PROMO_PRICING as the distinct 3.8
    // export (same current promo rates as 3.7, so the two can diverge later). Do not add a
    // second GEMINI_3_8_FLASH_PRICING alias on top of that.
    assert.deepEqual(shared.GEMINI_3_8_FLASH_PROMO_PRICING, rates);
    assert.notEqual(shared.GEMINI_3_8_FLASH_PROMO_PRICING, shared.GEMINI_3_7_FLASH_PROMO_PRICING);
    const oauth = DEFAULT_PRICING_OAUTH as Record<string, Record<string, unknown>>;
    for (const provider of ["ag", "antigravity", "agy"]) {
      for (const tier of ["low", "medium", "high"]) {
        assert.equal(
          oauth[provider][`gemini-3.8-flash-${tier}`],
          shared.GEMINI_3_8_FLASH_PROMO_PRICING
        );
        // 3.7 is still callable through the -tiered alias, so its pricing is kept too.
        assert.equal(
          oauth[provider][`gemini-3.7-flash-${tier}`],
          shared.GEMINI_3_7_FLASH_PROMO_PRICING,
          `${provider}: 3.7 ${tier} pricing must not be dropped while 3.7-tiered is served`
        );
      }
    }
  });
});
