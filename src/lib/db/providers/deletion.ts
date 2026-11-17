/**
 * db/providers/deletion.ts — Provider connection deletion & reordering.
 *
 * Extracted from db/providers.ts (god-file shrink): the three provider
 * connection delete paths plus the connection reorder helper they share.
 * Each delete path also purges the rows that have no foreign key to the
 * connection (account-scoped proxy_assignments #9232, provider_quota_state,
 * auto_candidate_overrides) so orphans never keep routing to removed
 * connections. Rows with a foreign key (quota_snapshots, connection_limits_cache,
 * connection_runtime_state, ...) go with the connection by ON DELETE CASCADE.
 */

import { db, type DbExecutor } from "../pg";
import { cleanupComboConnectionRefs } from "../combos";
import { deleteLKGPByConnectionIds } from "../settings/lkgp";
import {
  removeConnectionHealth,
  removeConnectionIndex,
} from "@omniroute/open-sse/services/apiKeyRotator.ts";
import { invalidateDbCache } from "../readCache";
import { invalidateReasoningRoutingRuleCache } from "../reasoningRoutingRules";
import { bumpProxyConfigGeneration } from "../settings";
import { deleteSyncedAvailableModelsForProvider } from "../models/syncedAvailableModelPersistence";
import {
  deleteDiscoveryStatesForConnections,
  deleteDiscoveryStatesForProvider,
} from "../discoveryState";

// Tables that reference a connection id without a foreign key. The account-scoped
// proxy_assignments rows live in exactly one place (scope = 'account').
async function _deleteRowsWithoutForeignKey(tx: DbExecutor, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(
    "DELETE FROM proxy_assignments WHERE scope = 'account' AND scope_id = ANY($1::text[])",
    [ids]
  );
  await tx.execute("DELETE FROM provider_quota_state WHERE connection_id = ANY($1::text[])", [ids]);
  await tx.execute("DELETE FROM auto_candidate_overrides WHERE connection_id = ANY($1::text[])", [
    ids,
  ]);
}

async function _cleanupDeletedComboConnectionRefs(connectionIds: string | string[]): Promise<void> {
  try {
    await cleanupComboConnectionRefs(connectionIds);
  } catch (error) {
    console.error("Failed to clean up combo route refs for deleted connections:", error);
  }
}

async function _cleanupDeletedLKGPConnectionRefs(connectionIds: string | string[]): Promise<void> {
  const ids = Array.isArray(connectionIds) ? connectionIds : [connectionIds];
  if (ids.length === 0) return;

  try {
    await deleteLKGPByConnectionIds(ids);
  } catch (error) {
    console.error("Failed to clean up LKGP refs for deleted connections:", error);
  }
}

function _revokeNativeCodexTurnPins(connectionId: string): void {
  void import("@omniroute/open-sse/services/combo/nativeCodexTurnPin.ts")
    .then((module) => module.revokeNativeCodexTurnPinsForConnection(connectionId))
    .catch(() => {});
}

export async function deleteProviderConnection(id: string) {
  const deleted = await db().transaction(async (tx) => {
    const row = await tx.queryOne<{ provider: string }>(
      "DELETE FROM provider_connections WHERE id = $1 RETURNING provider",
      [id]
    );
    if (!row) return null;
    await _deleteRowsWithoutForeignKey(tx, [id]);
    return row;
  });
  if (!deleted) return false;

  // These two helpers touch disjoint tables (combos vs lkgp) and are safe to run concurrently.
  await Promise.all([
    _cleanupDeletedComboConnectionRefs(id),
    _cleanupDeletedLKGPConnectionRefs(id),
  ]);
  _revokeNativeCodexTurnPins(id);

  removeConnectionHealth(id);
  removeConnectionIndex(id);
  await bumpProxyConfigGeneration();
  const providerId = typeof deleted.provider === "string" ? deleted.provider : "";
  // The discovery outcome of the deleted connection goes with it: a stored
  // failure of a connection that no longer exists is a leftover.
  try {
    await deleteDiscoveryStatesForConnections([{ provider: providerId, id }]);
  } catch (error) {
    // Do not turn a leftover purge into a 500, but leave a trace: the stored
    // outcome of a connection that no longer exists stays behind.
    console.error("Failed to purge the stored discovery outcome of a deleted connection:", error);
  }
  await reorderConnections(db(), providerId);
  invalidateDbCache("connections"); // Bust connections read cache
  invalidateReasoningRoutingRuleCache();
  return true;
}

export async function deleteProviderConnections(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const deletedConnections = await db().transaction(async (tx) => {
    const rows = await tx.query<{ id: string; provider: string }>(
      "DELETE FROM provider_connections WHERE id = ANY($1::text[]) RETURNING id, provider",
      [ids]
    );
    await _deleteRowsWithoutForeignKey(
      tx,
      rows.map((row) => row.id)
    );
    return rows;
  });
  const deletedIds = deletedConnections.map((entry) => entry.id);

  await Promise.all([
    _cleanupDeletedComboConnectionRefs(deletedIds),
    _cleanupDeletedLKGPConnectionRefs(deletedIds),
  ]);

  // The discovery outcomes of the deleted connections go with them.
  try {
    await deleteDiscoveryStatesForConnections(deletedConnections);
  } catch (error) {
    // Do not turn a leftover purge into a 500, but leave a trace: the stored
    // outcomes of connections that no longer exist stay behind.
    console.error("Failed to purge the stored discovery outcomes of deleted connections:", error);
  }

  for (const id of ids) {
    removeConnectionHealth(id);
    removeConnectionIndex(id);
    _revokeNativeCodexTurnPins(id);
  }

  invalidateDbCache("connections");
  invalidateReasoningRoutingRuleCache();

  return deletedConnections.length;
}

export async function deleteProviderConnectionsByProvider(providerId: string) {
  const deletedIds = await db().transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      "DELETE FROM provider_connections WHERE provider = $1 RETURNING id",
      [providerId]
    );
    const ids = rows.map((row) => row.id);
    await _deleteRowsWithoutForeignKey(tx, ids);
    return ids;
  });

  await Promise.all([
    _cleanupDeletedComboConnectionRefs(deletedIds),
    _cleanupDeletedLKGPConnectionRefs(deletedIds),
  ]);

  for (const connectionId of deletedIds) {
    removeConnectionHealth(connectionId);
    removeConnectionIndex(connectionId);
    _revokeNativeCodexTurnPins(connectionId);
  }
  invalidateDbCache("connections");
  invalidateReasoningRoutingRuleCache();
  await bumpProxyConfigGeneration();
  try {
    await deleteSyncedAvailableModelsForProvider(providerId);
  } catch {
    // Rows are already gone. Do not turn a leftover purge into a 500.
  }
  try {
    await deleteDiscoveryStatesForProvider(providerId);
  } catch (error) {
    // Do not turn a leftover purge into a 500, but leave a trace: the stored
    // outcomes of a provider that no longer exists stay behind.
    console.error("Failed to purge the stored discovery outcomes of a deleted provider:", error);
  }
  return deletedIds.length;
}

export async function reorderProviderConnections(providerId: string) {
  await reorderConnections(db(), providerId);
}

/**
 * Renumbers a provider's connections 1..n in their current (priority, updated_at)
 * order, in one statement so a concurrent writer cannot interleave. Only rows
 * whose priority changes are touched.
 */
export async function reorderConnections(executor: DbExecutor, providerId: string): Promise<void> {
  await executor.execute(
    `UPDATE provider_connections AS pc
        SET priority = ranked.rank, updated_at = now()
       FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY priority ASC, updated_at DESC, id ASC)::integer AS rank
           FROM provider_connections
          WHERE provider = $1
       ) AS ranked
      WHERE pc.id = ranked.id AND pc.priority IS DISTINCT FROM ranked.rank`,
    [providerId]
  );
}
