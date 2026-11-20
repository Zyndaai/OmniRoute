/**
 * The cluster runtime's Redis command connection, shared with modules that must not import
 * the runtime itself (it pulls in pg/ioredis/the DB backend). Set by ./runtime.ts when Redis
 * coordination starts, cleared on shutdown; null otherwise. On globalThis because Next
 * compiles boot code and route handlers into separate bundles (see ./bus.ts).
 *
 * Dependency-free on purpose.
 */

/** The subset of an ioredis client the consumers need. */
export interface ClusterRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const KEY = Symbol.for("omniroute.cluster.redis");
const store = globalThis as unknown as Record<symbol, ClusterRedis | null | undefined>;

export function setClusterRedis(client: ClusterRedis | null): void {
  store[KEY] = client;
}

export function getClusterRedis(): ClusterRedis | null {
  return store[KEY] ?? null;
}
