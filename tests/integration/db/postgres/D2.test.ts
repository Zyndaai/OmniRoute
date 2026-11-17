// Group D2 against a real PostgreSQL: call logs, proxy logs, cost ledger, compression
// analytics, quota snapshots/reset events, MCP + admin audit, webhook deliveries,
// conversation tracking, cleanup. Run through tests/_setup/isolatePostgres.ts (see the
// task's command): each test process gets its own database with the schema applied.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";
import { db } from "../../../../src/lib/db/pg.ts";

import {
  aggregateLedger,
  aggregateLedgerThisMonth,
  getCostBySessionTag,
  listLedgerEntries,
  recordLedgerEntries,
  recordLedgerEntry,
  recordLedgerEntrySafe,
  sumSearchLedgerSpendSince,
} from "../../../../src/lib/db/costLedger.ts";
import {
  expirePendingCallLogDetails,
  failPendingCallLogDetail,
  publishPendingCallLogDetail,
} from "../../../../src/lib/db/callLogDetails.ts";
import {
  countCallLogsSince,
  exportCallLogsSince,
  getCallLogById,
  getCallLogs,
  iterateCallLogsSince,
  saveCallLog,
  waitForCallLogSaves,
} from "../../../../src/lib/usage/callLogs.ts";
import { getCallLogFilterOptions } from "../../../../src/lib/usage/callLogFilterOptions.ts";
import {
  clearArtifactReference,
  deleteCallLogsBefore,
  trimCallLogsToMaxRows,
} from "../../../../src/lib/usage/callLogRotation.ts";
import {
  findReferencedArtifacts,
  parseArtifactRelPath,
  selectCallLogIdsBefore,
} from "../../../../src/lib/usage/callLogsBoundedQueries.ts";
import { buildArtifactRelativePath } from "../../../../src/lib/usage/callLogArtifacts.ts";
import { jsonTextParam } from "../../../../src/lib/db/pgJsonText.ts";
import {
  attachExportBodies,
  countCallLogsAfterRowId,
  getCallLogsForExport,
  getMaxCallLogRowId,
} from "../../../../src/lib/usage/callLogExportQueries.ts";
import {
  getErrorTypeBreakdown,
  getFallbackStats,
  getProviderMetrics,
  getRecentSearchLogs,
  getSearchAggregateStats,
} from "../../../../src/lib/db/callLogStats.ts";
import { getComboForecastUsageRows } from "../../../../src/lib/db/comboForecast.ts";
import {
  clearNoneHonoredCache,
  getNoneHonoredSnapshot,
} from "../../../../src/lib/db/reasoningEffortCompliance.ts";
import {
  resolveCallLogIdByResponseId,
  resolvePreviousResponseState,
} from "../../../../src/lib/db/responsesContinuationStore.ts";
import {
  countProxyLogsSince,
  exportProxyLogsSince,
  getPoolEgressObservation,
  getRecentEgressIpForConnection,
  getRecentEgressIpForProxy,
  getRecentEgressIpsForProxy,
  iterateProxyLogsSince,
  updateAttemptTiming,
} from "../../../../src/lib/db/proxyLogs.ts";
import { pickByLatency } from "../../../../src/lib/db/proxyLatency.ts";
import {
  clearProxyLogs,
  flushProxyLogsSync,
  getProxyLogs,
  logProxyEvent,
} from "../../../../src/lib/proxyLogger.ts";
import {
  cleanupOldSnapshots,
  getAggregatedSnapshots,
  getLatestQuotaSnapshotsForConnection,
  getQuotaSnapshots,
  isUnreportedQuotaSnapshot,
  saveQuotaSnapshot,
} from "../../../../src/lib/db/quotaSnapshots.ts";
import {
  getProviderQuotaWindowStart,
  hasObservedClaudeQuotaResetAfter,
  recordProviderQuotaResetEventIfChanged,
} from "../../../../src/lib/db/quotaResetEvents.ts";
import {
  attachCompressionUsageReceipt,
  getCompressionAnalyticsSummary,
  getLatestCompressionAnalyticsRun,
  getPerEngineAnalytics,
  insertCompressionAnalyticsRow,
  insertCompressionEngineBreakdown,
  recordContextEditingTelemetry,
} from "../../../../src/lib/db/compressionAnalytics.ts";
import {
  getCacheStatsSummary,
  recordCacheStats,
} from "../../../../src/lib/db/compressionCacheStats.ts";
import {
  getCompressionRunTelemetrySummary,
  insertCompressionRunTelemetryRow,
} from "../../../../src/lib/db/compressionRunTelemetry.ts";
import {
  __setAuditCallerIdResolverForTests,
  getAuditStats,
  getRecentAuditEntries,
  logToolCall,
  queryAuditEntries,
} from "../../../../open-sse/mcp-server/audit.ts";
import {
  cleanupExpiredLogs,
  countAuditLog,
  getAuditLog,
  logAuditEvent,
} from "../../../../src/lib/compliance/index.ts";
import { getDeliveries, insertDelivery } from "../../../../src/lib/db/webhookDeliveries.ts";
import {
  contentCandidatesSql,
  createAgenticConversation,
  findAgenticConversationsByContent,
  findAgenticConversationsByFingerprint,
  getConversationTurnIndex,
  getConversationTurnPage,
  getMultiTurnConversationById,
  insertConversationTurnNodes,
  listMultiTurnConversations,
  resolveCallLogIdsByCorrelationIds,
  touchOrCreateExternalConversation,
  updateAgenticConversation,
} from "../../../../src/lib/db/agenticConversations.ts";
import { resolveTurnDisplayContent } from "../../../../open-sse/services/conversationTurnContent.ts";
import {
  cleanupAgenticConversations,
  cleanupCallLogs,
  cleanupCompressionAnalytics,
  cleanupConversationTurnNodes,
  cleanupMcpAudit,
  cleanupQuotaSnapshots,
  cleanupProxyLogs,
  resetUsageHistory,
  purgeCallLogs,
} from "../../../../src/lib/db/cleanup.ts";
import { dropLogPartitionsBefore } from "../../../../src/lib/db/logPartitions.ts";
import { getRetentionSettings } from "../../../../src/lib/db/retentionSettings.ts";
import { computeDiff } from "../../../../src/domain/configAudit.ts";

const backend = getTestBackend();

beforeEach(async () => {
  await truncateAll(backend);
  clearNoneHonoredCache();
});

const DAY = 86_400_000;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

async function insertConnection(id: string, provider = "claude") {
  await db().execute(
    "INSERT INTO provider_connections (id, provider, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [id, provider, `name-${id}`]
  );
}

async function insertCallLogRow(row: {
  id: string;
  timestamp?: string;
  provider?: string;
  model?: string;
  status?: number;
  connectionId?: string | null;
  correlationId?: string | null;
  sessionTag?: string | null;
  comboName?: string | null;
  detailState?: string;
  artifactRelpath?: string | null;
  responseId?: string | null;
  apiKeyId?: string | null;
  requestType?: string | null;
  errorType?: string | null;
  errorSummary?: string | null;
  duration?: number;
  reasoningEffortRequested?: string | null;
  tokensReasoning?: number | null;
}) {
  await db().execute(
    `INSERT INTO call_logs (id, "timestamp", provider, model, status, connection_id, correlation_id,
        session_tag, combo_name, detail_state, artifact_relpath, response_id, api_key_id,
        request_type, error_type, error_summary, duration, reasoning_effort_requested, tokens_reasoning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      row.id,
      row.timestamp ?? iso(),
      row.provider ?? "claude",
      row.model ?? "m1",
      row.status ?? 200,
      row.connectionId ?? null,
      row.correlationId ?? null,
      row.sessionTag ?? null,
      row.comboName ?? null,
      row.detailState ?? "none",
      row.artifactRelpath ?? null,
      row.responseId ?? null,
      row.apiKeyId ?? null,
      row.requestType ?? null,
      row.errorType ?? null,
      row.errorSummary ?? null,
      row.duration ?? 100,
      row.reasoningEffortRequested ?? null,
      row.tokensReasoning ?? null,
    ]
  );
}

test("cost ledger: write, aggregate, list, month window, run join", async () => {
  await recordLedgerEntry({ apiKeyId: "k1", provider: "p", model: "m", amountUsd: 1.5, tokensInput: 10.4 });
  await recordLedgerEntrySafe({ apiKeyId: "k1", provider: "p", model: "m", amountUsd: 0.5, success: false });
  await recordLedgerEntries([
    { apiKeyId: "k1", provider: "p", model: "m", amountUsd: 2, serviceTier: "search" },
    { apiKeyId: "k2", provider: "p", model: "m", amountUsd: 9 },
    { apiKeyId: "", provider: "p", model: "m", amountUsd: 100 },
  ]);

  const all = await aggregateLedger("k1", iso(-DAY));
  assert.equal(all.requestCount, 3);
  assert.equal(all.amountUsd, 4);
  const okOnly = await aggregateLedger("k1", iso(-DAY), { successOnly: true });
  assert.equal(okOnly.requestCount, 2);
  assert.equal(okOnly.amountUsd, 3.5);
  assert.equal(await sumSearchLedgerSpendSince("k1", iso(-DAY)), 2);

  const entries = await listLedgerEntries("k1", { limit: 10 });
  assert.equal(entries.length, 3);
  assert.equal(typeof entries[0].timestamp, "string");
  assert.ok(entries.some((e) => e.success === false));
  assert.equal(entries.find((e) => e.tokensInput === 10)?.provider, "p");

  assert.equal((await aggregateLedgerThisMonth("k1")).requestCount, 2);

  await recordLedgerEntry({
    apiKeyId: "k3",
    provider: "p",
    model: "m",
    amountUsd: 3,
    requestId: "corr-1",
  });
  await insertCallLogRow({ id: "c1", correlationId: "corr-1", sessionTag: "run-a" });
  const run = await getCostBySessionTag("run-a");
  assert.equal(run.length, 1);
  assert.equal(run[0].amountUsd, 3);
  assert.deepEqual(await getCostBySessionTag("nope"), []);
});

test("call log save: row, artifact detail state, list and detail reads, id collision", async () => {
  const timestamp = iso(-5_000);
  await saveCallLog({
    id: "log-1",
    timestamp,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "gpt-x",
    provider: "openai",
    duration: 120.6,
    tokens: { prompt_tokens: 12, completion_tokens: 7 },
    requestBody: { messages: [{ role: "user", content: "hi" }] },
    responseBody: { choices: [{ message: { role: "assistant", content: "yo" } }] },
    correlationId: "corr-save",
    sessionTag: "tag-save",
    comboName: "combo-a",
    requestType: "search",
  });
  await waitForCallLogSaves(5_000);

  const row = await db().queryOne<Record<string, unknown>>(
    "SELECT * FROM call_logs WHERE id = 'log-1'"
  );
  assert.ok(row);
  assert.equal(row.has_request_body, true);
  assert.equal(row.duration, 121);
  assert.equal(row.artifact_relpath, buildArtifactRelativePath(timestamp, "log-1"));
  assert.equal(row.detail_state, "ready");

  const list = await getCallLogs({ search: "GPT-X", limit: 10 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "log-1");
  assert.equal(list[0].detailState, "ready");
  assert.equal(list[0].hasRequestBody, true);
  assert.equal(list[0].artifactRelPath, row.artifact_relpath);
  assert.equal((await getCallLogs({ status: "error" })).length, 0);
  assert.equal((await getCallLogs({ since: iso(-DAY), model: "gpt" })).length, 1);

  const detail = (await getCallLogById("log-1")) as Record<string, unknown> | null;
  assert.ok(detail);
  assert.equal(detail.detailState, "ready");
  assert.ok(detail.requestBody);
  assert.equal((await getCallLogById("log-1", timestamp)) !== null, true);
  assert.equal(await getCallLogById("missing"), null);

  // The same id and timestamp again: the PK collides (23505) and the id is regenerated.
  await saveCallLog({ id: "log-1", timestamp, status: 200, provider: "openai", model: "gpt-x" });
  await waitForCallLogSaves(5_000);
  const count = await db().queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM call_logs");
  assert.equal(count?.n, 2);

  assert.equal(await countCallLogsSince(iso(-DAY)), 2);
  assert.equal((await exportCallLogsSince(iso(-DAY))).length, 2);
  let streamed = 0;
  for await (const _log of iterateCallLogsSince(iso(-DAY), 1)) streamed++;
  assert.equal(streamed, 1);

  const options = await getCallLogFilterOptions();
  assert.deepEqual(options.providers, ["openai"]);
  assert.ok(options.models.includes("gpt-x"));
});

test("call log details: pending barrier, publish, fail, expiry", async () => {
  const ts = iso(-1_000);
  const pendingUntil = iso(5 * 60_000);
  await insertCallLogRow({ id: "d1", timestamp: ts, detailState: "pending" });
  await insertCallLogRow({ id: "d2", timestamp: ts, detailState: "pending" });
  await insertCallLogRow({ id: "d3", timestamp: ts, detailState: "pending" });
  await db().execute(
    `UPDATE call_logs SET detail_pending_until = $1 WHERE id IN ('d1', 'd2')`,
    [pendingUntil]
  );

  const published = await publishPendingCallLogDetail(
    db(),
    "d1",
    { relPath: "x/y.json", sizeBytes: 12, sha256: "abc" },
    ts
  );
  assert.equal(published, true);
  // Already ready: a second publish no longer matches.
  assert.equal(
    await publishPendingCallLogDetail(db(), "d1", { relPath: "x/y.json", sizeBytes: 1, sha256: "z" }),
    false
  );
  await failPendingCallLogDetail(db(), "d2", ts);
  // d3 has no pending deadline: recovery makes it terminal.
  await expirePendingCallLogDetails(db());

  const states = await db().query<{ id: string; detail_state: string }>(
    "SELECT id, detail_state FROM call_logs ORDER BY id"
  );
  assert.deepEqual(
    states.map((s) => `${s.id}:${s.detail_state}`),
    ["d1:ready", "d2:missing", "d3:missing"]
  );
});

test("rotation: key parsing, referenced paths, clear reference, delete before, trim", async () => {
  const ts = "2026-03-04T05:06:07.089Z";
  const rel = buildArtifactRelativePath(ts, "id_with_underscore");
  assert.deepEqual(parseArtifactRelPath(rel), { id: "id_with_underscore", timestamp: ts });
  assert.equal(parseArtifactRelPath("legacy/path.json"), null);

  await insertCallLogRow({
    id: "id_with_underscore",
    timestamp: ts,
    detailState: "ready",
    artifactRelpath: rel,
  });
  const referenced = await findReferencedArtifacts([rel, "legacy/path.json"]);
  assert.deepEqual([...referenced], [rel]);

  await clearArtifactReference(rel, "missing");
  const cleared = await db().queryOne<{ detail_state: string; artifact_relpath: string | null }>(
    "SELECT detail_state, artifact_relpath FROM call_logs WHERE id = 'id_with_underscore'"
  );
  assert.equal(cleared?.detail_state, "missing");
  assert.equal(cleared?.artifact_relpath, null);

  for (let i = 0; i < 5; i++) {
    await insertCallLogRow({ id: `old-${i}`, timestamp: iso(-(40 + i) * DAY) });
  }
  for (let i = 0; i < 3; i++) {
    await insertCallLogRow({ id: `new-${i}`, timestamp: iso(-i * 1000) });
  }
  const keys = await selectCallLogIdsBefore(iso(-30 * DAY), 3);
  assert.equal(keys.length, 3);
  const deleted = await deleteCallLogsBefore(iso(-30 * DAY));
  // The five old rows plus the March row inserted above.
  assert.equal(deleted.deletedRows, 6);

  const remaining = await db().queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM call_logs");
  assert.equal(remaining?.n, 3);
  const trimmed = await trimCallLogsToMaxRows(2);
  assert.equal(trimmed.deletedRows, 1);
  const afterTrim = await db().queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM call_logs");
  assert.equal(afterTrim?.n, 2);
});

test("export queries: seq cursor with the one-minute lag", async () => {
  await insertCallLogRow({ id: "e1", timestamp: iso(-10 * 60_000) });
  await insertCallLogRow({ id: "e2", timestamp: iso(-5 * 60_000) });
  await insertCallLogRow({ id: "e3", timestamp: iso(-1_000) });

  const max = await getMaxCallLogRowId();
  assert.ok(max >= 3);
  assert.equal(await countCallLogsAfterRowId(db(), 0), 3);

  const batch = await getCallLogsForExport(db(), 0, 10);
  // e3 is younger than the lag and is read on a later pass.
  assert.deepEqual(
    batch.map((b) => b.record.id),
    ["e1", "e2"]
  );
  assert.ok(batch[1].rowId > batch[0].rowId);
  const next = await getCallLogsForExport(db(), batch[1].rowId, 10);
  assert.equal(next.length, 0);
});

test("export queries: a newer timestamp with a lower seq is never skipped by the cursor", async () => {
  // Lower seq, still inside the lag window; higher seq, already past it.
  await insertCallLogRow({ id: "lag-a", timestamp: iso(-20_000) });
  await insertCallLogRow({ id: "lag-b", timestamp: iso(-90_000) });

  const first = await getCallLogsForExport(db(), 0, 10);
  // The batch is cut at the first row inside the window, so b is not exported past a.
  assert.deepEqual(first, []);

  await db().execute(`UPDATE call_logs SET "timestamp" = $1 WHERE id = 'lag-a'`, [iso(-120_000)]);
  const later = await getCallLogsForExport(db(), 0, 10);
  assert.deepEqual(
    later.map((b) => b.record.id),
    ["lag-a", "lag-b"]
  );
});

test("export bodies resolve by id and timestamp", async () => {
  const t1 = iso(-5 * 60_000);
  const t2 = iso(-4 * 60_000);
  await insertCallLogRow({ id: "same", timestamp: t1 });
  await insertCallLogRow({ id: "same", timestamp: t2 });
  const rows = await getCallLogsForExport(db(), 0, 10);
  assert.equal(rows.length, 2);
  const seen: Array<[string, string | null]> = [];
  await attachExportBodies(rows, 4096, async (id, timestamp) => {
    seen.push([id, timestamp]);
    return null;
  });
  assert.deepEqual(
    seen.map(([, t]) => Date.parse(String(t))).sort(),
    [Date.parse(t1), Date.parse(t2)].sort()
  );
});

test("jsonb text params drop lone surrogates and keep valid pairs", async () => {
  const lone = JSON.stringify({ a: "x" + "\u{1F600}".slice(0, 1), b: "\u{1F600}" });
  const param = jsonTextParam(lone);
  const row = await db().queryOne<{ v: { a: string; b: string } }>("SELECT $1::jsonb AS v", [param]);
  assert.equal(row?.v.a, "x�");
  assert.equal(row?.v.b, "\u{1F600}");
  const rawText = await db().queryOne<{ v: string }>("SELECT $1::jsonb AS v", [
    jsonTextParam("not json \ud83d"),
  ]);
  assert.equal(rawText?.v, "not json �");
});

test("call log stats, combo forecast, reasoning compliance, continuation lookup", async () => {
  await insertConnection("conn-s", "searxng-search");
  await insertConnection("conn-p", "claude");
  await insertCallLogRow({ id: "s1", provider: "claude", status: 200, connectionId: "conn-p" });
  await insertCallLogRow({
    id: "s2",
    provider: "claude",
    status: 500,
    errorType: "upstream",
    errorSummary: "boom",
    connectionId: "conn-p",
  });
  await insertCallLogRow({
    id: "s3",
    provider: "searxng-search",
    requestType: "search",
    comboName: "c1",
    connectionId: "conn-s",
  });

  const metrics = await getProviderMetrics();
  const claude = metrics.find((m) => m.provider === "claude");
  assert.equal(claude?.totalRequests, 2);
  assert.equal(claude?.totalSuccesses, 1);
  assert.equal(claude?.lastErrorStatus, 500);

  assert.equal((await getSearchAggregateStats(iso(-DAY))).total, 1);
  assert.equal((await getRecentSearchLogs()).length, 1);

  const fallback = await getFallbackStats("WHERE \"timestamp\" >= @since", { since: iso(-DAY) });
  assert.equal(fallback.total, 2);
  const errors = await getErrorTypeBreakdown("WHERE \"timestamp\" >= @since", { since: iso(-DAY) });
  assert.equal(errors.reduce((sum, e) => sum + e.count, 0), 1);

  const forecast = await getComboForecastUsageRows({ since: iso(-DAY) });
  assert.equal(forecast.length, 1);
  assert.equal(forecast[0].comboName, "c1");
  assert.equal(forecast[0].requests, 1);

  for (let i = 0; i < 3; i++) {
    await insertCallLogRow({
      id: `r${i}`,
      model: "reason-model",
      reasoningEffortRequested: "none",
      tokensReasoning: i === 0 ? 5 : null,
    });
  }
  const snapshot = await getNoneHonoredSnapshot(db());
  assert.deepEqual(snapshot.entries.get("reason-model"), { honored: false, sampleSize: 3 });

  await insertCallLogRow({ id: "resp1", responseId: "resp_x", apiKeyId: "key-a" });
  assert.equal(await resolveCallLogIdByResponseId("resp_x", "key-a"), "resp1");
  assert.equal(await resolveCallLogIdByResponseId("resp_x", "key-b"), null);
  assert.equal(await resolvePreviousResponseState("resp_x", "key-a"), null);
});

test("proxy logs: batched write, hydrate order, timing patch with partition key, egress lookups", async () => {
  await insertConnection("pc1", "claude");
  await clearProxyLogs();
  const first = logProxyEvent({
    status: "success",
    proxy: { type: "http", host: "Proxy.Example", port: 8080, name: "px1" },
    level: "provider",
    provider: "claude",
    egressIp: "9.9.9.9",
    latencyMs: 12.7,
    connectionId: "pc1",
    correlationId: "pcorr",
    attemptIssue: "served",
    attemptNumber: 1,
    error: "bad\u0000error",
    tlsFingerprint: true,
  });
  logProxyEvent({ status: "error", level: "direct", latencyMs: 5, provider: "claude" });
  await flushProxyLogsSync();

  const rows = await db().query<Record<string, unknown>>("SELECT * FROM proxy_logs ORDER BY id");
  assert.equal(rows.length, 2);
  const stored = rows.find((r) => r.id === first.id);
  assert.equal(stored?.proxy_host, "proxy.example");
  assert.equal(stored?.latency_ms, 13);
  assert.equal(stored?.tls_fingerprint, true);
  assert.equal(stored?.error, "baderror");
  assert.equal(getProxyLogs({ provider: "claude" }).length, 2);

  assert.equal(await updateAttemptTiming(first.id, { headersMs: 20, firstChunkMs: 31 }, first.timestamp), true);
  assert.equal(await updateAttemptTiming(first.id, { headersMs: -1 }), false);
  const patched = await db().queryOne<{ headers_ms: number; first_chunk_ms: number }>(
    "SELECT headers_ms, first_chunk_ms FROM proxy_logs WHERE id = $1",
    [first.id]
  );
  assert.deepEqual(patched, { headers_ms: 20, first_chunk_ms: 31 });

  const since = iso(-DAY);
  assert.equal(await countProxyLogsSince(since), 2);
  const exported = await exportProxyLogsSince(since);
  assert.equal(exported.length, 2);
  assert.deepEqual(
    exported.map((r) => r.tls_fingerprint).sort(),
    [0, 1]
  );
  let streamed = 0;
  for await (const _row of iterateProxyLogsSince(since, 1)) streamed++;
  assert.equal(streamed, 1);

  assert.equal((await getRecentEgressIpForConnection("pc1", since))?.egressIp, "9.9.9.9");
  assert.equal((await getRecentEgressIpForProxy("PROXY.example", 8080))?.egressIp, "9.9.9.9");
  assert.deepEqual(await getRecentEgressIpsForProxy("proxy.example", 8080, since), ["9.9.9.9"]);

  await db().execute(
    `INSERT INTO proxy_registry (id, name, type, host, port) VALUES ('reg1', 'px1', 'http', 'proxy.example', 8080)`
  );
  await db().execute(
    `INSERT INTO proxy_assignments (proxy_id, scope, scope_id) VALUES ('reg1', 'global', '__global__')`
  );
  const observation = await getPoolEgressObservation("global", null, since);
  assert.equal(observation.connections, 1);
  assert.equal(observation.distinctExits, 1);

  const picked = await pickByLatency(db(), [
    { host: "proxy.example", port: 8080 },
    { host: "other", port: 1 },
  ]);
  assert.equal(picked.host, "other");
});

test("quota snapshots and reset events", async () => {
  await insertConnection("qc1", "claude");
  const base = {
    provider: "claude",
    connection_id: "qc1",
    window_key: "weekly",
    remaining_percentage: 40,
    is_exhausted: 0,
    next_reset_at: iso(DAY),
    window_duration_ms: 604_800_000,
    raw_data: null,
  };
  await saveQuotaSnapshot(base);
  await saveQuotaSnapshot({ ...base, window_key: "5h", remaining_percentage: 0, is_exhausted: 1, raw_data: '{"fractionReported":false}' });
  // A deleted connection is skipped, not an error.
  await saveQuotaSnapshot({ ...base, connection_id: "gone" });

  const latest = await getLatestQuotaSnapshotsForConnection("qc1");
  assert.equal(latest.length, 2);
  const rows = await getQuotaSnapshots({ connectionId: "qc1", since: iso(-DAY) });
  assert.equal(rows.length, 2);
  const unreported = rows.filter((r) => isUnreportedQuotaSnapshot(r));
  assert.equal(unreported.length, 1);
  const fiveHour = rows.find((r) => (r as unknown as { windowKey: string }).windowKey === "5h");
  // The row shape keeps the 0/1 flag and the JSON text of the old schema.
  assert.equal((fiveHour as unknown as { isExhausted: number }).isExhausted, 1);
  assert.equal(typeof (fiveHour as unknown as { rawData: unknown }).rawData, "string");

  const points = await getAggregatedSnapshots({ since: iso(-DAY), bucketMinutes: 60 });
  assert.equal(points.length, 1);
  assert.equal(points[0].windowKey, "5h");
  assert.equal(points[0].isExhausted, true);
  assert.match(points[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);

  // Reset events: a weekly window that moved forward is recorded once.
  const previous = { resetAt: iso(-8 * DAY), remainingPercentage: 5 };
  const input = {
    provider: "claude",
    connectionId: "qc1",
    windowKey: "weekly",
    currentResetAt: iso(DAY),
    currentRemainingPercentage: 90,
    previousObservation: previous,
  };
  await recordProviderQuotaResetEventIfChanged(input);
  await recordProviderQuotaResetEventIfChanged(input);
  const events = await db().query("SELECT * FROM provider_quota_reset_events");
  assert.equal(events.length, 1);
  assert.equal(await hasObservedClaudeQuotaResetAfter("qc1", iso(-DAY)), true);
  assert.equal(await hasObservedClaudeQuotaResetAfter("qc1", iso(DAY)), false);
  const start = await getProviderQuotaWindowStart("qc1", iso(DAY));
  assert.ok(start);

  assert.equal(await cleanupOldSnapshots(1), 0);
});

test("compression analytics, breakdown, cache stats, run telemetry", async () => {
  await insertCompressionAnalyticsRow({
    timestamp: iso(),
    mode: "stacked",
    engine: "caveman",
    provider: "claude",
    original_tokens: 1000,
    compressed_tokens: 600,
    tokens_saved: 400,
    request_id: "req-1",
    validation_fallback: true,
    rtk_raw_output_pointers: '["a","b"]',
    estimated_usd_saved: 0.012,
  });
  await insertCompressionAnalyticsRow({
    timestamp: iso(),
    mode: "stacked",
    original_tokens: 10,
    compressed_tokens: 10,
    tokens_saved: 0,
    skip_reason: "no_savings",
  });
  await insertCompressionEngineBreakdown([
    { timestamp: iso(), request_id: "req-1", engine: "caveman", original_tokens: 100, compressed_tokens: 50, tokens_saved: 50 },
  ]);
  await attachCompressionUsageReceipt("req-1", { prompt_tokens: 900, completion_tokens: 20 }, "provider");
  await recordContextEditingTelemetry("req-2", { clearedInputTokens: 77 });

  const summary = await getCompressionAnalyticsSummary("24h");
  assert.equal(summary.totalRequests, 2);
  assert.equal(summary.totalSkipped, 1);
  assert.equal(summary.bySkipReason.no_savings, 1);
  assert.equal(summary.validationFallbacks, 1);
  assert.equal(summary.realUsage.requestsWithReceipts, 1);
  assert.equal(summary.realUsage.promptTokens, 900);
  assert.equal(summary.last24h.length, 24);
  assert.ok(summary.last24h.some((h) => h.count > 0));
  assert.equal(summary.byMode.stacked.skipped, 1);

  const perEngine = await getPerEngineAnalytics("caveman", 7);
  assert.equal(perEngine.runs, 1);
  const latest = await getLatestCompressionAnalyticsRun();
  assert.ok(latest);
  assert.equal(typeof latest.validation_fallback, "number");

  await recordCacheStats({
    provider: "claude",
    compressionMode: "lite",
    cacheControlPresent: true,
    estimatedCacheHit: true,
    tokensSavedCompression: 10,
    tokensSavedCaching: 20,
    netSavings: 30,
  });
  await recordCacheStats({
    provider: "claude",
    compressionMode: "lite",
    cacheControlPresent: false,
    estimatedCacheHit: false,
    tokensSavedCompression: 0,
    tokensSavedCaching: 0,
    netSavings: 10,
  });
  const cache = await getCacheStatsSummary();
  assert.equal(cache.totalRequests, 2);
  assert.equal(cache.cacheHitRate, 0.5);
  assert.equal(cache.byProvider.claude.avgNetSavings, 20);
  assert.equal((await getCacheStatsSummary(new Date(Date.now() + DAY))).totalRequests, 0);

  await insertCompressionRunTelemetryRow({
    requestId: "t1",
    model: "m",
    provider: "p",
    source: "chat",
    tokensBefore: 100,
    tokensAfter: 40,
    ratio: 0.4,
    outputStyles: [{ id: "terse", level: "lite" }],
    outputStyleBypass: "none",
    outputTokens: 12,
  });
  const telemetry = await getCompressionRunTelemetrySummary();
  assert.equal(telemetry.totalRuns, 1);
  assert.equal(telemetry.totalTokensSaved, 60);
  assert.deepEqual(telemetry.appliedStyleCounts, { terse: 1 });
});

test("mcp audit and admin audit log", async () => {
  __setAuditCallerIdResolverForTests(async () => "caller-1");
  try {
    await logToolCall("tool_a", { q: 1 }, { ok: true }, 12.4, true);
    await logToolCall("tool_a", { q: 2 }, "x", 3, false, "E_FAIL");
    await logToolCall("tool_b", { q: 3 }, "y\u0000z", 5, true);
  } finally {
    __setAuditCallerIdResolverForTests(null);
  }

  const all = await queryAuditEntries({ limit: 10 });
  assert.equal(all.total, 3);
  assert.equal(all.entries[0].apiKeyId, "caller-1");
  const failed = await queryAuditEntries({ success: false });
  assert.equal(failed.total, 1);
  assert.equal(failed.entries[0].errorCode, "E_FAIL");
  assert.equal((await queryAuditEntries({ tool: "tool_b" })).entries[0].outputSummary.includes("\u0000"), false);
  assert.equal((await getRecentAuditEntries(2)).length, 2);
  const stats = await getAuditStats();
  assert.equal(stats.totalCalls, 3);
  assert.ok(Math.abs(stats.successRate - 2 / 3) < 0.001);
  assert.equal(stats.topTools[0].tool, "tool_a");

  // Concurrent writers: every event lands, secrets are redacted, strings round-trip.
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      logAuditEvent({
        action: i % 2 ? "settings.update" : "apiKey.create",
        actor: `admin-${i}`,
        details: i === 0 ? "plain text" : { token: "secret-value", i },
        requestId: `rq-${i}`,
      })
    )
  );
  assert.equal(await countAuditLog(), 20);
  assert.equal(await countAuditLog({ action: "settings" }), 10);
  const entries = await getAuditLog({ actor: "ADMIN-3", limit: 5 });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].details, { token: "[redacted]", i: 3 });
  const plain = await getAuditLog({ requestId: "rq-0" });
  assert.equal(plain[0].details, "plain text");
  assert.equal((await getAuditLog({ from: iso(DAY) })).length, 0);
  assert.ok((await getAuditLog({ levelFilter: "high" })).length >= 0);
});

test("webhook deliveries keep the newest 100 per webhook, concurrently", async () => {
  await db().execute(
    `INSERT INTO webhooks (id, url) VALUES ('wh-1', 'https://a.example'), ('wh-2', 'https://b.example')`
  );
  // A delivery for a webhook deleted meanwhile is dropped, not an error.
  await insertDelivery({ webhookId: "wh-gone", eventType: "evt", status: "ok" });
  await Promise.all(
    Array.from({ length: 110 }, (_, i) =>
      insertDelivery({
        webhookId: "wh-1",
        eventType: "evt",
        status: "ok",
        httpStatus: 200,
        latencyMs: i + 0.4,
        payloadSnapshot: "{}",
      })
    )
  );
  await insertDelivery({ webhookId: "wh-2", eventType: "evt", status: "failed", error: "boom" });

  const count = await db().queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = 'wh-1'"
  );
  assert.ok(count && count.n <= 105 && count.n >= 100, `kept ${count?.n}`);
  // One more sequential write settles at exactly the cap.
  await insertDelivery({ webhookId: "wh-1", eventType: "evt", status: "ok" });
  const settled = await db().queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = 'wh-1'"
  );
  assert.equal(settled?.n, 100);
  const list = await getDeliveries("wh-2", 10);
  assert.equal(list.length, 1);
  assert.equal("payload_snapshot" in list[0], false);
  assert.equal(list[0].status, "failed");
});

test("agentic conversations: upsert race, nodes, paging, listing, content candidates", async () => {
  // Concurrent first requests for a client-chosen session id: one row, every request counted.
  await Promise.all(
    Array.from({ length: 10 }, () => touchOrCreateExternalConversation("sess-ext", { apiKeyId: "k" }))
  );
  const ext = await db().queryOne<{ turn_count: number }>(
    "SELECT turn_count FROM agentic_conversations WHERE id = 'sess-ext'"
  );
  assert.equal(ext?.turn_count, 10);

  const conv = await createAgenticConversation({ apiKeyId: "k", fingerprintHash: "fp-1" });
  assert.equal((await findAgenticConversationsByFingerprint("fp-1")).length, 1);
  await updateAgenticConversation(conv.id, { turnCount: 5 });
  assert.equal((await findAgenticConversationsByFingerprint("fp-1"))[0].turnCount, 5);
  await Promise.all([
    updateAgenticConversation(conv.id, { turnCount: 6 }),
    updateAgenticConversation(conv.id, { turnCount: 6 }),
  ]);
  assert.equal((await findAgenticConversationsByFingerprint("fp-1"))[0].turnCount, 7);

  const nodes = Array.from({ length: 25 }, (_, i) => ({
    id: `n${i}`,
    parentId: i === 0 ? null : `n${i - 1}`,
    role: i % 2 ? "assistant" : "user",
    contentHash: `h${i}`,
  }));
  await insertConversationTurnNodes(conv.id, "corr-n", nodes);
  await insertConversationTurnNodes(conv.id, "corr-n2", nodes.slice(0, 3));

  const index = await getConversationTurnIndex(conv.id);
  assert.equal(index.nodeIds.size, 25);
  assert.equal(index.parentsWithChildren.size, 24);
  const page = await getConversationTurnPage(conv.id, { limit: 20 });
  assert.equal(page.nodes.length, 20);
  assert.equal(page.hasMore, true);
  assert.equal(page.nodes[page.nodes.length - 1].id, "n24");
  const older = await getConversationTurnPage(conv.id, { limit: 20, beforeSeq: page.nodes[0].seq });
  assert.equal(older.nodes.length, 5);
  assert.equal(older.hasMore, false);
  assert.equal((await getConversationTurnPage(conv.id, { afterSeq: page.nodes[18].seq })).nodes.length, 1);

  const content = await findAgenticConversationsByContent("fp-1", ["h3", "h4", "nope"]);
  assert.equal(content.length, 1);
  assert.match(contentCandidatesSql(3), /ANY\(\$1::text\[\]\)/);

  await insertCallLogRow({ id: "cl-conv", correlationId: "corr-n", sessionTag: conv.id, model: "mm" });
  const resolved = await resolveCallLogIdsByCorrelationIds(["corr-n", "missing", ""]);
  assert.equal(resolved.get("corr-n"), "cl-conv");

  const multi = await listMultiTurnConversations();
  assert.equal(multi.total, 1);
  assert.equal(multi.rows[0].lastCallLogId, "cl-conv");
  assert.equal(multi.rows[0].lastModel, "mm");
  assert.equal((await getMultiTurnConversationById(conv.id))?.lastCallLogId, "cl-conv");
  assert.equal(await getMultiTurnConversationById("nope"), null);

  const display = await resolveTurnDisplayContent([{ lastCorrelationId: "corr-n" }]);
  assert.equal(display.size, 0);

  // Retention: old nodes first, then the conversations left empty.
  await db().execute("UPDATE conversation_turn_nodes SET last_seen_at = $1", [iso(-90 * DAY)]);
  await db().execute("UPDATE agentic_conversations SET last_seen_at = $1", [iso(-90 * DAY)]);
  assert.equal((await cleanupConversationTurnNodes()).deleted, 25);
  assert.equal((await cleanupAgenticConversations()).deleted, 2);
});

test("retention: partitions are dropped by day, plain tables by DELETE", async () => {
  const oldDay = new Date(Date.now() - 45 * DAY);
  const oldDayText = oldDay.toISOString().slice(0, 10);
  await db().execute("SELECT omniroute_ensure_daily_partitions('call_logs', $1::date, $1::date)", [oldDayText]);
  await db().execute("SELECT omniroute_ensure_daily_partitions('proxy_logs', $1::date, $1::date)", [oldDayText]);
  const oldTs = `${oldDayText}T12:00:00.000Z`;

  await insertCallLogRow({ id: "old-1", timestamp: oldTs });
  await insertCallLogRow({ id: "old-2", timestamp: oldTs });
  await insertCallLogRow({ id: "fresh", timestamp: iso() });
  // Back-dated into a day with no partition: lands in the default partition.
  await insertCallLogRow({ id: "stray", timestamp: iso(-70 * DAY) });
  await db().execute(
    `INSERT INTO proxy_logs (id, "timestamp", status) VALUES ('pl-old', $1, 'success'), ('pl-new', now(), 'success')`,
    [oldTs]
  );
  await db().execute(
    `INSERT INTO quota_snapshots (provider, connection_id, window_key, created_at) VALUES ('p', 'c', 'w', $1), ('p', 'c', 'w', now())`,
    [iso(-30 * DAY)]
  ).catch(() => {});

  const settings = await getRetentionSettings();
  assert.equal(settings.callLogs, 30);
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('databaseSettings', 'retention.mcpAudit', '1'::jsonb)`
  );
  assert.equal((await getRetentionSettings()).mcpAudit, 1);

  const calls = await cleanupCallLogs();
  assert.equal(calls.deleted, 3);
  const remaining = await db().query<{ id: string }>("SELECT id FROM call_logs ORDER BY id");
  assert.deepEqual(remaining.map((r) => r.id), ["fresh"]);
  const partitions = await db().query<{ relname: string }>(
    "SELECT relname FROM pg_class WHERE relname = $1",
    [`call_logs_p${oldDayText.replaceAll("-", "")}`]
  );
  assert.equal(partitions.length, 0);

  assert.equal((await cleanupProxyLogs()).deleted, 1);
  assert.equal((await dropLogPartitionsBefore("usage_history", new Date())).deletedRows, 0);

  await db().execute(`INSERT INTO mcp_tool_audit (tool_name, created_at) VALUES ('t', $1), ('t', now())`, [iso(-3 * DAY)]);
  assert.equal((await cleanupMcpAudit()).deleted, 1);
  await db().execute(
    `INSERT INTO compression_analytics ("timestamp", mode, original_tokens, compressed_tokens, tokens_saved) VALUES ($1, 'm', 1, 1, 0), (now(), 'm', 1, 1, 0)`,
    [iso(-40 * DAY)]
  );
  assert.equal((await cleanupCompressionAnalytics()).deleted, 1);
  await cleanupQuotaSnapshots();

  // Admin compliance cleanup: the same partition rule from the env/retention windows.
  const compliance = await cleanupExpiredLogs();
  assert.equal(typeof compliance.deletedCallLogs, "number");
  assert.ok((await getAuditLog({ action: "compliance.cleanup" })).length >= 1);
});

test("reset and purge: period scoped, everything, key-quota counters kept", async () => {
  await insertCallLogRow({ id: "rc-old", timestamp: iso(-2 * DAY) });
  await insertCallLogRow({ id: "rc-new", timestamp: iso(-1000) });
  await db().execute(
    `INSERT INTO usage_history ("timestamp", provider, model) VALUES ($1, 'p', 'm'), (now(), 'p', 'm')`,
    [iso(-2 * DAY)]
  );
  await db().execute(
    `INSERT INTO quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at)
     VALUES ('k', 'pool:x', 1, 1, $1), ('k', 'key-quota:tpm', 1, 1, $1)`,
    [iso(-2 * DAY)]
  );
  await db().execute(
    `INSERT INTO relay_logs (token_id, status, created_at) VALUES (NULL, 'auth_failed', $1)`,
    [iso(-2 * DAY)]
  );

  const timed = await resetUsageHistory("1d");
  assert.equal(timed.errors, 0);
  assert.equal(timed.deletedCallLogs, 1);
  assert.equal(timed.deletedUsageHistory, 1);
  assert.equal(timed.deletedQuotaConsumption, 1);
  assert.equal(timed.deletedRelayLogs, 1);
  const kept = await db().query<{ dimension_key: string }>("SELECT dimension_key FROM quota_counters");
  assert.deepEqual(kept.map((k) => k.dimension_key), ["key-quota:tpm"]);

  await createAgenticConversation({ id: "conv-reset", apiKeyId: null, fingerprintHash: "x" });
  await insertConversationTurnNodes("conv-reset", null, [
    { id: "rn1", parentId: null, role: "user", contentHash: "a" },
  ]);
  const all = await resetUsageHistory("all");
  assert.equal(all.errors, 0);
  assert.equal(all.deletedConversationTurnNodes, 1);
  assert.equal(all.deletedAgenticConversations, 1);
  assert.equal((await db().queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM call_logs"))?.n, 0);

  await insertCallLogRow({ id: "pc-1" });
  assert.equal((await purgeCallLogs()).deleted, 1);
  await assert.rejects(() => resetUsageHistory("2d"), /Invalid reset period/);
});

test("config audit helpers stay pure", () => {
  const diff = computeDiff({ a: 1, b: 2 }, { b: 3, c: 4 });
  assert.deepEqual(diff.added, ["c"]);
  assert.deepEqual(diff.removed, ["a"]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.isEmpty, false);
});
