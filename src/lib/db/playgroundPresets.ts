/**
 * db/playgroundPresets.ts — Playground Studio preset persistence.
 *
 * CRUD operations for the playground_presets table. Ids are uuid columns, so a
 * lookup with a malformed id returns "not found" without querying.
 *
 * @module lib/db/playgroundPresets
 */

import { randomUUID } from "node:crypto";
import { db, jsonb } from "./pg";
import { stripNul } from "./pgJsonText";

export interface PlaygroundPresetListItem {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  system: string | null;
  params: Record<string, unknown>;
  created_at: string;
}

type PlaygroundPresetRow = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  system: string | null;
  params: unknown;
  created_at: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = "id, name, endpoint, model, system, params, created_at";

function rowToItem(row: PlaygroundPresetRow): PlaygroundPresetListItem {
  let params: Record<string, unknown> = {};
  let parsed: unknown = row.params;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    params = parsed as Record<string, unknown>;
  }
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    model: row.model,
    system: row.system,
    params,
    created_at: row.created_at,
  };
}

/**
 * Returns all presets ordered by created_at descending (newest first).
 * Accepts optional limit/offset for pagination.
 */
export async function listPlaygroundPresets(options?: {
  limit?: number;
  offset?: number;
}): Promise<{
  items: PlaygroundPresetListItem[];
  total: number;
}> {
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  let sql = `SELECT ${COLUMNS} FROM playground_presets ORDER BY created_at DESC, id DESC`;
  const params: unknown[] = [];
  if (limit !== undefined) {
    sql += " LIMIT $1 OFFSET $2";
    params.push(limit, offset);
  }
  const rows = await db().query<PlaygroundPresetRow>(sql, params);
  const totalRow = await db().queryOne<{ cnt: number }>(
    `SELECT count(*)::int AS cnt FROM playground_presets`
  );
  return { items: rows.map(rowToItem), total: Number(totalRow?.cnt ?? 0) };
}

/**
 * Returns a single preset by id, or null when not found.
 */
export async function getPlaygroundPreset(id: string): Promise<PlaygroundPresetListItem | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db().queryOne<PlaygroundPresetRow>(
    `SELECT ${COLUMNS} FROM playground_presets WHERE id = $1`,
    [id]
  );
  return row ? rowToItem(row) : null;
}

/**
 * Creates a new preset. Generates a UUID v4 for the id.
 */
export async function createPlaygroundPreset(input: {
  name: string;
  endpoint: string;
  model: string;
  system: string | null | undefined;
  params: Record<string, unknown>;
}): Promise<PlaygroundPresetListItem> {
  const id = randomUUID();
  const row = await db().queryOne<PlaygroundPresetRow>(
    `INSERT INTO playground_presets (id, name, endpoint, model, system, params)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING ${COLUMNS}`,
    [
      id,
      stripNul(input.name),
      stripNul(input.endpoint),
      stripNul(input.model),
      input.system == null ? null : stripNul(input.system),
      jsonb(input.params ?? {}),
    ]
  );
  return rowToItem(row!);
}

/**
 * Updates only the supplied fields on an existing preset.
 * Returns the updated row, or null when the id does not exist.
 */
export async function updatePlaygroundPreset(
  id: string,
  patch: Partial<{
    name: string;
    endpoint: string;
    model: string;
    system: string | null;
    params: Record<string, unknown>;
  }>
): Promise<PlaygroundPresetListItem | null> {
  if (!UUID_RE.test(id)) return null;

  const setClauses: string[] = [];
  const values: unknown[] = [];
  const add = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (patch.name !== undefined) setClauses.push(`name = ${add(stripNul(patch.name))}`);
  if (patch.endpoint !== undefined) setClauses.push(`endpoint = ${add(stripNul(patch.endpoint))}`);
  if (patch.model !== undefined) setClauses.push(`model = ${add(stripNul(patch.model))}`);
  if ("system" in patch) {
    setClauses.push(`system = ${add(patch.system == null ? null : stripNul(patch.system))}`);
  }
  if (patch.params !== undefined) setClauses.push(`params = ${add(jsonb(patch.params))}::jsonb`);

  if (setClauses.length === 0) {
    // Empty patch — return current row unchanged
    return getPlaygroundPreset(id);
  }

  const row = await db().queryOne<PlaygroundPresetRow>(
    `UPDATE playground_presets SET ${setClauses.join(", ")} WHERE id = ${add(id)}::uuid
     RETURNING ${COLUMNS}`,
    values
  );
  return row ? rowToItem(row) : null;
}

/**
 * Deletes a preset by id.
 * Returns true when a row was deleted, false when the id did not exist.
 */
export async function deletePlaygroundPreset(id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const result = await db().execute(`DELETE FROM playground_presets WHERE id = $1`, [id]);
  return result.changes > 0;
}
