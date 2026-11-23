import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-felo-runtime-block-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const providerNodesDb = await import("../../../src/lib/db/providers/nodes.ts");
const modelAliasesDb = await import("../../../src/lib/db/models/aliases.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const modelAliasResolver = await import("../../../src/lib/modelAliasResolver.ts");
const providerPrefixIndex = await import("../../../src/lib/providerNodePrefixes.ts");
const { hashLeaseOwnerId } = await import("../../../src/lib/db/exclusiveConnectionLeases.ts");
const { getProviderCredentials } = await import("../../../src/sse/services/auth.ts");
const { getModelInfo } = await import("../../../src/sse/services/model.ts");
const { resolveModelOrError } = await import("../../../src/sse/handlers/chatHelpers.ts");
const chatRoute = await import("../../../src/app/api/v1/chat/completions/route.ts");

const originalFetch = globalThis.fetch;

const RETIRED_PROVIDER_VARIANTS = [
  "felo-web",
  "felo",
  " FeLo-Web ",
  "\tFELO\n",
  " FELO-WEB﻿",
  " felo ",
  "　FELO-WEB　",
] as const;

async function resetStorage() {
  await resetTestDb();
  modelAliasResolver.invalidateAliasCache();
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => setImmediate(resolve));
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function isRetiredError(error: unknown): boolean {
  const typed = error as Error & { code?: string; status?: number };
  assert.equal(typed.code, "PROVIDER_RETIRED");
  assert.equal(typed.status, 410);
  assert.match(typed.message, /retired/i);
  return true;
}

test("retired Felo model prefixes cannot shadow custom compatible nodes", async () => {
  // Prefixes are unique case-insensitively (provider_nodes_prefix_uq on lower(btrim(prefix))), so
  // "FeLo-WeB" and "FELO" cannot be created next to "felo-web" and "felo". Those spellings are
  // still checked below through the retired-identity path.
  const nodeIdsByPrefix = new Map<string, string>();
  for (const [index, providerId] of ["felo-web", "felo"].entries()) {
    const nodeId = `openai-compatible-chat-retired-felo-prefix-${index}`;
    await providerNodesDb.createProviderNode({
      id: nodeId,
      type: "openai-compatible",
      name: `Retired prefix ${providerId}`,
      prefix: providerId,
      apiType: "chat",
      baseUrl: "https://retired.example.invalid/v1",
    });
    nodeIdsByPrefix.set(providerId, nodeId);
  }
  for (const providerId of ["felo-web", "felo", "FeLo-WeB", "FELO"]) {
    await assert.rejects(() => getModelInfo(`${providerId}/gpt-4o`), isRetiredError);
  }

  const prefixIndex = await providerPrefixIndex.getProviderPrefixIndex();
  for (const [providerId, nodeId] of nodeIdsByPrefix) {
    assert.equal(
      prefixIndex.entries.get(providerId)?.status,
      "reserved",
      `${providerId} must remain reserved in pricing and override indexes`
    );
    assert.equal(prefixIndex.eligibleNodeIds.has(nodeId), false);
    assert.equal(prefixIndex.prefixToNode.has(providerId), false);
  }
});

test("stripModelPrefix cannot erase retired Felo identities before dispatch", async () => {
  await settingsDb.updateSettings({ stripModelPrefix: true });
  try {
    for (const providerId of ["felo-web", "felo", "FeLo-WeB", "FELO"]) {
      await assert.rejects(() => getModelInfo(`${providerId}/gpt-4o`), isRetiredError);
    }
  } finally {
    await settingsDb.updateSettings({ stripModelPrefix: false });
  }
});

test("direct chat resolution converts retired Felo failures into sanitized HTTP 410", async () => {
  for (const providerId of ["felo-web", "felo"]) {
    const result = await resolveModelOrError(
      `${providerId}/gpt-4o`,
      { model: `${providerId}/gpt-4o`, messages: [{ role: "user", content: "hello" }] },
      "/v1/chat/completions"
    );
    assert.ok(result.error instanceof Response);
    assert.equal(result.error.status, 410);
    const body = (await result.error.json()) as {
      error?: { code?: string; message?: string };
    };
    assert.equal(body.error?.code, "PROVIDER_RETIRED");
    assert.equal(body.error?.message, "Provider is retired and unavailable.");
    assert.equal(JSON.stringify(body).includes(providerId), false);
  }
});

test("persisted aliases cannot rewrite retired Felo models before the route tombstone", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Retired Felo alias bypass control",
    apiKey: "sk-retired-felo-alias-bypass",
    isActive: true,
    testStatus: "active",
  });
  await modelAliasesDb.setModelAlias("felo-web/gpt-4o", "openai/gpt-4o");
  modelAliasResolver.invalidateAliasCache();

  const fetchCalls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    return Response.json({
      id: "chatcmpl-retired-felo-alias-bypass",
      choices: [{ message: { role: "assistant", content: "alias bypassed retirement" } }],
    });
  };

  const response = await chatRoute.POST(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "felo-web/gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    })
  );

  assert.equal(response.status, 410);
  assert.equal(fetchCalls.length, 0, "a retired alias must be rejected before upstream fetch");
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(body.error?.code, "PROVIDER_RETIRED");
  assert.equal(body.error?.message, "Provider is retired and unavailable.");

  // Bare model names are aliases/combos, not provider prefixes. An operator is
  // still allowed to own an unrelated alias named "felo"; only the slashful
  // retired provider identity must be rejected before alias resolution.
  await modelAliasesDb.setModelAlias("felo", "openai/gpt-4o");
  modelAliasResolver.invalidateAliasCache();
  const bareAliasResponse = await chatRoute.POST(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "felo",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    })
  );
  assert.equal(bareAliasResponse.status, 200);
  assert.equal(fetchCalls.length, 1, "a bare alias named felo must remain routable");
});

test("priority combo skips retired Felo target and falls back to a healthy target", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Healthy Felo combo fallback",
    apiKey: "sk-healthy-felo-combo-fallback",
    isActive: true,
    testStatus: "active",
  });
  await combosDb.createCombo({
    name: "retired-felo-fallback",
    strategy: "priority",
    models: [
      { provider: "felo-web", model: "gpt-4o" },
      { provider: "openai", model: "gpt-4o" },
    ],
  });

  const fetchCalls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    fetchCalls.push(String(input));
    return Response.json({
      id: "chatcmpl-retired-felo-fallback",
      choices: [{ message: { role: "assistant", content: "healthy fallback" } }],
    });
  };

  const response = await chatRoute.POST(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OmniRoute-No-Cache": "true",
      },
      body: JSON.stringify({
        model: "retired-felo-fallback",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.equal(fetchCalls.length, 1);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  assert.equal(body.choices?.[0]?.message?.content, "healthy fallback");
});

test("retired Felo ids stay ineligible after imports, even if the write path is bypassed", async () => {
  const backend = getTestBackend();

  const created = await providersDb.createProviderConnection({
    provider: "felo-web",
    authType: "apikey",
    name: "Retired Felo create response",
    apiKey: "retired-felo-create-key",
    isActive: true,
  });
  assert.equal(created.isActive, false, "create must report the tombstoned persisted state");

  const updated = await providersDb.updateProviderConnection(created.id, {
    isActive: true,
    testStatus: "active",
    errorCode: null,
    lastError: null,
    lastErrorType: null,
    lastErrorSource: null,
    lastErrorAt: null,
  });
  assert.equal(updated?.isActive, false, "update must report the tombstoned persisted state");
  assert.equal(updated?.errorCode, "PROVIDER_REMOVED");

  const deduplicated = await providersDb.createProviderConnection({
    provider: "felo-web",
    authType: "apikey",
    name: "Retired Felo create response",
    apiKey: "retired-felo-create-key",
    isActive: true,
    testStatus: "active",
  });
  assert.equal(deduplicated.id, created.id, "the second create must use the dedup path");
  assert.equal(
    deduplicated.isActive,
    false,
    "a deduplicated create must report the tombstoned persisted state"
  );
  assert.equal(deduplicated.errorCode, "PROVIDER_REMOVED");

  await assert.rejects(
    providersDb.updateProviderConnection(created.id, {
      provider: "openai",
      isActive: true,
      testStatus: "active",
      errorCode: null,
      lastError: null,
      lastErrorType: null,
      lastErrorSource: null,
      lastErrorAt: null,
    }),
    /retired provider connection identity cannot be changed/i
  );
  const identityPreserved = await providersDb.getProviderConnectionById(created.id);
  assert.equal(identityPreserved?.provider, "felo-web");
  assert.equal(identityPreserved?.isActive, false);
  assert.equal(identityPreserved?.errorCode, "PROVIDER_REMOVED");

  // Rows that get past the write path (an import that writes SQL directly) must still be blocked
  // at auth time, whatever their stored state says. This is the Postgres-era replacement for the
  // retired SQLite triggers, which normalized such rows on insert.
  for (const [index, providerId] of RETIRED_PROVIDER_VARIANTS.entries()) {
    const connectionId = `truly-active-${index}`;
    const leaseOwnerId = `vlo_${String.fromCharCode(65 + index).repeat(43)}`;
    const apiKeyId = `retired-key-${index}`;
    const generation = index + 1;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await backend.execute(
      "INSERT INTO provider_connections " +
        "(id, provider, auth_type, name, is_active, test_status, created_at, updated_at) " +
        "VALUES ($1, $2, 'apikey', $3, true, 'active', $4, $5)",
      [connectionId, providerId, `${providerId}-trigger-bypass`, now, now]
    );
    await backend.execute(
      "INSERT INTO exclusive_connection_leases " +
        "(lease_owner_hash, api_key_id, provider, connection_id, generation, state, " +
        "acquired_at, renewed_at, expires_at) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8)",
      [
        hashLeaseOwnerId(leaseOwnerId),
        apiKeyId,
        providerId,
        connectionId,
        generation,
        now,
        now,
        expiresAt,
      ]
    );

    const activeBeforeSelection = await backend.queryOne<{
      is_active: boolean;
      test_status: string;
    }>("SELECT is_active, test_status FROM provider_connections WHERE id = $1", [connectionId]);
    assert.deepEqual(
      activeBeforeSelection,
      { is_active: true, test_status: "active" },
      "fixture must bypass the write path so the auth tombstone is tested independently"
    );

    const credentials = await getProviderCredentials(
      providerId,
      null,
      [connectionId],
      "felo-chat",
      {
        allowSuppressedConnections: true,
        lease: {
          apiKeyId,
          context: { leaseOwnerId, generation },
          mode: "request",
        },
      }
    );
    assert.equal(credentials, null, `${providerId} must be blocked even with a truly active row`);

    const lease = await backend.queryOne<{ state: string; end_reason: string | null }>(
      "SELECT state, end_reason FROM exclusive_connection_leases WHERE connection_id = $1",
      [connectionId]
    );
    assert.deepEqual(lease, {
      state: "INVALIDATED",
      end_reason: "CONNECTION_INELIGIBLE",
    });
  }
});
