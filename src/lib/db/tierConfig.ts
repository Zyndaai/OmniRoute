import { db, jsonb } from "./pg";
import type { TierConfig } from "../../../open-sse/services/tierTypes";
import { validateTierConfig, DEFAULT_TIER_CONFIG } from "../../../open-sse/services/tierConfig";
import { defaultLogger as log } from "@omniroute/open-sse/utils/logger";

const NAMESPACE = "tier";
const KEY = "tier_config";
const CORRUPTED_VALUE_PREVIEW_LEN = 200;

/** The tier config lives in `config_entries` (namespace `tier`); nothing to create. */
export function initTierConfigTable(): void {}

export async function saveTierConfig(config: TierConfig): Promise<void> {
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [NAMESPACE, KEY, jsonb(config)]
  );
}

/**
 * Truncate an unknown value for safe inclusion in a log payload.
 * Returns the string verbatim when shorter than the cap, otherwise a
 * 200-char preview with an ellipsis.
 */
function previewCorruptedValue(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  if (text.length <= CORRUPTED_VALUE_PREVIEW_LEN) return text;
  return `${text.slice(0, CORRUPTED_VALUE_PREVIEW_LEN)}…`;
}

/**
 * Load the persisted tier config. Returns `null` when no row exists OR when the
 * stored value is unreadable (fails Zod validation).
 *
 * The function NEVER throws on a bad value — instead it logs a structured
 * warning so operators can spot the corruption in logs and either:
 *   1. Manually delete the bad row:
 *        DELETE FROM config_entries WHERE namespace = 'tier' AND key = 'tier_config';
 *   2. Re-save a clean config via the dashboard's Tier settings page.
 *
 * The caller (`loadTierConfig()`) then falls back to `DEFAULT_TIER_CONFIG`,
 * so a corrupted row never silently feeds invalid pricing into the router.
 */
export async function loadTierConfigFromDb(): Promise<TierConfig | null> {
  const row = await db().queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace = $1 AND key = $2",
    [NAMESPACE, KEY]
  );
  if (!row) return null;

  const raw = row.value;
  let parsed: unknown = raw;
  // A double-encoded value (a JSON string holding JSON) is read through once.
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(
        "TIER_CONFIG",
        "tier_config JSON.parse failed; falling back to DEFAULT_TIER_CONFIG",
        {
          err: err instanceof Error ? err.message : String(err),
          value: previewCorruptedValue(raw),
        }
      );
      return null;
    }
  }

  try {
    return validateTierConfig(parsed);
  } catch (err) {
    log.warn(
      "TIER_CONFIG",
      "tier_config Zod validation failed; falling back to DEFAULT_TIER_CONFIG",
      {
        err: err instanceof Error ? err.message : String(err),
        value: previewCorruptedValue(raw),
      }
    );
    return null;
  }
}

export async function loadTierConfig(): Promise<TierConfig> {
  return (await loadTierConfigFromDb()) || DEFAULT_TIER_CONFIG;
}
