/**
 * A stored combo granted through `allowedCombos` admits its inner targets past
 * `allowedModels` (#14197). Only a combo named in `allowedCombos` also overrides
 * `blockedModels`; the default `combo/*` grant must not admit an inner target that
 * matches the key's `blockedModels`.
 *
 * The handleChat cases dispatch to a loopback HTTP server through a real
 * OpenAI-compatible provider node; `globalThis.fetch` is not replaced.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

process.env.OMNIROUTE_ALLOW_PRIVATE_PROVIDER_URLS = "true";

const h = await createChatPipelineHarness("combo-granted-blocked");
const { apiKeysDb, combosDb, handleChat, resetStorage } = h;
const providersDb = await import("../../src/lib/db/providers.ts");
const nodesDb = await import("../../src/lib/db/providers/nodes.ts");
const aliasesDb = await import("../../src/lib/db/models/aliases.ts");
const { comboTargetPassesKeyModelPolicy } =
  await import("../../src/sse/handlers/chat/comboTargetKeyPolicy.ts");
const { createResolvedModelGate, rejectUnauthorizedResolvedModels } =
  await import("../../src/sse/handlers/chat/resolvedModelPolicy.ts");

const KEY = "sk-combo-granted-blocked";
const COMBO = "granted-combo";
const BLOCKED = "mock/secret-model";
const PUBLIC = "mock/public-model";
const NODE = "openai-compatible-chat-0a0a0a0a-0000-4000-8000-0000000000b8";
const NODE_ID_BLOCKED = `${NODE}/secret-model`;
const ALIAS = "sm-alias";
const ALIAS_COMBO = "alias-combo";
const NODE_COMBO = "node-id-combo";

// Loopback upstream for the handleChat cases; started before any test is declared.
const upstreamModels: string[] = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let model = "";
    try {
      model = String(JSON.parse(raw).model);
    } catch {
      model = "<unparsed>";
    }
    upstreamModels.push(model);
    res.setHeader("content-type", "application/json");
    // No keep-alive: a reused socket the server idles out reads as a 502 and locks the model.
    res.setHeader("connection", "close");
    res.end(
      JSON.stringify({
        id: "chatcmpl-combo-blocked",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `ok ${model}` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

// Stand-in for isModelAllowedForKey: these cases only use exact allow-list entries.
function allowListChecker(models: string[]) {
  return async (_key: string, model: string) => models.includes(model);
}

async function passes(apiKeyInfo: Record<string, unknown>, requested: string, target: string) {
  return comboTargetPassesKeyModelPolicy({
    apiKey: KEY,
    apiKeyInfo,
    requestedModelStr: requested,
    targetModelStr: target,
    isModelAllowedForKey: allowListChecker((apiKeyInfo.allowedModels as string[]) ?? []),
  });
}

// ── Pre-dispatch target policy ──────────────────────────────────────────────

test("named allowedCombos grant overrides blockedModels for its inner targets", async () => {
  const info = {
    modelAccessMode: "restricted",
    allowedModels: [PUBLIC],
    allowedCombos: [COMBO],
    blockedModels: [BLOCKED],
  };
  assert.equal(await passes(info, COMBO, BLOCKED), true);
  assert.equal(await passes(info, COMBO, PUBLIC), true, "unblocked target stays admitted");

  // The `combo/` form of the rule names the combo too.
  const prefixed = { ...info, allowedCombos: [`combo/${COMBO}`] };
  assert.equal(await passes(prefixed, COMBO, BLOCKED), true);
});

test("naming one combo next to combo/* overrides blockedModels for that combo only", async () => {
  const info = { allowedCombos: ["combo/*", COMBO], blockedModels: [BLOCKED] };
  assert.equal(await passes(info, COMBO, BLOCKED), true, "named combo");
  assert.equal(await passes(info, "other-combo", BLOCKED), false, "reached through combo/* only");
});

test("default combo/* grant does not admit a blocked inner target", async () => {
  const info = { modelAccessMode: "all", allowedCombos: ["combo/*"], blockedModels: ["mock/*"] };
  assert.equal(await passes(info, COMBO, BLOCKED), false);
  assert.equal(await passes(info, COMBO, "other/model"), true);
});

test("pre-dispatch policy applies every blockedModels entry to a granted target", async () => {
  const list = ["other/unused-model", BLOCKED, "other/unused-2"];
  const info = { allowedCombos: ["combo/*"], blockedModels: list };
  assert.equal(await passes(info, COMBO, BLOCKED), false, "middle entry");
  assert.equal(await passes(info, COMBO, PUBLIC), true, "unblocked target");
  const both = {
    modelAccessMode: "restricted",
    allowedModels: [BLOCKED],
    allowedCombos: ["combo/*"],
    blockedModels: [BLOCKED],
  };
  assert.equal(await passes(both, COMBO, BLOCKED), false);
});

test("named allowedCombos grant still admits inner targets outside allowedModels (#14197)", async () => {
  const info = {
    modelAccessMode: "restricted",
    allowedModels: [PUBLIC],
    allowedCombos: [COMBO],
    blockedModels: ["unrelated/*"],
  };
  assert.equal(await passes(info, COMBO, BLOCKED), true);
});

test("auto/* combos keep per-candidate allowedModels and blockedModels checks", async () => {
  const info = {
    modelAccessMode: "restricted",
    allowedModels: [PUBLIC],
    allowedCombos: ["combo/*", "auto/best"],
    blockedModels: [BLOCKED],
  };
  assert.equal(await passes(info, "auto/best", BLOCKED), false);
  assert.equal(await passes(info, "auto/best", "other/model"), false);
  assert.equal(await passes(info, "auto/best", PUBLIC), true);
});

// ── Dispatch gate for granted targets ───────────────────────────────────────

test("dispatch gate rejects a combo-granted target that matches blockedModels", async () => {
  const rejected = await rejectUnauthorizedResolvedModels({
    hasApiKeyMetadata: true,
    apiKey: KEY,
    requestedModel: COMBO,
    resolvedModels: [BLOCKED],
    grantedTargets: new Set([BLOCKED]),
    blockedModels: [BLOCKED],
  });
  assert.ok(rejected, "a blocked granted target must be rejected");
  assert.equal(rejected.status, 403);

  const globRejected = await rejectUnauthorizedResolvedModels({
    hasApiKeyMetadata: true,
    apiKey: KEY,
    requestedModel: COMBO,
    resolvedModels: [BLOCKED],
    grantedTargets: new Set([BLOCKED]),
    blockedModels: ["mock/secret-*"],
  });
  assert.ok(globRejected, "a glob in blockedModels must reject a granted target");
  assert.equal(globRejected.status, 403);

  const admitted = await rejectUnauthorizedResolvedModels({
    hasApiKeyMetadata: true,
    apiKey: KEY,
    requestedModel: COMBO,
    resolvedModels: [PUBLIC],
    grantedTargets: new Set([PUBLIC]),
    blockedModels: [BLOCKED],
  });
  assert.equal(admitted, null, "an unblocked granted target is still admitted");
});

test("dispatch gate built for a combo/* grant carries the key's blockedModels", async () => {
  const gateFor = (apiKeyInfo: Record<string, unknown>) =>
    createResolvedModelGate({
      apiKeyInfo,
      apiKey: KEY,
      contextModel: COMBO,
      comboGrantsTargets: true,
      provider: "mock",
      model: "secret-model",
      modelStr: BLOCKED,
    });
  const rejected = await gateFor({ allowedCombos: ["combo/*"], blockedModels: [BLOCKED] })([
    BLOCKED,
  ]);
  assert.ok(rejected);
  assert.equal(rejected.status, 403);

  // A key that names another combo gets no override for this one.
  const otherNameRejected = await gateFor({
    allowedCombos: ["combo/*", "other-combo"],
    blockedModels: [BLOCKED],
  })([BLOCKED]);
  assert.ok(otherNameRejected, "combo/* must not inherit another combo's named grant");
  assert.equal(otherNameRejected.status, 403);

  const listRejected = await gateFor({
    allowedCombos: ["combo/*"],
    blockedModels: ["other/unused-model", BLOCKED, "other/unused-2"],
  })([BLOCKED]);
  assert.ok(listRejected, "a middle blockedModels entry must reject a granted target");
});

test("dispatch gate built for a named combo overrides blockedModels on its own target", async () => {
  for (const allowedCombos of [[COMBO], ["combo/*", COMBO]]) {
    const namedGate = createResolvedModelGate({
      apiKeyInfo: { allowedCombos, blockedModels: [BLOCKED] },
      apiKey: KEY,
      contextModel: COMBO,
      comboGrantsTargets: true,
      provider: "mock",
      model: "secret-model",
      modelStr: BLOCKED,
    });
    assert.equal(await namedGate([BLOCKED]), null, `${allowedCombos}: granted target`);
  }
});

test("dispatch gate fails closed when the blockedModels check throws", async () => {
  const rejected = await rejectUnauthorizedResolvedModels({
    hasApiKeyMetadata: true,
    apiKey: KEY,
    requestedModel: COMBO,
    resolvedModels: [BLOCKED],
    grantedTargets: new Set([BLOCKED]),
    blockedModels: [{} as unknown as string],
  });
  assert.ok(rejected);
  assert.equal(rejected.status, 503);
});

// ── handleChat with a loopback upstream ─────────────────────────────────────

test.after(async () => {
  server.close();
  await h.cleanup();
});

async function seed(perms: Record<string, unknown>) {
  await resetStorage();
  upstreamModels.length = 0;
  await nodesDb.createProviderNode({
    id: NODE,
    type: "openai-compatible",
    name: "combo blocked mock",
    prefix: "mock",
    apiType: "chat",
    baseUrl,
  });
  await providersDb.createProviderConnection({
    provider: NODE,
    authType: "apikey",
    name: "mock",
    apiKey: "sk-mock-upstream",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { prefix: "mock", baseUrl },
  });
  await combosDb.createCombo({ name: COMBO, strategy: "priority", models: [BLOCKED] });
  await combosDb.createCombo({
    name: "mixed-combo",
    strategy: "priority",
    models: [BLOCKED, PUBLIC],
  });
  await combosDb.createCombo({ name: NODE_COMBO, strategy: "priority", models: [NODE_ID_BLOCKED] });
  await aliasesDb.setModelAlias(ALIAS, BLOCKED);
  await combosDb.createCombo({ name: ALIAS_COMBO, strategy: "priority", models: [ALIAS] });
  const key = await apiKeysDb.createApiKey("combo blocked", "machine-combo-blocked");
  await apiKeysDb.updateApiKeyPermissions(key.id, perms);
  return key.key;
}

async function chat(key: string, model: string) {
  process.env.REQUIRE_API_KEY = "true";
  const response = await handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
  );
  await response.text();
  return response.status;
}

function namedGrant(combo: string, blockedModels: string[]) {
  return {
    modelAccessMode: "restricted",
    allowedModels: [PUBLIC],
    allowedCombos: [combo],
    blockedModels,
  };
}

function wildcardGrant(blockedModels: string[]) {
  return {
    modelAccessMode: "restricted",
    allowedModels: [PUBLIC],
    allowedCombos: ["combo/*"],
    blockedModels,
  };
}

test("handleChat: a new key (default combo/*) cannot reach a blocked model through a combo", async () => {
  const key = await seed({ blockedModels: [BLOCKED] });
  const meta = await apiKeysDb.getApiKeyMetadata(key);
  assert.deepEqual(meta?.allowedCombos, ["combo/*"], "precondition: default combo grant");

  const status = await chat(key, COMBO);
  assert.equal(status, 503, "every target is skipped before dispatch");
  assert.deepEqual(upstreamModels, [], "the blocked target must not be dispatched");
});

test("handleChat: a combo/* grant on a restricted key cannot reach a blocked model", async () => {
  const key = await seed(wildcardGrant([BLOCKED]));
  assert.equal(await chat(key, COMBO), 503);
  assert.deepEqual(upstreamModels, []);
});

test("handleChat: a named allowedCombos grant reaches a blocked model of that combo", async () => {
  const key = await seed(namedGrant(COMBO, [BLOCKED]));
  assert.equal(await chat(key, COMBO), 200);
  assert.deepEqual(upstreamModels, ["secret-model"]);
});

test("handleChat: naming one combo does not open blockedModels for the others", async () => {
  const key = await seed({ allowedCombos: ["combo/*", "mixed-combo"], blockedModels: [BLOCKED] });
  assert.equal(await chat(key, COMBO), 503, "reached through combo/* only");
  assert.deepEqual(upstreamModels, []);
  assert.equal(await chat(key, "mixed-combo"), 200, "named combo");
  assert.deepEqual(upstreamModels, ["secret-model"], "its first target is dispatched");
});

test("handleChat: a combo skips its blocked target and falls back to an allowed one", async () => {
  const key = await seed({ blockedModels: [BLOCKED] });
  assert.equal(await chat(key, "mixed-combo"), 200);
  assert.deepEqual(upstreamModels, ["public-model"]);
});

test("handleChat: an unrestricted key keeps dispatching combo targets", async () => {
  const key = await seed({});
  assert.equal(await chat(key, COMBO), 200);
  assert.deepEqual(upstreamModels, ["secret-model"]);
});

test("handleChat: a direct request for a blocked model is still rejected", async () => {
  const key = await seed({ blockedModels: [BLOCKED] });
  assert.equal(await chat(key, BLOCKED), 403);
  assert.deepEqual(upstreamModels, []);
});

// Provider-node entries: the dashboard stores `${node.id}/model`; an alias target reaches the
// dispatch gate in prefix form (`mock/model`).

test("handleChat: default combo/* cannot reach a node-id blocked model through an alias target", async () => {
  const key = await seed({ blockedModels: [NODE_ID_BLOCKED] });
  assert.equal(await chat(key, ALIAS_COMBO), 403);
  assert.deepEqual(upstreamModels, []);
});

test("handleChat: named grant reaches a node-id blocked model through an alias target", async () => {
  const key = await seed(namedGrant(ALIAS_COMBO, ["other/unused-model", NODE_ID_BLOCKED]));
  assert.equal(await chat(key, ALIAS_COMBO), 200);
  assert.deepEqual(upstreamModels, ["secret-model"]);
});

test("handleChat: a prefix-form entry blocks a combo target written in node-id form", async () => {
  for (const blockedModels of [[BLOCKED], ["mock/*"]]) {
    const named = await seed(namedGrant(NODE_COMBO, blockedModels));
    assert.equal(await chat(named, NODE_COMBO), 200, `named grant, ${blockedModels}`);
    assert.deepEqual(upstreamModels, ["secret-model"]);
    const byDefault = await seed({ blockedModels });
    assert.equal(await chat(byDefault, NODE_COMBO), 403, `combo/*, ${blockedModels}`);
    assert.deepEqual(upstreamModels, []);
  }
});
