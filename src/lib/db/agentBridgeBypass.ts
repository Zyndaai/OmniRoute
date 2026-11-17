/**
 * Database module: AgentBridgeBypass
 * CRUD + seed for agent_bridge_bypass table.
 */

import { db } from "./pg";
import type { AgentBridgeBypassRow } from "./_rowTypes.ts";

export async function getAllBypassPatterns(): Promise<AgentBridgeBypassRow[]> {
  return db().query<AgentBridgeBypassRow>(
    `SELECT pattern, source, created_at FROM agent_bridge_bypass ORDER BY source ASC, pattern ASC`
  );
}

export async function getUserBypassPatterns(): Promise<string[]> {
  const rows = await db().query<{ pattern: string }>(
    `SELECT pattern FROM agent_bridge_bypass WHERE source = 'user' ORDER BY pattern ASC`
  );
  return rows.map((r) => r.pattern);
}

export async function replaceUserBypassPatterns(patterns: string[]): Promise<void> {
  const now = new Date().toISOString();
  const unique = [...new Set(patterns)];
  await db().transaction(async (tx) => {
    await tx.execute(`DELETE FROM agent_bridge_bypass WHERE source = 'user'`);
    for (const pattern of unique) {
      // A default row with the same pattern keeps its source (the primary key is the pattern).
      await tx.execute(
        `INSERT INTO agent_bridge_bypass (pattern, source, created_at) VALUES ($1, 'user', $2)
         ON CONFLICT (pattern) DO NOTHING`,
        [pattern, now]
      );
    }
  });
}

/**
 * Seeds default bypass patterns — idempotent.
 * Only inserts a pattern if it does not already exist in the table.
 */
export async function seedDefaultBypassPatterns(defaults: string[]): Promise<void> {
  const now = new Date().toISOString();
  await db().transaction(async (tx) => {
    for (const pattern of defaults) {
      await tx.execute(
        `INSERT INTO agent_bridge_bypass (pattern, source, created_at) VALUES ($1, 'default', $2)
         ON CONFLICT (pattern) DO NOTHING`,
        [pattern, now]
      );
    }
  });
}
