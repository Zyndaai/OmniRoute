/**
 * Database module: AgentBridgeState
 * CRUD operations for agent_bridge_state table.
 */

import { db, ts } from "./pg";
import type { AgentBridgeStateRow } from "./_rowTypes.ts";

export async function getAllAgentBridgeStates(): Promise<AgentBridgeStateRow[]> {
  return db().query<AgentBridgeStateRow>(`SELECT * FROM agent_bridge_state ORDER BY agent_id ASC`);
}

export async function getAgentBridgeState(agentId: string): Promise<AgentBridgeStateRow | null> {
  const row = await db().queryOne<AgentBridgeStateRow>(
    `SELECT * FROM agent_bridge_state WHERE agent_id = $1`,
    [agentId]
  );
  return row ?? null;
}

export async function upsertAgentBridgeState(
  row: Partial<AgentBridgeStateRow> & { agent_id: string }
): Promise<void> {
  const lastStartedGiven = row.last_started_at !== undefined;
  const lastErrorGiven = row.last_error !== undefined;
  // Insert with defaults for omitted fields; on conflict update only the fields passed.
  await db().execute(
    `INSERT INTO agent_bridge_state
       (agent_id, dns_enabled, cert_trusted, setup_completed, last_started_at, last_error)
     VALUES ($1, COALESCE($2::boolean, false), COALESCE($3::boolean, false),
             COALESCE($4::boolean, false), $5, $6)
     ON CONFLICT (agent_id) DO UPDATE SET
       dns_enabled = COALESCE($2::boolean, agent_bridge_state.dns_enabled),
       cert_trusted = COALESCE($3::boolean, agent_bridge_state.cert_trusted),
       setup_completed = COALESCE($4::boolean, agent_bridge_state.setup_completed),
       last_started_at = CASE WHEN $7::boolean THEN EXCLUDED.last_started_at
                              ELSE agent_bridge_state.last_started_at END,
       last_error = CASE WHEN $8::boolean THEN EXCLUDED.last_error
                         ELSE agent_bridge_state.last_error END`,
    [
      row.agent_id,
      row.dns_enabled === undefined ? null : Boolean(row.dns_enabled),
      row.cert_trusted === undefined ? null : Boolean(row.cert_trusted),
      row.setup_completed === undefined ? null : Boolean(row.setup_completed),
      ts(row.last_started_at ?? null),
      row.last_error ?? null,
      lastStartedGiven,
      lastErrorGiven,
    ]
  );
}

export async function setLastStarted(agentId: string, at: string): Promise<void> {
  await db().execute(
    `INSERT INTO agent_bridge_state (agent_id, last_started_at)
     VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET last_started_at = EXCLUDED.last_started_at`,
    [agentId, ts(at)]
  );
}

export async function setLastError(agentId: string, err: string | null): Promise<void> {
  await db().execute(
    `INSERT INTO agent_bridge_state (agent_id, last_error)
     VALUES ($1, $2)
     ON CONFLICT (agent_id) DO UPDATE SET last_error = EXCLUDED.last_error`,
    [agentId, err]
  );
}
