/**
 * #3500 — call_logs aggregation functions extracted into callLogStats.ts (Hard Rule #5).
 *
 * Seeds the per-process Postgres database (tests/_setup/isolatePostgres.ts) and asserts
 * each db function returns the correct aggregation. The database is emptied and reseeded
 * with resetTestDb() before the file runs.
 */
import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../../src/lib/db/callLogStats.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idSeq = 0;

async function insertCallLog(row: Record<string, unknown>) {
  const b = getTestBackend();
  const full: Record<string, unknown> = {
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
    request_type: null,
    ...row,
    id: row.id ?? `log-3500-${++_idSeq}`,
    timestamp: row.timestamp ?? new Date().toISOString(),
  };
  const cols = Object.keys(full);
  await b.execute(
    `INSERT INTO call_logs (${cols.map((c) => `"${c}"`).join(", ")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => full[c])
  );
}

async function seedConnection(id: string, provider: string) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES ($1, $2, $3, $4)`,
    [id, provider, now, now]
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.before(async () => {
  await resetTestDb();
  // Search queries only surface providers with a live provider_connections
  // row — seed connections for the search providers used below so their
  // call_logs rows are not filtered out as deleted providers.
  await seedConnection("conn-3500-brave", "brave");
  await seedConnection("conn-3500-serper", "serper");
  await seedConnection("conn-3500-bing", "bing");
  await seedConnection("conn-3500-rare-provider", "rare_provider");
});

test.after(async () => {
  await resetTestDb().catch(() => {});
});

// ---------------------------------------------------------------------------
// getProviderMetrics
// ---------------------------------------------------------------------------

test("#3500 getProviderMetrics — aggregates totals and latency per provider", async () => {
  // #10714: getProviderMetrics() only surfaces providers with a live
  // provider_connections row — seed openai/anthropic connections so their
  // call_logs rows are not filtered out as ghost/deleted providers.
  await seedConnection("conn-3500-openai", "openai");
  await seedConnection("conn-3500-anthropic", "anthropic");

  // Two openai rows: one success, one error with error_summary
  const ts1 = "2025-06-01T10:00:00.000Z";
  const ts2 = "2025-06-01T11:00:00.000Z";
  await insertCallLog({ provider: "openai", status: 200, duration: 100, timestamp: ts1 });
  await insertCallLog({
    provider: "openai",
    status: 500,
    duration: 300,
    error_summary: "upstream error",
    timestamp: ts2,
  });
  // One anthropic success row
  const ts3 = "2025-06-01T09:00:00.000Z";
  await insertCallLog({ provider: "anthropic", status: 200, duration: 50, timestamp: ts3 });
  // Provider '-' should be excluded
  await insertCallLog({ provider: "-", status: 200 });
  // Provider null should be excluded
  await insertCallLog({ provider: null, status: 200, model: "x" });

  const rows = await mod.getProviderMetrics();

  // '-' and null providers must not appear
  assert.ok(!rows.some((r) => r.provider === "-"), "provider '-' excluded");
  assert.ok(!rows.some((r) => r.provider === null), "null provider excluded");

  const openai = rows.find((r) => r.provider === "openai");
  assert.ok(openai, "openai row present");
  assert.equal(openai.totalRequests, 2);
  assert.equal(openai.totalSuccesses, 1); // only the 200
  assert.equal(openai.avgLatencyMs, 200); // ROUND((100+300)/2) = 200
  // Postgres returns timestamptz as ISO strings; compare the instant.
  assert.equal(Date.parse(openai.lastRequestAt as string), Date.parse(ts2), "lastRequestAt = most recent ts");
  assert.equal(Date.parse(openai.lastErrorAt as string), Date.parse(ts2), "lastErrorAt = ts of the 500/error row");
  assert.equal(openai.lastStatus, 500, "lastStatus = most recent status");
  assert.equal(openai.lastErrorStatus, 500, "lastErrorStatus = most recent error status");

  const anthropic = rows.find((r) => r.provider === "anthropic");
  assert.ok(anthropic, "anthropic row present");
  assert.equal(anthropic.totalRequests, 1);
  assert.equal(anthropic.totalSuccesses, 1);
  assert.equal(anthropic.lastErrorAt, null, "no error row → lastErrorAt is null");
  assert.equal(anthropic.lastStatus, 200);
  assert.equal(anthropic.lastErrorStatus, null, "no error → lastErrorStatus is null");
});

// ---------------------------------------------------------------------------
// getSearchProviderStats
// ---------------------------------------------------------------------------

test("#3500 getSearchProviderStats — aggregates search requests per provider", async () => {
  await insertCallLog({ provider: "brave", status: 200, duration: 50, request_type: "search" });
  await insertCallLog({ provider: "brave", status: 200, duration: 150, request_type: "search" });
  await insertCallLog({ provider: "serper", status: 200, duration: 80, request_type: "search" });
  // non-search row — must NOT appear
  await insertCallLog({ provider: "openai", status: 200, duration: 100, request_type: null });

  const rows = await mod.getSearchProviderStats();

  // Only search request_type rows
  assert.ok(!rows.some((r) => r.provider === "openai"), "non-search row excluded");

  const brave = rows.find((r) => r.provider === "brave");
  assert.ok(brave, "brave row present");
  assert.equal(brave.requests, 2);
  assert.equal(brave.avg_latency_ms, 100); // AVG(50,150) = 100

  const serper = rows.find((r) => r.provider === "serper");
  assert.ok(serper, "serper row present");
  assert.equal(serper.requests, 1);
});

// ---------------------------------------------------------------------------
// getRecentSearchLogs
// ---------------------------------------------------------------------------

test("#3500 getRecentSearchLogs — returns up to 10 most recent search rows", async () => {
  // Insert 12 search rows with incrementing timestamps
  for (let i = 1; i <= 12; i++) {
    const ts = new Date(Date.UTC(2025, 5, i, 12, 0, 0)).toISOString();
    await insertCallLog({
      provider: "brave",
      status: 200,
      request_type: "search",
      timestamp: ts,
      request_summary: { query: `q${i}` },
    });
  }

  const rows = await mod.getRecentSearchLogs();
  assert.equal(rows.length, 10, "limited to 10 rows");
  // Most recent first (i=12 is the newest)
  assert.ok(rows[0].timestamp >= rows[rows.length - 1].timestamp, "ordered newest-first");
});

// ---------------------------------------------------------------------------
// getSearchAggregateStats
// ---------------------------------------------------------------------------

test("#3500 getSearchAggregateStats — correct totals, today, errors, avg, cached", async () => {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  // Rows inserted after todayStart qualify as "today"
  const nowIso = new Date().toISOString();
  // #13928: "cached" is driven by cache_source='semantic', not duration —
  // this row's duration is deliberately >5ms to prove the fix no longer
  // uses the old `duration < 5` latency heuristic.
  await insertCallLog({
    provider: "brave",
    status: 200,
    duration: 100,
    request_type: "search",
    timestamp: nowIso,
  });
  await insertCallLog({
    provider: "brave",
    status: 200,
    duration: 50,
    cache_source: "semantic",
    request_type: "search",
    timestamp: nowIso,
  });
  await insertCallLog({
    provider: "brave",
    status: 500,
    duration: 80,
    request_type: "search",
    timestamp: nowIso,
  });
  // Old row (yesterday) — not in today count
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  await insertCallLog({
    provider: "brave",
    status: 200,
    duration: 200,
    request_type: "search",
    timestamp: yesterday,
  });

  const result = await mod.getSearchAggregateStats(todayIso);

  assert.ok(result.total >= 4, "total includes all search rows (across all tests in file)");
  assert.ok(result.today >= 3, "today counts rows from today");
  assert.ok(result.errors >= 1, "errors counts status >= 400");
  assert.ok(result.cached >= 1, "cached counts cache_source='semantic' rows (#13928)");
  assert.ok(result.avg_duration !== null, "avg_duration not null when rows have duration > 0");
});

test("#3500 getSearchAggregateStats — returns zero struct when no search rows match", async () => {
  // Use a far-future todayIso so no row qualifies
  const farFuture = "2999-01-01T00:00:00.000Z";
  const result = await mod.getSearchAggregateStats(farFuture);
  // The function never returns null, so we just check the shape.
  // Only "today" is gated by todayIso; total counts all search rows.
  assert.equal(typeof result.total, "number");
  assert.equal(typeof result.today, "number");
  assert.equal(result.today, 0, "no rows qualify as 'today' in far future");
});

// ---------------------------------------------------------------------------
// getSearchProviderCounts
// ---------------------------------------------------------------------------

test("#3500 getSearchProviderCounts — ordered by cnt desc", async () => {
  // brave has multiple rows from earlier tests; add a burst to ensure ordering
  for (let i = 0; i < 5; i++) {
    await insertCallLog({ provider: "bing", status: 200, request_type: "search" });
  }
  for (let i = 0; i < 2; i++) {
    await insertCallLog({ provider: "rare_provider", status: 200, request_type: "search" });
  }

  const rows = await mod.getSearchProviderCounts();
  // Each row must have provider + cnt
  for (const row of rows) {
    assert.equal(typeof row.provider, "string");
    assert.equal(typeof row.cnt, "number");
  }
  // First row should have count >= last row (ordered desc)
  if (rows.length >= 2) {
    assert.ok(rows[0].cnt >= rows[rows.length - 1].cnt, "ordered by cnt desc");
  }
  // bing (5 added) should beat rare_provider (2 added)
  const bing = rows.find((r) => r.provider === "bing");
  const rare = rows.find((r) => r.provider === "rare_provider");
  assert.ok(bing, "bing row present");
  assert.ok(rare, "rare_provider row present");
  assert.ok(bing.cnt > rare.cnt, "bing cnt > rare_provider cnt");
});

// ---------------------------------------------------------------------------
// getProviderUsageSince — windowed usage aggregate for the rankings API
// ---------------------------------------------------------------------------

const USAGE_CUTOFF = "2025-07-01T00:00:00.000Z";
const IN_WINDOW = "2025-07-02T12:00:00.000Z";
const OUT_OF_WINDOW = "2025-06-01T12:00:00.000Z";

test("getProviderUsageSince — only counts rows inside the window", async () => {
  await seedConnection("conn-usage-usage-window", "usage-window");
  await insertCallLog({ provider: "usage-window", status: 200, timestamp: IN_WINDOW });
  await insertCallLog({ provider: "usage-window", status: 200, timestamp: IN_WINDOW });
  await insertCallLog({ provider: "usage-window", status: 200, timestamp: OUT_OF_WINDOW });
  await insertCallLog({ provider: "usage-window", status: 500, timestamp: OUT_OF_WINDOW });

  const row = (await mod.getProviderUsageSince(USAGE_CUTOFF)).find(
    (r) => r.provider === "usage-window"
  );
  assert.ok(row, "provider must be present");
  assert.equal(row.requests, 2, "rows before the cutoff must not be counted");
  assert.equal(row.successes, 2);
});

test("getProviderUsageSince — 2xx/3xx count as success, 4xx/5xx do not", async () => {
  await seedConnection("conn-usage-usage-status", "usage-status");
  for (const status of [200, 204, 301, 399]) {
    await insertCallLog({ provider: "usage-status", status, timestamp: IN_WINDOW });
  }
  for (const status of [400, 429, 500, 503]) {
    await insertCallLog({ provider: "usage-status", status, timestamp: IN_WINDOW });
  }

  const row = (await mod.getProviderUsageSince(USAGE_CUTOFF)).find(
    (r) => r.provider === "usage-status"
  );
  assert.ok(row);
  assert.equal(row.requests, 8);
  assert.equal(row.successes, 4, "same success rule as getProviderMetrics");
});

test("getProviderUsageSince — a provider with no live connection is excluded (#10714)", async () => {
  // No seedConnection() on purpose: rows exist in call_logs but the provider was deleted.
  await insertCallLog({ provider: "usage-ghost", status: 200, timestamp: IN_WINDOW });

  const rows = await mod.getProviderUsageSince(USAGE_CUTOFF);
  assert.equal(
    rows.find((r) => r.provider === "usage-ghost"),
    undefined,
    "a deleted provider must not resurface from retained logs"
  );
});

test("getProviderUsageSince — latency and lastRequestAt are bounded by the window too", async () => {
  await seedConnection("conn-usage-usage-latency", "usage-latency");
  await insertCallLog({
    provider: "usage-latency",
    status: 200,
    duration: 100,
    timestamp: IN_WINDOW,
  });
  await insertCallLog({
    provider: "usage-latency",
    status: 200,
    duration: 900,
    timestamp: OUT_OF_WINDOW,
  });

  const row = (await mod.getProviderUsageSince(USAGE_CUTOFF)).find(
    (r) => r.provider === "usage-latency"
  );
  assert.ok(row);
  assert.equal(row.avgLatencyMs, 100, "the out-of-window 900ms row must not weigh in");
  assert.equal(Date.parse(row.lastRequestAt as string), Date.parse(IN_WINDOW));
});

test("getProviderUsageSince — providers '-' and NULL are excluded", async () => {
  await seedConnection("conn-usage-dash", "-");
  await insertCallLog({ provider: "-", status: 200, timestamp: IN_WINDOW });

  const rows = await mod.getProviderUsageSince(USAGE_CUTOFF);
  assert.equal(
    rows.find((r) => r.provider === "-"),
    undefined
  );
  assert.equal(
    rows.find((r) => r.provider === null),
    undefined
  );
});
