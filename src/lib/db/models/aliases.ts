/** db/models/aliases.ts — model alias CRUD (`model_aliases`) and provider-scoped aliases (`provider_model_catalog.provider_aliases`). */

import { db } from "../pg";
import { finishModelCatalogWriteWithoutBackup } from "./modelCatalogWriteSignals";
import { readCatalogColumn, updateCatalogColumn } from "./catalogRow";

export async function getModelAliases() {
  const rows = await db().query<{ alias: string; target: unknown }>(
    "SELECT alias, target FROM model_aliases"
  );
  const result: Record<string, unknown> = {};
  for (const row of rows) result[row.alias] = row.target;
  return result;
}

/** Upserts the alias target; an existing alias keeps its `managed` marker. */
export async function setModelAlias(alias: string, model: unknown) {
  await db().execute(
    `INSERT INTO model_aliases (alias, target) VALUES ($1, $2::jsonb)
     ON CONFLICT (alias) DO UPDATE SET target = EXCLUDED.target, updated_at = now()`,
    [alias, JSON.stringify(model ?? null)]
  );
  finishModelCatalogWriteWithoutBackup();
}

/** Deleting the row also drops its managed marker. */
export async function deleteModelAlias(alias: string) {
  await db().execute("DELETE FROM model_aliases WHERE alias = $1", [alias]);
  finishModelCatalogWriteWithoutBackup();
}

// ──────── Managed-alias provenance marker (#11836) ────────
// Distinguishes an alias OmniRoute itself generated during a provider model sync from one a
// person typed in the dashboard. Only aliases flagged `managed` are eligible for the
// sync's prune passes — resolveManagedModelAlias() and syncManagedAvailableModelAliases()
// must never delete or "adopt" an alias unless it is flagged, so a
// hand-created custom alias that happens to already point at a model's full id is never
// silently claimed (and later pruned) as if OmniRoute had generated it.

/**
 * The set of alias names OmniRoute has generated/adopted itself during a managed
 * provider model sync (OpenRouter + OpenAI/Anthropic-compatible custom providers).
 * Only these are eligible for sync-triggered pruning.
 */
export async function getManagedModelAliasNames(): Promise<Set<string>> {
  const rows = await db().query<{ alias: string }>(
    "SELECT alias FROM model_aliases WHERE managed"
  );
  return new Set(rows.map((row) => row.alias));
}

/**
 * Record that `alias` was generated/adopted by OmniRoute's own sync logic. The alias row
 * must already exist (call `setModelAlias` first); a name without a row is ignored.
 */
export async function markManagedModelAlias(alias: string): Promise<void> {
  await db().execute(
    "UPDATE model_aliases SET managed = true WHERE alias = $1 AND NOT managed",
    [alias]
  );
}

/** Clear the managed marker for `alias`. */
export async function unmarkManagedModelAlias(alias: string): Promise<void> {
  await db().execute(
    "UPDATE model_aliases SET managed = false WHERE alias = $1 AND managed",
    [alias]
  );
}

// ──────── Provider-scoped aliases (#9068) ────────
// These survive rediscovery: an alias in this column is never touched by
// model sync, and always resolves the same way regardless of upstream ID changes.

export type ProviderAliasMap = Record<string, string>; // alias → upstream model ID

function toAliasMap(value: unknown): ProviderAliasMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as ProviderAliasMap) }
    : {};
}

/**
 * Get the provider-scoped alias map for a given provider.
 * Returns `{}` when no aliases have been set.
 */
export async function getProviderAliases(providerId: string): Promise<ProviderAliasMap> {
  return toAliasMap(await readCatalogColumn("provider_aliases", providerId));
}

/**
 * Set a provider-scoped alias.
 */
export async function setProviderAlias(
  providerId: string,
  alias: string,
  upstreamModelId: string
): Promise<void> {
  await updateCatalogColumn("provider_aliases", providerId, (current) => {
    const map = toAliasMap(current);
    map[alias] = upstreamModelId;
    return { value: map, result: undefined };
  });
}

/**
 * Remove a provider-scoped alias.
 */
export async function removeProviderAlias(providerId: string, alias: string): Promise<void> {
  await updateCatalogColumn("provider_aliases", providerId, (current) => {
    const map = toAliasMap(current);
    if (!(alias in map)) return { skip: true, result: undefined };
    delete map[alias];
    return { value: map, result: undefined };
  });
}

/**
 * Cascade-delete every model-alias row that resolves to the given provider.
 *
 * Managed/imported aliases are stored as `alias = <alias>`, `target = "<providerId>/<model>"`
 * (e.g. `setModelAlias("x-fast", "providerX/fast-model")`). When a custom provider is
 * removed, its connections and node are deleted but these alias rows are left behind,
 * which then block re-importing the same provider ("already exists" / no new models) — see
 * #1409. This removes every alias whose stored value begins with `<providerId>/`, so a
 * fresh import is unblocked.
 *
 * Only string values starting with the exact `"<providerId>/"` prefix match, so unrelated
 * providers and user-facing settings aliases (whose value is the bare alias, not a
 * `<providerId>/<model>` string) are left untouched.
 *
 * @returns the list of alias keys that were removed.
 */
export async function deleteModelAliasesForProvider(providerId: string): Promise<string[]> {
  const prefix = `${providerId}/`;
  const rows = await db().query<{ alias: string }>(
    `DELETE FROM model_aliases
     WHERE jsonb_typeof(target) = 'string'
       AND left(target #>> '{}', char_length($1)) = $1
     RETURNING alias`,
    [prefix]
  );
  if (rows.length > 0) finishModelCatalogWriteWithoutBackup();
  return rows.map((row) => row.alias);
}
