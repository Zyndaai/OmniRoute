/**
 * Retention windows for the cleanup passes, read from `config_entries('databaseSettings',
 * 'retention.<name>')`. A key the operator never saved falls back to the shipped default, so
 * the answer never depends on a settings table being populated.
 *
 * @module lib/db/retentionSettings
 */

import { db } from "./pg";
import { DEFAULT_DATABASE_SETTINGS } from "@/types/databaseSettings";
import { getCallLogRetentionDays } from "../logEnv";

export type RetentionSettings = typeof DEFAULT_DATABASE_SETTINGS.retention;

const RETENTION_KEY_PREFIX = "retention.";

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Saved retention values merged over the defaults. */
export async function getRetentionSettings(): Promise<RetentionSettings> {
  const merged: Record<string, unknown> = { ...DEFAULT_DATABASE_SETTINGS.retention };
  const rows = await db().query<{ key: string; value: unknown }>(
    `SELECT key, value FROM config_entries
      WHERE namespace = 'databaseSettings' AND key LIKE 'retention.%'`
  );
  let savedCallLogs = false;
  for (const row of rows) {
    const name = row.key.slice(RETENTION_KEY_PREFIX.length);
    if (!(name in merged)) continue;
    const defaultValue = merged[name];
    if (typeof defaultValue === "boolean") {
      if (typeof row.value === "boolean") merged[name] = row.value;
    } else if (isPositiveNumber(row.value)) {
      merged[name] = row.value;
      if (name === "callLogs" && row.value > 0) savedCallLogs = true;
    }
  }
  // One effective call-log age for display, scheduled cleanup and request-log rotation
  // (resolveCallLogRetentionDays): an install that never saved one follows
  // CALL_LOG_RETENTION_DAYS, else 7 days, instead of the shipped 30 that rotation never
  // enforces. A value the operator saved still wins (#19435).
  if (!savedCallLogs) merged.callLogs = getCallLogRetentionDays();
  return merged as RetentionSettings;
}

/**
 * The dashboard-saved call-log retention without defaults applied, or null when the
 * operator never saved one.
 */
export async function getPersistedRetentionDays(
  name: keyof RetentionSettings
): Promise<number | null> {
  const row = await db().queryOne<{ value: unknown }>(
    `SELECT value FROM config_entries
      WHERE namespace = 'databaseSettings' AND key = $1`,
    [`${RETENTION_KEY_PREFIX}${String(name)}`]
  );
  // 0 is out of contract for a persisted call-log window; callers fall back to the default.
  return isPositiveNumber(row?.value) && row.value > 0 ? row.value : null;
}
