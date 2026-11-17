/**
 * db/keyQuota.ts — Per-API-key tpm/rpm/monthly-amount quota (RIC-741 / M3 D5).
 *
 * KISS counter + threshold quota: a single config row on `api_key_quota_limits`
 * (tpm / rpm / monthly USD) plus 2-bucket sliding-window counters in
 * `quota_counters` (dimension keys `key-quota:tpm` / `key-quota:rpm`). The
 * monthly amount is not counted here — it is read from the cost ledger's
 * current-calendar-month SUM (`aggregateLedgerThisMonth`), so one source of
 * truth for money.
 *
 * A NULL limit means "unlimited" (0 is normalized to unlimited on read).
 *
 * @module db/keyQuota
 */

import { db } from "./pg";
import { aggregateLedgerThisMonth } from "./costLedger";
import { toNumber } from "@/shared/utils/numeric";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeyQuotaLimits {
  apiKeyId: string;
  /** Tokens per minute; null/0 = unlimited. */
  tpmLimit: number | null;
  /** Requests per minute; null/0 = unlimited. */
  rpmLimit: number | null;
  /** Calendar-month USD spend cap; null/0 = unlimited. */
  monthlyAmountUsd: number | null;
}

export interface KeyQuotaCounters {
  /** Effective tokens used in the current minute window. */
  tpmUsed: number;
  /** Effective requests used in the current minute window. */
  rpmUsed: number;
  /** Calendar-month USD spend (from the cost ledger). */
  monthlyAmountUsd: number;
}

export interface KeyQuotaStatus {
  enabled: boolean;
  limits: KeyQuotaLimits;
  counters: KeyQuotaCounters;
  tpmExceeded: boolean;
  rpmExceeded: boolean;
  monthlyExceeded: boolean;
  /** ISO timestamp the current minute window ends. */
  windowResetAtIso: string;
}

export type KeyQuotaDimension = "tpm" | "rpm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 2-bucket sliding window over a 60s fixed window. */
export const KEY_QUOTA_WINDOW_MS = 60_000;

/** dimension_key fragment for the counters table. */
const DIMENSION_TPM = "key-quota:tpm";
const DIMENSION_RPM = "key-quota:rpm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** NULL or <=0 reads as unlimited → null. */
function toLimitOrNull(value: unknown): number | null {
  const numeric = toNumber(value);
  return numeric > 0 ? numeric : null;
}

/** Convert a limit back to a null-safe value for the DB (NULL stores unlimited). */
function limitToDb(value: number | null | undefined): number | null {
  if (value === undefined) return null;
  return value !== null && value > 0 ? value : null;
}

/** tpm/rpm are integer columns: a fractional limit is rounded, below 1 reads as unlimited. */
function intLimitToDb(value: number | null | undefined): number | null {
  const limit = limitToDb(value);
  if (limit === null) return null;
  const rounded = Math.round(limit);
  return rounded > 0 ? rounded : null;
}

function toIsoWindowStart(nowMs: number): string {
  const windowStart = Math.floor(nowMs / KEY_QUOTA_WINDOW_MS) * KEY_QUOTA_WINDOW_MS;
  return new Date(windowStart).toISOString();
}

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

function rowToLimits(row: unknown): KeyQuotaLimits {
  const r = asRecord(row);
  return {
    apiKeyId: typeof r.api_key_id === "string" ? r.api_key_id : "",
    tpmLimit: toLimitOrNull(r.tpm_limit),
    rpmLimit: toLimitOrNull(r.rpm_limit),
    monthlyAmountUsd: toLimitOrNull(r.monthly_amount_usd),
  };
}

/**
 * Load quota limits for a key. Returns all-null limits when no row exists.
 */
export async function getKeyQuotaLimits(apiKeyId: string): Promise<KeyQuotaLimits> {
  if (!apiKeyId) return { apiKeyId, tpmLimit: null, rpmLimit: null, monthlyAmountUsd: null };
  const row = await db().queryOne(
    `SELECT api_key_id, tpm_limit, rpm_limit, monthly_amount_usd
     FROM api_key_quota_limits WHERE api_key_id = $1`,
    [apiKeyId]
  );
  return row
    ? rowToLimits(row)
    : { apiKeyId, tpmLimit: null, rpmLimit: null, monthlyAmountUsd: null };
}

export interface UpsertKeyQuotaLimitsInput {
  tpmLimit?: number | null;
  rpmLimit?: number | null;
  monthlyAmountUsd?: number | null;
}

/**
 * Upsert quota limits for a key. Omitted fields keep their existing value.
 * Returns the resulting limits.
 */
export async function upsertKeyQuotaLimits(
  apiKeyId: string,
  input: UpsertKeyQuotaLimitsInput
): Promise<KeyQuotaLimits> {
  if (!apiKeyId) return { apiKeyId, tpmLimit: null, rpmLimit: null, monthlyAmountUsd: null };

  // One statement: omitted fields keep the stored value, so two concurrent
  // partial updates cannot overwrite each other's field. Saving the quota is
  // an operator action: a month closed by unpriced usage starts over.
  const row = await db().queryOne(
    `INSERT INTO api_key_quota_limits
       (api_key_id, tpm_limit, rpm_limit, monthly_amount_usd, unpriced_usage_since, updated_at)
     VALUES ($1, $2, $3, $4, NULL, now())
     ON CONFLICT (api_key_id) DO UPDATE SET
       tpm_limit = CASE WHEN $5 THEN EXCLUDED.tpm_limit ELSE api_key_quota_limits.tpm_limit END,
       rpm_limit = CASE WHEN $6 THEN EXCLUDED.rpm_limit ELSE api_key_quota_limits.rpm_limit END,
       monthly_amount_usd = CASE WHEN $7 THEN EXCLUDED.monthly_amount_usd
                                 ELSE api_key_quota_limits.monthly_amount_usd END,
       unpriced_usage_since = NULL,
       updated_at = now()
     RETURNING api_key_id, tpm_limit, rpm_limit, monthly_amount_usd`,
    [
      apiKeyId,
      intLimitToDb(input.tpmLimit),
      intLimitToDb(input.rpmLimit),
      limitToDb(input.monthlyAmountUsd),
      input.tpmLimit !== undefined,
      input.rpmLimit !== undefined,
      input.monthlyAmountUsd !== undefined,
    ]
  );
  return rowToLimits(row);
}

export async function clearKeyQuotaLimits(apiKeyId: string): Promise<void> {
  if (!apiKeyId) return;
  await db().transaction(async (tx) => {
    await tx.execute("DELETE FROM api_key_quota_limits WHERE api_key_id = $1", [apiKeyId]);
    await tx.execute(
      "DELETE FROM quota_counters WHERE api_key_id = $1 AND dimension_key IN ($2, $3)",
      [apiKeyId, DIMENSION_TPM, DIMENSION_RPM]
    );
  });
}

// ---------------------------------------------------------------------------
// Unpriced usage marker
// ---------------------------------------------------------------------------

/**
 * The calendar month in which a key used a metered model it could not price (no
 * pricing row and no provider-reported cost). That usage never reaches the
 * ledger the monthly cap sums, so it is recorded on the key's limits row
 * (`unpriced_usage_since`). Without a limits row there is nothing to cap, so
 * saving the marker is a no-op.
 */

/** Start (UTC ms) of the month that recorded unpriced usage for a key, or null. */
export async function loadUnpricedQuotaMonthStart(apiKeyId: string): Promise<number | null> {
  if (!apiKeyId) return null;
  const row = await db().queryOne<{ ms: number | null }>(
    `SELECT (extract(epoch FROM unpriced_usage_since) * 1000)::bigint AS ms
     FROM api_key_quota_limits WHERE api_key_id = $1`,
    [apiKeyId]
  );
  const monthStart = toNumber(row?.ms, 0);
  return monthStart > 0 ? monthStart : null;
}

export async function saveUnpricedQuotaMonthStart(
  apiKeyId: string,
  monthStartMs: number
): Promise<void> {
  await db().execute(
    "UPDATE api_key_quota_limits SET unpriced_usage_since = $2 WHERE api_key_id = $1",
    [apiKeyId, new Date(monthStartMs).toISOString()]
  );
}

export async function deleteUnpricedQuotaMonthStart(apiKeyId: string): Promise<void> {
  await db().execute(
    "UPDATE api_key_quota_limits SET unpriced_usage_since = NULL WHERE api_key_id = $1",
    [apiKeyId]
  );
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function bucketIndex(nowMs: number): number {
  return Math.floor(nowMs / KEY_QUOTA_WINDOW_MS);
}

/**
 * Effective count for a 2-bucket sliding window:
 *   effective = prev × (1 − elapsed/window) + curr
 */
async function effectiveWindowCount(
  apiKeyId: string,
  dimensionKey: string,
  nowMs: number
): Promise<number> {
  const current = bucketIndex(nowMs);
  const prev = current - 1;
  const rows = await db().query<{ bucket_index: number; consumed: number }>(
    `SELECT bucket_index, consumed FROM quota_counters
     WHERE api_key_id = $1 AND dimension_key = $2 AND bucket_index IN ($3, $4)`,
    [apiKeyId, dimensionKey, current, prev]
  );
  let curr = 0;
  let prevCount = 0;
  for (const r of rows) {
    if (Number(r.bucket_index) === current) curr = toNumber(r.consumed);
    else prevCount = toNumber(r.consumed);
  }
  const elapsed = nowMs - current * KEY_QUOTA_WINDOW_MS;
  const weight = Math.max(0, Math.min(1, elapsed / KEY_QUOTA_WINDOW_MS));
  return prevCount * (1 - weight) + curr;
}

/**
 * Atomically add `delta` to the current window bucket (UPSERT).
 */
export async function incrementKeyQuotaCounter(
  apiKeyId: string,
  dimension: KeyQuotaDimension,
  delta: number,
  nowMs = Date.now()
): Promise<void> {
  if (!apiKeyId || delta <= 0) return;
  const dimensionKey = dimension === "tpm" ? DIMENSION_TPM : DIMENSION_RPM;
  const bucket = bucketIndex(nowMs);
  await db().execute(
    `INSERT INTO quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (api_key_id, dimension_key, bucket_index) DO UPDATE SET
       consumed = quota_counters.consumed + EXCLUDED.consumed,
       updated_at = EXCLUDED.updated_at`,
    [apiKeyId, dimensionKey, bucket, delta, new Date(nowMs).toISOString()]
  );
}

/**
 * Increment both tpm (by billable tokens) and rpm (by 1) for a completed call.
 */
export async function recordKeyQuotaUsage(
  apiKeyId: string,
  billableTokens: number,
  nowMs = Date.now()
): Promise<void> {
  if (!apiKeyId) return;
  if (billableTokens > 0) await incrementKeyQuotaCounter(apiKeyId, "tpm", billableTokens, nowMs);
  await incrementKeyQuotaCounter(apiKeyId, "rpm", 1, nowMs);
}

// ---------------------------------------------------------------------------
// Status / enforcement read
// ---------------------------------------------------------------------------

/**
 * Effective usage in the current windows plus the month ledger total.
 */
export async function getKeyQuotaCounters(
  apiKeyId: string,
  deps: { now?: () => number; monthTotalUsd?: number } = {}
): Promise<KeyQuotaCounters> {
  const nowMs = (deps.now ?? Date.now)();
  const [tpmUsed, rpmUsed, monthlyAmountUsd] = await Promise.all([
    effectiveWindowCount(apiKeyId, DIMENSION_TPM, nowMs),
    effectiveWindowCount(apiKeyId, DIMENSION_RPM, nowMs),
    deps.monthTotalUsd !== undefined
      ? Promise.resolve(deps.monthTotalUsd)
      : getLedgerMonthTotal(apiKeyId, nowMs),
  ]);
  return { tpmUsed, rpmUsed, monthlyAmountUsd };
}

/** Resolve the current calendar-month ledger total for a key. */
async function getLedgerMonthTotal(apiKeyId: string, nowMs: number): Promise<number> {
  try {
    return (await aggregateLedgerThisMonth(apiKeyId, new Date(nowMs).toISOString())).amountUsd;
  } catch {
    return 0;
  }
}

/**
 * Full enforcement-ready status for a key: limits, current usage, and per
 * dimension exceeded flags.
 * Enforcement-only reads skip unlimited dimensions and report their counters
 * as zero. Dashboard callers retain full usage reads by default.
 */
export async function getKeyQuotaStatus(
  apiKeyId: string,
  deps: { now?: () => number; monthTotalUsd?: number; enforcementOnly?: boolean } = {}
): Promise<KeyQuotaStatus> {
  const limits = await getKeyQuotaLimits(apiKeyId);
  const nowMs = (deps.now ?? Date.now)();
  const counters = deps.enforcementOnly
    ? {
        tpmUsed:
          limits.tpmLimit !== null ? await effectiveWindowCount(apiKeyId, DIMENSION_TPM, nowMs) : 0,
        rpmUsed:
          limits.rpmLimit !== null ? await effectiveWindowCount(apiKeyId, DIMENSION_RPM, nowMs) : 0,
        monthlyAmountUsd:
          limits.monthlyAmountUsd !== null
            ? deps.monthTotalUsd !== undefined
              ? deps.monthTotalUsd
              : await getLedgerMonthTotal(apiKeyId, nowMs)
            : 0,
      }
    : await getKeyQuotaCounters(apiKeyId, { ...deps, now: () => nowMs });
  const enabled =
    limits.tpmLimit !== null || limits.rpmLimit !== null || limits.monthlyAmountUsd !== null;

  return {
    enabled,
    limits,
    counters,
    tpmExceeded: enabled && limits.tpmLimit !== null && counters.tpmUsed >= limits.tpmLimit,
    rpmExceeded: enabled && limits.rpmLimit !== null && counters.rpmUsed >= limits.rpmLimit,
    monthlyExceeded:
      enabled &&
      limits.monthlyAmountUsd !== null &&
      counters.monthlyAmountUsd >= limits.monthlyAmountUsd,
    windowResetAtIso: toIsoWindowStart(nowMs + KEY_QUOTA_WINDOW_MS),
  };
}
