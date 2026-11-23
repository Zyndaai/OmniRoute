// /v1/models and the model-catalog routes around it: CORS echo on auth rejections, alias and catalog
// diagnostics headers, per-model health, provider model lists, discovery filters, OpenRouter-format
// pricing, functional-gateway mirrors, dashboard visibility and learned Copilot rejections.
//
// Merged from 9 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// resets the database, the API-key state, the model lockouts and the catalog cache in its own
// hooks (each former file started from an empty store), restores the environment variables and
// feature flags it changes, and the database handle is closed once at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { CALL_LOG_SETTLE_TIMEOUT_MS } from "../../helpers/callLogSettle.ts";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-catalog-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-routes-test-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "model-alias-route-jwt";
process.env.OMNIROUTE_PLUGINS_DIR = path.join(TEST_DATA_DIR, "plugins");
// These cases measure catalog contents, not the cold-build latency budget of a shared host.
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const providerNodesDb = await import("../../../src/lib/db/providers/nodes.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const pricingDb = await import("../../../src/lib/db/settings/pricing.ts");
const serviceModelsDb = await import("../../../src/lib/db/serviceModels.ts");
const featureFlagsDb = await import("../../../src/lib/db/featureFlags.ts");
const functionalGatewayDb = await import("../../../src/lib/db/functionalGatewayMirrors.ts");
const { getActiveSyncedCatalog } =
  await import("../../../src/lib/db/models/activeSyncedCatalog.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const featureFlagsUtil = await import("../../../src/shared/utils/featureFlags.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const catalogCacheMod = await import("../../../src/app/api/v1/models/catalogCache.ts");
const filters = await import("../../../src/app/api/v1/models/catalogFilters.ts");
const { getFilteredCatalogResponse } =
  await import("../../../src/app/api/v1/models/catalogDiscovery.ts");
const modelsRoute = await import("../../../src/app/api/v1/models/route.ts");
const providerModelsV1Route =
  await import("../../../src/app/api/v1/providers/[provider]/models/route.ts");
const aliasRoute = await import("../../../src/app/api/models/alias/route.ts");
const catalogRoute = await import("../../../src/app/api/models/catalog/route.ts");
const filesRoute = await import("../../../src/app/api/v1/files/route.ts");
const fileByIdRoute = await import("../../../src/app/api/v1/files/[id]/route.ts");
const { resolveListScope } = await import("../../../src/app/api/v1/_helpers/apiKeyScope.ts");
const sessionLeasesRoute = await import("../../../src/app/api/v1/session-leases/route.ts");
const chatRoute = await import("../../../src/app/api/v1/chat/completions/route.ts");
const catalogUtils =
  await import("../../../src/app/(dashboard)/dashboard/models/modelCatalogUtils.ts");
const visibilityUtils =
  await import("../../../src/app/(dashboard)/dashboard/models/catalogVisibility.ts");
const { enrichCatalogModelEntry } = await import("../../../src/lib/modelMetadataRegistry.ts");
const { findStaleComboModelRefs } = await import("../../../src/lib/combos/staleModelRefs.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const { runAsProbe } = await import("../../../src/shared/utils/probeOrigin.ts");
const { NOAUTH_PROVIDERS } = await import("../../../src/shared/constants/providers.ts");
const locks = await import("../../../open-sse/services/accountFallback.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

const originalFetch = globalThis.fetch;
const originalInitialPassword = process.env.INITIAL_PASSWORD;

/** Start a describe from an empty database, API-key state, lockouts, data dir and catalog cache. */
async function resetAll() {
  globalThis.fetch = originalFetch;
  locks.clearAllModelLockouts();
  apiKeysDb.resetApiKeyState();
  await core.resetDbInstance();
  // A fire-and-forget write from the previous test (usage rows, request logs) can still hold a
  // row lock when TRUNCATE starts and Postgres then picks one side as a deadlock victim; the
  // write finishes within moments, so retry the reset instead of failing the hook.
  for (let attempt = 1; ; attempt++) {
    try {
      await resetTestDb();
      break;
    } catch (error) {
      if ((error as { code?: string })?.code !== "40P01" || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await catalogCacheMod.__flushCatalogBackgroundRefreshForTest();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

function restoreInitialPassword() {
  if (originalInitialPassword === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = originalInitialPassword;
}

after(async () => {
  globalThis.fetch = originalFetch;
  locks.clearAllModelLockouts();
  restoreInitialPassword();
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("cors-credential-rejection-echo", () => {
  /**
   * #5242 follow-up to the CLIENT_API validated-key CORS rule.
   *
   * With REQUIRE_API_KEY=false the authz pipeline serves an unvalidated key as
   * anonymous and does not echo the Origin. A route that then refuses the key
   * with its own 401 must restore the echo so browser/Electron clients can read
   * the rejection, while a response served to the anonymous caller still gets no
   * Access-Control-Allow-Origin.
   */
  const ORIGIN = "https://app.example";
  const originalRequireApiKey = process.env.REQUIRE_API_KEY;
  const originalCorsAllowAll = process.env.CORS_ALLOW_ALL;
  const originalCorsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;

  function restoreEnv(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(async () => {
    delete process.env.CORS_ALLOW_ALL;
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.REQUIRE_API_KEY = "false";
    await resetAll();
  });

  after(() => {
    restoreEnv("REQUIRE_API_KEY", originalRequireApiKey);
    restoreEnv("CORS_ALLOW_ALL", originalCorsAllowAll);
    restoreEnv("CORS_ALLOWED_ORIGINS", originalCorsAllowedOrigins);
  });

  function crossOrigin(url: string, headers: Record<string, string> = {}) {
    return new Request(url, { headers: { origin: ORIGIN, ...headers } });
  }

  test("/v1/models 401 for a refused key echoes the Origin when management auth is configured", async () => {
    await settingsDb.updateSettings({ password: "test-password-cors", requireLogin: true });

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      crossOrigin("http://test.example.com/v1/models", { authorization: "Bearer junk" })
    );

    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "invalid_api_key");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.match(res.headers.get("Vary") || "", /Origin/);
    assert.equal(res.headers.get("Access-Control-Allow-Credentials"), null);
  });

  test("/v1/models 401 without a presented key does not echo the Origin", async () => {
    await settingsDb.updateSettings({ password: "test-password-cors", requireLogin: true });

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      crossOrigin("http://test.example.com/v1/models")
    );

    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });

  test("/v1/models served to an anonymous caller with a junk key does not echo the Origin", async () => {
    await settingsDb.updateSettings({ requireAuthForModels: false });

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      crossOrigin("http://test.example.com/v1/models", { authorization: "Bearer junk" })
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });

  test("/v1/files 401 for a refused key echoes the Origin", async () => {
    const list = await filesRoute.GET(
      crossOrigin("http://localhost/api/v1/files", { authorization: "Bearer junk" })
    );
    assert.equal(list.status, 401);
    assert.equal(list.headers.get("Access-Control-Allow-Origin"), ORIGIN);

    const byId = await fileByIdRoute.GET(
      crossOrigin("http://localhost/api/v1/files/file-x", { authorization: "Bearer junk" }),
      { params: Promise.resolve({ id: "file-x" }) }
    );
    assert.equal(byId.status, 401);
    assert.equal(byId.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  });

  test("/v1/session-leases 401 for a refused key echoes the Origin", async () => {
    const res = await sessionLeasesRoute.POST(
      new Request("http://localhost/api/v1/session-leases", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: "Bearer junk",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "status" }),
      })
    );
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(res.headers.get("Content-Type"), "application/json");
  });

  test("resolveListScope 401 echoes the Origin only when given the request", () => {
    const scope = {
      apiKey: "junk",
      apiKeyId: null,
      apiKeyMetadata: null,
      keyState: "missing",
      rejection: null,
      isSessionAuth: false,
    } as unknown as Parameters<typeof resolveListScope>[0];
    const req = crossOrigin("http://localhost/api/v1/files", { "x-api-key": "junk" });

    const withRequest = resolveListScope(scope, undefined, req);
    assert.equal(withRequest.mode, "rejected");
    if (withRequest.mode === "rejected") {
      assert.equal(withRequest.response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    }

    const withoutRequest = resolveListScope(scope);
    assert.equal(withoutRequest.mode, "rejected");
    if (withoutRequest.mode === "rejected") {
      assert.equal(withoutRequest.response.headers.get("Access-Control-Allow-Origin"), null);
    }
  });
});

describe("model-alias-route", () => {
  beforeEach(async () => {
    delete process.env.INITIAL_PASSWORD;
    await resetAll();
  });

  after(restoreInitialPassword);

  test("model alias route resolves a stored alias and emits diagnostics headers", async () => {
    await modelsDb.setModelAlias("fast-default", "openai/gpt-4o-mini");

    const response = await aliasRoute.GET(
      await makeManagementSessionRequest("http://localhost/api/models/alias?alias=fast-default", {
        headers: { "x-request-id": "req-model-alias-1" },
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Request-Id"), "req-model-alias-1");
    assert.equal(response.headers.get("X-Model-Alias-Resolved"), "openai/gpt-4o-mini");
    assert.match(response.headers.get("X-Model-Catalog-Version") || "", /^model-metadata-v1:/);
    assert.equal(body.resolved.qualifiedId, "openai/gpt-4o-mini");
    assert.equal(body.resolved.source, "stored_alias");
  });

  test("model alias route returns typed ambiguity errors for ambiguous aliases", async () => {
    const response = await aliasRoute.GET(
      await makeManagementSessionRequest(
        "http://localhost/api/models/alias?alias=claude-sonnet-4-6"
      )
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 409);
    assert.equal(body.error.code, "MODEL_ALIAS_AMBIGUOUS");
    assert.ok(Array.isArray(body.error.candidates));
    assert.equal(response.headers.get("X-Model-Alias-Resolved"), "claude-sonnet-4-6");
  });

  test("model alias route requires a dashboard session when management auth is enabled", async () => {
    process.env.INITIAL_PASSWORD = "bootstrap-password";
    await settingsDb.updateSettings({ requireLogin: true, password: "" });

    const unauthenticated = await aliasRoute.GET(
      new Request("http://localhost/api/models/alias?alias=fast-default")
    );
    const invalidToken = await aliasRoute.GET(
      new Request("http://localhost/api/models/alias?alias=fast-default", {
        headers: { authorization: "Bearer sk-invalid" },
      })
    );

    const unauthenticatedBody = (await unauthenticated.json()) as any;
    const invalidTokenBody = (await invalidToken.json()) as any;

    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticatedBody.error.message, "Authentication required");
    assert.equal(invalidToken.status, 403);
    assert.equal(invalidTokenBody.error.message, "Invalid management token");
    assert.match(
      unauthenticated.headers.get("X-Model-Catalog-Version") || "",
      /^model-metadata-v1:/
    );
  });

  test("api models catalog route reuses the unified catalog diagnostics headers", async () => {
    await providersDb.createProviderConnection({
      provider: "deepgram",
      authType: "apikey",
      name: "deepgram-audio-catalog",
      apiKey: "dg-test",
      isActive: true,
      testStatus: "active",
    });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await catalogRoute.GET(
      new Request("http://localhost/api/models/catalog", {
        headers: { "x-request-id": "req-model-catalog-1" },
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Request-Id"), "req-model-catalog-1");
    assert.match(response.headers.get("X-Model-Catalog-Version") || "", /^model-metadata-v1:/);
    assert.equal(typeof body.catalog, "object");
    assert.equal(typeof body.catalogVersion, "string");
    const nova = body.catalog.deepgram.models.find(
      (model: { id?: string }) => model.id === "deepgram/nova-3"
    );
    assert.equal(nova.type, "audio");
    assert.equal(nova.subtype, "transcription");
  });

  test("v1 models catalog emits diagnostics headers alongside the OpenAI-compatible list", async () => {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { "x-request-id": "req-v1-models-1" },
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Request-Id"), "req-v1-models-1");
    assert.match(response.headers.get("X-Model-Catalog-Version") || "", /^model-metadata-v1:/);
    assert.equal(body.object, "list");
    assert.ok(Array.isArray(body.data));
  });
});

describe("models-health-cooldown-route", () => {
  /**
   * GET /v1/models/health: per-model pause state per API key.
   *
   * One test per gate case. Lockout entries are built with the production
   * writers (`lockModel` / `lockExactModel`) against the ids of the real seeded
   * connections, and removed in `finally`, so the inputs reach the code through
   * the same store the dispatcher reads.
   */
  const { lockModel, lockExactModel, clearModelLock } = locks;

  const GLM_ALIAS = "glm";
  const GLM_MODEL_A = "glm-5.3";
  const GLM_MODEL_B = "glm-5.3-flash";

  async function seedGlmConnections(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const conn = (await providersDb.createProviderConnection({
        provider: "glm",
        authType: "apikey",
        name: `health-glm-${i}-${Date.now()}`,
        apiKey: `sk-health-${i}`,
      })) as Record<string, unknown>;
      ids.push(conn.id as string);
    }
    return ids;
  }

  function freezeNow(now: number) {
    const realNow = Date.now;
    (Date as unknown as { now: () => number }).now = () => now;
    return () => {
      (Date as unknown as { now: () => number }).now = realNow;
    };
  }

  function readStates(body: unknown): Map<string, Record<string, unknown>> {
    const data = (body as { data: Array<Record<string, unknown>> }).data;
    assert.ok(Array.isArray(data), "response must carry a data array");
    return new Map(data.map((item) => [String(item.id), item]));
  }

  function assertNoConnectionId(value: unknown, trail: string) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) assertNoConnectionId(value[i], `${trail}[${i}]`);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        assert.notEqual(key, "connectionId", `no connectionId at ${trail}.${key}`);
        assertNoConnectionId(entry, `${trail}.${key}`);
      }
    }
  }

  beforeEach(resetAll);

  test("models/health: all active connections paused renders cooling with the shortest delay first", async () => {
    const [connA, connB] = await seedGlmConnections(2);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    const now = 1_760_000_000_000;
    const unfreeze = freezeNow(now);
    try {
      lockModel("glm", connA, GLM_MODEL_A, "quota_exhausted", 6_001, {});
      lockModel("glm", connB, GLM_MODEL_A, "quota_exhausted", 61_000, {});
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> };
      assert.equal(body.object, "list");
      const entry = readStates(body).get(`${GLM_ALIAS}/${GLM_MODEL_A}`);
      assert.ok(entry, "expected the glm test model in the health list");
      assert.equal(entry.state, "cooling");
      assert.equal(entry.retry_after, 7);
      assert.equal(typeof entry.observed_at, "string");
    } finally {
      clearModelLock("glm", connA, GLM_MODEL_A);
      clearModelLock("glm", connB, GLM_MODEL_A);
      unfreeze();
    }
  });

  test("models/health: one paused connection out of three stays ok", async () => {
    const [connA] = await seedGlmConnections(3);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      lockModel("glm", connA, GLM_MODEL_A, "quota_exhausted", 60_000, {});
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const entry = readStates(await res.json()).get(`${GLM_ALIAS}/${GLM_MODEL_A}`);
      assert.ok(entry, "expected the glm test model in the health list");
      assert.equal(entry.state, "ok");
      assert.equal(entry.retry_after, undefined);
    } finally {
      clearModelLock("glm", connA, GLM_MODEL_A);
    }
  });

  test("models/health: no observation renders ok with observed_at", async () => {
    await seedGlmConnections(1);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    const res = await GET(new Request("http://localhost/api/v1/models/health"));
    assert.equal(res.status, 200);
    const entry = readStates(await res.json()).get(`${GLM_ALIAS}/${GLM_MODEL_A}`);
    assert.ok(entry, "expected the glm test model in the health list");
    assert.equal(entry.state, "ok");
    assert.equal(typeof entry.observed_at, "string");
  });

  test("models/health: codex scope lockout cools every scope member", async () => {
    const conns = await seedGlmConnections(1);
    void conns;
    const codexConn = (await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "health-codex-seed",
      accessToken: "codex-token",
    })) as Record<string, unknown>;
    const codexId = codexConn.id as string;
    const { getModelLockoutInfo } = locks;
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      lockModel("codex", codexId, "gpt-6-astra", "quota_exhausted", 60_000, {});
      assert.ok(
        getModelLockoutInfo("codex", codexId, "gpt-6-astra"),
        "precondition: codex lockout must be readable"
      );
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const states = readStates(await res.json());
      const astra =
        states.get("codex/gpt-6-astra") ??
        states.get("cx/gpt-6-astra") ??
        [...states.values()].find((item) => String(item.id).endsWith("/gpt-6-astra"));
      assert.ok(astra, "expected a gpt-6-astra row in the health list");
      assert.equal(astra.state, "cooling");
      const sibling = states.get("codex/gpt-6-sol") ?? states.get("cx/gpt-6-sol");
      if (sibling) assert.equal(sibling.state, "cooling");
    } finally {
      clearModelLock("codex", codexId, "gpt-6-astra");
    }
  });

  test("models/health: not_found locks alone never cool a model", async () => {
    const conns = await seedGlmConnections(2);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      for (const conn of conns) {
        lockModel("glm", conn, GLM_MODEL_A, "not_found", 60_000, {});
      }
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const entry = readStates(await res.json()).get(`${GLM_ALIAS}/${GLM_MODEL_A}`);
      assert.ok(entry, "expected the glm test model in the health list");
      assert.equal(entry.state, "ok");
    } finally {
      for (const conn of conns) clearModelLock("glm", conn, GLM_MODEL_A);
    }
  });

  test("models/health: exact 5xx lockout cools only the locked model", async () => {
    const conns = await seedGlmConnections(2);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      for (const conn of conns) {
        lockExactModel("glm", conn, GLM_MODEL_A, "internal_error", 60_000, {});
      }
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const states = readStates(await res.json());
      const locked = states.get(`${GLM_ALIAS}/${GLM_MODEL_A}`);
      const sibling = states.get(`${GLM_ALIAS}/${GLM_MODEL_B}`);
      assert.ok(locked, "expected the locked glm model in the health list");
      assert.equal(locked.state, "cooling");
      assert.ok(sibling, "expected the sibling glm model in the health list");
      assert.equal(sibling.state, "ok");
    } finally {
      for (const conn of conns) clearModelLock("glm", conn, GLM_MODEL_A);
    }
  });

  test("models/health: combos stay out and every item carries a state", async () => {
    await seedGlmConnections(1);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    const res = await GET(
      new Request("http://localhost/api/v1/models/health?ids=does-not-resolve%2Fnope")
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    assert.ok(body.data.length > 0, "health list should not be empty");
    const requested = body.data.find((item) => item.id === "does-not-resolve/nope");
    assert.ok(requested, "requested unresolvable id must be present");
    assert.equal(requested.state, "unknown");
    assert.equal(requested.retry_after, undefined);
    assert.equal(typeof requested.observed_at, "string");
    for (const item of body.data) {
      assert.ok(!String(item.id).startsWith("auto/"), `combo leaked: ${String(item.id)}`);
      assert.ok(
        ["ok", "cooling", "unknown"].includes(String(item.state)),
        `unexpected state for ${String(item.id)}: ${String(item.state)}`
      );
    }
  });

  test("models/health: disabled connections stay out of the cooling denominator", async () => {
    const [activeConn, idleConn] = await seedGlmConnections(2);
    await providersDb.updateProviderConnection(idleConn, { isActive: false } as never);
    invalidateDbCache("connections");
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      lockModel("glm", activeConn, GLM_MODEL_A, "quota_exhausted", 60_000, {});
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const entry = readStates(await res.json()).get(`${GLM_ALIAS}/${GLM_MODEL_A}`);
      assert.ok(entry, "expected the glm test model in the health list");
      assert.equal(entry.state, "cooling");
    } finally {
      clearModelLock("glm", activeConn, GLM_MODEL_A);
    }
  });

  test("models/health: restricted keys see only their models", async () => {
    await seedGlmConnections(1);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    const created = await apiKeysDb.createApiKey("health-restricted", "machine-health");
    await apiKeysDb.updateApiKeyPermissions(created.id, { allowedModels: [`${GLM_ALIAS}/*`] });
    const res = await GET(
      new Request("http://localhost/api/v1/models/health", {
        headers: { Authorization: `Bearer ${created.key}` },
      })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    assert.ok(body.data.length > 0, "restricted key should see its glm models");
    for (const item of body.data) {
      assert.ok(
        String(item.id).startsWith(`${GLM_ALIAS}/`) || String(item.id).startsWith("qtSd/"),
        `restricted key leaked: ${String(item.id)}`
      );
    }
  });

  test("models/health: no connectionId anywhere in the payload", async () => {
    const [connA] = await seedGlmConnections(1);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      lockModel("glm", connA, GLM_MODEL_A, "quota_exhausted", 60_000, {});
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const body = await res.json();
      assertNoConnectionId(body, "body");
    } finally {
      clearModelLock("glm", connA, GLM_MODEL_A);
    }
  });

  test("models/health: GET /v1/models is identical before and after", async () => {
    await seedGlmConnections(1);
    const health = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    } catch {}
    const before = await (
      await v1ModelsCatalog.getUnifiedModelsResponse(new Request("http://localhost/api/v1/models"))
    ).text();
    const healthRes = await health.GET(new Request("http://localhost/api/v1/models/health"));
    assert.equal(healthRes.status, 200);
    await healthRes.json();
    const after = await (
      await v1ModelsCatalog.getUnifiedModelsResponse(new Request("http://localhost/api/v1/models"))
    ).text();
    assert.equal(after, before);
  });

  test("models/health: the static health route answers, not the model catch-all", async () => {
    await seedGlmConnections(1);
    const { handleGetModelById } = await import("../../../src/app/api/v1/models/modelById.ts");
    const res = await handleGetModelById(
      new Request("http://localhost/api/v1/models/health"),
      "health",
      async () =>
        Response.json(
          {
            error: { message: "The model 'health' does not exist", code: "model_not_found" },
          },
          { status: 404 }
        )
    );
    assert.equal(res.status, 404);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    const direct = await GET(new Request("http://localhost/api/v1/models/health"));
    assert.equal(direct.status, 200);
    const body = (await direct.json()) as { object: string };
    assert.equal(body.object, "list");
  });

  test("models/health: anonymous callers get 401 when auth is required", async () => {
    await settingsDb.updateSettings({ requireLogin: true, password: "health-pw-cooldown" });
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    const res = await GET(new Request("http://localhost/api/v1/models/health"));
    assert.equal(res.status, 401);
  });

  test("models/health: model lockout plus connection cooldown still reads cooling", async () => {
    const conn = (await providersDb.createProviderConnection({
      provider: "glm",
      authType: "apikey",
      name: "health-cooldown-conn",
      apiKey: "sk-health",
      providerSpecificData: {},
    })) as Record<string, unknown>;
    const connId = conn.id as string;
    const future = new Date(Date.now() + 60_000).toISOString();
    await providersDb.updateProviderConnection(connId, { rateLimitedUntil: future } as never);
    const { GET } = await import("../../../src/app/api/v1/models/health/route.ts");
    try {
      lockModel("glm", connId, GLM_MODEL_A, "quota_exhausted", 60_000, {});
      const res = await GET(new Request("http://localhost/api/v1/models/health"));
      assert.equal(res.status, 200);
      const entry = readStates(await res.json()).get(`${GLM_ALIAS}/${GLM_MODEL_A}`);
      assert.ok(entry, "expected the glm test model in the health list");
      assert.equal(entry.state, "cooling");
    } finally {
      clearModelLock("glm", connId, GLM_MODEL_A);
    }
  });
});

describe("provider-models-v1-route", () => {
  /**
   * Tests for GET /api/v1/providers/[provider]/models
   * Covers the connection-ID fallback path added in PR #3402.
   */
  function makeRequest(provider: string) {
    return new Request(`http://localhost/api/v1/providers/${encodeURIComponent(provider)}/models`);
  }

  async function callGET(provider: string) {
    return providerModelsV1Route.GET(makeRequest(provider), {
      params: Promise.resolve({ provider }),
    });
  }

  beforeEach(resetAll);

  test("GET /v1/providers/:provider/models returns 400 for completely unknown provider", async () => {
    const res = await callGET("utterly-unknown-provider-xyz");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, "invalid_provider");
    assert.ok(body.error?.message?.includes("utterly-unknown-provider-xyz"));
  });

  test("GET /v1/providers/:provider/models accepts openai-compatible connection ID format", async () => {
    const connectionId = "openai-compatible-chat-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    // A valid compatible connection ID should NOT return 400 (passes validation gate)
    const res = await callGET(connectionId);
    // The catalog may return 200 with empty data or non-200 for other reasons,
    // but it must NOT return the "Unknown provider" 400 error.
    if (res.status === 400) {
      const body = await res.json();
      assert.notEqual(
        body.error?.code,
        "invalid_provider",
        "openai-compatible-chat-* IDs must bypass the unknown-provider 400 gate"
      );
    }
  });

  test("GET /v1/providers/:provider/models accepts anthropic-compatible connection ID format", async () => {
    // anthropic-compatible ids never embed a "-chat-" segment (#8326) — this is
    // the actual shape generated by src/app/api/provider-nodes/route.ts.
    const connectionId = "anthropic-compatible-deadbeef-0000-0000-0000-000000000000";
    const res = await callGET(connectionId);
    if (res.status === 400) {
      const body = await res.json();
      assert.notEqual(body.error?.code, "invalid_provider");
    }
  });

  test("GET /v1/providers/:provider/models accepts anthropic-compatible-cc connection ID format", async () => {
    const connectionId = "anthropic-compatible-cc-deadbeef-0000-0000-0000-000000000000";
    const res = await callGET(connectionId);
    if (res.status === 400) {
      const body = await res.json();
      assert.notEqual(body.error?.code, "invalid_provider");
    }
  });

  test("GET /v1/providers/:provider/models accepts openai-compatible-responses connection ID format", async () => {
    const connectionId = "openai-compatible-responses-deadbeef-0000-0000-0000-000000000000";
    const res = await callGET(connectionId);
    if (res.status === 400) {
      const body = await res.json();
      assert.notEqual(body.error?.code, "invalid_provider");
    }
  });

  test("GET /v1/providers/:provider/models returns synced embedded service models", async () => {
    await serviceModelsDb.saveServiceModels("cliproxyapi", [
      { id: "cli/gpt-5", name: "GPT-5 via CLIProxyAPI" },
      { id: "old-model" },
    ]);
    await serviceModelsDb.saveServiceModels("cliproxyapi", [
      { id: "cli/gpt-5", name: "GPT-5 via CLIProxyAPI" },
    ]);

    const res = await callGET("cliproxyapi");
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.object, "list");
    assert.deepEqual(
      body.data.map((model: { id: string }) => model.id),
      ["cli/gpt-5"]
    );
    assert.equal(body.data[0].owned_by, "cliproxyapi");
    assert.equal(body.data[0].parent, null);
  });

  test("#13829: compatible provider IDs return synced models owned by their public prefix", async () => {
    const providerId = "openai-compatible-chat-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const prefix = "hz";
    const modelId = "Qwen/Qwen3.6-35B-A3B-FP8";

    await providerNodesDb.createProviderNode({
      id: providerId,
      type: "openai-compatible",
      name: "Hetzner",
      prefix,
      apiType: "chat",
      baseUrl: "https://inference.example.com/v1",
    });
    const connection = await providersDb.createProviderConnection({
      provider: providerId,
      authType: "apikey",
      name: "Hetzner",
      apiKey: "test-key",
      isActive: true,
      testStatus: "active",
    });
    await modelsDb.replaceSyncedAvailableModelsForConnection(providerId, String(connection.id), [
      { id: modelId, name: modelId, source: "imported" },
    ]);

    const catalogResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const catalogBody = (await catalogResponse.json()) as { data: Array<Record<string, unknown>> };
    const catalogModel = catalogBody.data.find((model) => model.id === `${prefix}/${modelId}`);
    assert.equal(catalogModel?.owned_by, prefix);

    const res = await callGET(providerId);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(
      body.data.map((model: { id: string }) => model.id),
      [modelId]
    );
    assert.equal(body.data[0].owned_by, prefix);
    assert.equal(body.data[0].parent, null);
  });

  test("GET /v1/providers/:provider/models rejects non-matching connection-like strings", async () => {
    // Looks like a connection ID but with wrong prefix
    const res = await callGET("custom-compatible-chat-a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, "invalid_provider");
  });
});

describe("v1-models-discovery-filters", () => {
  /**
   * Discovery filters on GET /v1/models (`capability`, `min_context`, `kind`, `q`).
   *
   * Contract:
   *   - Opt-in: without a discovery param the route takes the untouched path, so the
   *     response stays byte-identical (paging-only params included).
   *   - Filters narrow the caller's already key-filtered catalog; they never widen it.
   *   - Bad values are a 400 whose message lists the valid values and leaks no stack.
   *   - Filtering precedes the existing OpenAI-style `limit`/`after` paging.
   */
  type Row = {
    id: string;
    owned_by?: string;
    type?: string;
    name?: string;
    context_length?: number;
    max_output_tokens?: number;
    capabilities?: Record<string, unknown>;
  };

  before(resetAll);

  const ROWS: Row[] = [
    {
      id: "a/vision-big",
      owned_by: "a",
      name: "Vision Big",
      context_length: 1_000_000,
      max_output_tokens: 64_000,
      capabilities: { vision: true, tool_calling: true },
    },
    {
      id: "a/text-small",
      owned_by: "a",
      name: "Text Small",
      context_length: 8_000,
      max_output_tokens: 4_000,
      capabilities: { vision: false, tool_calling: true },
    },
    { id: "b/embed", owned_by: "b", type: "embedding", context_length: 8_192 },
    { id: "b/no-caps", owned_by: "b" },
  ];

  function params(query: string): URLSearchParams {
    return new URL(`http://localhost/v1/models${query}`).searchParams;
  }

  function parseOk(query: string) {
    const parsed = filters.parseCatalogDiscoveryQuery(params(query));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error("unreachable");
    return parsed.value;
  }

  function ids(rows: Array<{ id?: unknown }>): string[] {
    return rows.map((row) => String(row.id));
  }

  // ── pure parsing / filtering ────────────────────────────────────────────────

  test("discovery mode is opt-in: no param or paging-only params do not switch it on", () => {
    assert.equal(filters.hasCatalogDiscoveryParams(params("")), false);
    assert.equal(filters.hasCatalogDiscoveryParams(params("?limit=5&after=x")), false);
    assert.equal(
      filters.hasCatalogDiscoveryParams(params("?prefix=alias&configuredOnly=true")),
      false
    );
    assert.equal(filters.hasCatalogDiscoveryParams(params("?capability=vision")), true);
    assert.equal(filters.hasCatalogDiscoveryParams(params("?q=gpt")), true);
    assert.equal(filters.hasCatalogDiscoveryParams(params("?min_context=1")), true);
    assert.equal(filters.hasCatalogDiscoveryParams(params("?kind=chat")), true);
  });

  test("capability accepts repeated and comma-separated values; all must be true", () => {
    const value = parseOk("?capability=vision&capability=tool_calling");
    assert.deepEqual(value.capabilities, ["vision", "tool_calling"]);
    assert.deepEqual(parseOk("?capability=vision,%20tool_calling").capabilities, [
      "vision",
      "tool_calling",
    ]);
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, value)), ["a/vision-big"]);
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, parseOk("?capability=tool_calling"))), [
      "a/vision-big",
      "a/text-small",
    ]);
  });

  test("min_context keeps rows at or above the floor and rejects non-integers", () => {
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, parseOk("?min_context=500000"))), [
      "a/vision-big",
    ]);
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, parseOk("?min_context=8192"))), [
      "a/vision-big",
      "b/embed",
    ]);
    for (const bad of ["1.5", "-1", "", "abc", "10abc"]) {
      const parsed = filters.parseCatalogDiscoveryQuery(params(`?min_context=${bad}`));
      assert.equal(parsed.ok, false, `min_context=${bad} must be rejected`);
      if (!parsed.ok) assert.match(parsed.message, /min_context must be a non-negative integer/);
    }
  });

  test("kind treats a row without `type` as chat; q matches id or name case-insensitively", () => {
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, parseOk("?kind=embedding"))), [
      "b/embed",
    ]);
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, parseOk("?kind=chat"))), [
      "a/vision-big",
      "a/text-small",
      "b/no-caps",
    ]);
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, parseOk("?q=VISION"))), [
      "a/vision-big",
    ]);
    assert.deepEqual(ids(filters.filterCatalogModels(ROWS, parseOk("?q=text%20small"))), [
      "a/text-small",
    ]);
    assert.equal(filters.parseCatalogDiscoveryQuery(params("?kind=llm")).ok, false);
    assert.equal(filters.parseCatalogDiscoveryQuery(params("?q=%20%20")).ok, false);
  });

  test("an unknown capability is rejected with the valid vocabulary listed", () => {
    const parsed = filters.parseCatalogDiscoveryQuery(params("?capability=bogus"));
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    for (const capability of filters.CATALOG_CAPABILITY_FILTERS) {
      assert.ok(parsed.message.includes(capability), `message must list ${capability}`);
    }
  });

  // ── the response layer, with an injected catalog loader ─────────────────────

  function fakeLoader(body: Record<string, unknown>, status = 200) {
    const seen: Request[] = [];
    const loader = async (request: Request) => {
      seen.push(request);
      return Response.json(body, {
        status,
        headers: { "x-omniroute-catalog-cache": "HIT", "content-length": "1" },
      });
    };
    return { loader, seen };
  }

  test("filters apply before paging, and the inner catalog request drops filter + paging params", async () => {
    const { loader, seen } = fakeLoader({ object: "list", data: ROWS });
    const response = await getFilteredCatalogResponse(
      new Request("http://localhost/v1/models?capability=tool_calling&limit=1&prefix=alias", {
        headers: { authorization: "Bearer sk-test" },
      }),
      loader
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(ids(body.data), ["a/vision-big"]);
    assert.equal(body.has_more, true);
    assert.equal(body.last_id, "a/vision-big");
    assert.equal(response.headers.get("x-omniroute-catalog-cache"), "HIT");
    assert.notEqual(response.headers.get("content-length"), "1");

    const inner = new URL(seen[0].url);
    assert.equal(inner.searchParams.get("prefix"), "alias");
    for (const dropped of ["capability", "limit", "after", "min_context", "kind", "q"]) {
      assert.equal(inner.searchParams.has(dropped), false, `${dropped} must not reach the builder`);
    }
    assert.equal(seen[0].headers.get("authorization"), "Bearer sk-test");
  });

  test("a non-200 catalog response (auth rejection) passes through untouched", async () => {
    const { loader } = fakeLoader({ error: { message: "nope" } }, 401);
    const response = await getFilteredCatalogResponse(
      new Request("http://localhost/v1/models?capability=vision"),
      loader
    );
    assert.equal(response.status, 401);
  });

  test("invalid params are a 400 without stack traces and without building the catalog", async () => {
    const { loader, seen } = fakeLoader({ object: "list", data: ROWS });
    for (const query of ["?capability=bogus", "?min_context=1.5", "?kind=nope"]) {
      const response = await getFilteredCatalogResponse(
        new Request(`http://localhost/v1/models${query}`),
        loader
      );
      assert.equal(response.status, 400, query);
      const body = await response.json();
      assert.equal(typeof body.error?.message, "string");
      assert.ok(!body.error.message.includes("at /"), "error must not leak a stack trace");
    }
    assert.equal(seen.length, 0);
  });

  // ── the real route ──────────────────────────────────────────────────────────

  let seeded = false;
  async function seedCatalog() {
    if (seeded) return;
    seeded = true;
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "discovery fixture",
      apiKey: "sk-synthetic-discovery",
      isActive: true,
      testStatus: "active",
    });
  }

  async function routeJson(query: string, headers: Record<string, string> = {}) {
    const response = await modelsRoute.GET(
      new Request(`http://localhost/v1/models${query}`, { headers })
    );
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }

  test("GET /v1/models without discovery params is byte-identical to the unfiltered catalog", async () => {
    await seedCatalog();
    for (const query of ["", "?limit=3", "?prefix=alias"]) {
      const viaRoute = await modelsRoute.GET(new Request(`http://localhost/v1/models${query}`));
      const direct = await v1ModelsCatalog.getUnifiedModelsResponse(
        new Request(`http://localhost/v1/models${query}`)
      );
      const routeText = await viaRoute.text();
      assert.equal(viaRoute.status, 200);
      assert.equal(routeText, await direct.text(), `body must be unchanged for "${query}"`);
      assert.equal(viaRoute.headers.get("content-length"), String(Buffer.byteLength(routeText)));
      assert.equal(JSON.parse(routeText).data.length > 0, true);
    }
  });

  test("GET /v1/models?capability=vision returns only vision rows from the real catalog", async () => {
    await seedCatalog();
    const all = await routeJson("");
    const vision = await routeJson("?capability=vision");
    assert.equal(vision.status, 200);
    assert.ok(vision.body.data.length > 0, "the fixture must expose at least one vision model");
    assert.ok(vision.body.data.length < all.body.data.length, "the filter must drop rows");
    for (const row of vision.body.data as Row[]) {
      assert.equal(row.capabilities?.vision, true, `${row.id} is not a vision model`);
    }
    const allIds = new Set(ids(all.body.data));
    for (const id of ids(vision.body.data)) assert.ok(allIds.has(id));
  });

  test("GET /v1/models?min_context filters and ?capability=bogus is a sanitized 400", async () => {
    await seedCatalog();
    const big = await routeJson("?min_context=500000");
    assert.equal(big.status, 200);
    for (const row of big.body.data as Row[]) {
      assert.ok((row.context_length ?? 0) >= 500_000, `${row.id} is below the floor`);
    }
    const fractional = await routeJson("?min_context=1.5");
    assert.equal(fractional.status, 400);

    const bogus = await routeJson("?capability=bogus");
    assert.equal(bogus.status, 400);
    assert.match(bogus.body.error.message, /vision/);
    assert.ok(!bogus.text.includes("at /"), "error must not leak a stack trace");
  });

  test("a restricted API key plus filters never lists a model outside the key's scope", async () => {
    await seedCatalog();
    const all = await routeJson("?capability=vision");
    const allowed = String(all.body.data[0].id);
    const key = await apiKeysDb.createApiKey("discovery-restricted", "synthetic-machine");
    await apiKeysDb.updateApiKeyPermissions(key.id, { allowedModels: [allowed] });
    const headers = { Authorization: `Bearer ${key.key}` };

    const scoped = await routeJson("", headers);
    const scopedIds = new Set(ids(scoped.body.data));
    const filtered = await routeJson("?capability=vision", headers);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.data.length > 0);
    for (const id of ids(filtered.body.data)) {
      assert.ok(scopedIds.has(id), `${id} is outside the key's scope`);
    }
    const wide = await routeJson("?q=gpt", headers);
    for (const id of ids(wide.body.data)) {
      assert.ok(scopedIds.has(id), `${id} is outside the key's scope`);
    }
  });
});

describe("v1-models-openrouter-pricing", () => {
  /**
   * GET /v1/models: every entry carries an OpenRouter-format `pricing` object (USD per
   * token, decimal strings) next to the existing per-1M numbers, priced from the same
   * table cost accounting uses. Helpers are covered by catalog-openrouter-pricing.test.ts.
   */
  type Entry = {
    id: string;
    owned_by?: string;
    root?: string;
    pricing?: Record<string, unknown>;
  };

  const PRICED = {
    prompt: "0.000005",
    completion: "0.000025",
    input_cache_read: "0.0000005",
    input_cache_write: "0.00000625",
    input: 5,
    output: 25,
    cached: 0.5,
    cache_creation: 6.25,
  };

  before(async () => {
    await resetAll();
    const connection = (await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-pricing-test",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    })) as { id: string };
    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connection.id, [
      { id: "pricing-test-priced", name: "Priced" },
      { id: "pricing-test-free", name: "Free" },
      { id: "pricing-test-unpriced", name: "Unpriced" },
    ]);
    await pricingDb.updatePricing({
      openai: {
        "pricing-test-priced": { input: 5, output: 25, cached: 0.5, cache_creation: 6.25 },
        "pricing-test-free": { input: 0, output: 0 },
      },
    });
    await combosDb.createCombo({
      name: "pricing-test-combo",
      strategy: "priority",
      models: ["openai/pricing-test-priced", "openai/pricing-test-unpriced"],
    });
    await combosDb.createCombo({
      name: "pricing-test-combo-unpriced",
      strategy: "priority",
      models: ["openai/pricing-test-unpriced", "openai/pricing-test-priced"],
    });
  });

  // Leave no pricing rows or cached pricing behind for the next describe.
  after(resetAll);

  async function listModels(headers: Record<string, string> = {}) {
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models", { headers })
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { object: string; data: Entry[] };
    assert.equal(body.object, "list");
    return body.data;
  }

  function entriesFor(data: Entry[], root: string): Entry[] {
    const found = data.filter((entry) => entry.root === root && entry.owned_by !== "combo");
    assert.ok(found.length > 0, `catalog lists ${root}`);
    return found;
  }

  test("a priced model carries per-token strings and the per-1M numbers", async () => {
    const data = await listModels();
    for (const entry of entriesFor(data, "pricing-test-priced")) {
      assert.deepEqual(entry.pricing, PRICED, entry.id);
    }
    // Same row as cost accounting.
    const row = await pricingDb.getPricingForModel("openai", "pricing-test-priced");
    assert.equal(row?.input, 5);
  });

  test("a free model is priced at zero and an unknown price omits `pricing`", async () => {
    const data = await listModels();
    for (const entry of entriesFor(data, "pricing-test-free")) {
      assert.deepEqual(entry.pricing, { prompt: "0", completion: "0", input: 0, output: 0 });
    }
    for (const entry of entriesFor(data, "pricing-test-unpriced")) {
      assert.equal("pricing" in entry, false, entry.id);
    }
  });

  test("a combo is priced as its first target", async () => {
    const data = await listModels();
    const combo = data.find((entry) => entry.id === "pricing-test-combo");
    assert.ok(combo);
    assert.deepEqual(combo.pricing, PRICED);

    const unpriced = data.find((entry) => entry.id === "pricing-test-combo-unpriced");
    assert.ok(unpriced);
    assert.equal("pricing" in unpriced, false);
  });

  test("every priced token-billed entry has the same shape and no exponent notation", async () => {
    const data = await listModels();
    // Credit-metered providers keep numeric-only pricing (covered below).
    const priced = data.filter(
      (entry) => entry.pricing && entry.owned_by !== "kiro" && entry.owned_by !== "kr"
    );
    assert.ok(priced.length > 3);
    for (const entry of priced) {
      const pricing = entry.pricing as Record<string, unknown>;
      assert.equal(typeof pricing.prompt, "string", entry.id);
      assert.equal(typeof pricing.completion, "string", entry.id);
      assert.equal(typeof pricing.input, "number", entry.id);
      assert.equal(typeof pricing.output, "number", entry.id);
      for (const key of ["prompt", "completion", "input_cache_read", "input_cache_write"]) {
        if (pricing[key] === undefined) continue;
        assert.match(String(pricing[key]), /^\d+(\.\d+)?$/, `${entry.id} ${key}`);
      }
    }
  });

  test("a credit-metered provider keeps its numeric pricing and gets no per-token strings", async () => {
    await providersDb.createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      name: "kiro-pricing-test",
      accessToken: "token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const data = await listModels();
    const credit = data.filter(
      (entry) => (entry.owned_by === "kiro" || entry.owned_by === "kr") && entry.pricing
    );
    assert.ok(credit.length > 0, "catalog lists priced kiro models");
    for (const entry of credit) {
      // Exactly what catalog enrichment produced before per-token strings existed.
      const before = (
        await enrichCatalogModelEntry({
          id: entry.id,
          owned_by: entry.owned_by,
          root: entry.root,
        })
      ).pricing;
      assert.deepEqual(entry.pricing, before, entry.id);
      assert.equal("prompt" in (entry.pricing ?? {}), false, entry.id);
      assert.equal("completion" in (entry.pricing ?? {}), false, entry.id);
    }
    const sonnet = credit.find((entry) => entry.root === "claude-sonnet-4.5");
    assert.deepEqual(sonnet?.pricing, {
      input: 3,
      output: 15,
      cached: 1.5,
      reasoning: 15,
      cache_creation: 3,
    });
  });

  test("an Anthropic-style request (x-api-key + anthropic-version) gets the same pricing", async () => {
    const key = (await apiKeysDb.createApiKey("pricing-test-key", "machine-pricing")) as {
      key: string;
    };
    const data = await listModels({ "x-api-key": key.key, "anthropic-version": "2023-06-01" });
    for (const entry of entriesFor(data, "pricing-test-priced")) {
      assert.deepEqual(entry.pricing, PRICED, entry.id);
    }
    const combo = data.find((entry) => entry.id === "pricing-test-combo");
    assert.deepEqual(combo?.pricing, PRICED);
  });
});

describe("models-catalog-functional-gateway-permissions", () => {
  // Flag reads are synchronous and served from an in-process snapshot, so refresh it after each write.
  async function setFlag(key: string, value: string) {
    await featureFlagsDb.setFeatureFlagOverride(key, value);
    await featureFlagsUtil.refreshFeatureFlagSnapshot();
  }

  async function removeFlag(key: string) {
    await featureFlagsDb.removeFeatureFlagOverride(key);
    await featureFlagsUtil.refreshFeatureFlagSnapshot();
  }

  async function seedConnection(
    provider: string,
    overrides: {
      authType?: string;
      apiKey?: string | null;
      accessToken?: string;
    } = {}
  ) {
    return providersDb.createProviderConnection({
      provider,
      authType: overrides.authType || "apikey",
      name: `${provider}-catalog-permissions`,
      apiKey: overrides.apiKey === undefined ? "sk-test" : overrides.apiKey,
      accessToken: overrides.accessToken,
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  function catalogIds(body: unknown): Set<string> {
    if (!body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data)) {
      return new Set();
    }
    return new Set(
      body.data.flatMap((item) =>
        item && typeof item === "object" && "id" in item && typeof item.id === "string"
          ? [item.id]
          : []
      )
    );
  }

  beforeEach(resetAll);
  // The flag snapshot is process-global: drop the overrides so they cannot leak into later describes.
  afterEach(async () => {
    await removeFlag("EXPOSE_FUNCTIONAL_GATEWAY_MIRRORS");
    await removeFlag("CATALOG_MIRROR_REFINEMENTS_ENABLED");
  });

  test("v1 models catalog requires independent permission for functional gateway mirrors", async () => {
    await seedConnection("kimi-coding", {
      authType: "oauth",
      apiKey: null,
      accessToken: "kimi-access",
    });
    await seedConnection("agentrouter");
    await setFlag("EXPOSE_FUNCTIONAL_GATEWAY_MIRRORS", "true");
    await functionalGatewayDb.setFunctionalGatewayProviderSetting("agentrouter", "on");

    const restrictedKey = await apiKeysDb.createApiKey(
      "catalog-functional-mirror",
      "machine-functional"
    );
    await apiKeysDb.updateApiKeyPermissions(restrictedKey.id, {
      allowedModels: ["kimi-coding/*"],
    });

    const restrictedResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { Authorization: `Bearer ${restrictedKey.key}` },
      })
    );
    const restrictedIds = catalogIds(await restrictedResponse.json());

    assert.equal(restrictedResponse.status, 200);
    assert.equal(restrictedIds.has("kmc/k3"), true);
    assert.equal(restrictedIds.has("agentrouter/kmc/k3"), false);

    const gatewayKey = await apiKeysDb.createApiKey(
      "catalog-functional-mirror-allowed",
      "machine-functional-allowed"
    );
    await apiKeysDb.updateApiKeyPermissions(gatewayKey.id, {
      allowedModels: ["kimi-coding/*", "agentrouter/*"],
    });

    const gatewayResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { Authorization: `Bearer ${gatewayKey.key}` },
      })
    );
    const gatewayIds = catalogIds(await gatewayResponse.json());

    assert.equal(gatewayResponse.status, 200);
    assert.equal(gatewayIds.has("kmc/k3"), true);
    assert.equal(gatewayIds.has("agentrouter/kmc/k3"), true);
  });

  // ── CATALOG_MIRROR_REFINEMENTS_ENABLED ─────────────────────────────────────────
  // Each case runs flag off (historical catalog, unchanged) and flag on (refined).

  const REFINEMENTS_FLAG = "CATALOG_MIRROR_REFINEMENTS_ENABLED";

  async function gatewayCatalogIds(refined: boolean): Promise<Set<string>> {
    if (refined) await setFlag(REFINEMENTS_FLAG, "true");
    else await removeFlag(REFINEMENTS_FLAG);
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    return catalogIds(await response.json());
  }

  async function enableAgentrouterMirrors() {
    const gateway = (await seedConnection("agentrouter")) as { id: string };
    await setFlag("EXPOSE_FUNCTIONAL_GATEWAY_MIRRORS", "true");
    await functionalGatewayDb.setFunctionalGatewayProviderSetting("agentrouter", "on");
    return gateway;
  }

  test("refinements: a model whose owner is connected under an alias prefix is not mirrored", async () => {
    // `kmc/` is kimi-coding's alias. The historical owner check compares the alias
    // prefix against connection provider ids, never matches, and advertises
    // `agentrouter/kmc/k3` even though kimi-coding itself is connected.
    await seedConnection("kimi-coding", {
      authType: "oauth",
      apiKey: null,
      accessToken: "kimi-access",
    });
    await enableAgentrouterMirrors();

    const off = await gatewayCatalogIds(false);
    assert.equal(off.has("kmc/k3"), true);
    assert.equal(off.has("agentrouter/kmc/k3"), true, "flag off keeps the historical mirror");

    const on = await gatewayCatalogIds(true);
    assert.equal(on.has("kmc/k3"), true);
    assert.equal(on.has("agentrouter/kmc/k3"), false);
  });

  /**
   * Two unowned models the refined catalog mirrors through agentrouter, picked from
   * the live registry instead of hard-coding an id the provider catalogs may drop.
   * Returns the ORIGINAL ids (without the `agentrouter/` prefix).
   */
  async function pickUnownedMirroredIds(): Promise<[string, string]> {
    const ids = await gatewayCatalogIds(true);
    const originals = [...ids]
      .filter((id) => id.startsWith("agentrouter/"))
      .map((id) => id.slice("agentrouter/".length))
      // exactly `<prefix>/<model>`: keeps the `<prefix>/*` permission glob unambiguous
      .filter((id) => id.split("/").length === 2 && !id.startsWith("auto/") && ids.has(id));
    assert.ok(originals.length >= 2, "registry must expose at least two unowned mirrored models");
    return [originals[0], originals[1]];
  }

  test("refinements: an unowned model is still mirrored and still needs its own permission", async () => {
    await enableAgentrouterMirrors();
    const [unowned] = await pickUnownedMirroredIds();
    const ownerPrefix = unowned.slice(0, unowned.indexOf("/"));
    await setFlag(REFINEMENTS_FLAG, "true");

    const listFor = async (allowedModels: string[], name: string) => {
      const key = await apiKeysDb.createApiKey(name, `machine-${name}`);
      await apiKeysDb.updateApiKeyPermissions(key.id, { allowedModels });
      v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
      const response = await v1ModelsCatalog.getUnifiedModelsResponse(
        new Request("http://localhost/api/v1/models", {
          headers: { Authorization: `Bearer ${key.key}` },
        })
      );
      assert.equal(response.status, 200);
      return catalogIds(await response.json());
    };

    const restricted = await listFor([`${ownerPrefix}/*`], "refined-restricted");
    assert.equal(restricted.has(unowned), true);
    assert.equal(restricted.has(`agentrouter/${unowned}`), false);

    const allowed = await listFor([`${ownerPrefix}/*`, "agentrouter/*"], "refined-allowed");
    assert.equal(allowed.has(unowned), true);
    assert.equal(allowed.has(`agentrouter/${unowned}`), true);
  });

  test("refinements: combos never get a gateway mirror", async () => {
    await enableAgentrouterMirrors();
    const off = await gatewayCatalogIds(false);
    assert.equal(
      off.has("agentrouter/auto/best-coding"),
      true,
      "flag off keeps the historical mirror"
    );
    const on = await gatewayCatalogIds(true);
    assert.equal(
      [...on].some((id) => id.startsWith("agentrouter/auto/")),
      false
    );
  });

  test("refinements: gateway mirrors outside the gateway's authoritative live catalog are skipped", async () => {
    const gateway = await enableAgentrouterMirrors();
    const [served, notServed] = await pickUnownedMirroredIds();
    // A fresh, authoritative live catalog for the gateway that serves exactly one of the
    // two models. The request path rejects everything else ("not available in the
    // active live catalog"), so only that model may be mirrored.
    await modelsDb.replaceSyncedAvailableModelsForConnection("agentrouter", gateway.id, [
      { id: served, name: "Served" },
    ]);

    const off = await gatewayCatalogIds(false);
    assert.equal(off.has(`agentrouter/${notServed}`), true, "flag off ignores the live catalog");

    const on = await gatewayCatalogIds(true);
    assert.equal(on.has(`agentrouter/${served}`), true);
    assert.equal(on.has(`agentrouter/${notServed}`), false);
  });

  test("refinements: a prefix-stripped live-catalog match does not count for a gateway mirror", async () => {
    // The gateway is sent the full `<prefix>/<model>`; listing only `<model>` must not
    // count (dispatch matches the full id and rejects it).
    const gateway = await enableAgentrouterMirrors();
    const [unowned] = await pickUnownedMirroredIds();
    const stripped = unowned.slice(unowned.indexOf("/") + 1);
    await modelsDb.replaceSyncedAvailableModelsForConnection("agentrouter", gateway.id, [
      { id: stripped, name: "Stripped" },
    ]);
    assert.equal((await gatewayCatalogIds(true)).has(`agentrouter/${unowned}`), false);
  });

  test("refinements: no mirrors through a gateway disabled in blockedProviders", async () => {
    // A blocked gateway keeps its connection row but has no usable credential at request
    // time, so its mirrors would all be advertised-but-dead.
    await enableAgentrouterMirrors();
    const [unowned] = await pickUnownedMirroredIds();
    await settingsDb.updateSettings({ blockedProviders: ["agentrouter"] });

    const off = await gatewayCatalogIds(false);
    assert.equal(
      off.has(`agentrouter/${unowned}`),
      true,
      "flag off keeps the historical (blocked-gateway) mirrors"
    );
    const on = await gatewayCatalogIds(true);
    assert.equal(
      [...on].some((id) => id.startsWith("agentrouter/")),
      false
    );
  });
});

describe("models-catalog-visibility", () => {
  /**
   * Central model visibility in the Models catalog.
   *
   * `GET /api/models/catalog?includeHidden=1` (management only) keeps the models an
   * operator hid on a provider page, tags them `hidden: true`, and tells the dashboard
   * which stored `(provider, modelId)` keys a hide/show must PATCH. Without the param —
   * and on the public `/v1/models` — hidden models stay out, exactly as before.
   */
  const { mergeModelCompatOverride, addCustomModel } = modelsDb;

  beforeEach(async () => {
    delete process.env.INITIAL_PASSWORD;
    await resetAll();
  });

  after(restoreInitialPassword);

  type CatalogEntry = {
    id: string;
    hidden?: boolean;
    visibility?: { modality: string; targets: Array<{ provider: string; modelId: string }> };
  };

  async function fetchManagementCatalog(query = ""): Promise<CatalogEntry[]> {
    const response = await catalogRoute.GET(
      new Request(`http://localhost/api/models/catalog${query}`)
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      catalog: Record<string, { models: CatalogEntry[] }>;
    };
    return Object.values(body.catalog).flatMap((bucket) => bucket.models);
  }

  async function fetchPublicIds(): Promise<string[]> {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    return body.data.map((model) => model.id);
  }

  async function seedClaude() {
    await providersDb.createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "claude-visibility",
      apiKey: "sk-test-visibility",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  test("includeHidden=1 keeps a hidden model, tagged hidden, with the stored key to unhide", async () => {
    await seedClaude();
    // Hidden on the provider page whose route param was the alias "cc".
    await mergeModelCompatOverride("cc", "claude-opus-5", { isHidden: true, modality: "chat" });

    const withHidden = await fetchManagementCatalog("?includeHidden=1");
    const hiddenRow = withHidden.find((model) => model.id === "cc/claude-opus-5");
    assert.ok(hiddenRow, "hidden model must be listed when includeHidden=1");
    assert.equal(hiddenRow.hidden, true);
    assert.equal(hiddenRow.visibility?.modality, "chat");
    assert.deepEqual(hiddenRow.visibility?.targets, [{ provider: "cc", modelId: "claude-opus-5" }]);

    const visibleRow = withHidden.find(
      (model) => model.id.startsWith("cc/") && model.id !== "cc/claude-opus-5"
    );
    assert.ok(visibleRow, "a visible claude model is listed too");
    assert.equal(visibleRow.hidden, undefined);
    assert.equal(visibleRow.visibility?.targets[0]?.provider, "claude");

    const withoutHidden = await fetchManagementCatalog();
    assert.equal(
      withoutHidden.some((model) => model.id === "cc/claude-opus-5"),
      false,
      "without includeHidden the hidden model stays out"
    );
    assert.equal(
      withoutHidden.some((model) => model.visibility !== undefined),
      false,
      "the default catalog payload is unchanged"
    );

    const publicIds = await fetchPublicIds();
    assert.equal(publicIds.includes("cc/claude-opus-5"), false, "/v1/models still omits it");
  });

  test("includeHidden=1 maps a compatible-node prefix row back to the node id", async () => {
    const NODE_ID = "openai-compatible-chat-visibility-c0ffee00-0000-4000-8000-000000000000";
    const PREFIX = "vis-node";
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "Visibility Node",
      prefix: PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "vis-node-conn",
      apiKey: "sk-test-vis-node",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });
    await addCustomModel(NODE_ID, "vis-chat", "Vis Chat");

    const rows = await fetchManagementCatalog("?includeHidden=1");
    const row = rows.find((model) => model.id === `${PREFIX}/vis-chat`);
    assert.ok(row, `expected ${PREFIX}/vis-chat in ${JSON.stringify(rows.map((r) => r.id))}`);
    assert.deepEqual(row.visibility?.targets, [{ provider: NODE_ID, modelId: "vis-chat" }]);
  });

  test("groupVisibilityPatches builds one PATCH payload per provider and modality", () => {
    const rows = catalogUtils.flattenCatalog({
      claude: {
        provider: "Claude",
        models: [
          {
            id: "cc/a",
            type: "chat",
            visibility: { modality: "chat", targets: [{ provider: "claude", modelId: "a" }] },
          },
          {
            id: "cc/b",
            type: "chat",
            hidden: true,
            visibility: {
              modality: "chat",
              targets: [
                { provider: "cc", modelId: "b" },
                { provider: "claude", modelId: "b" },
              ],
            },
          },
        ],
      },
      openai: {
        provider: "OpenAI",
        models: [
          {
            id: "openai/text-embedding-3-small",
            type: "embedding",
            visibility: {
              modality: "embeddings",
              targets: [{ provider: "openai", modelId: "text-embedding-3-small" }],
            },
          },
          { id: "combo-x", type: "chat" },
        ],
      },
    });

    // Hiding skips rows that are already hidden and rows with no visibility target.
    assert.deepEqual(visibilityUtils.groupVisibilityPatches(rows, true), [
      { provider: "claude", modality: "chat", modelIds: ["a"] },
      { provider: "openai", modality: "embeddings", modelIds: ["text-embedding-3-small"] },
    ]);
    // Showing clears every stored key of the hidden row (alias and canonical).
    assert.deepEqual(visibilityUtils.groupVisibilityPatches(rows, false), [
      { provider: "cc", modality: "chat", modelIds: ["b"] },
      { provider: "claude", modality: "chat", modelIds: ["b"] },
    ]);

    assert.deepEqual(visibilityUtils.countCatalogVisibility(rows), {
      visible: 3,
      hidden: 1,
      total: 4,
    });
  });

  test('the "hidden" / "visible" visibility filter selects rows by their hidden flag', () => {
    const rows = catalogUtils.flattenCatalog({
      alpha: {
        provider: "Alpha",
        models: [
          { id: "alpha/on", type: "chat" },
          { id: "alpha/off", type: "chat", hidden: true },
        ],
      },
    });
    const base = { query: "", providerId: "all", type: "all" };
    assert.deepEqual(
      catalogUtils.filterCatalogModels(rows, { ...base, visibility: "hidden" }).map((r) => r.id),
      ["alpha/off"]
    );
    assert.deepEqual(
      catalogUtils.filterCatalogModels(rows, { ...base, visibility: "visible" }).map((r) => r.id),
      ["alpha/on"]
    );
    assert.equal(catalogUtils.filterCatalogModels(rows, { ...base, visibility: "all" }).length, 2);
  });

  test("a toggle round-trip through PATCH /api/provider-models hides then shows the row", async () => {
    await seedClaude();
    const providerModelsRoute = await import("../../../src/app/api/provider-models/route.ts");
    const patch = async (hidden: boolean, rows: CatalogEntry[]) => {
      const flattened = catalogUtils.flattenCatalog({
        claude: { provider: "Claude", models: rows },
      });
      for (const body of visibilityUtils.groupVisibilityPatches(flattened, hidden)) {
        const response = await providerModelsRoute.PATCH(
          new Request(
            `http://localhost/api/provider-models?provider=${encodeURIComponent(body.provider)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                isHidden: hidden,
                modelIds: body.modelIds,
                modality: body.modality,
              }),
            }
          )
        );
        assert.equal(response.status, 200);
      }
    };

    const before = await fetchManagementCatalog("?includeHidden=1");
    const row = before.find((model) => model.id === "cc/claude-opus-5");
    assert.ok(row && row.hidden === undefined, "starts visible");
    await patch(true, [row]);
    assert.equal((await fetchPublicIds()).includes("cc/claude-opus-5"), false, "hidden publicly");

    const afterHide = await fetchManagementCatalog("?includeHidden=1");
    const hiddenRow = afterHide.find((model) => model.id === "cc/claude-opus-5");
    assert.equal(hiddenRow?.hidden, true);
    await patch(false, [hiddenRow!]);
    assert.equal((await fetchPublicIds()).includes("cc/claude-opus-5"), true, "visible again");
  });

  test("includeHidden=1 requires management auth when login is enabled", async () => {
    process.env.INITIAL_PASSWORD = "visibility-test-password";
    const response = await catalogRoute.GET(
      new Request("http://localhost/api/models/catalog?includeHidden=1")
    );
    assert.equal(response.status, 401);
  });
});

describe("copilot-learned-catalog-15634", () => {
  const rejectedModel = "claude-sonnet-5";
  const validModel = "gpt-6-astra";
  const dispatched: string[] = [];
  let connectionId = "";
  let rejectionCode: string | undefined = "model_not_supported";
  let rejectionStatus = 400;
  let rejectionMessage = "The requested model is not supported.";

  async function seedOtherConnection(provider: string, inventory?: string[]) {
    const connection = await providersDb.createProviderConnection({
      provider,
      name: "Synthetic account B",
      authType: "oauth",
      accessToken: "synthetic-other-access",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        copilotToken: "synthetic-other-token",
        copilotTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    if (inventory)
      await modelsDb.replaceSyncedAvailableModelsForConnection(
        provider,
        String(connection.id),
        inventory.map((id) => ({ id, name: id, source: "imported" as const }))
      );
    return String(connection.id);
  }

  async function rejectOnce() {
    const response = await chat(`gh/${rejectedModel}`);
    assert.equal(response.status, rejectionStatus, await response.text());
  }

  function hasRejected(ids: string[]) {
    return ids.includes(`github/${rejectedModel}`);
  }

  async function listedIds(): Promise<string[]> {
    const response = await modelsRoute.GET(new Request("http://localhost/v1/models"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    return body.data.map((entry) => entry.id);
  }

  async function chat(model: string) {
    return chatRoute.POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OmniRoute-No-Cache": "true" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      })
    );
  }

  beforeEach(async () => {
    await resetAll();
    dispatched.length = 0;
    rejectionCode = "model_not_supported";
    rejectionStatus = 400;
    rejectionMessage = "The requested model is not supported.";
    await settingsDb.updateSettings({
      requireLogin: false,
      requireApiKey: false,
      requireAuthForModels: false,
      requestRetry: 0,
      autoRoutingEnabled: false,
      probeCanDisable: false,
      blockedProviders: Object.keys(NOAUTH_PROVIDERS),
    });
    const connection = await providersDb.createProviderConnection({
      provider: "github",
      name: "Copilot synthetic account A",
      authType: "oauth",
      accessToken: "synthetic-github-access",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        copilotToken: "synthetic-copilot-token",
        copilotTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    connectionId = String(connection.id);
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "github",
      connectionId,
      [rejectedModel, validModel].map((id) => ({ id, name: id, source: "imported" as const }))
    );
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.hostname, "api.githubcopilot.com", `unexpected upstream ${url.origin}`);
      const body = JSON.parse(String(init?.body)) as { model: string };
      dispatched.push(body.model);
      if (
        body.model === rejectedModel &&
        new Headers(init?.headers).get("authorization") !== "Bearer synthetic-other-token"
      ) {
        return Response.json(
          {
            error: {
              message: rejectionMessage,
              code: rejectionCode,
              type: "invalid_request_error",
              param: "model",
            },
          },
          { status: rejectionStatus }
        );
      }
      if (body.model === rejectedModel) {
        assert.equal(url.pathname, "/v1/messages");
        return Response.json({
          id: "msg-15634",
          type: "message",
          role: "assistant",
          model: rejectedModel,
          content: [{ type: "text", text: "hello from account B" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 4 },
        });
      }
      assert.equal(body.model, validModel);
      return Response.json({
        id: "resp-copilot-catalog-fixture",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
      });
    };
  });

  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS), true);
    globalThis.fetch = originalFetch;
  });

  test("a listed, supported Copilot model still reaches the HTTP upstream", async () => {
    assert.ok((await listedIds()).includes(`github/${validModel}`));
    const response = await chat(`gh/${validModel}`);
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(dispatched, [validModel]);
  });

  for (const cold of [false, true]) {
    test(`learned Copilot rejection disappears from the ${cold ? "cold" : "warm"} HTTP catalog`, async () => {
      const before = await listedIds();
      assert.ok(before.includes(`github/${rejectedModel}`));
      const rejected = await chat(`gh/${rejectedModel}`);
      assert.equal(rejected.status, 400, await rejected.text());
      assert.deepEqual(dispatched, [rejectedModel]);
      assert.equal(locks.isModelLocked("github", connectionId, rejectedModel), true);
      if (cold) v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
      const after = await listedIds();
      assert.ok(after.includes(`github/${validModel}`));
      assert.equal(
        after.some((id) => /^(?:gh|github)\/claude-sonnet-5(?:$|-)/.test(id)),
        false
      );
    });
  }

  test("a repeated rejected model reports model_not_supported without another upstream call", async () => {
    const first = await chat(`gh/${rejectedModel}`);
    assert.equal(first.status, 400);
    await first.text();
    const repeated = await chat(`github/${rejectedModel}`);
    const body = await repeated.json();
    assert.deepEqual(dispatched, [rejectedModel]);
    assert.deepEqual(
      { status: repeated.status, code: body.error?.code },
      { status: 400, code: "model_not_supported" }
    );
  });

  test("account B advertising the model keeps it listed and handles the next request", async () => {
    await rejectOnce();
    const otherId = await seedOtherConnection("github", [rejectedModel, validModel]);
    assert.equal(hasRejected(await listedIds()), true);
    const response = await chat(`github/${rejectedModel}`);
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(dispatched, [rejectedModel, rejectedModel]);
    assert.equal(locks.isModelLocked("github", otherId, rejectedModel), false);
  });

  test("account B explicitly advertising only GPT does not keep rejected Claude listed", async () => {
    await rejectOnce();
    await seedOtherConnection("github", [validModel]);
    assert.equal(hasRejected(await listedIds()), false);
  });

  test("account B with unknown inventory preserves the existing fail-open contract", async () => {
    await rejectOnce();
    await seedOtherConnection("github");
    assert.equal(hasRejected(await listedIds()), true);
  });

  test("manual exclusions on account B remain authoritative", async () => {
    await rejectOnce();
    const otherId = await seedOtherConnection("github", [rejectedModel, validModel]);
    await providersDb.updateProviderConnection(otherId, {
      providerSpecificData: { excludedModels: [rejectedModel] },
    });
    assert.equal(hasRejected(await listedIds()), false);
    const repeated = await chat(`github/${rejectedModel}`);
    const body = await repeated.json();
    assert.deepEqual(
      { status: repeated.status, code: body.error?.code },
      { status: 400, code: "model_not_supported" }
    );
    assert.deepEqual(dispatched, [rejectedModel]);
  });

  test("explicit clear rebuilds the complete catalog without changing synced inventory", async () => {
    await listedIds();
    const inventory = await modelsDb.getSyncedAvailableModelsByConnection("github");
    await rejectOnce();
    assert.equal(hasRejected(await listedIds()), false);
    assert.equal(locks.clearModelLock("github", connectionId, rejectedModel), true);
    assert.equal(hasRejected(await listedIds()), true);
    assert.deepEqual(await modelsDb.getSyncedAvailableModelsByConnection("github"), inventory);
  });

  test("the learned six-hour deadline expires without another DB write", async (t) => {
    await rejectOnce();
    const lock = locks.getAllModelLockouts().find((entry) => entry.connectionId === connectionId);
    assert.ok(lock);
    assert.equal(lock.reason, "copilot_model_not_supported");
    assert.equal(lock.until - Date.parse(lock.lockedAt), 6 * 60 * 60 * 1_000);
    assert.equal(hasRejected(await listedIds()), false);
    const builderRuns = v1ModelsCatalog.__getCatalogBuilderRunsForTest();
    const currentTime = Date.now();
    const now = t.mock.method(Date, "now", () => currentTime + 1_000);
    assert.equal(hasRejected(await listedIds()), false);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      builderRuns,
      "a ticking remainingMs must not rebuild"
    );
    now.mock.mockImplementation(() => lock.until);
    assert.equal(
      hasRejected(await listedIds()),
      true,
      "deadline excludes stale locks even at zero remainingMs"
    );
  });

  for (const reason of ["rate_limit", "model_capacity", "model_not_found", "server_error"]) {
    test(`transient ${reason} lock does not remove a model from the catalog`, async () => {
      await listedIds();
      locks.lockModel("github", connectionId, rejectedModel, reason, 60_000);
      assert.equal(hasRejected(await listedIds()), true);
    });
  }

  for (const code of ["model_not_found", "model_capacity"]) {
    test(`an upstream ${code} is not learned as catalog entitlement`, async () => {
      rejectionCode = code;
      await rejectOnce();
      assert.equal(hasRejected(await listedIds()), true);
    });
  }

  test("probe-origin failures do not learn a catalog rejection", async () => {
    await runAsProbe(rejectOnce);
    assert.equal(locks.isModelLocked("github", connectionId, rejectedModel), false);
    assert.equal(hasRejected(await listedIds()), true);
  });

  test("the same model remains visible on a separate provider", async () => {
    await seedOtherConnection("claude", [rejectedModel]);
    await rejectOnce();
    const ids = await listedIds();
    assert.equal(hasRejected(ids), false);
    assert.ok(ids.includes(`claude/${rejectedModel}`));
  });

  test("learned response filtering never marks live combo members stale or prunes them", async () => {
    await providersDb.touchConnectionSyncedModelsAt(connectionId);
    const combo = await combosDb.createCombo({
      name: "copilot-15634",
      strategy: "priority",
      models: [`github/${rejectedModel}`, `github/${validModel}`],
    });
    const inventory = await getActiveSyncedCatalog("github");
    assert.equal(inventory.authoritative, true);
    assert.ok(inventory.models.some((model) => model.id === rejectedModel));
    await rejectOnce();
    assert.equal(hasRejected(await listedIds()), false);
    assert.deepEqual(await getActiveSyncedCatalog("github"), inventory);
    assert.deepEqual(await findStaleComboModelRefs("github"), []);
    assert.deepEqual((await combosDb.getComboById(combo.id))?.models, combo.models);
    const fallback = await chat("copilot-15634");
    assert.equal(fallback.status, 200, await fallback.text());
    assert.deepEqual(dispatched, [rejectedModel, validModel]);
  });

  test("API-key ACL is still applied independently of learned catalog filtering", async () => {
    await rejectOnce();
    const key = await apiKeysDb.createApiKey("catalog-15634", "synthetic-machine");
    await apiKeysDb.updateApiKeyPermissions(key.id, {
      allowedModels: [`github/${validModel}`, `gh/${validModel}`],
    });
    const response = await modelsRoute.GET(
      new Request("http://localhost/v1/models", {
        headers: { Authorization: `Bearer ${key.key}` },
      })
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.data.length > 0);
    assert.ok(
      body.data.every((model: { id: string }) =>
        [`github/${validModel}`, `gh/${validModel}`].includes(model.id)
      )
    );
  });

  test("an already-dispatched long quota response does not erase a learned model rejection", async () => {
    const respondNormally = globalThis.fetch;
    let releaseQuota!: () => void;
    let enteredQuota!: () => void;
    const quotaPending = new Promise<void>((resolve) => {
      releaseQuota = resolve;
    });
    const quotaEntered = new Promise<void>((resolve) => {
      enteredQuota = resolve;
    });
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls += 1;
      if (calls > 1) return respondNormally(input, init);
      const url = new URL(String(input));
      assert.equal(url.hostname, "api.githubcopilot.com");
      assert.equal(JSON.parse(String(init?.body)).model, rejectedModel);
      dispatched.push(rejectedModel);
      enteredQuota();
      await quotaPending;
      return Response.json(
        {
          error: {
            message: "Model quota exceeded. Please retry later.",
            code: "rate_limit_exceeded",
          },
        },
        { status: 429, headers: { "Retry-After": "28800" } }
      );
    };
    const quotaRequest = chat(`gh/${rejectedModel}`);
    await quotaEntered;
    try {
      await rejectOnce();
      assert.equal(hasRejected(await listedIds()), false);
    } finally {
      releaseQuota();
    }
    const quota = await quotaRequest;
    assert.equal(quota.status, 429, await quota.text());
    assert.equal(calls, 2, "both requests were already dispatched before learning");
    assert.equal(
      hasRejected(await listedIds()),
      false,
      "a later quota response must not erase the rejection"
    );
  });

  test("text mentioning model_not_supported without its structured code does not hide a model", async () => {
    rejectionCode = "invalid_request_error";
    rejectionMessage = "The requested model is not supported. Diagnostic: model_not_supported";
    await rejectOnce();
    assert.equal(hasRejected(await listedIds()), true);
  });

  test("a shorter rejection arriving after a long quota keeps its independent expiry", async (t) => {
    const respondNormally = globalThis.fetch;
    let releaseRejected!: () => void;
    let enteredRejected!: () => void;
    const rejectedPending = new Promise<void>((resolve) => {
      releaseRejected = resolve;
    });
    const rejectedEntered = new Promise<void>((resolve) => {
      enteredRejected = resolve;
    });
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls += 1;
      if (calls === 1) {
        enteredRejected();
        await rejectedPending;
        return respondNormally(input, init);
      }
      assert.equal(new URL(String(input)).hostname, "api.githubcopilot.com");
      assert.equal(JSON.parse(String(init?.body)).model, rejectedModel);
      dispatched.push(rejectedModel);
      return Response.json(
        {
          error: {
            message: "Model quota exceeded. Please retry later.",
            code: "rate_limit_exceeded",
          },
        },
        { status: 429, headers: { "Retry-After": "28800" } }
      );
    };
    const rejectedRequest = chat(`gh/${rejectedModel}`);
    await rejectedEntered;
    try {
      const quota = await chat(`gh/${rejectedModel}`);
      assert.equal(quota.status, 429, await quota.text());
      assert.equal(hasRejected(await listedIds()), true, "quota alone must not hide the model");
    } finally {
      releaseRejected();
    }
    const rejected = await rejectedRequest;
    assert.equal(rejected.status, 400, await rejected.text());
    assert.equal(calls, 2);
    assert.equal(hasRejected(await listedIds()), false);
    const currentTime = Date.now();
    t.mock.method(Date, "now", () => currentTime + 6 * 60 * 60 * 1_000 + 1_000);
    assert.equal(hasRejected(await listedIds()), true, "six-hour rejection expires independently");
    assert.equal(
      locks.isModelLocked("github", connectionId, rejectedModel),
      true,
      "eight-hour quota remains active"
    );
    assert.equal(locks.clearModelLock("github", connectionId, rejectedModel), true);
    assert.equal(locks.isModelLocked("github", connectionId, rejectedModel), false);
  });

  test("text without any error code does not create a learned catalog rejection", async () => {
    rejectionCode = undefined;
    rejectionMessage = "The requested model is not supported. Diagnostic: model_not_supported";
    await rejectOnce();
    assert.equal(hasRejected(await listedIds()), true);
  });
});
