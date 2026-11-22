// @ts-nocheck
// /v1/models catalog: compatible provider nodes (prefix / owned_by / apiType), alias-backed ids,
// self-aliased providers in canonical mode, embedding registry merge, noAuth imports and the
// static-vs-synced suppression rules.
//
// Merged from 9 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. Every describe
// resets the database and the catalog builder in its own hooks; the database handle is closed once
// at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-catalog-nodes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";
// Cold catalog builds are bounded by this (8s default); a loaded host would trip it.
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const aliasesDb = await import("../../../src/lib/db/models/aliases.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const modelsRoute = await import("../../../src/app/api/v1/models/route.ts");
const managedAvailableModels =
  await import("../../../src/lib/providerModels/managedAvailableModels.ts");
const embeddingRegistry = await import("../../../open-sse/config/embeddingRegistry.ts");
const { defaultEndpointsForProviderNodeApiType } =
  await import("../../../src/shared/constants/modelSupportedEndpoints.ts");
const { REGISTRY } = await import("@omniroute/open-sse/config/providerRegistry");
const { resetTestDb } = await import("../../helpers/postgres.ts");

after(async () => {
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("8327-models-owned-by-prefix", () => {
  /**
   * Regression test for #8327 — /v1/models leaked the internal provider-node UUID as
   * `owned_by` for synced/custom models on openai-compatible / anthropic-compatible
   * provider nodes, instead of honoring the operator-configured `prefix`.
   *
   * Root cause: `catalog.ts` builds two different identifiers per model entry —
   * `alias` (which DOES receive `providerIdToPrefix` and correctly becomes the
   * configured prefix for the published `id` field) and `canonicalProviderId` (via
   * `resolveCanonicalProviderId()`, catalogProviderMaps.ts), which is used for
   * `owned_by` and never consulted `providerIdToPrefix` at all — for a compatible
   * provider node (UUID id, not present in the static AI_PROVIDERS/PROVIDER_MODELS
   * alias maps) it fell through every lookup and returned the raw UUID verbatim.
   *
   * Fix: resolve `owned_by` through a dedicated `resolvePublicOwnerId()` helper that
   * checks `providerIdToPrefix` first, applied at every emit site (synced-models,
   * custom-models, model-alias, managed-fallback blocks) — WITHOUT changing what
   * `canonicalProviderId` resolves to internally, since that value is still required,
   * unmodified, by connection/hidden-model/registry lookups keyed on the raw node id.
   */

  // A realistic provider-node id shape, matching `openai-compatible-chat-<uuid>` per
  // src/app/api/provider-nodes/route.ts / createProviderNode()'s `id: data.id || uuidv4()`.
  const NODE_ID = "openai-compatible-chat-550e8400-e29b-41d4-a716-446655440000";
  const UUID_SHAPE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const CONFIGURED_PREFIX = "pix4k-talk";

  async function resetStorage() {
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#8327: synced models on a compatible provider node expose the configured prefix as owned_by, not the raw UUID", async () => {
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "pix4k talk (probe)",
      prefix: CONFIGURED_PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    const connection = await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "pix4k-talk-conn",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      NODE_ID,
      (connection as { id: string }).id,
      [
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          source: "imported",
          supportedEndpoints: ["chat"],
        },
      ]
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };

    assert.equal(response.status, 200);

    const entry = body.data.find((m) => m.id === `${CONFIGURED_PREFIX}/glm-5.2`);
    assert.ok(
      entry,
      `expected an entry with id "${CONFIGURED_PREFIX}/glm-5.2" in ${JSON.stringify(body.data.map((m) => m.id))}`
    );
    assert.equal(
      entry!.owned_by,
      CONFIGURED_PREFIX,
      `owned_by must be the configured prefix "${CONFIGURED_PREFIX}", not the raw provider-node id — got "${entry!.owned_by}"`
    );

    // The raw UUID-shaped provider-node id must never appear as owned_by anywhere.
    for (const model of body.data) {
      assert.equal(
        typeof model.owned_by === "string" && UUID_SHAPE_RE.test(model.owned_by),
        false,
        `owned_by "${model.owned_by}" (id "${model.id}") must not be a raw provider-node UUID`
      );
      assert.notEqual(
        model.owned_by,
        NODE_ID,
        `owned_by must never equal the raw provider-node id "${NODE_ID}"`
      );
    }
  });

  test("#8327: custom models on a compatible provider node expose the configured prefix as owned_by", async () => {
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "anthropic-compatible",
      name: "pix4k talk custom (probe)",
      prefix: CONFIGURED_PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/messages",
      modelsPath: "/v1/models",
    });
    await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "pix4k-talk-custom-conn",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/messages",
        modelsPath: "/v1/models",
      },
    });
    await modelsDb.addCustomModel(NODE_ID, "custom-glm", "Custom GLM");

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };

    const entry = body.data.find((m) => m.id === `${CONFIGURED_PREFIX}/custom-glm`);
    assert.ok(
      entry,
      `expected an entry with id "${CONFIGURED_PREFIX}/custom-glm" in ${JSON.stringify(body.data.map((m) => m.id))}`
    );
    assert.equal(
      entry!.owned_by,
      CONFIGURED_PREFIX,
      `owned_by must be the configured prefix "${CONFIGURED_PREFIX}", not the raw provider-node id — got "${entry!.owned_by}"`
    );
    assert.notEqual(entry!.owned_by, NODE_ID);
  });

  test("#8327: built-in providers keep their existing owned_by contract (unaffected by the fix)", async () => {
    await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-main",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };

    const openaiModel = body.data.find(
      (m) => typeof m.id === "string" && (m.id as string).startsWith("openai/")
    );
    assert.ok(openaiModel, "expected at least one openai/* built-in model in the catalog");
    assert.equal(openaiModel!.owned_by, "openai");
  });

  test("#9416: compatible provider with empty prefix falls back to slugified name, not UUID", async () => {
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "PIX4K Talk (production-probe)",
      prefix: "", // empty prefix — should fall back to slugified name
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    const connection = await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "pix4k-talk-conn",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      NODE_ID,
      (connection as { id: string }).id,
      [
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          source: "imported",
          supportedEndpoints: ["chat"],
        },
      ]
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };

    // "PIX4K Talk (production-probe)" → slugified "pix4k-talk-production-probe"
    const expectedPrefix = "pix4k-talk-production-probe";
    const entry = body.data.find((m) => m.id === `${expectedPrefix}/glm-5.2`);
    assert.ok(
      entry,
      `expected an entry with id "${expectedPrefix}/glm-5.2" since prefix was empty, name should slugify — got ids: ${JSON.stringify(body.data.map((m) => m.id))}`
    );
    assert.equal(
      entry!.owned_by,
      expectedPrefix,
      `owned_by must be the slugified name "${expectedPrefix}", not the raw provider-node UUID — got "${entry!.owned_by}"`
    );

    // The raw UUID-shaped provider-node id must never appear as owned_by anywhere.
    for (const model of body.data) {
      assert.equal(
        typeof model.owned_by === "string" && UUID_SHAPE_RE.test(model.owned_by),
        false,
        `owned_by "${model.owned_by}" (id "${model.id}") must not be a raw provider-node UUID`
      );
      assert.notEqual(
        model.owned_by,
        NODE_ID,
        `owned_by must never equal the raw provider-node id "${NODE_ID}"`
      );
    }
  });

  test("#9416: compatible provider with null/undefined prefix also falls back to slugified name", async () => {
    const nodeIdWithoutPrefix = "openai-compatible-chat-660e8400-e29b-41d4-a716-446655440001";
    await providersDb.createProviderNode({
      id: nodeIdWithoutPrefix,
      type: "openai-compatible",
      name: "My Custom Proxy",
      // prefix omitted entirely → should fall back to slugified name
      baseUrl: "https://myproxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    const connection2 = await providersDb.createProviderConnection({
      provider: nodeIdWithoutPrefix,
      authType: "apikey",
      name: "myproxy-conn",
      apiKey: "sk-test-2",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://myproxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      nodeIdWithoutPrefix,
      (connection2 as { id: string }).id,
      [
        {
          id: "my-model-v1",
          name: "My Model V1",
          source: "imported",
          supportedEndpoints: ["chat"],
        },
      ]
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };

    // "My Custom Proxy" → slugified "my-custom-proxy"
    const expectedSlug = "my-custom-proxy";
    const entry = body.data.find((m) => m.id === `${expectedSlug}/my-model-v1`);
    assert.ok(
      entry,
      `expected an entry with id "${expectedSlug}/my-model-v1" — got ids: ${JSON.stringify(body.data.map((m) => m.id))}`
    );
    assert.equal(
      entry!.owned_by,
      expectedSlug,
      `owned_by must be the slugified name "${expectedSlug}", not the raw provider-node id`
    );
    assert.notEqual(entry!.owned_by, nodeIdWithoutPrefix);
  });

  test("#9416: provider with configured prefix still uses the configured prefix (regression guard)", async () => {
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "pix4k talk (probe)",
      prefix: CONFIGURED_PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    const connection = await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "pix4k-talk-conn",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      NODE_ID,
      (connection as { id: string }).id,
      [
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          source: "imported",
          supportedEndpoints: ["chat"],
        },
      ]
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };

    // Must still use the configured prefix, NOT slugified name
    const entry = body.data.find((m) => m.id === `${CONFIGURED_PREFIX}/glm-5.2`);
    assert.ok(entry, `expected entry with configured prefix "${CONFIGURED_PREFIX}/glm-5.2"`);
    assert.equal(entry!.owned_by, CONFIGURED_PREFIX);
    assert.notEqual(entry!.owned_by, "pix4k-talk-probe"); // not slugified
  });
});

describe("8958-alias-backed-node-prefix", () => {
  /**
   * Regression test for #8958 — /v1/models listed alias-backed models for a
   * compatible provider node (openai-compatible / anthropic-compatible, whose id is a
   * UUID) TWICE: once with the correct `prefix/model` id and once with the raw
   * `<node-uuid>/model` id. The duplicate UUID-prefixed entry appeared even under
   * MODELS_CATALOG_PREFIX_MODE=alias, which should only ever emit alias ids.
   *
   * Root cause: the alias-backed loop in `catalog.ts` built its display prefix as
   * `providerIdToAlias[canonicalProviderId] || providerKey` and never consulted
   * `providerIdToPrefix` (unlike the synced-models / custom-models loops). For a
   * compatible node the alias fell through to the raw UUID `providerKey`, and the
   * dedupe (which only checks `alias/model` and `providerKey/model`, both
   * UUID-prefixed) never matched the correct `prefix/model` row already emitted.
   *
   * Fix: `const alias = providerIdToPrefix[providerKey] || providerIdToAlias[...] ||
   * providerKey;` — the id then collapses to `prefix/model` and the existing dedupe
   * skips the duplicate.
   */
  const NODE_ID = "openai-compatible-chat-550e8400-e29b-41d4-a716-446655440000";
  const UUID_SHAPE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const CONFIGURED_PREFIX = "fta";
  const MODEL_ID = "opc/big-pickle";

  async function resetStorage() {
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  async function seedCompatibleNodeWithAlias() {
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "fta (probe)",
      prefix: CONFIGURED_PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    const connection = await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "fta-conn",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    // Synced entry — produces the correct `fta/opc/big-pickle` row.
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      NODE_ID,
      (connection as { id: string }).id,
      [{ id: MODEL_ID, name: "Big Pickle", source: "imported", supportedEndpoints: ["chat"] }]
    );

    // Alias row pointing at the node UUID — as combos/imports register unprefixed
    // shortcuts. This is what triggered the duplicate `<uuid>/model` entry.
    await aliasesDb.setModelAlias("big-pickle", `${NODE_ID}/${MODEL_ID}`);
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#8958: alias-backed model on a compatible node is not duplicated under the raw UUID prefix (alias mode)", async () => {
    await seedCompatibleNodeWithAlias();

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models?prefix=alias")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    assert.equal(response.status, 200);

    const ids = body.data.map((m) => m.id) as string[];

    // The correct prefixed id is present exactly once.
    assert.equal(
      ids.filter((id) => id === `${CONFIGURED_PREFIX}/${MODEL_ID}`).length,
      1,
      `expected exactly one "${CONFIGURED_PREFIX}/${MODEL_ID}" in ${JSON.stringify(ids)}`
    );

    // No id leaks the raw provider-node UUID.
    for (const id of ids) {
      assert.equal(
        id.startsWith(`${NODE_ID}/`),
        false,
        `id "${id}" must not be prefixed with the raw provider-node UUID`
      );
      assert.equal(
        UUID_SHAPE_RE.test(id.split("/")[0]),
        false,
        `id "${id}" must not carry a UUID-shaped provider prefix`
      );
    }
  });

  test("#8958: alias-backed duplicate is absent in default and dual modes too", async () => {
    await seedCompatibleNodeWithAlias();

    for (const query of ["", "?prefix=dual"]) {
      const response = await v1ModelsCatalog.getUnifiedModelsResponse(
        new Request(`http://localhost/api/v1/models${query}`)
      );
      const body = (await response.json()) as { data: Array<Record<string, unknown>> };
      const ids = body.data.map((m) => m.id) as string[];

      assert.ok(
        ids.includes(`${CONFIGURED_PREFIX}/${MODEL_ID}`),
        `mode "${query || "default"}": expected "${CONFIGURED_PREFIX}/${MODEL_ID}"`
      );
      assert.equal(
        ids.some((id) => id.startsWith(`${NODE_ID}/`)),
        false,
        `mode "${query || "default"}": no id may carry the raw provider-node UUID prefix`
      );
    }
  });
});

describe("9034-alias-backed-prefix-id-repro", () => {
  /**
   * Regression test for #9034 — /v1/models alias-backed emission block (catalog.ts ~:1298)
   * leaked the raw provider-node UUID as the published model `id` for alias-backed models
   * (synced via `syncManagedAvailableModelAliases`), instead of the operator-configured
   * prefix. The #8327 fix only covered `owned_by`; the routable model `id` was missed.
   *
   * Root cause: the alias-backed block builds `alias` as
   * `providerIdToAlias[canonicalProviderId] || providerKey` and never consults
   * `providerIdToPrefix`. For a compatible provider node, the storage prefix is the raw
   * node UUID (managedAvailableModels.getProviderStoragePrefix()), so `providerKey` is the
   * node UUID and the catalog re-publishes it as the public model `id` (e.g.
   * `openai-compatible-chat-550e8400-.../kimi-k2`) instead of the configured prefix.
   *
   * Fix: resolve `const prefix = providerIdToPrefix[providerKey] ?? providerIdToPrefix[canonicalProviderId]`
   * and `const alias = prefix || providerIdToAlias[canonicalProviderId] || providerKey`,
   * plus add `!prefix` to the includeCanonical guard (mirroring synced :896 / custom :1245).
   */

  // A realistic provider-node id shape, matching `openai-compatible-chat-<uuid>`
  const NODE_ID = "openai-compatible-chat-550e8400-e29b-41d4-a716-446655440000";
  const CONFIGURED_PREFIX = "myprefix";
  const MODEL_NAME = "kimi-k2";

  async function resetStorage() {
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    // The standalone file ran on a fresh database; the merged file reuses one.
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  before(async () => {
    await resetStorage();
  });

  test("#9034: alias-backed model id must use the configured prefix, not the raw provider-node UUID", async () => {
    // Create an openai-compatible provider node with a configured prefix
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "test node (probe)",
      prefix: CONFIGURED_PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "test-conn",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    // The real producer path: syncManagedAvailableModelAliases stores aliases as
    // `<UUID>/<modelId>` (getProviderStoragePrefix returns raw node id for compatible providers).
    // This creates a key_value alias entry that the alias-backed block in catalog.ts reads.
    await managedAvailableModels.syncManagedAvailableModelAliases(NODE_ID, [MODEL_NAME]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const ids = body.data.map((m) => m.id as string);

    assert.equal(response.status, 200);

    // (a) The configured prefix must be used in the model id
    const expectedId = `${CONFIGURED_PREFIX}/${MODEL_NAME}`;
    assert.ok(
      ids.includes(expectedId),
      `expected model id "${expectedId}" to exist in /v1/models — got: ${JSON.stringify(ids)}`
    );

    // (b) No entry id should start with the raw node UUID when a prefix is configured
    for (const id of ids) {
      assert.equal(
        id.startsWith(NODE_ID),
        false,
        `entry id "${id}" must not start with the raw provider-node UUID "${NODE_ID}" when a prefix ("${CONFIGURED_PREFIX}") is configured`
      );
    }
  });
});

describe("12058-models-catalog-canonical-self-aliased", () => {
  /**
   * Regression test for #12058 — `MODELS_CATALOG_PREFIX_MODE=canonical` (or
   * `?prefix=canonical`) dropped every chat row of a *self-aliased* provider: a
   * registry entry whose `alias` is undefined (`antigravity`) or equal to its own id
   * (`agy`, and most built-in providers).
   *
   * Root cause: every emission loop in `catalog.ts` pushes the `alias/model` row only
   * when `includeAlias` is set and the `canonicalProviderId/model` row only when
   * `canonicalProviderId !== alias` (a dual-mode duplicate guard). For a self-aliased
   * provider both ids are the same string, so in canonical mode neither branch fires
   * and the provider vanishes. #11832 / PR #11918 fixed the same class for custom
   * provider nodes (`includeAlias || Boolean(prefix)`) but left built-in providers
   * behind.
   *
   * Fix: treat the alias row as the canonical row whenever the two ids coincide, in
   * the static, synced, custom and alias-backed loops alike. `alias` and `dual` modes
   * already emitted that single row, so their output must not change.
   */
  // Every `getRows()` call resets the builder, so each one is a *cold* catalog build; the
  // timeout is pinned out of the way at the top of the file exactly like #12627 does.

  type CatalogRow = { id: string; parent: string | null; root: string | null };
  type PrefixMode = "alias" | "canonical" | "dual";

  // Both ship this id in their curated static catalog (ANTIGRAVITY_PUBLIC_MODELS /
  // AGY_PUBLIC_MODELS). `antigravity` has `alias: undefined`, `agy` has `alias: "agy"`.
  const SELF_ALIASED_PROVIDERS = ["antigravity", "agy"] as const;
  const STATIC_MODEL_ID = "gemini-3.8-flash-high";

  // A self-aliased api-key provider used to exercise the synced / custom /
  // alias-backed loops, which carry the same guard as the static loop.
  const SYNCED_PROVIDER = "groq";
  const SYNCED_MODEL_ID = "probe-synced-12058";
  // A synced audio model must survive too (it is a chat-loop row with `type: "audio"`).
  const SYNCED_AUDIO_MODEL_ID = "probe-tts-12058";
  const CUSTOM_MODEL_ID = "probe-custom-12058";
  const ALIAS_BACKED_MODEL_ID = "probe-alias-backed-12058";

  // Control: a normally-aliased provider (alias `cc`, canonical `claude`) whose
  // mode gating must stay exactly as it was.
  const CONTROL_ALIAS_ID = "cc/claude-sonnet-4-6";
  const CONTROL_CANONICAL_ID = "claude/claude-sonnet-4-6";

  async function resetStorage() {
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  async function seedOauthConnection(provider: string) {
    await providersDb.createProviderConnection({
      provider,
      authType: "oauth",
      name: `${provider}-12058`,
      apiKey: null,
      accessToken: `${provider}-access-token`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  async function seedCatalog() {
    for (const provider of SELF_ALIASED_PROVIDERS) await seedOauthConnection(provider);
    await seedOauthConnection("claude");

    const connection = await providersDb.createProviderConnection({
      provider: SYNCED_PROVIDER,
      authType: "apikey",
      name: `${SYNCED_PROVIDER}-12058`,
      apiKey: "sk-test-12058",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      SYNCED_PROVIDER,
      (connection as { id: string }).id,
      [
        { id: SYNCED_MODEL_ID, source: "imported", supportedEndpoints: ["chat"] },
        { id: SYNCED_AUDIO_MODEL_ID, source: "imported", supportedEndpoints: ["audio-speech"] },
      ]
    );
    await modelsDb.addCustomModel(SYNCED_PROVIDER, CUSTOM_MODEL_ID, "Probe Custom 12058");
    await aliasesDb.setModelAlias(
      ALIAS_BACKED_MODEL_ID,
      `${SYNCED_PROVIDER}/${ALIAS_BACKED_MODEL_ID}`
    );
  }

  async function getRows(mode: PrefixMode): Promise<CatalogRow[]> {
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request(`http://localhost/api/v1/models?prefix=${mode}`)
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: CatalogRow[] };
    return body.data;
  }

  function idsWithPrefix(rows: CatalogRow[], prefix: string): string[] {
    return rows.map((row) => row.id).filter((id) => id.startsWith(`${prefix}/`));
  }

  function duplicates(rows: CatalogRow[]): string[] {
    const ids = rows.map((row) => row.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  }

  function assertExactlyOnce(rows: CatalogRow[], id: string, mode: PrefixMode) {
    const matches = rows.filter((row) => row.id === id);
    assert.equal(
      matches.length,
      1,
      `${mode} mode: expected exactly one "${id}", got ${matches.length}`
    );
    return matches[0];
  }

  beforeEach(async () => {
    await resetStorage();
    await seedCatalog();
  });

  test("#12058 canonical mode lists the curated models of self-aliased providers once, re-rooted", async () => {
    const rows = await getRows("canonical");

    for (const provider of SELF_ALIASED_PROVIDERS) {
      const row = assertExactlyOnce(rows, `${provider}/${STATIC_MODEL_ID}`, "canonical");
      // The single surviving row is the head of its chain: no parent to point at.
      assert.equal(row.parent, null, `${provider}: the canonical row must not carry a parent`);
      assert.equal(row.root, STATIC_MODEL_ID, `${provider}: root must be the bare model id`);

      // Anti-vacuity: the whole curated chat catalog is back, not just the sampled id.
      const listed = idsWithPrefix(rows, provider);
      assert.ok(
        listed.length >= 5,
        `${provider}: expected the curated catalog in canonical mode, got ${JSON.stringify(listed)}`
      );
    }

    assert.deepEqual(duplicates(rows), [], "canonical mode must not emit duplicate ids");
  });

  test("#12058 canonical mode keeps synced, custom and alias-backed rows of a self-aliased provider", async () => {
    const rows = await getRows("canonical");

    for (const modelId of [
      SYNCED_MODEL_ID,
      SYNCED_AUDIO_MODEL_ID,
      CUSTOM_MODEL_ID,
      ALIAS_BACKED_MODEL_ID,
    ]) {
      const row = assertExactlyOnce(rows, `${SYNCED_PROVIDER}/${modelId}`, "canonical");
      assert.equal(row.parent, null, `${modelId}: the canonical row must not carry a parent`);
    }
  });

  test("#12058 canonical mode still suppresses the alias row of a normally-aliased provider", async () => {
    // Guards against "fixing" the defect by disabling the alias gate outright.
    const rows = await getRows("canonical");
    const ids = new Set(rows.map((row) => row.id));

    assert.ok(
      ids.has(CONTROL_CANONICAL_ID),
      `expected "${CONTROL_CANONICAL_ID}" in canonical mode`
    );
    assert.equal(
      ids.has(CONTROL_ALIAS_ID),
      false,
      `"${CONTROL_ALIAS_ID}" must stay suppressed in canonical mode`
    );
  });

  test("#12058 self-aliased providers emit the same single id set in every mode; alias/dual stay unchanged", async () => {
    const byMode = {
      alias: await getRows("alias"),
      canonical: await getRows("canonical"),
      dual: await getRows("dual"),
    } satisfies Record<PrefixMode, CatalogRow[]>;

    for (const mode of ["alias", "dual"] as const) {
      assert.deepEqual(duplicates(byMode[mode]), [], `${mode} mode must not emit duplicate ids`);
    }

    // A self-aliased provider has exactly one id form, so all three modes must agree.
    for (const provider of [...SELF_ALIASED_PROVIDERS, SYNCED_PROVIDER]) {
      const aliasIds = idsWithPrefix(byMode.alias, provider).sort();
      assert.ok(aliasIds.length > 0, `${provider}: alias mode must list the provider at all`);
      assert.deepEqual(
        idsWithPrefix(byMode.canonical, provider).sort(),
        aliasIds,
        `${provider}: canonical mode must list the same ids as alias mode`
      );
      assert.deepEqual(
        idsWithPrefix(byMode.dual, provider).sort(),
        aliasIds,
        `${provider}: dual mode must list the same ids as alias mode`
      );
    }

    // The normally-aliased control keeps its per-mode shape.
    const aliasIds = new Set(byMode.alias.map((row) => row.id));
    const dualIds = new Set(byMode.dual.map((row) => row.id));
    assert.ok(aliasIds.has(CONTROL_ALIAS_ID), "alias mode keeps the cc/ row");
    assert.equal(
      aliasIds.has(CONTROL_CANONICAL_ID),
      false,
      "alias mode suppresses the claude/ row"
    );
    assert.ok(dualIds.has(CONTROL_ALIAS_ID), "dual mode keeps the cc/ row");
    assert.ok(dualIds.has(CONTROL_CANONICAL_ID), "dual mode keeps the claude/ row");
  });
});

describe("11759-embedding-registry-width-and-type", () => {
  /**
   * Regression test for #11759 — `/v1/models` dropped the vector width and the
   * `embedding` type from embedding models that `embeddingRegistry.ts` describes,
   * whenever a synced model existed for the same id.
   *
   * `embeddingRegistry.ts` is the only machine-readable source of two facts: a model's
   * vector width, and that it is an embedding model at all. No upstream provider
   * publishes either — OpenRouter's catalogue carries no `dimensions`, and OpenAI's
   * `/v1/models` returns ids with no capability information.
   *
   * Two paths lost them:
   *
   *  - Width. The registry loop skipped its entry outright when discovery had already
   *    produced the model (`hasEquivalentSpecialtyModel(...) continue`), so the surviving
   *    entry was the discovered one — typed, but with no `dimensions`.
   *
   *  - Type. Classification comes from `sm.supportedEndpoints`, which falls back to
   *    `["chat"]`. A provider that does not report endpoints therefore yielded
   *    `modelType === undefined` and the `type` key was omitted entirely, so an embedding
   *    model read as a chat model.
   *
   * A consumer that stores vectors needs both: collections are keyed on width, and an
   * untyped model cannot be identified as an embedding model. These tests assert the
   * merged `/v1/models` output, not the registry in isolation — the registry was always
   * correct; the loss happened in `catalog.ts`.
   */
  // These cases assert catalog contents, not the cold-build time bound (#13438): the timeout
  // is pinned at the top of the file.

  /** Both are real registry entries, so the expected widths come from the registry itself. */
  const OPENROUTER_MODEL = "qwen/qwen3-embedding-8b";
  const OPENAI_MODEL = "text-embedding-3-small";

  function registryWidth(providerId: string, modelId: string): number {
    const provider = embeddingRegistry.getEmbeddingProvider(providerId);
    assert.ok(provider, `embeddingRegistry has no provider "${providerId}"`);
    const model = provider!.models.find((m) => m.id === modelId);
    assert.ok(model, `embeddingRegistry has no model "${modelId}" on "${providerId}"`);
    const { dimensions } = model!;
    assert.equal(
      typeof dimensions,
      "number",
      `this test assumes a single advertised width for "${modelId}"`
    );
    return dimensions as number;
  }

  async function resetStorage() {
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  /** An active connection, which is what makes the provider's registry models eligible. */
  async function connectProvider(provider: string) {
    return (await providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider}-conn`,
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
    })) as { id: string };
  }

  async function modelEntry(id: string) {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const entry = body.data.find((model) => model.id === id);
    assert.ok(
      entry,
      `expected "${id}" in /v1/models, got ${JSON.stringify(
        body.data.filter((m) => String(m.id).includes("embedding")).map((m) => m.id)
      )}`
    );
    return entry!;
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#11759: a synced embedding model keeps the width the registry states", async () => {
    const connection = await connectProvider("openrouter");

    // What discovery produces for OpenRouter: typed as an embedding model, and carrying no
    // width, because the upstream catalogue does not publish one.
    await modelsDb.replaceSyncedAvailableModelsForConnection("openrouter", connection.id, [
      {
        id: OPENROUTER_MODEL,
        name: "Qwen3 Embedding 8B",
        source: "imported",
        supportedEndpoints: ["embeddings"],
      },
    ]);

    const entry = await modelEntry(`openrouter/${OPENROUTER_MODEL}`);
    const expected = registryWidth("openrouter", OPENROUTER_MODEL);

    assert.equal(
      entry.dimensions,
      expected,
      `the registry states ${expected} for "${OPENROUTER_MODEL}"; the synced entry must not drop it — got ${JSON.stringify(entry.dimensions)}`
    );
    assert.equal(entry.type, "embedding", "a synced embedding model must stay typed as one");
  });

  test("#11759: a synced model the embedding registry names is typed as an embedding model", async () => {
    const connection = await connectProvider("openai");

    // What discovery produces for OpenAI: no `supportedEndpoints`, because `/v1/models`
    // returns ids with no capability information, so classification falls back to `["chat"]`
    // and the model is emitted with no `type` at all.
    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connection.id, [
      {
        id: OPENAI_MODEL,
        name: "Text Embedding 3 Small",
        source: "imported",
      },
    ]);

    const entry = await modelEntry(`openai/${OPENAI_MODEL}`);

    assert.equal(
      entry.type,
      "embedding",
      `"${OPENAI_MODEL}" is in the embedding registry, so it must not be published untyped — got ${JSON.stringify(entry.type)}`
    );
    assert.equal(
      entry.dimensions,
      registryWidth("openai", OPENAI_MODEL),
      "an embedding model published without its width cannot be indexed by a consumer"
    );
  });
});

describe("catalog-provider-node-apitype-endpoints", () => {
  // Regression tests: /v1/models types compatible-provider-node rows by the node's apiType.
  //
  // Model rows discovered from a local OpenAI-compatible node rarely carry endpoint
  // metadata (a TEI/Infinity/vLLM `/v1/models` listing is just ids), and the catalog
  // defaulted such rows to `["chat"]`. So an `embeddings`-typed node exposing `bge-m3`
  // and a `rerank`-typed node exposing `bge-reranker-v2-m3` both surfaced in `/v1/models`
  // as untyped chat models — clients that build their picker from `type: "embedding"` /
  // `type: "rerank"` never saw them, and chat pickers listed models that 400 on chat.
  //
  // Rows with no explicit `supportedEndpoints` now inherit the node's modality; a manual
  // overlay row that sets `supportedEndpoints: ["rerank"]` on top of a discovered row also
  // re-types the merged entry.
  interface CatalogRow {
    id: string;
    type?: string;
    subtype?: string;
    owned_by?: string;
    supported_endpoints?: string[];
  }

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  // The standalone file started on a fresh database; reset before the first test too.
  before(async () => {
    await resetStorage();
  });

  afterEach(async () => {
    await resetStorage();
  });

  test("defaultEndpointsForProviderNodeApiType maps node apiType to a modality", () => {
    assert.deepEqual(defaultEndpointsForProviderNodeApiType("embeddings"), ["embeddings"]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType("rerank"), ["rerank"]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType("audio-speech"), ["audio-speech"]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType("audio-transcriptions"), [
      "audio-transcriptions",
    ]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType("images-generations"), ["images"]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType("chat"), ["chat"]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType("responses"), ["chat"]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType(undefined), ["chat"]);
    assert.deepEqual(defaultEndpointsForProviderNodeApiType(" RERANK "), ["rerank"]);
  });

  async function createNode(id: string, prefix: string, apiType: string) {
    await providersDb.createProviderNode({
      id,
      type: "openai-compatible",
      name: prefix,
      prefix,
      apiType,
      baseUrl: "http://10.10.50.19:8888/v1",
      modelsPath: "/v1/models",
    });
    const connection = await providersDb.createProviderConnection({
      provider: id,
      authType: "apikey",
      name: `${prefix}-main`,
      apiKey: "sk-test",
      isActive: true,
      providerSpecificData: { baseUrl: "http://10.10.50.19:8888/v1", prefix, apiType },
    });
    return connection;
  }

  async function fetchCatalog(): Promise<CatalogRow[]> {
    invalidateDbCache("nodes");
    invalidateDbCache("connections");
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models", { method: "GET" })
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: CatalogRow[] };
    return body.data;
  }

  test("synced rows on an embeddings node without endpoint metadata are typed embedding", async () => {
    const connection = await createNode(
      "openai-compatible-embeddings-node-a",
      "skilled-mini",
      "embeddings"
    );
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "openai-compatible-embeddings-node-a",
      (connection as { id: string }).id,
      [{ id: "bge-m3", name: "bge-m3" }]
    );

    const rows = await fetchCatalog();
    const row = rows.find((r) => r.id === "skilled-mini/bge-m3");
    assert.ok(row, "expected skilled-mini/bge-m3 in /v1/models");
    assert.equal(row.type, "embedding");
    assert.equal(row.owned_by, "skilled-mini");
  });

  test("synced rows on a rerank node without endpoint metadata are typed rerank", async () => {
    const connection = await createNode("openai-compatible-rerank-node-b", "skilled-rr", "rerank");
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "openai-compatible-rerank-node-b",
      (connection as { id: string }).id,
      [{ id: "bge-reranker-v2-m3", name: "bge-reranker-v2-m3" }]
    );

    const rows = await fetchCatalog();
    const row = rows.find((r) => r.id === "skilled-rr/bge-reranker-v2-m3");
    assert.ok(row, "expected skilled-rr/bge-reranker-v2-m3 in /v1/models");
    assert.equal(row.type, "rerank");
  });

  test("explicit supportedEndpoints on a synced row still win over the node apiType", async () => {
    const connection = await createNode(
      "openai-compatible-embeddings-node-c",
      "mixed",
      "embeddings"
    );
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "openai-compatible-embeddings-node-c",
      (connection as { id: string }).id,
      [
        { id: "bge-m3", name: "bge-m3" },
        { id: "bge-reranker-v2-m3", name: "bge-reranker-v2-m3", supportedEndpoints: ["rerank"] },
      ]
    );

    const rows = await fetchCatalog();
    assert.equal(rows.find((r) => r.id === "mixed/bge-m3")?.type, "embedding");
    assert.equal(rows.find((r) => r.id === "mixed/bge-reranker-v2-m3")?.type, "rerank");
  });

  test("chat nodes keep the historical chat default (no type)", async () => {
    const connection = await createNode("openai-compatible-chat-node-d", "homegw", "chat");
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "openai-compatible-chat-node-d",
      (connection as { id: string }).id,
      [{ id: "qwen3-8b", name: "qwen3-8b" }]
    );

    const rows = await fetchCatalog();
    const row = rows.find((r) => r.id === "homegw/qwen3-8b");
    assert.ok(row, "expected homegw/qwen3-8b in /v1/models");
    assert.equal(row.type, undefined);
  });

  test("a manual overlay with supportedEndpoints re-types a discovered chat-default row", async () => {
    const connection = await createNode("openai-compatible-chat-node-e", "gw", "chat");
    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "openai-compatible-chat-node-e",
      (connection as { id: string }).id,
      [{ id: "bge-reranker-v2-m3", name: "bge-reranker-v2-m3" }]
    );
    await modelsDb.addCustomModel(
      "openai-compatible-chat-node-e",
      "bge-reranker-v2-m3",
      "bge-reranker-v2-m3",
      "manual",
      "rerank",
      ["rerank"]
    );

    const rows = await fetchCatalog();
    const matches = rows.filter((r) => r.id === "gw/bge-reranker-v2-m3");
    assert.equal(matches.length, 1, "overlay merges into the discovered row, no duplicate");
    assert.equal(matches[0].type, "rerank");
    assert.deepEqual(matches[0].supported_endpoints, ["rerank"]);
  });
});

describe("models-catalog-custom-node-prefix", () => {
  const NODE_ID = "openai-compatible-chat-550e8400-e29b-41d4-a716-446655440000";
  const PREFIX = "infrex";
  const EXPECTED_IDS = [
    `${PREFIX}/synced-model`,
    `${PREFIX}/custom-model`,
    `${PREFIX}/alias-backed-model`,
  ];

  async function resetStorage(): Promise<void> {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  async function seedCustomNode(): Promise<void> {
    await providersDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "Infrex",
      prefix: PREFIX,
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/chat/completions",
      modelsPath: "/v1/models",
    });
    const connection = await providersDb.createProviderConnection({
      provider: NODE_ID,
      authType: "apikey",
      name: "infrex-primary",
      apiKey: "test-key",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {
        baseUrl: "https://proxy.example.com",
        chatPath: "/v1/chat/completions",
        modelsPath: "/v1/models",
      },
    });

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      NODE_ID,
      (connection as { id: string }).id,
      [{ id: "synced-model", source: "imported", supportedEndpoints: ["chat"] }]
    );
    await modelsDb.addCustomModel(NODE_ID, "custom-model", "Custom Model");
    await aliasesDb.setModelAlias("alias-backed-model", `${NODE_ID}/alias-backed-model`);
  }

  async function getCatalogIds(mode: "alias" | "canonical" | "dual"): Promise<string[]> {
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/v1/models?prefix=${mode}`)
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    return body.data.map((model) => model.id);
  }

  function assertCustomNodeModels(ids: string[]): void {
    const actualCustomNodeIds = ids.filter((id) => EXPECTED_IDS.includes(id)).sort();
    assert.deepEqual(
      actualCustomNodeIds,
      [...EXPECTED_IDS].sort(),
      `expected each custom node source exactly once in ${JSON.stringify(ids)}`
    );
    assert.equal(
      ids.some((id) => id.startsWith(`${NODE_ID}/`)),
      false,
      "catalog must not expose the internal provider node id"
    );
  }

  beforeEach(async () => {
    await resetStorage();
    await seedCustomNode();
  });

  test("alias mode exposes every custom node model under its configured prefix", async () => {
    assertCustomNodeModels(await getCatalogIds("alias"));
  });

  test("canonical mode keeps custom node models under their configured prefix", async () => {
    assertCustomNodeModels(await getCatalogIds("canonical"));
  });

  test("dual mode exposes each custom node model once under its configured prefix", async () => {
    assertCustomNodeModels(await getCatalogIds("dual"));
  });
});

describe("noauth-imported-models-3200", () => {
  // Regression test for #3200 — imported/custom models on noAuth providers were missing
  // from GET /api/v1/models (and therefore from the Playground model dropdown), while
  // BUILT-IN and CUSTOM models on regular auth providers showed up fine.
  //
  // Root cause: the custom-models loop in catalog.ts gated every model through
  // hasEligibleConnectionForModel(getConnectionsForProvider(...)). noAuth providers
  // (e.g. duckduckgo-web / alias "ddgw") have NO DB connection rows, so getConnectionsForProvider
  // returns [] and hasEligibleConnectionForModel([]) === false → the model was dropped.
  // Built-in models survived because they go through providerSupportsModel(), which has a
  // noAuth bypass (#2798). This test asserts an IMPORTED model on a noAuth provider appears.

  async function resetStorage() {
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#3200 imported model on a noAuth provider (duckduckgo-web) appears in /api/v1/models", async () => {
    // duckduckgo-web is a noAuth provider (alias "ddgw") — it never creates a DB connection row.
    // Import a model that is NOT a built-in duckduckgo-web model, so its presence is solely due
    // to the custom/imported path (the path the bug breaks).
    await modelsDb.addCustomModel(
      "duckduckgo-web",
      "my-imported-model-3200",
      "My Imported Model",
      "imported"
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = new Set(body.data.map((m) => m.id));

    assert.equal(response.status, 200);
    assert.ok(
      ids.has("ddgw/my-imported-model-3200"),
      "imported model on noAuth provider must appear under its alias prefix"
    );
  });

  test("#3200 custom/imported models on auth providers still appear (no regression)", async () => {
    // kiro is an auth provider; with a manual custom model added, the alias-prefixed id
    // must still be present (the active-connection eligibility path is unchanged).
    // No connection seeded here — kiro custom models require an eligible connection, so
    // this guards that the fix does NOT make auth-provider custom models appear without one.
    await modelsDb.addCustomModel("kiro", "custom-kiro-3200", "Custom Kiro");

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = new Set(body.data.map((m) => m.id));

    assert.equal(response.status, 200);
    // Auth provider with NO active connection → custom model must NOT leak in.
    assert.equal(
      ids.has("kiro/custom-kiro-3200"),
      false,
      "auth-provider custom model must stay gated behind an eligible connection"
    );
  });

  test("#3200 imported models on noAuth providers are hidden when the provider is disabled", async () => {
    await settingsDb.updateSettings({ blockedProviders: ["duckduckgo-web"] });
    await modelsDb.addCustomModel(
      "duckduckgo-web",
      "my-imported-model-disabled",
      "Hidden Imported Model",
      "imported"
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = new Set(body.data.map((m) => m.id));

    assert.equal(response.status, 200);
    assert.equal(
      ids.has("ddgw/my-imported-model-disabled"),
      false,
      "imported noAuth provider models must stay hidden while the provider is disabled"
    );
  });
});

describe("models-catalog-static-synced-suppression", () => {
  const LIVE_MODEL = "google/gemma-4-31b-it";

  function getStaticModel(provider: string) {
    const model = REGISTRY[provider]?.models?.[0];
    assert.ok(model, `${provider} must define a static registry model for this regression test`);
    return model;
  }

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(path.join(TEST_DATA_DIR, "logs/application"), { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  async function seedConnection(provider: string, name: string) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name,
      apiKey: "test-api-key",
      isActive: true,
      testStatus: "active",
    });
  }

  async function getCatalogIds(): Promise<Set<string>> {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string }> };

    assert.equal(response.status, 200);
    return new Set(body.data.map((model) => model.id));
  }

  beforeEach(resetStorage);

  test("active authoritative live catalog suppresses stale static registry models", async () => {
    const staticNvidiaModel = getStaticModel("nvidia").id;
    const connection = await seedConnection("nvidia", "nvidia-static-synced-suppression");
    await modelsDb.replaceSyncedAvailableModelsForConnection("nvidia", connection.id as string, [
      { id: LIVE_MODEL, name: "Gemma 4 31B", source: "imported" },
    ]);

    const ids = await getCatalogIds();

    assert.equal(ids.has(`nvidia/${LIVE_MODEL}`), true);
    assert.equal(ids.has(`nvidia/${staticNvidiaModel}`), false);
  });

  test("static registry remains fallback when active connection has no live catalog", async () => {
    const staticNvidiaModel = getStaticModel("nvidia").id;
    await seedConnection("nvidia", "nvidia-fallback-static");

    const ids = await getCatalogIds();

    assert.equal(ids.has(`nvidia/${staticNvidiaModel}`), true);
  });

  // #14779: bare glm now opts out of authoritative gating (no live discovery), so xai
  // (real live discovery, default-authoritative) carries this regression.
  test("authoritative live catalog suppresses static effort-tier variants on sync", async () => {
    const connection = await seedConnection("xai", "xai-authoritative-effort-suppression");
    const staticModel = REGISTRY.xai?.models?.find(
      (model) =>
        Array.isArray(model.supportedThinkingEfforts) && model.supportedThinkingEfforts.length > 0
    );
    assert.ok(staticModel, "xai must define an effort-tier static model for this regression test");
    const effort = staticModel.supportedThinkingEfforts?.[0];
    assert.ok(effort, "xai static model must declare at least one effort tier");

    await modelsDb.replaceSyncedAvailableModelsForConnection("xai", connection.id as string, [
      { id: "xai-synced", name: "xAI Synced", source: "imported" },
    ]);

    const ids = await getCatalogIds();

    assert.equal(ids.has("xai/xai-synced"), true);
    assert.equal(ids.has(`xai/${staticModel.id}`), false);
    assert.equal(ids.has(`xai/${staticModel.id}-${effort}`), false);
  });

  test("partial discovery provider preserves uncovered static models when synced", async () => {
    const connection = await seedConnection("command-code", "command-code-partial-discovery");
    const uncoveredStaticModel = "deepseek/deepseek-v4-flash";
    const coveredSyncedModel = "claude-opus-4-7";

    await modelsDb.replaceSyncedAvailableModelsForConnection(
      "command-code",
      connection.id as string,
      [{ id: coveredSyncedModel, name: "Claude Opus 4.7", source: "imported" }]
    );

    const ids = await getCatalogIds();

    assert.equal(ids.has(`cmd/${coveredSyncedModel}`), true);
    assert.equal(ids.has(`cmd/${uncoveredStaticModel}`), true);
  });
});
