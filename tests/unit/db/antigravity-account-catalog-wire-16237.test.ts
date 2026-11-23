import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "antigravity-wire-16237-"));
process.env.DATA_DIR = dataDir;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const { setMitmAliasAll } = await import("../../../src/lib/db/models/mitmAlias.ts");
const { addCustomModel } = await import("../../../src/lib/db/models.ts");
const { AntigravityExecutor, cleanModelName } =
  await import("../../../open-sse/executors/antigravity.ts");
const { seedAntigravityIdeVersionCache, seedAntigravityCliVersionCache } =
  await import("../../../open-sse/services/antigravityVersion.ts");
const literal = "gemini-3.7-flash-high";
const tiered = "gemini-3.7-flash-tiered";
const originalFetch = globalThis.fetch;

async function seed(connectionId: string, ids: string[], provider = "antigravity") {
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, is_active, synced_models_at)
     VALUES ($1, $2, true, now())
     ON CONFLICT (id) DO UPDATE SET
       provider = EXCLUDED.provider, is_active = true, synced_models_at = now()`,
    [connectionId, provider]
  );
  // Written straight to the row so an empty list and a re-seed are stored exactly as given.
  await getTestBackend().execute(
    `INSERT INTO connection_model_sync (connection_id, provider, models)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (connection_id) DO UPDATE SET provider = EXCLUDED.provider, models = EXCLUDED.models`,
    [connectionId, provider, JSON.stringify(ids.map((id) => ({ id })))]
  );
}

async function setSyncedModelsAt(connectionId: string, timestamp: string | null) {
  await getTestBackend().execute(
    "UPDATE provider_connections SET synced_models_at = $1::timestamptz WHERE id = $2",
    [timestamp, connectionId]
  );
}

async function setCatalogContent(connectionId: string, jsonContent: string) {
  await getTestBackend().execute(
    "UPDATE connection_model_sync SET models = $1::jsonb WHERE connection_id = $2",
    [jsonContent, connectionId]
  );
}

async function dispatch(connectionId: string | undefined, model = literal) {
  const wires: Array<{ model: string; project: string; request: unknown }> = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/v1internal:streamGenerateContent\?alt=sse$/);
    assert.equal(init?.method, "POST");
    assert.equal(typeof init.body, "string");
    assert.ok(init.signal instanceof AbortSignal);
    wires.push(JSON.parse(String(init.body)));
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
      {
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  };
  try {
    const result = await new AntigravityExecutor().execute({
      model,
      body: { request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] } },
      stream: true,
      credentials: { connectionId, accessToken: "synthetic-token", projectId: "synthetic-project" },
      log: { debug() {}, warn() {} },
    });
    assert.equal(result.response.status, 200);
    assert.match(await result.response.text(), /ok/);
    assert.equal(wires.length, 1);
    assert.equal(wires[0].project, "synthetic-project");
    return wires[0].model;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test.beforeEach(async () => {
  await resetTestDb();
  await setMitmAliasAll("antigravity", { [literal]: `antigravity/${tiered}` });
  seedAntigravityIdeVersionCache("2.1.1");
  seedAntigravityCliVersionCache("1.1.5");
});
test.after(async () => {
  globalThis.fetch = originalFetch;
  await resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("fresh selected account sends its literal 3.7 id before global MITM aliases", async () => {
  await seed("literal-account", [literal, tiered]);
  await seed("tiered-account", [tiered]);
  assert.equal(await dispatch("literal-account"), literal);
});
test("tiered-only selected account retains tiered wire id despite another account's literal", async () => {
  await seed("literal-account", [literal]);
  await seed("tiered-account", [tiered]);
  assert.equal(await dispatch("tiered-account"), tiered);
});
test("missing selected account retains the existing MITM/static fallback", async () => {
  await seed("other-account", [literal]);
  assert.equal(await dispatch("missing-account"), tiered);
});

for (const tier of ["high", "medium", "low"]) {
  for (const provider of ["antigravity", "agy"]) {
    test(`${provider} ${tier} literal-only catalog wins without MITM`, async () => {
      const id = `gemini-3.7-flash-${tier}`;
      await setMitmAliasAll("antigravity", {});
      await seed("selected", [id], provider);
      assert.equal(await dispatch("selected", `${provider}/${id}`), id);
    });
  }
}

test("selected-account lookup prevents an unrelated global Pro fallback chain", async () => {
  await seed("selected", [literal]);
  await setMitmAliasAll("antigravity", { [literal]: "antigravity/gemini-3.1-pro-low" });
  assert.equal(await dispatch("selected"), literal);
});

test("fresh tiered-only evidence also precedes a different global MITM mapping", async () => {
  await seed("selected", [tiered]);
  await setMitmAliasAll("antigravity", { [literal]: "antigravity/old-target" });
  assert.equal(await dispatch("selected"), tiered);
});

test("successive account selections and catalog replacements never reuse a sibling snapshot", async () => {
  await seed("a", [literal]);
  await seed("b", [tiered]);
  assert.equal(await dispatch("b"), tiered);
  assert.equal(await dispatch("a"), literal);
  await seed("a", [tiered]);
  await seed("b", [literal]);
  assert.equal(await dispatch("a"), tiered);
  assert.equal(await dispatch("b"), literal);
});

// An "invalid" (non-date) timestamp case existed with SQLite text columns; synced_models_at is a
// timestamptz now, so a non-date value cannot be stored at all.
for (const [label, timestamp] of [
  ["missing", null],
  ["expired", new Date(Date.now() - 31 * 86400000).toISOString()],
]) {
  test(`${label} timestamp cannot borrow freshness from another account`, async () => {
    await seed("selected", [literal]);
    await seed("other", [literal]);
    await setSyncedModelsAt("selected", timestamp);
    assert.equal(await dispatch("selected"), tiered);
  });
}
// "malformed JSON" cannot be stored in a jsonb column; a JSON string scalar is the closest shape.
for (const [label, content] of [
  ["empty", "[]"],
  ["non-array scalar", '"{"'],
  ["wrong shape", "{}"],
  ["invalid entries", '[null,{"id":5}]'],
  ["unrelated models", '[{"id":"other"}]'],
]) {
  test(`${label} catalog keeps existing fallback`, async () => {
    await seed("selected", [literal]);
    await setCatalogContent("selected", content);
    assert.equal(await dispatch("selected"), tiered);
  });
}

test("inactive connection cannot authorize its literal", async () => {
  await seed("selected", [literal]);
  await getTestBackend().execute("UPDATE provider_connections SET is_active = false WHERE id = $1", [
    "selected",
  ]);
  assert.equal(await dispatch("selected"), tiered);
});

test("another provider's connection cannot authorize an Antigravity literal", async () => {
  await seed("selected", [literal], "openai");
  assert.equal(await dispatch("selected"), tiered);
});

test("catalog key must match the stored provider identity as well as connection id", async () => {
  await seed("selected", [literal], "agy");
  await getTestBackend().execute(
    "UPDATE connection_model_sync SET provider = 'antigravity' WHERE connection_id = $1",
    ["selected"]
  );
  assert.equal(await dispatch("selected"), tiered);
});

test("provider-wide custom models are not account evidence", async () => {
  await seed("selected", []);
  await addCustomModel("antigravity", literal);
  assert.equal(await dispatch("selected"), tiered);
});

test("omitted connection preserves the public legacy helper and executor contract", async () => {
  await seed("selected", [literal]);
  assert.equal(await cleanModelName(`antigravity/${literal}`), tiered);
  assert.equal(await dispatch(undefined), tiered);
});

test("explicit override still wins over fresh account and MITM", async () => {
  await seed("selected", [literal]);
  const result = await new AntigravityExecutor().transformRequest(
    literal,
    { request: { contents: [] } },
    true,
    { connectionId: "selected", projectId: "synthetic-project" },
    "antigravity/forced-wire-id"
  );
  assert.ok(!(result instanceof Response));
  assert.equal(result.model, "forced-wire-id");
});

for (const [requested, expected] of [
  ["gemini-3.7-flash", tiered],
  ["gemini-3.1-pro-high", "gemini-pro-agent"],
  ["gemini-3.8-flash-high", "gemini-3.8-flash-high"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6"],
  ["unknown-model", "unknown-model"],
]) {
  test(`${requested} retains its established family mapping`, async () => {
    await seed("selected", [requested]);
    assert.equal(await dispatch("selected", requested), expected);
  });
}

for (const [label, ttl, age, expected] of [
  ["default boundary", undefined, 30 * 86400000, literal],
  ["default expired", undefined, 30 * 86400000 + 1, tiered],
  ["override boundary", "1000", 1000, literal],
  ["override expired", "1000", 1001, tiered],
  ["invalid override uses default", "invalid", 86400000, literal],
  ["nonpositive override uses default", "0", 86400000, literal],
] as const) {
  test(`freshness parity: ${label}`, async () => {
    const now = Date.now();
    const previousNow = Date.now;
    const previousTtl = process.env.OMNIROUTE_SYNCED_CATALOG_STALE_AFTER_MS;
    if (ttl === undefined) delete process.env.OMNIROUTE_SYNCED_CATALOG_STALE_AFTER_MS;
    else process.env.OMNIROUTE_SYNCED_CATALOG_STALE_AFTER_MS = ttl;
    Date.now = () => now;
    try {
      await seed("selected", [literal]);
      await setSyncedModelsAt("selected", new Date(now - age).toISOString());
      assert.equal(await dispatch("selected"), expected);
    } finally {
      Date.now = previousNow;
      if (previousTtl === undefined) delete process.env.OMNIROUTE_SYNCED_CATALOG_STALE_AFTER_MS;
      else process.env.OMNIROUTE_SYNCED_CATALOG_STALE_AFTER_MS = previousTtl;
    }
  });
}

for (const credentials of [undefined, null, {}]) {
  const label = credentials === undefined ? "undefined" : credentials === null ? "null" : "empty";
  test(`transformRequest preserves body project with ${label} credentials`, async () => {
    const body = {
      project: "synthetic-project",
      request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    };
    const result = await new AntigravityExecutor().transformRequest(
      literal,
      body,
      true,
      credentials
    );
    assert.equal(result.project, "synthetic-project");
    assert.equal(result.model, tiered);
    assert.equal(result.request.contents[0].parts[0].text, "hello");
  });
}
