/**
 * Per-API-Key Token Limits — Persistence Layer
 *
 * Enforcement-grade token budgets attachable to an API key, scoped to a
 * specific model, a specific provider, or globally. Complements the USD cost
 * budgets in domainState.ts / src/domain/costRules.ts.
 *
 * Tables: api_key_token_limits, api_key_token_counters,
 *         api_key_token_limit_reset_logs.
 *
 * @module lib/db/tokenLimits
 */

import { db, ts, type DbExecutor } from "./pg";
import { invalidateApiKeyPolicyCache, loadApiKeyPolicyConfig } from "./readCache";
import { getBudgetWindow, type BudgetResetInterval } from "@/domain/costRules";

export type TokenLimitScopeType = "model" | "provider" | "global";

export interface TokenLimit {
  id: string;
  apiKeyId: string;
  scopeType: TokenLimitScopeType;
  scopeValue: string;
  tokenLimit: number;
  resetInterval: BudgetResetInterval;
  resetTime: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertTokenLimitInput {
  id?: string;
  apiKeyId: string;
  scopeType: TokenLimitScopeType;
  scopeValue?: string;
  tokenLimit: number;
  resetInterval?: BudgetResetInterval;
  resetTime?: string;
  enabled?: boolean;
}

export interface TokenWindowState {
  windowStart: string;
  didReset: boolean;
  periodStartAt: number;
  nextResetAt: number;
}

type JsonRecord = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeScopeType(value: unknown): TokenLimitScopeType {
  if (value === "model" || value === "provider" || value === "global") return value;
  return "global";
}

function normalizeResetInterval(value: unknown): BudgetResetInterval {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  return "monthly";
}

/** `windowStart` is epoch ms as a string; ts() would read small values as seconds. */
function windowIso(windowStart: string): string | null {
  const ms = Number(windowStart);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ts(windowStart);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; kind?: unknown } | null;
  return e?.code === "23505" || e?.kind === "unique_violation";
}

function rowToTokenLimit(row: unknown): TokenLimit {
  const r = asRecord(row);
  return {
    id: typeof r.id === "string" ? r.id : "",
    apiKeyId: typeof r.api_key_id === "string" ? r.api_key_id : "",
    scopeType: normalizeScopeType(r.scope_type),
    scopeValue: typeof r.scope_value === "string" ? r.scope_value : "",
    tokenLimit: toNumber(r.token_limit),
    resetInterval: normalizeResetInterval(r.reset_interval),
    // `time` columns arrive as 'HH:MM:SS'; the API has always exposed 'HH:MM'.
    resetTime:
      typeof r.reset_time === "string" && r.reset_time ? r.reset_time.slice(0, 5) : "00:00",
    enabled: r.enabled !== false,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

// ──────────────── CRUD ────────────────

/** An id-targeted update that would take another limit's (scope, reset interval) slot. */
export class TokenLimitConflictError extends Error {
  constructor(scopeType: TokenLimitScopeType, resetInterval: BudgetResetInterval) {
    super(`This key already has a ${resetInterval} ${scopeType} token limit for that scope.`);
    this.name = "TokenLimitConflictError";
  }
}

/** An id-targeted update for a token limit that does not exist. */
export class TokenLimitNotFoundError extends Error {
  constructor() {
    super("Token limit not found.");
    this.name = "TokenLimitNotFoundError";
  }
}

function normalizeUpsertInput(input: UpsertTokenLimitInput) {
  const scopeType = normalizeScopeType(input.scopeType);
  const rawTime = typeof input.resetTime === "string" ? input.resetTime.trim() : "";
  return {
    apiKeyId: input.apiKeyId,
    scopeType,
    scopeValue: scopeType === "global" ? "" : (input.scopeValue ?? "").trim(),
    resetInterval: normalizeResetInterval(input.resetInterval),
    resetTime: TIME_RE.test(rawTime) ? rawTime : "00:00",
    enabled: input.enabled !== false,
    tokenLimit: Math.floor(toNumber(input.tokenLimit)),
  };
}

async function updateTokenLimitById(
  id: string,
  row: ReturnType<typeof normalizeUpsertInput>
): Promise<TokenLimit> {
  if (!UUID_RE.test(id)) throw new TokenLimitNotFoundError();
  try {
    const written = await db().queryOne(
      `UPDATE api_key_token_limits
       SET scope_type = $1, scope_value = $2, token_limit = $3,
           reset_interval = $4, reset_time = $5::time, enabled = $6, updated_at = now()
       WHERE id = $7 AND api_key_id = $8
       RETURNING *`,
      [
        row.scopeType,
        row.scopeValue,
        row.tokenLimit,
        row.resetInterval,
        row.resetTime,
        row.enabled,
        id,
        row.apiKeyId,
      ]
    );
    if (!written) throw new TokenLimitNotFoundError();
    return rowToTokenLimit(written);
  } catch (err) {
    if (isUniqueViolation(err)) throw new TokenLimitConflictError(row.scopeType, row.resetInterval);
    throw err;
  }
}

/** Insert, or update the key's existing limit for the same scope AND reset interval. */
async function insertOrMergeTokenLimit(
  row: ReturnType<typeof normalizeUpsertInput>
): Promise<TokenLimit> {
  const written = await db().queryOne(
    `INSERT INTO api_key_token_limits
       (api_key_id, scope_type, scope_value, token_limit, reset_interval, reset_time, enabled)
     VALUES ($1, $2, $3, $4, $5, $6::time, $7)
     ON CONFLICT (api_key_id, scope_type, scope_value, reset_interval)
     DO UPDATE SET token_limit = EXCLUDED.token_limit,
                   reset_time  = EXCLUDED.reset_time,
                   enabled     = EXCLUDED.enabled,
                   updated_at  = now()
     RETURNING *`,
    [
      row.apiKeyId,
      row.scopeType,
      row.scopeValue,
      row.tokenLimit,
      row.resetInterval,
      row.resetTime,
      row.enabled,
    ]
  );
  return rowToTokenLimit(written);
}

/**
 * Insert or update a token limit. Upsert key is (api_key_id, scope_type, scope_value, reset_interval).
 * With `id`, that row is updated by id (taking another limit's (scope, reset interval) slot throws
 * TokenLimitConflictError, an unknown id TokenLimitNotFoundError). Without `id`, inserts or updates
 * the limit with the same scope and reset interval, never a limit of another window.
 * Returns the persisted row.
 */
export async function upsertTokenLimit(input: UpsertTokenLimitInput): Promise<TokenLimit> {
  const row = normalizeUpsertInput(input);
  const requestedId = input.id?.trim();
  try {
    return requestedId
      ? await updateTokenLimitById(requestedId, row)
      : await insertOrMergeTokenLimit(row);
  } finally {
    invalidateApiKeyPolicyCache();
  }
}

/** List all token limits for an API key (ordered most-specific first: model, provider, global). */
export async function listTokenLimits(apiKeyId: string): Promise<TokenLimit[]> {
  const rows = await db().query(
    `SELECT * FROM api_key_token_limits
     WHERE api_key_id = $1
     ORDER BY CASE scope_type WHEN 'model' THEN 0 WHEN 'provider' THEN 1 ELSE 2 END, scope_value`,
    [apiKeyId]
  );
  return rows.map(rowToTokenLimit);
}

/**
 * Return the enabled limits that apply to a given request: the model-scoped row
 * (scope_value === model), the provider-scoped row (scope_value === provider),
 * and the global row. Used by the enforcement read (before and after every request), so
 * cached per key/provider/model (see loadApiKeyPolicyConfig); the writers here invalidate it.
 */
export async function getTokenLimitsForRequest(
  apiKeyId: string,
  provider: string,
  model: string
): Promise<TokenLimit[]> {
  const cacheKey = `token-limits:${apiKeyId}\u0000${provider || ""}\u0000${model || ""}`;
  return loadApiKeyPolicyConfig(cacheKey, async () => {
    const rows = await db().query(
      `SELECT * FROM api_key_token_limits
       WHERE api_key_id = $1
         AND enabled
         AND (
           (scope_type = 'global')
           OR (scope_type = 'model' AND scope_value = $2)
           OR (scope_type = 'provider' AND scope_value = $3)
         )`,
      [apiKeyId, model || "", provider || ""]
    );
    return rows.map(rowToTokenLimit);
  });
}

/** Delete a token limit by id (counters and reset logs go with it through their FKs). */
export async function deleteTokenLimit(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const info = await db().execute("DELETE FROM api_key_token_limits WHERE id = $1", [id]);
  invalidateApiKeyPolicyCache();
  return info.changes > 0;
}

// ──────────────── Counters (atomic upserts) ────────────────

/**
 * Pure boundary calculator. Resolves the active window for a limit at `now`
 * and reports whether the window has rolled since the limit's last-known window.
 * No DB writes. Window math reused from costRules.getBudgetWindow.
 * `windowStart` is the window start in epoch ms, as a string.
 */
export function resetWindowIfElapsed(limit: TokenLimit, now = Date.now()): TokenWindowState {
  const window = getBudgetWindow(limit.resetInterval, limit.resetTime, now);
  const windowStart = String(window.periodStartAt);
  return {
    windowStart,
    didReset: false, // caller compares against the stored counter row to decide rollover
    periodStartAt: window.periodStartAt,
    nextResetAt: window.nextResetAt,
  };
}

/**
 * Read-only point-read of the current window's usage for a limit.
 * Returns 0 if no counter row exists yet (cold window). DB-authoritative.
 */
export async function getWindowUsage(limit: TokenLimit, now = Date.now()): Promise<number> {
  if (!UUID_RE.test(limit.id)) return 0;
  const { windowStart } = resetWindowIfElapsed(limit, now);
  const row = await db().queryOne(
    "SELECT tokens_used FROM api_key_token_counters WHERE limit_id = $1 AND window_start = $2",
    [limit.id, windowIso(windowStart)]
  );
  return toNumber(asRecord(row).tokens_used);
}

/**
 * Atomically add `tokens` to the counter for (limitId, windowStart) and return
 * the new running total. Uses UPSERT (no read-then-write) so concurrent
 * increments from any process cannot lose updates.
 */
export async function incrementWindowTokens(
  limitId: string,
  windowStart: string,
  tokens: number,
  executor: DbExecutor = db()
): Promise<number> {
  const delta = Math.max(0, Math.floor(toNumber(tokens)));
  if (!UUID_RE.test(limitId)) return 0;
  const row = await executor.queryOne(
    `INSERT INTO api_key_token_counters (limit_id, window_start, tokens_used, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (limit_id, window_start)
     DO UPDATE SET tokens_used = api_key_token_counters.tokens_used + EXCLUDED.tokens_used,
                   updated_at  = now()
     RETURNING tokens_used`,
    [limitId, windowIso(windowStart), delta]
  );
  return toNumber(asRecord(row).tokens_used);
}

/**
 * Create the counter row for a window at `seed` unless it already exists.
 * Returns true when this call created it (the caller is then the first writer
 * of the window and owns rollover logging and seeding).
 */
export async function createWindowCounterIfMissing(
  limitId: string,
  windowStart: string,
  seed: number,
  executor: DbExecutor = db()
): Promise<boolean> {
  if (!UUID_RE.test(limitId)) return false;
  const row = await executor.queryOne(
    `INSERT INTO api_key_token_counters (limit_id, window_start, tokens_used)
     VALUES ($1, $2, $3)
     ON CONFLICT (limit_id, window_start) DO NOTHING
     RETURNING tokens_used`,
    [limitId, windowIso(windowStart), Math.max(0, Math.floor(toNumber(seed)))]
  );
  return row !== undefined;
}

/** The newest counter row older than `windowStart` for a limit: its tokens, or 0 when none. */
export async function getPriorWindowTokens(
  limitId: string,
  windowStart: string,
  executor: DbExecutor = db()
): Promise<number> {
  if (!UUID_RE.test(limitId)) return 0;
  const row = await executor.queryOne(
    `SELECT tokens_used FROM api_key_token_counters
     WHERE limit_id = $1 AND window_start < $2
     ORDER BY window_start DESC LIMIT 1`,
    [limitId, windowIso(windowStart)]
  );
  return toNumber(asRecord(row).tokens_used);
}

/**
 * Append a window-reset audit log row. One row per rolled window: a second
 * writer for the same (limit, window) is a no-op.
 */
export async function logTokenLimitReset(
  limitId: string,
  prevTokens: number,
  windowStart: string,
  executor: DbExecutor = db()
): Promise<void> {
  if (!UUID_RE.test(limitId)) return;
  await executor.execute(
    `INSERT INTO api_key_token_limit_reset_logs (limit_id, reset_at, prev_tokens, window_start)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (limit_id, window_start) DO NOTHING`,
    [limitId, Math.max(0, Math.floor(toNumber(prevTokens))), windowIso(windowStart)]
  );
}
