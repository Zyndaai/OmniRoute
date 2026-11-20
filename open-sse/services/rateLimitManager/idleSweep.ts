/**
 * Drops limiters nobody has used for INACTIVE_LIMITER_MS so model and connection churn
 * cannot grow the limiter map without bound. A limiter with queued or running work is
 * kept. The next request for an evicted key builds a fresh limiter.
 *
 * (This replaced the Bottleneck wedge watchdog. The current limiter wakes its queue with
 * exact timers and has no heartbeat that could stall, so only the idle cleanup remained.)
 */

export const IDLE_SWEEP_INTERVAL_MS = 30_000;
export const INACTIVE_LIMITER_MS = 10 * 60 * 1000;

interface SweepableLimiter {
  isIdle(): boolean;
}

export interface IdleSweepDependencies {
  limiters: Map<string, SweepableLimiter>;
  limiterLastUsed: Map<string, number>;
  log: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** Evicts idle limiters and returns how many were removed. */
export function sweepIdleLimiters(deps: IdleSweepDependencies, now = Date.now()): number {
  const { limiters, limiterLastUsed, log } = deps;
  const debug = deps.debug ?? ((...args: unknown[]) => console.debug(...args));

  let evicted = 0;
  let maxIdleMs = 0;
  let hasValidIdle = false;
  for (const [key, limiter] of Array.from(limiters)) {
    const lastUsed = limiterLastUsed.get(key) ?? 0;
    if (now - lastUsed <= INACTIVE_LIMITER_MS) continue;
    if (!limiter.isIdle()) continue;

    // A row with no recorded use is still removed; only the headline figure skips it so
    // one missing timestamp cannot dominate the reported oldest idle age.
    if (lastUsed > 0) {
      maxIdleMs = Math.max(maxIdleMs, now - lastUsed);
      hasValidIdle = true;
    }
    evicted += 1;
    limiters.delete(key);
    limiterLastUsed.delete(key);
    debug(
      `[RATE-LIMIT] Evicting idle limiter: ${key} ` +
        `(inactive for ${Math.round((now - lastUsed) / 1000)}s)`
    );
  }
  if (evicted > 0) {
    const oldestIdleSec = hasValidIdle ? Math.round(maxIdleMs / 1000) : 0;
    log(`[RATE-LIMIT] Evicted idle limiters: ${evicted} (oldest idle ${oldestIdleSec}s)`);
  }
  return evicted;
}
