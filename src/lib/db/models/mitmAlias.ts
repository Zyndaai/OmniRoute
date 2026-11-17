/** db/models/mitmAlias.ts — MITM alias CRUD (rows of `agent_bridge_mappings`). */

import { db } from "../pg";

type MitmAliasMap = Record<string, string>;

/** `{source: target}` for one agent, or `{agent: {source: target}}` for all agents. */
export async function getMitmAlias(toolName?: string) {
  if (toolName) {
    const rows = await db().query<{ source_model: string; target_model: string }>(
      "SELECT source_model, target_model FROM agent_bridge_mappings WHERE agent_id = $1",
      [toolName]
    );
    const result: MitmAliasMap = {};
    for (const row of rows) result[row.source_model] = row.target_model;
    return result;
  }
  const rows = await db().query<{
    agent_id: string;
    source_model: string;
    target_model: string;
  }>("SELECT agent_id, source_model, target_model FROM agent_bridge_mappings");
  const result: Record<string, MitmAliasMap> = {};
  for (const row of rows) {
    (result[row.agent_id] ??= {})[row.source_model] = row.target_model;
  }
  return result;
}

function entryModel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const model = (value as { model?: unknown }).model;
    if (typeof model === "string") return model.trim() || null;
  }
  return null;
}

/**
 * Replaces every mapping of `toolName` with `mappings`. Entries are plain strings or
 * `{model?, reasoningEffort?}` objects; only `model` is stored (`agent_bridge_mappings` has no
 * reasoning-effort column, so a reasoningEffort override is not persisted) and entries without a
 * model are skipped. A non-object `mappings` is a no-op; an empty object clears the agent.
 */
export async function setMitmAliasAll(toolName: string, mappings: unknown) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return;
  const pairs: [string, string][] = [];
  for (const [source, value] of Object.entries(mappings as Record<string, unknown>)) {
    const model = entryModel(value);
    if (source && model) pairs.push([source, model]);
  }
  await db().transaction(async (tx) => {
    await tx.execute("DELETE FROM agent_bridge_mappings WHERE agent_id = $1", [toolName]);
    if (pairs.length === 0) return;
    await tx.execute(
      `INSERT INTO agent_bridge_mappings (agent_id, source_model, target_model)
       SELECT $1, s, t FROM unnest($2::text[], $3::text[]) AS m(s, t)
       ON CONFLICT (agent_id, source_model)
       DO UPDATE SET target_model = EXCLUDED.target_model, updated_at = now()`,
      [toolName, pairs.map(([source]) => source), pairs.map(([, target]) => target)]
    );
  });
}
