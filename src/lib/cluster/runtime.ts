/**
 * Cluster runtime for this process: validates the cluster configuration, takes the leader
 * fence and installs the invalidation bus. Called once from `registerNodejs()` after the
 * database is ready.
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
import {
  FENCE_APPLICATION_PREFIX,
  acquirePgLeaderFence,
  readPgLeaderHolder,
} from "./pgLeaderFence";
import { clusterConfigErrors, resolveBootPlan, type BootPlan } from "./role";

type RedisClient = import("ioredis").Redis;

interface ClusterRuntimeState {
  plan: BootPlan;
  fence: LeaderFence | null;
  bus: ClusterBus | null;
  redis: RedisClient[];
  closers: Array<() => Promise<void>>;
}

let state: ClusterRuntimeState | null = null;

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

async function connectPg(applicationName: string) {
  const { default: pg } = await import("pg");
  const url = process.env.OMNIROUTE_POSTGRES_URL?.trim();
  if (!url) throw new Error("[CLUSTER] OMNIROUTE_POSTGRES_URL is required.");
  const client = new pg.Client({ connectionString: url, application_name: applicationName });
  // node-postgres throws on an "error" with no listener; the fence/bus add their own.
  client.on("error", () => {});
  await client.connect();
  return client;
}

/**
 * Starts the cluster runtime. Throws (and so stops the boot) on a configuration error,
 * when the coordination store is unreachable, or when another process holds the fence.
 */
export async function startClusterRuntime(env: NodeJS.ProcessEnv = process.env): Promise<BootPlan> {
  if (state) return state.plan;
  const errors = clusterConfigErrors(env);
  if (errors.length > 0) throw new Error(`[CLUSTER] Invalid configuration: ${errors.join(" ")}`);

  const plan = resolveBootPlan(env);
  // A standalone process gets a per-process fence id, so two role-less processes can never
  // take over each other's lease as "the same instance".
  const fenceId =
    plan.instanceId === "standalone"
      ? `standalone:${os.hostname()}:${process.pid}`
      : plan.instanceId;
  const current: ClusterRuntimeState = { plan, fence: null, bus: null, redis: [], closers: [] };
  state = current;
  const resync = () => runBusResync();

  try {
    let publisher: BusPublisher | null = null;
    let subscriber: BusSubscriber | null = null;

    if (plan.coordination === "redis") {
      const url = (env.REDIS_URL ?? "").trim();
      const command = await connectRedis(url, `omniroute:${plan.instanceId}:cmd`);
      current.redis.push(command);
      current.closers.push(() => command.quit().then(() => undefined));
      if (plan.takeLeaderFence) {
        current.fence = await acquireLeaderFence({ redis: command, instanceId: fenceId });
      }
      if (plan.clusterMode) {
        const sub = await connectRedis(url, `omniroute:${plan.instanceId}:sub`, resync);
        current.redis.push(sub);
        current.closers.push(() => sub.quit().then(() => undefined));
        publisher = command;
        subscriber = sub;
      }
    } else {
      if (plan.takeLeaderFence) {
        const client = await connectPg(FENCE_APPLICATION_PREFIX + fenceId);
        current.fence = await acquirePgLeaderFence({ client, instanceId: fenceId });
      }
      if (plan.clusterMode) {
        publisher = createPgBusPublisher((text, values) => getDbBackend().execute(text, values));
        const pgSubscriber = createPgBusSubscriber({
          connect: () => connectPg(`omniroute-${plan.instanceId}:listen`),
          onReconnect: resync,
        });
        current.closers.push(() => pgSubscriber.close());
        subscriber = pgSubscriber;
      }
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
  return plan;
}

/** Releases the fence and closes the coordination connections (graceful shutdown). */
export async function stopClusterRuntime(): Promise<void> {
  const current = state;
  state = null;
  if (!current) return;
  setClusterBus(null);
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
  const current = state;
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
