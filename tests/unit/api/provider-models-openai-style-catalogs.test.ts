// Provider models route: OpenAI-style aggregator catalogs (live /models discovery, seeded
// fallback, base-URL overrides, curated embeddings merge). Merged from fourteen files so the
// heavy `src/app/api/providers/[id]/models/route.ts` module graph loads once; each original
// file is one `describe` below, named after the file it came from.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pm-openai-style-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { APIKEY_PROVIDERS } = await import("../../../src/shared/constants/providers.ts");
const { PROVIDER_ENDPOINTS } = await import("../../../src/shared/constants/config.ts");
const { REGISTRY: providerRegistry } = await import("../../../open-sse/config/providerRegistry.ts");
const { isValidModel } = await import("../../../src/shared/constants/models.ts");
const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsRoute = await import("../../../src/app/api/providers/[id]/models/route.ts");
const providerSets =
  await import("../../../src/app/api/providers/[id]/models/discovery/providerSets.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const embeddingRegistry = await import("../../../open-sse/config/embeddingRegistry.ts");
const staticModels = await import("../../../src/lib/providers/staticModels.ts");

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

interface ModelsBody {
  provider: string;
  connectionId?: string;
  models: Array<{ id: string }>;
  source?: string;
}

describe("aimlapi-discovery-route", () => {
  // AI/ML API (aimlapi) — route-level guard for the live catalog envelope (#13667).
  //
  // The live /models endpoint answers with the OpenAI-style envelope
  // `{ object: "list", data: [...] }` and the `openai/chat-completions` type. The
  // older route test fed a bare array of `chat-completion` rows — neither of which
  // the catalog has produced since the schema change — so the route passed there
  // while returning zero models in production.
  before(resetStorage);
  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("provider models route unwraps the live AI/ML API catalog envelope (#13667)", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "aimlapi",
      authType: "apikey",
      name: "aimlapi-envelope",
      apiKey: "aiml-key",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { autoFetchModels: true },
    });
    let calledUrl = "";
    globalThis.fetch = async (url) => {
      calledUrl = String(url);
      return Response.json({
        object: "list",
        data: [
          { id: "openai/gpt-5", type: "openai/chat-completions", info: { name: "GPT-5" } },
          {
            id: "anthropic/claude-sonnet-4-6",
            type: "openai/chat-completions",
            info: { name: "Claude 4.6 Sonnet" },
          },
          { id: "flux/flux-pro", type: "openai/image-generations", info: { name: "FLUX Pro" } },
        ],
      });
    };

    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as { source: string; models: Array<{ id: string }> };

    // RED before the fix: `Array.isArray(data)` was false for the envelope, so every
    // row was discarded and the route fell back to the static seed.
    assert.equal(response.status, 200);
    assert.equal(body.source, "api");
    assert.equal(calledUrl, "https://api.aimlapi.com/models");
    const ids = body.models.map((m) => m.id);
    assert.ok(ids.includes("openai/gpt-5") && ids.includes("anthropic/claude-sonnet-4-6"));
    assert.ok(!ids.includes("flux/flux-pro"), "non-chat model types are filtered out");
  });
});

describe("airforce-v1-double-prefix-5899", () => {
  /**
   * Regression for #5899 (PR #5920): the OpenAI-compatible models-discovery URL
   * builder must strip a trailing `/v1` UNCONDITIONALLY before appending
   * `/v1/models`. A gateway baseUrl like ".../v1/chat/completions" was reduced to
   * ".../v1" (the old `else if` skipped the /v1 strip once `/chat/completions`
   * matched) and then produced ".../v1/v1/models" — a 308 redirect that blocked
   * model discovery. The fix converts the `/v1` strip to an independent `if`
   * (guarding against a literal "scheme://v1" authority) in BOTH the general
   * discovery path and the `provider === "openai"` custom-base-URL path.
   */
  before(resetStorage);

  test("#5899 openai gateway baseUrl ending in /v1/chat/completions never probes /v1/v1/models", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "airforce-gateway",
      apiKey: "sk-airforce",
      providerSpecificData: { baseUrl: "https://api.airforce/v1/chat/completions" },
    });

    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      requestedUrls.push(u);
      // The correctly-stripped candidate must be the one that serves models.
      if (u === "https://api.airforce/v1/models") {
        return Response.json({ object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-5" }] });
      }
      // The double-prefixed URL upstream answered with a 308 redirect (#5899).
      if (u === "https://api.airforce/v1/v1/models") {
        return new Response(null, { status: 308, headers: { location: u } });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(
      requestedUrls.includes("https://api.airforce/v1/models"),
      `expected a request to the correctly-stripped /v1/models URL; got: ${JSON.stringify(requestedUrls)}`
    );
    assert.ok(
      !requestedUrls.includes("https://api.airforce/v1/v1/models"),
      `must never probe the double-prefixed /v1/v1/models URL; got: ${JSON.stringify(requestedUrls)}`
    );
  });
});

describe("bai-provider", () => {
  const BAI_CHAT_URL = "https://api.b.ai/v1/chat/completions";
  const BAI_MODELS_URL = "https://api.b.ai/v1/models";

  test("b.ai is registered as an API-key provider", () => {
    const entry = APIKEY_PROVIDERS.bai;
    assert.ok(entry, "APIKEY_PROVIDERS.bai must be defined");
    assert.equal(entry.id, "bai");
    assert.equal(entry.alias, "bai");
    assert.equal(entry.name, "b.ai");
    assert.equal(entry.website, "https://b.ai");
    assert.equal(entry.passthroughModels, true);
  });

  test("b.ai is distinct from the existing thebai (TheB.AI) provider", () => {
    const bai = APIKEY_PROVIDERS.bai;
    const thebai = APIKEY_PROVIDERS.thebai;
    assert.ok(bai, "APIKEY_PROVIDERS.bai must be defined");
    assert.ok(thebai, "APIKEY_PROVIDERS.thebai must be defined");
    assert.notEqual(bai.id, thebai.id);
    assert.notEqual(bai.website, thebai.website);
    assert.equal(bai.website, "https://b.ai");
    assert.equal(thebai.website, "https://theb.ai");
  });

  test("b.ai exposes the OpenAI-compatible chat completions endpoint", () => {
    assert.equal(PROVIDER_ENDPOINTS.bai, BAI_CHAT_URL);
  });

  test("b.ai registry entry uses OpenAI format with bearer API-key auth", () => {
    const entry = providerRegistry.bai;
    assert.ok(entry, "providerRegistry.bai must be defined");
    assert.equal(entry.id, "bai");
    assert.equal(entry.alias, "bai");
    assert.equal(entry.format, "openai");
    assert.equal(entry.executor, "default");
    assert.equal(entry.authType, "apikey");
    assert.equal(entry.authHeader, "bearer");
    assert.equal(entry.baseUrl, BAI_CHAT_URL);
    assert.equal(entry.modelsUrl, BAI_MODELS_URL);
    assert.equal(entry.passthroughModels, true);
  });

  test("b.ai ships no static model seed — relies fully on passthrough + live catalog", () => {
    const models = providerRegistry.bai.models;
    assert.deepEqual(models, []);
  });

  test("b.ai accepts any model id via passthrough models (GPT/Claude/Gemini/Kimi/GLM behind one key)", () => {
    assert.equal(isValidModel("bai", "gpt-5.2"), true);
    assert.equal(isValidModel("bai", "claude-opus-4-5"), true);
    assert.equal(isValidModel("bai", "gemini-3-pro"), true);
    assert.equal(isValidModel("bai", "kimi-k2.5"), true);
  });

  test("b.ai import fetches the live /v1/models catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "bai",
      authType: "apikey",
      name: "bai-live",
      apiKey: "bai-key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === BAI_MODELS_URL) {
        fetched = true;
        return Response.json({
          object: "list",
          data: [{ id: "gpt-5.2" }, { id: "claude-opus-4-5" }, { id: "kimi-k2.5" }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "bai");
      assert.equal(body.source, "api", "should serve the live upstream catalog");
      assert.ok(fetched, `should have probed ${BAI_MODELS_URL}`);
      const ids = body.models.map((model) => model.id);
      assert.ok(ids.includes("gpt-5.2"), `live catalog model missing: ${ids.join(",")}`);
      assert.ok(ids.includes("kimi-k2.5"), `live catalog model missing: ${ids.join(",")}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("b.ai import falls back to an empty local catalog when live fetch fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "bai",
      authType: "apikey",
      name: "bai-fallback",
      apiKey: "bai-key-2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "bai");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.deepEqual(
        body.models.map((model) => model.id),
        []
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("dgrid-provider", () => {
  const DGRID_CHAT_URL = "https://api.dgrid.ai/v1/chat/completions";
  const DGRID_MODELS_URL = "https://api.dgrid.ai/v1/models";
  const DGRID_FREE_ROUTER = "dgridai/free";

  test("DGrid is registered as a free API-key provider", () => {
    const entry = APIKEY_PROVIDERS.dgrid;
    assert.ok(entry, "APIKEY_PROVIDERS.dgrid must be defined");
    assert.equal(entry.id, "dgrid");
    assert.equal(entry.alias, "dgrid");
    assert.equal(entry.name, "DGrid");
    assert.equal(entry.website, "https://dgrid.ai");
    assert.equal(entry.hasFree, true);
    assert.equal(entry.passthroughModels, true);
    assert.match(entry.freeNote, /10 requests\/minute/);
    assert.match(entry.freeNote, /100 requests\/day/);
    assert.match(entry.freeNote, /\$5 lifetime top-up/);
  });

  test("DGrid exposes the OpenAI-compatible chat completions endpoint", () => {
    assert.equal(PROVIDER_ENDPOINTS.dgrid, DGRID_CHAT_URL);
  });

  test("DGrid registry entry uses OpenAI format with bearer API-key auth", () => {
    const entry = providerRegistry.dgrid;
    assert.ok(entry, "providerRegistry.dgrid must be defined");
    assert.equal(entry.id, "dgrid");
    assert.equal(entry.alias, "dgrid");
    assert.equal(entry.format, "openai");
    assert.equal(entry.executor, "default");
    assert.equal(entry.authType, "apikey");
    assert.equal(entry.authHeader, "bearer");
    assert.equal(entry.baseUrl, DGRID_CHAT_URL);
    assert.equal(entry.modelsUrl, DGRID_MODELS_URL);
    assert.equal(entry.passthroughModels, true);
  });

  test("DGrid ships the Free Models Router as the seeded default model", () => {
    const models = providerRegistry.dgrid.models;
    const ids = models.map((model: { id: string }) => model.id);
    assert.ok(ids.includes(DGRID_FREE_ROUTER), "seed list must include dgridai/free");
    assert.equal(new Set(ids).size, ids.length, "model ids must be unique");
    assert.equal(
      models.find((model: { id: string }) => model.id === DGRID_FREE_ROUTER)?.name,
      "DGrid Free Models Router"
    );
  });

  test("DGrid accepts the free router and the 200+ live catalog via passthrough models", () => {
    assert.equal(isValidModel("dgrid", DGRID_FREE_ROUTER), true);
    assert.equal(isValidModel("dgrid", "openai/gpt-4o"), true);
    assert.equal(isValidModel("dgrid", "anthropic/claude-sonnet-4"), true);
  });

  test("DGrid import fetches the live /v1/models catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "dgrid",
      authType: "apikey",
      name: "dgrid-live",
      apiKey: "dgrid-key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === DGRID_MODELS_URL) {
        fetched = true;
        return Response.json({
          object: "list",
          data: [
            { id: DGRID_FREE_ROUTER },
            { id: "openai/gpt-4o" },
            { id: "anthropic/claude-sonnet-4" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "dgrid");
      assert.equal(body.source, "api", "should serve the live upstream catalog");
      assert.ok(fetched, `should have probed ${DGRID_MODELS_URL}`);
      const ids = body.models.map((model) => model.id);
      assert.ok(ids.includes(DGRID_FREE_ROUTER), `free router missing: ${ids.join(",")}`);
      assert.ok(ids.includes("openai/gpt-4o"), `live catalog model missing: ${ids.join(",")}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("DGrid import falls back to the seeded free router when live fetch fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "dgrid",
      authType: "apikey",
      name: "dgrid-fallback",
      apiKey: "dgrid-key-2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "dgrid");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.deepEqual(
        body.models.map((model) => model.id),
        [DGRID_FREE_ROUTER]
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("qiniu-provider", () => {
  const QINIU_CHAT_URL = "https://api.qnaigc.com/v1/chat/completions";
  const QINIU_MODELS_URL = "https://api.qnaigc.com/v1/models";

  test("Qiniu is registered as an API-key provider", () => {
    const entry = APIKEY_PROVIDERS.qiniu;
    assert.ok(entry, "APIKEY_PROVIDERS.qiniu must be defined");
    assert.equal(entry.id, "qiniu");
    assert.equal(entry.alias, "qiniu");
    assert.equal(entry.name, "Qiniu");
    assert.equal(entry.website, "https://www.qiniu.com");
    assert.equal(entry.passthroughModels, true);
  });

  test("Qiniu exposes the OpenAI-compatible chat completions endpoint", () => {
    assert.equal(PROVIDER_ENDPOINTS.qiniu, QINIU_CHAT_URL);
  });

  test("Qiniu registry entry uses OpenAI format with bearer API-key auth", () => {
    const entry = providerRegistry.qiniu;
    assert.ok(entry, "providerRegistry.qiniu must be defined");
    assert.equal(entry.id, "qiniu");
    assert.equal(entry.alias, "qiniu");
    assert.equal(entry.format, "openai");
    assert.equal(entry.executor, "default");
    assert.equal(entry.authType, "apikey");
    assert.equal(entry.authHeader, "bearer");
    assert.equal(entry.baseUrl, QINIU_CHAT_URL);
    assert.equal(entry.modelsUrl, QINIU_MODELS_URL);
    assert.equal(entry.passthroughModels, true);
  });

  test("Qiniu ships no static model seed — relies fully on passthrough + live catalog", () => {
    const models = providerRegistry.qiniu.models;
    assert.deepEqual(models, []);
  });

  test("Qiniu accepts any model id via passthrough models (DeepSeek/Claude/Kimi behind one key)", () => {
    assert.equal(isValidModel("qiniu", "deepseek-v3"), true);
    assert.equal(isValidModel("qiniu", "deepseek-v3.2"), true);
    assert.equal(isValidModel("qiniu", "claude-sonnet-4-5"), true);
    assert.equal(isValidModel("qiniu", "kimi-k2"), true);
  });

  test("Qiniu import fetches the live /v1/models catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "qiniu",
      authType: "apikey",
      name: "qiniu-live",
      apiKey: "qiniu-key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === QINIU_MODELS_URL) {
        fetched = true;
        return Response.json({
          object: "list",
          data: [{ id: "deepseek-v3" }, { id: "deepseek-v4" }, { id: "kimi-k2" }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "qiniu");
      assert.equal(body.source, "api", "should serve the live upstream catalog");
      assert.ok(fetched, `should have probed ${QINIU_MODELS_URL}`);
      const ids = body.models.map((model) => model.id);
      assert.ok(ids.includes("deepseek-v3"), `live catalog model missing: ${ids.join(",")}`);
      assert.ok(ids.includes("kimi-k2"), `live catalog model missing: ${ids.join(",")}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Qiniu import falls back to an empty local catalog when live fetch fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "qiniu",
      authType: "apikey",
      name: "qiniu-fallback",
      apiKey: "qiniu-key-2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "qiniu");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.deepEqual(
        body.models.map((model) => model.id),
        []
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("nara-models-fetch-14748", () => {
  beforeEach(resetStorage);

  test("#14748 NaraRouter import fetches every model from its live catalog", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "nara",
      authType: "apikey",
      name: "nara-live-catalog",
      apiKey: "nara-test-key",
    });

    const upstreamModels = [
      { id: "agnes-2.0-flash" },
      { id: "laguna-s-2.1" },
      { id: "minimax-m3-free" },
      { id: "mistral-large" },
      { id: "qwen3.8-27b" },
      { id: "nara-live-only-model" },
    ];
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return Response.json({ object: "list", data: upstreamModels });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.source, "api");
      assert.deepEqual(
        body.models.map((model: { id: string }) => model.id),
        upstreamModels.map(({ id }) => id)
      );
      assert.ok(requestedUrls.includes("https://router.bynara.id/v1/models"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("NaraRouter model import falls back to its seed when live discovery fails", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "nara",
      authType: "apikey",
      name: "nara-catalog-fallback",
      apiKey: "nara-test-key",
    });

    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return new Response("bad gateway", { status: 502 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.source, "local_catalog");
      assert.ok(body.models.length > 0, "the pinned NaraRouter seed should remain available");
      assert.ok(requestedUrls.includes("https://router.bynara.id/v1/models"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("NaraRouter model import falls back when the live catalog is malformed", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "nara",
      authType: "apikey",
      name: "nara-malformed-catalog",
      apiKey: "nara-test-key",
    });

    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return new Response("{", { status: 200 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );

      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.source, "local_catalog");
      assert.match(body.warning, /API unavailable/);
      assert.deepEqual(requestedUrls, [
        "https://router.bynara.id/v1/models",
        "https://router.bynara.id/models",
        "https://router.bynara.id/v1/chat/completions/models",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("NaraRouter model discovery continues after a non-safe fetch error", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "nara",
      authType: "apikey",
      name: "nara-nonsafe-continue",
      apiKey: "nara-test-key",
    });

    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      const target = String(url);
      requestedUrls.push(target);
      if (target === "https://router.bynara.id/v1/models") {
        const response = new Response(
          JSON.stringify({ object: "list", data: [{ id: "should-not-win" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
        Object.defineProperty(response, "json", {
          value: async () => {
            throw new TypeError("unexpected catalog payload");
          },
        });
        return response;
      }
      return Response.json({ object: "list", data: [{ id: "nara-recovered-model" }] });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.source, "api");
      assert.deepEqual(
        body.models.map((model: { id: string }) => model.id),
        ["nara-recovered-model"]
      );
      assert.ok(
        requestedUrls.includes("https://router.bynara.id/models"),
        "a non-Safe error must not abort discovery before the next endpoint"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("zenmux-models-fetch-4202", () => {
  /**
   * TDD regression for #4202: ZenMux `GET /models` served a stale 9-entry hardcoded
   * registry list (source:"local_catalog", "API unavailable — using local catalog")
   * instead of the live upstream catalog, so the free models ZenMux advertises
   * (e.g. `z-ai/glm-5.2-free`, `moonshotai/kimi-k2.7-code-free`) never showed up.
   *
   * Root cause: `zenmux` carries a correct `modelsUrl` in the registry, but is not
   * classified by any live-fetch branch of the import route — not `openai-compatible-*`,
   * not self-hosted, and not in NAMED_OPENAI_STYLE_PROVIDERS. So the route never probes
   * the upstream `/models` and falls through to the registry's hardcoded `models[]`.
   *
   * Fix: add `zenmux` to NAMED_OPENAI_STYLE_PROVIDERS so the route does a live
   * `<baseUrl>/models` fetch (the `/chat/completions`-stripped `${base}/models` candidate
   * resolves to `https://zenmux.ai/api/v1/models`), falling back to the local catalog
   * only when the upstream fetch fails — import never breaks. Mirrors #3976 (llm7/byteplus).
   */
  test("#4202 ZenMux import fetches the live /api/v1/models catalog (incl. the free models)", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "zenmux",
      authType: "apikey",
      name: "zenmux-live",
      apiKey: "zm-key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // `${base}/models` after stripping `/chat/completions` → the registry modelsUrl.
      if (String(url) === "https://zenmux.ai/api/v1/models") {
        fetched = true;
        return Response.json({
          object: "list",
          data: [
            { id: "z-ai/glm-5.2-free" },
            { id: "moonshotai/kimi-k2.7-code-free" },
            { id: "openai/gpt-5" },
          ],
        });
      }
      // Bogus probe variants (…/v1/v1/models, …/chat/completions/models) → 404
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "zenmux");
      assert.equal(body.source, "api", "should serve the live upstream catalog, not local_catalog");
      assert.ok(fetched, "should have probed https://zenmux.ai/api/v1/models");
      const ids = body.models.map((m) => m.id);
      assert.ok(
        ids.includes("z-ai/glm-5.2-free"),
        `live free models missing from catalog: ${ids.join(",")}`
      );
      assert.ok(
        ids.includes("moonshotai/kimi-k2.7-code-free"),
        `live free models missing: ${ids.join(",")}`
      );
      // The stale hardcoded registry entry must not be what we serve.
      assert.ok(
        !ids.includes("mistralai/mistral-large-2512"),
        "served the stale hardcoded registry catalog instead of the live list"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("#4202 ZenMux import falls back to the local catalog when the live fetch fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "zenmux",
      authType: "apikey",
      name: "zenmux-fallback",
      apiKey: "zm-key-2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "zenmux");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.ok(body.models.length > 0, "fallback catalog should be non-empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("vercel-gateway-models-fetch-4249", () => {
  /**
   * TDD regression for #4249: the Vercel AI Gateway "import models" button on
   * /models returned nothing usable — clicking import did not load the live
   * catalog, even though manually adding the same models works. (@FerLuisxd)
   *
   * Root cause: `vercel-ai-gateway` carries a real `baseUrl`
   * (`https://ai-gateway.vercel.sh/v1/chat/completions`, format "openai") in the
   * registry, but is not classified by any live-fetch branch of the import route.
   * Fix: add `vercel-ai-gateway` to NAMED_OPENAI_STYLE_PROVIDERS so the route does a
   * live `<baseUrl>/models` fetch, falling back to the local catalog only when
   * the upstream fetch fails — import never breaks. Mirrors #4202 (zenmux) and
   * #3976 (llm7/byteplus).
   */
  test("#4249 Vercel AI Gateway import fetches the live /v1/models catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "vercel-ai-gateway",
      authType: "apikey",
      name: "vag-live",
      apiKey: "vck_key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // `${base}/models` after stripping `/chat/completions` → the gateway endpoint.
      if (String(url) === "https://ai-gateway.vercel.sh/v1/models") {
        fetched = true;
        return Response.json({
          object: "list",
          data: [
            { id: "xai/grok-4" },
            { id: "openai/gpt-5.1" },
            { id: "anthropic/claude-opus-4.5" },
          ],
        });
      }
      // Bogus probe variants (…/v1/v1/models, …/chat/completions/models) → 404
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "vercel-ai-gateway");
      assert.equal(body.source, "api", "should serve the live upstream catalog, not local_catalog");
      assert.ok(fetched, "should have probed https://ai-gateway.vercel.sh/v1/models");
      const ids = body.models.map((m) => m.id);
      assert.ok(ids.includes("xai/grok-4"), `live models missing from catalog: ${ids.join(",")}`);
      assert.ok(ids.includes("openai/gpt-5.1"), `live models missing: ${ids.join(",")}`);
      // The stale hardcoded registry entry must not be what we serve.
      assert.ok(
        !ids.includes("vercel/v0-1.5-md"),
        "served the stale hardcoded registry catalog instead of the live list"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("#4249 Vercel AI Gateway import falls back to the local catalog when the live fetch fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "vercel-ai-gateway",
      authType: "apikey",
      name: "vag-fallback",
      apiKey: "vck_key_2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "vercel-ai-gateway");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.ok(body.models.length > 0, "fallback catalog should be non-empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("xiaomi-mimo-models-fetch-15307", () => {
  /**
   * TDD regression for #15307: Xiaomi MiMo "import models" served the 2-entry
   * hardcoded registry seed with "API unavailable — using local catalog", even
   * though the upstream `GET /v1/models` answers with a full live catalog.
   *
   * Root cause: `xiaomi-mimo` / `xiaomi-mimo-token-plan` were not in
   * NAMED_OPENAI_STYLE_PROVIDERS, so the route never probed the upstream
   * `/models`. Same case as #4249, #4202 and #3976.
   */
  test("#15307 xiaomi-mimo providers are classified for live /models discovery", () => {
    assert.ok(providerSets.isNamedOpenAIStyleProvider("xiaomi-mimo"));
    assert.ok(providerSets.isNamedOpenAIStyleProvider("xiaomi-mimo-token-plan"));
  });

  test("#15307 xiaomi-mimo import fetches the live /v1/models catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "xiaomi-mimo",
      authType: "apikey",
      name: "mimo-live",
      apiKey: "mk_test_key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      // `${base}/models` after stripping `/v1` → `https://api.xiaomimimo.com/v1/models`.
      if (String(url) === "https://api.xiaomimimo.com/v1/models") {
        fetched = true;
        return Response.json({
          object: "list",
          data: [
            { id: "mimo-v2.5-pro" },
            { id: "mimo-v2.5" },
            { id: "mimo-v2.6-pro" },
            { id: "mimo-v2.6-flash" },
            { id: "mimo-v2.5-asr" },
            { id: "mimo-v2.5-tts" },
            { id: "mimo-v2.5-tts-voiceclone" },
            { id: "mimo-v2.5-tts-voicedesign" },
          ],
        });
      }
      // Bogus probe variants (…/v1/v1/models, …/models) → 404
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "xiaomi-mimo");
      assert.equal(body.source, "api", "should serve the live upstream catalog, not local_catalog");
      assert.ok(fetched, "should have probed https://api.xiaomimimo.com/v1/models");
      const ids = body.models.map((m) => m.id);
      for (const expected of [
        "mimo-v2.6-pro",
        "mimo-v2.6-flash",
        "mimo-v2.5-asr",
        "mimo-v2.5-tts",
      ]) {
        assert.ok(
          ids.includes(expected),
          `live model ${expected} missing from catalog: ${ids.join(",")}`
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("#15307 xiaomi-mimo-token-plan import fetches the live token-plan /v1/models catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "xiaomi-mimo-token-plan",
      authType: "apikey",
      name: "mimo-tp-live",
      apiKey: "tp_test_key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === "https://token-plan-sgp.xiaomimimo.com/v1/models") {
        fetched = true;
        return Response.json({
          object: "list",
          data: [{ id: "mimo-v2.5-pro" }, { id: "mimo-v2.5" }, { id: "mimo-v2.6-pro" }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "xiaomi-mimo-token-plan");
      assert.equal(body.source, "api", "should serve the live upstream catalog, not local_catalog");
      assert.ok(fetched, "should have probed https://token-plan-sgp.xiaomimimo.com/v1/models");
      const ids = body.models.map((m) => m.id);
      assert.ok(ids.includes("mimo-v2.6-pro"), `live model missing: ${ids.join(",")}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("#15307 xiaomi-mimo import falls back to the local catalog when the live fetch fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "xiaomi-mimo",
      authType: "apikey",
      name: "mimo-fallback",
      apiKey: "mk_test_key_2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "xiaomi-mimo");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.ok(body.models.length > 0, "fallback catalog should be non-empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("llm7-byteplus-models-fetch-3976", () => {
  /**
   * TDD regression for #3976: LLM7 (and BytePlus) `GET /models` returned a stale
   * hardcoded list instead of the live catalog.
   *
   * Root cause: `llm7`/`byteplus` carry a correct `modelsUrl` in the registry, but
   * neither is classified by any live-fetch branch of the import route, so the route
   * fell through to the registry's hardcoded `models[]` (4 entries), reported as
   * `source:"local_catalog"`.
   *
   * Fix: add `llm7` and `byteplus` to NAMED_OPENAI_STYLE_PROVIDERS so the route
   * does a live `<baseUrl>/models` fetch (falling back to the local catalog only
   * when the upstream fetch fails, so import never breaks).
   */
  test("#3976 LLM7 import fetches the live /v1/models catalog (not the 4 hardcoded models)", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "llm7",
      authType: "apikey",
      name: "llm7-live",
      apiKey: "llm7-key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === "https://api.llm7.io/v1/models") {
        fetched = true;
        return Response.json({
          object: "list",
          data: [
            { id: "gpt-5.1-nano-pro" },
            { id: "deepseek-v4-standard" },
            { id: "qwen3.6-coder-pro" },
          ],
        });
      }
      // Bogus probe variants (…/v1/v1/models, …/chat/completions/models) → 404
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "llm7");
      assert.equal(body.source, "api", "should serve the live upstream catalog, not local_catalog");
      assert.ok(fetched, "should have probed https://api.llm7.io/v1/models");
      const ids = body.models.map((m) => m.id);
      assert.ok(ids.includes("gpt-5.1-nano-pro"), `live ids missing: ${ids.join(",")}`);
      // The stale hardcoded entries must not be what we serve.
      assert.ok(!ids.includes("gpt-4o-mini-2024-07-18"), "served stale hardcoded catalog");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("#3976 LLM7 import falls back to the local catalog when the live fetch fails", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "llm7",
      authType: "apikey",
      name: "llm7-fallback",
      apiKey: "llm7-key-2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "llm7");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.ok(body.models.length > 0, "fallback catalog should be non-empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("#3976 BytePlus import fetches the live /api/v3/models catalog", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "byteplus",
      authType: "apikey",
      name: "byteplus-live",
      apiKey: "ark-key",
    });

    let fetched = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url) === "https://ark.ap-southeast.bytepluses.com/api/v3/models") {
        fetched = true;
        return Response.json({
          object: "list",
          data: [{ id: "seed-2.5-live" }, { id: "kimi-k2.5-live" }],
        });
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "byteplus");
      assert.equal(body.source, "api");
      assert.ok(
        fetched,
        "should have probed https://ark.ap-southeast.bytepluses.com/api/v3/models"
      );
      assert.ok(body.models.map((m) => m.id).includes("seed-2.5-live"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("poe-provider-models-baseurl", () => {
  // #8082: the built-in `poe` provider (passthroughModels:true, no baseUrl field
  // exposed in the UI) is routed through the generic OpenAI-style model-discovery
  // branch, which resolves its base URL ONLY from
  // `connection.providerSpecificData.baseUrl` OR `getRegistryEntry("poe")?.baseUrl`.
  // There was no REGISTRY entry for "poe", so discovery always failed with
  // {"error":"No base URL configured for provider"} even though the actual
  // inference/validation path has always had a hardcoded "https://api.poe.com/v1" fallback.
  beforeEach(resetStorage);

  test("provider models route resolves the built-in Poe registry base URL instead of failing with 'No base URL configured for provider' (#8082)", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "poe",
      authType: "apikey",
      name: "poe-8082",
      apiKey: "poe-test-key",
      isActive: true,
      testStatus: "active",
      // Mirrors the built-in provider's UI: no baseUrl field is exposed for Poe,
      // so providerSpecificData never carries one.
      providerSpecificData: {},
    });

    const seenRequests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      seenRequests.push({ url: String(url), authorization: headers.get("authorization") });
      return Response.json({ data: [{ id: "gpt-5.2", name: "GPT-5.2" }] });
    };

    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as { error?: string };

    assert.notEqual(body.error, "No base URL configured for provider");
    assert.equal(response.status, 200);
    assert.ok(
      seenRequests.some((req) => req.url.startsWith("https://api.poe.com/v1")),
      `expected a request against the Poe registry base URL, got: ${JSON.stringify(seenRequests)}`
    );
  });
});

describe("openrouter-embeddings-catalog-6976", () => {
  /** Shape of the /api/providers/[id]/models discovery payload asserted below. */
  type DiscoveredModel = { id: string; name?: string };
  type ModelsResponseBody = { source: string; models: DiscoveredModel[] };

  async function seedConnection(provider: string, overrides: Record<string, unknown> = {}) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: "or-test-key",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
      ...overrides,
    });
  }

  async function callRoute(connectionId: string) {
    return modelsRoute.GET(new Request(`http://localhost/api/providers/${connectionId}/models`), {
      params: { id: connectionId },
    });
  }

  // Postgres keeps its rows across resetDbInstance(): resetStorage empties the tables, or the
  // previous test's connection (same provider + key) and synced models leak in.
  beforeEach(resetStorage);

  test("embeddingRegistry curated openrouter catalog carries the refreshed lineup with dimensions (#6976)", () => {
    const config = embeddingRegistry.getEmbeddingProvider("openrouter");
    assert.ok(config, "openrouter embedding provider config must exist");
    const ids = config!.models.map((m) => m.id);
    for (const expected of [
      "openai/text-embedding-3-small",
      "openai/text-embedding-3-large",
      "qwen/qwen3-embedding-8b",
      "qwen/qwen3-embedding-4b",
      "baai/bge-m3",
      "mistralai/mistral-embed-2312",
      "google/gemini-embedding-001",
      "google/gemini-embedding-2",
      "google/gemini-embedding-2-preview",
    ]) {
      assert.ok(ids.includes(expected), `expected curated id ${expected}; got ${ids.join(", ")}`);
      const dim = config!.models.find((m) => m.id === expected)?.dimensions;
      assert.equal(typeof dim, "number", `${expected} must carry a dimensions value`);
    }
    assert.equal(
      config!.models.find((m) => m.id === "google/gemini-embedding-2")?.dimensions,
      3072
    );
    assert.equal(
      config!.models.find((m) => m.id === "google/gemini-embedding-2-preview")?.dimensions,
      3072
    );
  });

  test("getStaticModelsForProvider(openrouter) folds the curated embeddings into the specialty catalog (#6976)", () => {
    const specialty = staticModels.getStaticModelsForProvider("openrouter");
    assert.ok(specialty && specialty.length > 0);
    const embeddingEntry = specialty!.find((m) => m.id === "baai/bge-m3");
    assert.ok(embeddingEntry, "curated bge-m3 entry must be present in the static catalog");
    assert.equal(embeddingEntry!.apiFormat, "embeddings");
  });

  test("live discovery merges curated embeddings into the response even when /v1/models returns none (#6976)", async () => {
    const connection = await seedConnection("openrouter", {
      providerSpecificData: { autoFetchModels: true },
    });
    globalThis.fetch = async () =>
      Response.json({
        data: [{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }],
      });

    const response = await callRoute(connection.id);
    const body = (await response.json()) as ModelsResponseBody;

    assert.equal(response.status, 200);
    assert.equal(body.source, "api");
    const ids = body.models.map((m) => m.id);
    // Chat model from the live /v1/models fetch is preserved.
    assert.ok(ids.includes("anthropic/claude-sonnet-5"));
    // RED before the Step 2 merge: the live discovery success path (buildApiDiscoveryResponse)
    // returned `models` verbatim, so curated embeddings never appeared here — only on the
    // no-config local_catalog fallback. GREEN after: curated embeddings/rerank entries from
    // getStaticModelsForProvider() are folded in additively.
    assert.ok(
      ids.includes("baai/bge-m3"),
      `curated embedding baai/bge-m3 should be merged into live discovery; got: ${ids.join(", ")}`
    );
    assert.ok(ids.includes("openai/text-embedding-3-small"));
  });

  test("live discovery dedups: a model already present in the live catalog is not duplicated (#6976)", async () => {
    const connection = await seedConnection("openrouter", {
      providerSpecificData: { autoFetchModels: true },
    });
    globalThis.fetch = async () =>
      Response.json({
        // OpenRouter's live /v1/models never actually lists embedding ids today, but
        // this proves the merge is a dedup-by-id union, not a blind concat.
        data: [{ id: "baai/bge-m3", name: "BGE-M3 (live)" }],
      });

    const response = await callRoute(connection.id);
    const body = (await response.json()) as ModelsResponseBody;

    const bgeEntries = body.models.filter((m) => m.id === "baai/bge-m3");
    assert.equal(bgeEntries.length, 1, "baai/bge-m3 must appear exactly once");
    assert.equal(bgeEntries[0].name, "BGE-M3 (live)", "live entry wins over the curated duplicate");
  });
});

describe("openrouter-models-baseurl-override", () => {
  // Model discovery for the built-in `openrouter` provider was pinned to the
  // GLOBAL catalog URL in PROVIDER_MODELS_CONFIG, so the per-connection base-URL
  // override (stored as providerSpecificData.baseUrl) was silently ignored on the
  // DISCOVERY path — while the INFERENCE path honored it all along (#6147).
  // A connection pointed at a different OpenRouter region (for example the EU
  // in-region endpoint) kept importing the global catalog.
  const EU_BASE_URL = "https://eu.openrouter.ai/api/v1";
  const GLOBAL_CATALOG_URL = "https://openrouter.ai/api/v1/models";

  async function seedOpenRouterConnection(providerSpecificData: Record<string, unknown>) {
    return providersDb.createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: `openrouter-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: "[REDACTED:auth_header]",
      isActive: true,
      testStatus: "active",
      providerSpecificData,
    });
  }

  async function discover(connectionId: string) {
    const seenUrls: string[] = [];
    globalThis.fetch = async (url) => {
      seenUrls.push(String(url));
      return Response.json({ data: [{ id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" }] });
    };

    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: { id: connectionId } }
    );
    return { response, seenUrls };
  }

  beforeEach(resetStorage);

  test("openrouter model discovery honors the per-connection base URL override", async () => {
    const connection = await seedOpenRouterConnection({ baseUrl: EU_BASE_URL });

    const { response, seenUrls } = await discover(connection.id);
    assert.equal(response.status, 200);

    assert.ok(
      seenUrls.some((url) => url.startsWith(`${EU_BASE_URL}/models`)),
      `expected discovery against the overridden base URL, got: ${JSON.stringify(seenUrls)}`
    );
    assert.ok(
      !seenUrls.some((url) => url.startsWith(GLOBAL_CATALOG_URL)),
      `expected the hardcoded global catalog NOT to be used, got: ${JSON.stringify(seenUrls)}`
    );
  });

  test("openrouter discovery still uses the built-in global catalog when no override is set", async () => {
    const connection = await seedOpenRouterConnection({});

    const { response, seenUrls } = await discover(connection.id);
    assert.equal(response.status, 200);

    assert.ok(
      seenUrls.some((url) => url.startsWith(GLOBAL_CATALOG_URL)),
      `expected the built-in global catalog, got: ${JSON.stringify(seenUrls)}`
    );
  });
});

describe("openai-style-providers-4239-4155-3841", () => {
  /**
   * Batch coverage for three named OpenAI-style aggregator providers harvested in
   * the v3.8.30 cycle — all follow the zenmux (PR #4202) shape:
   *   - #4239 OpenAdapter  (https://api.openadapter.in/v1)
   *   - #4155 dit.ai       (https://api.dit.ai/v1)
   *   - #3841 TokenRouter  (https://api.tokenrouter.com/v1)
   *
   * Each is registered in APIKEY_PROVIDERS + PROVIDER_ENDPOINTS + the modular
   * registry, and added to NAMED_OPENAI_STYLE_PROVIDERS so `/models` serves the
   * live upstream catalog (falling back to the seeded list when the fetch fails).
   *
   * NOTE (Rule #18): the base paths were confirmed live (each returns a 401
   * OpenAI-style error body). The seed lists are intentionally minimal; live
   * discovery via NAMED_OPENAI_STYLE_PROVIDERS is the source of truth at runtime.
   */
  interface ProviderSpec {
    id: string;
    alias: string;
    name: string;
    website: string;
    chatUrl: string;
    modelsUrl: string;
    seedSample: string;
  }

  const SPECS: ProviderSpec[] = [
    {
      id: "openadapter",
      alias: "oad",
      name: "OpenAdapter",
      website: "https://openadapter.dev",
      chatUrl: "https://api.openadapter.in/v1/chat/completions",
      modelsUrl: "https://api.openadapter.in/v1/models",
      seedSample: "glm-4.7",
    },
    {
      id: "dit",
      alias: "dai",
      name: "DIT.ai",
      website: "https://dit.ai",
      chatUrl: "https://api.dit.ai/v1/chat/completions",
      modelsUrl: "https://api.dit.ai/v1/models",
      seedSample: "gpt-5.4",
    },
    {
      id: "tokenrouter",
      alias: "trk",
      name: "TokenRouter",
      website: "https://tokenrouter.com",
      chatUrl: "https://api.tokenrouter.com/v1/chat/completions",
      modelsUrl: "https://api.tokenrouter.com/v1/models",
      seedSample: "deepseek-v4-pro",
    },
  ];

  for (const spec of SPECS) {
    test(`${spec.name} is registered as an API-key provider with the canonical identity`, () => {
      const entry = APIKEY_PROVIDERS[spec.id];
      assert.ok(entry, `APIKEY_PROVIDERS.${spec.id} must be defined`);
      assert.equal(entry.id, spec.id);
      assert.equal(entry.alias, spec.alias);
      assert.equal(entry.name, spec.name);
      assert.equal(entry.website, spec.website);
      assert.equal(typeof entry.textIcon, "string");
    });

    test(`${spec.name} exposes the OpenAI-compatible chat completions URL`, () => {
      assert.equal(PROVIDER_ENDPOINTS[spec.id], spec.chatUrl);
    });

    test(`${spec.name} registry entry uses OpenAI format with bearer apikey auth`, () => {
      const entry = providerRegistry[spec.id];
      assert.ok(entry, `providerRegistry.${spec.id} must be defined`);
      assert.equal(entry.id, spec.id);
      assert.equal(entry.alias, spec.alias);
      assert.equal(entry.format, "openai");
      assert.equal(entry.executor, "default");
      assert.equal(entry.authType, "apikey");
      assert.equal(entry.authHeader, "bearer");
      assert.equal(entry.baseUrl, spec.chatUrl);
      assert.equal(entry.modelsUrl, spec.modelsUrl);
    });

    test(`${spec.name} ships a non-empty unique seed catalog including ${spec.seedSample}`, () => {
      const models = providerRegistry[spec.id].models;
      const ids = models.map((m: { id: string }) => m.id);
      assert.ok(ids.length >= 1, "seed list must be non-empty for the fallback path");
      assert.equal(new Set(ids).size, ids.length, "model ids must be unique");
      assert.ok(ids.includes(spec.seedSample), `seed list must include ${spec.seedSample}`);
    });
  }

  // ── Live /models discovery + fallback (the NAMED_OPENAI_STYLE_PROVIDERS branch) ──

  for (const spec of SPECS) {
    test(`#${spec.id} import fetches the live ${spec.modelsUrl} catalog`, async () => {
      await resetStorage();
      const connection = await providersDb.createProviderConnection({
        provider: spec.id,
        authType: "apikey",
        name: `${spec.id}-live`,
        apiKey: `${spec.alias}-key`,
      });

      let fetched = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url) === spec.modelsUrl) {
          fetched = true;
          return Response.json({
            object: "list",
            data: [{ id: "live-only-model-xyz" }, { id: spec.seedSample }],
          });
        }
        return new Response("not found", { status: 404 });
      };

      try {
        const response = await modelsRoute.GET(
          new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
          { params: { id: connection.id } }
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as ModelsBody;
        assert.equal(body.provider, spec.id);
        assert.equal(body.source, "api", "should serve the live upstream catalog");
        assert.ok(fetched, `should have probed ${spec.modelsUrl}`);
        const ids = body.models.map((m) => m.id);
        assert.ok(ids.includes("live-only-model-xyz"), `live model missing: ${ids.join(",")}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test(`#${spec.id} import falls back to the local seed catalog when the live fetch fails`, async () => {
      await resetStorage();
      const connection = await providersDb.createProviderConnection({
        provider: spec.id,
        authType: "apikey",
        name: `${spec.id}-fallback`,
        apiKey: `${spec.alias}-key-2`,
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

      try {
        const response = await modelsRoute.GET(
          new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
          { params: { id: connection.id } }
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as ModelsBody;
        assert.equal(body.provider, spec.id);
        assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
        assert.ok(body.models.length > 0, "fallback catalog should be non-empty");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});
