/**
 * Limiter state shared by every process of a cluster through Redis, so a limit holds per
 * upstream account across the whole cluster rather than per process.
 *
 * Each limiter key has two Redis keys:
 * - a hash with the token budget (`tokens`, `refreshAmount`, `refreshInterval`,
 *   `nextRefresh`) and the last start time (`lastStart`);
 * - a sorted set of running slots scored by their lease expiry, so a process that dies
 *   mid-request frees its slots when the lease runs out.
 *
 * Every decision runs as one Lua script on Redis's own clock (`TIME`), so processes never
 * race each other and their clock skew does not matter. A process that cannot reach Redis
 * lets requests through (fail open) and logs a warning at most once a minute: the limiter
 * protects upstream accounts, and stalling every request on a Redis outage would be worse.
 *
 * Waits that only another process can end (a slot held elsewhere, an empty budget with no
 * refill) are retried every POLL_MS, since a release in another process cannot wake this
 * queue directly.
 */

import { randomUUID } from "node:crypto";
import type { ClusterRedis } from "../../../src/lib/cluster/redisClient.ts";
import {
  isUnlimited,
  type Admission,
  type LimiterSettings,
  type SlotState,
} from "./keyedLimiter.ts";

const KEY_PREFIX = "omniroute:rl:";
const POLL_MS = 200;
const IDLE_TTL_MS = 10 * 60 * 1000;
const WARN_INTERVAL_MS = 60_000;

// Shared by the scripts: refill the budget if its refresh time has passed.
const REFILL = `
local function now_ms()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local function refill(key, now)
  local s = redis.call('HMGET', key, 'tokens', 'refreshAmount', 'refreshInterval', 'nextRefresh')
  local tokens, ra, ri, nr = tonumber(s[1]), tonumber(s[2]), tonumber(s[3]), tonumber(s[4])
  if ri and ra and nr and now >= nr then
    tokens = ra
    nr = nr + (math.floor((now - nr) / ri) + 1) * ri
    redis.call('HSET', key, 'tokens', tokens, 'nextRefresh', nr)
  end
  return tokens, ra, ri, nr
end
`;

// KEYS: hash, running set. ARGV: maxConcurrent (-1 = none), minTime, leaseMs, slot, ttlMs.
// Returns {1, 0} granted, {0, waitMs (-1 = unknown), reason}, or {-1} when the state is gone
// (expired while idle, or discarded): a missing budget must never read as "no limit".
const ACQUIRE = `${REFILL}
if redis.call('HEXISTS', KEYS[1], 'init') == 0 then return {-1, 0, 'missing'} end
local now = now_ms()
local maxc, minTime, lease, ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if maxc >= 0 and redis.call('ZCARD', KEYS[2]) >= maxc then
  return {0, -1, 'concurrency'}
end
local tokens, ra, ri, nr = refill(KEYS[1], now)
if tokens and tokens <= 0 then
  if ri and ra and nr then return {0, nr - now, 'reservoir'} end
  return {0, -1, 'reservoir'}
end
local last = tonumber(redis.call('HGET', KEYS[1], 'lastStart'))
if last and minTime > 0 and last + minTime > now then
  return {0, last + minTime - now, 'spacing'}
end
redis.call('HSET', KEYS[1], 'lastStart', now)
if tokens then redis.call('HSET', KEYS[1], 'tokens', tokens - 1) end
redis.call('ZADD', KEYS[2], now + lease, ARGV[4])
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[2], math.max(ttl, lease))
return {1, 0, ''}
`;

// KEYS: hash. ARGV: onlyIfNew (1/0), ttlMs, then field/value pairs where the value '' deletes.
// Setting refreshAmount or refreshInterval restarts the refill clock from now.
const APPLY = `
if ARGV[1] == '1' and redis.call('HEXISTS', KEYS[1], 'init') == 1 then return 0 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local refreshChanged = false
for i = 3, #ARGV, 2 do
  local field, value = ARGV[i], ARGV[i + 1]
  if value == '' then redis.call('HDEL', KEYS[1], field) else redis.call('HSET', KEYS[1], field, value) end
  if field == 'refreshAmount' or field == 'refreshInterval' then refreshChanged = true end
end
local ri = tonumber(redis.call('HGET', KEYS[1], 'refreshInterval'))
if ri then
  if refreshChanged then redis.call('HSET', KEYS[1], 'nextRefresh', now + ri) end
else
  redis.call('HDEL', KEYS[1], 'nextRefresh')
end
redis.call('HSET', KEYS[1], 'init', 1)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

const TOKENS = `${REFILL}
local tokens = refill(KEYS[1], now_ms())
return tokens and tostring(tokens) or false
`;

let lastWarnAt = 0;
function warnUnreachable(error: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[RATE-LIMIT] Redis limiter state unreachable (${message}); letting requests through until it recovers`
  );
}

function fieldValue(value: number | null | undefined): string {
  return isUnlimited(value) ? "" : String(value);
}

function applyArgs(updates: LimiterSettings): string[] {
  const args: string[] = [];
  if ("reservoir" in updates) args.push("tokens", fieldValue(updates.reservoir));
  if ("reservoirRefreshAmount" in updates) {
    args.push("refreshAmount", fieldValue(updates.reservoirRefreshAmount));
  }
  if ("reservoirRefreshInterval" in updates) {
    const interval = updates.reservoirRefreshInterval;
    args.push(
      "refreshInterval",
      typeof interval === "number" && Number.isFinite(interval) && interval > 0
        ? String(interval)
        : ""
    );
  }
  return args;
}

export class RedisSlotState implements SlotState {
  private readonly hashKey: string;
  private readonly runKey: string;
  private ttlMs: number;
  private ready: Promise<void>;

  constructor(
    private readonly redis: ClusterRedis,
    limiterKey: string,
    initial: LimiterSettings
  ) {
    this.hashKey = `${KEY_PREFIX}${limiterKey}`;
    this.runKey = `${KEY_PREFIX}${limiterKey}:run`;
    this.ttlMs = this.ttlFor(initial);
    // A limiter built in one process must not reset the budget other processes have
    // already used: the initial settings only apply when the key holds no state yet.
    this.ready = this.write(initial, true);
  }

  private ttlFor(settings: LimiterSettings): number {
    const interval = settings.reservoirRefreshInterval;
    const refresh = typeof interval === "number" && Number.isFinite(interval) ? interval * 2 : 0;
    return Math.max(IDLE_TTL_MS, refresh);
  }

  private async write(updates: LimiterSettings, onlyIfNew: boolean): Promise<void> {
    const args = applyArgs(updates);
    if ("reservoirRefreshInterval" in updates) this.ttlMs = this.ttlFor(updates);
    try {
      await this.redis.eval(
        APPLY,
        1,
        this.hashKey,
        onlyIfNew ? "1" : "0",
        String(this.ttlMs),
        ...args
      );
    } catch (error) {
      warnUnreachable(error);
    }
  }

  async acquire(settings: LimiterSettings, leaseMs: number): Promise<Admission> {
    await this.ready;
    const maxConcurrent = isUnlimited(settings.maxConcurrent)
      ? -1
      : Math.max(0, Math.floor(settings.maxConcurrent as number));
    const minTime =
      typeof settings.minTime === "number" && settings.minTime > 0 ? settings.minTime : 0;
    const slot = randomUUID();
    let reply: unknown;
    // Two attempts: a missing state is re-created from this limiter's current settings,
    // then asked again.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        reply = await this.redis.eval(
          ACQUIRE,
          2,
          this.hashKey,
          this.runKey,
          maxConcurrent,
          Math.ceil(minTime),
          Math.ceil(leaseMs),
          slot,
          Math.max(this.ttlMs, Math.ceil(minTime) * 2)
        );
      } catch (error) {
        warnUnreachable(error);
        return { granted: true, slot: "" };
      }
      if (!Array.isArray(reply) || Number(reply[0]) !== -1) break;
      await this.write(settings, true);
    }
    const [granted, waitMs, reason] = Array.isArray(reply) ? reply : [1, 0, ""];
    if (Number(granted) === -1) return { granted: false, waitMs: POLL_MS, reason: "reservoir" };
    if (Number(granted) === 1) return { granted: true, slot };
    const wait = Number(waitMs);
    return {
      granted: false,
      waitMs: wait < 0 ? POLL_MS : wait,
      reason: (String(reason) || "spacing") as "spacing" | "reservoir" | "concurrency",
    };
  }

  async release(slot: string): Promise<void> {
    try {
      await this.redis.eval("return redis.call('ZREM', KEYS[1], ARGV[1])", 1, this.runKey, slot);
    } catch (error) {
      warnUnreachable(error);
    }
  }

  apply(updates: LimiterSettings): Promise<void> {
    const write = this.ready.then(() => this.write(updates, false));
    this.ready = write;
    return write;
  }

  async tokens(): Promise<number | null> {
    await this.ready;
    try {
      const value = await this.redis.eval(TOKENS, 1, this.hashKey);
      return value === null || value === undefined || value === false ? null : Number(value);
    } catch (error) {
      warnUnreachable(error);
      return null;
    }
  }

  async discard(): Promise<void> {
    try {
      await this.redis.eval("return redis.call('DEL', KEYS[1])", 1, this.hashKey);
    } catch (error) {
      warnUnreachable(error);
    }
  }
}
