/**
 * MCP Audit Logger — Records all MCP tool invocations for security and observability.
 *
 * Logs are written to the `mcp_tool_audit` PostgreSQL table through the shared
 * backend (`src/lib/db/pg.ts`); the MCP server process opens its own pool.
 * Input data is hashed (SHA-256) to avoid storing sensitive prompts.
 * Output is truncated to 200 chars for summary.
 */

import { hashInput, summarizeOutput } from "./schemas/audit.ts";
import { db } from "../../src/lib/db/pg.ts";
import { resolveMcpCallerApiKeyId } from "./mcpCallerIdentity.ts";

interface AuditStatsRow {
  total: unknown;
  successRate: unknown;
  avgDuration: unknown;
}

interface AuditTopToolRow {
  tool: unknown;
  count: unknown;
}

interface AuditCountRow {
  total: unknown;
}

interface AuditEntryRow {
  id?: unknown;
  tool_name?: unknown;
  input_hash?: unknown;
  output_summary?: unknown;
  duration_ms?: unknown;
  api_key_id?: unknown;
  success?: unknown;
  error_code?: unknown;
  created_at?: unknown;
}

export interface McpAuditQuery {
  limit?: number;
  offset?: number;
  tool?: string;
  success?: boolean;
  apiKeyId?: string;
}

export interface McpAuditEntry {
  id: number;
  toolName: string;
  inputHash: string;
  outputSummary: string;
  durationMs: number;
  apiKeyId: string | null;
  success: boolean;
  errorCode: string | null;
  createdAt: string;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  return fallback;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = toNumber(value, fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function mapAuditEntry(row: AuditEntryRow): McpAuditEntry {
  return {
    id: toPositiveInt(row.id, 0),
    toolName: toString(row.tool_name),
    inputHash: toString(row.input_hash),
    outputSummary: toString(row.output_summary),
    durationMs: toNumber(row.duration_ms, 0),
    apiKeyId: toNullableString(row.api_key_id),
    success: toBoolean(row.success, false),
    errorCode: toNullableString(row.error_code),
    createdAt: toString(row.created_at),
  };
}

function buildAuditFilterSql(filters: McpAuditQuery): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (typeof filters.tool === "string" && filters.tool.trim().length > 0) {
    params.push(filters.tool.trim());
    clauses.push(`tool_name = $${params.length}`);
  }
  if (typeof filters.success === "boolean") {
    params.push(filters.success);
    clauses.push(`success = $${params.length}`);
  }
  if (typeof filters.apiKeyId === "string" && filters.apiKeyId.trim().length > 0) {
    params.push(filters.apiKeyId.trim());
    clauses.push(`api_key_id = $${params.length}`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

let auditCallerIdResolverForTests: (() => Promise<string | undefined>) | null = null;
export function __setAuditCallerIdResolverForTests(
  resolver: (() => Promise<string | undefined>) | null
): void {
  auditCallerIdResolverForTests = resolver;
}

async function resolveAuditCallerId(): Promise<string | null> {
  const resolver = auditCallerIdResolverForTests ?? resolveMcpCallerApiKeyId;
  const raw = await resolver();
  return raw ? raw : null;
}

/**
 * The audit logger uses the shared PostgreSQL backend, so there is no dedicated handle
 * to close any more. Kept for the shutdown hooks that call it; always reports that
 * nothing was open.
 */
export function closeAuditDb(): boolean {
  return false;
}

// ============ Audit Logger ============

/**
 * Log a tool invocation to the mcp_tool_audit table.
 *
 * Security: Input is hashed, never stored in clear text.
 * Output is truncated to a summary.
 */
export async function logToolCall(
  toolName: string,
  input: unknown,
  output: unknown,
  durationMs: number,
  success: boolean,
  errorCode?: string
): Promise<void> {
  try {
    const inputHash = await hashInput(input);
    const outputSummary = summarizeOutput(output);
    const apiKeyId = await resolveAuditCallerId();

    await db().execute(
      `INSERT INTO mcp_tool_audit (tool_name, input_hash, output_summary, duration_ms, api_key_id, success, error_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        toolName,
        inputHash,
        // U+0000 is rejected by Postgres text; output summaries can carry upstream text.
        outputSummary === null || outputSummary === undefined
          ? null
          : String(outputSummary).replace(/\u0000/g, ""),
        Number.isFinite(durationMs) ? Math.round(durationMs) : null,
        apiKeyId,
        success,
        errorCode || null,
      ]
    );
  } catch (err: unknown) {
    // Never let audit failure break tool execution
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP Audit] Failed to log:", message);
  }
}

/**
 * Get recent audit entries (for dashboard/monitoring).
 */
export async function queryAuditEntries(
  filters: McpAuditQuery = {}
): Promise<{ entries: McpAuditEntry[]; total: number; limit: number; offset: number }> {
  try {
    const limit = Math.max(1, Math.min(500, toPositiveInt(filters.limit, 50)));
    const offset = Math.max(0, toPositiveInt(filters.offset, 0));

    const { whereSql, params } = buildAuditFilterSql(filters);
    const totalRow = await db().queryOne<AuditCountRow>(
      `SELECT COUNT(*) as total FROM mcp_tool_audit ${whereSql}`,
      params
    );
    const rows = await db().query<AuditEntryRow>(
      `SELECT
           id,
           tool_name,
           input_hash,
           output_summary,
           duration_ms,
           api_key_id,
           success,
           error_code,
           created_at
         FROM mcp_tool_audit
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return {
      entries: rows.map(mapAuditEntry),
      total: toPositiveInt(totalRow?.total, 0),
      limit,
      offset,
    };
  } catch {
    return { entries: [], total: 0, limit: 50, offset: 0 };
  }
}

/**
 * Backward compatible helper for existing callers.
 */
export async function getRecentAuditEntries(limit = 50): Promise<McpAuditEntry[]> {
  const result = await queryAuditEntries({ limit, offset: 0 });
  return result.entries;
}

/**
 * Get audit stats for monitoring.
 */
export async function getAuditStats(): Promise<{
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  topTools: Array<{ tool: string; count: number }>;
}> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stats = await db().queryOne<AuditStatsRow>(
      `SELECT
           COUNT(*) as total,
           AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as "successRate",
           AVG(duration_ms) as "avgDuration"
         FROM mcp_tool_audit
         WHERE created_at > $1`,
      [since]
    );

    const topTools = await db().query<AuditTopToolRow>(
      `SELECT tool_name as tool, COUNT(*) as count
         FROM mcp_tool_audit
         WHERE created_at > $1
         GROUP BY tool_name
         ORDER BY count DESC
         LIMIT 10`,
      [since]
    );

    return {
      totalCalls: toNumber(stats?.total, 0),
      successRate: toNumber(stats?.successRate, 0),
      avgDurationMs: toNumber(stats?.avgDuration, 0),
      topTools: (topTools || []).map((entry) => ({
        tool: toString(entry.tool),
        count: toNumber(entry.count, 0),
      })),
    };
  } catch {
    return { totalCalls: 0, successRate: 0, avgDurationMs: 0, topTools: [] };
  }
}
