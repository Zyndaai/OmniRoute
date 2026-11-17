/**
 * Provider family aggregation (#15005) — usage rows for members of a declared
 * connection family (e.g. kimi-coding + kimi-coding-apikey) collapse into a
 * single canonical group, while /api/provider-metrics keeps one row per member
 * (topology nodes) plus folded `familyMetrics`.
 */
import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../../src/lib/db/callLogStats.ts");
const fam = await import("../../../src/lib/providerFamilyAgg.ts");
const route = await import("../../../src/app/api/provider-metrics/route.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idSeq = 0;
async function insertCallLog(row: Record<string, unknown>) {
  const full = {
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "m",
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
    request_type: null,
    ...row,
    id: row.id ?? `log-family-${++_idSeq}`,
    timestamp: row.timestamp ?? "2025-07-02T12:00:00.000Z",
  };
  await getTestBackend().execute(
    `INSERT INTO call_logs (
      id, "timestamp", method, path, status, model, requested_model, provider, account,
      connection_id, duration, tokens_in, tokens_out, cache_source, source_format, target_format,
      api_key_id, api_key_name, combo_name, combo_step_id, combo_execution_key,
      error_summary, detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256,
      has_request_body, has_response_body, has_pipeline_details, request_summary, request_type
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21,
      $22, $23, $24, $25, $26,
      $27, $28, $29, $30, $31
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
      Boolean(full.has_request_body),
      Boolean(full.has_response_body),
      Boolean(full.has_pipeline_details),
      full.request_summary,
      full.request_type,
    ]
  );
}

async function seedConnection(provider: string) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, created_at, updated_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [`conn-family-${provider}`, provider, now, now]
  );
}

const CUTOFF = "2025-07-01T00:00:00.000Z";

test.before(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb();
});

// ---------------------------------------------------------------------------
// Resolution table checks without a database
// ---------------------------------------------------------------------------

test("family aggregation — resolution table maps every member to its canonical id", () => {
  const table = fam.buildFamilyCanonicalOf();
  assert.equal(table.get("xao"), "xai-oauth");
  assert.equal(table.get("xai-oauth"), "xai-oauth");
  assert.equal(table.get("xai"), "xai");
  assert.equal(table.get("kimi-coding-apikey"), "kimi-coding");
  assert.equal(table.get("kimi-coding"), "kimi-coding");
  assert.equal(table.get("alibaba-cn"), "alibaba");
  assert.equal(table.get("freepik"), "magnific");
  assert.equal(table.get("magnific"), "magnific");
});

// ---------------------------------------------------------------------------
// GREEN — xai-oauth family collapses into one group
// ---------------------------------------------------------------------------

test("family aggregation — xai-oauth and xao form one xai-oauth group", async () => {
  await seedConnection("xai-oauth");
  await seedConnection("xao");
  await insertCallLog({ provider: "xai-oauth", status: 200, duration: 100 });
  await insertCallLog({ provider: "xao", status: 200, duration: 200 });

  const usage = await mod.getProviderUsageSince(CUTOFF);
  assert.deepEqual(
    usage.filter((r) => r.provider === "xao"),
    [],
    "no separate alias group"
  );
  const row = usage.find((r) => r.provider === "xai-oauth");
  assert.ok(row, "canonical group present");
  assert.equal(row.requests, 2, "requests are summed across members");
  assert.equal(row.avgLatencyMs, 150, "ROUND((100+200)/2)");

  const metrics = await mod.getProviderMetrics();
  assert.ok(
    metrics.some((r) => r.provider === "xai-oauth"),
    "canonical member metrics row present"
  );
  assert.ok(
    metrics.some((r) => r.provider === "xao"),
    "alias keeps its own topology metrics row"
  );
});

test("family aggregation — member without a live connection is excluded (#10714)", async () => {
  await seedConnection("kimi-coding");
  // No seedConnection("kimi-coding-apikey") on purpose.
  await insertCallLog({ provider: "kimi-coding", status: 200, duration: 100 });
  await insertCallLog({ provider: "kimi-coding-apikey", status: 200, duration: 100 });

  const row = (await mod.getProviderUsageSince(CUTOFF)).find(
    (r) => r.provider === "kimi-coding"
  );
  assert.ok(row, "canonical group present");
  assert.equal(row.requests, 1, "the member without a connection must not resurface");
});

test("family aggregation — lastStatus subquery shape is canonical", async () => {
  // Placeholder for the cross-member lastStatus proof, now folded into the
  // kimi-coding GREEN test (lastStatus/lastErrorStatus asserts). Kept as a
  // direct shape check on an isolated member pair instead of a duplicate DB
  // scenario that collides with shared database state.
  await seedConnection("kimi-coding-apikey-ls");
  await insertCallLog({
    provider: "kimi-coding-apikey-ls",
    status: 500,
    duration: 100,
    error_summary: "boom",
    timestamp: "2025-07-02T11:00:00.000Z",
    id: "log-family-ls-1",
  });

  const plain = (await mod.getProviderMetrics()).find(
    (r) => r.provider === "kimi-coding-apikey-ls"
  );
  assert.ok(plain, "member group present");
  assert.equal(plain.lastStatus, 500);
});

test("family aggregation — kimi-coding and kimi-coding-apikey form one group", async () => {
  await seedConnection("kimi-coding");
  await seedConnection("kimi-coding-apikey");
  const before =
    (await mod.getProviderUsageSince(CUTOFF)).find((r) => r.provider === "kimi-coding")
      ?.requests ?? 0;
  const beforeSuccesses =
    (await mod.getProviderUsageSince(CUTOFF)).find((r) => r.provider === "kimi-coding")
      ?.successes ?? 0;
  await insertCallLog({ provider: "kimi-coding", status: 200, duration: 100, id: "log-family-green-1" });
  await insertCallLog({
    provider: "kimi-coding-apikey",
    status: 500,
    duration: 300,
    error_summary: "upstream error",
    id: "log-family-green-2",
  });

  const usage = await mod.getProviderUsageSince(CUTOFF);
  assert.deepEqual(
    usage.filter((r) => r.provider === "kimi-coding-apikey"),
    [],
    "no separate member group"
  );
  const row = usage.find((r) => r.provider === "kimi-coding");
  assert.ok(row, "canonical group present");
  assert.equal(row.requests, before + 2, "requests are summed across members");
  assert.equal(row.successes, beforeSuccesses + 1, "successes are summed across members");

  const metrics = await mod.getProviderMetrics();
  const member = metrics.find((r) => r.provider === "kimi-coding-apikey");
  assert.ok(member, "family member keeps its own metrics row for its topology node");
  assert.ok(member.totalRequests >= 1);
  assert.equal(member.lastStatus, 500);
  const canonicalOnly = metrics.find((r) => r.provider === "kimi-coding");
  assert.ok(canonicalOnly, "canonical member row present");
  assert.equal(canonicalOnly.lastStatus, 200, "canonical row is not overwritten by the family");

  const family = fam.foldMetricRowsByFamily(metrics).find((r) => r.provider === "kimi-coding");
  assert.ok(family, "family aggregate present");
  assert.equal(family.totalRequests, member.totalRequests + canonicalOnly.totalRequests);
  assert.equal(family.lastErrorStatus, 500);
});

test("family aggregation — /api/provider-metrics serves member metrics and familyMetrics", async () => {
  await seedConnection("kimi-coding");
  await seedConnection("kimi-coding-apikey");
  await insertCallLog({
    provider: "kimi-coding-apikey",
    status: 503,
    duration: 50,
    error_summary: "late",
    timestamp: "2025-07-03T00:00:00.000Z",
    id: "log-family-route-1",
  });
  const res = await route.GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    metrics: Record<string, { totalRequests: number; lastStatus: number | null }>;
    familyMetrics: Record<string, { totalRequests: number; lastStatus: number | null }>;
    topology: { providers: string[] };
  };
  assert.ok(body.metrics["kimi-coding-apikey"], "member topology node keeps its metrics");
  assert.equal(body.metrics["kimi-coding-apikey"].lastStatus, 503);
  assert.ok(body.topology.providers.includes("kimi-coding-apikey"));
  const family = body.familyMetrics["kimi-coding"];
  assert.ok(family, "family aggregate keyed by the canonical id");
  assert.equal(
    family.totalRequests,
    body.metrics["kimi-coding-apikey"].totalRequests + body.metrics["kimi-coding"].totalRequests
  );
  assert.equal(family.lastStatus, 503, "newest member request drives the family lastStatus");
  assert.equal(body.familyMetrics["kimi-coding-apikey"], undefined);
});

test("family aggregation — avg latency folds weighted by samples", () => {
  const rows = fam.foldUsageRowsByFamily([
    {
      provider: "kimi-coding",
      requests: 3,
      successes: 3,
      avgLatencyMs: 100,
      latencySamples: 3,
      lastRequestAt: "2025-07-01T00:00:00.000Z",
    },
    {
      provider: "kimi-coding-apikey",
      requests: 1,
      successes: 0,
      avgLatencyMs: 500,
      latencySamples: 1,
      lastRequestAt: "2025-07-02T00:00:00.000Z",
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "kimi-coding");
  assert.equal(rows[0].avgLatencyMs, 200, "(100*3 + 500*1) / 4");
  assert.equal(rows[0].lastRequestAt, "2025-07-02T00:00:00.000Z");
});
