/**
 * Builds the limiter for one key with the state that fits how this process runs:
 * Redis-shared when it is part of a Redis-coordinated cluster, otherwise in memory with
 * this process's share of each limit (../clusterShare.ts).
 */

import { getClusterRedis } from "../../../src/lib/cluster/redisClient.ts";
import { clusterProcessCount, shareLimiterOptions } from "../clusterShare.ts";
import { KeyedLimiter, MemorySlotState, type LimiterSettings } from "./keyedLimiter.ts";
import { RedisSlotState } from "./redisSlotState.ts";

export {
  KeyedLimiter,
  MemorySlotState,
  LimiterExecutionTimeoutError,
  LimiterJobDroppedError,
  type LimiterSettings,
  type LimiterCounts,
  type ScheduleOptions,
  type SlotState,
} from "./keyedLimiter.ts";
export { RedisSlotState } from "./redisSlotState.ts";

/** "No limit" values the rate-limit manager uses; the split leaves them as they are. */
export const UNLIMITED_RESERVOIR = Number.MAX_SAFE_INTEGER;
export const UNLIMITED_CONCURRENCY = 1000;

export function createKeyedLimiter(key: string, settings: LimiterSettings): KeyedLimiter {
  const n = clusterProcessCount();
  const redis = n > 1 ? getClusterRedis() : null;
  if (redis) return new KeyedLimiter(key, settings, new RedisSlotState(redis, key, settings));
  const sentinels = {
    unlimitedReservoir: UNLIMITED_RESERVOIR,
    unlimitedConcurrency: UNLIMITED_CONCURRENCY,
  };
  const state = new MemorySlotState(settings, (s) => shareLimiterOptions(s, n, sentinels));
  return new KeyedLimiter(key, settings, state);
}
