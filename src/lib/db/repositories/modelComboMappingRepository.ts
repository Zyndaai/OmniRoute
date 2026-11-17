/**
 * PostgreSQL implementation of per-model combo mapping persistence and resolution.
 *
 * Maps model name patterns (glob-style wildcards) to specific combos.
 * When a request arrives for a model string like "claude-sonnet-4",
 * the resolver checks all enabled mappings (highest priority first)
 * and returns the first matching combo.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  CreateModelComboMappingInput,
  ModelComboMapping,
  ModelComboMappingRepository,
  UpdateModelComboMappingInput,
} from "@/domain/persistence/comboRepositories";
import { globToRegex } from "@/shared/utils/globPattern";
import { db } from "../pg";

export type { ModelComboMapping } from "@/domain/persistence/comboRepositories";

interface MappingRow {
  id: string;
  pattern: string;
  combo_id: string;
  combo_name: string | null;
  priority: number;
  enabled: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

const MAPPING_SELECT = `SELECT m.id, m.pattern, m.combo_id, c.name AS combo_name,
            m.priority, m.enabled, m.description, m.created_at, m.updated_at
     FROM model_combo_mappings m
     LEFT JOIN combos c ON c.id = m.combo_id`;

function rowToMapping(row: MappingRow): ModelComboMapping {
  return {
    id: row.id,
    pattern: row.pattern,
    comboId: row.combo_id,
    comboName: row.combo_name || undefined,
    priority: row.priority,
    enabled: row.enabled === true,
    description: row.description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List all model-combo mappings, joined with combo name.
 * Ordered by priority descending (highest first).
 */
export async function getModelComboMappings(options?: {
  limit?: number;
  offset?: number;
}): Promise<{ items: ModelComboMapping[]; total: number }> {
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  let sql = `${MAPPING_SELECT} ORDER BY m.priority DESC, m.created_at ASC, m.id ASC`;
  const params: unknown[] = [];
  if (limit !== undefined) {
    sql += " LIMIT $1 OFFSET $2";
    params.push(limit, offset);
  }
  const rows = await db().query<MappingRow>(sql, params);
  const totalRow = await db().queryOne<{ cnt: number }>(
    "SELECT count(*) AS cnt FROM model_combo_mappings"
  );
  return { items: rows.map(rowToMapping), total: totalRow?.cnt ?? 0 };
}

/**
 * Get a single mapping by ID.
 */
export async function getModelComboMappingById(id: string): Promise<ModelComboMapping | null> {
  const row = await db().queryOne<MappingRow>(`${MAPPING_SELECT} WHERE m.id = $1`, [id]);
  return row ? rowToMapping(row) : null;
}

/**
 * Create a new model-combo mapping.
 */
export async function createModelComboMapping(
  data: CreateModelComboMappingInput
): Promise<ModelComboMapping> {
  const now = new Date().toISOString();
  const id = uuidv4();

  await db().execute(
    `INSERT INTO model_combo_mappings
     (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [
      id,
      data.pattern,
      data.comboId,
      data.priority ?? 0,
      data.enabled !== false,
      data.description || "",
      now,
    ]
  );

  return {
    id,
    pattern: data.pattern,
    comboId: data.comboId,
    priority: data.priority ?? 0,
    enabled: data.enabled !== false,
    description: data.description || "",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update an existing model-combo mapping.
 */
export async function updateModelComboMapping(
  id: string,
  data: UpdateModelComboMappingInput
): Promise<ModelComboMapping | null> {
  const existing = await getModelComboMappingById(id);
  if (!existing) return null;

  await db().execute(
    `UPDATE model_combo_mappings
        SET pattern = $1, combo_id = $2, priority = $3, enabled = $4,
            description = $5, updated_at = now()
      WHERE id = $6`,
    [
      data.pattern ?? existing.pattern,
      data.comboId ?? existing.comboId,
      data.priority ?? existing.priority,
      data.enabled !== undefined ? data.enabled : existing.enabled,
      data.description ?? existing.description,
      id,
    ]
  );

  return getModelComboMappingById(id);
}

/**
 * Delete a model-combo mapping.
 */
export async function deleteModelComboMapping(id: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM model_combo_mappings WHERE id = $1", [id]);
  return result.changes > 0;
}

/**
 * Check if a model string matches any enabled model-combo mapping.
 * Returns the full combo object if a match is found, null otherwise.
 *
 * Mappings are checked in priority order (highest first).
 * Uses glob-style pattern matching (* = any chars, ? = single char).
 */
export async function resolveComboForModel(
  modelStr: string
): Promise<Record<string, unknown> | null> {
  const rows = await db().query<{ pattern: string; combo_id: string; combo_data: unknown }>(
    `SELECT m.pattern, m.combo_id, c.data AS combo_data
       FROM model_combo_mappings m
       JOIN combos c ON c.id = m.combo_id
      WHERE m.enabled
      ORDER BY m.priority DESC, m.created_at ASC, m.id ASC`
  );

  for (const row of rows) {
    if (!globToRegex(row.pattern).test(modelStr)) continue;
    try {
      const raw = row.combo_data;
      const combo = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
      if (!combo || typeof combo !== "object" || combo.isActive === false) continue;
      return combo;
    } catch {
      // Corrupted combo data — skip
      continue;
    }
  }

  return null;
}

export const modelComboMappingRepository: ModelComboMappingRepository = {
  list: getModelComboMappings,
  findById: getModelComboMappingById,
  create: createModelComboMapping,
  update: updateModelComboMapping,
  deleteById: deleteModelComboMapping,
  resolveForModel: resolveComboForModel,
};
