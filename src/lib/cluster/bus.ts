/**
 * Cluster bus: Redis pub/sub between the processes of one gateway.
 *
 * - `cluster:invalidate {scope, id?, origin}`: a process changed shared state; every
 *   other process drops its local cache for that scope (API keys, settings, proxies,
 *   rate-limit toggles...). Cache TTLs stay as the floor if a message is missed.
 * - `cluster:refresh-request {connectionId, origin}`: a worker found an expired token of
 *   a rotating provider; the leader refreshes it (workers never do).
 *
 * Loop safety: modules register LOCAL-ONLY handlers with `onInvalidation`. A public
 * invalidator does "local twin + publishInvalidation"; a received message calls only the
 * local twin, so it can never be republished. Messages from this process are ignored.
 *
 * Standalone processes install no bus: publishing is a no-op and nothing is received.
 */

export const INVALIDATE_CHANNEL = "cluster:invalidate";
export const REFRESH_REQUEST_CHANNEL = "cluster:refresh-request";

export interface BusPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

/** A dedicated ioredis connection (a subscribed connection cannot publish). */
export interface BusSubscriber {
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
}

export type InvalidationData = Record<string, string | number | boolean>;
type InvalidationHandler = (id: string | undefined, data: InvalidationData | undefined) => void;
type RefreshRequestHandler = (connectionId: string) => void;

const invalidationHandlers = new Map<string, Set<InvalidationHandler>>();
const refreshRequestHandlers = new Set<RefreshRequestHandler>();

/** Registers a local-only invalidator for `scope`. Returns an unregister function. */
export function onInvalidation(scope: string, handler: InvalidationHandler): () => void {
  let set = invalidationHandlers.get(scope);
  if (!set) invalidationHandlers.set(scope, (set = new Set()));
  set.add(handler);
  return () => set?.delete(handler);
}

const resyncHandlers = new Set<() => void>();

/**
 * Registers a "drop everything local" handler. Transports call `runBusResync()` after a
 * reconnect: messages sent while the connection was down are lost, so every cache that
 * relies on the bus must be dropped and re-read.
 */
export function onBusResync(handler: () => void): () => void {
  resyncHandlers.add(handler);
  return () => resyncHandlers.delete(handler);
}

export function runBusResync(warn: (line: string, error?: unknown) => void = console.warn): void {
  for (const handler of resyncHandlers) {
    try {
      handler();
    } catch (error) {
      warn("[CLUSTER] bus resync handler failed", error);
    }
  }
}

/** Registers the leader's refresh-request handler. Returns an unregister function. */
export function onRefreshRequest(handler: RefreshRequestHandler): () => void {
  refreshRequestHandlers.add(handler);
  return () => refreshRequestHandlers.delete(handler);
}

export interface ClusterBus {
  readonly instanceId: string;
  start(): Promise<void>;
  publishInvalidation(scope: string, id?: string, data?: InvalidationData): void;
  publishRefreshRequest(connectionId: string): void;
  /** Handles one raw message as the subscriber delivers it (exported for tests). */
  dispatch(channel: string, raw: string): void;
}

export interface ClusterBusOptions {
  publisher: BusPublisher;
  subscriber: BusSubscriber;
  instanceId: string;
  warn?: (line: string, error?: unknown) => void;
}

export function createClusterBus(options: ClusterBusOptions): ClusterBus {
  const { publisher, subscriber, instanceId, warn = console.warn } = options;

  const send = (channel: string, payload: Record<string, unknown>) => {
    publisher
      .publish(channel, JSON.stringify({ ...payload, origin: instanceId }))
      .catch((error: unknown) => warn(`[CLUSTER] publish on ${channel} failed`, error));
  };

  const dispatch = (channel: string, raw: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      warn(`[CLUSTER] dropped a malformed message on ${channel}`);
      return;
    }
    if (!message || typeof message !== "object" || message.origin === instanceId) return;

    if (channel === INVALIDATE_CHANNEL && typeof message.scope === "string") {
      const id = typeof message.id === "string" ? message.id : undefined;
      const data =
        message.data && typeof message.data === "object" && !Array.isArray(message.data)
          ? (message.data as InvalidationData)
          : undefined;
      for (const handler of invalidationHandlers.get(message.scope) ?? []) {
        try {
          handler(id, data);
        } catch (error) {
          warn(`[CLUSTER] invalidation handler for "${message.scope}" failed`, error);
        }
      }
    } else if (channel === REFRESH_REQUEST_CHANNEL && typeof message.connectionId === "string") {
      for (const handler of refreshRequestHandlers) {
        try {
          handler(message.connectionId);
        } catch (error) {
          warn("[CLUSTER] refresh-request handler failed", error);
        }
      }
    }
  };

  return {
    instanceId,
    async start() {
      subscriber.on("message", dispatch);
      await subscriber.subscribe(INVALIDATE_CHANNEL, REFRESH_REQUEST_CHANNEL);
    },
    publishInvalidation(scope, id, data) {
      send(INVALIDATE_CHANNEL, {
        scope,
        ...(id === undefined ? {} : { id }),
        ...(data === undefined ? {} : { data }),
      });
    },
    publishRefreshRequest(connectionId) {
      send(REFRESH_REQUEST_CHANNEL, { connectionId });
    },
    dispatch,
  };
}

// ── Process-wide bus (installed at boot in cluster mode) ─────────────────────────────

let activeBus: ClusterBus | null = null;

export function setClusterBus(bus: ClusterBus | null): void {
  activeBus = bus;
}

export function getClusterBus(): ClusterBus | null {
  return activeBus;
}

/** Tells the other processes to drop `scope`. No-op in standalone mode. */
export function publishInvalidation(scope: string, id?: string, data?: InvalidationData): void {
  activeBus?.publishInvalidation(scope, id, data);
}

/** Asks the leader to refresh a rotating token. No-op in standalone mode. */
export function publishRefreshRequest(connectionId: string): void {
  activeBus?.publishRefreshRequest(connectionId);
}
