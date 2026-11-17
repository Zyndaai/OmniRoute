/**
 * db/settings/lkgp.ts — Last Known Good Provider (LKGP) persistence (table `lkgp_pins`).
 */

import { db } from "../pg";

/**
 * Escape `LIKE` wildcards so a combo name containing `%` or `_` cannot
 * widen the prefix match into unrelated combos' pins.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function deleteLKGPRowsByComboName(comboName: string): Promise<string[]> {
  if (!comboName) return [];

  const prefix = `${comboName}:`;
  const rows = await db().query<{ pin_key: string }>(
    "DELETE FROM lkgp_pins WHERE pin_key LIKE $1 ESCAPE '\\' RETURNING pin_key",
    [`${escapeLikePattern(prefix)}%`]
  );
  return rows.map((row) => row.pin_key);
}

export interface LKGPRecord {
  provider: string;
  connectionId?: string;
}

export async function getLKGP(comboName: string, modelId: string): Promise<LKGPRecord | null> {
  const row = await db().queryOne<{ provider: string; connection_id: string | null }>(
    "SELECT provider, connection_id FROM lkgp_pins WHERE pin_key = $1",
    [`${comboName}:${modelId}`]
  );
  if (!row) return null;
  const record: LKGPRecord = { provider: row.provider };
  if (row.connection_id) record.connectionId = row.connection_id;
  return record;
}

export async function setLKGP(
  comboName: string,
  modelId: string,
  providerId: string,
  connectionId?: string
) {
  await db().execute(
    `INSERT INTO lkgp_pins (pin_key, provider, connection_id) VALUES ($1, $2, $3)
     ON CONFLICT (pin_key) DO UPDATE
       SET provider = EXCLUDED.provider, connection_id = EXCLUDED.connection_id, updated_at = now()`,
    [`${comboName}:${modelId}`, providerId, connectionId || null]
  );
}

export async function clearAllLKGP(): Promise<void> {
  await db().execute("DELETE FROM lkgp_pins");
}

/**
 * Delete one persisted LKGP pin after its target fails. `setLKGP` is only ever
 * called on success — nothing previously invalidated a pin once its provider
 * started failing, so a *separate* subsequent request kept re-selecting the
 * same just-failed provider via `applyStrategyOrdering.ts`'s LKGP reordering
 * (live incident: 3 consecutive requests all picked the same timed-out
 * opencode-zen/big-pickle target instead of failing over to another combo
 * model). Circuit breaker / model lockout deliberately don't react to this
 * failure class (request-scoped timeouts, see comboPredicates.ts), so nothing
 * else clears the stale pin.
 */
export async function clearLKGP(comboName: string, modelId: string): Promise<void> {
  const key = `${comboName}:${modelId}`;
  await db().execute("DELETE FROM lkgp_pins WHERE pin_key = $1", [key]);
  const { invalidateCachedLKGP } = await import("../readCache");
  invalidateCachedLKGP(key);
}

/**
 * Delete every persisted LKGP pin belonging to a combo. Pins are keyed by
 * `${comboName}:${modelId}`, so deleting a combo leaves its pins addressable by
 * a name that no longer resolves — `clearAllLKGP()` is too broad and
 * `clearLKGP()` needs a modelId the caller no longer knows. Combo delete paths
 * call this so the pins die with their combo instead of accumulating as
 * unreachable rows.
 */
export async function deleteLKGPByComboName(comboName: string): Promise<number> {
  const staleKeys = await deleteLKGPRowsByComboName(comboName);

  if (staleKeys.length === 0) return 0;

  const { invalidateCachedLKGP } = await import("../readCache");
  for (const key of staleKeys) {
    invalidateCachedLKGP(key);
  }

  return staleKeys.length;
}

/**
 * Delete persisted LKGP pins whose connectionId references a removed provider
 * connection (#8887). A pin persisted by `setLKGP()` carries the connection it
 * was learned from, so deleting that connection leaves the pin pointing at a
 * row that no longer exists; provider-connection delete paths call this so
 * the pin dies with its connection instead of becoming unbounded stale state.
 * Provider-level pins (no connection) are preserved.
 */
export async function deleteLKGPByConnectionIds(connectionIds: string[]): Promise<number> {
  if (connectionIds.length === 0) return 0;

  const deletedConnectionIds = [...new Set(connectionIds.filter(Boolean))];
  if (deletedConnectionIds.length === 0) return 0;

  const rows = await db().query<{ pin_key: string }>(
    "DELETE FROM lkgp_pins WHERE connection_id = ANY($1::text[]) RETURNING pin_key",
    [deletedConnectionIds]
  );
  if (rows.length === 0) return 0;

  const { invalidateCachedLKGP } = await import("../readCache");
  for (const row of rows) {
    invalidateCachedLKGP(row.pin_key);
  }

  return rows.length;
}
