/**
 * Compatibility facade for combo persistence.
 *
 * Application code keeps the existing function-level API while persistence is
 * delegated through the domain repository contract. Cross-cutting write effects
 * remain here instead of becoming part of the portable repository surface.
 */

import type { ComboRecord } from "@/domain/persistence/comboRepositories";
import { clearSessionModelHistoryForCombo } from "./contextHandoffs";
import { db, jsonb } from "./pg";
import { invalidateDbCache } from "./readCache";
import { invalidateReasoningRoutingRuleCache } from "./reasoningRoutingRules";
import { routingConfigRepositories } from "./repositories/routingConfigRepositories";

const repository = routingConfigRepositories.combos;

export function getCombos(limit?: number, offset?: number): Promise<ComboRecord[]> {
  return repository.list(limit, offset);
}

export function getCombosCount(): Promise<number> {
  return repository.count();
}

export function getComboById(id: string): Promise<ComboRecord | null> {
  return repository.findById(id);
}

export function getComboByName(name: string): Promise<ComboRecord | null> {
  return repository.findByName(name);
}

export function getComboByNameInsensitive(name: string): Promise<ComboRecord | null> {
  return repository.findByNameInsensitive(name);
}

export async function createCombo(data: ComboRecord): Promise<ComboRecord> {
  const combo = await repository.create(data);
  invalidateDbCache("combos");
  return combo;
}

export async function updateCombo(id: string, data: ComboRecord): Promise<ComboRecord | null> {
  const result = await repository.update(id, data);
  if (!result) return null;

  if (result.modelsFieldProvided) {
    const cleared = await clearSessionModelHistoryForCombo(result.previousName);
    if (cleared > 0 && result.currentName !== result.previousName) {
      await clearSessionModelHistoryForCombo(result.currentName);
    }
  }

  invalidateDbCache("combos");
  return result.combo;
}

export async function reorderCombos(comboIds: string[]): Promise<ComboRecord[]> {
  const result = await repository.reorder(comboIds);
  if (result.rowsReordered > 0) {
    invalidateDbCache("combos");
  }
  return result.combos;
}

export async function deleteCombo(id: string): Promise<boolean> {
  const deleted = await repository.deleteById(id);
  if (!deleted) return false;

  invalidateDbCache("combos");
  invalidateReasoningRoutingRuleCache();
  return true;
}

export async function deleteComboByName(name: string): Promise<boolean> {
  const combo = await repository.findByName(name);
  if (!combo || typeof combo.id !== "string") return false;
  return deleteCombo(combo.id);
}

export async function setActiveCombo(name: string): Promise<void> {
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('settings', 'activeCombo', $1::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [jsonb(name)]
  );
}

/**
 * Null out any combo model step whose connectionId matches a deleted connection.
 * Called after a provider connection is removed so combo routes don't carry
 * stale references.
 */
export async function cleanupComboConnectionRefs(connectionIds: string | string[]) {
  const deletedConnectionIds = new Set(
    (Array.isArray(connectionIds) ? connectionIds : [connectionIds]).filter(Boolean)
  );

  if (deletedConnectionIds.size === 0) return 0;

  const combos = await getCombos();
  let touched = 0;

  for (const combo of combos) {
    if (!Array.isArray(combo.models)) continue;

    let changed = false;

    const models = (combo.models as unknown as Record<string, unknown>[]).map((step) => {
      let out = step;

      if (typeof out.connectionId === "string" && deletedConnectionIds.has(out.connectionId)) {
        const { connectionId: _, ...rest } = out;
        out = rest;
        changed = true;
      }

      if (Array.isArray(out.allowedConnectionIds)) {
        const filtered = out.allowedConnectionIds.filter(
          (id) => typeof id !== "string" || !deletedConnectionIds.has(id)
        );

        if (filtered.length !== out.allowedConnectionIds.length) {
          out = {
            ...out,
            allowedConnectionIds: filtered,
          };
          changed = true;
        }
      }

      return out;
    });

    if (changed && typeof combo.id === "string") {
      try {
        const { id, ...rest } = combo;
        await updateCombo(combo.id, {
          ...rest,
          models,
        });
        touched++;
      } catch {
        // One combo failing should not block cleanup of the rest.
      }
    }
  }

  return touched;
}
