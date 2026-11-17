/**
 * db/quotaConsumption.ts — Sliding Window Counter primitives for quota tracking.
 *
 * Implements low-level bucket read/write operations for the 2-bucket sliding
 * window counter algorithm. Each row of `quota_counters` is keyed on
 * (api_key_id, dimension_key, bucket_index) where dimension_key =
 * "<poolId>:<unit>:<window>" and bucket_index = floor(now_ms / window_ms).
 *
 * Atomicity: incrementBucket uses INSERT ... ON CONFLICT DO UPDATE (UPSERT)
 * which is a single atomic statement — no separate read-modify-write, so it is
 * safe across processes.
 *
 * Part of: Group B — Quota Sharing Engine (plan 22, frente F2).
 */

import { db, toMs } from "./pg";

interface BucketRow {
  consumed: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single consumption event row, as returned by listConsumptionForPool.
 * Derived from the quota_counters table; the poolId is stripped from
 * dimension_key (format "<poolId>:<unit>:<window>") and the unit/window
 * fragments are surfaced separately.
 */
export interface ConsumptionEvent {
  apiKeyId: string;
  /** The full dimension_key string: "<poolId>:<unit>:<window>" */
  dimensionKey: string;
  /** The <unit> segment of dimension_key (e.g. "tokens", "requests", "usd") */
  unit: string;
  /** The <window> segment of dimension_key (e.g. "hourly", "daily") */
  window: string;
  bucketIndex: number;
  consumed: number;
  /** epoch ms */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the consumed value for a single bucket. Returns 0 if no row exists.
 */
export async function getBucket(
  apiKeyId: string,
  dimensionKey: string,
  bucketIndex: number
): Promise<number> {
  const row = await db().queryOne<BucketRow>(
    `SELECT consumed FROM quota_counters
     WHERE api_key_id = $1 AND dimension_key = $2 AND bucket_index = $3`,
    [apiKeyId, dimensionKey, bucketIndex]
  );
  return row?.consumed ?? 0;
}

/**
 * Atomically increment the consumed counter for a bucket.
 * Uses UPSERT: if the row does not exist it is created; if it exists the
 * delta is added to the existing consumed value and updated_at is refreshed.
 *
 * @param apiKeyId      The API key being tracked.
 * @param dimensionKey  "<poolId>:<unit>:<window>" string.
 * @param bucketIndex   floor(nowMs / windowMs).
 * @param delta         Amount to add (positive number).
 * @param nowMs         Current epoch milliseconds (used for updated_at).
 */
export async function incrementBucket(
  apiKeyId: string,
  dimensionKey: string,
  bucketIndex: number,
  delta: number,
  nowMs: number
): Promise<void> {
  await db().execute(
    `INSERT INTO quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (api_key_id, dimension_key, bucket_index)
     DO UPDATE SET
       consumed = quota_counters.consumed + EXCLUDED.consumed,
       updated_at = EXCLUDED.updated_at`,
    [apiKeyId, dimensionKey, bucketIndex, delta, new Date(nowMs).toISOString()]
  );
}

/**
 * Read the current and previous bucket values for the sliding window formula:
 *   effective = prev × (1 − elapsed/window) + curr
 *
 * @param apiKeyId      The API key being tracked.
 * @param dimensionKey  "<poolId>:<unit>:<window>" string.
 * @param currentBucket The current bucket index (floor(nowMs / windowMs)).
 * @returns             { curr, prev } — both default to 0 when row is absent.
 */
export async function getPair(
  apiKeyId: string,
  dimensionKey: string,
  currentBucket: number
): Promise<{ curr: number; prev: number }> {
  const rows = await db().query<{ bucket_index: number; consumed: number }>(
    `SELECT bucket_index, consumed FROM quota_counters
     WHERE api_key_id = $1 AND dimension_key = $2 AND bucket_index IN ($3, $4)`,
    [apiKeyId, dimensionKey, currentBucket, currentBucket - 1]
  );
  let curr = 0;
  let prev = 0;
  for (const r of rows) {
    if (Number(r.bucket_index) === currentBucket) curr = r.consumed;
    else prev = r.consumed;
  }
  return { curr, prev };
}

// ---------------------------------------------------------------------------
// List recent consumption for a pool
// ---------------------------------------------------------------------------

interface ConsumptionRow {
  api_key_id: string;
  dimension_key: string;
  bucket_index: number;
  consumed: number;
  updated_at: string;
}

/**
 * Return the most-recent consumption rows for a given pool, ordered by
 * updated_at DESC. The poolId is the first segment of dimension_key
 * (format "<poolId>:<unit>:<window>"), so we filter by that prefix.
 *
 * @param poolId  The quota pool identifier.
 * @param limit   Maximum rows to return (caller should clamp; default 50).
 * @returns       Array of ConsumptionEvent (may be empty if no data yet).
 */
export async function listConsumptionForPool(
  poolId: string,
  limit: number
): Promise<ConsumptionEvent[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
  // starts_with() avoids LIKE-escaping a poolId that contains "%" or "_".
  const rows = await db().query<ConsumptionRow>(
    `SELECT api_key_id, dimension_key, bucket_index, consumed, updated_at
     FROM quota_counters
     WHERE starts_with(dimension_key, $1)
     ORDER BY updated_at DESC
     LIMIT $2`,
    [`${poolId}:`, safeLimit]
  );

  return rows.map((r) => {
    const parts = r.dimension_key.split(":");
    // parts[0] = poolId, parts[1] = unit, parts[2..] = window (rejoin in case window has colons)
    const unit = parts[1] ?? "";
    const window = parts.slice(2).join(":") ?? "";
    return {
      apiKeyId: r.api_key_id,
      dimensionKey: r.dimension_key,
      unit,
      window,
      bucketIndex: r.bucket_index,
      consumed: r.consumed,
      updatedAt: toMs(r.updated_at) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Pool-wide aggregate
// ---------------------------------------------------------------------------

/**
 * Sum the consumed values for a given (dimensionKey, currentBucketIndex) and
 * (dimensionKey, currentBucketIndex - 1) across ALL api_key_id values.
 *
 * Returns { currTotal, prevTotal } so the caller can apply the sliding-window
 * formula once with the pool-wide totals instead of summing per-key.
 *
 * @param dimensionKey   "<poolId>:<unit>:<window>" string — same format as consume/peek.
 * @param currentBucket  floor(nowMs / windowMs) — caller must pass the same value.
 */
export async function sumPoolDimension(
  dimensionKey: string,
  currentBucket: number
): Promise<{ currTotal: number; prevTotal: number }> {
  const rows = await db().query<{ bucket_index: number; total: number }>(
    `SELECT bucket_index, COALESCE(SUM(consumed), 0) AS total
     FROM quota_counters
     WHERE dimension_key = $1 AND bucket_index IN ($2, $3)
     GROUP BY bucket_index`,
    [dimensionKey, currentBucket, currentBucket - 1]
  );
  let currTotal = 0;
  let prevTotal = 0;
  for (const r of rows) {
    if (Number(r.bucket_index) === currentBucket) currTotal = r.total;
    else prevTotal = r.total;
  }
  return { currTotal, prevTotal };
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

/**
 * Delete rows whose updated_at is strictly less than maxUpdatedAtMs.
 * Used by GC background job to clean up stale bucket rows.
 *
 * Boundary semantics: rows with updated_at === maxUpdatedAtMs are KEPT.
 * Only rows with updated_at < maxUpdatedAtMs (strictly older) are deleted.
 *
 * @param maxUpdatedAtMs Epoch ms threshold (exclusive lower bound for kept rows).
 * @returns              Number of rows deleted.
 */
export async function gcOlderThan(maxUpdatedAtMs: number): Promise<number> {
  const result = await db().execute("DELETE FROM quota_counters WHERE updated_at < $1", [
    new Date(maxUpdatedAtMs).toISOString(),
  ]);
  return result.changes;
}
