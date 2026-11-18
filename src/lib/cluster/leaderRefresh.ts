/**
 * Leader side of passive refresh: a worker that holds an expired or rejected token of a
 * provider it may not refresh publishes `cluster:refresh-request`; the leader refreshes
 * that connection and stores the result, and the worker adopts it from the database
 * (open-sse/services/tokenRefresh/passiveRefresh.ts).
 *
 * The refresh runs through the normal request-path refresh (`getAccessToken` with a
 * persist callback), so it takes the same per-connection mutex and rotation-group lane as
 * the leader's own sweep and request path: it can never race them.
 *
 * Guards: one refresh in flight per connection; at most one per connection every
 * `minIntervalMs` (a misbehaving worker cannot hammer the provider's token endpoint); an
 * "expired" request is dropped when the stored token is already fresh (another request
 * refreshed it first).
 */

import { parseTokenExpiryMs } from "@omniroute/open-sse/utils/tokenExpiry.ts";
import { onRefreshRequest, type RefreshReason } from "./bus";

export const LEADER_REFRESH_MIN_INTERVAL_MS = 15_000;
const FRESH_MARGIN_MS = 60_000;

type Connection = Record<string, unknown>;

export interface LeaderRefreshDeps {
  /** Uncached read of the connection row. */
  readConnection?: (id: string) => Promise<Connection | null>;
  /** Refreshes and persists (getAccessToken + updateProviderCredentials by default). */
  refresh?: (provider: string, connection: Connection, connectionId: string) => Promise<unknown>;
  minIntervalMs?: number;
  now?: () => number;
  warn?: (line: string, error?: unknown) => void;
}

async function defaultReadConnection(id: string): Promise<Connection | null> {
  const { getProviderConnectionById } =
    await import("@omniroute/open-sse/services/codexAccount/write.ts");
  return (await getProviderConnectionById(id)) as Connection | null;
}

async function defaultRefresh(provider: string, connection: Connection, connectionId: string) {
  const { getAccessToken, updateProviderCredentials } = await import("@/sse/services/tokenRefresh");
  return getAccessToken(provider, { ...connection, connectionId }, async (result) => {
    await updateProviderCredentials(connectionId, result);
  });
}

/** Decides whether a request should refresh, then refreshes. Exported for tests. */
export async function refreshForWorker(
  connectionId: string,
  reason: RefreshReason,
  deps: LeaderRefreshDeps = {}
): Promise<"refreshed" | "skipped"> {
  const readConnection = deps.readConnection ?? defaultReadConnection;
  const refresh = deps.refresh ?? defaultRefresh;
  const now = deps.now ?? Date.now;

  const connection = await readConnection(connectionId);
  if (!connection || connection.isActive === false) return "skipped";
  const provider = typeof connection.provider === "string" ? connection.provider : "";
  if (!provider || typeof connection.refreshToken !== "string" || !connection.refreshToken) {
    return "skipped";
  }
  const expiry = parseTokenExpiryMs(connection.tokenExpiresAt || connection.expiresAt);
  if (reason === "expired" && expiry > now() + FRESH_MARGIN_MS) return "skipped";
  await refresh(provider, connection, connectionId);
  return "refreshed";
}

/** Registers the leader's handler. Returns an unregister function. */
export function installLeaderRefreshHandler(deps: LeaderRefreshDeps = {}): () => void {
  const minIntervalMs = deps.minIntervalMs ?? LEADER_REFRESH_MIN_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((line: string, error?: unknown) => console.warn(line, error ?? ""));
  const inFlight = new Set<string>();
  const lastStarted = new Map<string, number>();

  return onRefreshRequest((connectionId, reason) => {
    if (inFlight.has(connectionId)) return;
    const startedAt = now();
    if (startedAt - (lastStarted.get(connectionId) ?? -Infinity) < minIntervalMs) return;
    lastStarted.set(connectionId, startedAt);
    inFlight.add(connectionId);
    // Ids and the reason only, never token material.
    console.info(`[CLUSTER] Refresh requested by a worker: connection ${connectionId} (${reason})`);
    void refreshForWorker(connectionId, reason, deps)
      .catch((error: unknown) =>
        warn(`[CLUSTER] Refresh for a worker failed (connection ${connectionId})`, error)
      )
      .finally(() => inFlight.delete(connectionId));
  });
}
