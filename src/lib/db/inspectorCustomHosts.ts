/**
 * Database module: InspectorCustomHosts
 * CRUD operations for inspector_custom_hosts table.
 */

import { db } from "./pg";
import type { InspectorCustomHostRow } from "./_rowTypes.ts";

interface InspectorCustomHostDbRow {
  host: string;
  enabled: boolean;
  label: string | null;
  kind: string;
  added_at: string;
}

function mapRow(row: InspectorCustomHostDbRow): InspectorCustomHostRow {
  return {
    host: row.host,
    enabled: row.enabled === true,
    label: row.label,
    kind: row.kind as "llm" | "app" | "custom",
    added_at: row.added_at,
    // The column was dropped (never read); the row type still carries the field.
    last_seen_at: null,
  };
}

export async function listCustomHosts(opts?: {
  enabledOnly?: boolean;
}): Promise<InspectorCustomHostRow[]> {
  const enabledOnly = opts?.enabledOnly === true;
  const rows = await db().query<InspectorCustomHostDbRow>(
    enabledOnly
      ? `SELECT host, enabled, label, kind, added_at FROM inspector_custom_hosts WHERE enabled ORDER BY host ASC`
      : `SELECT host, enabled, label, kind, added_at FROM inspector_custom_hosts ORDER BY host ASC`
  );
  return rows.map(mapRow);
}

export async function addCustomHost(
  host: string,
  kind: "llm" | "app" | "custom" = "custom",
  label?: string
): Promise<void> {
  await db().execute(
    `INSERT INTO inspector_custom_hosts (host, enabled, label, kind, added_at)
     VALUES ($1, true, $2, $3, now())
     ON CONFLICT (host) DO NOTHING`,
    [host, label ?? null, kind]
  );
}

export async function removeCustomHost(host: string): Promise<void> {
  await db().execute(`DELETE FROM inspector_custom_hosts WHERE host = $1`, [host]);
}

export async function toggleCustomHost(host: string, enabled: boolean): Promise<void> {
  await db().execute(`UPDATE inspector_custom_hosts SET enabled = $1 WHERE host = $2`, [
    enabled,
    host,
  ]);
}

/** The `last_seen_at` column is gone (nothing read it); kept so callers need no change. */
export async function touchLastSeen(_host: string): Promise<void> {}

/**
 * Returns true when `host` is present in inspector_custom_hosts with enabled=true.
 * Used by agentBridgeHook to distinguish custom-host intercepts from agent-bridge
 * intercepts so that Mode 2 (Custom Hosts) entries appear in the "Custom" profile.
 */
export async function isCustomHost(host: string): Promise<boolean> {
  const row = await db().queryOne<{ found: number }>(
    `SELECT 1 AS found FROM inspector_custom_hosts WHERE host = $1 AND enabled`,
    [host]
  );
  return row !== undefined;
}
