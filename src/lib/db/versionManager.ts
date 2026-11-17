/** Version manager tool state persistence. */

import { db, jsonb, ts } from "./pg";
import { decrypt, encrypt } from "./encryption";

type VersionManagerRow = Record<string, unknown>;

/** jsonb arrives parsed; tolerate a JSON string. */
function parseConfigOverrides(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    if (parsed.trim() === "") return null;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function configOverridesParam(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return jsonb(value);
  } catch {
    return null;
  }
}

/** api_key / management_key are stored as `enc:v1` envelopes; callers use the plaintext. */
function encryptSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return encrypt(value) ?? value;
}

function decryptSecret(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return decrypt(value) ?? null;
}

interface VersionManagerTool {
  /** Always 0: the table's primary key is `tool`; kept so the shape is unchanged. */
  id: number;
  tool: string;
  currentVersion: string | null;
  installedVersion: string | null;
  pinnedVersion: string | null;
  binaryPath: string | null;
  status: string;
  pid: number | null;
  port: number;
  apiKey: string | null;
  managementKey: string | null;
  autoUpdate: boolean;
  autoStart: boolean;
  /**
   * When true, an adopted (unsupervised, pre-existing) process is
   * immediately killed and replaced with a fresh spawn this supervisor
   * actually owns — trading a brief restart for working log capture.
   * Defaults off: adoption alone is already the safe, non-disruptive choice.
   */
  autoRestartAdopted: boolean;
  lastHealthCheck: string | null;
  lastUpdateCheck: string | null;
  healthStatus: string;
  configOverrides: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  logsBufferPath: string | null;
  providerExpose: boolean;
  lastSyncAt: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rowToVersionManager(record: VersionManagerRow): VersionManagerTool {
  return {
    id: 0,
    tool: typeof record.tool === "string" ? record.tool : "",
    currentVersion: str(record.current_version),
    installedVersion: str(record.installed_version),
    pinnedVersion: str(record.pinned_version),
    binaryPath: str(record.binary_path),
    status: typeof record.status === "string" ? record.status : "not_installed",
    pid: typeof record.pid === "number" ? record.pid : null,
    port: typeof record.port === "number" ? record.port : 8317,
    apiKey: decryptSecret(record.api_key),
    managementKey: decryptSecret(record.management_key),
    autoUpdate: record.auto_update === true,
    autoStart: record.auto_start === true,
    autoRestartAdopted: record.auto_restart_adopted === true,
    lastHealthCheck: str(record.last_health_check),
    lastUpdateCheck: str(record.last_update_check),
    healthStatus: typeof record.health_status === "string" ? record.health_status : "unknown",
    configOverrides: parseConfigOverrides(record.config_overrides),
    errorMessage: str(record.error_message),
    createdAt: typeof record.created_at === "string" ? record.created_at : "",
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : "",
    logsBufferPath: str(record.logs_buffer_path),
    providerExpose: record.provider_expose === true,
    lastSyncAt: str(record.last_sync_at),
  };
}

export async function getVersionManagerStatus(): Promise<VersionManagerTool[]> {
  const rows = await db().query<VersionManagerRow>("SELECT * FROM version_manager ORDER BY tool");
  return rows.map(rowToVersionManager);
}

export async function getVersionManagerTool(tool: string): Promise<VersionManagerTool | null> {
  const row = await db().queryOne<VersionManagerRow>(
    "SELECT * FROM version_manager WHERE tool = $1",
    [tool]
  );
  return row ? rowToVersionManager(row) : null;
}

const DB_STATUSES = new Set(["not_installed", "installed", "running", "stopped", "error"]);
const DB_HEALTH_STATUSES = new Set(["unknown", "healthy", "unhealthy", "timeout"]);

/**
 * version_manager.status has a CHECK. The supervisor's transient states are kept in
 * memory only: "starting" is persisted as "running" (child spawned), "stopping" as
 * "stopped"; anything else unknown becomes "error".
 */
function toDbStatus(status: string): string {
  if (DB_STATUSES.has(status)) return status;
  if (status === "starting") return "running";
  if (status === "stopping") return "stopped";
  return "error";
}

function toDbHealthStatus(status: string): string {
  return DB_HEALTH_STATUSES.has(status) ? status : "unknown";
}

export async function upsertVersionManagerTool(data: {
  tool: string;
  currentVersion?: string | null;
  installedVersion?: string | null;
  pinnedVersion?: string | null;
  binaryPath?: string | null;
  status?: string;
  pid?: number | null;
  port?: number;
  apiKey?: string | null;
  managementKey?: string | null;
  autoUpdate?: boolean;
  autoStart?: boolean;
  healthStatus?: string;
  configOverrides?: Record<string, unknown> | null;
  errorMessage?: string | null;
}): Promise<VersionManagerTool> {
  const row = await db().queryOne<VersionManagerRow>(
    `INSERT INTO version_manager (
       tool, current_version, installed_version, pinned_version, binary_path,
       status, pid, port, api_key, management_key, auto_update, auto_start,
       health_status, config_overrides, error_message, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, now(), now())
     ON CONFLICT (tool) DO UPDATE SET
       current_version = EXCLUDED.current_version,
       installed_version = EXCLUDED.installed_version,
       pinned_version = EXCLUDED.pinned_version,
       binary_path = EXCLUDED.binary_path,
       status = EXCLUDED.status,
       pid = EXCLUDED.pid,
       port = EXCLUDED.port,
       api_key = EXCLUDED.api_key,
       management_key = EXCLUDED.management_key,
       auto_update = EXCLUDED.auto_update,
       auto_start = EXCLUDED.auto_start,
       health_status = EXCLUDED.health_status,
       config_overrides = EXCLUDED.config_overrides,
       error_message = EXCLUDED.error_message,
       updated_at = now()
     RETURNING *`,
    [
      data.tool,
      data.currentVersion ?? null,
      data.installedVersion ?? null,
      data.pinnedVersion ?? null,
      data.binaryPath ?? null,
      toDbStatus(data.status ?? "not_installed"),
      data.pid == null ? null : Math.round(data.pid),
      Math.round(data.port ?? 8317),
      encryptSecret(data.apiKey),
      encryptSecret(data.managementKey),
      data.autoUpdate !== undefined ? data.autoUpdate : true,
      data.autoStart !== undefined ? data.autoStart : false,
      toDbHealthStatus(data.healthStatus ?? "unknown"),
      configOverridesParam(data.configOverrides),
      data.errorMessage ?? null,
    ]
  );
  if (!row) throw new Error("Failed to retrieve inserted version manager tool");
  return rowToVersionManager(row);
}

/** camelCase update key -> column. Anything not listed is ignored. */
const UPDATE_COLUMNS: Record<string, string> = {
  currentVersion: "current_version",
  installedVersion: "installed_version",
  pinnedVersion: "pinned_version",
  binaryPath: "binary_path",
  status: "status",
  pid: "pid",
  port: "port",
  apiKey: "api_key",
  managementKey: "management_key",
  autoUpdate: "auto_update",
  autoStart: "auto_start",
  autoRestartAdopted: "auto_restart_adopted",
  healthStatus: "health_status",
  configOverrides: "config_overrides",
  errorMessage: "error_message",
  logsBufferPath: "logs_buffer_path",
  providerExpose: "provider_expose",
  lastSyncAt: "last_sync_at",
};

const BOOLEAN_KEYS = new Set(["autoUpdate", "autoStart", "autoRestartAdopted", "providerExpose"]);
const INTEGER_KEYS = new Set(["pid", "port"]);
const SECRET_KEYS = new Set(["apiKey", "managementKey"]);

export async function updateVersionManagerTool(
  tool: string,
  updates: Record<string, unknown>
): Promise<VersionManagerTool | null> {
  // Column names come from UPDATE_COLUMNS only; every value is bound.
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [tool];

  for (const [key, value] of Object.entries(updates)) {
    const column = UPDATE_COLUMNS[key];
    if (!column) continue;

    let bound: unknown;
    let cast = "";
    if (key === "configOverrides") {
      bound = configOverridesParam(value as Record<string, unknown> | null);
      cast = "::jsonb";
    } else if (BOOLEAN_KEYS.has(key)) {
      bound = value === true;
    } else if (key === "status") {
      bound = toDbStatus(String(value ?? "not_installed"));
    } else if (key === "healthStatus") {
      bound = toDbHealthStatus(String(value ?? "unknown"));
    } else if (value === null || value === undefined) {
      bound = null;
    } else if (SECRET_KEYS.has(key)) {
      bound = encryptSecret(String(value));
    } else if (INTEGER_KEYS.has(key)) {
      bound = Math.round(Number(value));
    } else if (key === "lastSyncAt") {
      bound = ts(value as string | number | Date);
      cast = "::timestamptz";
    } else {
      bound = value;
    }
    params.push(bound);
    sets.push(`${column} = $${params.length}${cast}`);
  }

  const row = await db().queryOne<VersionManagerRow>(
    `UPDATE version_manager SET ${sets.join(", ")} WHERE tool = $1 RETURNING *`,
    params
  );
  return row ? rowToVersionManager(row) : null;
}

export async function deleteVersionManagerTool(tool: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM version_manager WHERE tool = $1", [tool]);
  return result.changes > 0;
}

export async function updateToolHealth(tool: string, healthStatus: string): Promise<boolean> {
  const result = await db().execute(
    "UPDATE version_manager SET health_status = $1, last_health_check = now(), updated_at = now() WHERE tool = $2",
    [toDbHealthStatus(healthStatus), tool]
  );
  return result.changes > 0;
}

export async function updateToolVersion(
  tool: string,
  field: "current_version" | "installed_version",
  version: string
): Promise<boolean> {
  if (field !== "current_version" && field !== "installed_version") {
    throw new Error(`updateToolVersion: field "${field}" is not allowed`);
  }
  const result = await db().execute(
    `UPDATE version_manager SET ${field} = $1, updated_at = now() WHERE tool = $2`,
    [version, tool]
  );
  return result.changes > 0;
}

export async function setToolStatus(
  tool: string,
  status: string,
  pid?: number,
  errorMessage?: string
): Promise<boolean> {
  status = toDbStatus(status);
  const result =
    pid !== undefined
      ? await db().execute(
          "UPDATE version_manager SET status = $1, pid = $2, error_message = $3, updated_at = now() WHERE tool = $4",
          [status, Math.round(pid), errorMessage ?? null, tool]
        )
      : await db().execute(
          "UPDATE version_manager SET status = $1, error_message = $2, updated_at = now() WHERE tool = $3",
          [status, errorMessage ?? null, tool]
        );
  return result.changes > 0;
}

/** Typed alias for getVersionManagerTool — preferred entry point for embedded services. */
export async function getServiceRow(tool: string): Promise<VersionManagerTool | null> {
  return getVersionManagerTool(tool);
}

const SERVICE_FIELD_WHITELIST: Set<string> = new Set([
  "logsBufferPath",
  "providerExpose",
  "lastSyncAt",
  "status",
  "pid",
  "port",
  "apiKey",
  "autoStart",
  "autoRestartAdopted",
  "autoUpdate",
  "healthStatus",
  "errorMessage",
  "currentVersion",
  "installedVersion",
  "binaryPath",
]);

/** Single-field update for embedded services; whitelisted to prevent SQL injection. */
export async function updateServiceField(
  tool: string,
  field: string,
  value: unknown
): Promise<VersionManagerTool | null> {
  if (!SERVICE_FIELD_WHITELIST.has(field)) {
    throw new Error(`updateServiceField: field "${field}" is not in the allowed list`);
  }
  return updateVersionManagerTool(tool, { [field]: value });
}
