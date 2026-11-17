import { db } from "./pg";

/**
 * Reads a catalog on/off override namespace (`ccDiscoveryAliases`,
 * `functionalGatewayMirrors`) from `config_entries`. Values are stored as JSON strings
 * ("on" / "off"); anything else is ignored.
 */
export async function loadCatalogOverrides(namespace: string): Promise<{
  providers: Map<string, "on" | "off">;
  models: Map<string, "on" | "off">;
}> {
  const rows = await db().query<{ key: string; value: string | null }>(
    "SELECT key, value #>> '{}' AS value FROM config_entries WHERE namespace = $1",
    [namespace]
  );

  const providers = new Map<string, "on" | "off">();
  const models = new Map<string, "on" | "off">();

  for (const row of rows) {
    const setting = row.value === "on" || row.value === "off" ? row.value : null;
    if (setting === null) continue;
    if (row.key.startsWith("provider:")) {
      providers.set(row.key.slice("provider:".length), setting);
    } else if (row.key.startsWith("model:")) {
      models.set(row.key.slice("model:".length), setting);
    }
  }

  return { providers, models };
}
