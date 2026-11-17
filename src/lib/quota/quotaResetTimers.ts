/**
 * quotaResetTimers.ts — Automated quota window reset timers and capacity recovery.
 *
 * Tracks window reset timestamps and automatically clears exhausted provider quota
 * states when their reset windows elapse.
 *
 * Part of: Quota-aware provider scheduling (Phase 2).
 */

import { db, toMs, ts } from "@/lib/db/pg";
import { createLogger } from "@/shared/utils/logger";

const log = createLogger("quota:reset-timers");

export interface QuotaResetItem {
  connectionId: string;
  model: string;
  tokensUsed: number;
  tokenLimit: number;
  windowReset: number;
  timeRemainingMs: number;
}

/**
 * Get all active quota states and their remaining window reset times.
 */
export async function getActiveQuotaResetItems(): Promise<QuotaResetItem[]> {
  try {
    const rows = await db().query<{
      connection_id: string;
      model: string;
      tokens_used: number;
      token_limit: number;
      window_reset: string;
    }>(
      `SELECT connection_id, model, tokens_used, token_limit, window_reset
       FROM provider_quota_state WHERE window_reset > to_timestamp(0)
       ORDER BY connection_id, model`
    );

    const now = Date.now();
    return rows.map((r) => {
      const windowReset = toMs(r.window_reset) ?? 0;
      return {
        connectionId: String(r.connection_id),
        model: String(r.model),
        tokensUsed: Number(r.tokens_used),
        tokenLimit: Number(r.token_limit),
        windowReset,
        timeRemainingMs: Math.max(0, windowReset - now),
      };
    });
  } catch (error) {
    log.error({ err: error }, "Failed to query active quota reset items");
    return [];
  }
}

/**
 * Purge all expired quota windows.
 * Returns the count of reset connections.
 */
export async function resetExpiredQuotaWindows(): Promise<number> {
  try {
    const result = await db().execute(
      "DELETE FROM provider_quota_state WHERE window_reset > to_timestamp(0) AND window_reset <= $1",
      [ts(Date.now())]
    );
    return result.changes ?? 0;
  } catch (error) {
    log.error({ err: error }, "Failed to reset expired quota windows");
    return 0;
  }
}
