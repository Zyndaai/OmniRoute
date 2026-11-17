/**
 * Compliance Controls — T-43
 *
 * Implements compliance features:
 * - APP_LOG_RETENTION_DAYS / CALL_LOG_RETENTION_DAYS: automatic log cleanup
 * - noLog opt-out per API key
 * - audit_log table for administrative actions
 *
 * @module lib/compliance
 */

import { db } from "../db/pg";
import { jsonTextParam } from "../db/pgJsonText";
import { getClientIpFromRequest } from "../ipUtils";
import {
  getAppLogRetentionDays,
  getCallLogRetentionDays,
  getAppLogRetentionDaysOverride,
  getCallLogRetentionDaysOverride,
  getCallLogsTableMaxRows,
  getProxyLogsTableMaxRows,
} from "../logEnv";
import { getRetentionSettings } from "../db/retentionSettings";
import { dropLogPartitionsBefore } from "../db/logPartitions";
import { generateRequestId, getRequestId } from "@/shared/utils/requestId";
import { HIGH_LEVEL_ACTIONS } from "@/lib/audit/highLevelActions";

type AuditLogFilter = {
  action?: string;
  actor?: string;
  target?: string;
  resourceType?: string;
  status?: string;
  requestId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  /** When "high", restricts results to HIGH_LEVEL_ACTIONS only (B7). */
  levelFilter?: "high";
};

type AuditLogRow = Record<string, unknown> & {
  id?: number | null;
  action?: string | null;
  actor?: string | null;
  target?: string | null;
  status?: string | null;
  details?: unknown;
  metadata?: unknown;
  ip_address?: string | null;
  resource_type?: string | null;
  request_id?: string | null;
  timestamp?: string | null;
};

/**
 * Public shape of a normalized audit-log entry returned by `getAuditLog` /
 * `normalizeAuditLogRow`. Includes the column-level fields callers (and
 * tests) reach into directly — `action`, `actor`, `target`, `id`, `status`,
 * `timestamp` — alongside the derived/parsed fields. The
 * `Record<string, unknown>` intersection preserves the existing behaviour of
 * spreading any extra DB columns (e.g. schema additions) without losing
 * compile-time access to the known ones.
 */
export type AuditLogEntry = Record<string, unknown> & {
  id?: number | null;
  action?: string | null;
  actor?: string | null;
  target?: string | null;
  status: string | null;
  timestamp: string;
  createdAt: string;
  details: unknown;
  metadata: unknown;
  ip_address: string | null;
  ip: string | null;
  resource_type: string | null;
  resourceType: string | null;
  request_id: string | null;
  requestId: string | null;
};

const SENSITIVE_AUDIT_KEYS = new Set([
  "apikey",
  "extraapikeys",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "jwttoken",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "setcookie",
  "consoleapikey",
  "clientsecret",
]);

function normalizeAuditKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveAuditKey(key: string) {
  const normalized = normalizeAuditKey(key);
  if (!normalized) return false;
  if (SENSITIVE_AUDIT_KEYS.has(normalized)) return true;
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        isSensitiveAuditKey(key) ? "[redacted]" : sanitizeAuditValue(nestedValue),
      ])
    );
  }

  return value;
}

/**
 * jsonb parameter for `details` / `metadata`: the redacted value as JSON. A plain string
 * is kept as a JSON string (read back as the same string); U+0000 is stripped.
 */
function serializeAuditValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const sanitizedValue = sanitizeAuditValue(value);
  try {
    return jsonTextParam(JSON.stringify(sanitizedValue));
  } catch {
    return jsonTextParam(JSON.stringify(String(sanitizedValue)));
  }
}

function parseAuditValue(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

type AuditLogQuery = {
  where: string;
  params: unknown[];
};

function buildAuditLogQuery(filter: AuditLogFilter = {}): AuditLogQuery {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // SQLite's LIKE ignored ASCII case; ILIKE keeps these filters behaving the same.
  const addLikeFilter = (column: string, value?: string) => {
    if (!value) return;
    conditions.push(`${column} ILIKE ${bind(`%${value}%`)}`);
  };

  addLikeFilter("action", filter.action);
  addLikeFilter("actor", filter.actor);
  addLikeFilter("target", filter.target);
  addLikeFilter("resource_type", filter.resourceType);
  addLikeFilter("status", filter.status);
  addLikeFilter("request_id", filter.requestId);

  const from = filter.from ? new Date(filter.from) : null;
  if (from && !Number.isNaN(from.getTime())) {
    conditions.push(`"timestamp" >= ${bind(from.toISOString())}`);
  }
  const to = filter.to ? new Date(filter.to) : null;
  if (to && !Number.isNaN(to.getTime())) {
    conditions.push(`"timestamp" <= ${bind(to.toISOString())}`);
  }

  // B7: level=high filter — restrict to HIGH_LEVEL_ACTIONS only
  if (filter.levelFilter === "high" && HIGH_LEVEL_ACTIONS.length > 0) {
    // HIGH_LEVEL_ACTIONS is readonly — create a mutable copy for the array parameter
    conditions.push(`action = ANY(${bind(Array.from(HIGH_LEVEL_ACTIONS))}::text[])`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function normalizeAuditLogRow(row: AuditLogRow): AuditLogEntry {
  const details = parseAuditValue(row.details);
  const metadata = parseAuditValue(row.metadata);
  const resourceType = typeof row.resource_type === "string" ? row.resource_type : null;
  const requestId = typeof row.request_id === "string" ? row.request_id : null;
  const ip = typeof row.ip_address === "string" ? row.ip_address : null;
  const timestamp = typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString();

  return {
    ...(row as Record<string, unknown>),
    timestamp,
    createdAt: timestamp,
    details,
    metadata: metadata ?? (details && typeof details === "object" ? details : null),
    ip_address: ip,
    ip,
    resource_type: resourceType,
    resourceType,
    request_id: requestId,
    requestId,
    status: typeof row.status === "string" ? row.status : null,
  };
}

export function getAuditRequestContext(request?: {
  headers?: Headers | { get?: (name: string) => string | null };
  socket?: { remoteAddress?: string };
  ip?: string;
}) {
  return {
    ipAddress: request ? getClientIpFromRequest(request) : null,
    requestId: getRequestId() || request?.headers?.get?.("x-request-id") || generateRequestId(),
  };
}

/**
 * The audit_log table is created by the schema migration; kept for callers that
 * initialise it at startup.
 */
export function initAuditLog() {
  /* nothing to do: the table and its indexes come with the migration */
}

/**
 * Log an administrative action.
 *
 * @param {Object} entry
 * @param {string} entry.action - Action type (e.g. "settings.update", "apiKey.create", "password.reset")
 * @param {string} [entry.actor="system"] - Who performed the action
 * @param {string} [entry.target] - What was affected
 * @param {Object|string} [entry.details] - Additional details
 * @param {string} [entry.ipAddress] - Client IP
 */
export async function logAuditEvent(entry: {
  action: string;
  actor?: string;
  target?: string;
  details?: unknown;
  metadata?: unknown;
  ipAddress?: string;
  resourceType?: string;
  status?: string;
  requestId?: string;
  createdAt?: string;
}): Promise<void> {
  try {
    const created = entry.createdAt ? new Date(entry.createdAt) : new Date();
    const createdAt = Number.isNaN(created.getTime()) ? new Date() : created;
    const serializedDetails = serializeAuditValue(entry.details ?? entry.metadata);
    const metadataSource =
      entry.metadata !== undefined
        ? entry.metadata
        : entry.details && typeof entry.details === "object"
          ? entry.details
          : null;
    await db().execute(
      `INSERT INTO audit_log (
        "timestamp",
        action,
        actor,
        target,
        details,
        ip_address,
        resource_type,
        status,
        request_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        createdAt.toISOString(),
        entry.action,
        entry.actor || "system",
        entry.target || null,
        serializedDetails,
        entry.ipAddress || null,
        entry.resourceType || null,
        entry.status || null,
        entry.requestId || null,
        serializeAuditValue(metadataSource),
      ]
    );
  } catch {
    // Silently fail — audit logging should never break the main flow
  }
}

/**
 * Query audit log entries.
 *
 * @param {Object} [filter={}]
 * @param {string} [filter.action] - Filter by action type
 * @param {string} [filter.actor] - Filter by actor
 * @param {number} [filter.limit=100] - Max results
 * @param {number} [filter.offset=0] - Pagination offset
 * @returns {Array<{ id: number, timestamp: string, action: string, actor: string, target: string, details: any, ip_address: string }>}
 */
export async function getAuditLog(filter: AuditLogFilter = {}): Promise<AuditLogEntry[]> {
  const { where, params } = buildAuditLogQuery(filter);
  const limit = Number.isFinite(filter.limit)
    ? Math.max(1, Math.min(500, filter.limit || 100))
    : 100;
  const offset = Number.isFinite(filter.offset) ? Math.max(0, filter.offset || 0) : 0;

  try {
    const rows = await db().query<AuditLogRow>(
      `SELECT * FROM audit_log ${where} ORDER BY "timestamp" DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return rows.map((row) => normalizeAuditLogRow(row));
  } catch {
    return [];
  }
}

export async function countAuditLog(filter: AuditLogFilter = {}): Promise<number> {
  const { where, params } = buildAuditLogQuery(filter);
  try {
    const row = await db().queryOne<{ count?: number }>(
      `SELECT COUNT(*) as count FROM audit_log ${where}`,
      params
    );
    return Number(row?.count || 0);
  } catch {
    return 0;
  }
}

// ─── No-Log Opt-Out ────────────────
// Moved to ./noLog.ts to break the callLogs → compliance → callLogs ESM cycle
// that deadlocks the bundled MCP server under Node.js 24 (#2650). Re-exported
// here so downstream callers that import from "../compliance" keep working.
export { isNoLog, setNoLog } from "./noLog";

// ─── Log Retention / Cleanup ────────────────

/**
 * Get the configured retention periods.
 */
export function getRetentionDays() {
  return {
    app: getAppLogRetentionDays(),
    call: getCallLogRetentionDays(),
  };
}

/**
 * Clean up logs using split APP/CALL retention windows.
 * Should be called periodically (e.g. daily cron or on startup).
 *
 * `usage_history`, `call_logs` and `proxy_logs` are day-partitioned: their retention drops
 * whole UTC days (rounded down to the day boundary of the cutoff).
 *
 * @returns {{
 *   deletedUsage: number,
 *   deletedCallLogs: number,
 *   deletedProxyLogs: number,
 *   deletedRequestDetailLogs: number,
 *   deletedAuditLogs: number,
 *   deletedMcpAuditLogs: number,
 *   trimmedCallLogs: number,
 *   trimmedProxyLogs: number,
 *   appRetentionDays: number,
 *   callRetentionDays: number,
 *   callLogsMaxRows: number,
 *   proxyLogsMaxRows: number
 * }}
 */
export async function cleanupExpiredLogs() {
  const appRetentionDays = getAppLogRetentionDays();
  const callRetentionDays = getCallLogRetentionDays();
  const callLogsMaxRows = getCallLogsTableMaxRows();
  const proxyLogsMaxRows = getProxyLogsTableMaxRows();

  // #4354: retention precedence is explicit env override > dashboard DB setting > 7-day
  // default. Previously this path always used the env default (7d), silently overriding a
  // configured dashboard "Data Retention" (e.g. 90d) on every startup and trimming
  // usage_history before the dashboard-based runAutoCleanup() could run. We now honor the
  // dashboard retention per table when the operator did not set the env var, while still
  // letting an explicit env var win (and falling back to env for non-DB deployments).
  // NOTE (#16302): this startup pass reads the MERGED settings (the shipped defaults fill
  // in unsaved keys), whereas the periodic request-log rotation resolves through
  // resolveCallLogRetentionDays() (src/lib/usage/callLogRetention.ts), which honors only
  // the dashboard keys the operator actually persisted and otherwise falls back to the env
  // variable / 7 days. Both share the env-override-first precedence; they differ only when
  // nothing was saved in the dashboard. Keep this in mind before tightening either side.
  const callOverride = getCallLogRetentionDaysOverride();
  const appOverride = getAppLogRetentionDaysOverride();
  let dbRetention: { usageHistory: number; callLogs: number; mcpAudit: number } | null = null;
  try {
    const r = (await getRetentionSettings());
    dbRetention = { usageHistory: r.usageHistory, callLogs: r.callLogs, mcpAudit: r.mcpAudit };
  } catch {
    /* settings table unavailable (e.g. very early startup) — keep env fallback */
  }
  const usageHistoryRetentionDays = callOverride ?? dbRetention?.usageHistory ?? callRetentionDays;
  const callLogRetentionDays = callOverride ?? dbRetention?.callLogs ?? callRetentionDays;
  const mcpAuditRetentionDays = appOverride ?? dbRetention?.mcpAudit ?? appRetentionDays;

  const day = 24 * 60 * 60 * 1000;
  const usageCutoffDate = new Date(Date.now() - usageHistoryRetentionDays * day);
  const callCutoffDate = new Date(Date.now() - callLogRetentionDays * day);
  const appCutoff = new Date(Date.now() - appRetentionDays * day).toISOString();
  const mcpCutoff = new Date(Date.now() - mcpAuditRetentionDays * day).toISOString();

  let deletedUsage = 0;
  // Always 0: request_detail_logs no longer exists; kept so the result shape is stable.
  const deletedRequestDetailLogs = 0;
  let deletedCallLogs = 0;
  let deletedProxyLogs = 0;
  let deletedAuditLogs = 0;
  let deletedMcpAuditLogs = 0;
  let trimmedCallLogs = 0;
  let trimmedProxyLogs = 0;

  try {
    // Roll the days about to be dropped into daily_usage_summary first, like
    // cleanupUsageHistory: raw usage rows are never dropped unaggregated.
    const { rollupUsageHistoryBeforeDate } = await import("../usage/aggregateHistory");
    const rollup = await rollupUsageHistoryBeforeDate(usageCutoffDate.toISOString().slice(0, 10));
    if (rollup.errors === 0) {
      deletedUsage = (await dropLogPartitionsBefore("usage_history", usageCutoffDate)).deletedRows;
    }
  } catch {
    /* table may not exist */
  }

  try {
    deletedCallLogs = (await dropLogPartitionsBefore("call_logs", callCutoffDate)).deletedRows;
  } catch {
    /* table may not exist */
  }

  try {
    deletedProxyLogs = (await dropLogPartitionsBefore("proxy_logs", callCutoffDate)).deletedRows;
  } catch {
    /* table may not exist */
  }

  try {
    deletedAuditLogs = (
      await db().execute('DELETE FROM audit_log WHERE "timestamp" < $1', [appCutoff])
    ).changes;
  } catch {
    /* table may not exist */
  }

  try {
    deletedMcpAuditLogs = (
      await db().execute("DELETE FROM mcp_tool_audit WHERE created_at < $1", [mcpCutoff])
    ).changes;
  } catch {
    /* table may not exist */
  }

  // Enforce row count limits to prevent unbounded DB growth (batched to avoid long locks)
  const BATCH_SIZE = 5000;
  if (callLogsMaxRows > 0) {
    try {
      const { trimCallLogsToMaxRows } = await import("../usage/callLogs");
      const trimmed = await trimCallLogsToMaxRows(callLogsMaxRows);
      trimmedCallLogs = trimmed.deletedRows;
    } catch {
      /* best effort */
    }
  }

  if (proxyLogsMaxRows > 0) {
    try {
      const counted = await db().queryOne<{ cnt: number }>("SELECT COUNT(*) as cnt FROM proxy_logs");
      let remaining = Number(counted?.cnt ?? 0);
      while (remaining > proxyLogsMaxRows) {
        const toDelete = Math.min(remaining - proxyLogsMaxRows, BATCH_SIZE);
        // (id, "timestamp") pairs, oldest first: the delete prunes to their partitions.
        const keys = await db().query<{ id: string; timestamp: string }>(
          `SELECT id, "timestamp" FROM proxy_logs ORDER BY "timestamp" ASC LIMIT $1`,
          [toDelete]
        );
        if (keys.length === 0) break;
        const params: unknown[] = [];
        const tuples = keys.map((key) => {
          params.push(key.id, key.timestamp);
          return `($${params.length - 1}, $${params.length}::timestamptz)`;
        });
        const trimmed = await db().execute(
          `DELETE FROM proxy_logs WHERE (id, "timestamp") IN (${tuples.join(", ")})`,
          params
        );
        trimmedProxyLogs += trimmed.changes;
        remaining -= trimmed.changes;
        if (trimmed.changes === 0) break;
      }
    } catch {
      /* best effort */
    }
  }

  await logAuditEvent({
    action: "compliance.cleanup",
    actor: "system",
    target: "log-retention",
    resourceType: "maintenance",
    status: "success",
    details: {
      deletedUsage,
      deletedCallLogs,
      deletedProxyLogs,
      deletedRequestDetailLogs,
      deletedAuditLogs,
      deletedMcpAuditLogs,
      trimmedCallLogs,
      trimmedProxyLogs,
      appRetentionDays,
      callRetentionDays,
      callLogsMaxRows,
      proxyLogsMaxRows,
    },
  });

  return {
    deletedUsage,
    deletedCallLogs,
    deletedProxyLogs,
    deletedRequestDetailLogs,
    deletedAuditLogs,
    deletedMcpAuditLogs,
    trimmedCallLogs,
    trimmedProxyLogs,
    appRetentionDays,
    callRetentionDays,
    callLogsMaxRows,
    proxyLogsMaxRows,
  };
}
