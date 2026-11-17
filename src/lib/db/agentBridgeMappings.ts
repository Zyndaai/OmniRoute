/**
 * Database module: AgentBridgeMappings
 * CRUD operations for agent_bridge_mappings table. The MITM proxy reads this table
 * directly, so there is no separate alias mirror to keep in sync any more.
 */

import { db } from "./pg";
import type { AgentBridgeMappingRow } from "./_rowTypes";

export async function getMappingsForAgent(agentId: string): Promise<AgentBridgeMappingRow[]> {
  return db().query<AgentBridgeMappingRow>(
    `SELECT agent_id, source_model, target_model, updated_at
       FROM agent_bridge_mappings WHERE agent_id = $1 ORDER BY source_model ASC`,
    [agentId]
  );
}

export async function setMappings(
  agentId: string,
  mappings: Array<{ source: string; target: string }>
): Promise<void> {
  const now = new Date().toISOString();
  await db().transaction(async (tx) => {
    await tx.execute(`DELETE FROM agent_bridge_mappings WHERE agent_id = $1`, [agentId]);
    for (const mapping of mappings) {
      // Later duplicates of one source win, as the old delete-then-insert would have failed.
      await tx.execute(
        `INSERT INTO agent_bridge_mappings (agent_id, source_model, target_model, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id, source_model) DO UPDATE SET
           target_model = EXCLUDED.target_model, updated_at = EXCLUDED.updated_at`,
        [agentId, mapping.source, mapping.target, now]
      );
    }
  });
}

export async function deleteMapping(agentId: string, source: string): Promise<void> {
  await db().execute(`DELETE FROM agent_bridge_mappings WHERE agent_id = $1 AND source_model = $2`, [
    agentId,
    source,
  ]);
}

/**
 * Kept for callers: the MITM proxy now reads `agent_bridge_mappings` itself (the
 * `mitmAlias` key_value mirror is gone), so there is nothing to sync.
 */
export async function syncAgentBridgeMappingsToMitmAlias(_agentId: string): Promise<void> {}
