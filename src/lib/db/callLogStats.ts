import { db, ts } from "./pg";
import { ERROR_TYPE_CONTRACT } from "@omniroute/open-sse/services/errorClassifier.ts";
import {
  SEARCH_CREDENTIAL_FALLBACKS,
  SEARCH_PROVIDERS,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import { foldUsageRowsByFamily } from "@/lib/providerFamilyAgg";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

/**
 * Aggregation queries over `call_logs` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/provider-metrics, /api/search/stats, and /api/v1/search/analytics routes
 * can delegate. Read-only aggregation; no writes.
 *
 * Sliced out of #3500 (call_logs cluster).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderMetricRow {
  provider: string;
  totalRequests: number;
  totalSuccesses: number;
  avgLatencyMs: number | null;
  lastRequestAt: string | null;
  lastErrorAt: string | null;
  lastStatus: number | null;
  lastErrorStatus: number | null;
  /** COUNT(duration) — weight for folding avgLatencyMs across a family. */
  latencySamples?: number | null;
}

/** One provider's traffic over a bounded window. See `getProviderUsageSince`. */
export interface ProviderUsageRow {
  provider: string;
  requests: number;
  successes: number;
  avgLatencyMs: number | null;
  lastRequestAt: string | null;
  latencySamples?: number | null;
}

export interface SearchProviderStatRow {
  provider: string;
  requests: number;
  avg_latency_ms: number | null;
}

export interface SearchRecentRow {
  request_summary: string | null;
  provider: string;
  timestamp: string;
}

export interface SearchAggregateStats {
  total: number;
  today: number;
  errors: number;
  avg_duration: number | null;
  cached: number;
}

export interface SearchProviderCountRow {
  provider: string;
  cnt: number;
}

// ---------------------------------------------------------------------------
// /api/provider-metrics — aggregate per-provider stats
// ---------------------------------------------------------------------------

/**
 * Returns one row per provider with call-level aggregates plus last-status
 * subselects. Excludes rows where provider is NULL or '-', and excludes
 * providers with no live row in `provider_connections` — a deleted provider
 * connection must not keep surfacing as a ghost topology node forever from
 * its retained historical call_logs rows. See #10714.
 *
 * Rows stay per raw provider (one per topology node, index-backed subqueries);
 * family totals are folded in JS by `foldMetricRowsByFamily` (#15005).
 */
export const PROVIDER_METRICS_SQL = `SELECT
      c.provider,
      COUNT(*) AS "totalRequests",
      SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS "totalSuccesses",
      ROUND(AVG(duration)) AS "avgLatencyMs",
      COUNT(duration) AS "latencySamples",
      MAX("timestamp") AS "lastRequestAt",
      MAX(
        CASE
          WHEN (status IS NOT NULL AND (status < 200 OR status >= 400))
            OR error_summary IS NOT NULL
          THEN "timestamp"
          ELSE NULL
        END
      ) AS "lastErrorAt",
      (
        SELECT c2.status
        FROM call_logs c2
        WHERE c2.provider = c.provider
        ORDER BY c2."timestamp" DESC, c2.id DESC
        LIMIT 1
      ) AS "lastStatus",
      (
        SELECT c3.status
        FROM call_logs c3
        WHERE c3.provider = c.provider
          AND (
            (c3.status IS NOT NULL AND (c3.status < 200 OR c3.status >= 400))
            OR c3.error_summary IS NOT NULL
          )
        ORDER BY c3."timestamp" DESC, c3.id DESC
        LIMIT 1
      ) AS "lastErrorStatus"
    FROM call_logs c
    WHERE c.provider IS NOT NULL AND c.provider != '-'
      AND EXISTS (
        SELECT 1 FROM provider_connections pc WHERE pc.provider = c.provider
      )
    GROUP BY c.provider`;

export async function getProviderMetrics(): Promise<ProviderMetricRow[]> {
  return db().query<ProviderMetricRow>(PROVIDER_METRICS_SQL);
}

/**
 * Rewrites `@name` placeholders (the shape the usage analytics route builds its
 * WHERE clauses with) into `$n` and returns the positional values. A name that
 * repeats reuses its index.
 */
function bindNamedParams(
  sql: string,
  params: Record<string, unknown>
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const indexByName = new Map<string, number>();
  const bound = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
    if (!(name in params)) return match;
    let index = indexByName.get(name);
    if (index === undefined) {
      values.push(params[name]);
      index = values.length;
      indexByName.set(name, index);
    }
    return `$${index}`;
  });
  return { sql: bound, values };
}

// ---------------------------------------------------------------------------
// /api/free-provider-rankings — windowed usage aggregate
// ---------------------------------------------------------------------------

/**
 * Per-provider usage over a time window: how much traffic a provider actually
 * served, and how much of it succeeded.
 *
 * Deliberately NOT `getProviderMetrics()` with a `since` parameter: that query
 * carries two correlated subqueries (`lastStatus`, `lastErrorStatus`) which a
 * ranking never displays, and they dominate its cost. Here a single bounded
 * `GROUP BY` leans on `idx_cl_timestamp` plus `idx_cl_provider_timestamp` /
 * `idx_cl_request_provider` (migration 174) and stops there. The rules are shared with its neighbour, not the query: same success
 * definition, same `#10714` guard against providers whose connections are gone.
 */
export async function getProviderUsageSince(since: string): Promise<ProviderUsageRow[]> {
  const rows = await db().query<ProviderUsageRow>(
    `SELECT
          c.provider,
          COUNT(*) AS requests,
          SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) AS successes,
          ROUND(AVG(c.duration)) AS "avgLatencyMs",
          COUNT(c.duration) AS "latencySamples",
          MAX(c."timestamp") AS "lastRequestAt"
        FROM call_logs c
        WHERE c.provider IS NOT NULL AND c.provider != '-'
          AND c."timestamp" >= $1
          AND EXISTS (
            SELECT 1 FROM provider_connections pc WHERE pc.provider = c.provider
          )
        GROUP BY c.provider`,
    [ts(since)]
  );
  // Grouped by the raw column in SQL, folded per connection family here (#15005).
  return foldUsageRowsByFamily(rows);
}

// ---------------------------------------------------------------------------
// /api/search/stats — search provider aggregates + recent entries
// ---------------------------------------------------------------------------

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

let searchLiveProviderGuardSql: string | null = null;

/** Always applied: never surface a NULL provider or the '-' sentinel. */
const SEARCH_PROVIDER_PRESENT_SQL = "c.provider IS NOT NULL AND c.provider != '-'";

/**
 * WHERE fragment shared by every search query below (alias `c` = call_logs).
 * A search row is surfaced only when its provider is still servable:
 *  - never a NULL provider or the '-' sentinel;
 *  - with SEARCH_STATS_HIDE_DELETED_CONNECTIONS on, a keyed provider also needs a
 *    provider_connections row, for itself or for one of its credential fallbacks
 *    (perplexity-search reuses a `perplexity` key), so a deleted connection stops
 *    resurfacing from its retained call_logs rows;
 *  - keyless providers (`authType: "none"` in the search registry, e.g.
 *    duckduckgo-free, searxng-search, anonymous context7) are always live —
 *    they are served without any provider_connections row.
 * The flag defaults to off, which keeps the historical stats: every retained row
 * with a real provider id counts. Built from registry constants on first use.
 */
function getSearchLiveProviderGuardSql(): string {
  if (!isSearchStatsHideDeletedConnectionsEnabled()) return SEARCH_PROVIDER_PRESENT_SQL;
  if (searchLiveProviderGuardSql !== null) return searchLiveProviderGuardSql;
  const keyless = Object.values(SEARCH_PROVIDERS)
    .filter((provider) => provider.authType === "none")
    .map((provider) => sqlStringLiteral(provider.id));
  const fallbackPairs = Object.entries(SEARCH_CREDENTIAL_FALLBACKS).flatMap(
    ([searchId, fallback]) =>
      (Array.isArray(fallback) ? fallback : [fallback]).map(
        (fallbackId) => `(${sqlStringLiteral(searchId)}, ${sqlStringLiteral(fallbackId)})`
      )
  );
  const keylessClause = keyless.length > 0 ? `c.provider IN (${keyless.join(", ")}) OR ` : "";
  const fallbackClause =
    fallbackPairs.length > 0
      ? `
            OR EXISTS (
              SELECT 1 FROM (VALUES ${fallbackPairs.join(", ")}) AS fb(column1, column2)
              JOIN provider_connections pcf ON pcf.provider = fb.column2
              WHERE fb.column1 = c.provider
            )`
      : "";
  searchLiveProviderGuardSql = `${SEARCH_PROVIDER_PRESENT_SQL}
          AND (
            ${keylessClause}EXISTS (
              SELECT 1 FROM provider_connections pc WHERE pc.provider = c.provider
            )${fallbackClause}
          )`;
  return searchLiveProviderGuardSql;
}

/** Fail closed to the historical behavior when the flag cannot be resolved. */
function isSearchStatsHideDeletedConnectionsEnabled(): boolean {
  try {
    return isFeatureFlagEnabled("SEARCH_STATS_HIDE_DELETED_CONNECTIONS");
  } catch {
    return false;
  }
}

/**
 * Per-provider request count and average latency for search requests.
 * Rows pass the search live-provider guard (see getSearchLiveProviderGuardSql).
 */
export async function getSearchProviderStats(): Promise<SearchProviderStatRow[]> {
  return db().query<SearchProviderStatRow>(
    `
        SELECT c.provider, COUNT(*) AS requests,
          FLOOR(AVG(c.duration))::integer AS avg_latency_ms
        FROM call_logs c
        WHERE c.request_type = 'search'
          AND ${getSearchLiveProviderGuardSql()}
        GROUP BY c.provider
      `
  );
}

/**
 * Most recent 10 search entries (request_summary + provider + timestamp).
 * Only rows from providers with a live connection are surfaced.
 */
export async function getRecentSearchLogs(): Promise<SearchRecentRow[]> {
  const rows = await db().query<
    Omit<SearchRecentRow, "request_summary"> & { request_summary: unknown }
  >(
    `
        SELECT c.request_summary, c.provider, c."timestamp"
        FROM call_logs c
        WHERE c.request_type = 'search'
          AND ${getSearchLiveProviderGuardSql()}
        ORDER BY c."timestamp" DESC
        LIMIT 10
      `
  );
  // request_summary is jsonb now; callers still read it as JSON text.
  return rows.map((row) => ({
    ...row,
    request_summary:
      row.request_summary === null || row.request_summary === undefined
        ? null
        : typeof row.request_summary === "string"
          ? row.request_summary
          : JSON.stringify(row.request_summary),
  }));
}

// ---------------------------------------------------------------------------
// /api/v1/search/analytics — aggregated search analytics
// ---------------------------------------------------------------------------

/**
 * Single-pass scalar aggregations for all search entries since `todayIso`.
 * `todayIso` is the ISO-8601 UTC start-of-day string used for the "today" count.
 * Uses the same live-provider guard as the per-provider breakdown, so `total`
 * always equals the sum of `getSearchProviderCounts()`.
 */
export async function getSearchAggregateStats(todayIso: string): Promise<SearchAggregateStats> {
  const row = await db().queryOne<SearchAggregateStats>(
    `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN c."timestamp" >= $1 THEN 1 ELSE 0 END), 0) AS today,
          COALESCE(SUM(CASE WHEN c.status >= 400 OR c.error_summary IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
          AVG(CASE WHEN c.duration > 0 THEN c.duration END) AS avg_duration,
          COALESCE(SUM(CASE WHEN c.cache_source = 'semantic' THEN 1 ELSE 0 END), 0) AS cached
         FROM call_logs c
         WHERE c.request_type = 'search'
          AND ${getSearchLiveProviderGuardSql()}`,
    [ts(todayIso)]
  );
  return row ?? { total: 0, today: 0, errors: 0, avg_duration: null, cached: 0 };
}

/**
 * Per-provider request count for search entries, ordered by count descending.
 * Rows pass the search live-provider guard (see getSearchLiveProviderGuardSql).
 */
export async function getSearchProviderCounts(): Promise<SearchProviderCountRow[]> {
  return db().query<SearchProviderCountRow>(
    `SELECT c.provider, COUNT(*) AS cnt
         FROM call_logs c WHERE c.request_type = 'search'
          AND ${getSearchLiveProviderGuardSql()}
         GROUP BY c.provider ORDER BY cnt DESC`
  );
}

// ---------------------------------------------------------------------------
// /api/usage/analytics — fallback-rate aggregates over call_logs
// ---------------------------------------------------------------------------

export interface FallbackStatsRow {
  total: number;
  with_requested: number;
  fallback_eligible: number;
  fallbacks: number;
}

/**
 * Scalar fallback-rate stats over `call_logs` for the usage analytics endpoint.
 *
 * @param whereClause - SQL WHERE clause (may be empty string) using the same
 *                      named params as the usage_history queries.
 * @param params      - Named params object (string values).
 */
export async function getFallbackStats(
  whereClause: string,
  params: Record<string, string>
): Promise<FallbackStatsRow> {
  const bound = bindNamedParams(
    `
      SELECT
        COALESCE(SUM(CASE WHEN (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN requested_model IS NOT NULL AND requested_model != '' AND (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END), 0) AS with_requested,
        COALESCE(SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
          THEN 1 ELSE 0 END
        ), 0) AS fallback_eligible,
        COALESCE(SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
           AND LOWER(CASE WHEN position('/' in requested_model) > 0 THEN substr(requested_model, position('/' in requested_model) + 1) ELSE requested_model END) != LOWER(model)
          THEN 1 ELSE 0 END
        ), 0) AS fallbacks
      FROM call_logs
      ${whereClause}
    `,
    params
  );
  const row = await db().queryOne<FallbackStatsRow>(bound.sql, bound.values);
  return row ?? { total: 0, with_requested: 0, fallback_eligible: 0, fallbacks: 0 };
}

// ERROR_TYPE_CUTOVER_ISO — single source of truth for the cutover: date of
// migration 158 (commit 4c15c05f9) that added `call_logs.error_type`.
export const ERROR_TYPE_CUTOVER_ISO = "2026-08-20";

// SQL `IN (...)` list of the persisted vocabulary. Built lazily (not at module
// evaluation) so an import cycle through the classifier can never observe the
// contract before it is initialised. Values are fixed identifiers; quotes are
// still escaped defensively.
let errorTypeVocabSql: string | null = null;
function getErrorTypeVocabSql(): string {
  if (errorTypeVocabSql === null) {
    errorTypeVocabSql = ERROR_TYPE_CONTRACT.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  }
  return errorTypeVocabSql;
}

/**
 * Failure-family breakdown over `call_logs` for the usage analytics endpoint.
 * Failures are rows with status >= 400 or a non-empty error summary; successes
 * are excluded in SQL. Rows predating migration 158 (`error_type` NULL,
 * `timestamp` before ERROR_TYPE_CUTOVER_ISO) land in `pre_migration`; other
 * NULL families land in `unclassified`, and so does any stored value outside
 * ERROR_TYPE_CONTRACT (free text written out of band). Every failure row lands
 * in exactly one bucket, so the counts always sum to the failure total.
 *
 * @param whereClause - SQL WHERE clause (may be empty string) using the same
 *                      named params as the usage_history queries.
 * @param params      - Named params object (string values).
 */
export async function getErrorTypeBreakdown(
  whereClause: string,
  params: Record<string, string>
): Promise<Array<{ errorType: string; count: number }>> {
  const bound = bindNamedParams(
    `
      SELECT
        -- ERROR_TYPE_CUTOVER_ISO (migration 158). Lower bound, not exact: late
        -- upgraders have post-cutoff rows with NULL values.
        CASE
          WHEN error_type IS NULL AND "timestamp" < '${ERROR_TYPE_CUTOVER_ISO}'::timestamptz THEN 'pre_migration'
          WHEN error_type IS NULL THEN 'unclassified'
          WHEN error_type NOT IN (${getErrorTypeVocabSql()}) THEN 'unclassified'
          ELSE error_type
        END AS "errorType",
        COUNT(*) AS count
      FROM call_logs
      ${whereClause} ${whereClause ? "AND" : "WHERE"} (status >= 400 OR error_summary IS NOT NULL)
      GROUP BY 1
      ORDER BY count DESC, "errorType" ASC
      `,
    params
  );
  const rows = await db().query<{ errorType: string; count: number }>(bound.sql, bound.values);
  return rows.map((row) => ({ errorType: String(row.errorType), count: Number(row.count) }));
}
