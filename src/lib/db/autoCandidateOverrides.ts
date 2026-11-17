/**
 * db/autoCandidateOverrides.ts — Per-API-key candidate exclusions for `auto/*`
 * channels (#7819, Level 2 of the "per-user candidate control" feature).
 *
 * OmniRoute is single-tenant (no `users` table, no `user_id`/`userId` column
 * anywhere under `src/lib/db/`) — `apiKeyId` is the closest real per-caller
 * identity this app has, so overrides are keyed by (apiKeyId, autoChannel,
 * connectionId) rather than "per user". See the Open Question in the #7819
 * plan for the follow-up decision on whether this should instead be global.
 *
 * Mirrors the relational style of `reasoningRoutingRules.ts` / `apiKeyGroups.ts`
 * rather than the key_value JSON-blob pattern — exclusions are a simple
 * row-per-candidate set, which is simpler to index and reason about than a
 * JSON array column.
 */
import { randomUUID } from "node:crypto";
import { db, type DbExecutor } from "@/lib/db/pg";

export interface AutoCandidateOverride {
  id: string;
  apiKeyId: string;
  autoChannel: string;
  connectionId: string;
  excluded: boolean;
  createdAt: string;
}

type OverrideRow = {
  id: string;
  api_key_id: string;
  auto_channel: string;
  connection_id: string;
  excluded: boolean;
  created_at: string;
};

function rowToOverride(row: OverrideRow): AutoCandidateOverride {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    autoChannel: row.auto_channel,
    connectionId: row.connection_id,
    excluded: row.excluded === true,
    createdAt: row.created_at,
  };
}

/** No FK on this table (keys may be `env-key`/`self-loop`), so deletes must clean it up. */
export async function deleteOverridesForApiKey(
  apiKeyId: string,
  executor: DbExecutor = db()
): Promise<number> {
  const res = await executor.execute("DELETE FROM auto_candidate_overrides WHERE api_key_id = $1", [
    apiKeyId,
  ]);
  return res.changes;
}

/** Counterpart for connection deletion (called by the providers domain). */
export async function deleteOverridesForConnection(
  connectionId: string,
  executor: DbExecutor = db()
): Promise<number> {
  const res = await executor.execute(
    "DELETE FROM auto_candidate_overrides WHERE connection_id = $1",
    [connectionId]
  );
  return res.changes;
}

/**
 * Returns the set of connection IDs excluded by this API key for this auto
 * channel. Empty set when no overrides exist (the default, unconfigured
 * path) — callers should treat an empty set as "no filtering needed" rather
 * than iterating a lookup for every candidate.
 */
export async function getExcludedConnectionIds(
  apiKeyId: string,
  autoChannel: string
): Promise<Set<string>> {
  if (!apiKeyId || !autoChannel) return new Set();
  const rows = await db().query<{ connection_id: string }>(
    `SELECT connection_id FROM auto_candidate_overrides
       WHERE api_key_id = $1 AND auto_channel = $2 AND excluded = true`,
    [apiKeyId, autoChannel]
  );
  return new Set(rows.map((row) => row.connection_id));
}

/**
 * Sets (or clears) the excluded flag for one candidate connection, scoped to
 * one API key + auto channel. Idempotent — re-setting the same value is a
 * no-op write via UPSERT.
 */
export async function setExcluded(
  apiKeyId: string,
  autoChannel: string,
  connectionId: string,
  excluded: boolean
): Promise<AutoCandidateOverride> {
  const row = await db().queryOne<OverrideRow>(
    `INSERT INTO auto_candidate_overrides
       (id, api_key_id, auto_channel, connection_id, excluded, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (api_key_id, auto_channel, connection_id)
     DO UPDATE SET excluded = EXCLUDED.excluded
     RETURNING id, api_key_id, auto_channel, connection_id, excluded, created_at`,
    [randomUUID(), apiKeyId, autoChannel, connectionId, excluded]
  );
  return rowToOverride(row as OverrideRow);
}

/** Lists all override rows for one API key + auto channel (excluded and not). */
export async function listOverrides(
  apiKeyId: string,
  autoChannel: string
): Promise<AutoCandidateOverride[]> {
  if (!apiKeyId || !autoChannel) return [];
  const rows = await db().query<OverrideRow>(
    `SELECT id, api_key_id, auto_channel, connection_id, excluded, created_at
       FROM auto_candidate_overrides
       WHERE api_key_id = $1 AND auto_channel = $2
       ORDER BY created_at ASC`,
    [apiKeyId, autoChannel]
  );
  return rows.map(rowToOverride);
}
