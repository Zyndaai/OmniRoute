import { db } from "../pg";
import { encryptConnectionFields } from "../encryption";
import { invalidateDbCache } from "../readCache";
import { parseProviderSpecificData } from "../webSessionDedup";
import { jsonValueParam } from "../pgJsonText";

/**
 * Merge a patch into a connection's `provider_specific_data` WITHOUT dropping
 * the model catalog cache (`skipModelCatalog`, #13389) — the /v1/models
 * builder never reads account-state keys like `alibabaFreeDrainedModels`.
 * ONLY for non-structural patches on registry providers; a compatible node's
 * providerSpecificData can carry model lists and must go through
 * `updateProviderConnection()` so the catalog sees them.
 */
export async function mergeConnectionProviderSpecificData(
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  // The row is locked from the read to the write, so a concurrent merge (in this
  // process or another) cannot lose a key.
  const merged = await db().transaction(async (tx) => {
    const row = await tx.queryOne<{ provider_specific_data?: unknown }>(
      "SELECT provider_specific_data FROM provider_connections WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!row) return false;

    const existing = parseProviderSpecificData(row.provider_specific_data);
    const next = { ...existing, ...patch };
    // A patch carrying a declared secret field in plaintext (a quota fetcher refreshing
    // a console cookie, an executor minting a bearer) is enveloped exactly like a
    // full-row write; values already stored as envelopes are left as they are.
    const stored = encryptConnectionFields({ providerSpecificData: next }).providerSpecificData;
    await tx.execute(
      "UPDATE provider_connections SET provider_specific_data = $1, updated_at = now() WHERE id = $2",
      [jsonValueParam(stored), id]
    );
    return true;
  });
  if (merged) invalidateDbCache("connections", id, { skipModelCatalog: true });
}
