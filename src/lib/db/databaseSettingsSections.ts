/**
 * Reads one section (`cache`, `retention`, `aggregation`, ...) of the user-facing
 * database settings straight from `config_entries('databaseSettings', ...)`.
 *
 * The transfer tool resolves the old four-source precedence once and stores the
 * effective values as `<section>.<name>` keys, so this reader needs no precedence
 * logic: defaults, then an optional whole-section object, then the dotted keys.
 * It exists so the usage and cache modules do not depend on the settings module.
 */
import { DEFAULT_DATABASE_SETTINGS, type DatabaseSettings } from "@/types/databaseSettings";
import { db } from "@/lib/db/pg";
import { decryptCacheSecrets } from "@/lib/db/cacheSecrets";

type UserSettings = Omit<DatabaseSettings, "location" | "stats">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function getDatabaseSettingsSection<S extends keyof UserSettings>(
  section: S
): Promise<UserSettings[S]> {
  const merged = structuredClone(DEFAULT_DATABASE_SETTINGS[section]) as Record<string, unknown>;
  const rows = await db().query<{ key: string; value: unknown }>(
    `SELECT key, value FROM config_entries
      WHERE namespace = 'databaseSettings' AND (key = $1 OR key LIKE $2)`,
    [section, `${section}.%`]
  );

  // The whole-section object first, so a dotted key written later always wins.
  for (const row of rows) {
    if (row.key === section && isRecord(row.value)) {
      for (const name of Object.keys(merged)) {
        if (row.value[name] !== undefined) merged[name] = row.value[name];
      }
    }
  }
  for (const row of rows) {
    if (!row.key.startsWith(`${section}.`)) continue;
    const name = row.key.slice(section.length + 1);
    if (name in merged) merged[name] = row.value;
  }

  if (section === "cache") decryptCacheSecrets(merged);
  return merged as UserSettings[S];
}
