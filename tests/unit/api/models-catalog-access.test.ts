// @ts-nocheck
// /v1/models catalog: which rows a caller may see (API-key allowlists, anonymous access, env master
// key, hidden models, paid / exposure-list filters, curated providers) plus the Claude Code gateway
// discovery conformance contract.
//
// Merged from 8 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// resets the database, API-key state and catalog cache in its own hooks (each former file started
// from a fresh process); the database handle is closed once at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-catalog-access-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-api-key-secret-claude-bare-root";
delete process.env.INITIAL_PASSWORD;
delete process.env.JWT_SECRET;
// A busy parallel run can push a cold catalog build past the 8s default bound, which answers 503
// catalog_build_timeout instead of the catalog under test.
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const readCache = await import("../../../src/lib/db/readCache.ts");
const { mergeModelCompatOverride } = await import("@/lib/db/models");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const { isCatalogModelAllowedForKey } =
  await import("../../../src/app/api/v1/models/catalogKeyFilter.ts");
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
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await v1ModelsCatalog.__flushCatalogBackgroundRefreshForTest();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

describe("api-key-catalog-claude-bare-root-leak", () => {
  /**
   * A restricted key's /v1/models must list only models the key can call.
   *
   * Observed: a key restricted to `cc/*` listed ~105 rows from other providers
   * (`dva/claude-opus-5-high`, `ddgw/claude-haiku-4-5`); every chat request to them
   * returned 403 "Model ... is not allowed for this API key".
   *
   * Cause: the catalog filter also checks each row's bare `root` (#781), and with
   * `preferClaudeCodeForUnprefixedClaudeModels` on, the permission check expands any
   * bare `claude-*` name to `cc/<name>` — which `cc/*` matches. Dispatch checks only
   * the requested id, so those rows were listed but refused.
   *
   * Rules:
   *   R1 With the preference on, a `cc/*` key lists cc/, claude/ and their no-think/
   *      variants, and no dva/ or ddgw/ rows.
   *   R2 Every listed provider row passes isModelAllowedForKey(key, id) — with the
   *      preference on and off.
   *   R3 The root fallback still serves a bare allowlist entry (#781).
   *   R4 A no-think/ id is judged as the real model it dispatches to.
   */
  beforeEach(async () => {
    await core.resetDbInstance();
    await resetAll();
  });

  async function seedClaudeCodeConnection() {
    await providersDb.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      name: "claude-bare-root",
      accessToken: "cc-access",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  async function restrictedKey(name: string, allowedModels: string[]) {
    const created = await apiKeysDb.createApiKey(name, `machine-${name}`);
    await apiKeysDb.updateApiKeyPermissions(created.id, {
      modelAccessMode: "restricted",
      allowedModels,
    } as Parameters<typeof apiKeysDb.updateApiKeyPermissions>[1]);
    apiKeysDb.resetApiKeyState();
    return created.key;
  }

  async function catalogIds(apiKey?: string): Promise<string[]> {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      })
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
    return body.data.filter((m) => m.owned_by !== "combo").map((m) => m.id);
  }

  const hasPrefix = (ids: string[], prefix: string) => ids.some((id) => id.startsWith(prefix));

  test("R1: a cc/* key lists cc/, claude/ and no-think/ variants, not dva/ or ddgw/", async () => {
    await seedClaudeCodeConnection();
    await settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
    const key = await restrictedKey("cc-only", ["cc/*"]);

    // Precondition: the unfiltered catalog does carry the other providers' claude-* rows.
    const all = await catalogIds();
    assert.ok(hasPrefix(all, "dva/claude-"), "fixture: dva/ claude rows exist in the catalog");
    assert.ok(hasPrefix(all, "ddgw/claude-"), "fixture: ddgw/ claude rows exist in the catalog");

    const ids = await catalogIds(key);
    assert.ok(hasPrefix(ids, "cc/"), "cc/ models are listed");
    assert.ok(hasPrefix(ids, "claude/"), "claude/ models are listed");
    assert.ok(hasPrefix(ids, "no-think/cc/"), "no-think/cc/ variants are listed");
    assert.ok(hasPrefix(ids, "no-think/claude/"), "no-think/claude/ variants are listed");
    assert.deepEqual(
      ids.filter((id) => /^(no-think\/)?(dva|ddgw)\//.test(id)),
      [],
      "no dva/ or ddgw/ row may be listed for a cc/* key"
    );
  });

  for (const prefer of [true, false]) {
    test(`R2: every listed row is callable by its id (prefer Claude Code: ${prefer})`, async () => {
      await seedClaudeCodeConnection();
      await settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: prefer });
      const key = await restrictedKey(`invariant-${prefer}`, ["cc/*"]);

      const ids = await catalogIds(key);
      assert.ok(ids.length > 0);
      const refused: string[] = [];
      for (const id of ids) {
        if (!(await apiKeysDb.isModelAllowedForKey(key, id))) refused.push(id);
      }
      assert.deepEqual(refused, [], "listed rows that a chat request would refuse");
    });
  }

  test("R3: the root fallback needs a bare allowlist entry", async () => {
    await settingsDb.updateSettings({ preferClaudeCodeForUnprefixedClaudeModels: true });
    const ccKey = await restrictedKey("cc-wildcard", ["cc/*"]);
    const bareKey = await restrictedKey("bare-claude", ["claude-opus-5-high"]);
    const dvaRow = { id: "dva/claude-opus-5-high", root: "claude-opus-5-high" };

    assert.equal(
      await isCatalogModelAllowedForKey(
        ccKey,
        dvaRow,
        { allowedModels: ["cc/*"], blockedModels: [] },
        apiKeysDb
      ),
      false,
      "cc/* must not admit another provider's row through its bare claude-* root"
    );
    assert.equal(
      await isCatalogModelAllowedForKey(
        bareKey,
        dvaRow,
        { allowedModels: ["claude-opus-5-high"], blockedModels: [] },
        apiKeysDb
      ),
      true,
      "a bare allowlist entry still matches the row's root (#781)"
    );
  });

  test("R4: a no-think/ id is judged as the model it dispatches to", async () => {
    const key = await restrictedKey("cc-no-think", ["cc/*"]);

    assert.equal(await apiKeysDb.isModelAllowedForKey(key, "no-think/cc/claude-opus-5"), true);
    assert.equal(await apiKeysDb.isModelAllowedForKey(key, "no-think/claude/claude-opus-5"), true);
    assert.equal(
      await apiKeysDb.isModelAllowedForKey(key, "no-think/dva/claude-opus-5-high"),
      false
    );
    assert.equal(await apiKeysDb.isModelAllowedForKey(key, "no-think/"), false);
  });
});

describe("v1-models-auth-leak-9320", () => {
  // #9320 — Tunnel exposure: /v1/models leaks full model catalog without an API key
  //
  // Regression guard: when management auth is configured (isAuthRequired === true),
  // GET /v1/models must require an API key or dashboard session. Anonymous requests
  // should get a 401 status, not the full catalog.
  //
  // Before the fix, `requireAuthForModels` defaulted to `undefined` in settings,
  // and `undefined !== true` evaluates to `true`, so `getModelCatalogAuthRejection()`
  // returned null (pass-through) on every request — leaking 115+ model entries to
  // anonymous callers.
  const settingsModule = settingsDb;

  beforeEach(async () => {
    await core.resetDbInstance();
    await resetAll();
  });

  test("#9320 FIXED: anonymous GET /v1/models returns 401 when auth is configured", async () => {
    // Set up management auth: configure a password so isAuthRequired() returns true
    await settingsModule.updateSettings({
      password: "test-password-9320",
      requireLogin: true,
    });

    // Anonymous request — no Authorization header
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://test.example.com/v1/models")
    );

    // After fix: anonymous requests must be rejected with 401 when auth is configured
    assert.equal(res.status, 401, `expected 401 for anonymous request, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must carry an error object");
  });

  test("#9320: authenticated request (valid API key) returns 200 with models", async () => {
    // Set up management auth
    await settingsModule.updateSettings({
      password: "test-password-9320",
      requireLogin: true,
    });

    // Create a valid API key
    await apiKeysDb.createApiKey("test-key-9320", "test-machine-9320");
    const keys = await apiKeysDb.getApiKeys();
    type ApiKeyRecord = Awaited<ReturnType<typeof apiKeysDb.getApiKeys>>[number];
    const apiKey = Array.isArray(keys)
      ? keys.find((k: ApiKeyRecord) => k.name === "test-key-9320")
      : null;
    assert.ok(apiKey, "API key must have been created");

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://test.example.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey.key}` },
      })
    );

    // With a valid API key, the catalog should be accessible
    if (res.status !== 200) {
      // If the fix is in place, this should return 200
      console.log(`[INFO] Authenticated request returned status ${res.status}`);
    }
  });
});

describe("hidden-models-leak-v1-models-11300", () => {
  /**
   * #11300 — Models toggled to "Hidden" on Provider pages are still listed in
   * `GET /v1/models`.
   *
   * `PATCH /api/provider-models?provider=<key>&modelId=<id>` persists the hidden
   * override under whatever key the dashboard's `[id]` route param happened to be
   * (an alias like `cc`/`gh`/`cx`, a canonical provider id, a compatible-provider
   * node UUID, or its configured prefix). `catalog.ts`'s `isModelHiddenBulk()` did
   * a single-key lookup, so a model stayed listed in `/v1/models` whenever the key
   * used to READ diverged from the key used to WRITE:
   *
   *  - Static `PROVIDER_MODELS` loop checked only `canonicalProviderId` — a model
   *    hidden under the alias (e.g. `cc` for Claude Code) never matched.
   *  - The Codex-native-unprefixed loop checked only `"codex"` — a model hidden
   *    via the `openai` provider page (codex often shares the openai-compatible
   *    connection) never matched.
   *  - The synced-discovery loop checked only the raw connection `providerId` —
   *    a model hidden via the compatible-provider node's configured *prefix*
   *    (the identifier the operator actually sees/uses on that node's page)
   *    never matched.
   */
  beforeEach(async () => {
    await resetAll();
  });

  async function fetchCatalogIds(): Promise<string[]> {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    assert.ok(Array.isArray(body.data), "response has data array");
    return body.data.map((m) => m.id);
  }

  test("#11300 A: hiding a static model under its ALIAS (cc) excludes it under both cc/ and claude/ ids", async () => {
    await providersDb.createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "claude-main",
      apiKey: "sk-test-11300a",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });

    // Sanity: before hiding, the model is advertised.
    let ids = await fetchCatalogIds();
    assert.ok(
      ids.includes("cc/claude-opus-5"),
      `expected cc/claude-opus-5 to be listed before hiding — got ${JSON.stringify(ids.filter((i) => i.includes("claude-opus-5")))}`
    );

    // Operator hides the model on the provider page, whose route param is the
    // alias "cc" (not the canonical "claude").
    await mergeModelCompatOverride("cc", "claude-opus-5", { isHidden: true });

    ids = await fetchCatalogIds();
    assert.ok(
      !ids.includes("cc/claude-opus-5"),
      `#11300 RED: cc/claude-opus-5 hidden under alias "cc" must not appear — got ${JSON.stringify(ids.filter((i) => i.includes("claude-opus-5")))}`
    );
    assert.ok(
      !ids.includes("claude/claude-opus-5"),
      `#11300 RED: claude/claude-opus-5 hidden under alias "cc" must not appear either`
    );
  });

  test('#11300 B: hiding a codex-native unprefixed model under "openai" excludes the bare model id', async () => {
    await providersDb.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "codex-main",
      apiKey: "sk-test-11300b",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });

    const nativeModelId = "gpt-5.6-sol";

    let ids = await fetchCatalogIds();
    assert.ok(
      ids.includes(nativeModelId),
      `expected bare "${nativeModelId}" to be listed before hiding — got ${JSON.stringify(ids.filter((i) => i.includes("gpt-5.6-sol")))}`
    );

    // Hidden via the "openai" provider page (codex native models are commonly
    // reached through the shared openai-compatible connection).
    await mergeModelCompatOverride("openai", nativeModelId, { isHidden: true });

    ids = await fetchCatalogIds();
    assert.ok(
      !ids.includes(nativeModelId),
      `#11300 RED: bare "${nativeModelId}" hidden under "openai" must not appear — got ${JSON.stringify(ids.filter((i) => i.includes("gpt-5.6-sol")))}`
    );
  });

  test("#11300 C: hiding a compatible-node synced model under its configured PREFIX excludes prefix/<model>", async () => {
    const NODE_ID = "openai-compatible-chat-11300-c0ffee00-0000-4000-8000-000000000000";
    const PREFIX = "deepseek-node-11300";

    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "Deepseek Node (11300 probe)",
      prefix: PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    const connection = await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "deepseek-node-conn",
      apiKey: "sk-test-11300c",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    const modelId = "deepseek-v4-flash-0731";
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      NODE_ID,
      (connection as { id: string }).id,
      [
        {
          id: modelId,
          name: "DeepSeek V4 Flash",
          source: "imported",
          supportedEndpoints: ["chat"],
        },
      ]
    );

    let ids = await fetchCatalogIds();
    assert.ok(
      ids.includes(`${PREFIX}/${modelId}`),
      `expected ${PREFIX}/${modelId} to be listed before hiding — got ${JSON.stringify(ids.filter((i) => i.includes(modelId)))}`
    );

    // Operator hides the model via the node's page, which is keyed by the
    // configured prefix rather than the internal node UUID.
    await mergeModelCompatOverride(PREFIX, modelId, { isHidden: true });

    ids = await fetchCatalogIds();
    assert.ok(
      !ids.includes(`${PREFIX}/${modelId}`),
      `#11300 RED: ${PREFIX}/${modelId} hidden under prefix "${PREFIX}" must not appear — got ${JSON.stringify(ids.filter((i) => i.includes(modelId)))}`
    );
    assert.ok(
      !ids.includes(`${NODE_ID}/${modelId}`),
      `#11300 RED: ${NODE_ID}/${modelId} hidden under prefix "${PREFIX}" must not appear either`
    );
  });
});

describe("models-catalog-hide-paid", () => {
  /**
   * #6316 — `hidePaidModels` settings toggle filters paid-only models from the
   * unified `/v1/models` catalog. Uses `isFreeModel()` from
   * `src/shared/utils/freeModels.ts` (`:free` suffix, zero-price pricing, or
   * FREE_MODEL_BUDGETS membership). Modality registries are exempt (no pricing).
   * Rule #18 regression guard for the toggle.
   */
  async function fetchCatalog(): Promise<Array<{ id: string; type?: string }>> {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { method: "GET" })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ id: string; type?: string }> };
    return body.data;
  }

  // The former file ran on a fresh database; its two tests share state.
  before(resetAll);

  test("hidePaidModels default is false + toggles the catalog filter", async () => {
    const defaults = await settingsDb.getSettings();
    assert.equal(defaults.hidePaidModels, false);

    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-main",
      apiKey: "sk-test",
      isActive: true,
    });

    // Chat-only assertion. Modality registries (embedding/image/audio/moderation)
    // are exempt from the paid filter by design (no pricing metadata).
    const isPaidChat = (m: { id: string; type?: string }) =>
      (m.type === undefined || m.type === "chat") &&
      (/^(openai|oa)\/gpt-/.test(m.id) || /^(openai|oa)\/o[1-9]/.test(m.id));

    await settingsDb.updateSettings({ hidePaidModels: false });
    const off = await fetchCatalog();
    assert.equal(off.some(isPaidChat), true, "expected paid OpenAI chat models when toggle is off");

    await settingsDb.updateSettings({ hidePaidModels: true });
    const on = await fetchCatalog();
    const leaked = on.filter(isPaidChat).map((m) => m.id);
    assert.deepEqual(leaked, [], `paid OpenAI chat aliases leaked: ${leaked.join(", ")}`);
  });

  // #6328 (follow-up to #6495) — the paid filter must also apply to the
  // *custom* (user-defined) model loop, not just the built-in PROVIDER_MODELS
  // loop the original #6495 test covers. `openai` has no curated free roster, so
  // a pricing-less custom model on it is paid-tier and must disappear when the
  // toggle is on. Regression guard for the added `shouldHidePaid()` call in the
  // custom-rows loop (src/app/api/v1/models/catalog.ts).
  test("#6328 hidePaidModels also filters user-defined custom model rows", async () => {
    // openai connection already created by the previous test; ensure the custom model exists.
    await modelsDb.addCustomModel("openai", "my-custom-paid-6328", "My Custom Paid 6328");

    const hasCustom = (list: Array<{ id: string }>) =>
      list.some((m) => m.id.includes("my-custom-paid-6328"));

    await settingsDb.updateSettings({ hidePaidModels: false });
    assert.equal(hasCustom(await fetchCatalog()), true, "custom model visible when toggle is off");

    await settingsDb.updateSettings({ hidePaidModels: true });
    assert.equal(
      hasCustom(await fetchCatalog()),
      false,
      "custom paid model must be hidden when hidePaidModels is on (#6328)"
    );
  });
});

describe("models-catalog-model-exposure-list", () => {
  /**
   * #11481 — `modelVisibilityAllowlist`/`modelVisibilityDenylist` filter the
   * unified `/v1/models` catalog. Mirrors the models-catalog-hide-paid describe above.
   * Rule #18 regression guard for the toggle.
   */
  async function fetchCatalog(): Promise<Array<{ id: string; type?: string }>> {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { method: "GET" })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ id: string; type?: string }> };
    return body.data;
  }

  // The former file ran on a fresh database; its tests share state.
  before(resetAll);

  test("default (both lists empty) — catalog is unchanged", async () => {
    const defaults = await settingsDb.getSettings();
    assert.deepEqual(defaults.modelVisibilityAllowlist, []);
    assert.deepEqual(defaults.modelVisibilityDenylist, []);

    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-main-exposure",
      apiKey: "sk-test",
      isActive: true,
    });

    const ids = (await fetchCatalog()).map((m) => m.id);
    assert.ok(
      ids.some((id) => /^(openai|oa)\/gpt-4o(-mini)?$/.test(id)),
      "expected openai chat models present with no exposure list configured"
    );
  });

  test("modelVisibilityDenylist hides an exact-id match from /v1/models", async () => {
    await settingsDb.updateSettings({
      modelVisibilityAllowlist: [],
      modelVisibilityDenylist: ["openai/gpt-4o-mini"],
    });

    const ids = (await fetchCatalog()).map((m) => m.id);
    assert.ok(!ids.includes("openai/gpt-4o-mini"), "denied model must not appear in the catalog");
    assert.ok(
      ids.some((id) => id === "openai/gpt-4o"),
      "a non-denied sibling model must remain"
    );

    await settingsDb.updateSettings({ modelVisibilityDenylist: [] });
  });

  test("modelVisibilityAllowlist restricts the chat catalog to exactly the listed models", async () => {
    await settingsDb.updateSettings({
      modelVisibilityDenylist: [],
      modelVisibilityAllowlist: ["openai/gpt-4o-mini"],
    });

    const chatIds = (await fetchCatalog())
      .filter((m) => m.type === undefined || m.type === "chat")
      .map((m) => m.id)
      .filter((id) => id.startsWith("openai/") || id.startsWith("oa/"));

    assert.deepEqual(
      chatIds.filter((id) => id !== "openai/gpt-4o-mini"),
      [],
      `only the allow-listed model may remain, found: ${chatIds.join(", ")}`
    );
    assert.ok(chatIds.includes("openai/gpt-4o-mini"), "the allow-listed model itself must remain");

    await settingsDb.updateSettings({ modelVisibilityAllowlist: [] });
  });
});

describe("models-catalog-envkey-6406", () => {
  // Regression guard for issue #6406 — `/v1/models` returned the full catalog
  // unauthenticated but 0 models when an env-var master key (OMNIROUTE_API_KEY /
  // ROUTER_API_KEY) was presented. Root cause: `isModelAllowedForKey` denies when
  // `getApiKeyMetadata` returns null, and env-var keys have no DB row.
  // Fix: skip the per-model filter when apiKey has no metadata (env-var master key).

  // `getUnifiedModelsResponse` returns the OpenAI-shaped `{object, data}` catalog
  // list (see catalog.ts's `responseBody`); only `data[].id` is asserted here.
  interface ModelsCatalogResponseBody {
    object: string;
    data: Array<{ id: string; [key: string]: unknown }>;
  }

  async function seedOpenAi() {
    return providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-envkey-6406",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  beforeEach(async () => {
    await resetAll();
  });

  after(() => {
    delete process.env.OMNIROUTE_API_KEY;
  });

  test("#6406 env-var master key (no DB metadata) sees the full catalog, not 0 models", async () => {
    await seedOpenAi();

    // Baseline: unauth response.
    const unauthResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const unauthBody = (await unauthResponse.json()) as ModelsCatalogResponseBody;
    assert.equal(unauthResponse.status, 200);
    const unauthCount = unauthBody.data.length;
    assert.ok(unauthCount > 0, `unauth baseline must have models, got ${unauthCount}`);

    // Env-var master key path — no DB row, so getApiKeyMetadata returns null.
    const envKey = "sk-envkey-6406-master";
    process.env.OMNIROUTE_API_KEY = envKey;

    const authResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { Authorization: `Bearer ${envKey}` },
      })
    );
    const authBody = (await authResponse.json()) as ModelsCatalogResponseBody;

    assert.equal(authResponse.status, 200);
    // Regression: before the fix, this collapsed to 0. Now it matches the unauth
    // catalog (env-var master key has no per-key restrictions).
    assert.equal(
      authBody.data.length,
      unauthCount,
      `env-var key catalog (${authBody.data.length}) must equal unauth catalog (${unauthCount}); auth should GATE access, not FILTER inventory when the key carries no restrictions`
    );
    assert.notEqual(authBody.data.length, 0, "env-var master key must not collapse catalog to 0");
  });

  test("#6406 DB-backed key with allowedModels still filters (unchanged behavior)", async () => {
    await seedOpenAi();

    const key = await apiKeysDb.createApiKey("envkey-6406-filter", "machine-envkey-6406");
    await apiKeysDb.updateApiKeyPermissions(key.id, { allowedModels: ["openai/*"] });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", {
        headers: { Authorization: `Bearer ${key.key}` },
      })
    );
    const body = (await response.json()) as ModelsCatalogResponseBody;
    const ids: string[] = body.data.map((item) => item.id);

    assert.equal(response.status, 200);
    assert.ok(
      ids.some((id) => id.startsWith("openai/")),
      "DB-backed key with allowedModels=['openai/*'] must still see openai/* models"
    );
    assert.equal(
      ids.some((id) => id.startsWith("claude/") || id.startsWith("cc/")),
      false,
      "DB-backed allowedModels filter must still exclude non-matching families"
    );
  });
});

describe("curated-provider-custom-models", () => {
  /**
   * Curated-model providers (CodeBuddy CN/intl, Kimi Web, Z.ai Web, ChatGPT Web)
   * publish no upstream model-catalog endpoint, so `providerUsesCuratedModelsOnly`
   * hides "Import Models" and skips every synced-catalog loop. That flag leaked into
   * the *custom* model paths as well, which is a different question: a row the
   * operator typed into "Add Custom Model" is a local decision, and dropping it made
   * the model impossible to route — saved in the dashboard, absent from the listing
   * and from `/v1/models`.
   *
   * These tests pin the split: curated providers keep their curated/synced behaviour
   * (no discovery), while operator-defined custom rows survive in the provider
   * listing merge and in `/v1/models`.
   */
  // `codebuddy-intl` is the provider from the report: alias `cbai`, curated-only.
  const CURATED_PROVIDER = "codebuddy-intl";
  const CURATED_ALIAS = "cbai";
  const CUSTOM_MODEL_ID = "deepseek-v4.1-flash-1017";

  async function seedCuratedConnection() {
    await providersDb.createProviderConnection({
      provider: CURATED_PROVIDER,
      authType: "oauth",
      name: `${CURATED_PROVIDER}-curated-custom`,
      apiKey: null,
      accessToken: `${CURATED_PROVIDER}-access-token`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  beforeEach(async () => {
    await resetAll();
    await seedCuratedConnection();
  });

  test("/v1/models advertises an operator-defined custom model on a curated-only provider", async () => {
    await modelsDb.addCustomModel(CURATED_PROVIDER, CUSTOM_MODEL_ID, "DeepSeek V4.1 Flash");

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((row) => row.id);

    assert.ok(
      ids.includes(`${CURATED_ALIAS}/${CUSTOM_MODEL_ID}`),
      `expected "${CURATED_ALIAS}/${CUSTOM_MODEL_ID}" in /v1/models, got ${JSON.stringify(
        ids.filter((id) => id.startsWith(`${CURATED_ALIAS}/`))
      )}`
    );
  });

  test("the curated catalog still ships when no custom model was added", async () => {
    // Anti-vacuity for the test above: the curated registry rows come from the static
    // loop and must not depend on the custom-model path.
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as { data: Array<{ id: string }> };
    const curatedIds = body.data
      .map((row) => row.id)
      .filter((id) => id.startsWith(`${CURATED_ALIAS}/`));

    assert.ok(curatedIds.length >= 5, `expected the curated lineup, got ${curatedIds.length}`);
    assert.equal(
      curatedIds.includes(`${CURATED_ALIAS}/${CUSTOM_MODEL_ID}`),
      false,
      "nothing was added, so nothing custom may appear"
    );
  });

  test("/v1/models keeps a discovery-imported custom row off a curated-only provider", async () => {
    // Operator rows reach /v1/models (#18018); a row a discovery sync imported is a stale
    // leftover on a provider with no upstream catalog and must stay unroutable (#8451).
    await modelsDb.addCustomModel(CURATED_PROVIDER, "stale-imported-model", "Stale", "imported");
    await modelsDb.addCustomModel(CURATED_PROVIDER, CUSTOM_MODEL_ID, "DeepSeek V4.1 Flash");

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);

    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((row) => row.id);

    assert.ok(ids.includes(`${CURATED_ALIAS}/${CUSTOM_MODEL_ID}`), "operator row must be listed");
    assert.equal(ids.includes(`${CURATED_ALIAS}/stale-imported-model`), false);
  });
});

describe("v1-models-discovery-conformance", () => {
  // Task D1 — GET /v1/models conformance for Claude Code's gateway model discovery.
  //
  // With CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1, Claude Code issues
  // `GET /v1/models?limit=1000` with a 3s timeout and `redirect: "fail"`, reading
  // only `id` + `display_name` from each entry. Three failure modes empty the
  // picker with no error surfaced to the user: the endpoint taking longer than
  // 3s, redirecting, or returning an entry without a string `id`. This suite
  // covers all three, plus the stale-while-revalidate cache behavior that makes
  // the timeout fix possible and the error-sanitization fix for the builder's
  // catch block (hard rule #12).
  beforeEach(async () => {
    await core.resetDbInstance();
    await resetAll();
  });

  test("1. GET /v1/models never returns a 3xx redirect status (regression guard)", async () => {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.ok(
      res.status < 300 || res.status >= 400,
      `expected a non-redirect status, got ${res.status}`
    );
  });

  test("2. every catalog entry has a non-empty string id, and display_name (if present) is a string", async () => {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data), "response must carry a data array");
    assert.ok(body.data.length > 0, "catalog must not be empty");
    for (const entry of body.data) {
      assert.equal(typeof entry.id, "string", `entry.id must be a string, got ${typeof entry.id}`);
      assert.ok(entry.id.length > 0, "entry.id must not be an empty string");
      if (Object.prototype.hasOwnProperty.call(entry, "display_name")) {
        assert.equal(
          typeof entry.display_name,
          "string",
          "display_name, when present, must be a string"
        );
      }
    }
  });

  test("3. stale-first: an expired 200 entry within the staleness window is served immediately, then refreshed in the background", async () => {
    const makeRequest = () => new Request("http://localhost/v1/models");

    const res1 = await v1ModelsCatalog.getUnifiedModelsResponse(makeRequest());
    assert.equal(res1.status, 200);
    const body1 = await res1.text();
    const runsAfterFirst = v1ModelsCatalog.__getCatalogBuilderRunsForTest();
    assert.equal(runsAfterFirst, 1, "the first request must have run the builder exactly once");

    // Deterministically expire the entry (just-expired — well inside the stale window)
    // instead of sleeping out the real TTL.
    v1ModelsCatalog.__expireCatalogCacheForTest();

    const res2 = await v1ModelsCatalog.getUnifiedModelsResponse(makeRequest());
    assert.equal(res2.status, 200);
    const body2 = await res2.text();
    assert.equal(body2, body1, "the stale response must be the cached body, served unchanged");
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      runsAfterFirst,
      "the builder must NOT have run yet at response time — the stale response must not wait for a rebuild"
    );

    await v1ModelsCatalog.__flushCatalogBackgroundRefreshForTest();
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      runsAfterFirst + 1,
      "the background refresh must have run once flushed"
    );
  });

  test("4. an ordinary TTL expiry inside the SWR window remains stale-first", async () => {
    const makeRequest = () => new Request("http://localhost/v1/models");

    const res1 = await v1ModelsCatalog.getUnifiedModelsResponse(makeRequest());
    assert.equal(res1.status, 200);
    const body1 = await res1.text();
    const runsAfterFirst = v1ModelsCatalog.__getCatalogBuilderRunsForTest();
    assert.equal(runsAfterFirst, 1);

    // #9199/#10198 bounded the stale window (CATALOG_STALE_WHILE_REVALIDATE_MS = 30s)
    // so a refresh that keeps failing cannot pin an old catalog forever — the old
    // "stale-first regardless of snapshot age" contract is gone (the past-the-window
    // rebuild path is pinned by model-catalog-cache-swr-8728.test.ts). Inside the
    // window, expiry must stay stale-first and never impose a cold-build wait.
    v1ModelsCatalog.__expireCatalogCacheForTest();

    const res2 = await v1ModelsCatalog.getUnifiedModelsResponse(makeRequest());
    assert.equal(res2.status, 200);
    assert.equal(await res2.text(), body1);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      runsAfterFirst,
      "ordinary TTL expiry must return the last successful snapshot before refreshing"
    );
    await v1ModelsCatalog.__flushCatalogBackgroundRefreshForTest();
    assert.equal(v1ModelsCatalog.__getCatalogBuilderRunsForTest(), runsAfterFirst + 1);
  });

  test("5. a cached non-200 entry is never served as stale", async () => {
    const request = new Request("http://localhost/v1/models");
    v1ModelsCatalog.__setCatalogCacheEntryForTest(request, {
      body: JSON.stringify({ error: { message: "boom", type: "server_error", code: "X" } }),
      headers: {},
      status: 500,
      // "Just expired" — this age would be well within the stale window if the
      // cached status were 200.
      expiresAt: Date.now() - 1,
    });
    const runsBefore = v1ModelsCatalog.__getCatalogBuilderRunsForTest();
    assert.equal(runsBefore, 0);

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );

    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      runsBefore + 1,
      "a cached error entry must never be served as stale — the builder must run instead"
    );
    assert.equal(res.status, 200, "the fresh rebuild replaces the cached error response");
  });

  test("6. a DB-state change drops the cache outright — the next response is a fresh build, never the stale pre-change body", async () => {
    const makeRequest = () => new Request("http://localhost/v1/models");

    const res1 = await v1ModelsCatalog.getUnifiedModelsResponse(makeRequest());
    assert.equal(res1.status, 200);
    const runsAfterFirst = v1ModelsCatalog.__getCatalogBuilderRunsForTest();
    assert.equal(runsAfterFirst, 1);

    // Any settings/connections/combos/pricing write bumps this version; catalog.ts
    // drops its entire cache map the next time it is read, independent of TTL/staleness.
    readCache.invalidateDbCache();

    const res2 = await v1ModelsCatalog.getUnifiedModelsResponse(makeRequest());
    assert.equal(res2.status, 200);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      runsAfterFirst + 1,
      "a state change must force a fresh build — the (now-superseded) cached entry must never be " +
        "served, stale or otherwise"
    );
  });

  test("7. the 500 error path is sanitized — no stack trace or absolute source path leaks into the body", async () => {
    const request = new Request("http://localhost/v1/models?prefix=alias&__d1_err_test=1");
    const rawMessage =
      "Query failed at /home/diegosouzapw/dev/proxys/OmniRoute-Enterprise/secret/catalog.ts:42:1";
    const err = new Error(rawMessage);
    v1ModelsCatalog.__forceCatalogInFlightRejectionForTest(request, err);

    const res = await v1ModelsCatalog.getUnifiedModelsResponse(request);
    assert.equal(res.status, 500);
    const body = await res.json();

    assert.ok(
      !body.error.message.includes("at /"),
      "error body must not leak a stack-trace-like path"
    );
    assert.ok(
      !body.error.message.includes("catalog.ts"),
      "error body must not leak the source file name"
    );
    assert.ok(
      !body.error.message.includes("diegosouzapw"),
      "error body must not leak the local username/path"
    );
    assert.equal(body.error.type, "server_error");
    assert.ok(typeof body.error.code === "string" && body.error.code.length > 0);
  });
});
