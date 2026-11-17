import { db, ts } from "./pg";
import { jsonTextParam } from "./pgJsonText";

export interface CompressionAnalyticsRow {
  id?: number;
  timestamp: string;
  combo_id?: string | null;
  compression_combo_id?: string | null;
  engine?: string | null;
  provider?: string | null;
  mode: string;
  original_tokens: number;
  compressed_tokens: number;
  tokens_saved: number;
  duration_ms?: number | null;
  request_id?: string | null;
  actual_prompt_tokens?: number | null;
  actual_completion_tokens?: number | null;
  actual_total_tokens?: number | null;
  actual_cache_read_tokens?: number | null;
  actual_cache_write_tokens?: number | null;
  estimated_usd_saved?: number | null;
  mcp_description_tokens_saved?: number | null;
  multimodal_skip_count?: number | null;
  receipt_source?: string | null;
  validation_fallback?: boolean | number | null;
  output_mode?: string | null;
  rtk_raw_output_pointer?: string | null;
  rtk_raw_output_bytes?: number | null;
  rtk_raw_output_pointers?: string | null;
  rtk_raw_output_total_bytes?: number | null;
  // Set on a no-op/skipped row: compression was attempted (mode active, engines
  // ran) but produced no recordable saving. NULL on a normal saving row. Lets
  // analytics distinguish "ran but saved nothing" from "never ran" (#4268).
  skip_reason?: string | null;
}

/**
 * One row per engine that ran inside a stacked compression pipeline. A stacked
 * request writes a single aggregate `compression_analytics` row (engine = mode) plus
 * N of these — so per-engine savings are queryable historically, not just live.
 */
export interface CompressionEngineBreakdownRow {
  timestamp: string;
  request_id?: string | null;
  engine: string;
  original_tokens: number;
  compressed_tokens: number;
  tokens_saved: number;
  duration_ms?: number | null;
}

export interface CompressionAnalyticsSummary {
  totalRequests: number;
  totalTokensSaved: number;
  avgSavingsPct: number;
  avgDurationMs: number;
  // `count`/`tokensSaved`/`avgSavingsPct` cover net-saving runs only (skip rows
  // excluded), preserving historical semantics. `skipped` = attempted-but-no-op
  // runs for that mode, so Stacked is no longer invisible when it saves nothing (#4268).
  byMode: Record<
    string,
    { count: number; tokensSaved: number; avgSavingsPct: number; skipped: number }
  >;
  byEngine: Record<string, { count: number; tokensSaved: number; avgSavingsPct: number }>;
  byCompressionCombo: Record<string, { count: number; tokensSaved: number }>;
  byProvider: Record<string, { count: number; tokensSaved: number }>;
  last24h: Array<{ hour: string; count: number; tokensSaved: number }>;
  // Total attempted-but-no-op compression runs (skip_reason set), and a breakdown
  // by reason (e.g. "no_savings"). Recorded but excluded from the saving aggregates (#4268).
  totalSkipped: number;
  bySkipReason: Record<string, number>;
  validationFallbacks: number;
  realUsage: {
    requestsWithReceipts: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedUsdSaved: number;
    bySource: Record<string, number>;
  };
  mcpDescriptionCompression: {
    snapshots: number;
    estimatedTokensSaved: number;
  };
}

function intOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

export async function insertCompressionAnalyticsRow(row: CompressionAnalyticsRow): Promise<void> {
  await db().execute(
    `
    INSERT INTO compression_analytics (
      "timestamp", combo_id, compression_combo_id, engine, provider, mode, original_tokens, compressed_tokens, tokens_saved,
      duration_ms, request_id, actual_prompt_tokens, actual_completion_tokens,
      actual_total_tokens, actual_cache_read_tokens, actual_cache_write_tokens,
      estimated_usd_saved, mcp_description_tokens_saved, multimodal_skip_count,
      receipt_source, validation_fallback, output_mode, rtk_raw_output_pointer, rtk_raw_output_bytes,
      rtk_raw_output_pointers, rtk_raw_output_total_bytes, skip_reason
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
  `,
    [
      ts(row.timestamp) ?? new Date().toISOString(),
      row.combo_id ?? null,
      row.compression_combo_id ?? null,
      row.engine ?? row.mode,
      row.provider ?? null,
      row.mode,
      Math.round(row.original_tokens),
      Math.round(row.compressed_tokens),
      Math.round(row.tokens_saved),
      intOrNull(row.duration_ms),
      row.request_id ?? null,
      intOrNull(row.actual_prompt_tokens),
      intOrNull(row.actual_completion_tokens),
      intOrNull(row.actual_total_tokens),
      intOrNull(row.actual_cache_read_tokens),
      intOrNull(row.actual_cache_write_tokens),
      row.estimated_usd_saved ?? null,
      intOrNull(row.mcp_description_tokens_saved) ?? 0,
      intOrNull(row.multimodal_skip_count) ?? 0,
      row.receipt_source ?? null,
      Boolean(row.validation_fallback),
      row.output_mode ?? null,
      row.rtk_raw_output_pointer ?? null,
      intOrNull(row.rtk_raw_output_bytes),
      jsonTextParam(row.rtk_raw_output_pointers),
      intOrNull(row.rtk_raw_output_total_bytes),
      row.skip_reason ?? null,
    ]
  );
}

/**
 * Record one Anthropic server-side Context Editing receipt as a
 * `compression_analytics` row under engine `"context-editing"`.
 *
 * The provider cleared `clearedInputTokens` of stale tool-use/thinking context from
 * its own window, so that maps to `tokens_saved` (original = cleared, compressed = 0).
 * Unlike the local engines there is no separate usage receipt to attach, so the
 * `request_id` is suffixed (`<id>::context-editing`): it stays traceable to the
 * originating request while staying collision-free with the exact-match
 * `attachCompressionUsageReceipt` UPDATE, which would otherwise latch onto this row.
 *
 * Best-effort: a zero/absent receipt is a no-op (context editing did not fire).
 */
export async function recordContextEditingTelemetry(
  requestId: string | null | undefined,
  telemetry:
    | { clearedInputTokens?: number; clearedToolUses?: number; editCount?: number }
    | null
    | undefined,
  provider: string | null = "claude"
): Promise<void> {
  const cleared = telemetry?.clearedInputTokens ?? 0;
  if (!Number.isFinite(cleared) || cleared <= 0) return;
  await insertCompressionAnalyticsRow({
    timestamp: new Date().toISOString(),
    provider,
    mode: "context-editing",
    engine: "context-editing",
    original_tokens: cleared,
    compressed_tokens: 0,
    tokens_saved: cleared,
    request_id: requestId ? `${requestId}::context-editing` : null,
  });
}

export async function insertCompressionEngineBreakdown(
  rows: CompressionEngineBreakdownRow[]
): Promise<void> {
  if (!rows.length) return;
  await db().transaction(async (tx) => {
    for (const r of rows) {
      await tx.execute(
        `INSERT INTO compression_engine_breakdown
       ("timestamp", request_id, engine, original_tokens, compressed_tokens, tokens_saved, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ts(r.timestamp) ?? new Date().toISOString(),
          r.request_id ?? null,
          r.engine,
          Math.round(r.original_tokens),
          Math.round(r.compressed_tokens),
          Math.round(r.tokens_saved),
          intOrNull(r.duration_ms),
        ]
      );
    }
  });
}

export async function attachCompressionUsageReceipt(
  requestId: string | null | undefined,
  usage: Record<string, unknown> | null | undefined,
  source: "provider" | "estimated" | "stream" = "provider"
): Promise<void> {
  if (!requestId || !usage || typeof usage !== "object") return;
  const promptTokens = toFiniteInt(usage.prompt_tokens);
  const completionTokens = toFiniteInt(usage.completion_tokens);
  const totalTokens =
    toFiniteInt(usage.total_tokens) ?? (promptTokens ?? 0) + (completionTokens ?? 0);
  const promptDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {};
  const cacheReadTokens = toFiniteInt(
    usage.cache_read_input_tokens ?? usage.cached_tokens ?? promptDetails.cached_tokens
  );
  const cacheWriteTokens = toFiniteInt(
    usage.cache_creation_input_tokens ?? promptDetails.cache_creation_tokens
  );
  if (promptTokens === null && completionTokens === null && totalTokens <= 0) return;

  await db().execute(
    `
    UPDATE compression_analytics
    SET actual_prompt_tokens = $1,
        actual_completion_tokens = $2,
        actual_total_tokens = $3,
        actual_cache_read_tokens = $4,
        actual_cache_write_tokens = $5,
        receipt_source = $6
    WHERE request_id = $7
      AND id = (
        SELECT id FROM compression_analytics
        WHERE request_id = $7
        ORDER BY id DESC
        LIMIT 1
      )
  `,
    [promptTokens, completionTokens, totalTokens, cacheReadTokens, cacheWriteTokens, source, requestId]
  );
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
}

function appendCondition(whereClause: string, condition: string): string {
  return whereClause ? `${whereClause} AND ${condition}` : `WHERE ${condition}`;
}

type EngineAggRow = { runs: number; original: number; compressed: number; saved: number };

export async function getPerEngineAnalytics(engineId: string, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // (1) Per-engine contributions from stacked runs (one breakdown row per engine).
  const breakdown = (await db().queryOne<EngineAggRow>(
    `SELECT COUNT(*) AS runs,
              COALESCE(SUM(original_tokens), 0) AS original,
              COALESCE(SUM(compressed_tokens), 0) AS compressed,
              COALESCE(SUM(tokens_saved), 0) AS saved
       FROM compression_engine_breakdown
       WHERE engine = $1 AND "timestamp" >= $2`,
    [engineId, since]
  )) as EngineAggRow;

  // (2) Legacy single-engine rows from compression_analytics, EXCLUDING any request
  // that already has a per-engine breakdown — so a stacked run's aggregate row is not
  // double-counted on top of its breakdown rows.
  const legacy = (await db().queryOne<EngineAggRow>(
    `SELECT COUNT(*) AS runs,
              COALESCE(SUM(original_tokens), 0) AS original,
              COALESCE(SUM(compressed_tokens), 0) AS compressed,
              COALESCE(SUM(tokens_saved), 0) AS saved
       FROM compression_analytics
       WHERE COALESCE(engine, mode) = $1 AND "timestamp" >= $2
         AND (
           request_id IS NULL
           OR request_id NOT IN (
             SELECT request_id FROM compression_engine_breakdown WHERE request_id IS NOT NULL
           )
         )`,
    [engineId, since]
  )) as EngineAggRow;

  const runs = breakdown.runs + legacy.runs;
  const original = breakdown.original + legacy.original;
  const compressed = breakdown.compressed + legacy.compressed;
  const tokensSaved = Math.max(0, breakdown.saved + legacy.saved);
  const avgSavingsPercent =
    original > 0 ? Math.round(((original - compressed) / original) * 1000) / 10 : 0;
  return { engineId, runs, tokensSaved, avgSavingsPercent, days };
}

export async function getCompressionAnalyticsSummary(
  since?: string
): Promise<CompressionAnalyticsSummary> {
  let cutoff: string | null = null;
  if (since === "24h") {
    cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  } else if (since === "7d") {
    cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (since === "30d") {
    cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const whereClause = cutoff ? 'WHERE "timestamp" >= $1' : "";
  const params = cutoff ? [cutoff] : [];
  // Saving aggregates count net-saving runs only: no-op/skip rows (skip_reason set)
  // are excluded so historical totals/avgs are unchanged, while skips are surfaced
  // separately below. (#4268)
  const successWhere = appendCondition(whereClause, "skip_reason IS NULL");

  type ScalarRow = { total: number; totalSaved: number; avgPct: number; avgDur: number };
  const scalar = await db().queryOne<ScalarRow>(
    `
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(tokens_saved), 0) AS "totalSaved",
      COALESCE(AVG(CASE WHEN original_tokens > 0 THEN tokens_saved::float8 / original_tokens * 100 ELSE 0 END), 0) AS "avgPct",
      COALESCE(AVG(duration_ms), 0) AS "avgDur"
    FROM compression_analytics ${successWhere}
  `,
    params
  );

  const modeRows = await db().query<{ mode: string; cnt: number; saved: number; avgPct: number }>(
    `
    SELECT mode, COUNT(*) AS cnt, COALESCE(SUM(tokens_saved), 0) AS saved,
      COALESCE(AVG(CASE WHEN original_tokens > 0 THEN tokens_saved::float8 / original_tokens * 100 ELSE 0 END), 0) AS "avgPct"
    FROM compression_analytics ${successWhere}
    GROUP BY mode
  `,
    params
  );

  // Attempted-but-no-op runs per mode (skip_reason set) — recorded since #4268 so
  // Stacked is visible even when it saves nothing.
  const skipModeRows = await db().query<{ mode: string; cnt: number }>(
    `
    SELECT mode, COUNT(*) AS cnt
    FROM compression_analytics ${appendCondition(whereClause, "skip_reason IS NOT NULL")}
    GROUP BY mode
  `,
    params
  );

  const byMode: Record<
    string,
    { count: number; tokensSaved: number; avgSavingsPct: number; skipped: number }
  > = {};
  for (const r of modeRows) {
    byMode[r.mode] = {
      count: r.cnt,
      tokensSaved: r.saved,
      avgSavingsPct: Math.round(r.avgPct),
      skipped: 0,
    };
  }
  for (const r of skipModeRows) {
    if (byMode[r.mode]) byMode[r.mode].skipped = r.cnt;
    else byMode[r.mode] = { count: 0, tokensSaved: 0, avgSavingsPct: 0, skipped: r.cnt };
  }

  const engineRows = await db().query<{
    engine: string;
    cnt: number;
    saved: number;
    avgPct: number;
  }>(
    `
    SELECT COALESCE(engine, mode) AS engine, COUNT(*) AS cnt, COALESCE(SUM(tokens_saved), 0) AS saved,
      COALESCE(AVG(CASE WHEN original_tokens > 0 THEN tokens_saved::float8 / original_tokens * 100 ELSE 0 END), 0) AS "avgPct"
    FROM compression_analytics ${successWhere}
    GROUP BY COALESCE(engine, mode)
  `,
    params
  );

  const byEngine: Record<string, { count: number; tokensSaved: number; avgSavingsPct: number }> =
    {};
  for (const r of engineRows) {
    byEngine[r.engine] = {
      count: r.cnt,
      tokensSaved: r.saved,
      avgSavingsPct: Math.round(r.avgPct),
    };
  }

  const compressionComboRows = await db().query<{
    compressionComboId: string | null;
    cnt: number;
    saved: number;
  }>(
    `
    SELECT compression_combo_id AS "compressionComboId", COUNT(*) AS cnt,
      COALESCE(SUM(tokens_saved), 0) AS saved
    FROM compression_analytics ${appendCondition(successWhere, "compression_combo_id IS NOT NULL")}
    GROUP BY compression_combo_id ORDER BY cnt DESC
  `,
    params
  );

  const byCompressionCombo: Record<string, { count: number; tokensSaved: number }> = {};
  for (const r of compressionComboRows) {
    const key = r.compressionComboId ?? "unknown";
    byCompressionCombo[key] = { count: r.cnt, tokensSaved: r.saved };
  }

  const provRows = await db().query<{ provider: string | null; cnt: number; saved: number }>(
    `
    SELECT provider, COUNT(*) AS cnt, COALESCE(SUM(tokens_saved), 0) AS saved
    FROM compression_analytics ${successWhere}
    GROUP BY provider ORDER BY cnt DESC
  `,
    params
  );

  const byProvider: Record<string, { count: number; tokensSaved: number }> = {};
  for (const r of provRows) {
    const key = r.provider ?? "unknown";
    byProvider[key] = { count: r.cnt, tokensSaved: r.saved };
  }

  const last24hMap = new Map<string, { hour: string; count: number; tokensSaved: number }>();
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    const hourStr = d.toISOString().substring(0, 14) + "00:00Z";
    last24hMap.set(hourStr, { hour: hourStr, count: 0, tokensSaved: 0 });
  }

  const hourRows = await db().query<{
    hour: string;
    cnt: number;
    saved: number;
  }>(
    `
    SELECT to_char(date_trunc('hour', "timestamp" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour,
      COUNT(*) AS cnt, COALESCE(SUM(tokens_saved), 0) AS saved
    FROM compression_analytics
    WHERE "timestamp" >= $1 AND skip_reason IS NULL
    GROUP BY 1 ORDER BY 1 ASC
  `,
    [new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()]
  );

  for (const r of hourRows) {
    if (last24hMap.has(r.hour)) {
      last24hMap.set(r.hour, { hour: r.hour, count: r.cnt, tokensSaved: r.saved });
    }
  }

  const last24h = Array.from(last24hMap.values());

  const receiptRows = await db().query<{
    source: string | null;
    cnt: number;
    prompt: number;
    completion: number;
    total: number;
    cacheRead: number;
    cacheWrite: number;
    usdSaved: number;
  }>(
    `
    SELECT receipt_source AS source, COUNT(*) AS cnt,
      COALESCE(SUM(actual_prompt_tokens), 0) AS prompt,
      COALESCE(SUM(actual_completion_tokens), 0) AS completion,
      COALESCE(SUM(actual_total_tokens), 0) AS total,
      COALESCE(SUM(actual_cache_read_tokens), 0) AS "cacheRead",
      COALESCE(SUM(actual_cache_write_tokens), 0) AS "cacheWrite",
      COALESCE(SUM(estimated_usd_saved), 0) AS "usdSaved"
    FROM compression_analytics ${appendCondition(successWhere, "receipt_source IS NOT NULL")}
    GROUP BY receipt_source
  `,
    params
  );

  const realUsage = {
    requestsWithReceipts: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedUsdSaved: 0,
    bySource: {} as Record<string, number>,
  };
  for (const row of receiptRows) {
    const source = row.source ?? "unknown";
    realUsage.requestsWithReceipts += row.cnt;
    realUsage.promptTokens += row.prompt;
    realUsage.completionTokens += row.completion;
    realUsage.totalTokens += row.total;
    realUsage.cacheReadTokens += row.cacheRead;
    realUsage.cacheWriteTokens += row.cacheWrite;
    realUsage.estimatedUsdSaved += row.usdSaved;
    realUsage.bySource[source] = row.cnt;
  }

  const fallbackRow = await db().queryOne<{ cnt: number }>(
    `
    SELECT COUNT(*) AS cnt
    FROM compression_analytics ${appendCondition(successWhere, "validation_fallback")}
  `,
    params
  );

  const mcpDescriptionRow = await db().queryOne<{ cnt: number; saved: number }>(
    `
    SELECT COUNT(*) AS cnt, COALESCE(SUM(mcp_description_tokens_saved), 0) AS saved
    FROM compression_analytics ${appendCondition(successWhere, "mcp_description_tokens_saved > 0")}
  `,
    params
  );

  const skipReasonRows = await db().query<{ reason: string | null; cnt: number }>(
    `
    SELECT skip_reason AS reason, COUNT(*) AS cnt
    FROM compression_analytics ${appendCondition(whereClause, "skip_reason IS NOT NULL")}
    GROUP BY skip_reason
  `,
    params
  );

  const bySkipReason: Record<string, number> = {};
  let totalSkipped = 0;
  for (const r of skipReasonRows) {
    const key = r.reason ?? "unknown";
    bySkipReason[key] = r.cnt;
    totalSkipped += r.cnt;
  }

  return {
    totalRequests: scalar?.total ?? 0,
    totalTokensSaved: scalar?.totalSaved ?? 0,
    avgSavingsPct: Math.round(scalar?.avgPct ?? 0),
    avgDurationMs: Math.round(scalar?.avgDur ?? 0),
    byMode,
    byEngine,
    byCompressionCombo,
    byProvider,
    last24h,
    totalSkipped,
    bySkipReason,
    validationFallbacks: fallbackRow?.cnt ?? 0,
    realUsage,
    mcpDescriptionCompression: {
      snapshots: mcpDescriptionRow?.cnt ?? 0,
      estimatedTokensSaved: mcpDescriptionRow?.saved ?? 0,
    },
  };
}

export interface LatestCompressionAnalyticsRun {
  id: number;
  timestamp: string;
  combo_id: string | null;
  compression_combo_id: string | null;
  mode: string;
  original_tokens: number;
  compressed_tokens: number;
  tokens_saved: number;
  duration_ms: number | null;
  request_id: string | null;
  engine: string | null;
  validation_fallback: number | null;
}

export async function getLatestCompressionAnalyticsRun(): Promise<
  LatestCompressionAnalyticsRun | undefined
> {
  const row = await db().queryOne<
    Omit<LatestCompressionAnalyticsRun, "validation_fallback"> & {
      validation_fallback: boolean | null;
    }
  >(
    `SELECT id, "timestamp", combo_id, compression_combo_id, mode,
              original_tokens, compressed_tokens, tokens_saved, duration_ms,
              request_id, engine, validation_fallback
         FROM compression_analytics
        ORDER BY "timestamp" DESC, id DESC
        LIMIT 1`
  );
  if (!row) return undefined;
  return {
    ...row,
    validation_fallback: row.validation_fallback === null ? null : row.validation_fallback ? 1 : 0,
  };
}
