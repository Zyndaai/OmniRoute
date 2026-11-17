import { db, type DbExecutor } from "@/lib/db/pg";

/**
 * Total input+output tokens for the current calendar month (UTC), across BOTH storage legs:
 *
 * 1. `daily_usage_summary` — the rolled-up aggregate (filled only by the retention
 *    cleanup path rolling up rows OLDER than `retention.usageHistory`, default 365 days),
 *    so the current month's rows never appear here until ~a year later (or the operator
 *    lowers retention).
 * 2. `usage_history` — the live per-request rows (written by `saveRequestUsage` with
 *    `tokens_input`/`tokens_output` and a `timestamp`), which hold the current month's
 *    actual usage.
 *
 * #10381: reading only leg 1 always returned ~0 for the current month. No double-count:
 * a row is rolled into `daily_usage_summary` only immediately before being deleted from
 * `usage_history` by the same cleanup step. The analytics layer uses the same
 * reconciliation in `buildUnifiedSource`.
 */
export async function sumUsageTokensThisMonth(executor: DbExecutor = db()): Promise<number> {
  try {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const row = await executor.queryOne<{ used: number }>(
      `SELECT
         COALESCE((
           SELECT SUM(tokens_input + tokens_output)
           FROM usage_history
           WHERE "timestamp" >= $1 AND "timestamp" < $2
         ), 0) +
         COALESCE((
           SELECT SUM(total_input_tokens + total_output_tokens)
           FROM daily_usage_summary
           WHERE date >= $3::date
         ), 0) AS used`,
      [
        monthStart.toISOString(),
        nextMonthStart.toISOString(),
        monthStart.toISOString().slice(0, 10),
      ]
    );
    return Number(row?.used ?? 0);
  } catch {
    return 0; // treat an unavailable table as 0 used
  }
}
