/**
 * reasoningCache.ts — DB domain module for the Reasoning Replay Cache.
 *
 * Persists reasoning_content from thinking-mode models (DeepSeek V4, Kimi K2,
 * Qwen-Thinking, etc.) keyed by tool_call_id. Used for crash recovery and
 * dashboard visibility. The hot path uses the in-memory cache in
 * open-sse/services/reasoningCache.ts; this module is the persistence layer.
 *
 * @see Issue #1628
 */

import { db } from "@/lib/db/pg";

// ──────────────── Types ────────────────

export interface ReasoningCacheEntry {
  toolCallId: string;
  provider: string;
  model: string;
  reasoning: string;
  charCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface ReasoningCacheStats {
  totalEntries: number;
  totalChars: number;
  byProvider: Record<string, { entries: number; chars: number }>;
  byModel: Record<string, { entries: number; chars: number }>;
  oldestEntry: string | null;
  newestEntry: string | null;
}

// ──────────────── Constants ────────────────

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const MAX_ENTRY_BYTES = 10000;

// ──────────────── CRUD ────────────────

/**
 * Store a reasoning_content entry for a given tool_call_id.
 * Upserts so duplicate tool_call_ids replace the earlier entry.
 */
export async function setReasoningCache(
  toolCallId: string,
  provider: string,
  model: string,
  reasoning: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<void> {
  const PLACEHOLDER = "(prior reasoning summary unavailable)";
  if (!reasoning || reasoning.trim() === PLACEHOLDER) return; // ponytail: never store the internal placeholder
  if (reasoning.length > MAX_ENTRY_BYTES) {
    reasoning = reasoning.slice(0, MAX_ENTRY_BYTES);
  }
  // Postgres rejects U+0000 in text.
  reasoning = reasoning.replace(/\u0000/g, "");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const charCount = reasoning.length;

  await db().execute(
    `INSERT INTO reasoning_cache
       (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (tool_call_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       reasoning = EXCLUDED.reasoning,
       char_count = EXCLUDED.char_count,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at`,
    [toolCallId, provider, model, reasoning, charCount, expiresAt]
  );
}

/**
 * Retrieve a cached reasoning_content by tool_call_id.
 * Returns null if not found or expired.
 */
export async function getReasoningCache(
  toolCallId: string
): Promise<{ reasoning: string; provider: string; model: string; expiresAt: string } | null> {
  const row = await db().queryOne<{
    reasoning: string;
    provider: string;
    model: string;
    expires_at: string;
  }>(
    `SELECT reasoning, provider, model, expires_at FROM reasoning_cache
     WHERE tool_call_id = $1 AND expires_at > now()`,
    [toolCallId]
  );

  const PLACEHOLDER = "(prior reasoning summary unavailable)";
  if (row && row.reasoning && row.reasoning.trim() === PLACEHOLDER) return null;
  return row
    ? {
        reasoning: row.reasoning,
        provider: row.provider,
        model: row.model,
        expiresAt: row.expires_at,
      }
    : null;
}

/**
 * Delete a specific reasoning cache entry.
 */
export async function deleteReasoningCache(toolCallId: string): Promise<number> {
  const result = await db().execute(`DELETE FROM reasoning_cache WHERE tool_call_id = $1`, [
    toolCallId,
  ]);
  return result.changes;
}

/**
 * Delete all expired entries. Returns count of rows removed.
 */
export async function cleanupExpiredReasoning(): Promise<number> {
  const result = await db().execute(`DELETE FROM reasoning_cache WHERE expires_at <= now()`);
  return result.changes;
}

/**
 * Delete all entries, optionally filtered by provider.
 * Returns count of rows removed.
 */
export async function clearAllReasoningCache(provider?: string): Promise<number> {
  if (provider) {
    const result = await db().execute(`DELETE FROM reasoning_cache WHERE provider = $1`, [
      provider,
    ]);
    return result.changes;
  }
  const result = await db().execute(`DELETE FROM reasoning_cache`);
  return result.changes;
}

// ──────────────── Stats ────────────────

/**
 * Get aggregate statistics for the reasoning cache.
 */
export async function getReasoningCacheStats(): Promise<ReasoningCacheStats> {
  const totals = await db().queryOne<{ total_entries: number; total_chars: number }>(
    `SELECT COUNT(*) as total_entries, COALESCE(SUM(char_count), 0) as total_chars
     FROM reasoning_cache WHERE expires_at > now()`
  );

  const providerRows = await db().query<{ provider: string; entries: number; chars: number }>(
    `SELECT provider, COUNT(*) as entries, COALESCE(SUM(char_count), 0) as chars
     FROM reasoning_cache WHERE expires_at > now()
     GROUP BY provider ORDER BY entries DESC`
  );

  const byProvider: Record<string, { entries: number; chars: number }> = {};
  for (const row of providerRows) {
    byProvider[row.provider] = { entries: Number(row.entries), chars: Number(row.chars) };
  }

  const modelRows = await db().query<{ model: string; entries: number; chars: number }>(
    `SELECT model, COUNT(*) as entries, COALESCE(SUM(char_count), 0) as chars
     FROM reasoning_cache WHERE expires_at > now()
     GROUP BY model ORDER BY entries DESC`
  );

  const byModel: Record<string, { entries: number; chars: number }> = {};
  for (const row of modelRows) {
    byModel[row.model] = { entries: Number(row.entries), chars: Number(row.chars) };
  }

  const bounds = await db().queryOne<{ oldest: string | null; newest: string | null }>(
    `SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest
     FROM reasoning_cache WHERE expires_at > now()`
  );

  return {
    totalEntries: Number(totals?.total_entries ?? 0),
    totalChars: Number(totals?.total_chars ?? 0),
    byProvider,
    byModel,
    oldestEntry: bounds?.oldest ?? null,
    newestEntry: bounds?.newest ?? null,
  };
}

// ──────────────── Paginated Entries ────────────────

/**
 * List reasoning cache entries with optional filters and pagination.
 */
export async function getReasoningCacheEntries(
  opts: {
    limit?: number;
    offset?: number;
    provider?: string;
    model?: string;
  } = {}
): Promise<ReasoningCacheEntry[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions: string[] = ["expires_at > now()"];
  const params: unknown[] = [];

  if (opts.provider) {
    params.push(opts.provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (opts.model) {
    params.push(opts.model);
    conditions.push(`model = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const rows = await db().query<{
    tool_call_id: string;
    provider: string;
    model: string;
    reasoning: string;
    char_count: number;
    created_at: string;
    expires_at: string;
  }>(
    `SELECT tool_call_id, provider, model, reasoning, char_count, created_at, expires_at
     FROM reasoning_cache ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return rows.map((row) => ({
    toolCallId: row.tool_call_id,
    provider: row.provider,
    model: row.model,
    reasoning: row.reasoning,
    charCount: row.char_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}
