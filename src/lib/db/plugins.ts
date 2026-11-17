/**
 * Plugin DB module — CRUD operations for the plugins table.
 *
 * `enabled` is derived (`status = 'active'`); the JSON columns are jsonb but are
 * returned as JSON text so `PluginRow` consumers keep parsing them as before.
 *
 * @module db/plugins
 */

import { db, jsonb } from "./pg";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("DB_PLUGINS");

// ── Types ──

export interface PluginRow {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  license: string;
  main: string;
  source: string;
  tags: string; // JSON array
  status: "installed" | "active" | "inactive" | "error";
  enabled: number; // 0 | 1 (derived: status = 'active')
  manifest: string; // JSON
  config: string; // JSON
  configSchema: string; // JSON
  hooks: string; // JSON array
  permissions: string; // JSON array
  pluginDir: string;
  errorMessage: string | null;
  installedAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

export interface PluginCreateInput {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  main: string;
  source?: string;
  tags?: string[];
  status?: PluginRow["status"];
  /** Ignored: `enabled` is derived from `status`. */
  enabled?: boolean;
  manifest: Record<string, unknown>;
  config?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  hooks?: string[];
  permissions?: string[];
  pluginDir: string;
}

// ── Helpers ──

const PLUGIN_SELECT = `SELECT id, name, version, description, author, license, main, source,
  tags::text AS tags, status, (status = 'active')::int AS enabled,
  manifest::text AS manifest, config::text AS config, config_schema::text AS config_schema,
  hooks::text AS hooks, permissions::text AS permissions, plugin_dir, error_message,
  installed_at, updated_at, activated_at
  FROM plugins`;

function rowToPlugin(row: any): PluginRow {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    author: row.author,
    license: row.license,
    main: row.main,
    source: row.source,
    tags: row.tags,
    status: row.status,
    enabled: Number(row.enabled),
    manifest: row.manifest,
    config: row.config,
    configSchema: row.config_schema,
    hooks: row.hooks,
    permissions: row.permissions,
    pluginDir: row.plugin_dir,
    errorMessage: row.error_message,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
  };
}

// ── CRUD ──

export async function insertPlugin(input: PluginCreateInput): Promise<PluginRow> {
  const now = new Date().toISOString();

  await db().execute(
    `INSERT INTO plugins (
      id, name, version, description, author, license, main, source, tags,
      status, manifest, config, config_schema, hooks, permissions,
      plugin_dir, installed_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb,
              $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18)`,
    [
      input.id,
      input.name,
      input.version,
      input.description ?? null,
      input.author ?? null,
      input.license ?? "MIT",
      input.main,
      input.source ?? "local",
      jsonb(input.tags ?? []),
      input.status ?? "installed",
      jsonb(input.manifest),
      jsonb(input.config ?? {}),
      jsonb(input.configSchema ?? {}),
      jsonb(input.hooks ?? []),
      jsonb(input.permissions ?? []),
      input.pluginDir,
      now,
      now,
    ]
  );

  log.info("plugin.inserted", { id: input.id, name: input.name });
  const plugin = await getPluginByName(input.name);
  if (!plugin) {
    throw new Error(`Failed to retrieve plugin '${input.name}' after insertion`);
  }
  return plugin;
}

export async function getPluginById(id: string): Promise<PluginRow | null> {
  const row = await db().queryOne(`${PLUGIN_SELECT} WHERE id = $1`, [id]);
  return row ? rowToPlugin(row) : null;
}

export async function getPluginByName(name: string): Promise<PluginRow | null> {
  const row = await db().queryOne(`${PLUGIN_SELECT} WHERE name = $1`, [name]);
  return row ? rowToPlugin(row) : null;
}

export async function listPlugins(status?: PluginRow["status"]): Promise<PluginRow[]> {
  const rows = status
    ? await db().query(`${PLUGIN_SELECT} WHERE status = $1 ORDER BY name`, [status])
    : await db().query(`${PLUGIN_SELECT} ORDER BY name`);
  return rows.map(rowToPlugin);
}

export async function updatePluginStatus(
  name: string,
  status: PluginRow["status"],
  errorMessage?: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const activatedAt = status === "active" ? now : null;

  // `activated_at` records the most-recent activation timestamp and is intentionally
  // preserved on deactivation via COALESCE (activatedAt is null when status != "active").
  // Callers should treat it as "last activated at", not "currently active since".
  const result = await db().execute(
    `UPDATE plugins SET status = $1, error_message = $2,
       updated_at = $3, activated_at = COALESCE($4::timestamptz, activated_at)
     WHERE name = $5`,
    [status, errorMessage ?? null, now, activatedAt, name]
  );

  if (result.changes > 0) {
    log.info("plugin.status_updated", { name, status });
  }
  return result.changes > 0;
}

/**
 * Refresh the persisted manifest snapshot (and the derived hooks list) for a plugin.
 *
 * The `manifest` column is a snapshot validated by the Zod schema of the OmniRoute
 * version that INSTALLED the plugin; when a later version adds a manifest field
 * (e.g. hooks.onStreamComplete, #11934), activate() re-reads plugin.json from disk
 * and calls this to bring the row up to date without requiring a version-bump upgrade.
 */
export async function updatePluginManifest(
  name: string,
  manifest: Record<string, unknown>,
  hooks: string[]
): Promise<boolean> {
  const result = await db().execute(
    `UPDATE plugins SET manifest = $1::jsonb, hooks = $2::jsonb, updated_at = now() WHERE name = $3`,
    [jsonb(manifest), jsonb(hooks), name]
  );

  if (result.changes > 0) {
    log.info("plugin.manifest_updated", { name });
  }
  return result.changes > 0;
}

export async function updatePluginConfig(
  name: string,
  config: Record<string, unknown>
): Promise<boolean> {
  const result = await db().execute(
    `UPDATE plugins SET config = $1::jsonb, updated_at = now() WHERE name = $2`,
    [jsonb(config), name]
  );
  return result.changes > 0;
}

export async function deletePlugin(name: string): Promise<boolean> {
  const result = await db().execute(`DELETE FROM plugins WHERE name = $1`, [name]);
  if (result.changes > 0) {
    log.info("plugin.deleted", { name });
  }
  return result.changes > 0;
}

export async function pluginExists(name: string): Promise<boolean> {
  const row = await db().queryOne(`SELECT 1 AS found FROM plugins WHERE name = $1`, [name]);
  return !!row;
}
