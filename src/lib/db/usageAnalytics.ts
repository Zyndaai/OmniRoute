/**
 * db/usageAnalytics.ts — Read-only aggregation queries over `usage_history`
 * and `daily_usage_summary` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/usage/analytics and /api/settings/export-json routes can delegate.
 * Read-only aggregation; no writes.
 *
 * Callers pass filter fragments with `@name` placeholders; `run()` rewrites them to
 * `$n` positional parameters.
 *
 * Sliced out of #3500 (usage_history / daily_usage_summary cluster).
 */

import { db } from "@/lib/db/pg";
import type { AnalyticsParams } from "./usageAnalytics/unifiedSources";

export { buildUnifiedSource, buildPresetUnifiedSource } from "./usageAnalytics/unifiedSources";
export type {
  AnalyticsParams,
  BuildUnifiedSourceOptions,
  UnifiedSourceResult,
} from "./usageAnalytics/unifiedSources";

/** UTC calendar day of a timestamp column, as a `date` (returned as `YYYY-MM-DD`). */
const dayOf = (column: string) => `(${column} AT TIME ZONE 'UTC')::date`;

const SERVICE_TIER_SQL = `COALESCE(NULLIF(service_tier, ''), 'standard')`;

/** Rewrites `@name` placeholders to `$n` and collects the values in order. */
function bindNamed(sql: string, params: Record<string, unknown>): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const indexOf = new Map<string, number>();
  const text = sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    let index = indexOf.get(name);
    if (index === undefined) {
      if (!(name in params)) throw new Error(`Missing analytics query parameter: ${name}`);
      values.push(params[name]);
      index = values.length;
      indexOf.set(name, index);
    }
    return `$${index}`;
  });
  return { text, values };
}

async function run<T>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const { text, values } = bindNamed(sql, params);
  return db().query<T>(text, values);
}

/**
 * Priceable-token sums over a unified source (see RAW_COST_COLUMNS in
 * ./usageAnalytics/unifiedSources). The display token sums stay untouched; cost is the
 * stored cost plus these tokens priced, so a row with a provider-reported cost is
 * never priced a second time.
 */
const UNIFIED_COST_TOKEN_SUMS = `
        COALESCE(SUM(cost_tokens_input), 0) as "costPromptTokens",
        COALESCE(SUM(cost_tokens_output), 0) as "costCompletionTokens",
        COALESCE(SUM(cost_tokens_cache_read), 0) as "costCacheReadTokens",
        COALESCE(SUM(cost_tokens_cache_creation), 0) as "costCacheCreationTokens",
        COALESCE(SUM(cost_tokens_reasoning), 0) as "costReasoningTokens"`;

/** The same split for queries that read usage_history directly. */
function rawCostSums(table: string): string {
  const priceable = (column: string) =>
    `COALESCE(SUM(CASE WHEN ${table}.provider_cost_usd IS NULL THEN ${table}.${column} ELSE 0 END), 0)`;
  return `
        COALESCE(SUM(${table}.provider_cost_usd), 0.0) as "storedCost",
        0 as "isAggregated",
        ${priceable("tokens_input")} as "costPromptTokens",
        ${priceable("tokens_output")} as "costCompletionTokens",
        ${priceable("tokens_cache_read")} as "costCacheReadTokens",
        ${priceable("tokens_cache_creation")} as "costCacheCreationTokens",
        ${priceable("tokens_reasoning")} as "costReasoningTokens"`;
}

/** Priceable-token fields carried by every cost row. */
export interface CostTokenFields {
  costPromptTokens: number;
  costCompletionTokens: number;
  costCacheReadTokens: number;
  costCacheCreationTokens: number;
  costReasoningTokens: number;
}

// ---------------------------------------------------------------------------
// Analytics summary — /api/usage/analytics
// ---------------------------------------------------------------------------

export interface UsageSummaryRow {
  totalRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  uniqueModels: number;
  uniqueAccounts: number;
  uniqueApiKeys: number;
  successfulRequests: number;
  avgLatencyMs: number;
  firstRequest: string;
  lastRequest: string;
}

/**
 * Scalar summary over the unified source CTE.
 *
 * @param unifiedSource - Pre-built subquery string (UNION of raw + aggregated rows).
 * @param params        - Named params referenced inside `unifiedSource`.
 */
export async function getUsageSummary(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<UsageSummaryRow> {
  const [row] = await run<Omit<UsageSummaryRow, "firstRequest" | "lastRequest"> & {
    firstRequest: string | null;
    lastRequest: string | null;
  }>(
    `
      SELECT
        COALESCE(SUM(requests), 0) as "totalRequests",
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens",
        COUNT(DISTINCT model) as "uniqueModels",
        COUNT(DISTINCT COALESCE(NULLIF(account_key, ''), NULLIF(connection_id, ''))) as "uniqueAccounts",
        COUNT(DISTINCT COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''))) as "uniqueApiKeys",
        COALESCE(SUM(CASE WHEN success THEN requests ELSE 0 END), 0) as "successfulRequests",
        COALESCE(AVG(latency_ms), 0) as "avgLatencyMs",
        MIN("timestamp") as "firstRequest",
        MAX("timestamp") as "lastRequest"
      FROM ${unifiedSource} AS _u
    `,
    params
  );
  if (!row) {
    return {
      totalRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      uniqueModels: 0,
      uniqueAccounts: 0,
      uniqueApiKeys: 0,
      successfulRequests: 0,
      avgLatencyMs: 0,
      firstRequest: "",
      lastRequest: "",
    };
  }
  return { ...row, firstRequest: row.firstRequest ?? "", lastRequest: row.lastRequest ?? "" };
}

// ---------------------------------------------------------------------------

export interface DailyUsageRow {
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Daily request + token counts aggregated from the unified source CTE.
 */
export async function getDailyUsage(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<DailyUsageRow[]> {
  return run<DailyUsageRow>(
    `
      SELECT
        ${dayOf(`"timestamp"`)} as "date",
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens"
      FROM ${unifiedSource} AS _u
      GROUP BY ${dayOf(`"timestamp"`)}
      ORDER BY "date" ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface DailyCostRow extends CostTokenFields {
  date: string;
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-day, per-provider, per-model token breakdown for cost calculation.
 */
export async function getDailyCostRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<DailyCostRow[]> {
  return run<DailyCostRow>(
    `
      SELECT
        ${dayOf(`"timestamp"`)} as "date",
        LOWER(provider) as provider,
        LOWER(model) as model,
        ${SERVICE_TIER_SQL} as "serviceTier",
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        COALESCE(SUM(stored_cost), 0.0) as "storedCost",
        MAX(is_aggregated) as "isAggregated",
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      GROUP BY ${dayOf(`"timestamp"`)}, LOWER(provider), LOWER(model), ${SERVICE_TIER_SQL}
      ORDER BY "date" ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface HeatmapRow {
  date: string;
  totalTokens: number;
}

/**
 * Per-day token totals for the activity heatmap.
 * Uses `usage_history` directly (not the unified CTE) since the heatmap has its
 * own independent time window and api_key filter.
 *
 * @param heatmapConditions - Array of SQL condition strings (combined with AND).
 * @param params            - Named params referenced inside the conditions.
 */
export async function getHeatmapRows(
  heatmapConditions: string[],
  params: AnalyticsParams
): Promise<HeatmapRow[]> {
  return run<HeatmapRow>(
    `
      SELECT
        ${dayOf(`"timestamp"`)} as "date",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens"
      FROM usage_history
      WHERE ${heatmapConditions.join(" AND ")}
      GROUP BY ${dayOf(`"timestamp"`)}
      ORDER BY "date" ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ModelUsageRow extends CostTokenFields {
  model: string;
  provider: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-model usage aggregates from the unified source CTE.
 */
export async function getModelUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ModelUsageRow[]> {
  return run<ModelUsageRow>(
    `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        ${SERVICE_TIER_SQL} as "serviceTier",
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens",
        COALESCE(AVG(latency_ms), 0) as "avgLatencyMs",
        COALESCE(SUM(CASE WHEN success THEN requests ELSE 0 END), 0) as "successfulRequests",
        MAX("timestamp") as "lastUsed",
        COALESCE(SUM(stored_cost), 0.0) as "storedCost",
        MAX(is_aggregated) as "isAggregated",
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      -- Keep cost inputs separated by day. Historical provider rows do not
      -- always use one cache-token convention, and computeCostFromPricing's
      -- non-cached-input clamp is intentionally non-linear across those rows.
      GROUP BY ${dayOf(`"timestamp"`)}, LOWER(model), LOWER(provider), ${SERVICE_TIER_SQL}
      ORDER BY requests DESC
    `,
    params
  ).then((rows) => rows.map((row) => ({ ...row, lastUsed: row.lastUsed ?? "" })));
}

// ---------------------------------------------------------------------------

export interface ProviderCostRow extends CostTokenFields {
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-provider, per-model token breakdown for provider cost calculation.
 */
export async function getProviderCostRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderCostRow[]> {
  return run<ProviderCostRow>(
    `
      SELECT
        LOWER(provider) as provider,
        LOWER(model) as model,
        ${SERVICE_TIER_SQL} as "serviceTier",
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        COALESCE(SUM(stored_cost), 0.0) as "storedCost",
        MAX(is_aggregated) as "isAggregated",
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      GROUP BY ${dayOf(`"timestamp"`)}, LOWER(provider), LOWER(model), ${SERVICE_TIER_SQL}
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ProviderUsageRow {
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
}

/**
 * Per-provider usage aggregates from the unified source CTE.
 */
export async function getProviderUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderUsageRow[]> {
  return run<ProviderUsageRow>(
    `
      SELECT
        LOWER(provider) as provider,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens",
        COALESCE(AVG(latency_ms), 0) as "avgLatencyMs",
        COALESCE(SUM(CASE WHEN success THEN requests ELSE 0 END), 0) as "successfulRequests"
      FROM ${unifiedSource} AS _u
      GROUP BY LOWER(provider)
      ORDER BY requests DESC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface AccountCostRow extends CostTokenFields {
  accountKey: string;
  provider: string;
  model: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/** The account key stored on a usage event, or a per-connection fallback for legacy rows. */
const RESOLVED_ACCOUNT_KEY_SQL = (table: string) => `COALESCE(
            NULLIF(${table}.account_key, ''),
            'connection:' || COALESCE(LOWER(${table}.provider), 'unknown') || ':' || COALESCE(NULLIF(BTRIM(${table}.connection_id), ''), 'unknown')
          )`;

/**
 * Per-account cost breakdown grouped by the identity snapshot stored on each usage event.
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export async function getAccountCostRows(
  whereClause: string,
  params: AnalyticsParams
): Promise<AccountCostRow[]> {
  return run<AccountCostRow>(
    `
      WITH account_events AS (
        SELECT
          ${RESOLVED_ACCOUNT_KEY_SQL("usage_history")} as resolved_account_key,
          usage_history.provider,
          usage_history.model,
          usage_history.service_tier,
          usage_history."timestamp",
          usage_history.tokens_input,
          usage_history.tokens_output,
          usage_history.tokens_cache_read,
          usage_history.tokens_cache_creation,
          usage_history.tokens_reasoning,
          usage_history.provider_cost_usd
        FROM usage_history
        ${whereClause}
      )
      SELECT
        account_events.resolved_account_key as "accountKey",
        LOWER(account_events.provider) as provider,
        LOWER(account_events.model) as model,
        COALESCE(NULLIF(account_events.service_tier, ''), 'standard') as "serviceTier",
        COALESCE(SUM(account_events.tokens_input), 0) as "promptTokens",
        COALESCE(SUM(account_events.tokens_output), 0) as "completionTokens",
        COALESCE(SUM(account_events.tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(account_events.tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(account_events.tokens_reasoning), 0) as "reasoningTokens",
        ${rawCostSums("account_events")}
      FROM account_events
      GROUP BY ${dayOf(`account_events."timestamp"`)}, account_events.resolved_account_key,
        LOWER(account_events.provider), LOWER(account_events.model),
        COALESCE(NULLIF(account_events.service_tier, ''), 'standard')
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface AccountUsageRow {
  accountKey: string;
  account: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  lastUsed: string;
}

/**
 * Per-account usage aggregates grouped by the identity snapshot stored on each usage event.
 *
 * @param whereClause - SQL WHERE clause (may be empty string); column refs already
 *                      prefixed with `usage_history.` by the caller.
 * @param params      - Named params referenced inside `whereClause`.
 */
export async function getAccountUsageRows(
  whereClause: string,
  params: AnalyticsParams
): Promise<AccountUsageRow[]> {
  const rows = await run<AccountUsageRow>(
    `
      WITH account_events AS (
        SELECT
          usage_history.*,
          ${RESOLVED_ACCOUNT_KEY_SQL("usage_history")} as resolved_account_key
        FROM usage_history
        ${whereClause}
      ),
      stable_account_keys AS (
        SELECT DISTINCT account_key
        FROM account_events
        WHERE account_key > ''
      ),
      stable_labels AS (
        SELECT
          stable_account_keys.account_key,
          (
            SELECT BTRIM(usage_history.account_label)
            FROM usage_history
            WHERE usage_history.account_key = stable_account_keys.account_key
              AND NULLIF(BTRIM(usage_history.account_label), '') IS NOT NULL
            ORDER BY COALESCE(usage_history.account_label_priority, 0) DESC,
                     usage_history."timestamp" DESC,
                     usage_history.id DESC
            LIMIT 1
          ) as account_label
        FROM stable_account_keys
      ),
      legacy_labels AS (
        SELECT account_key, account_label
        FROM (
          SELECT
            account_events.resolved_account_key as account_key,
            BTRIM(account_events.account_label) as account_label,
            ROW_NUMBER() OVER (
              PARTITION BY account_events.resolved_account_key
              ORDER BY COALESCE(account_events.account_label_priority, 0) DESC,
                       account_events."timestamp" DESC,
                       account_events.id DESC
            ) as label_rank
          FROM account_events
          WHERE (account_events.account_key IS NULL OR account_events.account_key = '')
            AND NULLIF(BTRIM(account_events.account_label), '') IS NOT NULL
        ) AS ranked_labels
        WHERE label_rank = 1
      ),
      selected_labels AS (
        SELECT account_key, account_label FROM stable_labels
        UNION ALL
        SELECT account_key, account_label FROM legacy_labels
      )
      SELECT
        account_events.resolved_account_key as "accountKey",
        MAX(COALESCE(NULLIF(BTRIM(selected_labels.account_label), ''), NULLIF(BTRIM(account_events.connection_id), ''), 'unknown')) as account,
        COUNT(account_events.id) as requests,
        COALESCE(SUM(account_events.tokens_input), 0) as "promptTokens",
        COALESCE(SUM(account_events.tokens_output), 0) as "completionTokens",
        COALESCE(SUM(account_events.tokens_input + account_events.tokens_output), 0) as "totalTokens",
        COALESCE(AVG(account_events.latency_ms), 0) as "avgLatencyMs",
        MAX(account_events."timestamp") as "lastUsed"
      FROM account_events
      LEFT JOIN selected_labels
        ON selected_labels.account_key = account_events.resolved_account_key
      GROUP BY account_events.resolved_account_key
      ORDER BY requests DESC
      LIMIT 50
    `,
    params
  );
  return rows.map((row) => ({ ...row, lastUsed: row.lastUsed ?? "" }));
}

// ---------------------------------------------------------------------------

export interface ApiKeyUsageRow extends CostTokenFields {
  apiKeyId: string | null;
  apiKeyGroupKey: string;
  provider: string;
  model: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-API-key usage aggregates from usage_history.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export async function getApiKeyUsageRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): Promise<ApiKeyUsageRow[]> {
  const groupKeySql = `COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown')`;
  return run<ApiKeyUsageRow>(
    `
      SELECT
        NULLIF(api_key_id, '') as "apiKeyId",
        ${groupKeySql} as "apiKeyGroupKey",
        LOWER(provider) as provider,
        LOWER(model) as model,
        ${SERVICE_TIER_SQL} as "serviceTier",
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens",
        ${rawCostSums("usage_history")}
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY ${dayOf(`"timestamp"`)}, ${groupKeySql}, NULLIF(api_key_id, ''), LOWER(provider), LOWER(model), ${SERVICE_TIER_SQL}
    `,
    params
  );
}

export interface ApiKeyTotalsRow extends CostTokenFields {
  apiKeyId: string | null;
  apiKeyName: string | null;
  provider: string;
  model: string;
  serviceTier: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  lastUsed: string | null;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-API-key totals and last-used time in a single scan, without the per-day
 * grouping of `getApiKeyUsageRows`. Backs the API Manager key list, which only
 * needs lifetime requests, cost and last use per key.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export async function getApiKeyTotalsRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): Promise<ApiKeyTotalsRow[]> {
  return run<ApiKeyTotalsRow>(
    `
      SELECT
        NULLIF(api_key_id, '') as "apiKeyId",
        NULLIF(api_key_name, '') as "apiKeyName",
        LOWER(provider) as provider,
        LOWER(model) as model,
        ${SERVICE_TIER_SQL} as "serviceTier",
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        MAX("timestamp") as "lastUsed",
        ${rawCostSums("usage_history")}
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), LOWER(provider), LOWER(model), ${SERVICE_TIER_SQL}
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ServiceTierUsageRow extends CostTokenFields {
  serviceTier: string;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-service-tier, per-provider, per-model usage aggregates.
 */
export async function getServiceTierUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ServiceTierUsageRow[]> {
  return run<ServiceTierUsageRow>(
    `
      SELECT
        ${SERVICE_TIER_SQL} as "serviceTier",
        LOWER(provider) as provider,
        LOWER(model) as model,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens",
        COALESCE(SUM(stored_cost), 0.0) as "storedCost",
        MAX(is_aggregated) as "isAggregated",
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${unifiedSource} AS _u
      GROUP BY ${dayOf(`"timestamp"`)}, ${SERVICE_TIER_SQL}, LOWER(provider), LOWER(model)
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface ApiKeyMetadataRow {
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyGroupKey: string;
  lastUsed: string;
}

/**
 * Latest API key name + group key from usage_history for display metadata.
 *
 * @param apiKeyWhereClause - Full WHERE clause including api_key presence guard.
 * @param params            - Named params referenced inside `apiKeyWhereClause`.
 */
export async function getApiKeyMetadataRows(
  apiKeyWhereClause: string,
  params: AnalyticsParams
): Promise<ApiKeyMetadataRow[]> {
  return run<ApiKeyMetadataRow>(
    `
      SELECT
        NULLIF(api_key_id, '') as "apiKeyId",
        NULLIF(api_key_name, '') as "apiKeyName",
        COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as "apiKeyGroupKey",
        MAX("timestamp") as "lastUsed"
      FROM usage_history
      ${apiKeyWhereClause}
      GROUP BY NULLIF(api_key_id, ''), NULLIF(api_key_name, '')
      ORDER BY "lastUsed" DESC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface WeeklyPatternRow {
  dayOfWeek: string;
  days: number;
  requests: number;
  totalTokens: number;
}

/**
 * Day-of-week aggregates for the weekly activity pattern chart.
 * `dayOfWeek` is '0' (Sunday) to '6' (Saturday), UTC.
 */
export async function getWeeklyPatternRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<WeeklyPatternRow[]> {
  const dow = `(EXTRACT(DOW FROM "timestamp" AT TIME ZONE 'UTC')::int)::text`;
  return run<WeeklyPatternRow>(
    `
      SELECT
        "dayOfWeek",
        COUNT(*) as days,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM("totalTokens"), 0) as "totalTokens"
      FROM (
        SELECT
          ${dayOf(`"timestamp"`)} as "date",
          ${dow} as "dayOfWeek",
          COALESCE(SUM(requests), 0) as requests,
          COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens"
        FROM ${unifiedSource} AS _u
        GROUP BY ${dayOf(`"timestamp"`)}, ${dow}
      ) AS daily
      GROUP BY "dayOfWeek"
      ORDER BY "dayOfWeek" ASC
    `,
    params
  );
}

// ---------------------------------------------------------------------------

export interface PresetCostModelRow extends CostTokenFields {
  model: string;
  provider: string;
  serviceTier: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  storedCost: number;
  isAggregated: number;
}

/**
 * Per-model token breakdown for preset range cost calculation.
 * Uses a preset-specific unified source (may differ from the main query window).
 */
export async function getPresetCostModelRows(
  presetUnifiedSource: string,
  params: AnalyticsParams
): Promise<PresetCostModelRow[]> {
  return run<PresetCostModelRow>(
    `
      SELECT
        LOWER(model) as model,
        LOWER(provider) as provider,
        ${SERVICE_TIER_SQL} as "serviceTier",
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        COALESCE(SUM(stored_cost), 0.0) as "storedCost",
        MAX(is_aggregated) as "isAggregated",
        ${UNIFIED_COST_TOKEN_SUMS}
      FROM ${presetUnifiedSource} AS _pu
      GROUP BY ${dayOf(`"timestamp"`)}, LOWER(model), LOWER(provider), ${SERVICE_TIER_SQL}
    `,
    params
  );
}

// ---------------------------------------------------------------------------
// Endpoint dimension — ported from decolua/9router#152 (thanks @toanalien).
// Reads directly from usage_history (raw rows) so the unified CTE stays
// untouched; matches the pattern used by getAutoRoutingVariantBreakdown.
// ---------------------------------------------------------------------------

export interface EndpointUsageRow {
  endpoint: string;
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  successfulRequests: number;
  lastUsed: string;
}

export interface EndpointUsageParams {
  sinceIso?: string | null;
  untilIso?: string | null;
}

/**
 * Per-endpoint × provider × model usage aggregates from `usage_history`.
 * NULL endpoints fold into the 'unknown' bucket so legacy rows stay visible.
 *
 * Inspired by decolua/9router#152 (byEndpoint aggregation), reshaped for the
 * OmniRoute analytics conventions.
 */
export async function getEndpointUsageRows(
  params: EndpointUsageParams = {}
): Promise<EndpointUsageRow[]> {
  const conditions: string[] = [];
  const bind: Record<string, unknown> = {};
  if (params.sinceIso) {
    conditions.push(`"timestamp" >= (@since)::timestamptz`);
    bind.since = params.sinceIso;
  }
  if (params.untilIso) {
    conditions.push(`"timestamp" <= (@until)::timestamptz`);
    bind.until = params.untilIso;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await run<Omit<EndpointUsageRow, "lastUsed"> & { lastUsed: string | null }>(
    `
      SELECT
        COALESCE(NULLIF(endpoint, ''), 'unknown') as endpoint,
        LOWER(COALESCE(provider, 'unknown')) as provider,
        LOWER(COALESCE(model, 'unknown')) as model,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
        COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
        COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens",
        COALESCE(AVG(latency_ms), 0) as "avgLatencyMs",
        COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END), 0) as "successfulRequests",
        MAX("timestamp") as "lastUsed"
      FROM usage_history
      ${whereSql}
      GROUP BY COALESCE(NULLIF(endpoint, ''), 'unknown'), LOWER(COALESCE(provider, 'unknown')), LOWER(COALESCE(model, 'unknown'))
      ORDER BY requests DESC
    `,
    bind
  );
  return rows.map((row) => ({ ...row, lastUsed: row.lastUsed ?? "" }));
}

// ---------------------------------------------------------------------------
// Request count per provider, per date — #4009
// ---------------------------------------------------------------------------

export interface ProviderDailyUsageRow {
  date: string;
  provider: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Per-day, per-provider request counts + token totals from the unified source CTE.
 * Answers "how many requests did provider X get on date Y" (#4009) — providers that
 * bill per-request rather than per-token need this breakdown, not just the
 * per-provider aggregate (`getProviderUsageRows`) or the per-day aggregate
 * (`getDailyUsage`).
 */
export async function getProviderDailyUsageRows(
  unifiedSource: string,
  params: AnalyticsParams
): Promise<ProviderDailyUsageRow[]> {
  return run<ProviderDailyUsageRow>(
    `
      SELECT
        ${dayOf(`"timestamp"`)} as "date",
        LOWER(provider) as provider,
        COUNT(*) as requests,
        COALESCE(SUM(tokens_input), 0) as "promptTokens",
        COALESCE(SUM(tokens_output), 0) as "completionTokens",
        COALESCE(SUM(tokens_input + tokens_output), 0) as "totalTokens"
      FROM ${unifiedSource} AS _u
      GROUP BY ${dayOf(`"timestamp"`)}, LOWER(provider)
      ORDER BY "date" DESC, requests DESC
    `,
    params
  );
}

// ---------------------------------------------------------------------------
// Export-JSON backup — /api/settings/export-json
// ---------------------------------------------------------------------------

/**
 * Returns all rows from `usage_history` for backup export.
 * Only called when `?includeHistory=true` is explicitly requested.
 */
export async function getAllUsageHistory(): Promise<Record<string, unknown>[]> {
  // Export format stays stable: `success` is 0/1, as in earlier exports.
  const rows = await db().query<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(t) - 'success'
              || jsonb_build_object('success', CASE WHEN t.success THEN 1 ELSE 0 END) AS j
       FROM usage_history t`
  );
  return rows.map((r) => r.j);
}

/** Returns durable team-dimensional summaries after raw history retention. */
export async function getAllDailyTeamUsageSummary(): Promise<Record<string, unknown>[]> {
  // Export format stays stable: shapes are exported as `*_json` text, which the importer reads.
  const rows = await db().query<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(t) - 'token_shapes' - 'successful_token_shapes'
              || jsonb_build_object(
                   'token_shapes_json', t.token_shapes::text,
                   'successful_token_shapes_json', t.successful_token_shapes::text) AS j
       FROM daily_team_usage_summary t`
  );
  return rows.map((r) => r.j);
}

/**
 * Returns all rows from `domain_cost_history` for backup export.
 */
export async function getAllDomainCostHistory(): Promise<Record<string, unknown>[]> {
  return db().query<Record<string, unknown>>("SELECT * FROM domain_cost_history");
}

/**
 * Returns all rows from `domain_budgets` for backup export.
 */
export async function getAllDomainBudgets(): Promise<Record<string, unknown>[]> {
  return db().query<Record<string, unknown>>("SELECT * FROM domain_budgets");
}
