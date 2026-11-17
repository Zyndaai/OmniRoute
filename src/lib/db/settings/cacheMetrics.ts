/**
 * db/settings/cacheMetrics.ts — Cache control metrics (computed from usage_history on-the-fly).
 */

import { db } from "@/lib/db/pg";

export async function getCacheMetrics() {
  try {
    // Aggregate totals from usage_history
    const totalsRow = await db().queryOne<{
      totalRequests: number;
      totalInputTokens: number | null;
      totalCachedTokens: number | null;
      totalCacheCreationTokens: number | null;
    }>(
      `
      SELECT
        COUNT(*) as "totalRequests",
        SUM(tokens_input) as "totalInputTokens",
        SUM(tokens_cache_read) as "totalCachedTokens",
        SUM(tokens_cache_creation) as "totalCacheCreationTokens"
      FROM usage_history
      WHERE tokens_cache_read > 0 OR tokens_cache_creation > 0
    `
    );

    // Get all requests count (including those without cache activity)
    const allRequestsRow = await db().queryOne<{ totalRequests: number }>(
      `
      SELECT COUNT(*) as "totalRequests"
      FROM usage_history
    `
    );

    // Aggregate by provider
    const byProviderRows = await db().query<{
      provider: string;
      totalRequests: number;
      cachedRequests: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheCreationTokens: number | null;
    }>(
      `
      SELECT
        provider,
        COUNT(*) as "totalRequests",
        SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN 1 ELSE 0 END) as "cachedRequests",
        SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN tokens_input ELSE 0 END) as "inputTokens",
        SUM(tokens_cache_read) as "cachedTokens",
        SUM(tokens_cache_creation) as "cacheCreationTokens"
      FROM usage_history
      WHERE provider IS NOT NULL
      GROUP BY provider
      HAVING SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN 1 ELSE 0 END) > 0
    `
    );

    // Aggregate by combo strategy (direct requests stored as 'direct')
    const byStrategyRows = await db().query<{
      strategy: string;
      requests: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheCreationTokens: number | null;
    }>(
      `
      SELECT
        COALESCE(combo_strategy, 'direct') as strategy,
        COUNT(*) as requests,
        SUM(tokens_input) as "inputTokens",
        SUM(tokens_cache_read) as "cachedTokens",
        SUM(tokens_cache_creation) as "cacheCreationTokens"
      FROM usage_history
      WHERE (tokens_cache_read > 0 OR tokens_cache_creation > 0)
      GROUP BY COALESCE(combo_strategy, 'direct')
    `
    );

    const tokensSaved = totalsRow?.totalCachedTokens || 0;

    const AVG_INPUT_PRICE_PER_MILLION = 3;
    const CACHE_DISCOUNT = 0.9;
    const estimatedCostSaved =
      Math.round((tokensSaved / 1_000_000) * AVG_INPUT_PRICE_PER_MILLION * CACHE_DISCOUNT * 100) /
      100;

    // Build byProvider object
    const byProvider: Record<
      string,
      {
        requests: number;
        totalRequests: number;
        cachedRequests: number;
        inputTokens: number;
        cachedTokens: number;
        cacheCreationTokens: number;
      }
    > = {};
    for (const row of byProviderRows) {
      byProvider[row.provider] = {
        requests: row.cachedRequests,
        totalRequests: row.totalRequests,
        cachedRequests: row.cachedRequests,
        inputTokens: row.inputTokens || 0,
        cachedTokens: row.cachedTokens || 0,
        cacheCreationTokens: row.cacheCreationTokens || 0,
      };
    }

    // Build byStrategy object
    const byStrategy: Record<
      string,
      {
        requests: number;
        inputTokens: number;
        cachedTokens: number;
        cacheCreationTokens: number;
      }
    > = {};
    for (const row of byStrategyRows) {
      byStrategy[row.strategy] = {
        requests: row.requests,
        inputTokens: row.inputTokens || 0,
        cachedTokens: row.cachedTokens || 0,
        cacheCreationTokens: row.cacheCreationTokens || 0,
      };
    }

    return {
      totalRequests: allRequestsRow?.totalRequests || totalsRow?.totalRequests || 0,
      requestsWithCacheControl: totalsRow?.totalRequests || 0,
      totalInputTokens: totalsRow?.totalInputTokens || 0,
      totalCachedTokens: totalsRow?.totalCachedTokens || 0,
      totalCacheCreationTokens: totalsRow?.totalCacheCreationTokens || 0,
      tokensSaved,
      estimatedCostSaved,
      byProvider,
      byStrategy,
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Failed to fetch cache metrics from usage_history:", error);
    return {
      totalRequests: 0,
      requestsWithCacheControl: 0,
      totalInputTokens: 0,
      totalCachedTokens: 0,
      totalCacheCreationTokens: 0,
      tokensSaved: 0,
      estimatedCostSaved: 0,
      byProvider: {},
      byStrategy: {},
      lastUpdated: new Date().toISOString(),
    };
  }
}

export async function updateCacheMetrics(_metrics: Record<string, unknown>) {
  // No-op: metrics are now computed from usage_history on-the-fly
  // The usage_history table is the single source of truth
  return getCacheMetrics();
}

export interface CacheTrendPoint {
  timestamp: string;
  requests: number;
  cachedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

export async function getCacheTrend(hours = 24): Promise<CacheTrendPoint[]> {
  try {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows = await db().query<{
      hour: string;
      requests: number;
      cachedRequests: number;
      inputTokens: number | null;
      cachedTokens: number | null;
      cacheCreationTokens: number | null;
    }>(
      `
        SELECT
          to_char(date_trunc('hour', "timestamp" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"') as hour,
          COUNT(*) as requests,
          SUM(CASE WHEN tokens_cache_read > 0 OR tokens_cache_creation > 0 THEN 1 ELSE 0 END) as "cachedRequests",
          SUM(tokens_input) as "inputTokens",
          SUM(tokens_cache_read) as "cachedTokens",
          SUM(tokens_cache_creation) as "cacheCreationTokens"
        FROM usage_history
        WHERE "timestamp" >= $1
        GROUP BY hour
        ORDER BY hour ASC
      `,
      [since]
    );

    return rows.map((r) => ({
      timestamp: r.hour,
      requests: r.requests,
      cachedRequests: r.cachedRequests,
      inputTokens: r.inputTokens || 0,
      cachedTokens: r.cachedTokens || 0,
      cacheCreationTokens: r.cacheCreationTokens || 0,
    }));
  } catch (error) {
    console.error("Failed to fetch cache trend:", error);
    return [];
  }
}

export async function resetCacheMetrics() {
  // No-op: cache metrics are computed from usage_history.
  console.warn(
    "resetCacheMetrics is deprecated - cache metrics are now computed from usage_history"
  );
  return getCacheMetrics();
}
