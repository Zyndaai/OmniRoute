import type { DbExecutor } from "@/lib/db/pg";
import { resolveProviderId } from "@/shared/constants/providers";
import type { UsageEntry } from "../usageHistory";

/**
 * Look up and backfill a legacy natural-key duplicate inside the caller's transaction.
 * `timestamp` must already be a normalised ISO string: it is the partition key, so the
 * lookup and the backfill UPDATEs touch exactly one `usage_history` partition.
 */
export async function backfillDuplicateUsageEntry(
  tx: DbExecutor,
  entry: UsageEntry,
  timestamp: string,
  tokensInput: number,
  tokensOutput: number
): Promise<boolean> {
  const existing = await tx.queryOne<{
    id: number;
    endpoint: string | null;
    cpa_auth_index: string | null;
  }>(
    `SELECT id, endpoint, cpa_auth_index FROM usage_history
     WHERE "timestamp" = $1
       AND COALESCE(provider, '')      = COALESCE($2::text, '')
       AND COALESCE(model, '')         = COALESCE($3::text, '')
       AND COALESCE(connection_id, '') = COALESCE($4::text, '')
       AND COALESCE(api_key_id, '')    = COALESCE($5::text, '')
       AND tokens_input  = $6
       AND tokens_output = $7
     ORDER BY id DESC LIMIT 1`,
    [
      timestamp,
      entry.provider ? resolveProviderId(entry.provider) : null,
      entry.model || null,
      entry.connectionId || null,
      entry.apiKeyId || null,
      tokensInput,
      tokensOutput,
    ]
  );

  if (!existing) return false;
  // Back-fill endpoint if the original row missed it.
  if (!existing.endpoint && entry.endpoint) {
    await tx.execute(
      `UPDATE usage_history SET endpoint = $1 WHERE id = $2 AND "timestamp" = $3`,
      [entry.endpoint, existing.id, timestamp]
    );
  }
  // A later completed attempt can carry the trace the first write missed.
  if (!existing.cpa_auth_index && entry.cpaAuthIndex) {
    await tx.execute(
      `UPDATE usage_history SET cpa_auth_index = $1 WHERE id = $2 AND "timestamp" = $3`,
      [entry.cpaAuthIndex, existing.id, timestamp]
    );
  }
  return true;
}
