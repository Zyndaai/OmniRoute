/**
 * Aggregation utility functions for usage data summarization.
 * Rolls up usage_history (and quota_snapshots) into daily summary tables.
 *
 * @module lib/usage/aggregateHistory
 */

import { db, ts } from "@/lib/db/pg";
import { getDatabaseSettingsSection } from "../db/databaseSettingsSections";
import { calculateCost } from "./costCalculator";

interface AggregationResult {
  processed: number;
  inserted: number;
  errors: number;
}

/** Numeric field of a quota_snapshots `raw_data` document; non-numbers count as absent. */
const rawDataNumber = (field: string, integer: boolean) =>
  `CASE WHEN jsonb_typeof(raw_data->'${field}') = 'number'
        THEN ${integer ? `trunc((raw_data->>'${field}')::numeric)` : `(raw_data->>'${field}')::numeric`}
        END`;

/**
 * Roll up quota_snapshots into daily_usage_summary table.
 * Aggregates by provider, model, and date.
 *
 * @param fromDate - Start date (YYYY-MM-DD format)
 * @param toDate - End date (YYYY-MM-DD format)
 * @returns Aggregation result with counts
 */
export async function rollupDailyUsage(
  fromDate: string,
  toDate: string
): Promise<AggregationResult> {
  const result: AggregationResult = {
    processed: 0,
    inserted: 0,
    errors: 0,
  };

  try {
    // Aggregate quota_snapshots by provider, model, and date
    const aggregateQuery = `
      INSERT INTO daily_usage_summary (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
      SELECT
        provider,
        COALESCE(raw_data->>'model', 'unknown'),
        (created_at AT TIME ZONE 'UTC')::date,
        COUNT(*),
        COALESCE(SUM(${rawDataNumber("input_tokens", true)}), 0)::bigint,
        COALESCE(SUM(${rawDataNumber("output_tokens", true)}), 0)::bigint,
        COALESCE(SUM(${rawDataNumber("cost", false)}), 0)
      FROM quota_snapshots
      WHERE (created_at AT TIME ZONE 'UTC')::date >= $1::date
        AND (created_at AT TIME ZONE 'UTC')::date <= $2::date
      GROUP BY provider, COALESCE(raw_data->>'model', 'unknown'), (created_at AT TIME ZONE 'UTC')::date
      ON CONFLICT (provider, model, date) DO UPDATE SET
        total_requests = EXCLUDED.total_requests,
        total_input_tokens = EXCLUDED.total_input_tokens,
        total_output_tokens = EXCLUDED.total_output_tokens,
        total_cost = EXCLUDED.total_cost
    `;

    const runResult = await db().execute(aggregateQuery, [fromDate, toDate]);

    result.processed = runResult.changes;
    result.inserted = runResult.changes;

    console.log(`[Aggregation] Daily rollup: ${result.inserted} rows for ${fromDate} to ${toDate}`);
  } catch (err: any) {
    console.error("[Aggregation] Daily rollup error:", err);
    result.errors++;
  }

  return result;
}

type ArchivedUsageRow = {
  provider: string;
  model: string;
  date: string;
  serviceTier: string;
  totalRequests: number;
  requestInputTokens: number;
  requestOutputTokens: number;
  requestCacheReadTokens: number;
  requestCacheCreationTokens: number;
  requestReasoningTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  hasStoredCost: boolean;
  storedCost: number;
};

const TEAM_KEY_EXPRESSIONS = `
  COALESCE(NULLIF(uh.api_key_id, ''), 'unknown'),
  COALESCE(NULLIF(LOWER(uh.provider), ''), '__unknown_provider__'),
  COALESCE(NULLIF(LOWER(uh.model), ''), '__unknown_model__'),
  COALESCE(NULLIF(uh.service_tier, ''), 'standard'),
  (uh."timestamp" AT TIME ZONE 'UTC')::date`;

/** Merges two per-day shape-count objects (`{"[in,out,cr,cc,r]": n}`) by summing counts per shape. */
function mergeShapesSql(column: string) {
  return `(
          SELECT jsonb_object_agg(merged.shape, merged.total) FROM (
            SELECT entry.key AS shape, SUM(entry.value::bigint) AS total FROM (
              SELECT key, value FROM jsonb_each_text(COALESCE(daily_team_usage_summary.${column}, '{}'::jsonb))
              UNION ALL SELECT key, value FROM jsonb_each_text(EXCLUDED.${column})
            ) AS entry GROUP BY entry.key
          ) AS merged
        )`;
}

/**
 * Roll up usage_history into daily_usage_summary before raw rows are deleted.
 * This is the authoritative rollup — sourced from actual per-request token data,
 * not from quota_snapshots. Should be called before cleanupUsageHistory() deletes rows.
 *
 * Each complete provider/model/day row replaces any prior summary. usage_history
 * is authoritative, so retries after a crash between rollup and delete remain
 * idempotent instead of double-counting the same raw rows.
 *
 * @param beforeDate - ISO timestamp/date boundary. Rows strictly before this value are rolled up.
 * @returns Aggregation result with counts
 */
export async function rollupUsageHistoryBeforeDate(beforeDate: string): Promise<AggregationResult> {
  const result: AggregationResult = {
    processed: 0,
    inserted: 0,
    errors: 0,
  };

  try {
    const before = ts(beforeDate);
    if (!before) throw new Error(`Invalid rollup boundary: ${beforeDate}`);
    const rollupStartedAt = new Date().toISOString();
    const teamAggregateQuery = `
      WITH shape_counts AS (
        SELECT uh.billing_team_id AS team_id,
          COALESCE(NULLIF(uh.api_key_id, ''), 'unknown') AS api_key_id,
          MAX(NULLIF(uh.api_key_name, '')) AS api_key_name,
          COALESCE(NULLIF(LOWER(uh.provider), ''), '__unknown_provider__') AS provider,
          COALESCE(NULLIF(LOWER(uh.model), ''), '__unknown_model__') AS model,
          COALESCE(NULLIF(uh.service_tier, ''), 'standard') AS service_tier,
          (uh."timestamp" AT TIME ZONE 'UTC')::date AS date,
          '[' || COALESCE(uh.tokens_input, 0) || ',' || COALESCE(uh.tokens_output, 0) || ','
            || COALESCE(uh.tokens_cache_read, 0) || ',' || COALESCE(uh.tokens_cache_creation, 0) || ','
            || COALESCE(uh.tokens_reasoning, 0) || ']' AS shape,
          COUNT(*) AS count_all,
          SUM(CASE WHEN uh.success THEN 1 ELSE 0 END) AS count_success
        FROM usage_history AS uh
        WHERE uh."timestamp" < $1 AND uh.billing_team_id IS NOT NULL AND uh.billing_team_id != ''
          AND uh.team_rollup_processed_at IS NULL
        GROUP BY uh.billing_team_id, ${TEAM_KEY_EXPRESSIONS}, shape
      ), grouped_shapes AS (
        SELECT team_id, api_key_id, MAX(api_key_name) AS api_key_name, provider, model, service_tier, date,
          jsonb_object_agg(shape, count_all) AS token_shapes,
          jsonb_object_agg(shape, count_success) AS successful_token_shapes
        FROM shape_counts
        GROUP BY team_id, api_key_id, provider, model, service_tier, date
      )
      INSERT INTO daily_team_usage_summary (
        team_id, api_key_id, api_key_name, provider, model, service_tier, date,
        total_requests, successful_requests, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens,
        successful_input_tokens, successful_output_tokens, successful_cache_read_tokens,
        successful_cache_creation_tokens, successful_reasoning_tokens,
        token_shapes, successful_token_shapes
      )
      SELECT
        uh.billing_team_id,
        COALESCE(NULLIF(uh.api_key_id, ''), 'unknown'),
        MAX(NULLIF(uh.api_key_name, '')),
        COALESCE(NULLIF(LOWER(uh.provider), ''), '__unknown_provider__'),
        COALESCE(NULLIF(LOWER(uh.model), ''), '__unknown_model__'),
        COALESCE(NULLIF(uh.service_tier, ''), 'standard'),
        (uh."timestamp" AT TIME ZONE 'UTC')::date,
        COUNT(*),
        COALESCE(SUM(CASE WHEN uh.success THEN 1 ELSE 0 END), 0),
        COALESCE(SUM(uh.tokens_input), 0),
        COALESCE(SUM(uh.tokens_output), 0),
        COALESCE(SUM(uh.tokens_cache_read), 0),
        COALESCE(SUM(uh.tokens_cache_creation), 0),
        COALESCE(SUM(uh.tokens_reasoning), 0),
        COALESCE(SUM(CASE WHEN uh.success THEN uh.tokens_input ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN uh.success THEN uh.tokens_output ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN uh.success THEN uh.tokens_cache_read ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN uh.success THEN uh.tokens_cache_creation ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN uh.success THEN uh.tokens_reasoning ELSE 0 END), 0),
        grouped_shapes.token_shapes, grouped_shapes.successful_token_shapes
      FROM usage_history AS uh
      JOIN grouped_shapes ON grouped_shapes.team_id = uh.billing_team_id
        AND grouped_shapes.api_key_id = COALESCE(NULLIF(uh.api_key_id, ''), 'unknown')
        AND grouped_shapes.provider = COALESCE(NULLIF(LOWER(uh.provider), ''), '__unknown_provider__')
        AND grouped_shapes.model = COALESCE(NULLIF(LOWER(uh.model), ''), '__unknown_model__')
        AND grouped_shapes.service_tier = COALESCE(NULLIF(uh.service_tier, ''), 'standard')
        AND grouped_shapes.date = (uh."timestamp" AT TIME ZONE 'UTC')::date
      WHERE uh."timestamp" < $1
        AND uh.billing_team_id IS NOT NULL AND uh.billing_team_id != ''
        AND uh.team_rollup_processed_at IS NULL
      GROUP BY uh.billing_team_id, ${TEAM_KEY_EXPRESSIONS},
        grouped_shapes.token_shapes, grouped_shapes.successful_token_shapes
      ON CONFLICT (team_id, api_key_id, provider, model, service_tier, date) DO UPDATE SET
        api_key_name = COALESCE(EXCLUDED.api_key_name, daily_team_usage_summary.api_key_name),
        total_requests = daily_team_usage_summary.total_requests + EXCLUDED.total_requests,
        successful_requests = daily_team_usage_summary.successful_requests + EXCLUDED.successful_requests,
        total_input_tokens = daily_team_usage_summary.total_input_tokens + EXCLUDED.total_input_tokens,
        total_output_tokens = daily_team_usage_summary.total_output_tokens + EXCLUDED.total_output_tokens,
        total_cache_read_tokens = daily_team_usage_summary.total_cache_read_tokens + EXCLUDED.total_cache_read_tokens,
        total_cache_creation_tokens = daily_team_usage_summary.total_cache_creation_tokens + EXCLUDED.total_cache_creation_tokens,
        total_reasoning_tokens = daily_team_usage_summary.total_reasoning_tokens + EXCLUDED.total_reasoning_tokens,
        successful_input_tokens = daily_team_usage_summary.successful_input_tokens + EXCLUDED.successful_input_tokens,
        successful_output_tokens = daily_team_usage_summary.successful_output_tokens + EXCLUDED.successful_output_tokens,
        successful_cache_read_tokens = daily_team_usage_summary.successful_cache_read_tokens + EXCLUDED.successful_cache_read_tokens,
        successful_cache_creation_tokens = daily_team_usage_summary.successful_cache_creation_tokens + EXCLUDED.successful_cache_creation_tokens,
        successful_reasoning_tokens = daily_team_usage_summary.successful_reasoning_tokens + EXCLUDED.successful_reasoning_tokens,
        token_shapes = CASE WHEN daily_team_usage_summary.total_requests > 0
          AND daily_team_usage_summary.token_shapes IS NULL THEN NULL ELSE ${mergeShapesSql("token_shapes")} END,
        successful_token_shapes = CASE WHEN daily_team_usage_summary.successful_requests > 0
          AND daily_team_usage_summary.successful_token_shapes IS NULL THEN NULL ELSE ${mergeShapesSql("successful_token_shapes")} END
    `;
    const rows = await db().query<ArchivedUsageRow>(
      `SELECT
          LOWER(provider) as provider,
          LOWER(model) as model,
          (("timestamp" AT TIME ZONE 'UTC')::date)::text as date,
          COALESCE(NULLIF(service_tier, ''), 'standard') as "serviceTier",
          COUNT(*) as "totalRequests",
          COALESCE(tokens_input, 0) as "requestInputTokens",
          COALESCE(tokens_output, 0) as "requestOutputTokens",
          COALESCE(tokens_cache_read, 0) as "requestCacheReadTokens",
          COALESCE(tokens_cache_creation, 0) as "requestCacheCreationTokens",
          COALESCE(tokens_reasoning, 0) as "requestReasoningTokens",
          COALESCE(SUM(tokens_input), 0) as "inputTokens",
          COALESCE(SUM(tokens_output), 0) as "outputTokens",
          COALESCE(SUM(tokens_cache_read), 0) as "cacheReadTokens",
          COALESCE(SUM(tokens_cache_creation), 0) as "cacheCreationTokens",
          COALESCE(SUM(tokens_reasoning), 0) as "reasoningTokens",
          (provider_cost_usd IS NOT NULL) as "hasStoredCost",
          COALESCE(SUM(provider_cost_usd), 0) as "storedCost"
        FROM usage_history
        WHERE "timestamp" < $1
          AND provider IS NOT NULL AND provider != ''
          AND model IS NOT NULL AND model != ''
        GROUP BY LOWER(provider), LOWER(model), ("timestamp" AT TIME ZONE 'UTC')::date,
          COALESCE(NULLIF(service_tier, ''), 'standard'),
          COALESCE(tokens_input, 0), COALESCE(tokens_output, 0), COALESCE(tokens_cache_read, 0),
          COALESCE(tokens_cache_creation, 0), COALESCE(tokens_reasoning, 0),
          (provider_cost_usd IS NOT NULL)`,
      [before]
    );

    const pricedRows = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        // Price one request of this exact token shape, then multiply by how many
        // identical requests the group holds. Pricing is a pure function of the
        // token shape, so this equals per-request pricing while still collapsing
        // duplicates. Pricing the day's SUMMED tokens instead would be wrong:
        // non-cached input is clamped at zero per request, and summing first lets
        // one cache-heavy request's clamped surplus cancel another request's
        // billable input.
        //
        // A request with a provider-reported exact cost (`provider_cost_usd`) is
        // archived at that cost; none of its tokens are priced.
        totalCost: row.hasStoredCost
          ? row.storedCost
          : (await calculateCost(
              row.provider,
              row.model,
              {
                input: row.requestInputTokens,
                output: row.requestOutputTokens,
                cacheRead: row.requestCacheReadTokens,
                cacheCreation: row.requestCacheCreationTokens,
                reasoning: row.requestReasoningTokens,
              },
              {
                provider: row.provider,
                model: row.model,
                serviceTier: row.serviceTier,
                // The archive stores API-equivalent value. Billed-cost consumers
                // still mask flat-rate providers when they read this value.
                flatRateAsZero: false,
              }
            )) * row.totalRequests,
      }))
    );

    const archivedRows = Array.from(
      pricedRows
        .reduce((byDay, row) => {
          const key = `${row.provider}\u0000${row.model}\u0000${row.date}`;
          const existing = byDay.get(key);
          if (existing) {
            existing.totalRequests += row.totalRequests;
            existing.inputTokens += row.inputTokens;
            existing.outputTokens += row.outputTokens;
            existing.totalCost += row.totalCost;
          } else {
            byDay.set(key, {
              provider: row.provider,
              model: row.model,
              date: row.date,
              totalRequests: row.totalRequests,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              totalCost: row.totalCost,
            });
          }
          return byDay;
        }, new Map<string, { provider: string; model: string; date: string; totalRequests: number; inputTokens: number; outputTokens: number; totalCost: number }>())
        .values()
    );

    // The summary upserts, the Team upsert and the raw-row processed marker are one
    // transaction. If any fails, none becomes visible and a retry cannot double count.
    const inserted = await db().transaction(async (tx) => {
      let changes = 0;
      for (const row of archivedRows) {
        const upserted = await tx.execute(
          `INSERT INTO daily_usage_summary
            (provider, model, date, total_requests, total_input_tokens, total_output_tokens, total_cost)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7)
           ON CONFLICT (provider, model, date) DO UPDATE SET
            total_requests = EXCLUDED.total_requests,
            total_input_tokens = EXCLUDED.total_input_tokens,
            total_output_tokens = EXCLUDED.total_output_tokens,
            total_cost = EXCLUDED.total_cost`,
          [
            row.provider,
            row.model,
            row.date,
            Math.round(row.totalRequests),
            Math.round(row.inputTokens),
            Math.round(row.outputTokens),
            row.totalCost,
          ]
        );
        changes += upserted.changes;
      }
      await tx.execute(teamAggregateQuery, [before]);
      await tx.execute(
        `UPDATE usage_history
         SET team_rollup_processed_at = $1
         WHERE "timestamp" < $2
           AND billing_team_id IS NOT NULL AND billing_team_id != ''
           AND team_rollup_processed_at IS NULL`,
        [rollupStartedAt, before]
      );
      return changes;
    });

    result.processed = rows.length;
    result.inserted = inserted;

    console.log(
      `[Aggregation] usage_history rollup: ${result.inserted} rows for dates before ${beforeDate}`
    );
  } catch (err: any) {
    console.error("[Aggregation] usage_history rollup error:", err);
    result.errors++;
  }

  return result;
}

/**
 * Get the cutoff date for raw data based on retention settings.
 * Data older than this should be aggregated and cleaned up.
 *
 * @returns ISO date string (YYYY-MM-DD)
 */
export async function getRawDataCutoffDate(): Promise<string> {
  // The raw-data cutoff MUST match the actual rollup/delete boundary used by
  // cleanupUsageHistory (src/lib/db/cleanup.ts), which is driven by
  // retention.usageHistory — NOT aggregation.rawDataRetentionDays.
  // Using rawDataRetentionDays (default 7 per migration 046) creates a gap:
  // analytics floors raw data at day-7 while cleanup doesn't roll up until
  // day-30, so the window [day-30, day-7) is excluded from BOTH UNION legs.
  const rawDataRetentionDays = (await getDatabaseSettingsSection("retention")).usageHistory;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - rawDataRetentionDays);

  return cutoffDate.toISOString().split("T")[0];
}

/**
 * Check if aggregation is enabled in settings.
 */
export async function isAggregationEnabled(): Promise<boolean> {
  return (await getDatabaseSettingsSection("aggregation")).enabled;
}
