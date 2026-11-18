/**
 * Leader fence on PostgreSQL (the default when REDIS_URL is unset; see ./leaderFence.ts for
 * the Redis lease). Same contract: at most one leader, crash-only, fail closed.
 *
 * The leader holds a session-level advisory lock on a DEDICATED connection (not a pool
 * client, which would hand the session to other queries). The server releases the lock
 * when that session ends, so a crashed leader frees it at once. The other half matters as
 * much: if the server drops the session (restart, network cut, admin kill), the lock is
 * gone while the old leader still runs, so the leader probes its connection every
 * `probeMs` and listens for `error`/`end`, and gives up the leader role (default: exits)
 * the moment the session is in doubt.
 */

import { LeaderFenceHeldError, type LeaderFence } from "./leaderFence";

// Two-int advisory key: classid = "OMNI", objid = 1 (the leader role).
export const FENCE_LOCK_CLASS = 0x4f4d4e49;
export const FENCE_LOCK_OBJECT = 1;
export const DEFAULT_PG_FENCE_PROBE_MS = 5_000;
/** application_name prefix of the fence session; the holder lookup strips it. */
export const FENCE_APPLICATION_PREFIX = "omniroute-fence:";

/** The subset of a node-postgres `Client` the fence needs (injectable for tests). */
export interface PgFenceClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  on(event: "error" | "end", listener: (...args: unknown[]) => void): unknown;
  end(): Promise<void>;
}

export interface PgLeaderFenceOptions {
  /** A connected client used only by the fence. It is closed on release. */
  client: PgFenceClient;
  instanceId: string;
  probeMs?: number;
  onLost?: (reason: string) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (line: string) => void;
}

function defaultOnLost(reason: string): void {
  console.error(`[CLUSTER] Leader fence lost (${reason}); exiting so no second leader can run.`);
  process.exit(1);
}

/** Who holds the fence (instance id), read from any connection. Null when nobody does. */
export async function readPgLeaderHolder(
  client: Pick<PgFenceClient, "query">
): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT a.application_name
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted
        AND l.classid = $1::oid AND l.objid = $2::oid AND l.objsubid = 2
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      LIMIT 1`,
    [FENCE_LOCK_CLASS, FENCE_LOCK_OBJECT]
  );
  const name = rows[0]?.application_name;
  if (typeof name !== "string") return null;
  return name.startsWith(FENCE_APPLICATION_PREFIX)
    ? name.slice(FENCE_APPLICATION_PREFIX.length)
    : name;
}

/**
 * Takes the fence or throws `LeaderFenceHeldError`. The client should have been created
 * with `application_name = FENCE_APPLICATION_PREFIX + instanceId` so others can name the
 * holder (see `createPgFenceClient` in ./runtime.ts).
 */
export async function acquirePgLeaderFence(options: PgLeaderFenceOptions): Promise<LeaderFence> {
  const {
    client,
    instanceId,
    probeMs = DEFAULT_PG_FENCE_PROBE_MS,
    onLost = defaultOnLost,
    setInterval: schedule = (fn, ms) => {
      const handle = setInterval(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearInterval: cancel = (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    log = console.log,
  } = options;

  // The fence session must never be closed for idling, and the lock call must not wait.
  await client.query("SET idle_session_timeout = 0");
  await client.query("SET statement_timeout = 10000");
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [
    FENCE_LOCK_CLASS,
    FENCE_LOCK_OBJECT,
  ]);
  if (rows[0]?.ok !== true) {
    const holder = await readPgLeaderHolder(client).catch(() => null);
    await client.end().catch(() => undefined);
    throw new LeaderFenceHeldError(holder);
  }
  log(`[CLUSTER] Leader fence acquired by ${instanceId} (PostgreSQL advisory lock)`);

  let stopped = false;
  let probing = false;
  let handle: unknown = null;
  const lose = (reason: string) => {
    if (stopped) return;
    stopped = true;
    if (handle !== null) cancel(handle);
    onLost(reason);
  };
  client.on("error", (error: unknown) =>
    lose(`fence connection error: ${error instanceof Error ? error.message : String(error)}`)
  );
  client.on("end", () => lose("fence connection closed"));
  handle = schedule(() => {
    if (stopped || probing) return;
    probing = true;
    client
      .query("SELECT 1")
      .catch((error: unknown) =>
        lose(`fence probe failed: ${error instanceof Error ? error.message : String(error)}`)
      )
      .finally(() => {
        probing = false;
      });
  }, probeMs);

  return {
    instanceId,
    async release() {
      if (stopped) return;
      stopped = true;
      if (handle !== null) cancel(handle);
      await client
        .query("SELECT pg_advisory_unlock($1, $2)", [FENCE_LOCK_CLASS, FENCE_LOCK_OBJECT])
        .catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}
