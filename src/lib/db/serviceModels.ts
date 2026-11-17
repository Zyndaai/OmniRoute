/** Persists and retrieves the model list synced from embedded services (9router, etc.). */

import { db } from "./pg";
import { configJson, deleteConfigValue, getConfigValue } from "./configEntries";

const NAMESPACE = "serviceModels";

export interface ServiceModel {
  id: string;
  name?: string;
  object?: string;
  owned_by?: string;
  created?: number;
  available?: boolean;
  [key: string]: unknown;
}

export async function getServiceModels(tool: string): Promise<ServiceModel[]> {
  const value = await getConfigValue(NAMESPACE, tool);
  return Array.isArray(value) ? (value as ServiceModel[]) : [];
}

/**
 * Persist a new model list for a tool, with soft-delete pruning.
 *
 * Models present in the new payload are UPSERTed with `available: true`.
 * Models that were previously stored but are missing from the new payload
 * are marked `available: false` (not deleted — preserves history).
 */
export async function saveServiceModels(tool: string, models: ServiceModel[]): Promise<void> {
  const incomingIds = new Set(models.map((m) => m.id));
  const incomingWithFlag: ServiceModel[] = models.map((m) => ({ ...m, available: true }));

  await db().transaction(async (tx) => {
    // Serialise concurrent syncs of one tool: the merge below reads the stored list first.
    await tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", [`serviceModels:${tool}`]);
    const stored = await getConfigValue(NAMESPACE, tool, tx);
    const existing = Array.isArray(stored) ? (stored as ServiceModel[]) : [];
    const pruned: ServiceModel[] = existing
      .filter((m) => !incomingIds.has(m.id))
      .map((m) => ({ ...m, available: false }));
    const merged = [...incomingWithFlag, ...pruned];

    if (merged.length === 0) {
      await deleteConfigValue(NAMESPACE, tool, tx);
    } else {
      await tx.execute(
        `INSERT INTO config_entries (namespace, key, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [NAMESPACE, tool, configJson(merged)]
      );
    }
  });
}

/**
 * Mark all stored models for a tool as unavailable.
 * Called when the supervisor transitions to stopped or error state so the
 * model catalog reflects that none of the models are currently reachable.
 */
export async function markAllUnavailable(tool: string): Promise<void> {
  // One statement: no read-modify-write window. Non-array values are left untouched.
  await db().execute(
    `UPDATE config_entries
        SET value = (SELECT COALESCE(jsonb_agg(elem || '{"available": false}'::jsonb), '[]'::jsonb)
                       FROM jsonb_array_elements(value) AS elem),
            updated_at = now()
      WHERE namespace = $1 AND key = $2
        AND jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0`,
    [NAMESPACE, tool]
  );
}
