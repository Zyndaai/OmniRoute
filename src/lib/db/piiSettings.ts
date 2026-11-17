/**
 * db/piiSettings.ts — operator choices for PII masking.
 *
 * Stored in `config_entries` under the "pii_settings" namespace:
 *   enabledTypes   — JSON string[] of built-in type ids, or absent for "all types"
 *   customPatterns — JSON PiiCustomPattern[]
 *
 * These only shape WHAT gets masked. Whether masking runs at all is still the
 * opt-in PII_REDACTION_ENABLED / PII_RESPONSE_SANITIZATION flags (default off).
 *
 * The sanitizers read this on hot paths (per string leaf / per stream chunk),
 * so reads are cached for a short TTL; writers in this module invalidate it.
 * `peekPiiSettings` returns the cached value synchronously for code that cannot await.
 */

import type { PiiCustomPattern } from "@/shared/utils/piiCustomPatterns";
import { deleteConfigValue, getConfigEntries, setConfigValue } from "./configEntries";

const NAMESPACE = "pii_settings";
const KEY_ENABLED_TYPES = "enabledTypes";
const KEY_CUSTOM_PATTERNS = "customPatterns";
const CACHE_TTL_MS = 1000;

export interface PiiSettings {
  /** null = every built-in type (the pre-existing behaviour). */
  enabledTypes: string[] | null;
  customPatterns: PiiCustomPattern[];
}

let cache: { value: PiiSettings; expiresAt: number } | null = null;

export function clearPiiSettingsCache(): void {
  cache = null;
}

/** The last loaded settings (even if past its TTL), or null before the first load. */
export function peekPiiSettings(): PiiSettings | null {
  return cache?.value ?? null;
}

async function readFromDb(): Promise<PiiSettings> {
  const rows = await getConfigEntries(NAMESPACE);
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const enabledRaw = byKey.get(KEY_ENABLED_TYPES);
  const customRaw = byKey.get(KEY_CUSTOM_PATTERNS);
  return {
    enabledTypes: Array.isArray(enabledRaw)
      ? enabledRaw.filter((entry): entry is string => typeof entry === "string")
      : null,
    customPatterns: Array.isArray(customRaw)
      ? customRaw.filter(
          (entry): entry is PiiCustomPattern =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as PiiCustomPattern).pattern === "string"
        )
      : [],
  };
}

export async function getPiiSettings(): Promise<PiiSettings> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const value = await readFromDb();
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export async function setPiiSettings(update: {
  enabledTypes?: string[] | null;
  customPatterns?: PiiCustomPattern[];
}): Promise<PiiSettings> {
  if (update.enabledTypes === null) {
    await deleteConfigValue(NAMESPACE, KEY_ENABLED_TYPES);
  } else if (update.enabledTypes !== undefined) {
    await setConfigValue(NAMESPACE, KEY_ENABLED_TYPES, update.enabledTypes);
  }
  if (update.customPatterns !== undefined) {
    await setConfigValue(NAMESPACE, KEY_CUSTOM_PATTERNS, update.customPatterns);
  }
  clearPiiSettingsCache();
  return getPiiSettings();
}
