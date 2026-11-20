/**
 * Cluster runtime for this process, started in two phases from `registerNodejs()`:
 *
 * 1. `beginClusterRuntime()` BEFORE the database is initialized: validates the cluster
 *    configuration and takes the leader fence. A second standalone process (or a stale
 *    leader) must exit before it migrates or touches shared state.
 * 2. `completeClusterRuntime()` AFTER the database is ready: installs the invalidation bus
 *    (the PostgreSQL publisher runs through the pool).
 *
 * Transport (owner, 2026-11-18): PostgreSQL by default (advisory-lock fence, LISTEN/NOTIFY
 * bus), Redis when REDIS_URL is set (SET NX PX lease, pub/sub). Both are fail-closed: a
 * leader that can no longer prove it holds the fence exits.
 *
 * - standalone: fence only (a second process on the same database exits), no bus.
 * - leader:     fence + bus.
 * - worker:     bus only.
 */

import os from "node:os";

import { isNextBuildPhase } from "@/lib/buildPhase";
import { getDbBackend } from "@/lib/db/backends/selection";
import {
  createClusterBus,
  runBusResync,
  setClusterBus,
  type BusPublisher,
  type BusSubscriber,
  type ClusterBus,
} from "./bus";
import { acquireLeaderFence, readLeaderHolder, type LeaderFence } from "./leaderFence";
import { createPgBusPublisher, createPgBusSubscriber } from "./pgBus";
import { setClusterRedis } from "./redisClient";
import {
  FENCE_APPLICATION_PREFIX,
  acquirePgLeaderFence,
  readPgLeaderHolder,
} from "./pgLeaderFence";
import { clusterConfigErrors, resolveBootPlan, type BootPlan } from "./role";

type RedisClient = import("ioredis").Redis;

interface ClusterRuntimeState {
  plan: BootPlan;
  env: NodeJS.ProcessEnv;
  fence: LeaderFence | null;
  bus: ClusterBus | null;
  redis: RedisClient[];
  closers: Array<() => Promise<void>>;
  completed: boolean;
}

// On globalThis, not module scope: boot, graceful shutdown and the health route may load
// different bundle copies of this module (see the registry note in ./bus.ts).
const STATE_KEY = Symbol.for("omniroute.cluster.runtime");
const store = globalThis as unknown as Record<symbol, ClusterRuntimeState | null | undefined>;
function getState(): ClusterRuntimeState | null {
  return store[STATE_KEY] ?? null;
}
function setState(next: ClusterRuntimeState | null): void {
  store[STATE_KEY] = next;
}

async function connectRedis(url: string, name: string, onReconnect?: () => void) {
  const { default: Redis } = await import("ioredis");
  // Fail fast instead of queueing: the fence and the bus are fail-closed primitives.
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectionName: name,
  });
  client.on("error", (error: Error) => {
    console.warn(`[CLUSTER] Redis (${name}) error: ${error.message}`);
  });
  await client.connect();
  if (onReconnect) {
    // ioredis re-subscribes by itself; messages sent while it was away are lost.
    client.on("ready", onReconnect);
  }
  return client;
}

async function connectPg(applicationName: string, env: NodeJS.ProcessEnv) {
  const { default: pg } = await import("pg");
  const url = env.OMNIROUTE_POSTGRES_URL?.trim();
  if (!url) throw new Error("[CLUSTER] OMNIROUTE_POSTGRES_URL is required.");
  const client = new pg.Client({
    connectionString: url,
    application_name: applicationName,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  // node-postgres throws on an "error" with no listener; the fence/bus add their own.
  client.on("error", () => {});
  await client.connect();
  return client;
}

/**
 * Phase 1, before the database is initialized. Throws (and so stops the boot) on a
 * configuration error, when the coordination store is unreachable, or when another
 * process holds the fence. Returns null during `next build`, which must never fence.
 */
export async function beginClusterRuntime(
  env: NodeJS.ProcessEnv = process.env
): Promise<BootPlan | null> {
  if (isNextBuildPhase()) return null;
  const existing = getState();
  if (existing) return existing.plan;
  const errors = clusterConfigErrors(env);
  if (errors.length > 0) throw new Error(`[CLUSTER] Invalid configuration: ${errors.join(" ")}`);

  const plan = resolveBootPlan(env);
  // A standalone process gets a per-process fence id, so two role-less processes can never
  // take over each other's lease as "the same instance".
  const fenceId =
    plan.instanceId === "standalone"
      ? `standalone:${os.hostname()}:${process.pid}`
      : plan.instanceId;
  const current: ClusterRuntimeState = {
    plan,
    env,
    fence: null,
    bus: null,
    redis: [],
    closers: [],
    completed: false,
  };
  setState(current);

  try {
    if (plan.coordination === "redis") {
      const url = (env.REDIS_URL ?? "").trim();
      const command = await connectRedis(url, `omniroute:${plan.instanceId}:cmd`);
      current.redis.push(command);
      current.closers.push(() => command.quit().then(() => undefined));
      if (plan.takeLeaderFence) {
        current.fence = await acquireLeaderFence({ redis: command, instanceId: fenceId });
      }
    } else if (plan.takeLeaderFence) {
      const client = await connectPg(FENCE_APPLICATION_PREFIX + fenceId, env);
      current.fence = await acquirePgLeaderFence({ client, instanceId: fenceId });
    }
  } catch (error) {
    await stopClusterRuntime();
    throw error;
  }
  return plan;
}

/** Phase 2, after the database is ready: installs the bus in cluster mode. */
export async function completeClusterRuntime(): Promise<void> {
  const current = getState();
  if (!current || current.completed) return;
  current.completed = true;
  const { plan, env } = current;
  const resync = () => runBusResync();

  try {
    let publisher: BusPublisher | null = null;
    let subscriber: BusSubscriber | null = null;
    if (plan.clusterMode && plan.coordination === "redis") {
      const sub = await connectRedis(
        (env.REDIS_URL ?? "").trim(),
        `omniroute:${plan.instanceId}:sub`,
        resync
      );
      current.redis.push(sub);
      current.closers.push(() => sub.quit().then(() => undefined));
      publisher = current.redis[0];
      subscriber = sub;
      // Rate limiters keep their state on the command connection so a limit holds per
      // account across the cluster (open-sse/services/rateLimiter/redisSlotState.ts).
      setClusterRedis(current.redis[0]);
    } else if (plan.clusterMode) {
      publisher = createPgBusPublisher((text, values) => getDbBackend().execute(text, values));
      const pgSubscriber = createPgBusSubscriber({
        connect: () => connectPg(`omniroute-${plan.instanceId}:listen`, env),
        onReconnect: resync,
      });
      current.closers.push(() => pgSubscriber.close());
      subscriber = pgSubscriber;
    }
    if (publisher && subscriber) {
      const bus = createClusterBus({ publisher, subscriber, instanceId: plan.instanceId });
      await bus.start();
      setClusterBus(bus);
      current.bus = bus;
    }
  } catch (error) {
    await stopClusterRuntime();
    throw error;
  }

  console.log(
    `[CLUSTER] role=${plan.role} instance=${plan.instanceId} coordination=${plan.coordination}` +
      (current.fence ? " (leader fence held)" : "") +
      (current.bus ? " (bus subscribed)" : "")
  );
}

/** Both phases in one call (tests and scripts that do not split the boot). */
export async function startClusterRuntime(
  env: NodeJS.ProcessEnv = process.env
): Promise<BootPlan | null> {
  const plan = await beginClusterRuntime(env);
  if (plan) await completeClusterRuntime();
  return plan;
}

/** The boot plan of this process, or null before `beginClusterRuntime()`. */
export function getClusterBootPlan(): BootPlan | null {
  return getState()?.plan ?? null;
}

/** Releases the fence and closes the coordination connections (graceful shutdown). */
export async function stopClusterRuntime(): Promise<void> {
  const current = getState();
  setState(null);
  if (!current) return;
  setClusterBus(null);
  setClusterRedis(null);
  await current.fence?.release().catch(() => undefined);
  await Promise.all(current.closers.map((close) => close().catch(() => undefined)));
}

export interface ClusterStatus {
  role: BootPlan["role"];
  instanceId: string;
  coordination: BootPlan["coordination"];
  leaderLeaseHolder: string | null;
}

/** For the health payload. Null when the runtime was never started. */
export async function getClusterStatus(): Promise<ClusterStatus | null> {
  const current = getState();
  if (!current) return null;
  let leaderLeaseHolder: string | null = null;
  try {
    leaderLeaseHolder =
      current.plan.coordination === "redis"
        ? current.redis[0]
          ? await readLeaderHolder(current.redis[0])
          : null
        : await readPgLeaderHolder({
            query: async (text, values) => ({
              rows: await getDbBackend().query<Record<string, unknown>>(text, values),
            }),
          });
  } catch {
    leaderLeaseHolder = null;
  }
  return {
    role: current.plan.role,
    instanceId: current.plan.instanceId,
    coordination: current.plan.coordination,
    leaderLeaseHolder,
  };
}
