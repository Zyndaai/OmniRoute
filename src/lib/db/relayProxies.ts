/**
 * Relay Proxy DB module
 *
 * Manages relay tokens, rate limits, and usage tracking for serverless relay proxies.
 * Public timestamps stay epoch seconds; the tables store timestamptz.
 */

import { createHash, randomBytes } from "node:crypto";
import { db, jsonb, toMs } from "./pg";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RelayToken {
  id: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  description: string;
  comboId: string | null;
  /** JSON text of a string array. */
  allowedModels: string;
  maxTokensPerRequest: number;
  maxRequestsPerMinute: number;
  maxRequestsPerDay: number;
  maxCostPerDay: number;
  enabled: boolean;
  /** epoch seconds */
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  /** JSON text of an object. */
  metadata: string;
}

export interface RelayTokenRow {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  description: string;
  combo_id: string | null;
  allowed_models: unknown;
  max_tokens_per_request: number;
  max_requests_per_minute: number;
  max_requests_per_day: number;
  max_cost_per_day: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  metadata: unknown;
}

export interface CreateRelayTokenInput {
  name: string;
  description?: string;
  comboId?: string;
  allowedModels?: string[];
  maxTokensPerRequest?: number;
  maxRequestsPerMinute?: number;
  maxRequestsPerDay?: number;
  maxCostPerDay?: number;
  /** epoch seconds */
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface RelayTokenWithSecret extends RelayToken {
  rawToken: string; // Only returned once on creation
}

export interface RelayLogRow {
  id: number;
  /** null when the request failed authentication (no token) */
  token_id: string | null;
  request_id: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  status: string;
  status_code: number;
  latency_ms: number;
  client_ip: string | null;
  user_agent: string | null;
  /** epoch seconds */
  created_at: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return "rl_" + randomBytes(16).toString("hex");
}

function generateToken(): string {
  return "relay_" + randomBytes(24).toString("hex");
}

function hashToken(token: string): string {
  // Simple hash for token comparison (not bcrypt-heavy for performance)
  return createHash("sha256").update(token).digest("hex");
}

function toSeconds(value: string | null | undefined): number | null {
  const ms = toMs(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

function secondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function asJsonText(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function rowToToken(row: RelayTokenRow): RelayToken {
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    description: row.description,
    comboId: row.combo_id,
    allowedModels: asJsonText(row.allowed_models, '["*"]'),
    maxTokensPerRequest: row.max_tokens_per_request,
    maxRequestsPerMinute: row.max_requests_per_minute,
    maxRequestsPerDay: row.max_requests_per_day,
    maxCostPerDay: Number(row.max_cost_per_day),
    enabled: row.enabled === true,
    createdAt: toSeconds(row.created_at) ?? 0,
    updatedAt: toSeconds(row.updated_at) ?? 0,
    expiresAt: toSeconds(row.expires_at),
    lastUsedAt: toSeconds(row.last_used_at),
    metadata: asJsonText(row.metadata, "{}"),
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function createRelayToken(input: CreateRelayTokenInput): Promise<RelayTokenWithSecret> {
  const id = generateId();
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  const prefix = "rl_" + rawToken.slice(6, 14);

  const row = await db().queryOne<RelayTokenRow>(
    `INSERT INTO relay_tokens (id, name, token_hash, token_prefix, description, combo_id, allowed_models,
       max_tokens_per_request, max_requests_per_minute, max_requests_per_day, max_cost_per_day,
       enabled, expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, true, $12, $13::jsonb)
     RETURNING *`,
    [
      id,
      input.name,
      tokenHash,
      prefix,
      input.description || "",
      input.comboId || null,
      jsonb(input.allowedModels || ["*"]),
      Math.round(input.maxTokensPerRequest || 128000),
      Math.round(input.maxRequestsPerMinute || 60),
      Math.round(input.maxRequestsPerDay || 10000),
      input.maxCostPerDay || 0,
      input.expiresAt ? secondsToIso(input.expiresAt) : null,
      jsonb(input.metadata || {}),
    ]
  );
  return { ...rowToToken(row as RelayTokenRow), rawToken };
}

export async function getRelayTokens(): Promise<RelayToken[]> {
  const rows = await db().query<RelayTokenRow>(
    "SELECT * FROM relay_tokens ORDER BY created_at DESC, id DESC"
  );
  return rows.map(rowToToken);
}

export async function getRelayToken(id: string): Promise<RelayToken | null> {
  const row = await db().queryOne<RelayTokenRow>("SELECT * FROM relay_tokens WHERE id = $1", [id]);
  return row ? rowToToken(row) : null;
}

export async function getRelayTokenByHash(
  tokenHash: string
): Promise<(RelayToken & { rawToken?: string }) | null> {
  const row = await db().queryOne<RelayTokenRow>(
    "SELECT * FROM relay_tokens WHERE token_hash = $1 AND enabled",
    [tokenHash]
  );
  return row ? rowToToken(row) : null;
}

export async function updateRelayToken(
  id: string,
  updates: Partial<CreateRelayTokenInput>
): Promise<RelayToken | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (updates.name !== undefined) add("name", updates.name);
  if (updates.description !== undefined) add("description", updates.description);
  if (updates.comboId !== undefined) add("combo_id", updates.comboId);
  if (updates.allowedModels !== undefined) {
    add("allowed_models", jsonb(updates.allowedModels), "::jsonb");
  }
  if (updates.maxTokensPerRequest !== undefined) {
    add("max_tokens_per_request", Math.round(updates.maxTokensPerRequest));
  }
  if (updates.maxRequestsPerMinute !== undefined) {
    add("max_requests_per_minute", Math.round(updates.maxRequestsPerMinute));
  }
  if (updates.maxRequestsPerDay !== undefined) {
    add("max_requests_per_day", Math.round(updates.maxRequestsPerDay));
  }
  if (updates.maxCostPerDay !== undefined) add("max_cost_per_day", updates.maxCostPerDay);

  params.push(id);
  await db().execute(`UPDATE relay_tokens SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return getRelayToken(id);
}

export async function deleteRelayToken(id: string): Promise<void> {
  // Rate-limit windows and logs go with the token through their foreign keys.
  await db().execute("DELETE FROM relay_tokens WHERE id = $1", [id]);
}

export async function toggleRelayToken(id: string, enabled: boolean): Promise<RelayToken | null> {
  await db().execute("UPDATE relay_tokens SET enabled = $1, updated_at = now() WHERE id = $2", [
    enabled,
    id,
  ]);
  return getRelayToken(id);
}

// ── Usage / Rate Limit ───────────────────────────────────────────────────────

export async function checkRateLimit(
  tokenId: string,
  existingToken?: RelayToken
): Promise<{
  allowed: boolean;
  remaining: number;
  resetIn: number;
}> {
  let token = existingToken;
  if (!token) {
    const row = await db().queryOne<RelayTokenRow>("SELECT * FROM relay_tokens WHERE id = $1", [
      tokenId,
    ]);
    if (!row) return { allowed: false, remaining: 0, resetIn: 0 };
    token = rowToToken(row);
  }

  const now = Math.floor(Date.now() / 1000);
  const minuteWindow = Math.floor(now / 60) * 60;
  const dayWindow = Math.floor(now / 86400) * 86400;

  // One round trip for both windows.
  const counts = await db().queryOne<{ minute_count: number; day_count: number }>(
    `SELECT
       COALESCE(SUM(request_count) FILTER (WHERE window_start = $2), 0) AS minute_count,
       COALESCE(SUM(request_count), 0) AS day_count
     FROM relay_rate_limits
     WHERE token_id = $1 AND window_start >= $3`,
    [tokenId, secondsToIso(minuteWindow), secondsToIso(dayWindow)]
  );

  const minuteCount = Number(counts?.minute_count ?? 0);
  if (minuteCount >= token.maxRequestsPerMinute) {
    return { allowed: false, remaining: 0, resetIn: 60 - (now % 60) };
  }

  const dayCount = Number(counts?.day_count ?? 0);
  if (dayCount >= token.maxRequestsPerDay) {
    return { allowed: false, remaining: 0, resetIn: 86400 - (now % 86400) };
  }

  const remaining = Math.min(
    token.maxRequestsPerMinute - minuteCount,
    token.maxRequestsPerDay - dayCount
  );

  return { allowed: true, remaining, resetIn: 60 - (now % 60) };
}

/**
 * Record one relay request. A request that failed authentication (`tokenId`
 * "unknown", or a token that no longer exists) is logged with `token_id = NULL`
 * and writes no rate-limit window.
 */
export async function recordRelayUsage(
  tokenId: string,
  params: {
    requestId?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    cost?: number;
    status?: string;
    statusCode?: number;
    latencyMs?: number;
    clientIp?: string;
    userAgent?: string;
  }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const minuteWindow = secondsToIso(Math.floor(now / 60) * 60);
  const cost = params.cost || 0;

  await db().transaction(async (tx) => {
    // The token row is touched first: it both records last_used_at and tells us
    // whether the token exists (the rate-limit and log rows reference it).
    const known =
      tokenId !== "unknown" &&
      (await tx.execute("UPDATE relay_tokens SET last_used_at = now() WHERE id = $1", [tokenId]))
        .changes > 0;

    if (known) {
      await tx.execute(
        `INSERT INTO relay_rate_limits (token_id, window_start, request_count, cost)
         VALUES ($1, $2, 1, $3)
         ON CONFLICT (token_id, window_start) DO UPDATE SET
           request_count = relay_rate_limits.request_count + 1,
           cost = relay_rate_limits.cost + EXCLUDED.cost`,
        [tokenId, minuteWindow, cost]
      );
    }

    await tx.execute(
      `INSERT INTO relay_logs (token_id, request_id, model, prompt_tokens, completion_tokens, cost,
         status, status_code, latency_ms, client_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        known ? tokenId : null,
        params.requestId || null,
        params.model || null,
        Math.round(params.promptTokens || 0),
        Math.round(params.completionTokens || 0),
        cost,
        params.status || "success",
        Math.round(params.statusCode || 200),
        Math.round(params.latencyMs || 0),
        params.clientIp || null,
        params.userAgent || null,
      ]
    );
  });
}

export async function getRelayUsage(
  tokenId: string,
  since: number
): Promise<{ requestCount: number; totalCost: number }> {
  const row = await db().queryOne<{ request_count: number; total_cost: number }>(
    `SELECT COUNT(*) AS request_count, COALESCE(SUM(cost), 0) AS total_cost
     FROM relay_logs WHERE token_id = $1 AND created_at >= $2`,
    [tokenId, secondsToIso(since)]
  );
  return {
    requestCount: Number(row?.request_count ?? 0),
    totalCost: Number(row?.total_cost ?? 0),
  };
}

type RelayLogDbRow = Omit<RelayLogRow, "created_at"> & { created_at: string };

export async function getRelayLogs(tokenId?: string, limit = 50): Promise<RelayLogRow[]> {
  const rows = tokenId
    ? await db().query<RelayLogDbRow>(
        "SELECT * FROM relay_logs WHERE token_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
        [tokenId, Math.max(1, Math.floor(limit))]
      )
    : await db().query<RelayLogDbRow>(
        "SELECT * FROM relay_logs ORDER BY created_at DESC, id DESC LIMIT $1",
        [Math.max(1, Math.floor(limit))]
      );
  return rows.map((row) => ({ ...row, created_at: toSeconds(row.created_at) ?? 0 }));
}
