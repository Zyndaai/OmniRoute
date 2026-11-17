/**
 * Typed access to `config_entries` (namespace, key, value jsonb), the home of the old
 * SQLite `key_value` namespaces. Values arrive parsed; raw-string namespaces
 * (feature_flags, ccDiscoveryAliases, ...) hold JSON strings and use the text helpers.
 */

import { db, type DbExecutor } from "./pg";
import { jsonTextParam } from "./pgJsonText";

export type ConfigNamespace =
  | "settings"
  | "proxyConfig"
  | "secrets"
  | "ipFilter"
  | "feature_flags"
  | "pii_settings"
  | "provider_param_filters"
  | "interception_rules"
  | "compression"
  | "databaseSettings"
  | "ccDiscoveryAliases"
  | "functionalGatewayMirrors"
  | "obsidian"
  | "notion"
  | "sync"
  | "conductor"
  | "local_corpus"
  | "cliToolLastConfig"
  | "cliToolInitialConfig"
  | "serviceModels"
  | "antigravityCreditBalance"
  | "tier"
  | "job_state";

/** A jsonb parameter that is never SQL NULL (the column is NOT NULL); `undefined` stores JSON null. */
export function configJson(value: unknown): string {
  return jsonTextParam(JSON.stringify(value === undefined ? null : value)) ?? "null";
}

/** Every entry of a namespace, in key order. */
export async function getConfigEntries(
  namespace: ConfigNamespace,
  ex: DbExecutor = db()
): Promise<Array<{ key: string; value: unknown }>> {
  return ex.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM config_entries WHERE namespace = $1 ORDER BY key",
    [namespace]
  );
}

/** One value, or `undefined` when the key has no row. */
export async function getConfigValue<T = unknown>(
  namespace: ConfigNamespace,
  key: string,
  ex: DbExecutor = db()
): Promise<T | undefined> {
  const row = await ex.queryOne<{ value: T }>(
    "SELECT value FROM config_entries WHERE namespace = $1 AND key = $2",
    [namespace, key]
  );
  return row ? row.value : undefined;
}

export async function setConfigValue(
  namespace: ConfigNamespace,
  key: string,
  value: unknown,
  ex: DbExecutor = db()
): Promise<void> {
  await ex.execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [namespace, key, configJson(value)]
  );
}

/** Stores `value` as a JSON string (raw-text namespaces: feature_flags, ccDiscoveryAliases, ...). */
export async function setConfigText(
  namespace: ConfigNamespace,
  key: string,
  value: string,
  ex: DbExecutor = db()
): Promise<void> {
  await setConfigValue(namespace, key, String(value), ex);
}

/** Reads a raw-text entry (`value #>> '{}'`), or `undefined` when missing. */
export async function getConfigText(
  namespace: ConfigNamespace,
  key: string,
  ex: DbExecutor = db()
): Promise<string | undefined> {
  const row = await ex.queryOne<{ value: string | null }>(
    "SELECT value #>> '{}' AS value FROM config_entries WHERE namespace = $1 AND key = $2",
    [namespace, key]
  );
  return row?.value ?? undefined;
}

/** Every raw-text entry of a namespace as key -> string (non-string values are skipped). */
export async function getConfigTextEntries(
  namespace: ConfigNamespace,
  ex: DbExecutor = db()
): Promise<Array<{ key: string; value: string }>> {
  const rows = await ex.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM config_entries WHERE namespace = $1 ORDER BY key",
    [namespace]
  );
  return rows.filter((r): r is { key: string; value: string } => typeof r.value === "string");
}

/**
 * Provider/model "on" | "off" overrides stored as `provider:<id>` / `model:<id>` keys
 * (ccDiscoveryAliases, functionalGatewayMirrors).
 */
export async function loadCatalogOverrideMaps(namespace: ConfigNamespace): Promise<{
  providers: Map<string, "on" | "off">;
  models: Map<string, "on" | "off">;
}> {
  const providers = new Map<string, "on" | "off">();
  const models = new Map<string, "on" | "off">();
  for (const row of await getConfigTextEntries(namespace)) {
    if (row.value !== "on" && row.value !== "off") continue;
    if (row.key.startsWith("provider:")) providers.set(row.key.slice("provider:".length), row.value);
    else if (row.key.startsWith("model:")) models.set(row.key.slice("model:".length), row.value);
  }
  return { providers, models };
}

export async function deleteConfigValue(
  namespace: ConfigNamespace,
  key: string,
  ex: DbExecutor = db()
): Promise<number> {
  const { changes } = await ex.execute(
    "DELETE FROM config_entries WHERE namespace = $1 AND key = $2",
    [namespace, key]
  );
  return changes;
}

export async function deleteConfigNamespace(
  namespace: ConfigNamespace,
  ex: DbExecutor = db()
): Promise<number> {
  const { changes } = await ex.execute("DELETE FROM config_entries WHERE namespace = $1", [
    namespace,
  ]);
  return changes;
}
