import type { DbExecutor } from "@/lib/db/pg";
import { deleteProxyById, updateProxy } from "../db/proxies";

/**
 * Subscription delete: a row the sync wrote is deleted (unchanged behavior); a
 * manual row the operator attached by id is detached instead, keeping its
 * identity, credentials and scope assignments.
 */
export async function detachOrDeleteSubscriptionRow(row: {
  id: string;
  source: string;
}): Promise<void> {
  if (row.source === "subscription") {
    await deleteProxyById(row.id, { force: true });
  } else {
    await updateProxy(row.id, { subscriptionId: null });
  }
}

/**
 * Delete registry rows of a subscription that are missing from the fetched
 * set. A caller that syncs a disabled subscription skips this step: the
 * refresh still upserts the fetched nodes as a preview, but attached rows the
 * feed omits stay in place until the subscription is enabled again.
 *
 * Only rows the sync itself wrote (`source = 'subscription'`) are candidates.
 * A manual row attached to the subscription by id is never in `keptIds` (the
 * sync only collects the rows it upserted), so without the source filter every
 * sync would detach it again.
 */
export async function removeStaleSubscriptionNodes(
  executor: DbExecutor,
  id: string,
  keptIds: string[]
): Promise<void> {
  const stale =
    keptIds.length > 0
      ? await executor.query<{ id: string }>(
          "SELECT id FROM proxy_registry WHERE subscription_id = $1 AND source = 'subscription' AND id <> ALL($2::text[])",
          [id, keptIds]
        )
      : await executor.query<{ id: string }>(
          "SELECT id FROM proxy_registry WHERE subscription_id = $1 AND source = 'subscription'",
          [id]
        );
  for (const r of stale) {
    try {
      await deleteProxyById(r.id, { force: true });
    } catch {
      // ignore
    }
  }
}
