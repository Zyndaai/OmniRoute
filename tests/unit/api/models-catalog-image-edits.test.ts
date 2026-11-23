// Image edit routes (/v1/images/edits, the Codex Images route) and image models in the /v1/models
// catalog: OpenRouter and Adobe Firefly edits, combo fall-through, Codex GPT Image dispatch and
// image-vs-chat catalog typing.
//
// Merged from 5 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// restores `globalThis.fetch` and resets the database, the API-key state and the catalog cache in
// its own hooks (each former file started from an empty store); the database handle is closed once
// at the end of the file.
import "../../_setup/disableAdobeBrowser.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { cleanupTempDataDir } from "../../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-models-catalog-image-edits-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-image-edits-test-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "image-combo-edits-12547-jwt";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const imageRoute = await import("../../../src/app/api/v1/images/generations/route.ts");
const imageEditRoute = await import("../../../src/app/api/v1/images/edits/route.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const catalogCacheMod = await import("../../../src/app/api/v1/models/catalogCache.ts");
const { handleImageGeneration } = await import("../../../open-sse/handlers/imageGeneration.ts");
const { getAllImageModels } = await import("../../../open-sse/config/imageRegistry.ts");
const { executeImageCombo } = await import("../../../open-sse/services/imageCombo.ts");
const { ADOBE_FIREFLY_IMAGE_UPLOAD_URL, ADOBE_FIREFLY_IMAGE_SUBMIT_URL } =
  await import("../../../open-sse/services/adobeFireflyClient.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

interface ErrorResponseBody {
  error: { message: string; code?: string };
}

interface ImageResponseBody {
  data: Array<{ b64_json?: string; url?: string }>;
}

const originalFetch = globalThis.fetch;

/** Start a describe from an empty database, API-key state, data dir, fetch and catalog cache. */
async function resetAll() {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await resetTestDb();
  await catalogCacheMod.__flushCatalogBackgroundRefreshForTest();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

function dataUrlPng(bytes: number[]): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

const REF_A = dataUrlPng([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

after(async () => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  await core.resetDbInstance();
  await cleanupTempDataDir(TEST_DATA_DIR);
});

describe("10197-openrouter-image-edits-route", () => {
  // #10197 (tiangao88): route-level coverage for the built-in OpenRouter branch
  // that /v1/images/edits gained in this PR. Exercises the actual POST(request)
  // handler so the credentials / rate-limit / unified-Image-API forwarding branches
  // added to route.ts itself are proven, not just the downstream service call.
  //
  // Before this change: POST /v1/images/edits rejected the built-in `openrouter`
  // provider ("Image edit is not supported for built-in provider"), so image
  // Combos routing through OpenRouter could generate but never edit. OpenRouter's
  // current reference-image contract is POST /api/v1/images with input_references.

  function seedOpenRouterConnection(overrides: { rateLimitedUntil?: string | null } = {}) {
    return providersDb.createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: "openrouter-test",
      apiKey: "sk-or-test-openrouter-edits",
      isActive: true,
      testStatus: "active",
      rateLimitedUntil: overrides.rateLimitedUntil ?? null,
    });
  }

  beforeEach(resetAll);

  test("#10197 v1 image edit POST forwards built-in openrouter edits to the unified Image API", async () => {
    await seedOpenRouterConnection();

    let hitUrl: string | null = null;
    let hitAuth: string | null = null;
    let hitBody = "";

    globalThis.fetch = async (url, init: RequestInit = {}) => {
      hitUrl = String(url);
      const headers = init.headers;
      hitAuth =
        headers instanceof Headers
          ? String(headers.get("authorization") || "")
          : String(
              (headers as Record<string, string> | undefined)?.authorization ||
                (headers as Record<string, string> | undefined)?.Authorization ||
                ""
            );
      // The OpenRouter adapter sends JSON with input_references, not multipart.
      const raw = init.body;
      if (typeof raw === "string") hitBody = raw;
      else if (raw instanceof Uint8Array) hitBody = Buffer.from(raw).toString("utf8");
      else if (raw instanceof ArrayBuffer) hitBody = Buffer.from(raw).toString("utf8");
      else if (raw && typeof (raw as { arrayBuffer?: unknown }).arrayBuffer === "function") {
        hitBody = Buffer.from(
          await (raw as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer()
        ).toString("utf8");
      }
      return new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openrouter/google/gemini-3.1-flash-image-preview",
          prompt: "add a red hat",
          images: [REF_A],
        }),
      })
    );
    const body = (await response.json()) as ImageResponseBody;

    assert.equal(response.status, 200);
    assert.ok(body.data[0].b64_json, "edit must return an image payload");

    // OpenRouter's current image-to-image endpoint is the unified Image API.
    assert.equal(hitUrl, "https://openrouter.ai/api/v1/images");
    // Must carry the OpenRouter connection key as a Bearer token.
    assert.equal(hitAuth, "Bearer sk-or-test-openrouter-edits");
    assert.ok(hitBody, "JSON body must be captured");
    const forwarded = JSON.parse(hitBody) as {
      model?: string;
      prompt?: string;
      input_references?: Array<{ image_url?: { url?: string } }>;
    };
    assert.equal(forwarded.model, "google/gemini-3.1-flash-image-preview");
    assert.equal(forwarded.prompt, "add a red hat");
    assert.equal(forwarded.input_references?.length, 1);
    assert.match(forwarded.input_references?.[0]?.image_url?.url || "", /^data:image\/png;base64,/);
  });

  test("#10197 v1 image edit POST surfaces missing openrouter credentials", async () => {
    // No openrouter connection seeded at all.
    globalThis.fetch = async () => {
      throw new Error("Missing-credentials path must not reach upstream");
    };

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openrouter/openai/gpt-5-image-mini",
          prompt: "edit this",
          images: [REF_A],
        }),
      })
    );
    const body = (await response.json()) as ErrorResponseBody;

    assert.equal(response.status, 401);
    assert.match(body.error.message, /No credentials for provider: openrouter/);
    // Hard Rule #12 — error responses must never leak a raw stack trace.
    assert.ok(!body.error.message.includes("at /"));
  });

  test("#10197 v1 image edit POST surfaces openrouter rate-limit sentinel", async () => {
    await seedOpenRouterConnection({
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    globalThis.fetch = async () => {
      throw new Error("Rate-limited path must not reach upstream");
    };

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openrouter/openai/gpt-5.4-image-2",
          prompt: "edit this",
          images: [REF_A],
        }),
      })
    );
    const body = (await response.json()) as ErrorResponseBody;

    assert.equal(response.status, 429);
    assert.match(body.error.message, /All accounts rate limited/);
    assert.ok(!body.error.message.includes("at /"));
  });
});

describe("8510-adobe-firefly-edits-route", () => {
  // #8510 (artickc, feat/adobe-firefly-reference-images): route-level coverage for the Adobe
  // Firefly branch that /v1/images/edits gained in this PR. Exercises the actual
  // POST(request) handler (not the inner handleAdobeFireflyImageGeneration helper directly,
  // which tests/unit/services/adobe-firefly.test.ts already covers) so the credentials /
  // rate-limit / 4-reference-cap branches added to route.ts itself are proven, not just the
  // downstream service call.

  async function seedAdobeFireflyConnection(
    overrides: { apiKey?: string; rateLimitedUntil?: string | null } = {}
  ) {
    return providersDb.createProviderConnection({
      provider: "adobe-firefly",
      authType: "apikey",
      name: "adobe-firefly-test",
      apiKey: overrides.apiKey ?? userImsJwt(),
      isActive: true,
      testStatus: "active",
      rateLimitedUntil: overrides.rateLimitedUntil ?? null,
    });
  }

  // Mirrors tests/unit/services/adobe-firefly.test.ts's userImsJwt() helper — a synthetic,
  // non-guest IMS access token shape so resolveAdobeAccessToken() accepts it directly
  // without needing a live cookie->token exchange call.
  function userImsJwt(userId = "0EB@AdobeID"): string {
    return (
      `eyJhbGciOiJSUzI1NiJ9.` +
      Buffer.from(
        JSON.stringify({ user_id: userId, type: "access_token", client_id: "clio-playground-web" })
      ).toString("base64url") +
      `.` +
      "sig".padEnd(40, "x")
    );
  }

  const REF_B = dataUrlPng([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);

  beforeEach(resetAll);

  test("#8510 v1 image edit POST uploads Adobe Firefly reference images and dispatches referenceBlobs", async () => {
    await seedAdobeFireflyConnection();

    const uploadedIds: string[] = [];
    let submitBody: Record<string, unknown> | null = null;

    globalThis.fetch = async (url, init: RequestInit = {}) => {
      const stringUrl = String(url);
      if (stringUrl === ADOBE_FIREFLY_IMAGE_UPLOAD_URL) {
        const id = `blob-${uploadedIds.length + 1}`;
        uploadedIds.push(id);
        return new Response(JSON.stringify({ images: [{ id }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (stringUrl === ADOBE_FIREFLY_IMAGE_SUBMIT_URL) {
        submitBody = JSON.parse(String(init.body || "{}"));
        return new Response(
          JSON.stringify({ links: { result: "https://poll.example/job/img1" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }
      if (stringUrl === "https://poll.example/job/img1") {
        return new Response(
          JSON.stringify({
            status: "COMPLETED",
            outputs: [{ image: { presignedUrl: "https://cdn.example/edited-out.png" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected URL: ${stringUrl}`);
    };

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "adobe-firefly/nano-banana-pro",
          prompt: "combine these two references",
          images: [REF_A, REF_B],
        }),
      })
    );
    const body = (await response.json()) as ImageResponseBody;

    assert.equal(response.status, 200);
    assert.equal(body.data[0].url, "https://cdn.example/edited-out.png");

    // referenceBlobs upload path: both distinct reference images must have been uploaded
    // to Firefly storage and forwarded as referenceBlobs on the generate-async dispatch.
    assert.equal(uploadedIds.length, 2, "both reference images must be uploaded individually");
    assert.ok(submitBody, "generate-async must have been called");
    const referenceBlobs = (submitBody as Record<string, unknown>).referenceBlobs as Array<{
      id: string;
    }>;
    assert.ok(Array.isArray(referenceBlobs), "generate-async payload must carry referenceBlobs");
    assert.deepEqual(referenceBlobs.map((r) => r.id).sort(), [...uploadedIds].sort());
  });

  test("#8510 v1 image edit POST rejects more than 4 Adobe Firefly reference images", async () => {
    await seedAdobeFireflyConnection();
    globalThis.fetch = async () => {
      throw new Error("Over-cap Adobe Firefly reference sets must not reach upstream");
    };

    const images = Array.from({ length: 5 }, (_, i) => dataUrlPng([0x89, 0x50, 0x4e, 0x47, i + 1]));
    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "adobe-firefly/nano-banana-pro",
          prompt: "combine these references",
          images,
        }),
      })
    );
    const body = (await response.json()) as ErrorResponseBody;

    assert.equal(response.status, 400);
    assert.match(
      body.error.message,
      /Adobe Firefly image edit supports at most 4 reference images/
    );
    // Hard Rule #12 — every error response routes through buildErrorBody/sanitizeErrorMessage
    // and must never leak a raw stack trace.
    assert.ok(!body.error.message.includes("at /"));
  });

  test("#8510 v1 image edit POST surfaces missing Adobe Firefly credentials", async () => {
    // No adobe-firefly connection seeded at all.
    globalThis.fetch = async () => {
      throw new Error("Missing-credentials path must not reach upstream");
    };

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "adobe-firefly/nano-banana-pro",
          prompt: "edit this",
          images: [REF_A],
        }),
      })
    );
    const body = (await response.json()) as ErrorResponseBody;

    assert.equal(response.status, 401);
    assert.match(body.error.message, /No credentials for provider: adobe-firefly/);
    assert.ok(!body.error.message.includes("at /"));
  });

  test("#8510 v1 image edit POST surfaces Adobe Firefly rate-limit sentinel", async () => {
    await seedAdobeFireflyConnection({
      rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    globalThis.fetch = async () => {
      throw new Error("Rate-limited path must not reach upstream");
    };

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "adobe-firefly/nano-banana-pro",
          prompt: "edit this",
          images: [REF_A],
        }),
      })
    );
    const body = (await response.json()) as ErrorResponseBody;

    assert.equal(response.status, 429);
    assert.match(body.error.message, /All accounts rate limited/);
    assert.ok(!body.error.message.includes("at /"));
  });
});

describe("codex-images-dedicated-endpoint", () => {
  // Codex GPT Image models must use the dedicated Codex Images routes
  // (`/backend-api/codex/images/{generations,edits}`), not the Responses hosted
  // `image_generation` tool. The hosted tool ignores the requested image model (the
  // backend pins `gpt-image-2-codex`), and the chat model that has to call the tool can
  // decline, which surfaced as a 502. These tests drive the public handler and route
  // paths with a mocked upstream and assert the outbound URL, body (model forwarded, no
  // tool call), headers, and the OpenAI image envelope returned to the caller.
  const IMAGES_BASE = "https://chatgpt.com/backend-api/codex/images";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

  function imagesResponse(b64: string, outputTokens = 472) {
    return new Response(
      JSON.stringify({
        created: 1790000000,
        data: [{ b64_json: b64, generation_id: "gen_1" }],
        background: "opaque",
        output_format: "png",
        quality: "low",
        size: "1312x1199",
        usage: {
          input_tokens: 19,
          input_tokens_details: { image_tokens: 0, text_tokens: 19 },
          output_tokens: outputTokens,
          output_tokens_details: { image_tokens: outputTokens, text_tokens: 0 },
          total_tokens: 19 + outputTokens,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  function captureFetch(calls: Captured[], respond = () => imagesResponse("ZmxhcmU=")) {
    globalThis.fetch = async (url, options: RequestInit = {}) => {
      calls.push({
        url: String(url),
        headers: options.headers as Record<string, string>,
        body: JSON.parse(String(options.body || "{}")),
      });
      return respond();
    };
  }

  beforeEach(resetAll);

  test("Codex GPT Image generation posts to the dedicated Images route and forwards the model", async () => {
    const calls: Captured[] = [];
    captureFetch(calls);

    const result = await handleImageGeneration({
      body: {
        model: "codex/gpt-image-2.5-flare",
        prompt: "a ceramic teacup",
        size: "1024x1536",
        quality: "hd",
      },
      credentials: { accessToken: "codex-token", providerSpecificData: { workspaceId: "ws-1" } },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, `${IMAGES_BASE}/generations`);
    assert.deepEqual(call.body, {
      prompt: "a ceramic teacup",
      model: "gpt-image-2.5-flare",
      n: 1,
      size: "1024x1536",
      quality: "high",
    });
    assert.equal(call.headers.Authorization, "Bearer codex-token");
    assert.equal(call.headers["chatgpt-account-id"], "ws-1");
    assert.equal(call.headers.originator, "codex_cli_rs");
    assert.equal(call.headers.Accept, "application/json");
    assert.match(call.headers["x-codex-image-turn-id"], UUID_RE);

    // OpenAI gpt-image envelope: bytes in b64_json by default, plus the upstream usage block.
    assert.equal(result.data.created, 1790000000);
    assert.deepEqual(result.data.data, [{ b64_json: "ZmxhcmU=" }]);
    assert.equal(result.data.usage.output_tokens_details.image_tokens, 472);
  });

  test("Codex GPT Image generation fans out n>1, sums usage, and honors response_format=url", async () => {
    const calls: Captured[] = [];
    let index = 0;
    captureFetch(calls, () => imagesResponse(index++ === 0 ? "Zmlyc3Q=" : "c2Vjb25k", 429));

    const result = await handleImageGeneration({
      body: { model: "cx/gpt-image-2", prompt: "kitten", n: 2, response_format: "url" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, `${IMAGES_BASE}/generations`);
      assert.equal(call.body.model, "gpt-image-2");
      assert.equal(call.body.n, 1);
    }
    assert.notEqual(
      calls[0].headers["x-codex-image-turn-id"],
      calls[1].headers["x-codex-image-turn-id"]
    );
    assert.deepEqual(result.data.data, [
      { url: "data:image/png;base64,Zmlyc3Q=" },
      { url: "data:image/png;base64,c2Vjb25k" },
    ]);
    assert.equal(result.data.usage.output_tokens, 858);
    assert.equal(result.data.usage.total_tokens, 896);
  });

  test("Codex Images errors keep the free-plan guard, retryable access errors, and sanitization", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("request must not reach upstream");
    };
    const tooMany = await handleImageGeneration({
      body: { model: "codex/gpt-image-2", prompt: "kitten", n: 11 },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(tooMany.status, 400);
    assert.match(String(tooMany.error), /between 1 and 10/);
    assert.equal(fetchCalls, 0);

    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("free-plan request must not reach upstream");
    };
    const freePlan = await handleImageGeneration({
      body: { model: "codex/gpt-image-2.5-flare", prompt: "kitten" },
      credentials: {
        accessToken: "codex-token",
        providerSpecificData: { chatgptPlanType: "free" },
      },
      log: null,
    });
    assert.equal(freePlan.success, false);
    assert.equal(freePlan.retryable, true);
    assert.equal(fetchCalls, 0);

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          detail:
            "The 'gpt-image-2.5-flare' model is not supported when using Codex with a ChatGPT account.",
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    const accessError = await handleImageGeneration({
      body: { model: "codex/gpt-image-2.5-flare", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(accessError.status, 400);
    assert.equal(accessError.retryable, true);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "boom", authorization: "Bearer upstream-secret" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const upstreamError = await handleImageGeneration({
      body: { model: "codex/gpt-image-2", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(upstreamError.status, 403);
    assert.equal(upstreamError.retryable, undefined);
    assert.doesNotMatch(JSON.stringify(upstreamError.error), /upstream-secret/);

    globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const empty = await handleImageGeneration({
      body: { model: "codex/gpt-image-2", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });
    assert.equal(empty.status, 502);
    assert.match(String(empty.error), /no b64_json/);

    globalThis.fetch = async () =>
      ({
        ok: true,
        text: async () => {
          throw new Error("socket reset while reading response");
        },
      }) as unknown as Response;
    const unreadable = (await handleImageGeneration({
      body: { model: "codex/gpt-image-2", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    })) as { success: false; status: number; error: unknown };
    assert.equal(unreadable.status, 502);
    assert.match(String(unreadable.error), /response error/i);
  });

  test("v1 image generation route serves codex/gpt-image-2.5-flare from the Images route", async () => {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "codex-images",
      apiKey: "codex-oauth-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: Captured[] = [];
    captureFetch(calls);

    const response = await imageRoute.POST(
      new Request("http://localhost/api/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-image-2.5-flare", prompt: "a ceramic teacup" }),
      })
    );
    const body = (await response.json()) as { data: Array<{ b64_json?: string; url?: string }> };

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${IMAGES_BASE}/generations`);
    assert.equal(calls[0].body.model, "gpt-image-2.5-flare");
    assert.equal(calls[0].body.tools, undefined);
    assert.equal(calls[0].headers.Authorization, "Bearer codex-oauth-token");
    assert.equal(body.data[0].b64_json, "ZmxhcmU=");
    assert.equal(body.data[0].url, undefined);
  });

  test("v1 image edit route sends Codex GPT Image references to the Images edits route", async () => {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "codex-images-edit",
      apiKey: "codex-oauth-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: Captured[] = [];
    captureFetch(calls, () => imagesResponse("ZWRpdGVk"));

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3]);
    const formData = new FormData();
    formData.set("prompt", "make the cup blue");
    formData.set("model", "codex/gpt-image-2.5-flare");
    formData.append("image[]", new File([jpeg], "style.jpg", { type: "image/jpeg" }));
    formData.append("image", new File([png], "cup.png", { type: "image/png" }));

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", { method: "POST", body: formData })
    );
    const body = (await response.json()) as { data: Array<{ b64_json?: string }> };

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, `${IMAGES_BASE}/edits`);
    assert.equal(call.body.model, "gpt-image-2.5-flare");
    assert.equal(call.body.prompt, "make the cup blue");
    assert.equal(call.body.n, 1);
    assert.equal(call.body.tools, undefined);
    assert.deepEqual(call.body.images, [
      { image_url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` },
      { image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
    ]);
    assert.match(call.headers["x-codex-image-turn-id"], UUID_RE);
    assert.equal(body.data[0].b64_json, "ZWRpdGVk");
  });

  test("GPT Image 2.5 forwards 16 references and rejects 17 before upstream", async () => {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "codex-images-16",
      apiKey: "codex-oauth-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: Captured[] = [];
    captureFetch(calls, () => imagesResponse("ZWRpdGVk"));

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const requestFor = (count: number) => {
      const formData = new FormData();
      formData.set("prompt", "combine the color references");
      formData.set("model", "codex/gpt-image-2.5-flare");
      for (let index = 0; index < count; index += 1) {
        formData.append(
          "image[]",
          new File([png], "reference-" + (index + 1) + ".png", { type: "image/png" })
        );
      }
      return new Request("http://localhost/api/v1/images/edits", {
        method: "POST",
        body: formData,
      });
    };

    const valid = await imageEditRoute.POST(requestFor(16));
    assert.equal(valid.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, IMAGES_BASE + "/edits");
    assert.equal(calls[0].body.model, "gpt-image-2.5-flare");
    const forwarded = calls[0].body.images as Array<{ image_url: string }>;
    assert.equal(forwarded.length, 16);
    assert.ok(forwarded.every((image) => image.image_url.startsWith("data:image/png;base64,")));

    const oversized = await imageEditRoute.POST(requestFor(17));
    assert.equal(oversized.status, 400);
    const error = (await oversized.json()) as { error: { message: string } };
    assert.match(error.error.message, /at most 16 reference images/i);
    assert.equal(calls.length, 1, "invalid edit must not reach upstream");
  });

  test("v1 image edit route sends Codex GPT Image 2.5 Sunburst references to the Images edits route", async () => {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "codex-sunburst-edit",
      apiKey: "codex-oauth-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: Captured[] = [];
    captureFetch(calls, () => imagesResponse("ZWRpdGVk"));

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const formData = new FormData();
    formData.set("prompt", "make the cup blue");
    formData.set("model", "codex/gpt-image-2.5-sunburst");
    formData.append("image", new File([png], "cup.png", { type: "image/png" }));

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", { method: "POST", body: formData })
    );
    const body = (await response.json()) as { data: Array<{ b64_json?: string }> };

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, `${IMAGES_BASE}/edits`);
    assert.equal(call.body.model, "gpt-image-2.5-sunburst");
    assert.equal(call.body.prompt, "make the cup blue");
    assert.equal(call.body.n, 1);
    assert.equal(call.body.tools, undefined);
    assert.deepEqual(call.body.images, [
      { image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
    ]);
    assert.match(call.headers["x-codex-image-turn-id"], UUID_RE);
    assert.equal(body.data[0].b64_json, "ZWRpdGVk");
  });

  test("v1 image generation route serves codex/gpt-image-2.5-sunburst from the Images route", async () => {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "codex-sunburst-generation",
      apiKey: "codex-oauth-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: Captured[] = [];
    captureFetch(calls);

    const response = await imageRoute.POST(
      new Request("http://localhost/api/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-image-2.5-sunburst",
          prompt: "a ceramic teacup",
        }),
      })
    );
    const body = (await response.json()) as { data: Array<{ b64_json?: string; url?: string }> };

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${IMAGES_BASE}/generations`);
    assert.equal(calls[0].body.model, "gpt-image-2.5-sunburst");
    assert.equal(calls[0].body.tools, undefined);
    assert.equal(calls[0].headers.Authorization, "Bearer codex-oauth-token");
    assert.equal(body.data[0].b64_json, "ZmxhcmU=");
    assert.equal(body.data[0].url, undefined);
  });

  test("v1 image edit route rejects unregistered Codex GPT Image ids without upstream calls", async () => {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "codex-unknown-image-edit",
      apiKey: "codex-oauth-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: Captured[] = [];
    captureFetch(calls);

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const formData = new FormData();
    formData.set("prompt", "make the cup blue");
    formData.set("model", "codex/gpt-image-9-notreal");
    formData.append("image", new File([png], "cup.png", { type: "image/png" }));

    const response = await imageEditRoute.POST(
      new Request("http://localhost/api/v1/images/edits", { method: "POST", body: formData })
    );
    const body = (await response.json()) as { error: { message: string } };

    assert.equal(response.status, 400);
    assert.match(body.error.message, /Unsupported Codex image edit model/);
    assert.equal(calls.length, 0);
  });

  test("GPT-5.6 Codex image ids stay on the hosted Responses tool", async () => {
    const calls: Captured[] = [];
    captureFetch(calls, () => {
      const event = {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_1",
          status: "completed",
          result: "aG9zdGVk",
        },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { status: 200 });
    });

    const result = await handleImageGeneration({
      body: { model: "codex/gpt-5.6-sol-image", prompt: "kitten" },
      credentials: { accessToken: "codex-token" },
      log: null,
    });

    assert.equal(result.success, true);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(calls[0].body.model, "gpt-5.6-sol");
    assert.deepEqual(calls[0].body.tools, [{ type: "image_generation", output_format: "png" }]);
    assert.ok(
      getAllImageModels().some((model: { id: string }) => model.id === "codex/gpt-image-2.5-flare")
    );
  });
});

describe("image-combo-edits-fallback-12547", () => {
  // #12547 (diegosouzapw endorsed): /v1/images/edits must iterate a combo's targets
  // the same way /v1/images/generations does (#9239), so a combo whose FIRST target
  // isn't edit-capable (or lacks credentials) falls through to a later edit-capable
  // target instead of flattening to the first target and hard-erroring.
  //
  // Before this change: /v1/images/edits resolved a bare combo name to its first
  // target via resolveSingleImageComboTarget() and dispatched only that one. A combo
  // like ["openai/gpt-image-2", "openrouter/..."] hard-errored ("Image edit is not
  // supported for built-in provider openai") even though the OpenRouter target could
  // have serviced the edit. Missing credentials on the first target were likewise a
  // hard 401 for the whole request.
  //
  // After this change: the edits route diverts bare combos through the same shared
  // runImageComboTargets loop generations uses, filtered to edit-capable targets.

  function seedOpenRouterConnection() {
    return providersDb.createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: "openrouter-combo-edit",
      apiKey: "sk-or-combo-edit-12547",
      isActive: true,
      testStatus: "active",
      rateLimitedUntil: null,
    });
  }

  function editRequest(model: string, images: string[] = [REF_A]): Request {
    return new Request("http://localhost/api/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "add a red hat", images }),
    });
  }

  /** Mock a successful OpenRouter unified-Image-API edit response. */
  function mockOpenRouterSuccess(): void {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
  }

  beforeEach(resetAll);

  // ---------------------------------------------------------------------------
  // Discriminant #1 — first target is NOT edit-capable, a later one is.
  // RED on base (400 "not supported for built-in provider openai"); GREEN with fix.
  // ---------------------------------------------------------------------------
  test("#12547 edits combo falls through a non-edit-capable first target to a later one", async () => {
    await seedOpenRouterConnection();
    mockOpenRouterSuccess();
    await combosDb.createCombo({
      name: "edit-fallback-combo",
      strategy: "priority",
      // openai/gpt-image-2 is a built-in provider with NO OpenAI-compatible edit
      // endpoint (the single-model path hard-errors on it); the openrouter target can edit.
      models: ["openai/gpt-image-2", "openrouter/google/gemini-3.1-flash-image-preview"],
    });

    const response = await imageEditRoute.POST(editRequest("edit-fallback-combo"));
    const body = (await response.json()) as ImageResponseBody;

    assert.equal(response.status, 200, "must fall through to the edit-capable openrouter target");
    assert.ok(body.data?.[0]?.b64_json, "edit returns an image payload from the later target");
  });

  // ---------------------------------------------------------------------------
  // Discriminant #2 — first target IS edit-capable but lacks credentials.
  // Matching generations, missing credentials is a SKIP (not a hard 401). A later
  // credentialed target services the edit.
  // RED on base (401 "No credentials for provider: codex"); GREEN with fix.
  // ---------------------------------------------------------------------------
  test("#12547 edits combo skips an edit-capable first target missing credentials", async () => {
    await seedOpenRouterConnection(); // only openrouter is credentialed; codex is not
    mockOpenRouterSuccess();
    await combosDb.createCombo({
      name: "edit-skip-nocreds-combo",
      strategy: "priority",
      models: ["codex/gpt-5.6-sol", "openrouter/google/gemini-3.1-flash-image-preview"],
    });

    const response = await imageEditRoute.POST(editRequest("edit-skip-nocreds-combo"));
    const body = (await response.json()) as ImageResponseBody;

    assert.equal(response.status, 200, "missing creds on the first target must skip, not 401");
    assert.ok(
      body.data?.[0]?.b64_json,
      "edit returns an image payload from the credentialed target"
    );
  });

  // ---------------------------------------------------------------------------
  // Guard — a combo with no edit-capable target reports a clear 400 (no stack leak).
  // ---------------------------------------------------------------------------
  test("#12547 edits combo with no edit-capable targets returns a clean 400", async () => {
    globalThis.fetch = async () => {
      throw new Error("No edit-capable target must never reach upstream");
    };
    await combosDb.createCombo({
      name: "no-edit-capable-combo",
      strategy: "priority",
      // openai + a chat model: neither exposes an OpenAI-compatible edit endpoint.
      models: ["openai/gpt-image-2", "openai/gpt-4o"],
    });

    const response = await imageEditRoute.POST(editRequest("no-edit-capable-combo"));
    const body = (await response.json()) as ErrorResponseBody;

    assert.equal(response.status, 400);
    assert.match(body.error.message, /No image-edit-capable targets/);
    assert.ok(!body.error.message.includes("at /"), "no stack trace leak");
  });

  // ---------------------------------------------------------------------------
  // /v1/images/generations behavior is unchanged by the shared-loop extraction.
  // The generation combo path still filters non-image targets and reports the
  // image-capable-but-uncredentialed error (not the filtering error).
  // ---------------------------------------------------------------------------
  function createLog() {
    const record = () => () => 0;
    return { info: record(), warn: record(), error: record(), debug: record() };
  }

  test("#12547 generations combo still rejects a chat-only combo with 'No images-capable targets'", async () => {
    await combosDb.createCombo({
      name: "gen-chat-only-combo",
      strategy: "priority",
      models: ["openai/gpt-4o"],
    });

    const response = await executeImageCombo(
      "gen-chat-only-combo",
      { model: "gen-chat-only-combo", prompt: "a cat" },
      {
        request: new Request("http://localhost/v1/images/generations", { method: "POST" }),
        policy: { apiKeyInfo: { id: "k", name: "k" } },
      },
      Date.now(),
      createLog() as never
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as ErrorResponseBody;
    assert.match(JSON.stringify(body), /No images-capable targets/);
  });

  test("#12547 generations combo still surfaces missing credentials for image targets", async () => {
    await combosDb.createCombo({
      name: "gen-img-no-conn-combo",
      strategy: "priority",
      models: ["openai/gpt-image-2", "openai/gpt-image-1.5"],
    });

    const response = await executeImageCombo(
      "gen-img-no-conn-combo",
      { model: "gen-img-no-conn-combo", prompt: "a cat", n: 1 },
      {
        request: new Request("http://localhost/v1/images/generations", { method: "POST" }),
        policy: { apiKeyInfo: { id: "k", name: "k" } },
      },
      Date.now(),
      createLog() as never
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as ErrorResponseBody;
    // Image-capable targets were found (so NOT the filtering error); the failure is credentials.
    assert.ok(!JSON.stringify(body).includes("No images-capable targets"));
  });
});

describe("image-model-not-in-chat-catalog-6457", () => {
  // Regression test for #6457 — huggingface/stabilityai/stable-diffusion-xl-base-1.0
  // (an image/diffusion model) was listed as a CHAT model in GET /v1/models, so firing
  // POST /v1/chat/completions with it hit the upstream and returned a raw HuggingFace
  // "[400] The requested model '...' is not a chat model." error.
  //
  // Root cause: the synced-provider-models loop in catalog.ts (fed by live discovery —
  // e.g. HuggingFace's own `/v1/models`) defaults a model's `endpoints` to `["chat"]`
  // whenever the upstream discovery payload carries no modality/endpoint info, which is
  // exactly what HuggingFace's live catalog returns for image models. That produced a
  // second, bogus chat-typed entry for the SAME id already correctly listed with
  // `type: "image"` by the imageRegistry loop — and catalogDedupe.ts keys on
  // (id, type, subtype), so the two distinct-`type` entries both survived.
  //
  // Fix: skip an exact-provider registered image model from the chat-catalog loop only
  // when synced metadata does not explicitly advertise `chat` or `responses`. The image
  // registry loop still adds the correctly typed image entry, while multi-capability
  // models keep both entries.

  beforeEach(resetAll);

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

  test("#6457 image/diffusion model discovered via live sync is NOT listed as a chat model", async () => {
    const connection = await seedProviderConnection("huggingface");

    // Simulate what HuggingFace's live `/v1/models` discovery persists for an
    // image/diffusion model: no supportedEndpoints/modality info at all — the exact
    // upstream shape that made the synced-models loop default to `["chat"]`.
    await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", connection.id, [
      { id: "stabilityai/stable-diffusion-xl-base-1.0", name: "Stable Diffusion XL (HF)" },
      { id: "meta-llama/llama-3.1-8b-instruct", name: "Llama 3.1 8B" },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      data: Array<{ id: string; type?: string }>;
    };

    const imageModelEntries = body.data.filter((m) =>
      m.id.includes("stabilityai/stable-diffusion-xl-base-1.0")
    );

    assert.ok(imageModelEntries.length > 0, "the image model must still be listed somewhere");
    for (const entry of imageModelEntries) {
      assert.equal(
        entry.type,
        "image",
        `every listing of the diffusion model must be type:"image", got ${JSON.stringify(entry)}`
      );
    }

    // A real chat model synced alongside it must still be listed as chat (no `type`,
    // per the OpenAI-compatible convention used throughout this catalog).
    const chatModelEntries = body.data.filter((m) =>
      m.id.includes("meta-llama/llama-3.1-8b-instruct")
    );
    assert.ok(chatModelEntries.length > 0, "the real chat model must still be listed");
    for (const entry of chatModelEntries) {
      assert.equal(entry.type, undefined, "the real chat model must not carry a non-chat type");
    }
  });

  test("Codex Responses and image entries keep distinct public IDs for the same upstream model", async () => {
    const connection = await seedProviderConnection("codex");

    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
      {
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        supportedEndpoints: ["responses"],
      },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models?prefix=alias")
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      data: Array<{ id: string; type?: string; supported_endpoints?: string[] }>;
    };
    const entries = body.data.filter((model) => model.id.endsWith("/gpt-5.6-sol"));

    assert.ok(
      entries.some(
        (model) => model.type !== "image" && model.supported_endpoints?.includes("responses")
      ),
      "explicit responses support must keep the synced chat entry"
    );
    assert.ok(
      entries.every((model) => model.type !== "image"),
      "an image entry must not shadow the Responses model ID"
    );
    assert.ok(
      body.data.some((model) => model.id === "codex/gpt-5.6-sol-image" && model.type === "image"),
      "the image surface must remain available under its distinct catalog ID"
    );
  });
});
