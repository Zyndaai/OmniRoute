/** Canonical comparison and write helpers for connection-scoped synced model catalogs. */

import { isDeepStrictEqual } from "node:util";
import { db } from "../pg";
import { jsonValueParam } from "../pgJsonText";
import { invalidateModelCatalogCache } from "../readCache";

type ModelNormalizer<T> = (models: unknown) => T[];

// #11016: the Feature 5004 reconciler copies provider-declared windows
// (`inputTokenLimit`, captured at /models discovery) into `auto:discovery`
// overrides — the only source the REQUEST-TIME token-limit chain trusts for a
// freshly synced model that models.dev has not indexed yet. Before this, the
// reconcile ran only at startup + every 24h, so a model synced mid-cycle was
// enforced at the provider's static `defaultContextLength` (128K for
// OpenRouter) for up to a day even though the catalog advertised its real
// window (measured: `openrouter/stealth/ox-alpha` advertised 1,048,576,
// enforced 128,000). Run the reconcile opportunistically right after a synced
// catalog write changes, debounced + fire-and-forget so the sync request is
// never blocked (dynamic import: `contextWindowResolver` reads this module via
// `getAllSyncedAvailableModels`, so a static import would be circular).
let reconcileAfterSyncTimer: ReturnType<typeof setTimeout> | null = null;
const pendingReconcileProviders = new Set<string>();

// #18048: a real trailing debounce. The old `setTimeout(0)` ran one GLOBAL pass per
// changed write, so a 100-connection cycle chained many multi-second event-loop
// blocks. Now a burst collapses into one pass restricted to the touched providers.
export const POST_SYNC_RECONCILE_DEBOUNCE_MS = 5000;

function flushPostSyncReconcile(): void {
  reconcileAfterSyncTimer = null;
  const providers = Array.from(pendingReconcileProviders);
  pendingReconcileProviders.clear();
  if (providers.length === 0) return;
  void import("../../contextWindowResolver")
    .then((m) => m.runContextWindowReconcile({ providers }))
    .catch(() => {
      // Swallow — the periodic reconcile still runs; sync must never fail on it.
    });
}

export function scheduleReconcileAfterSyncWrite(
  providerId: string,
  debounceMs: number = POST_SYNC_RECONCILE_DEBOUNCE_MS
): void {
  pendingReconcileProviders.add(providerId);
  if (reconcileAfterSyncTimer) clearTimeout(reconcileAfterSyncTimer);
  reconcileAfterSyncTimer = setTimeout(flushPostSyncReconcile, debounceMs);
  reconcileAfterSyncTimer.unref?.();
}

/** Providers waiting for the next debounced post-sync reconcile (test hook). */
export function getPendingPostSyncReconcileProviders(): string[] {
  return Array.from(pendingReconcileProviders);
}

/** Cancel the pending post-sync reconcile and forget its providers (test hook). */
export function cancelPendingPostSyncReconcile(): void {
  if (reconcileAfterSyncTimer) clearTimeout(reconcileAfterSyncTimer);
  reconcileAfterSyncTimer = null;
  pendingReconcileProviders.clear();
}

type WindowCarrier = { id?: unknown; contextWindow?: unknown; inputTokenLimit?: unknown };

/** id→window signature: the only fields the context-window reconcile reads. */
function windowSignature(models: unknown[] | null): string {
  if (!models) return "";
  const entries: string[] = [];
  for (const m of models as WindowCarrier[]) {
    const w = m?.contextWindow ?? m?.inputTokenLimit;
    if (typeof w === "number") entries.push(`${String(m.id)}=${w}`);
  }
  return entries.sort().join("|");
}

export function finishSyncedAvailableModelsWrite(): void {
  invalidateModelCatalogCache();
}

/**
 * A `connection_model_sync` row also carries the discovery verdict, so clearing a model list
 * empties `models` instead of deleting the row. Rows left with no models and no verdict are
 * dropped here.
 */
export async function deleteEmptySyncRows(providerId: string): Promise<void> {
  await db().execute(
    `DELETE FROM connection_model_sync
     WHERE provider = $1 AND models = '[]'::jsonb AND discovery_status IS NULL`,
    [providerId]
  );
}

/** Empty one connection's synced model list. Returns 1 when a non-empty list was cleared. */
export async function clearConnectionSyncedModels(
  providerId: string,
  connectionId: string
): Promise<number> {
  const cleared = await db().execute(
    `UPDATE connection_model_sync SET models = '[]'::jsonb, updated_at = now()
     WHERE connection_id = $1 AND provider = $2 AND models <> '[]'::jsonb`,
    [connectionId, providerId]
  );
  if (cleared.changes > 0) await deleteEmptySyncRows(providerId);
  return cleared.changes;
}

/**
 * Delete all synced models for every connection belonging to a provider.
 * Returns the number of connection-scoped synced model lists removed.
 */
export async function deleteSyncedAvailableModelsForProvider(providerId: string): Promise<number> {
  const cleared = await db().execute(
    `UPDATE connection_model_sync SET models = '[]'::jsonb, updated_at = now()
     WHERE provider = $1 AND models <> '[]'::jsonb`,
    [providerId]
  );
  if (cleared.changes > 0) {
    await deleteEmptySyncRows(providerId);
    finishSyncedAvailableModelsWrite();
  }
  return cleared.changes;
}

/**
 * Write one connection's canonical model list. `key` is `<providerId>:<connectionId>`
 * (split at the first colon). Returns false when the stored list already equals it.
 */
export async function persistCanonicalSyncedAvailableModels<T>(
  key: string,
  normalizedModels: T[],
  normalizeModels: ModelNormalizer<T>
): Promise<boolean> {
  const sep = key.indexOf(":");
  const providerId = sep < 0 ? key : key.slice(0, sep);
  const connectionId = sep < 0 ? "" : key.slice(sep + 1);

  const outcome = await db().transaction(async (tx) => {
    const row = await tx.queryOne<{ models: unknown }>(
      "SELECT models FROM connection_model_sync WHERE connection_id = $1 FOR UPDATE",
      [connectionId]
    );
    const hasStored = row !== undefined && !(Array.isArray(row.models) && row.models.length === 0);
    let existingModels: T[] | null = null;
    if (hasStored) {
      try {
        existingModels = normalizeModels(row!.models);
      } catch {
        existingModels = null;
      }
    }

    const unchanged =
      (normalizedModels.length > 0 &&
        existingModels !== null &&
        // jsonb does not keep key order: compare structurally, not by serialized text.
        isDeepStrictEqual(existingModels, JSON.parse(JSON.stringify(normalizedModels)))) ||
      (normalizedModels.length === 0 && !hasStored);
    if (unchanged) return null;

    if (normalizedModels.length === 0) {
      await tx.execute(
        `UPDATE connection_model_sync SET models = '[]'::jsonb, updated_at = now()
         WHERE connection_id = $1`,
        [connectionId]
      );
      await tx.execute(
        `DELETE FROM connection_model_sync
         WHERE connection_id = $1 AND models = '[]'::jsonb AND discovery_status IS NULL`,
        [connectionId]
      );
    } else {
      // The row has a foreign key to its connection: a sync that finishes after its
      // connection was deleted has nowhere to land and is dropped instead of failing.
      await tx.execute(
        `INSERT INTO connection_model_sync (connection_id, provider, models)
         SELECT $1::text, $2::text, $3::jsonb
         WHERE EXISTS (SELECT 1 FROM provider_connections WHERE id = $1)
         ON CONFLICT (connection_id)
         DO UPDATE SET provider = EXCLUDED.provider, models = EXCLUDED.models, updated_at = now()`,
        [connectionId, providerId, jsonValueParam(normalizedModels)]
      );
    }
    return { existingModels };
  });
  if (!outcome) return false;

  finishSyncedAvailableModelsWrite();
  // Skip when no declared window changed: the reconcile would only re-scan for nothing.
  if (windowSignature(outcome.existingModels) !== windowSignature(normalizedModels)) {
    scheduleReconcileAfterSyncWrite(providerId);
  }
  return true;
}
