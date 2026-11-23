/**
 * #3175 — provider/model call statistics aggregated from call_logs.
 * Guards the SQL extracted out of the /api/provider-stats route (Hard Rule #5).
 * Both aggregates are bounded to a 7-day window (buildProviderStatsSince) and
 * exclude providers whose connections are gone (EXISTS provider_connections),
 * while keyless providers stay visible: they have no connection row.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const stats = await import("../../../src/lib/db/providerStats.ts");
const { NOAUTH_PROVIDERS } = await import("../../../src/shared/constants/providers.ts");

async function insertCallLog(row: Record<string, unknown>) {
  const full = {
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    requested_model: null,
    provider: "openai",
    account: null,
    connection_id: null,
    duration: 100,
    tokens_in: 10,
    tokens_out: 20,
    cache_source: "upstream",
    source_format: null,
    target_format: null,
    api_key_id: null,
    api_key_name: null,
    combo_name: null,
    combo_step_id: null,
    combo_execution_key: null,
    error_summary: null,
    detail_state: "none",
    artifact_relpath: null,
    artifact_size_bytes: null,
    artifact_sha256: null,
    has_request_body: false,
    has_response_body: false,
    has_pipeline_details: false,
    request_summary: null,
    ...row,
    id: row.id ?? `log-${Math.random().toString(16).slice(2)}`,
    timestamp: row.timestamp ?? new Date().toISOString(),
  };
  await getTestBackend().execute(
    `INSERT INTO call_logs (
      id, "timestamp", method, path, status, model, requested_model, provider, account,
      connection_id, duration, tokens_in, tokens_out, cache_source, source_format, target_format,
      api_key_id, api_key_name, combo_name, combo_step_id, combo_execution_key,
      error_summary, detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256,
      has_request_body, has_response_body, has_pipeline_details, request_summary
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21,
      $22, $23, $24, $25, $26,
      $27, $28, $29, $30::jsonb
    )`,
    [
      full.id,
      full.timestamp,
      full.method,
      full.path,
      full.status,
      full.model,
      full.requested_model,
      full.provider,
      full.account,
      full.connection_id,
      full.duration,
      full.tokens_in,
      full.tokens_out,
      full.cache_source,
      full.source_format,
      full.target_format,
      full.api_key_id,
      full.api_key_name,
      full.combo_name,
      full.combo_step_id,
      full.combo_execution_key,
      full.error_summary,
      full.detail_state,
      full.artifact_relpath,
      full.artifact_size_bytes,
      full.artifact_sha256,
      full.has_request_body,
      full.has_response_body,
      full.has_pipeline_details,
      full.request_summary === null ? null : JSON.stringify(full.request_summary),
    ]
  );
}

async function insertConnection(id: string, provider: string) {
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES ($1, $2, now(), now())`,
    [id, provider]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
});

test("getProviderCallStats aggregates totals, success and latency per provider", async () => {
  const since = stats.buildProviderStatsSince();
  await insertConnection("conn-openai", "openai");
  await insertConnection("conn-anthropic", "anthropic");
  await insertCallLog({ provider: "openai", status: 200, duration: 100, tokens_in: 10, tokens_out: 20 });
  await insertCallLog({ provider: "openai", status: 500, duration: 300, tokens_in: 5, tokens_out: 0 });
  await insertCallLog({ provider: "anthropic", status: 200, duration: 50, tokens_in: 1, tokens_out: 2 });
  // excluded: provider '-' / null
  await insertCallLog({ provider: "-", status: 200 });
  // excluded: a provider whose connection is gone (no provider_connections row)
  await insertCallLog({ provider: "ghost-provider", status: 200, model: "ghost/model" });

  const rows = await stats.getProviderCallStats(since);
  const openai = rows.find((r) => r.provider === "openai");
  assert.ok(openai, "openai stats present");
  assert.equal(openai.totalRequests, 2);
  assert.equal(openai.successfulRequests, 1); // only the 200
  assert.equal(openai.avgLatencyMs, 200); // (100+300)/2
  assert.equal(openai.totalTokensIn, 15);
  assert.equal(openai.totalTokensOut, 20);
  assert.ok(!rows.some((r) => r.provider === "-"), "provider '-' is excluded");
  assert.ok(!rows.some((r) => r.provider === "ghost-provider"), "orphaned provider is excluded");
  // ordered by totalRequests desc → openai (2) before anthropic (1)
  assert.equal(rows[0].provider, "openai");
});

test("getModelCallStats groups by provider+model", async () => {
  const since = stats.buildProviderStatsSince();
  // a live connection, so its rows are not excluded by the provider guard
  await insertConnection("conn-models", "openai");
  await insertCallLog({ provider: "openai", status: 200, model: "openai/gpt-4.1" });
  await insertCallLog({ provider: "openai", status: 500, model: "openai/gpt-4.1" });
  // older than the 7-day window: counted by an unbounded query, not by the windowed one
  await insertCallLog({
    provider: "openai",
    status: 200,
    model: "openai/gpt-4.1",
    timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const rows = await stats.getModelCallStats(since);
  const m = rows.find((r) => r.model === "openai/gpt-4.1" && r.provider === "openai");
  assert.ok(m, "model row present");
  assert.equal(Number(m.requests), 2); // the windowed rows only, the 10-day-old row is out
  assert.equal(Number(m.successfulRequests), 1);
});

test("window: rows older than the window start are excluded", async () => {
  const now = new Date("2026-10-19T00:00:00.000Z");
  const since = stats.buildProviderStatsSince(now);
  const dayMs = 24 * 60 * 60 * 1000;
  assert.equal(since, new Date(now.getTime() - 7 * dayMs).toISOString());

  await insertConnection("conn-openai", "openai");
  await insertCallLog({ provider: "openai", status: 200, timestamp: now.toISOString() });
  await insertCallLog({
    provider: "openai",
    status: 200,
    timestamp: new Date(now.getTime() - 10 * dayMs).toISOString(),
  });

  const rows = await stats.getProviderCallStats(since);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "openai");
  assert.equal(Number(rows[0].totalRequests), 1);

  const models = await stats.getModelCallStats(since);
  assert.equal(models.length, 1);
  assert.equal(Number(models[0].requests), 1);
});

test("a provider without a live connection is excluded from both aggregates", async () => {
  const since = stats.buildProviderStatsSince();
  await insertConnection("conn-openai", "openai");
  await insertCallLog({ provider: "openai", status: 200 });
  // orphaned: call_logs rows exist, no provider_connections row
  await insertCallLog({ provider: "ghost-provider", status: 200 });

  const rows = await stats.getProviderCallStats(since);
  assert.deepEqual(
    rows.map((r) => r.provider),
    ["openai"]
  );
  const models = await stats.getModelCallStats(since);
  assert.ok(!models.some((r) => r.provider === "ghost-provider"));
});

test("a keyless provider keeps its stats without a connection row", async () => {
  const since = stats.buildProviderStatsSince();
  // The keyless provider list comes from production: every entry requests
  // through a shared synthetic connection, so none owns a provider_connections row.
  const keylessProvider = Object.keys(NOAUTH_PROVIDERS)[0];
  await insertConnection("conn-openai", "openai");
  await insertCallLog({ provider: "openai", status: 200 });
  await insertCallLog({
    provider: keylessProvider,
    status: 200,
    model: `${keylessProvider}/free-model`,
  });
  await insertCallLog({ provider: "ghost-provider", status: 200 });

  const providers = (await stats.getProviderCallStats(since)).map((r) => r.provider);
  assert.deepEqual(providers.sort(), [keylessProvider, "openai"].sort());

  const models = (await stats.getModelCallStats(since)).map((r) => r.provider);
  assert.ok(models.includes(keylessProvider), "keyless provider model rows are kept");
  assert.ok(!models.includes("ghost-provider"), "a removed provider stays excluded");
});

test("planner uses an index on call_logs for both aggregates, no sequential scan", async () => {
  const backend = getTestBackend();
  const dayMs = 24 * 60 * 60 * 1000;
  const recent = new Date(Date.now() - dayMs).toISOString();
  const old = new Date(Date.now() - 10 * dayMs).toISOString();
  await backend.execute(
    `INSERT INTO call_logs (id, "timestamp", provider, model, status, duration, tokens_in, tokens_out)
     SELECT 'perf-' || g, CASE WHEN g % 2 = 0 THEN $1::timestamptz ELSE $2::timestamptz END,
            'openai', 'openai/gpt-4.1', 200, 100, 10, 20
       FROM generate_series(0, 99) AS g`,
    [recent, old]
  );
  await insertConnection("perf-conn", "openai");
  await backend.execute("ANALYZE call_logs");
  const since = stats.buildProviderStatsSince();
  const keylessProviderIds = Object.keys(NOAUTH_PROVIDERS);

  // The statements under test are the ones the route serves, not a copy of them.
  // Seq scans are discouraged for this transaction only, so the planner has to pick an index
  // whenever one can serve the predicate; the plan must then read call_logs through an index.
  const explain = async (sql: string) =>
    backend.transaction(async (tx) => {
      await tx.execute("SET LOCAL enable_seqscan = off");
      const rows = await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, [
        since,
        keylessProviderIds,
      ]);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });

  const providerPlan = await explain(stats.PROVIDER_CALL_STATS_SQL);
  assert.match(
    providerPlan,
    /Index.*call_logs|call_logs.*Index/s,
    `provider query must read call_logs through an index, got: ${providerPlan}`
  );
  assert.doesNotMatch(providerPlan, /Seq Scan on call_logs/);

  const modelPlan = await explain(stats.MODEL_CALL_STATS_SQL);
  assert.match(
    modelPlan,
    /Index.*call_logs|call_logs.*Index/s,
    `model query must read call_logs through an index, got: ${modelPlan}`
  );
  assert.doesNotMatch(modelPlan, /Seq Scan on call_logs/);
});

test("the shipped aggregates keep the window predicate and the keyless exception", () => {
  assert.ok(
    stats.PROVIDER_CALL_STATS_SQL.includes('c."timestamp" >= $1::timestamptz'),
    "the provider aggregate must bound the lookback in SQL"
  );
  assert.ok(
    stats.PROVIDER_CALL_STATS_SQL.includes("c.provider = ANY($2::text[])"),
    "the provider aggregate must keep the keyless exception in SQL"
  );
  assert.ok(
    stats.MODEL_CALL_STATS_SQL.includes('c."timestamp" >= $1::timestamptz'),
    "the model aggregate must bound the lookback in SQL"
  );
  assert.ok(
    stats.MODEL_CALL_STATS_SQL.includes("c.provider = ANY($2::text[])"),
    "the model aggregate must keep the keyless exception in SQL"
  );
});

test("bounded aggregates stay under the response threshold on a large table", async () => {
  const backend = getTestBackend();
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const recent = new Date(now.getTime() - dayMs).toISOString();
  const old = new Date(now.getTime() - 10 * dayMs).toISOString();
  const rowCount = 100000;
  await backend.execute(
    `INSERT INTO call_logs (id, "timestamp", provider, model, status, duration, tokens_in, tokens_out)
     SELECT 'big-' || g, CASE WHEN g % 2 = 0 THEN $1::timestamptz ELSE $2::timestamptz END,
            'openai', 'openai/gpt-4.1', 200, 100, 10, 20
       FROM generate_series(0, $3::int - 1) AS g`,
    [recent, old, rowCount]
  );
  await insertConnection("conn-big", "openai");
  await backend.execute("ANALYZE call_logs");
  const since = stats.buildProviderStatsSince();

  const started = performance.now();
  const rows = await stats.getProviderCallStats(since);
  const providerMs = performance.now() - started;
  assert.ok(providerMs < 1500, `bounded provider query took ${providerMs.toFixed(1)} ms`);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].totalRequests), Math.floor(rowCount / 2));

  const startedModel = performance.now();
  const models = await stats.getModelCallStats(since);
  const modelMs = performance.now() - startedModel;
  assert.ok(modelMs < 1500, `bounded model query took ${modelMs.toFixed(1)} ms`);
  assert.equal(Number(models[0].requests), Math.floor(rowCount / 2));
});

test("a keyless search provider keeps its stats without a connection row", async () => {
  const since = stats.buildProviderStatsSince();
  // Keyless search providers (authType: "none") are exempted from the connection
  // guard alongside no-auth AI cards: searxng-search, context7, duckduckgo-free.
  // Their requests run on a shared synthetic connection, so none owns a
  // provider_connections row — yet their call_logs rows must still appear.
  await insertCallLog({ provider: "searxng-search", status: 200, model: "searxng-search/web" });
  await insertCallLog({ provider: "ghost-provider", status: 200 });

  const providers = (await stats.getProviderCallStats(since)).map((r) => r.provider);
  assert.ok(providers.includes("searxng-search"), "keyless search provider is kept");
  assert.ok(!providers.includes("ghost-provider"), "a removed provider stays excluded");

  const models = await stats.getModelCallStats(since);
  const m = models.find((r) => r.provider === "searxng-search");
  assert.ok(m, "keyless search provider model row is present");
  assert.equal(Number(m.requests), 1);
  assert.equal(m.model, "searxng-search/web");
});
