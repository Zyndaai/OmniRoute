/**
 * Leader fence: at most one process may hold the leader duties (background jobs and the
 * refresh of single-use OAuth tokens). Two leaders refreshing the same Claude/Codex
 * account would burn its refresh-token family and force a human re-login.
 *
 * The leader takes `cluster:leader` with `SET NX PX <ttl>` and renews it every
 * `renewMs` with a compare-and-extend script. Crash-only: when the lease is held by
 * someone else at boot, or lost later (another holder, or Redis unreachable long enough
 * that the lease may have expired), `onLost` runs; the default logs and exits so the
 * container restart policy retries visibly. There is no demotion path.
 */

export const LEADER_FENCE_KEY = "cluster:leader";
export const DEFAULT_FENCE_TTL_MS = 30_000;
export const DEFAULT_FENCE_RENEW_MS = 10_000;

// Extend only while we still hold the key; returns 1 when extended, 0 otherwise.
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
// Delete only our own lease on a clean shutdown.
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** The subset of an ioredis client the fence needs (injectable for tests). */
export interface FenceRedis {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface LeaderFenceOptions {
  redis: FenceRedis;
  instanceId: string;
  ttlMs?: number;
  renewMs?: number;
  /** Called once when the lease is lost after acquisition. Default: log and exit(1). */
  onLost?: (reason: string) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export interface LeaderFence {
  readonly instanceId: string;
  /** Stops renewing and releases the lease if still ours. */
  release(): Promise<void>;
}

export class LeaderFenceHeldError extends Error {
  constructor(readonly holder: string | null) {
    super(
      `Leader fence ${LEADER_FENCE_KEY} is held by "${holder ?? "unknown"}". Only one process may run as leader; this one exits.`
    );
    this.name = "LeaderFenceHeldError";
  }
}

function defaultOnLost(reason: string): void {
  console.error(`[CLUSTER] Leader fence lost (${reason}); exiting so no second leader can run.`);
  process.exit(1);
}

/**
 * Takes the fence or throws `LeaderFenceHeldError`. A lease already held under this
 * process's own instance id (a restart within the TTL) is taken over.
 */
export async function acquireLeaderFence(options: LeaderFenceOptions): Promise<LeaderFence> {
  const {
    redis,
    instanceId,
    ttlMs = DEFAULT_FENCE_TTL_MS,
    renewMs = DEFAULT_FENCE_RENEW_MS,
    onLost = defaultOnLost,
    now = Date.now,
    setInterval: schedule = (fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearInterval: cancel = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    log = console.log,
  } = options;
  if (!(renewMs > 0 && renewMs < ttlMs)) {
    throw new Error(`leader fence: renewMs (${renewMs}) must be > 0 and < ttlMs (${ttlMs})`);
  }

  const acquired = await redis.set(LEADER_FENCE_KEY, instanceId, "PX", ttlMs, "NX");
  if (acquired !== "OK") {
    const holder = await redis.get(LEADER_FENCE_KEY);
    if (holder !== instanceId) throw new LeaderFenceHeldError(holder);
    const extended = await redis.eval(RENEW_SCRIPT, 1, LEADER_FENCE_KEY, instanceId, ttlMs);
    if (Number(extended) !== 1) throw new LeaderFenceHeldError(await redis.get(LEADER_FENCE_KEY));
  }
  log(`[CLUSTER] Leader fence acquired by ${instanceId} (ttl ${ttlMs} ms)`);

  let lastRenewedAt = now();
  let stopped = false;
  let renewing = false;
  const lose = (reason: string) => {
    if (stopped) return;
    stopped = true;
    cancel(handle);
    onLost(reason);
  };
  const handle = schedule(() => {
    if (stopped || renewing) return;
    renewing = true;
    redis
      .eval(RENEW_SCRIPT, 1, LEADER_FENCE_KEY, instanceId, ttlMs)
      .then((result) => {
        if (Number(result) === 1) lastRenewedAt = now();
        else lose("lease is held by another process");
      })
      .catch((error: unknown) => {
        // Fail closed: once the lease may have expired, another process may lead.
        if (now() - lastRenewedAt >= ttlMs - renewMs) {
          const msg = error instanceof Error ? error.message : String(error);
          lose(`renewal failed for ${now() - lastRenewedAt} ms: ${msg}`);
        }
      })
      .finally(() => {
        renewing = false;
      });
  }, renewMs);

  return {
    instanceId,
    async release() {
      if (stopped) return;
      stopped = true;
      cancel(handle);
      await redis.eval(RELEASE_SCRIPT, 1, LEADER_FENCE_KEY, instanceId).catch(() => undefined);
    },
  };
}

/** Current lease holder, for the health payload. Null when nobody holds it. */
export async function readLeaderHolder(redis: Pick<FenceRedis, "get">): Promise<string | null> {
  return redis.get(LEADER_FENCE_KEY);
}
