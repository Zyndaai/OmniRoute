import { db, jsonb } from "./pg";

export interface CompressionRunTelemetryInput {
  requestId: string;
  model: string;
  provider: string;
  source: string;
  tokensBefore: number;
  tokensAfter: number;
  ratio: number;
  costDelta?: number;
  outputStyles?: Array<{ id: string; level: "lite" | "full" | "ultra" }>;
  outputStyleBypass?: string;
  outputTokens?: number;
}

export interface CompressionRunTelemetrySummary {
  totalRuns: number;
  totalTokensSaved: number;
  runsWithStyles: number;
  bypassCount: number;
  totalOutputTokens: number;
  appliedStyleCounts: Record<string, number>;
}

/**
 * Persist one CompressionRunTelemetry record (D0). Best-effort and off the hot path:
 * the `timestamp` is stamped here (never inside the pure resolvers). Mirrors the
 * compression-stats / compressionAnalytics recording discipline — never throws into a request.
 */
export async function insertCompressionRunTelemetryRow(
  row: CompressionRunTelemetryInput
): Promise<void> {
  try {
    await db().execute(
      `INSERT INTO compression_run_telemetry (
        "timestamp", request_id, model, provider, source,
        tokens_before, tokens_after, ratio, cost_delta,
        output_styles, output_style_bypass, output_tokens
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        new Date().toISOString(),
        row.requestId ?? null,
        row.model ?? null,
        row.provider ?? null,
        row.source ?? null,
        Math.round(row.tokensBefore),
        Math.round(row.tokensAfter),
        row.ratio,
        row.costDelta ?? null,
        row.outputStyles && row.outputStyles.length > 0 ? jsonb(row.outputStyles) : null,
        row.outputStyleBypass ?? null,
        row.outputTokens === undefined || row.outputTokens === null
          ? null
          : Math.round(row.outputTokens),
      ]
    );
  } catch {
    // best-effort telemetry — a write failure never affects a request
  }
}

export async function getCompressionRunTelemetrySummary(): Promise<CompressionRunTelemetrySummary> {
  const rows = await db().query<{
    tokens_before: number;
    tokens_after: number;
    output_styles: Array<{ id: string }> | string | null;
    output_style_bypass: string | null;
    output_tokens: number | null;
  }>(
    `SELECT tokens_before, tokens_after, output_styles, output_style_bypass, output_tokens
       FROM compression_run_telemetry`
  );

  const summary: CompressionRunTelemetrySummary = {
    totalRuns: rows.length,
    totalTokensSaved: 0,
    runsWithStyles: 0,
    bypassCount: 0,
    totalOutputTokens: 0,
    appliedStyleCounts: {},
  };

  for (const row of rows) {
    summary.totalTokensSaved += Math.max(0, row.tokens_before - row.tokens_after);
    summary.totalOutputTokens += row.output_tokens ?? 0;
    if (row.output_style_bypass) summary.bypassCount += 1;
    if (row.output_styles) {
      summary.runsWithStyles += 1;
      try {
        const styles = (
          typeof row.output_styles === "string" ? JSON.parse(row.output_styles) : row.output_styles
        ) as Array<{ id: string }>;
        for (const style of styles) {
          summary.appliedStyleCounts[style.id] = (summary.appliedStyleCounts[style.id] ?? 0) + 1;
        }
      } catch {
        // ignore a corrupt JSON cell
      }
    }
  }
  return summary;
}
