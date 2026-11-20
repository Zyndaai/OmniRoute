/**
 * db/providers/rateLimit.ts — Rate-limit/quota runtime helpers for provider_connections.
 */

import { db, ts, toMs } from "../pg";
import { invalidateDbCache } from "../readCache";
import { bumpProxyConfigGeneration } from "../settings";
import { stripCodexChildCooldownsFromConnection } from "./codexAccountState";

// ──────────────── T05: Rate-Limit DB Persistence ──────────────────────────
// Allows rate-limit state to survive token refresh without being accidentally
// cleared. The rate_limited_until column is a timestamptz.
// Ref: sub2api PR #1218 (fix(openai): prevent rescheduling rate-limited accounts)

/**
 * T05: Persist when a connection is rate-limited, directly in DB.
 * This survives token refresh — OAuth flows must NOT override this field.
 *
 * @param connectionId - The provider_connections.id
 * @param until - Epoch ms when the rate limit expires (null to clear)
 */
export async function setConnectionRateLimitUntil(
  connectionId: string,
  until: number | null
): Promise<void> {
  // Guard: never persist a non-finite or already-expired timestamp. null
  // is the only clear path (via clearConnectionRateLimit); past/zero
  // timestamps are noops so an expired write cannot overwrite a live row.
  if (until !== null && (!Number.isFinite(until) || until <= Date.now())) return;
  if (until == null) {
    await stripCodexChildCooldownsFromConnection(connectionId, { alsoClearTopLevel: true });
    return;
  }
  await db().execute(
    "UPDATE provider_connections SET rate_limited_until = $1, updated_at = $2 WHERE id = $3",
    [ts(until), new Date().toISOString(), connectionId]
  );
  // Routing-only write (rate_limited_until) — the /v1/models builder never reads
  // it, so bust the connections read cache without dropping the catalog cache.
  invalidateDbCache("connections", connectionId, { skipModelCatalog: true });
}

/**
 * Mark a connection as rate-limited until `Date.now() + retryAfterMs`.
 *
 * Best-effort: never throws — a DB failure must not crash the chat path. The T05
 * startup helper `clearStaleCrashCooldowns` will not undo a write made here because
 * the timestamp is always strictly in the future at the moment of write. See Issue #1
 * (per-account 429 cascade not persisting).
 */
export async function markConnectionRateLimitedUntil(
  connectionId: string,
  retryAfterMs: number
): Promise<void> {
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
  try {
    await setConnectionRateLimitUntil(connectionId, Date.now() + retryAfterMs);
  } catch {
    // best-effort
  }
}

/**
 * Clear a connection's persisted 429 cooldown.
 *
 * Best-effort: never throws. Mirrors `resetAccountState`'s in-memory clear so the
 * in-memory AccountState and the DB row agree.
 */
export async function clearConnectionRateLimit(connectionId: string): Promise<void> {
  if (typeof connectionId !== "string" || connectionId.length === 0) return;
  try {
    await setConnectionRateLimitUntil(connectionId, null);
  } catch {
    // best-effort
  }
}

/**
 * T05: Check if a connection is currently rate-limited (DB-backed).
 * Use this before account selection to skip transiently rate-limited accounts.
 *
 * @returns true if rate_limited_until is set and in the future
 */
export async function isConnectionRateLimited(connectionId: string): Promise<boolean> {
  const row = await db().queryOne<{ rate_limited_until: string | null }>(
    "SELECT rate_limited_until FROM provider_connections WHERE id = $1",
    [connectionId]
  );
  const untilMs = toMs(row?.rate_limited_until);
  if (untilMs === null) return false;
  return Date.now() < untilMs;
}

/**
 * T05: Get all connections for a provider that are currently rate-limited.
 * Returns an array of { id, rateLimitedUntil } for dashboard display.
 */
export async function getRateLimitedConnections(
  provider: string
): Promise<Array<{ id: string; rateLimitedUntil: number }>> {
  const rows = await db().query<{ id: string; rate_limited_until: string }>(
    "SELECT id, rate_limited_until FROM provider_connections WHERE provider = $1 AND rate_limited_until > $2",
    [provider, new Date().toISOString()]
  );
  return rows.map((r) => ({ id: r.id, rateLimitedUntil: toMs(r.rate_limited_until) ?? 0 }));
}

// ──────────────── T13: Stale Quota Display Fix ─────────────────────────────
// Codex/Claude quotas display stale cumulative usage after the window resets.
// By comparing resetAt timestamp to now(), we can show 0 when window has passed.
// Ref: sub2api PR #1171 (fix: quota display shows stale cumulative usage after reset)

/**
 * T13: Get effective quota usage, zeroing it out if the window has already reset.
 *
 * @param used - Stored usage value (tokens used in the window)
 * @param resetAt - ISO-8601 string or epoch ms when the window resets, or null
 * @returns Effective usage: 0 if window expired, original value otherwise
 */
export function getEffectiveQuotaUsage(
  used: number,
  resetAt: string | number | null | undefined
): number {
  if (!resetAt) return used;
  const resetTime = typeof resetAt === "number" ? resetAt : new Date(resetAt).getTime();
  if (isNaN(resetTime)) return used;
  // Window has passed — display should show 0 (pending next snapshot)
  if (Date.now() >= resetTime) return 0;
  return used;
}

/**
 * T05: Startup crash-recovery — clear stale transient connection cooldowns.
 *
 * After an unclean crash (SIGKILL, OOM-kill, large-body burst) the normal
 * error-handler paths that would clear/normalise cooldowns never run.
 * A connection's `rate_limited_until` may have been pushed far into the
 * future by exponential back-off.  On next startup that leaves all affected
 * connections excluded by `getProviderCredentials()`, so every request sits
 * in the limiter queue and times out at `maxWaitMs` (120 s default).
 *
 * Safe invariants:
 *  - Only connections with `rate_limited_until IS NOT NULL` are touched.
 *  - Terminal states (`banned`, `expired`, `credits_exhausted`) are skipped —
 *    those require a deliberate credential change or operator reset.
 *  - Past timestamps are cleared: they are already expired in the lazy
 *    expiry sense, but clearing them resets `backoffLevel` / transient error
 *    fields so the connection gets a clean slate on this fresh process.
 *  - FUTURE timestamps are NEVER cleared. Clearing them was the original
 *    behaviour and it wiped legitimate multi-day quota cooldowns on every
 *    container recreate: a GLM weekly cap persisted until 2026-08-29 came
 *    back `active` with `rate_limited_until = NULL`, combo dispatched it
 *    immediately, and the connection re-earned a real upstream 429. A stale
 *    crash-backoff value is bounded by the engine's own cooldown cap, so
 *    honouring it costs at most that window — far less than burning quota
 *    against an upstream that is provably exhausted.
 *
 * Must be called once, early in the startup sequence, before any request
 * is handled.  Returns the number of connections that were cleared.
 */
export async function clearStaleCrashCooldowns(): Promise<{ cleared: number }> {
  const now = new Date().toISOString();

  // One statement: the cutoff and the terminal-status filter are applied
  // atomically, so a cooldown written between a read and the clear is never wiped.
  const { changes } = await db().execute(
    `UPDATE provider_connections SET
       rate_limited_until = NULL,
       test_status        = 'active',
       backoff_level      = 0,
       last_error         = NULL,
       last_error_at      = NULL,
       last_error_type    = NULL,
       last_error_source  = NULL,
       error_code         = NULL,
       updated_at         = $1
     WHERE rate_limited_until IS NOT NULL
       AND rate_limited_until <= $1
       AND lower(btrim(COALESCE(test_status, ''))) NOT IN ('banned', 'expired', 'credits_exhausted')`,
    [now]
  );

  if (changes === 0) return { cleared: 0 };

  // Routing/health-only fields (rate_limited_until, test_status, backoff_level,
  // last_error*, error_code) — the /v1/models builder never reads them.
  invalidateDbCache("connections", undefined, { skipModelCatalog: true });

  return { cleared: changes };
}

/**
 * Atomic conditional clear of recoverable error state on a connection row.
 *
 * Returns true when the row was cleared, false when a concurrent writer
 * (markAccountUnavailable, connectionRecovery tick, test, etc.) changed the
 * row between the caller's snapshot read and this UPDATE — in which case the
 * clear is skipped to preserve the freshest error state. Closes the TOCTOU
 * window in the quota-recovery path.
 *
 * CAS token = (test_status, last_error_at, rate_limited_until).
 * Nested Codex child cooldown maps are stripped in the same UPDATE so a
 * concurrent writer cannot re-persist them between two statements.
 */
export async function clearConnectionErrorIfUnchanged(
  id: string,
  expected: {
    testStatus: string | null | undefined;
    lastErrorAt: string | null | undefined;
    rateLimitedUntil: string | null | undefined;
  }
): Promise<boolean> {
  const result = await db().execute(
    `UPDATE provider_connections SET
       test_status = 'active',
       last_error = NULL,
       last_error_at = NULL,
       last_error_type = NULL,
       last_error_source = NULL,
       error_code = NULL,
       rate_limited_until = NULL,
       backoff_level = 0,
       provider_specific_data = CASE
         WHEN provider = 'codex' AND jsonb_typeof(provider_specific_data) = 'object'
           THEN provider_specific_data - 'codexScopeRateLimitedUntil' - 'codexScopeRateLimitSource'
         ELSE provider_specific_data
       END,
       updated_at = $1
     WHERE id = $2
       AND COALESCE(test_status, '') = $3
       AND last_error_at IS NOT DISTINCT FROM $4::timestamptz
       AND rate_limited_until IS NOT DISTINCT FROM $5::timestamptz`,
    [
      new Date().toISOString(),
      id,
      expected.testStatus ?? "",
      ts(expected.lastErrorAt),
      ts(expected.rateLimitedUntil),
    ]
  );
  const applied = result.changes > 0;
  if (applied) {
    // Routing/health-only fields + codex-scope cooldown keys — none are read by
    // the /v1/models builder (it only reads providerSpecificData.excludedModels).
    invalidateDbCache("connections", id, { skipModelCatalog: true });
    await bumpProxyConfigGeneration();
  }
  return applied;
}

// T13: Format a reset countdown as a human-readable string ("2h 35m" / "4m 30s").
// The implementation lives in the client-safe formatting utils so client
// components (e.g. CoolingConnectionsPanel) can import it without pulling this
// server-only DB module into the browser bundle.
// Re-exported here for existing server-side callers and the db/providers barrel.
export { formatResetCountdown } from "@/shared/utils/formatting";
