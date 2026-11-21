/**
 * CLI Tool State Persistence
 *
 * Stores last-configured timestamps and initial config snapshots
 * for CLI tools in `config_entries`.
 *
 * Namespaces:
 *   - cliToolLastConfig: ISO timestamp of last configuration
 *   - cliToolInitialConfig: JSON snapshot of pre-OmniRoute configuration
 *
 * @module lib/db/cliToolState
 */

import { db } from "./pg";
import { isCloud } from "./core";
import {
  configJson,
  deleteConfigValue,
  getConfigEntries,
  getConfigValue,
  setConfigValue,
} from "./configEntries";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// ──────────────── Last Configured Timestamp ────────────────

/**
 * Save last-configured timestamp for a CLI tool.
 */
export async function saveCliToolLastConfigured(
  toolId: string,
  timestamp: string = new Date().toISOString()
): Promise<void> {
  if (isCloud) return;
  await setConfigValue("cliToolLastConfig", toolId, timestamp);
}

/**
 * Get last-configured timestamp for a CLI tool.
 * @returns ISO timestamp string or null if never configured.
 */
export async function getCliToolLastConfigured(toolId: string): Promise<string | null> {
  if (isCloud) return null;
  const value = await getConfigValue("cliToolLastConfig", toolId);
  return typeof value === "string" ? value : null;
}

/**
 * Get all CLI tool last-configured timestamps.
 * @returns Record<toolId, ISO timestamp>
 */
export async function getAllCliToolLastConfigured(): Promise<Record<string, string>> {
  if (isCloud) return {};
  const result: Record<string, string> = {};
  for (const row of await getConfigEntries("cliToolLastConfig")) {
    if (typeof row.value === "string") result[row.key] = row.value;
  }
  return result;
}

/**
 * Delete last-configured timestamp for a CLI tool.
 */
export async function deleteCliToolLastConfigured(toolId: string): Promise<void> {
  if (isCloud) return;
  await deleteConfigValue("cliToolLastConfig", toolId);
}

// ──────────────── Initial Config Snapshot ────────────────

/**
 * Save the initial (pre-OmniRoute) config snapshot for a CLI tool.
 * Only saves if no snapshot exists yet (first-time only).
 * @returns true if saved, false if snapshot already exists.
 */
export async function saveCliToolInitialConfig(
  toolId: string,
  config: JsonRecord
): Promise<boolean> {
  if (isCloud) return false;
  const { changes } = await db().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('cliToolInitialConfig', $1, $2::jsonb)
     ON CONFLICT (namespace, key) DO NOTHING`,
    [toolId, configJson(config)]
  );
  return changes > 0;
}

/**
 * Get the initial config snapshot for a CLI tool.
 * @returns Config object or null if no snapshot exists.
 */
export async function getCliToolInitialConfig(toolId: string): Promise<JsonRecord | null> {
  if (isCloud) return null;
  return toRecord(await getConfigValue("cliToolInitialConfig", toolId));
}

/**
 * Delete the initial config snapshot for a CLI tool.
 */
export async function deleteCliToolInitialConfig(toolId: string): Promise<void> {
  if (isCloud) return;
  await deleteConfigValue("cliToolInitialConfig", toolId);
}
