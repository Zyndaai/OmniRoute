import { db } from "./pg";

export interface CacheStatsEntry {
  provider: string;
  model?: string;
  compressionMode: string;
  cacheControlPresent: boolean;
  estimatedCacheHit: boolean;
  tokensSavedCompression: number;
  tokensSavedCaching: number;
  netSavings: number;
}

export interface CacheStatsSummary {
  totalRequests: number;
  avgNetSavings: number;
  cacheHitRate: number;
  byProvider: Record<string, { count: number; avgNetSavings: number; cacheHitRate: number }>;
}

export async function recordCacheStats(entry: CacheStatsEntry): Promise<void> {
  await db().execute(
    `INSERT INTO compression_cache_stats (
    provider,
    model,
    compression_mode,
    cache_control_present,
    estimated_cache_hit,
    tokens_saved_compression,
    tokens_saved_caching,
    net_savings
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.provider,
      entry.model ?? "",
      entry.compressionMode,
      Boolean(entry.cacheControlPresent),
      Boolean(entry.estimatedCacheHit),
      Math.round(entry.tokensSavedCompression),
      Math.round(entry.tokensSavedCaching),
      Math.round(entry.netSavings),
    ]
  );
}

export async function getCacheStatsSummary(since?: Date): Promise<CacheStatsSummary> {
  const whereClause = since ? "WHERE created_at >= $1" : "";
  const params = since ? [since.toISOString()] : [];

  // Global aggregates
  const globalRow = await db().queryOne<{
    totalRequests: number;
    avgNetSavings: number | null;
    cacheHitRate: number | null;
  }>(
    `SELECT COUNT(*) AS "totalRequests", AVG(net_savings) AS "avgNetSavings",
            SUM(estimated_cache_hit::int)::float8 / NULLIF(COUNT(*), 0) AS "cacheHitRate"
       FROM compression_cache_stats ${whereClause}`,
    params
  );

  if (!globalRow || globalRow.totalRequests === 0) {
    return { totalRequests: 0, avgNetSavings: 0, cacheHitRate: 0, byProvider: {} };
  }

  // Per-provider aggregates
  const providerRows = await db().query<{
    provider: string;
    count: number;
    avgNetSavings: number;
    cacheHitRate: number;
  }>(
    `SELECT provider, COUNT(*) AS count, AVG(net_savings) AS "avgNetSavings",
            SUM(estimated_cache_hit::int)::float8 / NULLIF(COUNT(*), 0) AS "cacheHitRate"
       FROM compression_cache_stats ${whereClause} GROUP BY provider`,
    params
  );

  const byProvider: Record<string, { count: number; avgNetSavings: number; cacheHitRate: number }> =
    {};
  for (const row of providerRows) {
    byProvider[row.provider] = {
      count: row.count,
      avgNetSavings: row.avgNetSavings,
      cacheHitRate: row.cacheHitRate,
    };
  }

  return {
    totalRequests: globalRow.totalRequests,
    avgNetSavings: globalRow.avgNetSavings ?? 0,
    cacheHitRate: globalRow.cacheHitRate ?? 0,
    byProvider,
  };
}
