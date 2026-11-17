/**
 * db/providers/nodes.ts — Provider nodes CRUD.
 */

import { v4 as uuidv4 } from "uuid";
import { db, jsonb } from "../pg";
import { rowToCamel } from "../caseMapping";
import { selectProviderNodeForConnection } from "../providerNodeSelect";
import { invalidateDbCache } from "../readCache";
import { toRecord, type JsonRecord } from "./columns";
import { resetProviderNodePrefixCache } from "./nodePrefix";

function normalizeDailyQuotaResetHour(value: unknown): number | null {
  return value === 0 || value ? Number(value) : null;
}

// A blank prefix would violate the provider_nodes CHECK; it means "no prefix".
function normalizePrefix(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function toCustomHeaders(value: unknown): JsonRecord | null {
  if (value && typeof value === "object") return value as JsonRecord;
  // Tolerate callers that still hand over the JSON text.
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as JsonRecord) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function nodeFromRow(row: unknown): JsonRecord | null {
  return rowToCamel(row);
}

export async function getProviderNodes(filter: JsonRecord = {}, limit?: number, offset?: number) {
  const params: unknown[] = [];
  let sql = "SELECT * FROM provider_nodes";

  if (filter.type) {
    params.push(filter.type);
    sql += ` WHERE type = $${params.length}`;
  }
  sql += " ORDER BY id ASC";
  if (limit !== undefined) {
    params.push(limit, offset ?? 0);
    sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }

  const rows = await db().query(sql, params);
  return rows.map(nodeFromRow);
}

export async function getProviderNodesCount(filter: JsonRecord = {}): Promise<number> {
  const params: unknown[] = [];
  let sql = "SELECT count(*) AS cnt FROM provider_nodes";

  if (filter.type) {
    params.push(filter.type);
    sql += " WHERE type = $1";
  }

  const row = await db().queryOne<{ cnt: number }>(sql, params);
  return Number(row?.cnt ?? 0);
}

export async function getProviderNodeById(id: string) {
  const row = await db().queryOne("SELECT * FROM provider_nodes WHERE id = $1", [id]);
  return row ? nodeFromRow(row) : null;
}

// #4421: resolve the provider node for a new connection from either its concrete id
// (what the dashboard sends, "<type>-<uuid>") OR the bare derived type (what callers
// using the /api/providers API directly often pass, e.g. "openai-compatible-responses").
// Falls back to the sole node of that type only when unambiguous; otherwise null (so the
// caller still surfaces the existing 404).
export async function resolveProviderNodeForConnection(idOrType: string) {
  const exact = await getProviderNodeById(idOrType);
  if (exact) return exact;
  const all = (await getProviderNodes()) as JsonRecord[];
  return selectProviderNodeForConnection(idOrType, all);
}

export const PROVIDER_NODE_ID_CONFLICT = "PROVIDER_NODE_ID_CONFLICT";

/** Thrown by createProviderNode when a node with the same id already exists. */
export class ProviderNodeIdConflictError extends Error {
  readonly code = PROVIDER_NODE_ID_CONFLICT;
  readonly nodeId: string;

  constructor(nodeId: string) {
    super(`Provider node ID "${nodeId}" already exists`);
    this.name = "ProviderNodeIdConflictError";
    this.nodeId = nodeId;
  }
}

// Matched by `code` (not only `instanceof`) so the guard survives duplicated module
// instances across bundles/realms.
export function isProviderNodeIdConflictError(
  error: unknown
): error is ProviderNodeIdConflictError {
  return (
    error instanceof ProviderNodeIdConflictError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === PROVIDER_NODE_ID_CONFLICT)
  );
}

export const PROVIDER_NODE_PREFIX_CONFLICT = "PROVIDER_NODE_PREFIX_CONFLICT";

/** Thrown by createProviderNode / updateProviderNode when another node already uses the prefix. */
export class ProviderNodePrefixConflictError extends Error {
  readonly code = PROVIDER_NODE_PREFIX_CONFLICT;
  readonly prefix: string;

  constructor(prefix: string) {
    super(`Provider node prefix "${prefix}" is already in use`);
    this.name = "ProviderNodePrefixConflictError";
    this.prefix = prefix;
  }
}

export function isProviderNodePrefixConflictError(
  error: unknown
): error is ProviderNodePrefixConflictError {
  return (
    error instanceof ProviderNodePrefixConflictError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === PROVIDER_NODE_PREFIX_CONFLICT)
  );
}

// provider_nodes_prefix_uq compares lower(btrim(prefix)), so "Zed" and "zed " collide.
function asPrefixConflict(error: unknown, prefix: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505" && message.includes("provider_nodes_prefix_uq")) {
    return new ProviderNodePrefixConflictError(String(prefix ?? ""));
  }
  return error;
}

export async function createProviderNode(data: JsonRecord) {
  const now = new Date().toISOString();

  const customHeaders = data.customHeaders ? toCustomHeaders(data.customHeaders) : null;

  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: normalizePrefix(data.prefix),
    apiType: data.apiType || null,
    baseUrl: data.baseUrl || null,
    chatPath: data.chatPath || null,
    modelsPath: data.modelsPath || null,
    // Optional operator-supplied remote icon URL (#2166) — plain text.
    iconUrl: data.iconUrl || null,
    customHeaders,
    dailyQuotaResetTimezone: data.dailyQuotaResetTimezone || null,
    dailyQuotaResetHour: normalizeDailyQuotaResetHour(data.dailyQuotaResetHour),
    createdAt: now,
    updatedAt: now,
  };

  const result = await db()
    .execute(
      `INSERT INTO provider_nodes (id, type, name, prefix, api_type, base_url, chat_path, models_path, icon_url, custom_headers, daily_quota_reset_timezone, daily_quota_reset_hour, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     ON CONFLICT (id) DO NOTHING`,
      [
        node.id,
        node.type,
        node.name,
        node.prefix,
        node.apiType,
        node.baseUrl,
        node.chatPath,
        node.modelsPath,
        node.iconUrl,
        jsonb(node.customHeaders),
        node.dailyQuotaResetTimezone,
        node.dailyQuotaResetHour,
        now,
      ]
    )
    .catch((err: unknown) => {
      throw asPrefixConflict(err, node.prefix);
    });
  // Ids can be operator-chosen (custom suffix), so a collision is a caller error,
  // never a silent overwrite nor an unhandled constraint failure.
  if (result.changes === 0) throw new ProviderNodeIdConflictError(String(node.id));

  invalidateDbCache("nodes");
  resetProviderNodePrefixCache();

  return { ...node };
}

export async function updateProviderNode(id: string, data: JsonRecord) {
  const merged = await db()
    .transaction(async (tx) => {
      const existing = await tx.queryOne("SELECT * FROM provider_nodes WHERE id = $1 FOR UPDATE", [
        id,
      ]);
      if (!existing) return null;

      const stored = toRecord(nodeFromRow(existing));
      const next: JsonRecord = { ...stored, ...data, updatedAt: new Date().toISOString() };
      // Partial update that omits customHeaders must PRESERVE the stored value; an
      // explicit falsy value clears it.
      next.customHeaders = toCustomHeaders(
        data.customHeaders !== undefined ? data.customHeaders : stored.customHeaders
      );

      await tx.execute(
        `UPDATE provider_nodes SET type = $2, name = $3, prefix = $4,
         api_type = $5, base_url = $6, chat_path = $7,
         models_path = $8, icon_url = $9,
         custom_headers = $10,
         daily_quota_reset_timezone = $11,
         daily_quota_reset_hour = $12,
         updated_at = $13
       WHERE id = $1`,
        [
          id,
          next["type"],
          next["name"],
          normalizePrefix(next["prefix"]),
          next["apiType"] || null,
          next["baseUrl"] || null,
          next["chatPath"] || null,
          next["modelsPath"] || null,
          // #2166: iconUrl is nullable — explicit `null` (not omission) clears a previously
          // stored custom icon when the caller submits an empty value.
          next["iconUrl"] || null,
          jsonb(next["customHeaders"]),
          next["dailyQuotaResetTimezone"] || null,
          normalizeDailyQuotaResetHour(next["dailyQuotaResetHour"]),
          next["updatedAt"],
        ]
      );
      return next;
    })
    .catch((err: unknown) => {
      throw asPrefixConflict(err, data.prefix);
    });
  if (!merged) return null;

  invalidateDbCache("nodes");
  resetProviderNodePrefixCache();

  return merged;
}

export async function deleteProviderNode(id: string) {
  const row = await db().queryOne("DELETE FROM provider_nodes WHERE id = $1 RETURNING *", [id]);
  if (!row) return null;

  invalidateDbCache("nodes");
  resetProviderNodePrefixCache();
  return nodeFromRow(row);
}
