/**
 * providerQuotaState.ts — per-connection token budget ledger.
 *
 * Tracks tokens used against a configured per-minute (or per-window) token
 * limit for a (connection, model) pair. The purpose is PRE-REQUEST capacity
 * awareness: before dispatching to a provider, the scheduler can ask "does
 * this connection have budget left?" and skip exhausted connections instead
 * of waiting for a 429.
 *
 * Design notes:
 *  - Window semantics: fixed windows keyed by `window_start`. When
 *    `window_reset` passes, usage resets to 0 for the new window. The roll
 *    happens inside one upsert, so concurrent processes cannot lose updates.
 *  - Fail-open: reads return `{ known: false }` when the store is missing
 *    or empty — the scheduler treats unknown budget as available (existing
 *    routing behavior is preserved when quota tracking is not configured).
 *  - Writes are best-effort: recording usage must never break the request
 *    path (catch + log + return).
 *
 * Part of: Quota-aware provider scheduling (feat/quota-aware-scheduling).
 */
import { db, toMs, ts } from "@/lib/db/pg";
import { createLogger } from "@/shared/utils/logger";

const log = createLogger("quota:provider-state");

export interface ProviderQuotaRow {
  connectionId: string;
  model: string;
  tokensUsed: number;
  tokenLimit: number;
  windowStart: number;
  windowReset: number;
  updatedAt: string;
}

export interface ProviderQuotaSnapshot {
  /** true when the store has a fresh record for this window */
  known: boolean;
  tokensUsed: number;
  tokenLimit: number;
  /** remaining tokens in the current window (clamped >= 0) */
  tokensRemaining: number;
  /** 0..1 ratio of the window budget still available */
  remainingRatio: number;
  windowReset: number;
}

interface RowLike {
  connection_id?: string;
  model?: string;
  tokens_used?: number;
  token_limit?: number;
  window_start?: string;
  window_reset?: string;
  updated_at?: string;
}

function normalizeRow(row: RowLike): ProviderQuotaRow {
  return {
    connectionId: String(row.connection_id ?? ""),
    model: String(row.model ?? ""),
    tokensUsed: Number(row.tokens_used ?? 0),
    tokenLimit: Number(row.token_limit ?? 0),
    windowStart: toMs(row.window_start) ?? 0,
    windowReset: toMs(row.window_reset) ?? 0,
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * Read the current quota snapshot for (connectionId, model).
 * When the record is stale (its window expired) the caller sees
 * `known: false` — usage for the new window is implicitly zero.
 */
export async function getProviderQuota(
  connectionId: string,
  model: string
): Promise<ProviderQuotaSnapshot | null> {
  if (!connectionId || !model) return null;
  try {
    const row = await db().queryOne<RowLike>(
      "SELECT * FROM provider_quota_state WHERE connection_id = $1 AND model = $2",
      [connectionId, model]
    );
    if (!row) return null;

    const normalized = normalizeRow(row);
    const now = Date.now();
    if (normalized.windowReset > 0 && now > normalized.windowReset) {
      return {
        known: false,
        tokensUsed: 0,
        tokenLimit: 0,
        tokensRemaining: 0,
        remainingRatio: 1,
        windowReset: normalized.windowReset,
      };
    }

    const tokenLimit = normalized.tokenLimit > 0 ? normalized.tokenLimit : 0;
    const tokensUsed = Math.max(0, normalized.tokensUsed);
    const tokensRemaining = tokenLimit > 0 ? Math.max(0, tokenLimit - tokensUsed) : 0;
    const remainingRatio =
      tokenLimit > 0 ? Math.min(1, Math.max(0, tokensRemaining / tokenLimit)) : 1;

    return {
      known: true,
      tokensUsed,
      tokenLimit,
      tokensRemaining,
      remainingRatio,
      windowReset: normalized.windowReset,
    };
  } catch (err) {
    log.warn(
      { err: (err as Error)?.message, connectionId, model },
      "getProviderQuota failed — fail-open"
    );
    return null;
  }
}

/**
 * Record token usage for (connectionId, model) in the current window.
 *
 * One upsert: a missing row is seeded with the configured tokenLimit, and a row
 * whose window has rolled over restarts at the new usage. Best-effort: never throws.
 */
export async function recordProviderQuotaUsage(
  connectionId: string,
  model: string,
  tokensUsedDelta: number,
  opts: { tokenLimit?: number; windowMs?: number } = {}
): Promise<void> {
  if (!connectionId || !model || !(tokensUsedDelta > 0)) return;
  try {
    const now = Date.now();
    const windowMs = opts.windowMs ?? 60_000; // default: per-minute window
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const windowReset = windowStart + windowMs;
    const delta = Math.round(tokensUsedDelta);
    const limit = Math.round(opts.tokenLimit && opts.tokenLimit > 0 ? opts.tokenLimit : 0);

    await db().execute(
      `INSERT INTO provider_quota_state
         (connection_id, model, tokens_used, token_limit, window_start, window_reset, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (connection_id, model) DO UPDATE SET
         tokens_used = CASE WHEN provider_quota_state.window_reset < $7
                            THEN EXCLUDED.tokens_used
                            ELSE provider_quota_state.tokens_used + EXCLUDED.tokens_used END,
         token_limit = CASE WHEN EXCLUDED.token_limit > 0 THEN EXCLUDED.token_limit
                            ELSE provider_quota_state.token_limit END,
         window_start = EXCLUDED.window_start,
         window_reset = EXCLUDED.window_reset,
         updated_at = now()`,
      [connectionId, model, delta, limit, ts(windowStart), ts(windowReset), ts(now)]
    );
  } catch (err) {
    log.warn(
      { err: (err as Error)?.message, connectionId, model },
      "recordProviderQuotaUsage failed — best-effort"
    );
  }
}

/** Delete all quota state for a connection (used on connection removal). */
export async function clearProviderQuota(connectionId: string): Promise<void> {
  if (!connectionId) return;
  try {
    await db().execute("DELETE FROM provider_quota_state WHERE connection_id = $1", [
      connectionId,
    ]);
  } catch {
    // best-effort
  }
}
