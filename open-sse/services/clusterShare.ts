/**
 * Static per-process share of a rate limit in a cluster.
 *
 * Every OmniRoute process (PM2 leader + workers, ecosystem.config.cjs) runs its own request
 * queues. Limits must hold per upstream account across the cluster, so:
 *
 * - With Redis coordination (REDIS_URL set) the limiter keeps its state in Redis and every
 *   process enforces the one shared limit exactly (rateLimiter/redisSlotState.ts).
 * - With PostgreSQL coordination (no Redis) each process enforces 1/N of each cap, as
 *   computed here: spacing is multiplied by N, counts are divided by N. This adds nothing to
 *   the hot path and no failure mode, and errs on the safe side: a stopped worker leaves its
 *   share unused, never over budget. A count below N cannot be split (each process keeps at
 *   least 1, so the cluster allows up to N). The average rate holds, but the processes do not
 *   see each other: up to N requests can reach the upstream at the same moment.
 *
 * The provider-default caps (providerDefaultRateLimit.ts) use the split in both modes.
 *
 * N comes from OMNIROUTE_CLUSTER_SIZE (leader + workers, set by ecosystem.config.cjs);
 * unset or 1 means a single process and changes nothing.
 */

export const CLUSTER_SIZE_ENV = "OMNIROUTE_CLUSTER_SIZE";

export function clusterProcessCount(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const n = Number.parseInt(env[CLUSTER_SIZE_ENV] ?? "", 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

/**
 * This process's share of a count (requests per window, concurrency). Non-positive values
 * (exhausted, or "no limit" sentinels the caller handles) and `unlimitedAt` or above pass
 * through unchanged.
 */
export function shareOfCount(total: number, n: number, unlimitedAt = Infinity): number {
  if (n <= 1 || !Number.isFinite(total) || total <= 0 || total >= unlimitedAt) return total;
  return Math.max(1, Math.floor(total / n));
}

/** This process's spacing between requests (ms). */
export function shareOfSpacing(ms: number, n: number): number {
  if (n <= 1 || !Number.isFinite(ms) || ms <= 0) return ms;
  return ms * n;
}

interface LimiterOptionsLike {
  maxConcurrent?: number | null;
  minTime?: number | null;
  reservoir?: number | null;
  reservoirRefreshAmount?: number | null;
}

/**
 * Limiter settings scaled to this process's share. `unlimitedReservoir` and
 * `unlimitedConcurrency` are the caller's "no limit" sentinels, left as they are. Only keys
 * the caller set are touched, so a minTime-only update stays minTime-only.
 */
export function shareLimiterOptions<T extends LimiterOptionsLike>(
  options: T,
  n: number,
  sentinels: { unlimitedReservoir: number; unlimitedConcurrency: number }
): T {
  if (n <= 1) return options;
  const out: T = { ...options };
  const countKey = (key: keyof LimiterOptionsLike, unlimitedAt: number) => {
    const value = out[key];
    if (typeof value === "number") {
      (out as LimiterOptionsLike)[key] = shareOfCount(value, n, unlimitedAt);
    }
  };
  if (typeof out.minTime === "number") out.minTime = shareOfSpacing(out.minTime, n);
  countKey("maxConcurrent", sentinels.unlimitedConcurrency);
  countKey("reservoir", sentinels.unlimitedReservoir);
  countKey("reservoirRefreshAmount", sentinels.unlimitedReservoir);
  return out;
}
