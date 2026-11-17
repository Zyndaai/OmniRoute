/**
 * db/discoveryState.ts — Per-connection record of the last model discovery outcome.
 *
 * A discovery response only lives for the request that produced it: after a
 * failed discovery the next read looked exactly like a successful one, with no
 * trace of the failure left anywhere. This module stores the last outcome
 * (status, cause, date) of every connection in the `discovery_status`,
 * `discovery_cause` and `discovery_at` columns of `connection_model_sync`
 * (one row per connection, shared with the synced model list).
 *
 * The record is display state only: it never touches the connection columns
 * that drive routing (`lastError`, `lastErrorType`, `testStatus`).
 */

import { db } from "./pg";
import { stripNul } from "./pgJsonText";

export type DiscoveryStateStatus = "healthy" | "degraded";

export interface DiscoveryStateRecord {
  /** Outcome of the last discovery attempt: "healthy" or "degraded". */
  status: DiscoveryStateStatus;
  /** Sanitized cause of the failure, or null when the discovery succeeded. */
  cause: string | null;
  /** ISO timestamp of the attempt the record describes. */
  at: string;
}

/** One connection whose stored outcome is read or deleted. */
export interface DiscoveryStateEntry {
  provider: string;
  id: string;
}

function discoveryStateKey(providerId: string, connectionId: string): string {
  return `${providerId}:${connectionId}`;
}

/**
 * Store the outcome of the last discovery attempt for one connection. The
 * entry is replaced, never appended: the store keeps one row per connection.
 * The row has a foreign key to its connection, so an outcome for a connection that no
 * longer exists is dropped.
 */
export async function saveDiscoveryState(
  providerId: string,
  connectionId: string,
  outcome: { status: DiscoveryStateStatus; cause: string | null }
): Promise<void> {
  await db().execute(
    `INSERT INTO connection_model_sync
       (connection_id, provider, discovery_status, discovery_cause, discovery_at)
     SELECT $1::text, $2::text, $3::text, $4::text, now()
     WHERE EXISTS (SELECT 1 FROM provider_connections WHERE id = $1)
     ON CONFLICT (connection_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       discovery_status = EXCLUDED.discovery_status,
       discovery_cause = EXCLUDED.discovery_cause,
       discovery_at = EXCLUDED.discovery_at,
       updated_at = now()`,
    [connectionId, providerId, outcome.status, outcome.cause === null ? null : stripNul(outcome.cause)]
  );
}

/**
 * Read the stored outcomes of a list of connections with a single query.
 * Returns a map keyed by `<providerId>:<connectionId>`; a connection without a
 * readable entry is simply absent from the map.
 */
export async function getDiscoveryStatesForConnections(
  entries: DiscoveryStateEntry[]
): Promise<Map<string, DiscoveryStateRecord>> {
  const states = new Map<string, DiscoveryStateRecord>();
  if (entries.length === 0) return states;

  const rows = await db().query<{
    connection_id: string;
    provider: string;
    discovery_status: string | null;
    discovery_cause: string | null;
    discovery_at: string | null;
  }>(
    `SELECT connection_id, provider, discovery_status, discovery_cause, discovery_at
     FROM connection_model_sync
     WHERE discovery_status IS NOT NULL AND discovery_at IS NOT NULL
       AND (provider, connection_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [entries.map((entry) => entry.provider), entries.map((entry) => entry.id)]
  );

  for (const row of rows) {
    // An unknown outcome must never be mistaken for a healthy one.
    if (row.discovery_status !== "healthy" && row.discovery_status !== "degraded") continue;
    const at = row.discovery_at ? new Date(row.discovery_at).toISOString() : "";
    if (!at) continue;
    states.set(discoveryStateKey(row.provider, row.connection_id), {
      status: row.discovery_status,
      cause: row.discovery_cause && row.discovery_cause.length > 0 ? row.discovery_cause : null,
      at,
    });
  }
  return states;
}

/** Clear the stored outcome columns, dropping rows that then hold nothing. */
async function clearDiscoveryColumns(where: string, params: unknown[]): Promise<number> {
  return db().transaction(async (tx) => {
    const cleared = await tx.execute(
      `UPDATE connection_model_sync
       SET discovery_status = NULL, discovery_cause = NULL, discovery_at = NULL, updated_at = now()
       WHERE discovery_status IS NOT NULL AND ${where}`,
      params
    );
    await tx.execute(
      `DELETE FROM connection_model_sync
       WHERE discovery_status IS NULL AND models = '[]'::jsonb AND ${where}`,
      params
    );
    return cleared.changes;
  });
}

/** Drop the stored outcomes of the given connections. */
export async function deleteDiscoveryStatesForConnections(
  entries: DiscoveryStateEntry[]
): Promise<number> {
  if (entries.length === 0) return 0;
  return clearDiscoveryColumns(
    "(provider, connection_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))",
    [entries.map((entry) => entry.provider), entries.map((entry) => entry.id)]
  );
}

/** Drop every stored outcome of a provider. */
export async function deleteDiscoveryStatesForProvider(providerId: string): Promise<number> {
  return clearDiscoveryColumns("provider = $1", [providerId]);
}
