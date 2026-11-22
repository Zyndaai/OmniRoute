// Provider models route: Codex discovery (client-version compatibility, live/GitHub/cache
// catalogs), user-added custom model merging and the LAN/SSRF guard. Merged from four files so
// the heavy `src/app/api/providers/[id]/models/route.ts` module graph loads once; each original
// file is one `describe` below, named after the file it came from.
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";

import {
  clearCodexClientVersionCache,
  getCodexClientVersion,
  resetCodexClientVersionCacheForTests,
} from "../../../open-sse/config/codexClient.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pm-codex-guards-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { setSafeOutboundPinnedFetchTestOverride } =
  await import("../../../src/shared/network/safeOutboundFetch.ts");
const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const providerModelsRoute = await import("../../../src/app/api/providers/[id]/models/route.ts");
const codexDiscovery =
  await import("../../../src/app/api/providers/[id]/models/discovery/codex.ts");
const { createCodexCatalogReconciler } =
  await import("../../../src/app/api/providers/[id]/models/discovery/codexRoute.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const outboundUrlGuard = await import("../../../src/shared/network/outboundUrlGuard.ts");
const outboundUrlGuardPolicy =
  await import("../../../src/shared/network/outboundUrlGuardPolicy.ts");

const originalFetch = globalThis.fetch;

// Every describe starts (and, where the source had a beforeEach, every test starts) from an
// empty database and data dir with the real fetch restored and the Codex GitHub cache cleared.
async function resetStorage() {
  globalThis.fetch = originalFetch;
  codexDiscovery.clearCodexGithubCatalogCacheForTests();
  await core.resetDbInstance();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  globalThis.fetch = originalFetch;
  codexDiscovery.clearCodexGithubCatalogCacheForTests();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("provider-models-codex-compatibility", () => {
  const originalVersion = process.env.CODEX_CLIENT_VERSION;

  type Body = {
    source: string;
    warning?: string;
    models: { id: string }[];
    candidateModels?: { id: string; compatibilityReason?: string }[];
  };

  const future = {
    slug: "future-model",
    visibility: "list",
    supported_in_api: true,
    minimal_client_version: "0.200.0",
  };
  const compatible = { slug: "account-model", visibility: "list", supported_in_api: true };

  function matchesFetchHostname(input: Parameters<typeof fetch>[0], hostname: string): boolean {
    const url = input instanceof Request ? input.url : input;
    return new URL(url).hostname === hostname;
  }

  async function seed() {
    const connection = await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "compatibility-fixture",
      accessToken: "fixture-access-token",
      isActive: true,
      testStatus: "active",
      providerSpecificData: { autoFetchModels: true },
    });
    assert.ok(connection && typeof connection.id === "string");
    return connection.id;
  }

  async function get(id: string, query = "?refresh=true&includeCandidates=true") {
    const response = await providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${id}/models${query}`),
      {
        params: { id },
      }
    );
    assert.equal(response.status, 200);
    return (await response.json()) as Body;
  }

  beforeEach(async () => {
    process.env.CODEX_CLIENT_VERSION = "0.160.1";
    resetCodexClientVersionCacheForTests();
    clearCodexClientVersionCache();
    await resetStorage();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalVersion === undefined) delete process.env.CODEX_CLIENT_VERSION;
    else process.env.CODEX_CLIENT_VERSION = originalVersion;
    resetCodexClientVersionCacheForTests();
    clearCodexClientVersionCache();
  });

  test("successful account discovery does not warn about public-only newer models", async () => {
    const id = await seed();
    globalThis.fetch = async (url) =>
      Response.json({
        models: matchesFetchHostname(url, "raw.githubusercontent.com")
          ? [compatible, future]
          : [compatible],
      });
    const body = await get(id);
    assert.equal(body.source, "api");
    assert.deepEqual(
      body.models.map((model) => model.id),
      [compatible.slug]
    );
    assert.equal(body.warning, undefined);
    assert.deepEqual(body.candidateModels, []);
  });

  test("live version candidates keep their warning when the GitHub catalog is unavailable", async () => {
    const id = await seed();
    globalThis.fetch = async (url) =>
      matchesFetchHostname(url, "raw.githubusercontent.com")
        ? new Response("fixture unavailable", { status: 503 })
        : Response.json({ models: [compatible, future] });
    const body = await get(id);
    assert.equal(body.source, "api");
    assert.deepEqual(
      body.models.map((model) => model.id),
      [compatible.slug]
    );
    assert.match(body.warning || "", /future-model.*OmniRoute reports 0\.160\.1.*0\.200\.0/);
    assert.equal(body.candidateModels?.[0]?.compatibilityReason, "requires-newer-client");
  });

  test("all-too-new live inventory stays empty and explains the required version", async () => {
    const id = await seed();
    globalThis.fetch = async (url) =>
      matchesFetchHostname(url, "raw.githubusercontent.com")
        ? Response.json({ models: [compatible] })
        : Response.json({ models: [future] });
    const body = await get(id);
    assert.equal(body.source, "api");
    assert.deepEqual(body.models, []);
    assert.match(body.warning || "", /future-model.*CODEX_CLIENT_VERSION=0\.200\.0/);
  });

  test("GitHub fallback explains version candidates without warning about retired or unsupported entries", async () => {
    const id = await seed();
    globalThis.fetch = async (url) =>
      matchesFetchHostname(url, "raw.githubusercontent.com")
        ? Response.json({
            models: [
              future,
              { ...future, slug: "gpt-5.3-codex-spark", minimal_client_version: "999.0.0" },
              { ...future, slug: "hidden-model", visibility: "hide" },
              { ...future, slug: "unsupported-model", supported_in_api: false },
              { slug: "unspecified-model", minimal_client_version: "not-a-version" },
            ],
          })
        : new Response("fixture unavailable", { status: 503 });
    const body = await get(id);
    assert.equal(body.source, "github_catalog");
    assert.deepEqual(body.models, []);
    assert.match(body.warning || "", /using GitHub model catalog.*future-model.*0\.200\.0/);
    // Picker visibility does not revoke API compatibility: hidden, API-supported
    // candidates still need the newer client profile, just like listed models.
    assert.match(body.warning || "", /hidden-model/);
    assert.doesNotMatch(
      body.warning || "",
      /gpt-5\.3-codex-spark|unsupported-model|unspecified-model|999\.0\.0/
    );
  });

  test("GitHub TTL cache diagnostics are recomputed after the effective version changes", async () => {
    const id = await seed();
    let githubRequests = 0;
    globalThis.fetch = async (url) => {
      if (!matchesFetchHostname(url, "raw.githubusercontent.com"))
        return new Response("fixture unavailable", { status: 503 });
      githubRequests += 1;
      return Response.json({ models: [future] }, { headers: { etag: '"fixture-catalog"' } });
    };
    const before = await get(id);
    assert.match(before.warning || "", /future-model.*0\.160\.1/);
    process.env.CODEX_CLIENT_VERSION = "0.200.0";
    const after = await get(id);
    assert.equal(after.source, "github_catalog");
    assert.deepEqual(
      after.models.map((model) => model.id),
      [future.slug]
    );
    assert.doesNotMatch(after.warning || "", /Skipped|0\.160\.1/);
    assert.equal(githubRequests, 1);
  });

  test("cached account inventory retains precedence over a public-only future model", async () => {
    const id = await seed();
    globalThis.fetch = async (url) =>
      matchesFetchHostname(url, "raw.githubusercontent.com")
        ? Response.json({ models: [future] })
        : Response.json({ models: [compatible] });
    assert.equal((await get(id)).models.length, 1);
    globalThis.fetch = async () => new Response("fixture unavailable", { status: 503 });
    const body = await get(id);
    assert.equal(body.source, "cache");
    assert.deepEqual(
      body.models.map((model) => model.id),
      [compatible.slug]
    );
    assert.match(body.warning || "", /using cached catalog/);
    assert.doesNotMatch(body.warning || "", /Skipped|future-model/);
  });

  test("route discovery refreshes the client version before classifying and warning", async (t) => {
    const id = await seed();
    delete process.env.CODEX_CLIENT_VERSION;
    t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
    setSafeOutboundPinnedFetchTestOverride(() => (url, init) => globalThis.fetch(url, init));
    t.after(() => setSafeOutboundPinnedFetchTestOverride(undefined));
    let registryRequests = 0;
    globalThis.fetch = async (url) => {
      if (matchesFetchHostname(url, "registry.npmjs.org")) {
        registryRequests += 1;
        return Response.json({ name: "@openai/codex", version: "0.999.0" });
      }
      if (matchesFetchHostname(url, "raw.githubusercontent.com"))
        return new Response("fixture unavailable", { status: 503 });
      assert.equal(new URL(String(url)).searchParams.get("client_version"), "0.999.0");
      return Response.json({ models: [{ ...future, minimal_client_version: "0.999.1" }] });
    };
    const body = await get(id);
    assert.equal(registryRequests, 1);
    assert.equal(body.source, "api");
    assert.match(body.warning || "", /OmniRoute reports 0\.999\.0.*0\.999\.1/);
  });

  test("warning uses the highest numeric version and bounds the displayed model list", () => {
    const models = codexDiscovery.normalizeCodexModelsResponse({
      models: [
        { ...future, slug: "first", minimal_client_version: "1.9.0" },
        { ...future, slug: "second", minimal_client_version: "1.10.0" },
        { ...future, slug: "third", minimal_client_version: "1.3.0" },
        { ...future, slug: "fourth", minimal_client_version: "1.2.0" },
      ],
    });
    const catalog = createCodexCatalogReconciler([], "safe")(models, "github", "Fallback context.");
    assert.equal(catalog.candidateModels.length, 4);
    assert.match(
      catalog.warning || "",
      /Fallback context.*first, second, third, and 1 more.*at least 1\.10\.0/
    );
    assert.doesNotMatch(catalog.warning || "", /fourth/);
    assert.match(
      catalog.warning || "",
      /Installing Codex CLI is only relevant to the separate codex-app-server provider/
    );
  });

  // #15306: the same matcher used by route mocks must not recognize hostnames in URL data.
  for (const hostname of ["raw.githubusercontent.com", "registry.npmjs.org"]) {
    test(`fetch fixture recognizes the exact ${hostname} host for every fetch input`, () => {
      const url = `https://${hostname}/fixture.json`;
      for (const input of [url, new URL(url), new Request(url)]) {
        assert.equal(matchesFetchHostname(input, hostname), true);
      }
    });

    for (const url of [
      `https://${hostname}.evil.invalid/fixture.json`,
      `https://evil-${hostname}/fixture.json`,
      `https://evil.invalid/${hostname}/fixture.json`,
      `https://evil.invalid/?next=${hostname}`,
      `https://${hostname}@evil.invalid/fixture.json`,
    ]) {
      test(`fetch fixture rejects a hostname embedded in ${url}`, () => {
        const parsed = new URL(url);
        const inputs: Parameters<typeof fetch>[0][] = [url, parsed];
        if (!parsed.username && !parsed.password) inputs.push(new Request(url));
        for (const input of inputs) {
          assert.equal(matchesFetchHostname(input, hostname), false);
        }
      });
    }
  }

  test("fetch fixture fails explicitly for malformed URLs", () => {
    assert.throws(() => matchesFetchHostname("not a URL", "raw.githubusercontent.com"), TypeError);
  });
});

describe("provider-models-custom-merge-6247", () => {
  // #6247 regression guard — the per-connection /api/providers/[id]/models route
  // (used by MCP list_models_catalog + the dashboard import view) must include
  // USER-ADDED custom models, not just the static/discovered catalog.
  //
  // Root cause: the route never read getCustomModels(provider) (custom models live
  // in key_value namespace `customModels`), so the live REST /api/v1/models merged
  // them but the per-connection route did not — on both the local_catalog and the
  // discovery-success paths. Fix: merge getCustomModels(provider) (dedup by id,
  // owned_by: provider) into the route's returned model list.
  //
  // Harness copied (minimal) from tests/unit/provider-models-route.test.ts — the
  // frozen file's own note says the seedConnection/callRoute harness is not
  // separately extractable, so a small local copy is acceptable.
  interface SeedOverrides {
    authType?: string;
    name?: string;
    apiKey?: string;
    accessToken?: string;
    isActive?: boolean;
    testStatus?: string;
    providerSpecificData?: Record<string, unknown>;
  }

  async function seedConnection(provider: string, overrides: SeedOverrides = {}) {
    return providersDb.createProviderConnection({
      provider,
      authType: overrides.authType || "apikey",
      name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: overrides.apiKey,
      accessToken: overrides.accessToken,
      isActive: overrides.isActive ?? true,
      testStatus: overrides.testStatus || "active",
      providerSpecificData: overrides.providerSpecificData || {},
    });
  }

  async function callRoute(connectionId: string, search = "") {
    return providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
      { params: { id: connectionId } }
    );
  }

  beforeEach(resetStorage);

  test("per-connection models route includes user-added custom models on the local_catalog path (#6247)", async () => {
    const connection = await seedConnection("aimlapi", { apiKey: "aiml-key" });

    // A user-added custom model persisted under key_value namespace `customModels`.
    await modelsDb.addCustomModel("aimlapi", "my-org/custom-model-6247", "My Custom 6247");

    // Force the local_catalog fallback: the live models probe fails, so the route
    // serves the local catalog (source local_catalog) — the path that dropped
    // custom models before the fix.
    globalThis.fetch = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;

    const response = await callRoute(connection.id);
    const body = (await response.json()) as {
      source?: string;
      models?: Array<{ id: string; owned_by?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    const custom = (body.models || []).find((m) => m.id === "my-org/custom-model-6247");
    // RED before the fix: the custom model is absent (route never read getCustomModels).
    assert.ok(custom, "user-added custom model must appear in the per-connection catalog");
    assert.equal(custom.owned_by, "aimlapi", "custom model must be stamped owned_by = provider");
  });

  test("per-connection models route overlays same-id custom metadata", async () => {
    const connection = await seedConnection("aimlapi", { apiKey: "aiml-key" });
    await modelsDb.replaceSyncedAvailableModelsForConnection("aimlapi", connection.id, [
      { id: "shared-model", name: "Discovered name", supportsVision: true },
    ]);
    await modelsDb.addCustomModel(
      "aimlapi",
      "shared-model",
      "Operator name",
      "manual",
      "chat-completions",
      ["chat"],
      undefined,
      {},
      false
    );
    globalThis.fetch = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;

    const response = await callRoute(connection.id);
    const body = (await response.json()) as {
      models?: Array<{ id: string; name?: string; supportsVision?: boolean }>;
    };
    const model = body.models?.find((entry) => entry.id === "shared-model");

    assert.equal(response.status, 200);
    assert.equal(model?.name, "Operator name");
    assert.equal(model?.supportsVision, false);
  });

  test("per-connection models route includes custom models on a curated-only provider", async () => {
    // codebuddy-intl publishes no model-catalog endpoint, so the route takes the
    // intentional local_catalog branch and never probes upstream. "Curated" must
    // not also mean "the operator cannot add an id by hand" — the saved row used
    // to be dropped here, in mergeProviderModelListing and in /v1/models alike.
    const connection = await seedConnection("codebuddy-intl", {
      authType: "oauth",
      accessToken: "codebuddy-intl-access-token",
    });
    await modelsDb.addCustomModel("codebuddy-intl", "probe-curated-custom", "Probe Curated Custom");
    globalThis.fetch = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;

    const response = await callRoute(connection.id);
    const body = (await response.json()) as {
      source?: string;
      models?: Array<{ id: string; owned_by?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    const custom = (body.models || []).find((m) => m.id === "probe-curated-custom");
    assert.ok(custom, "curated providers must still return operator-defined custom models");
    assert.equal(custom.owned_by, "codebuddy-intl");
  });

  test("per-connection models route can exclude response-only custom models for sync", async () => {
    const connection = await seedConnection("aimlapi", { apiKey: "aiml-key" });

    await modelsDb.addCustomModel("aimlapi", "my-org/custom-model-sync", "My Custom Sync");
    globalThis.fetch = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;

    const response = await callRoute(connection.id, "?excludeCustom=true");
    const body = (await response.json()) as {
      source?: string;
      models?: Array<{ id: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.equal(
      (body.models || []).some((model) => model.id === "my-org/custom-model-sync"),
      false,
      "internal model-sync discovery must not reclassify response-only custom rows"
    );
  });
});

describe("provider-models-route-lan-guard", () => {
  // #6939 — model-list fetch for a LAN-local OpenAI-compatible provider (e.g. LM Studio on
  // 192.168.x.x) was rejected by the SSRF guard even though the connection test for the same
  // host succeeds, under the default (local-first) settings. Root cause: the models route used
  // getProviderOutboundGuard() (only "none" | "public-only", never consults the local-first
  // default) instead of getProviderValidationGuard() (used by the test-connection path, which
  // resolves to "block-metadata" — allow LAN, still block cloud-metadata/link-local — when
  // local-first is ON, which is the default).
  const originalAllowPrivateProviderUrls = process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
  const originalAllowLocalProviderUrls = process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS;

  function restoreGuardEnv() {
    if (originalAllowPrivateProviderUrls === undefined) {
      delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
    } else {
      process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = originalAllowPrivateProviderUrls;
    }
    if (originalAllowLocalProviderUrls === undefined) {
      delete process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS;
    } else {
      process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS = originalAllowLocalProviderUrls;
    }
  }

  async function seedConnection(provider: string, overrides: Record<string, unknown> = {}) {
    return providersDb.createProviderConnection({
      provider,
      authType: (overrides.authType as string) || "apikey",
      name: (overrides.name as string) || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: overrides.apiKey as string | undefined,
      accessToken: overrides.accessToken as string | undefined,
      isActive: (overrides.isActive as boolean) ?? true,
      testStatus: (overrides.testStatus as string) || "active",
      providerSpecificData: (overrides.providerSpecificData as Record<string, unknown>) || {},
    });
  }

  async function callRoute(connectionId: string, search = "") {
    return providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
      { params: { id: connectionId } }
    );
  }

  beforeEach(async () => {
    restoreGuardEnv();
    await resetStorage();
  });
  after(restoreGuardEnv);

  test("#6939: getProviderOutboundGuard() and getProviderValidationGuard() agree for LAN hosts under the default local-first setting", () => {
    // Default settings: OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS unset (ON by default),
    // OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS unset (OFF by default).
    delete process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS;
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

    const validationGuard = outboundUrlGuardPolicy.getProviderValidationGuard();
    assert.equal(validationGuard, "block-metadata");

    // The models route must resolve a guard for LAN-local model discovery that is at least as
    // permissive as the validation (test-connection) guard — "public-only" would reject LAN.
    assert.notEqual(
      validationGuard,
      "public-only",
      "sanity: validation guard should allow LAN under the local-first default"
    );
  });

  test("#6939: LM Studio (LAN host, local OpenAI-compatible provider) model-list fetch is not SSRF-blocked under default settings", async () => {
    delete process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS;
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;

    const connection = await seedConnection("lm-studio", {
      providerSpecificData: { baseUrl: "http://192.168.1.50:1234/v1", autoFetchModels: true },
    });

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return Response.json({ data: [{ id: "llama-3-8b-instruct" }] });
    };

    const response = await callRoute(connection.id);
    const body = (await response.json()) as Record<string, unknown>;

    // RED before the fix: the guard blocked the LAN host before the fetch mock ever ran,
    // surfacing a 400 "Blocked private or local provider URL" — even though the equivalent
    // test-connection call for the same host succeeds under the same default settings.
    assert.ok(
      fetchCalled,
      `expected the LAN model-list fetch to reach the network layer, got status=${response.status} body=${JSON.stringify(body)}`
    );
    assert.notEqual(response.status, 400);
    assert.ok(
      !String(body?.error || "").includes(outboundUrlGuard.PROVIDER_URL_BLOCKED_MESSAGE),
      `LAN host must not be SSRF-blocked by default: ${JSON.stringify(body)}`
    );
  });

  test("#6939: LAN model-list fetch is still blocked when the local-first default is explicitly disabled", async () => {
    delete process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS;
    process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS = "false";

    const connection = await seedConnection("lm-studio", {
      providerSpecificData: { baseUrl: "http://192.168.1.50:1234/v1", autoFetchModels: true },
    });

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return Response.json({ data: [{ id: "llama-3-8b-instruct" }] });
    };

    const response = await callRoute(connection.id);
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(fetchCalled, false, "guard should block before the network layer is reached");
    assert.equal(response.status, 400);
    assert.equal(body.error, outboundUrlGuard.PROVIDER_URL_BLOCKED_MESSAGE);
  });
});

describe("provider-models-route-codex", () => {
  type RouteModel = {
    id: string;
    name?: string;
    apiFormat?: string;
    supportedEndpoints?: string[];
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    [key: string]: unknown;
  };

  type RouteBody = {
    provider?: string;
    models?: RouteModel[];
    source?: string;
    warning?: string;
    intentional?: boolean;
    discoveredCandidateCount?: number;
  };

  type ProviderOverrides = {
    authType?: string;
    apiKey?: string | null;
    accessToken?: string | null;
    providerSpecificData?: Record<string, unknown>;
  };

  async function seedCodexConnection(overrides: ProviderOverrides = {}) {
    return providersDb.createProviderConnection({
      provider: "codex",
      authType: overrides.authType || "oauth",
      name: `codex-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: overrides.apiKey,
      accessToken: overrides.accessToken,
      isActive: true,
      testStatus: "active",
      providerSpecificData: overrides.providerSpecificData || {},
    });
  }

  async function callRoute(connectionId: string, search = "") {
    return providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${connectionId}/models${search}`),
      { params: { id: connectionId } }
    );
  }

  const CACHED_CODEX_ROW = {
    id: "gpt-5.6-sol",
    name: "Cached GPT 5.6 Sol",
    source: "imported",
    apiFormat: "responses",
    supportedEndpoints: ["responses"],
  };

  const GITHUB_NOVA_MANIFEST = {
    models: [
      {
        slug: "gpt-5.7-nova",
        display_name: "GPT-5.7 Nova",
        visibility: "list",
        supported_in_api: true,
        context_window: 400000,
      },
    ],
  };

  beforeEach(resetStorage);

  test("hidden Codex models survive live sync and cached routing while picker filtering stays separate", async () => {
    const connection = await seedCodexConnection({
      accessToken: "test-token",
      providerSpecificData: { codexDiscoveryMode: "safe" },
    });
    globalThis.fetch = async (url) =>
      new URL(String(url)).hostname === "raw.githubusercontent.com"
        ? Response.json({ models: [] })
        : Response.json({
            models: [
              {
                slug: "codex-auto-review",
                visibility: "hide",
                supported_in_api: true,
                minimal_client_version: "0.98.0",
              },
              { slug: "visible-model", visibility: "list", supported_in_api: true },
            ],
          });
    const fresh = await callRoute(connection.id, "?refresh=true");
    assert.equal(fresh.status, 200);
    const synced = await modelsDb.getSyncedAvailableModelsForConnection("codex", connection.id);
    assert.equal(synced.find((model) => model.id === "codex-auto-review")?.visibility, "hide");
    const { getModelInfo } = await import("../../../src/sse/services/model.ts");
    const resolved = await getModelInfo("codex/codex-auto-review");
    assert.equal(resolved.provider, "codex");
    assert.equal(resolved.model, "codex-auto-review");
    assert.equal(resolved.error, undefined);
    const cached = await callRoute(connection.id);
    assert.ok(
      ((await cached.json()) as RouteBody).models?.some((model) => model.id === "codex-auto-review")
    );
    const picker = await callRoute(connection.id, "?excludeHidden=true");
    assert.equal(
      ((await picker.json()) as RouteBody).models?.some(
        (model) => model.id === "codex-auto-review"
      ),
      false
    );
    const stillSynced = await modelsDb.getSyncedAvailableModelsForConnection(
      "codex",
      connection.id
    );
    assert.ok(stillSynced.some((model) => model.id === "codex-auto-review"));
  });

  test("provider models route merges live Codex models with the local catalog then filters denylist", async () => {
    const connection = await seedCodexConnection({
      accessToken: "codex-access-token",
      providerSpecificData: { chatgptAccountId: "account-123" },
    });
    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
      { id: "stale-codex-model", name: "Stale Codex Model", source: "imported" },
    ]);
    const seenRequests: Array<Record<string, string | null>> = [];

    globalThis.fetch = async (url, init) => {
      const requestUrl = String(url);
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      seenRequests.push({
        url: requestUrl,
        authorization: headers.get("authorization"),
        workspaceId: headers.get("chatgpt-account-id"),
        originator: headers.get("originator"),
        userAgent: headers.get("user-agent"),
      });
      if (requestUrl.includes("raw.githubusercontent.com/openai/codex")) {
        return Response.json({
          models: [
            {
              slug: "gpt-5.6-sol",
              display_name: "GPT 5.6 Sol GitHub",
              visibility: "list",
              supported_in_api: true,
              minimal_client_version: "0.144.0",
              context_window: 372000,
              input_modalities: ["text", "image"],
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            },
            {
              slug: "gpt-5.4",
              display_name: "Retired GPT 5.4 GitHub",
              visibility: "list",
              supported_in_api: true,
            },
          ],
        });
      }
      return Response.json({
        models: [
          { slug: "codex-auto-review", visibility: "hide", supported_in_api: true },
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT 5.6 Sol Live",
            visibility: "list",
            supported_in_api: true,
            max_input_tokens: 999999,
            max_output_tokens: 999999,
          },
          {
            slug: "gpt-5.4",
            display_name: "Retired GPT 5.4 Live",
            visibility: "list",
            supported_in_api: true,
          },
          { id: "", name: "missing-id" },
        ],
      });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;
    const modelIds = new Set(body.models?.map((model) => model.id));
    const liveModel = body.models?.find((model) => model.id === "gpt-5.6-sol");
    const syncedModels = await modelsDb.getSyncedAvailableModelsForConnection(
      "codex",
      connection.id
    );
    const syncedIds = new Set(syncedModels.map((model) => model.id));

    assert.equal(response.status, 200);
    assert.equal(body.provider, "codex");
    assert.equal(body.source, "api");
    assert.equal(body.discoveredCandidateCount, undefined);
    assert.deepEqual(seenRequests, [
      {
        url: `https://chatgpt.com/backend-api/codex/models?client_version=${getCodexClientVersion()}`,
        authorization: "Bearer codex-access-token",
        workspaceId: "account-123",
        originator: "codex_cli_rs",
        userAgent: `codex-cli/${getCodexClientVersion()} (Windows 10.0.26200; x64)`,
      },
      {
        url: "https://raw.githubusercontent.com/openai/codex/refs/heads/main/codex-rs/models-manager/models.json",
        authorization: null,
        workspaceId: null,
        originator: null,
        userAgent: null,
      },
    ]);
    assert.ok(modelIds.has("gpt-5.6-sol"));
    // The live inventory is authoritative: static effort aliases the account does
    // not advertise are no longer appended to it.
    assert.equal(modelIds.has("gpt-5.6-sol-ultra"), false);
    assert.equal(modelIds.has("gpt-5.6-sol-max"), false);
    // Live payload wins on overlapping fields; the local catalog only enriches
    // ids the live payload already lists. EXCEPTION: capacity limits (inputTokenLimit/outputTokenLimit)
    // merge conservatively — the smaller of live vs. pinned wins, never the
    // larger, so a stale/inflated live number can never make OmniRoute promise
    // more context than the account can actually serve (#7012). Here the pinned
    // GPT-5.6 Codex contract (872000/128000, see GPT_5_6_CODEX_CAPABILITIES — raised
    // from the old 272K pricing tier to the real usable window by #11179)
    // is smaller than the live payload's 999999/999999, so the pinned value wins.
    assert.equal(liveModel?.name, "GPT 5.6 Sol Live");
    assert.equal(liveModel?.inputTokenLimit, 872000);
    assert.equal(liveModel?.outputTokenLimit, 128000);
    assert.equal(liveModel?.apiFormat, "responses");
    assert.deepEqual(liveModel?.supportedEndpoints, ["responses"]);
    assert.equal(liveModel?.supportsThinking, true);
    assert.equal(liveModel?.supportsVision, true);
    assert.equal(modelIds.has("gpt-5.5-low"), false);
    assert.equal(
      [...modelIds].some((id) => String(id).startsWith("gpt-5.4")),
      false
    );
    assert.ok(syncedIds.has("gpt-5.6-sol"));
    assert.equal(syncedIds.has("gpt-5.5-low"), false);
    assert.equal(
      [...syncedIds].some((id) => String(id).startsWith("gpt-5.4")),
      false
    );
    // Stale cache-only ids are replaced when a fresh discovery response is persisted.
    assert.equal(modelIds.has("stale-codex-model"), false);
    assert.equal(syncedIds.has("stale-codex-model"), false);
  });

  test("provider models route: live token limit wins when it is SMALLER than the pinned local catalog value", async () => {
    const connection = await seedCodexConnection({
      accessToken: "codex-access-token",
      providerSpecificData: { chatgptAccountId: "account-123" },
    });

    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("raw.githubusercontent.com/openai/codex")) {
        return Response.json({ models: [] });
      }
      // Live reports a SMALLER budget than the pinned GPT-5.6 Codex contract
      // (272000/128000, GPT_5_6_CODEX_CAPABILITIES) — e.g. a temporary
      // account-level cap. The conservative merge must take the smaller live
      // value here, not the larger pinned one (#7012).
      return Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT 5.6 Sol Live",
            visibility: "list",
            supported_in_api: true,
            max_input_tokens: 100000,
            max_output_tokens: 50000,
          },
        ],
      });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;
    const liveModel = body.models?.find((model) => model.id === "gpt-5.6-sol");

    assert.equal(response.status, 200);
    assert.equal(liveModel?.inputTokenLimit, 100000);
    assert.equal(liveModel?.outputTokenLimit, 50000);
  });

  test("provider models route uses the GitHub Codex catalog when live discovery fails", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });
    const seenUrls: string[] = [];

    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      seenUrls.push(requestUrl);
      if (requestUrl.includes("raw.githubusercontent.com/openai/codex")) {
        return Response.json({
          models: [
            {
              slug: "gpt-5.6-sol",
              display_name: "GPT-5.6-Sol",
              visibility: "list",
              supported_in_api: true,
              minimal_client_version: "0.144.0",
              context_window: 372000,
            },
            {
              slug: "gpt-5.4",
              display_name: "Retired GPT-5.4",
              visibility: "list",
              supported_in_api: true,
            },
          ],
        });
      }
      return new Response("upstream unavailable", { status: 503 });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;
    const modelIds = new Set((body.models || []).map((model) => model.id));

    assert.equal(response.status, 200);
    assert.equal(body.provider, "codex");
    assert.equal(body.source, "github_catalog");
    assert.equal(body.intentional, undefined);
    assert.equal(body.warning, "Codex live catalog unavailable — using GitHub model catalog");
    assert.equal(body.discoveredCandidateCount, undefined);
    assert.ok(seenUrls.some((url) => url.includes("backend-api/codex/models")));
    assert.ok(seenUrls.some((url) => url.includes("raw.githubusercontent.com/openai/codex")));
    assert.ok(modelIds.has("gpt-5.6-sol"));
    // GitHub manifest ids only: static effort aliases are not appended to it.
    assert.equal(modelIds.has("gpt-5.5-low"), false);
    assert.equal(
      [...modelIds].some((id) => String(id).startsWith("gpt-5.4")),
      false
    );
    const syncedModels = await modelsDb.getSyncedAvailableModelsForConnection(
      "codex",
      connection.id
    );
    assert.equal(syncedModels.length, 0, "GitHub models.json must not persist into synced catalog");
  });

  test("provider models route returns cached Codex models when refresh discovery fails", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });
    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
      {
        id: "gpt-5.4",
        name: "Retired Cached GPT 5.4",
        source: "imported",
        apiFormat: "responses",
        supportedEndpoints: ["responses"],
      },
      {
        id: "gpt-5.6-sol",
        name: "Cached GPT 5.6 Sol",
        source: "imported",
        apiFormat: "responses",
        supportedEndpoints: ["responses"],
      },
    ]);

    globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;

    assert.equal(response.status, 200);
    assert.equal(body.provider, "codex");
    assert.equal(body.source, "cache");
    assert.equal(body.warning, "Codex live catalog unavailable — using cached catalog");
    assert.equal(body.discoveredCandidateCount, undefined);
    const modelIds = new Set((body.models || []).map((model) => model.id));
    assert.ok(modelIds.has("gpt-5.6-sol"));
    // The account's cached inventory is authoritative: no static effort aliases.
    assert.equal(modelIds.has("gpt-5.6-sol-ultra"), false);
    assert.equal(
      [...modelIds].some((id) => String(id).startsWith("gpt-5.4")),
      false
    );
    const syncedModels = await modelsDb.getSyncedAvailableModelsForConnection(
      "codex",
      connection.id
    );
    const syncedIds = new Set(syncedModels.map((model) => model.id));
    assert.ok(syncedIds.has("gpt-5.6-sol"));
    assert.equal(syncedIds.has("gpt-5.6-sol-ultra"), false);
    assert.equal(syncedIds.has("gpt-5.4"), false);
  });

  test("provider models route auto-includes remote-only Codex models after merge", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });

    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("raw.githubusercontent.com/openai/codex")) {
        return Response.json({ models: [] });
      }
      return Response.json({
        models: [
          {
            slug: "future-codex-experimental",
            display_name: "Future Codex Experimental",
            visibility: "list",
            supported_in_api: true,
          },
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT 5.6 Sol Live",
            visibility: "list",
            supported_in_api: true,
          },
          {
            slug: "gpt-5.4",
            display_name: "Retired GPT 5.4 Live",
            visibility: "list",
            supported_in_api: true,
          },
        ],
      });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;
    const modelIds = new Set((body.models || []).map((model) => model.id));
    const syncedModels = await modelsDb.getSyncedAvailableModelsForConnection(
      "codex",
      connection.id
    );
    const syncedIds = new Set(syncedModels.map((model) => model.id));

    assert.equal(response.status, 200);
    assert.equal(body.source, "api");
    assert.ok(modelIds.has("future-codex-experimental"));
    assert.ok(modelIds.has("gpt-5.6-sol"));
    assert.equal(modelIds.has("gpt-5.4"), false);
    assert.ok(syncedIds.has("future-codex-experimental"));
    assert.equal(syncedIds.has("gpt-5.4"), false);
  });

  test("provider models route falls back to local Codex catalog when live and GitHub fail", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });

    globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;

    assert.equal(response.status, 200);
    assert.equal(body.provider, "codex");
    assert.equal(body.source, "local_catalog");
    assert.equal(body.intentional, true);
    assert.equal(body.warning, "Codex live and GitHub catalogs unavailable — using local catalog");
    assert.ok(body.models?.some((model) => model.id === "gpt-5.6-sol"));
    assert.ok(body.models?.some((model) => model.id === "gpt-5.5"));
    assert.equal(
      body.models?.some((model) => model.id.startsWith("gpt-5.4")),
      false
    );
  });

  test("provider models route returns curated GPT-5.6 variants when auto-fetch is disabled", async () => {
    const connection = await seedCodexConnection({
      apiKey: null,
      accessToken: "codex-access",
      providerSpecificData: { autoFetchModels: false },
    });

    const response = await callRoute(connection.id);
    const body = (await response.json()) as RouteBody;
    const modelIds = new Set((body.models || []).map((model) => model.id));

    assert.equal(response.status, 200);
    assert.equal(body.provider, "codex");
    assert.equal(body.source, "local_catalog");
    assert.ok(modelIds.has("gpt-5.6-sol-ultra"));
    assert.ok(modelIds.has("gpt-5.6-sol-max"));
    assert.ok(modelIds.has("gpt-5.6-terra-ultra"));
    assert.ok(modelIds.has("gpt-5.6-luna-max"));
    assert.equal(
      [...modelIds].some((id) => String(id).startsWith("gpt-5.4")),
      false
    );
  });

  test("vendor models route keeps the cached catalog when live Codex answers an empty list", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });
    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
      CACHED_CODEX_ROW,
    ]);

    globalThis.fetch = async (url) => {
      if (String(url).includes("raw.githubusercontent.com/openai/codex")) {
        return Response.json(GITHUB_NOVA_MANIFEST);
      }
      // Live answers 200 with an empty catalog (measured 2026-10-23: both pro
      // accounts, client versions 0.61-0.64, with and without the account id).
      return Response.json({ models: [] });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;
    const modelIds = new Set((body.models || []).map((model) => model.id));

    assert.equal(response.status, 200);
    // An empty answer can be transient, so the account's own catalog wins and the
    // response is labelled degraded (model-sync's isDegraded* gates key off source
    // plus a non-empty warning), with wording distinct from an upstream outage.
    assert.equal(body.source, "cache");
    assert.equal(body.warning, "Codex returned no models — using the cached catalog");
    assert.ok(modelIds.has("gpt-5.6-sol"));
    const synced = await modelsDb.getSyncedAvailableModelsForConnection("codex", connection.id);
    assert.deepEqual(
      synced.map((model) => model.id),
      ["gpt-5.6-sol"],
      "an empty answer must not delete the cached catalog"
    );
  });

  test("vendor models route falls through to the public catalog on an empty list with no cache", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });

    globalThis.fetch = async (url) => {
      if (String(url).includes("raw.githubusercontent.com/openai/codex")) {
        return Response.json(GITHUB_NOVA_MANIFEST);
      }
      return Response.json({ models: [] });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;

    assert.equal(response.status, 200);
    assert.equal(body.source, "github_catalog");
    assert.equal(body.warning, "Codex returned no models — using the public catalog");
    assert.ok((body.models || []).some((model) => model.id === "gpt-5.7-nova"));
  });

  test("vendor models route keeps the cache on an empty list even when GitHub is down", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });
    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
      CACHED_CODEX_ROW,
    ]);

    globalThis.fetch = async (url) => {
      if (String(url).includes("raw.githubusercontent.com/openai/codex")) {
        return new Response("github unavailable", { status: 503 });
      }
      return Response.json({ models: [] });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;

    assert.equal(response.status, 200);
    assert.equal(body.source, "cache");
    assert.equal(body.warning, "Codex returned no models — using the cached catalog");
    const synced = await modelsDb.getSyncedAvailableModelsForConnection("codex", connection.id);
    assert.equal(synced.length, 1, "the cached catalog must survive an empty answer");
  });

  test("vendor models route reports an error envelope as a failure, not a live or empty catalog", async () => {
    const connection = await seedCodexConnection({ accessToken: "codex-access-token" });
    await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
      CACHED_CODEX_ROW,
    ]);

    globalThis.fetch = async (url) => {
      if (String(url).includes("raw.githubusercontent.com/openai/codex")) {
        return new Response("github unavailable", { status: 503 });
      }
      // 200 with an error body: without the guard this normalizes into a phantom
      // model with id "error" and the route reports a successful live lookup.
      return Response.json({ error: { message: "quota exhausted", type: "insufficient_quota" } });
    };

    const response = await callRoute(connection.id, "?refresh=true");
    const body = (await response.json()) as RouteBody;
    const modelIds = (body.models || []).map((model) => model.id);

    assert.equal(response.status, 200);
    assert.equal(body.source, "cache");
    assert.equal(body.warning, "Codex live catalog unavailable — using cached catalog");
    assert.equal(modelIds.includes("error"), false, "an error envelope is not a model");
    assert.ok(modelIds.includes("gpt-5.6-sol"));
    const synced = await modelsDb.getSyncedAvailableModelsForConnection("codex", connection.id);
    assert.equal(synced.length, 1, "a failed lookup must not touch the cached catalog");
  });
});
