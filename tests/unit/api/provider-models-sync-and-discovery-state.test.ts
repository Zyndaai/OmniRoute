// Provider models route: discovery outcome, degraded/intentional catalogs, model sync and
// catalog policy (free-only, media models, capability overrides), no-auth discovery and the
// live-catalog sweep. Merged from twelve files so the heavy
// `src/app/api/providers/[id]/models/route.ts` module graph loads once; each original file is
// one `describe` below, named after the file it came from.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pm-sync-state-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.APP_LOG_TO_FILE = "false";
// model-sync-empty-discovery-19143 / model-sync-keeps-imported-media-models /
// perplexity-agent-provider all needed an API key secret before the app imports.
process.env.API_KEY_SECRET ||= `test-provider-models-sync-${Date.now()}`;

const core = await import("../../../src/lib/db/core.ts");
const { db } = await import("../../../src/lib/db/pg.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const contextOverrides = await import("../../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const catalog = await import("../../../src/lib/db/models/activeSyncedCatalog.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const deletion = await import("../../../src/lib/db/providers/deletion.ts");
const discoveryStateDb = await import("../../../src/lib/db/discoveryState.ts");
const published = await import("../../../src/lib/db/apiKeys/publishedModelLookup.ts");
const providerModelsRoute = await import("../../../src/app/api/providers/[id]/models/route.ts");
const syncModelsRoute = await import("../../../src/app/api/providers/[id]/sync-models/route.ts");
const providersRoute = await import("../../../src/app/api/providers/route.ts");
const providerModelsCrudRoute = await import("../../../src/app/api/provider-models/route.ts");
const { recordDiscoveryOutcome } =
  await import("../../../src/app/api/providers/[id]/models/discovery/discoveryOutcome.ts");
const scheduler = await import("../../../src/shared/services/modelSyncScheduler.ts");
const virtualFactory = await import("../../../open-sse/services/autoCombo/virtualFactory.ts");
const combo = await import("../../../open-sse/services/combo.ts");
const { expandAutoComboCandidatePool } =
  await import("../../../open-sse/services/combo/autoStrategy.ts");
const { NOAUTH_PROVIDERS } = await import("../../../src/shared/constants/providers/noauth.ts");
const { REGISTRY, getRegistryEntry, providerUsesAuthoritativeLiveCatalog } =
  await import("../../../open-sse/config/providerRegistry.ts");
const { DefaultExecutor } = await import("../../../open-sse/executors/default.ts");
const { AI_PROVIDERS, APIKEY_PROVIDERS, getProviderByAlias, getProviderById } =
  await import("../../../src/shared/constants/providers.ts");
const { getModelInfo } = await import("../../../src/sse/services/model.ts");
const { getExplicitModelOutputCap } = await import("../../../src/lib/modelCapabilities.ts");
const { enforceOutputTokenBudget } =
  await import("../../../open-sse/handlers/chatCore/outputTokenBudget.ts");
const { importManagedModels } =
  await import("../../../src/lib/providerModels/managedModelImport.ts");
const { getStaticModelsForProvider } = await import("../../../src/lib/providers/staticModels.ts");
const { getDiscoveryClass } = await import("../../../src/lib/providerModels/discoveryClass.ts");
const { isDegradedDiscovery } =
  await import("../../../src/app/api/providers/[id]/sync-models/degradedLocalCatalog.ts");
const { extractImportWarning, classifyModelImport } =
  await import("../../../src/app/(dashboard)/dashboard/providers/[id]/hooks/modelImportWarning.ts");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const originalFetch = globalThis.fetch;

// Every describe starts (and, where the source had a beforeEach, every test starts) from an
// empty database and data dir with the real fetch restored.
async function resetStorage() {
  globalThis.fetch = originalFetch;
  syncModelsRoute.__resetLoopbackReadinessForTests();
  await core.resetDbInstance();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  globalThis.fetch = originalFetch;
  await resetTestDb();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("discovery-degraded-response", () => {
  type ConnectionInput = {
    provider: string;
    apiKey?: string;
    providerSpecificData?: Record<string, unknown>;
  };

  async function connection({
    provider,
    apiKey = "test-only-key",
    providerSpecificData = { autoFetchModels: true },
  }: ConnectionInput) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider} degraded test`,
      apiKey,
      isActive: true,
      testStatus: "active",
      providerSpecificData,
    });
  }

  function modelsUrl(id: string, refresh = true) {
    return `http://localhost/api/providers/${id}/models${refresh ? "?refresh=true" : ""}`;
  }

  async function listModels(id: string, refresh = true) {
    const response = await providerModelsRoute.GET(new Request(modelsUrl(id, refresh)), {
      params: { id },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  beforeEach(resetStorage);

  test("a discovery whose upstream call fails reports the degraded state and the reason", async () => {
    const stored = await connection({ provider: "openai" });
    globalThis.fetch = async () =>
      new Response('{"key":"sk-abc","token":"gho_secret"}', { status: 500 });

    const { status, body } = await listModels(stored.id);

    assert.equal(status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.degraded, true);
    assert.equal(body.error, "HTTP 500");
    assert.equal("failure" in body, false, "the internal failure must not reach the response body");
    assert.ok(
      !JSON.stringify(body).includes("sk-abc") && !JSON.stringify(body).includes("gho_secret"),
      "the reported reason must not carry upstream secrets"
    );
  });

  test("a successful discovery carries neither the degraded state nor a reason", async () => {
    const stored = await connection({ provider: "openai" });
    globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-4.1", object: "model" }] });

    const { status, body } = await listModels(stored.id);

    assert.equal(status, 200);
    assert.equal(body.source, "api");
    assert.equal("degraded" in body, false);
    assert.equal("error" in body, false);
    assert.equal("failure" in body, false);
  });

  test("a provider whose static catalog is the intended source is not degraded", async () => {
    const stored = await connection({ provider: "ideogram" });
    globalThis.fetch = async () => {
      assert.fail("a static-only provider must not call the upstream");
    };

    const { status, body } = await listModels(stored.id);

    assert.equal(status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.equal("degraded" in body, false);
    assert.equal("error" in body, false);
  });

  test("a discovery the operator turned off is not a degraded discovery", async () => {
    const stored = await connection({
      provider: "openai",
      providerSpecificData: { autoFetchModels: false },
    });
    globalThis.fetch = async () => {
      assert.fail("no discovery must be attempted when the operator turned it off");
    };

    const { status, body } = await listModels(stored.id, false);

    assert.equal(status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.equal("degraded" in body, false);
    assert.equal("error" in body, false);
    assert.match(String(body.warning), /Auto-fetch disabled/);
  });

  test("the codex discovery the operator turned off is not a degraded discovery", async () => {
    // Auto-fetch is off for codex by default: the local catalog is the expected
    // source, so the response must not claim the provider could not be reached.
    const stored = await connection({ provider: "codex", providerSpecificData: {} });
    globalThis.fetch = async () => {
      assert.fail("no discovery must be attempted when the operator turned it off");
    };

    const { status, body } = await listModels(stored.id, false);

    assert.equal(status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.equal("degraded" in body, false);
    assert.equal("error" in body, false);
    assert.equal(body.warning, "Auto-fetch disabled — using local catalog");
  });

  test("a discovery with no credential reports the missing credential", async () => {
    const stored = await connection({ provider: "openai", apiKey: "" });
    globalThis.fetch = async () => {
      assert.fail("no credential means no discovery attempt");
    };

    const { status, body } = await listModels(stored.id);

    assert.equal(status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.degraded, true);
    assert.equal(body.error, "NO_CREDENTIAL");
    assert.equal("failure" in body, false);
  });

  test("a discovery that answered without a usable model reports an empty catalog", async () => {
    const stored = await connection({ provider: "openai" });
    globalThis.fetch = async () => Response.json({ data: [] });

    const { status, body } = await listModels(stored.id);

    assert.equal(status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(body.degraded, true);
    assert.equal(body.error, "EMPTY_CATALOG");
    assert.equal("failure" in body, false);
  });

  test("the degraded state and its reason always travel together", async () => {
    const stored = await connection({ provider: "openai" });
    globalThis.fetch = async () => new Response("upstream down", { status: 503 });

    const { body } = await listModels(stored.id);

    assert.equal("degraded" in body, "error" in body, "the flag and the reason go together");
    assert.equal(body.degraded, true);
    assert.equal(body.error, "HTTP 503");
  });
});

describe("discovery-free-only-policy", () => {
  // The import-free-models-only setting must hold where models are READ for
  // routing: the dispatch catalog, the /v1/models listing and the auto-combo
  // pools. A refresh keeps paid rows as cached discovery (#17028) and a sync of a
  // listing with no free model stores nothing, so both states must still leave
  // paid models out — and an empty free set must not fall back to the static
  // catalog.
  const FREE = {
    id: "vendor/free-model:free",
    name: "Free model",
    pricing: { prompt: "0", completion: "0" },
  };
  const PAID = {
    id: "vendor/paid-model",
    name: "Paid model",
    pricing: { prompt: "0.000003", completion: "0.000015" },
  };

  async function seedOpenRouter(importFreeModelsOnly: boolean): Promise<{ id: string }> {
    return (await providersDb.createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: `openrouter-${importFreeModelsOnly ? "free" : "all"}`,
      apiKey: "openrouter-fixture-key",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { autoFetchModels: true, importFreeModelsOnly },
    })) as { id: string };
  }

  /** Answer the upstream listing; the sync's discovery loopback runs the real route in-process. */
  function serveListing(connectionId: string, listing: unknown[]) {
    globalThis.fetch = async (input, init) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl);
      if (url.pathname.includes("__readiness_probe__")) return new Response("", { status: 404 });
      if (url.pathname === `/api/providers/${connectionId}/models`) {
        return providerModelsRoute.GET(new Request(rawUrl, init), {
          params: Promise.resolve({ id: connectionId }),
        });
      }
      assert.equal(rawUrl, "https://openrouter.ai/api/v1/models");
      return Response.json({ data: listing });
    };
  }

  async function refresh(connectionId: string, listing: unknown[]) {
    serveListing(connectionId, listing);
    const response = await providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
      { params: Promise.resolve({ id: connectionId }) }
    );
    assert.equal(response.status, 200);
  }

  async function sync(connectionId: string, listing: unknown[]) {
    serveListing(connectionId, listing);
    const response = await syncModelsRoute.POST(
      new Request(`http://localhost/api/providers/${connectionId}/sync-models`, {
        method: "POST",
        headers: scheduler.buildModelSyncInternalHeaders(),
      }),
      { params: Promise.resolve({ id: connectionId }) }
    );
    return { response, body: (await response.json()) as Record<string, unknown> };
  }

  async function storedIds(connectionId: string) {
    const synced = await modelsDb.getSyncedAvailableModelsForConnection("openrouter", connectionId);
    return synced.map((model) => model.id).sort();
  }

  async function dispatchAdmits(modelId: string) {
    const reconciled = await catalog.reconcileProvidersWithActiveSyncedCatalog(
      ["openrouter"],
      modelId
    );
    return reconciled.providers.includes("openrouter");
  }

  async function poolModels() {
    const prepared = await virtualFactory.prepareVirtualAutoComboInputs();
    const virtual = prepared.regularCandidates
      .filter((candidate) => candidate.provider === "openrouter")
      .map((candidate) => candidate.model);
    const expanded = (await combo.expandAutoComboCandidatePool([], { config: {} }))
      .filter((target) => target.provider === "openrouter")
      .map((target) => target.modelStr);
    return { virtual, expanded };
  }

  beforeEach(resetStorage);

  test("a free-only sync of a listing with no free model stores nothing and reports it", async () => {
    const connection = await seedOpenRouter(true);

    const { response, body } = await sync(connection.id, [PAID]);

    assert.equal(
      response.status,
      200,
      "an all-paid listing is a successful sync with nothing to keep"
    );
    assert.equal(body.freeFilterEmpty, true);
    assert.deepEqual(await storedIds(connection.id), []);
  });

  test("the stale cut also removes paid rows a refresh cached before the sync", async () => {
    const connection = await seedOpenRouter(true);
    // The refresh keeps the full listing as cached discovery, paid rows marked non-free (#17028).
    await refresh(connection.id, [PAID]);
    assert.ok((await storedIds(connection.id)).includes(PAID.id));

    const { response } = await sync(connection.id, [PAID]);

    assert.equal(response.status, 200);
    assert.deepEqual(await storedIds(connection.id), []);
  });

  test("after that sync the provider has nothing callable: no paid model, no static fallback", async () => {
    const connection = await seedOpenRouter(true);
    await sync(connection.id, [PAID]);

    const active = await catalog.getActiveSyncedCatalog("openrouter");
    assert.equal(
      active.authoritative,
      true,
      "an empty free set is a synced answer, not a missing catalog"
    );
    assert.deepEqual(active.models, []);
    assert.equal(await dispatchAdmits(PAID.id), false, "dispatch must reject the paid model");
    assert.equal(
      await dispatchAdmits("auto"),
      false,
      "dispatch must not fall back to the static catalog"
    );

    const listing = await catalog.getAllActiveSyncedModels();
    assert.equal(listing.openrouter, undefined, "/v1/models lists nothing for the provider");

    const pools = await poolModels();
    assert.deepEqual(
      pools.virtual,
      [],
      "the virtual auto pool must not fall back to the static catalog"
    );
    assert.deepEqual(
      pools.expanded,
      [],
      "the expanded auto pool must not fall back to the static catalog"
    );
  });

  test("between a refresh and the next sync, routing serves only the free models", async () => {
    const connection = await seedOpenRouter(true);
    // No sync yet: the stored rows still hold the paid model, marked non-free.
    await refresh(connection.id, [FREE, PAID]);
    assert.deepEqual(await storedIds(connection.id), [PAID.id, FREE.id].sort());

    const active = await catalog.getActiveSyncedCatalog("openrouter");
    assert.equal(active.authoritative, true);
    assert.deepEqual(
      active.models.map((model) => model.id),
      [FREE.id]
    );
    assert.equal(await dispatchAdmits(FREE.id), true);
    assert.equal(await dispatchAdmits(PAID.id), false);

    const listing = await catalog.getAllActiveSyncedModels();
    assert.deepEqual(
      (listing.openrouter ?? []).map((model) => model.id),
      [FREE.id]
    );

    const pools = await poolModels();
    assert.deepEqual(pools.virtual, [FREE.id]);
    assert.deepEqual(pools.expanded, [`openrouter/${FREE.id}`]);

    // A key limited to published models may call the free one only.
    assert.ok(await published.findPublishedModel("openrouter", FREE.id));
    assert.equal(await published.findPublishedModel("openrouter", PAID.id), null);
  });

  test("a connection that imports every model keeps the paid ones callable", async () => {
    const connection = await seedOpenRouter(false);
    await refresh(connection.id, [FREE, PAID]);

    assert.equal(await dispatchAdmits(PAID.id), true);
    assert.deepEqual((await poolModels()).virtual.sort(), [PAID.id, FREE.id].sort());
  });
});

describe("discovery-state-memorized", () => {
  /**
   * Integration coverage for the stored discovery outcome.
   *
   * A failed discovery used to leave no trace: the next read of the same
   * connection looked healthy, and the provider page had nothing to show. The
   * outcome of the last discovery is now stored per connection, read back by
   * GET /api/providers, and cleared when the connection is deleted.
   */
  async function createConnection(
    provider: string,
    name: string,
    providerSpecificData: Record<string, unknown> = { autoFetchModels: true }
  ) {
    return providersDb.createProviderConnection({
      provider,
      name,
      authType: "apikey",
      apiKey: `${provider}-${name}-key`,
      isActive: true,
      testStatus: "active",
      providerSpecificData,
    });
  }

  /**
   * A no-auth provider that declares a live models endpoint. The provider is
   * DERIVED from the provider registry, not hardcoded: providers come and go
   * between releases, and a stale literal would turn this test into a false
   * failure while covering no provider at all.
   */
  function noAuthProviderWithLiveCatalog(): string {
    const noAuthProviders = NOAUTH_PROVIDERS as Record<string, { noAuth?: boolean }>;
    for (const id of Object.keys(noAuthProviders)) {
      if (noAuthProviders[id]?.noAuth !== true) continue;
      const modelsUrl = getRegistryEntry(id)?.modelsUrl;
      if (typeof modelsUrl === "string" && modelsUrl.length > 0) return id;
    }
    throw new Error("expected at least one no-auth provider with a live models endpoint");
  }

  async function listConnections(provider: string) {
    const response = await providersRoute.GET(
      await makeManagementSessionRequest(`http://localhost/api/providers?provider=${provider}`)
    );
    const body = (await response.json()) as {
      connections: Array<{
        id: string;
        provider: string;
        discoveryState: { status: string; cause: string | null; at: string } | null;
      }>;
    };
    assert.equal(response.status, 200);
    return body.connections;
  }

  const discoveryRoute = providerModelsRoute;

  // The management-session helper signs with JWT_SECRET and a set INITIAL_PASSWORD turns the
  // management auth on. Other describes (provider-model-output-vision-14337 calls the
  // /api/provider-models handlers unauthenticated) need both unset, so they are scoped here.
  const ENV_KEYS = ["JWT_SECRET", "INITIAL_PASSWORD"] as const;
  const savedEnv: Record<string, string | undefined> = {};
  before(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.JWT_SECRET = "test-jwt-secret-for-discovery-state-memorized";
    process.env.INITIAL_PASSWORD = "admin-secret";
  });
  after(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(resetStorage);

  test("a failed discovery is remembered for its connection", async () => {
    const saved = await createConnection("aimlapi", "remember-me");
    const connection = { provider: "aimlapi", connectionId: saved.id };

    await recordDiscoveryOutcome({
      ...connection,
      degraded: true,
      error: "HTTP 500",
      source: "cache",
      warning: "API unavailable — using cached catalog",
    });

    const states = await discoveryStateDb.getDiscoveryStatesForConnections([
      { provider: connection.provider, id: connection.connectionId },
    ]);
    const stored = states.get(`aimlapi:${saved.id}`);
    assert.equal(stored?.status, "degraded");
    assert.equal(stored?.cause, "HTTP 500");
    assert.ok(Number.isFinite(Date.parse(stored?.at ?? "")));
  });

  test("a later read does not erase the remembered failure", async () => {
    // Auto-fetch is off: a plain read answers from the catalog WITHOUT running a
    // discovery, so it has no outcome of its own to record. (With auto-fetch on, a
    // plain read is a live discovery and legitimately records its own outcome.)
    const connection = await createConnection("aimlapi", "remembered", { autoFetchModels: false });
    await recordDiscoveryOutcome({
      provider: "aimlapi",
      connectionId: connection.id,
      degraded: true,
      error: "HTTP 500",
      source: "cache",
    });

    // A plain read of the same connection (no refresh) still answers from the
    // catalog: the remembered failure must survive it.
    const response = await discoveryRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models`),
      { params: { id: connection.id } }
    );
    assert.equal(response.status, 200);

    const [row] = await listConnections("aimlapi");
    assert.equal(row.discoveryState?.status, "degraded");
    assert.equal(row.discoveryState?.cause, "HTTP 500");
  });

  test("a successful discovery makes the remembered outcome healthy again", async () => {
    const connection = await createConnection("openai", "recovered");
    await recordDiscoveryOutcome({
      provider: "openai",
      connectionId: connection.id,
      degraded: true,
      error: "HTTP 500",
      source: "cache",
    });

    globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-4.1", object: "model" }] });
    const response = await discoveryRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
      { params: { id: connection.id } }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "api");

    const [row] = await listConnections("openai");
    assert.equal(row.discoveryState?.status, "healthy");
    assert.equal(row.discoveryState?.cause, null);
  });

  test("two connections of one provider keep their own outcome", async () => {
    const degraded = await createConnection("aimlapi", "degraded");
    const healthy = await createConnection("aimlapi", "healthy");

    await recordDiscoveryOutcome({
      provider: "aimlapi",
      connectionId: degraded.id,
      degraded: true,
      error: "HTTP 500",
      source: "cache",
    });

    const rows = await listConnections("aimlapi");
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get(degraded.id)?.discoveryState?.status, "degraded");
    assert.equal(byId.get(degraded.id)?.discoveryState?.cause, "HTTP 500");
    assert.equal(byId.get(healthy.id)?.discoveryState, null);
  });

  test("a connection that was never refreshed reads as unknown, never as healthy", async () => {
    await createConnection("aimlapi", "never-refreshed");

    const [row] = await listConnections("aimlapi");
    assert.equal(row.discoveryState, null);
  });

  test("a local condition keeps the previous outcome and its own date", async () => {
    const saved = await createConnection("aimlapi", "local-condition");
    const connection = { provider: "aimlapi", connectionId: saved.id };
    await recordDiscoveryOutcome({
      ...connection,
      degraded: true,
      error: "HTTP 500",
      source: "cache",
    });
    const before = (
      await discoveryStateDb.getDiscoveryStatesForConnections([
        { provider: connection.provider, id: connection.connectionId },
      ])
    ).get(`aimlapi:${saved.id}`);

    await recordDiscoveryOutcome({
      ...connection,
      degraded: true,
      error: "NO_CREDENTIAL",
      source: "local_catalog",
    });

    const after = (
      await discoveryStateDb.getDiscoveryStatesForConnections([
        { provider: connection.provider, id: connection.connectionId },
      ])
    ).get(`aimlapi:${saved.id}`);
    assert.equal(after?.status, "degraded");
    assert.equal(after?.cause, "HTTP 500");
    assert.equal(after?.at, before?.at);
  });

  test("a remembered failure never touches the routing fields of the connection", async () => {
    const connection = await createConnection("aimlapi", "routing-untouched");
    const before = await providersDb.getProviderConnections({ provider: "aimlapi" });

    globalThis.fetch = async () => new Response("upstream down", { status: 500 });
    const response = await discoveryRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
      { params: { id: connection.id } }
    );
    assert.equal(response.status, 200);

    const after = await providersDb.getProviderConnections({ provider: "aimlapi" });
    assert.equal(after[0].lastError, before[0].lastError);
    assert.equal(after[0].lastErrorType, before[0].lastErrorType);
    assert.equal(after[0].lastErrorSource, before[0].lastErrorSource);
    assert.equal(after[0].testStatus, before[0].testStatus);
  });

  test("a failed upstream discovery answers with its cause and is remembered", async () => {
    const connection = await createConnection("aimlapi", "upstream-failure");
    globalThis.fetch = async () => new Response("upstream down", { status: 500 });

    const response = await discoveryRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as { degraded?: unknown; error?: unknown };
    assert.equal(response.status, 200);
    assert.equal(body.degraded, true, "the response must say the discovery fell back");
    assert.equal(body.error, "HTTP 500", "the response must carry the reason of the failure");

    const [row] = await listConnections("aimlapi");
    assert.equal(row.discoveryState?.status, "degraded");
    assert.equal(row.discoveryState?.cause, "HTTP 500");
  });

  test("a failed Copilot discovery is remembered with the cause derived from its structured failure", async () => {
    // The Copilot result carries the structured diagnostics (#17984); the stored
    // cause must be the closed-vocabulary one derived from them, not a generic
    // upstream error.
    const connection = await providersDb.createProviderConnection({
      provider: "github",
      authType: "oauth",
      name: "copilot-upstream-failure",
      accessToken: "github-access-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { copilotToken: "copilot-token" },
    });
    globalThis.fetch = async () =>
      new Response("nope", { status: 503, headers: { "content-type": "text/plain" } });

    const response = await discoveryRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as { degraded?: unknown; error?: unknown };
    assert.equal(response.status, 200);
    assert.equal(body.degraded, true);
    assert.equal(body.error, "HTTP 503");

    const [row] = await listConnections("github");
    assert.equal(row.discoveryState?.status, "degraded");
    assert.equal(row.discoveryState?.cause, "HTTP 503");
  });

  test("a no-auth provider whose live catalog fails is remembered too", async () => {
    const provider = noAuthProviderWithLiveCatalog();
    const connection = await createConnection(provider, "no-auth-failure");
    globalThis.fetch = async () => new Response("upstream down", { status: 500 });

    const response = await discoveryRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as { degraded?: unknown; error?: unknown };
    assert.equal(response.status, 200);
    assert.equal(body.degraded, true, "the response must say the live catalog could not be used");
    assert.equal(body.error, "HTTP 500", "the response must carry the reason of the failure");

    const [row] = await listConnections(provider);
    assert.equal(row.discoveryState?.status, "degraded");
    assert.equal(row.discoveryState?.cause, "HTTP 500");
  });

  test("deleting a connection drops its remembered outcome", async () => {
    const connection = await createConnection("aimlapi", "deleted");
    await recordDiscoveryOutcome({
      provider: "aimlapi",
      connectionId: connection.id,
      degraded: true,
      error: "HTTP 500",
      source: "cache",
    });
    assert.equal(
      (
        await discoveryStateDb.getDiscoveryStatesForConnections([
          { provider: "aimlapi", id: connection.id },
        ])
      ).size,
      1
    );

    await deletion.deleteProviderConnection(connection.id);

    assert.equal(
      (
        await discoveryStateDb.getDiscoveryStatesForConnections([
          { provider: "aimlapi", id: connection.id },
        ])
      ).size,
      0
    );
  });

  test("a failed purge of the stored outcome leaves a trace and never fails the deletion", async () => {
    const connection = await createConnection("aimlapi", "purge-failure");
    await recordDiscoveryOutcome({
      provider: "aimlapi",
      connectionId: connection.id,
      degraded: true,
      error: "HTTP 500",
      source: "cache",
    });

    // Only the purge of the discovery outcomes fails: a statement-level trigger
    // makes every UPDATE of connection_model_sync raise, and nothing else of the
    // deletion path touches that statement. Removed again in `finally`.
    const backend = getTestBackend();
    await backend.execute(`
      CREATE OR REPLACE FUNCTION test_fail_discovery_purge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'the discovery outcome store is unavailable'; END $$`);
    await backend.execute(`
      CREATE TRIGGER test_fail_discovery_purge BEFORE UPDATE ON connection_model_sync
      FOR EACH STATEMENT EXECUTE FUNCTION test_fail_discovery_purge()`);

    const errors: unknown[][] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    let deleted: boolean | undefined;
    try {
      deleted = await deletion.deleteProviderConnection(connection.id);
    } finally {
      console.error = log;
      await backend.execute(
        "DROP TRIGGER IF EXISTS test_fail_discovery_purge ON connection_model_sync"
      );
      await backend.execute("DROP FUNCTION IF EXISTS test_fail_discovery_purge()");
    }

    assert.equal(deleted, true, "a failed purge must not fail the deletion");
    assert.equal(errors.length, 1, "the failed purge must leave exactly one trace");
    assert.match(String(errors[0][0]), /discovery outcome/i);
    assert.ok(errors[0][1] instanceof Error, "the trace must carry the failure");
  });

  test("the models list of the provider page carries no verdict of the discovery", () => {
    const modelsSection = fs.readFileSync(
      path.join(
        repoRoot,
        "src/app/(dashboard)/dashboard/providers/[id]/components/ProviderModelsSection.tsx"
      ),
      "utf8"
    );
    const modelsHook = fs.readFileSync(
      path.join(
        repoRoot,
        "src/app/(dashboard)/dashboard/providers/[id]/hooks/useProviderModels.ts"
      ),
      "utf8"
    );

    assert.doesNotMatch(modelsSection, /discoveryState/);
    assert.doesNotMatch(modelsHook, /discoveryState/);
  });
});

describe("model-discovery-diagnostics", () => {
  type ModelRow = { id: string };
  type ModelsBody = {
    provider?: string;
    source?: string;
    intentional?: boolean;
    models?: ModelRow[];
    discoveryFailure?: Record<string, unknown>;
    degraded?: boolean;
    error?: string;
    failure?: unknown;
  };

  async function callRoute(connectionId: string, search = "") {
    return providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
      { params: { id: connectionId } }
    );
  }

  beforeEach(resetStorage);

  function installLocalModelRouteFetch() {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("__readiness_probe__")) {
        return new Response(null, { status: 404 });
      }
      const match = url.pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
      assert.ok(match, `unexpected model-sync internal URL: ${url.pathname}`);
      return providerModelsRoute.GET(new Request(url, init), {
        params: { id: decodeURIComponent(match[1]!) },
      });
    };
  }

  test("Veo AI Free exposes its static no-auth video catalog as intentional", async () => {
    const response = await callRoute("veoaifree-web");
    const body = (await response.json()) as ModelsBody;

    assert.equal(response.status, 200);
    assert.equal(body.provider, "veoaifree-web");
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.deepEqual(
      body.models?.map((model) => model.id),
      ["veo", "seedance"]
    );
  });

  test("Veo AI Free's intentional catalog completes model sync instead of returning 502", async () => {
    installLocalModelRouteFetch();
    const connection = await providersDb.createProviderConnection({
      provider: "veoaifree-web",
      authType: "no-auth",
      name: "veo-sync-diagnostics-test",
      isActive: true,
      testStatus: "active",
    });

    const response = await syncModelsRoute.POST(
      new Request(`http://localhost/api/providers/${connection.id}/sync-models`, {
        method: "POST",
        headers: scheduler.buildModelSyncInternalHeaders(),
      }),
      { params: Promise.resolve({ id: connection.id }) }
    );
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.syncedModels, 2);
    assert.equal(body.availableModelsCount, 2);
  });

  test("a failed no-auth live catalog stays degraded instead of becoming intentional", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "aihorde",
      authType: "no-auth",
      name: "aihorde-diagnostics-test",
      isActive: true,
      testStatus: "active",
    });
    globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

    const response = await callRoute(connection.id);
    const body = (await response.json()) as ModelsBody;

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.notEqual(body.intentional, true);
  });

  test("Copilot route returns safe structured failure diagnostics with its fallback warning", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "github",
      authType: "oauth",
      name: "github-diagnostics-test",
      accessToken: "github-access-secret",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { copilotToken: "copilot-token-secret" },
    });
    globalThis.fetch = async () =>
      new Response('{"private":"must-not-leak"}', {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as ModelsBody;

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.deepEqual(body.discoveryFailure, {
      kind: "http_status",
      upstreamStatus: 503,
      contentType: "application/json",
      bodyShape: "json",
    });
    // One shape: the structured diagnostics stay published as `discoveryFailure`
    // and the closed-vocabulary cause is derived from them, never rebuilt apart.
    assert.equal(body.degraded, true);
    assert.equal(body.error, "HTTP 503");
    assert.equal("failure" in body, false, "the internal failure never reaches the response");
    assert.doesNotMatch(
      JSON.stringify(body),
      /must-not-leak|github-access-secret|copilot-token-secret/
    );
  });
});

describe("model-sync-empty-discovery-19143", () => {
  // #19143: a sync whose upstream answers 200 with no models must not touch the catalog.
  // The self-fetch is served by the real /models route because the destructive write
  // happens there, before the sync route looks at the response.
  const COMPATIBLE = "openai-compatible-19143";
  const OLD_SYNC = "2020-01-01T00:00:00.000Z";

  type Row = { id: string; source?: string };
  type Upstream = () => Response;

  const emptyList: Upstream = () => Response.json({ data: [] });
  const noListKey: Upstream = () => Response.json({ error: { message: "starting up" } });
  const listOf =
    (...rows: Array<string | Record<string, unknown>>): Upstream =>
    () =>
      Response.json({ data: rows.map((row) => (typeof row === "string" ? { id: row } : row)) });

  function serve(upstream: Upstream) {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("__readiness_probe__")) {
        return new Response(null, { status: 404 });
      }
      const self = url.pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
      if (self) {
        return providerModelsRoute.GET(new Request(url.href, { headers: init?.headers }), {
          params: Promise.resolve({ id: decodeURIComponent(self[1]) }),
        });
      }
      return upstream();
    };
  }

  async function sync(connectionId: string, search = "") {
    const response = await syncModelsRoute.POST(
      new Request(`http://localhost/api/providers/${connectionId}/sync-models${search}`, {
        method: "POST",
        headers: scheduler.buildModelSyncInternalHeaders(),
      }),
      { params: Promise.resolve({ id: connectionId }) }
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function connect(provider = COMPATIBLE, name = "main", extra: Record<string, unknown> = {}) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name,
      apiKey: "test-key",
      providerSpecificData: { baseUrl: "https://proxy.example.com/v1", ...extra },
    });
  }

  async function syncedAt(connectionId: string): Promise<string | null> {
    const row = await db().queryOne<{ at: string | Date | null }>(
      "SELECT synced_models_at AS at FROM provider_connections WHERE id = $1",
      [connectionId]
    );
    const at = row?.at ?? null;
    return at instanceof Date ? at.toISOString() : at;
  }

  async function setSyncedAt(connectionId: string, value: string | null) {
    await db().execute("UPDATE provider_connections SET synced_models_at = $1 WHERE id = $2", [
      value,
      connectionId,
    ]);
    invalidateDbCache();
  }

  async function syncedIds(provider: string, connectionId: string) {
    const rows = await modelsDb.getSyncedAvailableModelsForConnection(provider, connectionId);
    return rows.map((row) => row.id).sort();
  }

  async function customIds(provider = COMPATIBLE) {
    const rows = (await modelsDb.getCustomModels(provider)) as Row[];
    return rows.map((row) => row.id).sort();
  }

  beforeEach(async () => {
    delete process.env.COMBO_AUTO_PRUNE_STALE_STEPS;
    await resetStorage();
    apiKeysDb.resetApiKeyState();
  });
  after(() => {
    delete process.env.COMBO_AUTO_PRUNE_STALE_STEPS;
  });

  for (const [label, search] of [
    ["scheduled sync", ""],
    ["mode=import", "?mode=import"],
  ] as const) {
    for (const [shape, upstream] of [
      ["empty list", emptyList],
      ["no list key", noListKey],
    ] as const) {
      test(`${label}, ${shape}: a cached catalog and every custom row survive`, async () => {
        const connection = await connect();
        await modelsDb.replaceSyncedAvailableModelsForConnection(COMPATIBLE, connection.id, [
          { id: "model-a", name: "Model A" },
          { id: "model-b", name: "Model B" },
        ]);
        await setSyncedAt(connection.id, OLD_SYNC);
        await modelsDb.addCustomModel(COMPATIBLE, "imported-row", "Imported", "imported");
        await modelsDb.addCustomModel(COMPATIBLE, "manual-row", "Manual", "manual");
        await modelsDb.setModelAlias("keep-alias", `${COMPATIBLE}/model-a`);
        await modelsDb.markManagedModelAlias("keep-alias");

        serve(upstream);
        const { status, body } = await sync(connection.id, search);

        assert.equal(status, 502);
        assert.equal(body.error, "EMPTY_CATALOG");
        assert.deepEqual(await syncedIds(COMPATIBLE, connection.id), ["model-a", "model-b"]);
        assert.deepEqual(await customIds(), ["imported-row", "manual-row"]);
        assert.equal(await syncedAt(connection.id), OLD_SYNC);
        assert.equal((await modelsDb.getModelAliases())["keep-alias"], `${COMPATIBLE}/model-a`);
      });

      test(`${label}, ${shape}: no cache and no local catalog fails the sync and keeps rows`, async () => {
        const connection = await connect();
        await modelsDb.addCustomModel(COMPATIBLE, "imported-row", "Imported", "imported");
        await modelsDb.addCustomModel(COMPATIBLE, "manual-row", "Manual", "manual");
        await setSyncedAt(connection.id, null);

        serve(upstream);
        const { status, body } = await sync(connection.id, search);

        assert.equal(status, 502);
        assert.equal(body.error, "EMPTY_CATALOG");
        assert.deepEqual(await customIds(), ["imported-row", "manual-row"]);
        assert.equal(await syncedAt(connection.id), null);
      });
    }
  }

  test("a provider with a static catalog keeps its synced rows instead of falling back", async () => {
    const connection = await connect("opencode-go");
    await modelsDb.replaceSyncedAvailableModelsForConnection("opencode-go", connection.id, [
      { id: "cached-go", name: "Cached Go" },
    ]);
    await setSyncedAt(connection.id, OLD_SYNC);

    serve(emptyList);
    const { status, body } = await sync(connection.id);

    assert.equal(status, 502);
    assert.equal(body.error, "EMPTY_CATALOG");
    assert.deepEqual(await syncedIds("opencode-go", connection.id), ["cached-go"]);
    assert.equal(await syncedAt(connection.id), OLD_SYNC);
  });

  test("empty discovery on one connection does not refresh a stale sibling catalog", async () => {
    const stale = await connect(COMPATIBLE, "stale");
    const empty = await connect(COMPATIBLE, "empty");
    await modelsDb.replaceSyncedAvailableModelsForConnection(COMPATIBLE, stale.id, [
      { id: "old-model", name: "Old" },
    ]);
    await setSyncedAt(stale.id, OLD_SYNC);
    await setSyncedAt(empty.id, null);
    assert.equal((await catalog.getActiveSyncedCatalog(COMPATIBLE)).authoritative, false);

    serve(emptyList);
    const { status } = await sync(empty.id);

    assert.equal(status, 502);
    assert.equal(await syncedAt(empty.id), null);
    assert.equal((await catalog.getActiveSyncedCatalog(COMPATIBLE)).authoritative, false);
  });

  test("empty discovery on one connection does not prune combo steps it alone served", async () => {
    process.env.COMBO_AUTO_PRUNE_STALE_STEPS = "true";
    const healthy = await connect(COMPATIBLE, "healthy");
    const empty = await connect(COMPATIBLE, "empty");
    await modelsDb.replaceSyncedAvailableModelsForConnection(COMPATIBLE, healthy.id, [
      { id: "model-a", name: "A" },
    ]);
    await modelsDb.replaceSyncedAvailableModelsForConnection(COMPATIBLE, empty.id, [
      { id: "model-b", name: "B" },
    ]);
    const steps = [`${COMPATIBLE}/model-a`, `${COMPATIBLE}/model-b`];
    const createdCombo = await combosDb.createCombo({ name: "combo-19143", models: steps });

    serve(emptyList);
    const { status } = await sync(empty.id);

    assert.equal(status, 502);
    assert.deepEqual(
      (await combosDb.getComboById(String(createdCombo.id)))?.models,
      createdCombo.models
    );
    assert.deepEqual(await syncedIds(COMPATIBLE, empty.id), ["model-b"]);
  });

  test("a cached catalog of only non-chat models survives on the chat surface", async () => {
    const connection = await connect();
    await modelsDb.replaceSyncedAvailableModelsForConnection(COMPATIBLE, connection.id, [
      { id: "embed-a", name: "Embed", supportedEndpoints: ["embeddings"] },
    ]);
    await setSyncedAt(connection.id, OLD_SYNC);

    serve(emptyList);
    const { status } = await sync(connection.id);

    assert.equal(status, 502);
    assert.deepEqual(await syncedIds(COMPATIBLE, connection.id), ["embed-a"]);
    assert.equal(await syncedAt(connection.id), OLD_SYNC);
  });

  test("control: a healthy non-chat-only catalog is not treated as empty", async () => {
    const connection = await connect();
    await modelsDb.addCustomModel(COMPATIBLE, "synthetic-chat", "Synthetic", "imported");
    await modelsDb.addCustomModel(COMPATIBLE, "speech-row", "Speech", "imported", "audio-speech", [
      "audio-speech",
    ]);
    await setSyncedAt(connection.id, OLD_SYNC);

    serve(listOf({ id: "embed-a", supportedEndpoints: ["embeddings"] }));
    const { status } = await sync(connection.id);

    assert.equal(status, 200);
    assert.deepEqual(await syncedIds(COMPATIBLE, connection.id), ["embed-a"]);
    assert.notEqual(await syncedAt(connection.id), OLD_SYNC);
    // #14825: media rows stay and rows with the synthetic chat default are replaced.
    assert.deepEqual(await customIds(), ["speech-row"]);
  });

  test("control: a smaller non-empty catalog still removes models and managed aliases", async () => {
    const connection = await connect();
    serve(listOf("model-a", "model-b"));
    assert.equal((await sync(connection.id)).status, 200);
    const before = Object.keys(await modelsDb.getModelAliases());
    assert.equal(before.length, 2);

    serve(listOf("model-a"));
    assert.equal((await sync(connection.id)).status, 200);

    assert.deepEqual(await syncedIds(COMPATIBLE, connection.id), ["model-a"]);
    assert.deepEqual(Object.values(await modelsDb.getModelAliases()), [`${COMPATIBLE}/model-a`]);
  });

  test("repeated empty answers then a healthy one updates the catalog normally", async () => {
    const connection = await connect();
    await modelsDb.replaceSyncedAvailableModelsForConnection(COMPATIBLE, connection.id, [
      { id: "model-a", name: "A" },
    ]);
    await setSyncedAt(connection.id, OLD_SYNC);

    serve(emptyList);
    assert.equal((await sync(connection.id)).status, 502);
    assert.equal((await sync(connection.id)).status, 502);
    assert.equal(await syncedAt(connection.id), OLD_SYNC);

    serve(listOf("model-a", "model-new"));
    assert.equal((await sync(connection.id)).status, 200);

    assert.deepEqual(await syncedIds(COMPATIBLE, connection.id), ["model-a", "model-new"]);
    assert.notEqual(await syncedAt(connection.id), OLD_SYNC);
  });

  test("control: importFreeModelsOnly with no free models keeps its deliberate cleanup", async () => {
    const connection = await connect(COMPATIBLE, "free-only", { importFreeModelsOnly: true });
    await modelsDb.addCustomModel(COMPATIBLE, "imported-row", "Imported", "imported");

    serve(listOf("paid-model"));
    const { status, body } = await sync(connection.id);

    assert.equal(status, 200);
    assert.equal(body.freeFilterEmpty, true);
    assert.deepEqual(await customIds(), []);
  });
});

describe("model-sync-keeps-imported-media-models", () => {
  // Model sync discovers through the chat surface, so a speech / transcription /
  // image model never comes back from it. Sync used to drop every imported row
  // before re-adding what it discovered, which silently deleted every model a
  // media-only provider (Soniox, ElevenLabs, …) had imported from its local catalog
  // on the next sync cycle — every 6 h and on every restart. API keys with
  // "Disable Non-Public Models" then answered 403 for those models again.
  type StoredModel = { id: string; source?: string; apiFormat?: string };

  before(resetStorage);

  test("model sync keeps the speech and transcription models a media-only provider imported", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "soniox",
      authType: "apikey",
      name: "Soniox media sync",
      apiKey: "soniox-test-key",
    });
    const staticCatalog = getStaticModelsForProvider("soniox") || [];
    assert.ok(staticCatalog.length > 0);
    for (const model of staticCatalog) {
      await modelsDb.addCustomModel(
        "soniox",
        model.id,
        model.name,
        "imported",
        model.apiFormat,
        model.supportedEndpoints
      );
    }
    const importedIds = staticCatalog.map((model) => model.id).sort();

    // Serve the self-fetch from the real /models route so the sync sees exactly
    // what production sees, including the chat-surface filter.
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("__readiness_probe__")) {
        return new Response(null, { status: 404 });
      }
      if (url.pathname === `/api/providers/${connection.id}/models`) {
        return providerModelsRoute.GET(new Request(url.href, { headers: init?.headers }), {
          params: Promise.resolve({ id: connection.id }),
        });
      }
      throw new Error(`Unexpected fetch in media sync test: ${url.href}`);
    };

    const response = await syncModelsRoute.POST(
      new Request(`http://localhost/api/providers/${connection.id}/sync-models?quiet=1`, {
        method: "POST",
        headers: scheduler.buildModelSyncInternalHeaders(),
      }),
      { params: { id: connection.id } }
    );

    assert.equal(response.status, 200);
    const stored = (await modelsDb.getCustomModels("soniox")) as StoredModel[];
    assert.deepEqual(stored.map((model) => model.id).sort(), importedIds);
  });

  test("sync still replaces imported chat rows with the discovered catalog", async () => {
    await modelsDb.addCustomModel("openai", "gpt-old-chat", "Old chat", "imported");
    await modelsDb.addCustomModel(
      "openai",
      "whisper-imported",
      "Whisper",
      "imported",
      "audio-transcriptions",
      ["audio-transcriptions"]
    );

    // Synced rows reference a real connection (foreign key), so create one.
    const connection = await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "OpenAI media sync",
      apiKey: "openai-test-key",
    });
    const connectionId = String(connection.id);

    await importManagedModels({
      providerId: "openai",
      connectionId,
      mode: "sync",
      fetchedModels: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    });

    const stored = (await modelsDb.getCustomModels("openai")) as StoredModel[];
    assert.deepEqual(
      stored.map((model) => model.id),
      ["whisper-imported"]
    );
    assert.deepEqual(
      (await modelsDb.getSyncedAvailableModelsForConnection("openai", connectionId)).map(
        (model) => model.id
      ),
      ["gpt-5.6-sol"]
    );
  });

  test("sync still replaces an imported row stored with the synthetic chat default", async () => {
    // OpenAI image rows imported before endpoint metadata existed carry ["chat"];
    // they keep the old replace-on-sync behaviour instead of becoming permanent.
    await modelsDb.addCustomModel("openai", "gpt-image-1", "GPT Image 1", "imported");

    await importManagedModels({
      providerId: "openai",
      connectionId: "openai-synthetic-chat-conn",
      mode: "sync",
      fetchedModels: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    });

    const stored = (await modelsDb.getCustomModels("openai")) as StoredModel[];
    assert.equal(
      stored.some((model) => model.id === "gpt-image-1"),
      false
    );
  });

  test("self-hosted providers keep replacing every imported row, since their discovery is unfiltered", async () => {
    await modelsDb.addCustomModel(
      "ollama-local",
      "nomic-embed-text",
      "Nomic Embed",
      "imported",
      "embeddings",
      ["embeddings"]
    );

    await importManagedModels({
      providerId: "ollama-local",
      connectionId: "ollama-local-conn",
      mode: "sync",
      fetchedModels: [{ id: "llama3.3", name: "Llama 3.3" }],
    });

    const stored = (await modelsDb.getCustomModels("ollama-local")) as StoredModel[];
    assert.deepEqual(stored, []);
  });

  test("a pure-auto combo does not expand imported speech models into chat targets", async () => {
    await providersDb.createProviderConnection({
      provider: "soniox",
      authType: "apikey",
      name: "Soniox auto pool",
      apiKey: "soniox-test-key",
    });
    invalidateDbCache();

    const targets = await expandAutoComboCandidatePool([], { config: {} });

    assert.deepEqual(
      targets.filter((target) => target.providerId === "soniox").map((target) => target.modelStr),
      []
    );
  });
});

describe("noauth-models-route", () => {
  const LIVE_MODEL_LIST = [
    { id: "live-model-alpha", object: "model" },
    { id: "live-model-beta", object: "model" },
  ];

  before(resetStorage);

  // #3047 — a no-auth provider (originally OpenCode Free, now exercised through
  // uncloseai) has no connection row, so the
  // "Import from /models" button used to hit a 404 and silently no-op. The models
  // route must serve a non-empty model list when called with a no-auth provider id.
  // #3611 — the source may now be "upstream" (live fetch succeeded) or
  // "local_catalog" (live fetch failed/unavailable); both are acceptable here.
  test("models route serves models for a no-auth provider id (#3047)", async () => {
    const response = await providerModelsRoute.GET(
      new Request("http://localhost/api/providers/uncloseai/models?refresh=true"),
      { params: { id: "uncloseai" } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "uncloseai");
    assert.ok(
      body.source === "local_catalog" || body.source === "upstream",
      `source must be 'local_catalog' or 'upstream', got '${body.source}'`
    );
    assert.ok(Array.isArray(body.models) && body.models.length > 0, "should return catalog models");
    assert.ok(
      body.models.every((m: { id?: unknown }) => typeof m.id === "string" && m.id.length > 0),
      "every model must have a non-empty id"
    );
  });

  test("models route still 404s for an unknown provider/connection id", async () => {
    const response = await providerModelsRoute.GET(
      new Request("http://localhost/api/providers/does-not-exist-xyz/models"),
      { params: { id: "does-not-exist-xyz" } }
    );
    assert.equal(response.status, 404);
  });

  // #3611 — a noAuth provider with a modelsUrl (uncloseai) must fetch live models from the
  // provider's modelsUrl instead of always returning the stale local_catalog.
  test("models route fetches live models from modelsUrl for noAuth provider with modelsUrl (#3611)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL, _init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === "https://hermes.ai.unturf.com/v1/models") {
        return Response.json({ data: LIVE_MODEL_LIST });
      }
      return new Response("unexpected fetch: " + urlStr, { status: 500 });
    };

    try {
      const response = await providerModelsRoute.GET(
        new Request("http://localhost/api/providers/uncloseai/models"),
        { params: { id: "uncloseai" } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.provider, "uncloseai");
      assert.equal(
        body.source,
        "upstream",
        "should report source as 'upstream' when live fetch succeeds"
      );
      assert.ok(Array.isArray(body.models), "models should be an array");
      const ids = body.models.map((m: { id: string }) => m.id);
      assert.ok(ids.includes("live-model-alpha"), "should include live model alpha");
      assert.ok(ids.includes("live-model-beta"), "should include live model beta");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("metadata-only no-auth connection row still uses public model discovery", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "uncloseai",
      authType: "apikey",
      name: "uncloseai-metadata",
      isActive: true,
      testStatus: "unknown",
      providerSpecificData: {
        fingerprints: [{ id: "fingerprint-1" }],
        accountProxies: [],
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL) => {
      if (String(url) === "https://hermes.ai.unturf.com/v1/models") {
        return Response.json({ data: LIVE_MODEL_LIST });
      }
      return new Response("unexpected", { status: 500 });
    };

    try {
      const response = await providerModelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.provider, "uncloseai");
      assert.equal(body.connectionId, connection.id);
      assert.equal(body.source, "upstream");
      assert.ok(body.models.some((model: { id: string }) => model.id === "live-model-alpha"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("models route falls back to local_catalog when live modelsUrl fetch throws (#3611 fallback on error)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL, _init?: RequestInit) => {
      if (String(url) === "https://hermes.ai.unturf.com/v1/models") {
        throw new Error("network failure");
      }
      return new Response("unexpected", { status: 500 });
    };

    try {
      const response = await providerModelsRoute.GET(
        new Request("http://localhost/api/providers/uncloseai/models"),
        { params: { id: "uncloseai" } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.provider, "uncloseai");
      assert.equal(
        body.source,
        "local_catalog",
        "should fall back to local_catalog on fetch error"
      );
      assert.ok(Array.isArray(body.models) && body.models.length > 0, "should have catalog models");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("models route falls back to local_catalog when live modelsUrl fetch returns non-OK (#3611 fallback on non-OK)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string | URL, _init?: RequestInit) => {
      if (String(url) === "https://hermes.ai.unturf.com/v1/models") {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response("unexpected", { status: 500 });
    };

    try {
      const response = await providerModelsRoute.GET(
        new Request("http://localhost/api/providers/uncloseai/models"),
        { params: { id: "uncloseai" } }
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.provider, "uncloseai");
      assert.equal(
        body.source,
        "local_catalog",
        "should fall back to local_catalog when upstream returns non-OK"
      );
      assert.ok(Array.isArray(body.models) && body.models.length > 0, "should have catalog models");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("provider-model-output-vision-14337", () => {
  const models = modelsDb;
  const providers = providersDb;
  const overrides = capabilityOverrides;
  const route = providerModelsCrudRoute;
  const discovery = providerModelsRoute;

  beforeEach(async () => {
    await resetStorage();
    globalThis.fetch = async () => {
      throw new Error("Unexpected external request");
    };
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });
  const request = (body: Record<string, unknown>, method = "PUT") =>
    new Request("http://localhost/api/provider-models", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const put = (value: unknown, provider = "openai", modelId = "gpt-4o") =>
    route.PUT(request({ provider, modelId, maxOutputTokenOverride: value }));

  test("synced models save an output override consumed by runtime without creating a custom row", async () => {
    const response = await put(4096);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).maxOutputTokenOverride, 4096);
    assert.equal(
      await overrides.getModelCapabilityOverride("openai", "gpt-4o", "max_output_tokens"),
      4096
    );
    assert.equal(await overrides.getModelCapabilityOverride("openai", "gpt-4o", "max_token"), null);
    assert.equal(await getExplicitModelOutputCap({ provider: "openai", model: "gpt-4o" }), 4096);
    const capped = enforceOutputTokenBudget(
      { max_tokens: 16000, max_completion_tokens: 16000, max_output_tokens: 16000 },
      100,
      128000,
      0,
      await getExplicitModelOutputCap({ provider: "openai", model: "gpt-4o" })
    );
    assert.equal(capped.ok, true);
    if (capped.ok)
      assert.deepEqual(capped.body, {
        max_tokens: 4096,
        max_completion_tokens: 4096,
        max_output_tokens: 4096,
      });
    assert.deepEqual(await models.getCustomModels("openai"), []);
  });

  test("GET returns provider-scoped output overrides for synced and custom rows", async () => {
    const staleRow = { id: "custom-14337", name: "Custom", maxOutputTokenOverride: 99999 };
    await models.replaceCustomModels("openai", [staleRow]);
    await contextOverrides.setModelContextOverride("openai", "custom-14337", 128000, "manual");
    await overrides.setModelCapabilityOverride("openai/gpt-4o", "max_output_tokens", 4096);
    await overrides.setModelCapabilityOverride("openai/custom-14337", "max_output_tokens", 2048);
    await overrides.setModelCapabilityOverride("anthropic/other", "max_output_tokens", 1024);
    await overrides.setModelCapabilityOverride("openai/gpt-4o", "max_input_tokens", 64000);
    const response = await route.GET(
      new Request("http://localhost/api/provider-models?provider=openai")
    );
    const body = await response.json();
    assert.deepEqual(
      body.modelOutputOverrides
        ?.map((row: { modelId: string; maxOutputTokenOverride: number }) => [
          row.modelId,
          row.maxOutputTokenOverride,
        ])
        .sort(),
      [
        ["custom-14337", 2048],
        ["gpt-4o", 4096],
      ]
    );
    assert.equal(
      body.models.find((row: { id: string }) => row.id === "custom-14337")?.maxOutputTokenOverride,
      2048
    );
  });

  test("clearing the override restores the runtime catalog default", async () => {
    const original = await getExplicitModelOutputCap({ provider: "openai", model: "gpt-4o" });
    await overrides.setModelCapabilityOverride("openai/gpt-4o", "max_output_tokens", 1234);
    const response = await put(null);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).maxOutputTokenOverride, null);
    assert.equal(
      await overrides.getModelCapabilityOverride("openai", "gpt-4o", "max_output_tokens"),
      null
    );
    assert.equal(
      await getExplicitModelOutputCap({ provider: "openai", model: "gpt-4o" }),
      original
    );
  });

  test("re-sync preserves an operator output override", async () => {
    assert.equal((await put(4096)).status, 200);
    await models.replaceSyncedAvailableModelsForConnection("openai", "synthetic-sync", [
      { id: "gpt-4o", name: "Changed upstream name", outputTokenLimit: 99999 },
    ]);
    assert.equal(await getExplicitModelOutputCap({ provider: "openai", model: "gpt-4o" }), 4096);
  });

  test("invalid values cannot overwrite an existing output override", async () => {
    await overrides.setModelCapabilityOverride("openai/gpt-4o", "max_output_tokens", 2048);
    for (const invalid of [0, -1, 1.5, "1024", true]) {
      assert.equal((await put(invalid)).status, 400, `Reject ${JSON.stringify(invalid)}`);
      assert.equal(
        await overrides.getModelCapabilityOverride("openai", "gpt-4o", "max_output_tokens"),
        2048
      );
    }
  });

  test("unknown providers leave no output override behind", async () => {
    assert.equal((await put(2048, "not-a-provider-14337")).status, 400);
    assert.equal(
      await overrides.getModelCapabilityOverride(
        "not-a-provider-14337",
        "gpt-4o",
        "max_output_tokens"
      ),
      null
    );
  });

  test("custom creation still accepts max_output_tokens independently of the override", async () => {
    const response = await route.POST(
      request(
        { provider: "openai-compatible-output-test", modelId: "custom", max_output_tokens: 8192 },
        "POST"
      )
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await models.getCustomModels("openai-compatible-output-test"))[0]?.outputTokenLimit,
      8192
    );
  });

  test("provider union catalog exposes positive synced vision without promoting false or unknown", async () => {
    const connection = await providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "synthetic-reader",
      apiKey: "synthetic-only",
      isActive: true,
      providerSpecificData: { autoFetchModels: false },
    });
    // connection_model_sync has a foreign key to provider_connections: a sync for an
    // id that is not a real connection is dropped, so the sibling must exist.
    const sibling = await providers.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "synthetic-sibling",
      apiKey: "synthetic-sibling-only",
      isActive: true,
    });
    await models.replaceSyncedAvailableModelsForConnection("openai", sibling.id, [
      { id: "vision-14337", name: "Vision", supportsVision: true },
      { id: "text-14337", name: "Text", supportsVision: false },
      { id: "unknown-14337", name: "Unknown" },
    ]);
    const response = await discovery.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models`),
      { params: { id: connection.id } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.models.find((row: { id: string }) => row.id === "vision-14337")?.supportsVision,
      true
    );
    assert.equal(
      body.models.find((row: { id: string }) => row.id === "text-14337")?.supportsVision,
      undefined
    );
    assert.equal(
      Object.hasOwn(
        body.models.find((row: { id: string }) => row.id === "unknown-14337"),
        "supportsVision"
      ),
      false
    );
  });
});

describe("provider-sweep-live-discovery", () => {
  /**
   * TDD regression for the provider-model-sweep (2026-06-19): seven providers were
   * classified as "fixed-official" in the registry (their `models[]` is a small
   * hardcoded seed), yet each exposes a real OpenAI-style `/models` endpoint that
   * serves a much larger, constantly-changing live catalog. The correct fix mirrors
   * #4249 (vercel-ai-gateway), #4202 (zenmux) and #3976 (llm7/byteplus): add the
   * provider to NAMED_OPENAI_STYLE_PROVIDERS so the import route does a live
   * `<baseUrl>/models` fetch, keeping the small registry seed only as the offline
   * fallback.
   *
   * Each case below pins the exact `/models` URL the route derives after stripping
   * `/chat/completions` (and a trailing `/v1`) from the registry baseUrl.
   */
  interface ModelsBody {
    provider: string;
    connectionId: string;
    models: Array<{ id: string }>;
    source?: string;
  }

  // provider → the upstream /models URL the route resolves from its registry baseUrl.
  const LIVE_CASES: Array<{ provider: string; liveUrl: string; source?: string }> = [
    { provider: "venice", liveUrl: "https://api.venice.ai/api/v1/models" },
    { provider: "deepinfra", liveUrl: "https://api.deepinfra.com/v1/openai/models" },
    { provider: "wandb", liveUrl: "https://api.inference.wandb.ai/v1/models" },
    { provider: "pollinations", liveUrl: "https://gen.pollinations.ai/v1/models" },
    { provider: "nscale", liveUrl: "https://inference.api.nscale.com/v1/models" },
    { provider: "inference-net", liveUrl: "https://api.inference.net/v1/models" },
    { provider: "moonshot", liveUrl: "https://api.moonshot.ai/v1/models" },
    // GPU-cloud / aggregator marketplaces (sweep cont.).
    { provider: "crof", liveUrl: "https://crof.ai/v1/models" },
    { provider: "featherless-ai", liveUrl: "https://api.featherless.ai/v1/models" },
    { provider: "ovhcloud", liveUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models" },
    { provider: "sambanova", liveUrl: "https://api.sambanova.ai/v1/models" },
    { provider: "orcarouter", liveUrl: "https://api.orcarouter.ai/v1/models" },
    {
      provider: "uncloseai",
      liveUrl: "https://hermes.ai.unturf.com/v1/models",
      source: "upstream",
    },
    { provider: "opencode-go", liveUrl: "https://opencode.ai/zen/go/v1/models" },
    { provider: "baseten", liveUrl: "https://inference.baseten.co/v1/models" },
    { provider: "hyperbolic", liveUrl: "https://api.hyperbolic.xyz/v1/models" },
    { provider: "nebius", liveUrl: "https://api.tokenfactory.nebius.com/v1/models" },
    { provider: "scaleway", liveUrl: "https://api.scaleway.ai/v1/models" },
    { provider: "together", liveUrl: "https://api.together.xyz/v1/models" },
    // escalated cmqlvxg4o: api-airforce carries a real live `https://api.airforce/v1/models`
    // catalog but was left out of the sweep, so it served its stale hardcoded seed
    // (grok-3, grok-2-1212, claude-3.7-sonnet …) — models that no longer exist upstream,
    // so chat failed even though the connection test passed. Same class as the rows above.
    { provider: "api-airforce", liveUrl: "https://api.airforce/v1/models" },
  ];

  for (const { provider, liveUrl, source = "api" } of LIVE_CASES) {
    test(`sweep: ${provider} import fetches the live /models catalog`, async () => {
      await resetStorage();
      const connection = await providersDb.createProviderConnection({
        provider,
        authType: "apikey",
        name: `${provider}-live`,
        apiKey: "sweep-key",
      });

      let fetched = false;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url) === liveUrl) {
          fetched = true;
          return Response.json({
            object: "list",
            data: [{ id: `${provider}-live-a` }, { id: `${provider}-live-b` }],
          });
        }
        // Bogus probe variants (…/v1/v1/models, …/chat/completions/models) → 404.
        return new Response("not found", { status: 404 });
      };

      try {
        const response = await providerModelsRoute.GET(
          new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
          { params: { id: connection.id } }
        );
        assert.equal(response.status, 200);
        const body = (await response.json()) as ModelsBody;
        assert.equal(body.provider, provider);
        assert.ok(fetched, `should have probed ${liveUrl}`);
        assert.equal(
          body.source,
          source,
          "should serve the live upstream catalog, not local_catalog"
        );
        const ids = body.models.map((m) => m.id);
        assert.ok(
          ids.includes(`${provider}-live-a`) && ids.includes(`${provider}-live-b`),
          `live models missing from catalog: ${ids.join(",")}`
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test("sweep: live-discovery providers fall back to the local seed when upstream is down", async () => {
    await resetStorage();
    const connection = await providersDb.createProviderConnection({
      provider: "venice",
      authType: "apikey",
      name: "venice-fallback",
      apiKey: "sweep-key-2",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

    try {
      const response = await providerModelsRoute.GET(
        new Request(`http://localhost/api/providers/${connection.id}/models?refresh=true`),
        { params: { id: connection.id } }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as ModelsBody;
      assert.equal(body.provider, "venice");
      assert.equal(body.source, "local_catalog", "import must not break when upstream is down");
      assert.ok(body.models.length > 0, "fallback seed should be non-empty");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("static-only-discovery-warning-16687", () => {
  const noAdapterWarning =
    "Model discovery is not configured for this provider — using local catalog";

  async function connection(provider: string) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider} test`,
      apiKey: "test-only-key",
      isActive: true,
      providerSpecificData: { autoFetchModels: true },
    });
  }
  function refresh(id: string) {
    return providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${id}/models?refresh=true`),
      {
        params: { id },
      }
    );
  }

  beforeEach(resetStorage);

  for (const provider of ["ideogram", "grok-web"]) {
    test(`${provider} static-only refresh identifies missing discovery without an upstream call`, async () => {
      assert.equal(getDiscoveryClass(provider), "static-only");
      const stored = await connection(provider);
      let fetches = 0;
      globalThis.fetch = async () => {
        fetches++;
        return new Response("unexpected", { status: 500 });
      };
      const response = await refresh(stored.id);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.source, "local_catalog");
      assert.equal(body.intentional, true);
      assert.ok(body.models.length > 0);
      assert.equal(fetches, 0);
      assert.equal(body.warning, noAdapterWarning);
      assert.equal(extractImportWarning(body), noAdapterWarning);
      assert.equal(isDegradedDiscovery(body), false);
      assert.equal(
        classifyModelImport({
          modelsData: body,
          fetchedModels: body.models,
          isKnownModel: () => true,
        }).degraded,
        false
      );
    });
  }

  test("configured discovery failure retains its API-unavailable warning", async () => {
    const stored = await connection("openai");
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response("upstream unavailable", { status: 500 });
    };
    const response = await refresh(stored.id);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.ok(urls.length > 0);
    assert.ok(urls.every((url) => url === "https://api.openai.com/v1/models"));
    assert.match(body.warning, /API unavailable/);
    assert.notEqual(body.intentional, true);
    assert.equal(isDegradedDiscovery(body), true);
  });

  test("configured successful discovery remains live and warning-free", async () => {
    const stored = await connection("openai");
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return Response.json({ data: [{ id: "gpt-4.1", object: "model" }] });
    };
    const response = await refresh(stored.id);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "api");
    assert.deepEqual(urls, ["https://api.openai.com/v1/models"]);
    assert.ok(body.models.some((model: { id: string }) => model.id === "gpt-4.1"));
    assert.equal(body.warning, undefined);
    assert.equal(extractImportWarning(body), null);
    assert.equal(isDegradedDiscovery(body), false);
  });
});

describe("provider-models-upstream-unreachable-4843", () => {
  async function seedConnection(provider: string, apiKey: string) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { autoFetchModels: true },
    });
  }

  async function callRoute(connectionId: string) {
    return providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models`),
      { params: { id: connectionId } }
    );
  }

  function networkFailure(code: string) {
    return Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(`connect ${code} 203.0.113.7:443`), { code }),
    });
  }

  function assertNoLeak(raw: string) {
    assert.doesNotMatch(raw, /\n\s+at\s/, "response must not carry a stack trace");
    assert.doesNotMatch(raw, /"stack"|"cause"/, "response must not carry stack/cause fields");
    assert.doesNotMatch(raw, /203\.0\.113\.7/, "response must not carry the raw socket cause");
  }

  beforeEach(resetStorage);

  test("#4843 unreachable upstream without a fallback catalog answers 502 UPSTREAM_UNREACHABLE", async () => {
    // clarifai has a remote /models endpoint and no registry/static catalog,
    // so a network failure has nothing to degrade to.
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "CERT_HAS_EXPIRED"]) {
      const connection = await seedConnection("clarifai", "clarifai-key");
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        throw networkFailure(code);
      };

      const response = await callRoute(connection.id);
      const raw = await response.text();

      assert.ok(calls >= 1, `${code}: upstream should have been attempted`);
      assert.equal(response.status, 502, `${code}: expected 502, got ${response.status} ${raw}`);
      const body = JSON.parse(raw);
      assert.equal(body.code, "UPSTREAM_UNREACHABLE");
      assert.match(body.error, /^Failed to fetch models/);
      assertNoLeak(raw);
    }
  });

  test("#4843 upstream timeout without a fallback catalog still answers 504", async () => {
    const connection = await seedConnection("clarifai", "clarifai-key");
    globalThis.fetch = async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    };

    const response = await callRoute(connection.id);
    const raw = await response.text();

    assert.equal(response.status, 504, raw);
    assert.ok(JSON.parse(raw).error);
    assertNoLeak(raw);
  });

  test("#4843 timeout response does not echo the query-string API key", async () => {
    // gemini passes the key as `?key=` — the timeout message embeds the URL.
    const connection = await seedConnection("gemini", "gm-secret-4843");
    globalThis.fetch = async () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    };

    const response = await callRoute(connection.id);
    const raw = await response.text();

    assert.equal(response.status, 504, raw);
    assert.doesNotMatch(raw, /gm-secret-4843/);
    assertNoLeak(raw);
  });

  test("#4843 unreachable upstream still degrades to the local catalog when one exists", async () => {
    const connection = await seedConnection("groq", "groq-key");
    globalThis.fetch = async () => {
      throw networkFailure("ECONNREFUSED");
    };

    const response = await callRoute(connection.id);
    const body = (await response.json()) as {
      source?: string;
      warning?: string;
      models?: unknown[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.match(String(body.warning), /local catalog/i);
    assert.ok(Array.isArray(body.models));
    assert.notEqual(body.models.length, 0);
  });
});

describe("perplexity-agent-provider", () => {
  const AGENT_RESPONSES_URL = "https://api.perplexity.ai/v1/responses";
  const AGENT_MODELS_URL = "https://api.perplexity.ai/v1/models";
  const AGENT_CONNECTION_ID = "perplexity-agent-live-catalog-test";
  const DOCUMENTED_AGENT_MODEL_IDS = [
    "anthropic/claude-fable-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-opus-4-7",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-opus-4-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.5",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.4-nano",
    "openai/gpt-5.2",
    "openai/gpt-5.1",
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.1-flash-lite",
    "google/gemini-3.5-flash",
    "google/gemini-3.5-flash-lite",
    "google/gemini-3.6-flash",
    "google/gemini-3.7-flash",
    "google/gemini-3-flash-preview",
    "xai/grok-4.6",
    "xai/grok-4.5",
    "xai/grok-4.3",
    "xai/grok-4.20-reasoning",
    "xai/grok-4.20-non-reasoning",
    "xai/grok-4.20-multi-agent",
    "perplexity/deepseek-v4-flash-0731",
    "perplexity/glm-5.2",
    "perplexity/glm-5.3",
    "perplexity/kimi-k3",
    "perplexity/kimi-k2.7-code",
    "perplexity/nemotron-3.5-lightning-30b-a3b",
    "perplexity/nemotron-3-ultra-550b-a55b",
    "perplexity/sonar",
  ] as const;

  before(resetStorage);

  async function seedOneItemAgentLiveCatalog() {
    const now = new Date().toISOString();
    await getTestBackend().execute(
      `INSERT INTO provider_connections
       (id, provider, is_active, created_at, updated_at)
     VALUES ($1, $2, true, $3, $4)
     ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, is_active = true,
       updated_at = EXCLUDED.updated_at`,
      [AGENT_CONNECTION_ID, "perplexity-agent", now, now]
    );

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "perplexity-agent",
      AGENT_CONNECTION_ID,
      [
        {
          id: "openai/gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          source: "imported",
        },
      ]
    );
  }

  test("perplexity-agent registry entry uses Responses format with passthrough models", () => {
    const entry = REGISTRY["perplexity-agent"];

    assert.ok(entry, "REGISTRY['perplexity-agent'] must be defined");
    assert.equal(entry.id, "perplexity-agent");
    assert.equal(entry.alias, "pplx-agent");
    assert.equal(entry.format, "openai-responses");
    assert.equal(entry.executor, "default");
    assert.equal(entry.baseUrl, AGENT_RESPONSES_URL);
    assert.equal(entry.modelsUrl, AGENT_MODELS_URL);
    assert.equal(entry.testKeyModelsUrl, AGENT_MODELS_URL);
    assert.equal(entry.authType, "apikey");
    assert.equal(entry.authHeader, "bearer");
    assert.equal(entry.passthroughModels, true);
    assert.equal(entry.liveCatalogAuthoritative, false);
    assert.equal(providerUsesAuthoritativeLiveCatalog("perplexity-agent"), false);
    assert.equal(providerUsesAuthoritativeLiveCatalog("pplx-agent"), false);
  });

  test("perplexity-agent is available from the canonical API-key provider catalog", () => {
    const entry = APIKEY_PROVIDERS["perplexity-agent"];

    assert.ok(entry, "APIKEY_PROVIDERS['perplexity-agent'] must be defined");
    assert.equal(entry.id, "perplexity-agent");
    assert.equal(entry.alias, "pplx-agent");
    assert.equal(entry.name, "Perplexity Agent");
    assert.equal(entry.icon, "search");
    assert.equal(entry.color, "#20808D");
    assert.equal(entry.textIcon, "PA");
    assert.equal(entry.website, "https://www.perplexity.ai");
    assert.equal(entry.passthroughModels, true);
    assert.equal(AI_PROVIDERS["perplexity-agent"], entry);
    assert.equal(getProviderById("perplexity-agent"), entry);
    assert.equal(getProviderByAlias("pplx-agent"), entry);
  });

  test("perplexity-agent exposes minimal starter models without duplicating live discovery", () => {
    const entry = REGISTRY["perplexity-agent"];
    const ids = new Set(entry.models.map((model) => model.id));

    assert.deepEqual([...ids].sort(), ["openai/gpt-5.6-sol", "perplexity/kimi-k3"].sort());
    assert.equal(entry.models.length, 2);
    assert.ok(entry.models.some((model) => model.id === "openai/gpt-5.6-sol"));
    assert.ok(entry.models.some((model) => model.id === "perplexity/kimi-k3"));
  });

  test("pplx-agent prefix preserves raw slash-containing Agent API model IDs", async () => {
    const info = await getModelInfo("pplx-agent/openai/gpt-5.6-sol");

    assert.equal(info.provider, "perplexity-agent");
    assert.equal(info.model, "openai/gpt-5.6-sol");
  });

  test("pplx-agent keeps unseen slash-containing Agent API IDs routable after live sync", async () => {
    await seedOneItemAgentLiveCatalog();

    const info = await getModelInfo("pplx-agent/future/labs/model-alpha");

    assert.equal(info.provider, "perplexity-agent");
    assert.equal(info.model, "future/labs/model-alpha");
  });

  test("perplexity-agent default executor dispatches to Perplexity Responses endpoint", () => {
    const executor = new DefaultExecutor("perplexity-agent");

    assert.equal(executor.buildUrl("openai/gpt-5.6-sol", false, 0, null), AGENT_RESPONSES_URL);
  });

  test("Perplexity API executors send the OmniRoute integration header", () => {
    for (const provider of ["perplexity", "perplexity-agent"]) {
      const headers = new DefaultExecutor(provider).buildHeaders({ apiKey: "pplx-test" }, false);

      assert.equal(headers["X-Pplx-Integration"], "omniroute", provider);
      assert.equal(headers.Authorization, "Bearer pplx-test", provider);
    }
  });

  test("perplexity-agent defaults max_output_tokens when Agent requests omit token fields", () => {
    const executor = new DefaultExecutor("perplexity-agent");
    const explicit = executor.transformRequest(
      "anthropic/claude-opus-4-5",
      { model: "anthropic/claude-opus-4-5", input: "hi", max_output_tokens: 32 },
      false,
      null
    ) as Record<string, unknown>;
    const defaulted = executor.transformRequest(
      "anthropic/claude-opus-4-5",
      { model: "anthropic/claude-opus-4-5", input: "hi" },
      false,
      null
    ) as Record<string, unknown>;
    const kimiAgent = executor.transformRequest(
      "perplexity/kimi-k3",
      { model: "perplexity/kimi-k3", input: "hi" },
      false,
      null
    ) as Record<string, unknown>;
    const futureAgent = executor.transformRequest(
      "future-lab/model-alpha-1",
      { model: "future-lab/model-alpha-1", input: "hi" },
      false,
      null
    ) as Record<string, unknown>;

    assert.equal(explicit.max_output_tokens, 32);
    assert.equal(defaulted.max_output_tokens, 4096);
    assert.equal(kimiAgent.max_output_tokens, 4096);
    assert.equal(futureAgent.max_output_tokens, 4096);
  });

  test("perplexity-agent model discovery accepts documented and future Agent API model IDs", async () => {
    const { id } = (await providersDb.createProviderConnection({
      provider: "perplexity-agent",
      authType: "apikey",
      name: "valid Perplexity Agent key",
      apiKey: "pplx-valid-test-key",
      isActive: true,
    })) as { id?: unknown };
    assert.equal(typeof id, "string");

    const originalFetch = globalThis.fetch;
    const futureModelId = "future-lab/model-alpha-1";
    const upstreamModelIds = [...DOCUMENTED_AGENT_MODEL_IDS, futureModelId];
    let upstreamUrl: string | null = null;
    let upstreamAuthorization: string | null = null;
    globalThis.fetch = (async (input, init) => {
      upstreamUrl =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      upstreamAuthorization = new Headers(init?.headers).get("authorization");

      return new Response(
        JSON.stringify({
          object: "list",
          data: upstreamModelIds.map((modelId) => ({
            id: modelId,
            object: "model",
            owned_by: "perplexity-agent",
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof globalThis.fetch;

    try {
      const { GET } = providerModelsRoute;
      const response = await GET(
        new Request(`http://localhost/api/providers/${id}/models?refresh=true`),
        { params: { id } }
      );
      const body = (await response.json()) as { models?: Array<{ id?: string }> };
      const modelIds = (body.models ?? []).map((model) => model.id);

      assert.equal(response.status, 200);
      assert.equal(upstreamUrl, AGENT_MODELS_URL);
      assert.equal(upstreamAuthorization, "Bearer pplx-valid-test-key");
      for (const modelId of upstreamModelIds) {
        assert.ok(modelIds.includes(modelId), `expected discovered catalog to include ${modelId}`);
      }

      const futureInfo = await getModelInfo(`pplx-agent/${futureModelId}`);
      assert.equal(futureInfo.provider, "perplexity-agent");
      assert.equal(futureInfo.model, futureModelId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("existing Perplexity Sonar provider remains unchanged", () => {
    const entry = REGISTRY.perplexity;

    assert.ok(entry, "REGISTRY.perplexity must remain defined");
    assert.equal(entry.id, "perplexity");
    assert.equal(entry.alias, "pplx");
    assert.equal(entry.format, "openai");
    assert.equal(entry.baseUrl, "https://api.perplexity.ai/chat/completions");
    assert.equal(entry.testKeyModelsUrl, AGENT_MODELS_URL);
  });
});
