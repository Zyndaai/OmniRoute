/**
 * db/semanticCache.ts — CRUD queries over the `semantic_cache` table.
 * Extracted from the /api/cache/entries route handler.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/cache/entries route can delegate.
 *
 * Sliced out of #3500 (semantic_cache cluster, slice 4).
 */

import { db } from "@/lib/db/pg";
import {
  getSemanticCachePruneConfig,
  type SemanticCachePruneConfig,
} from "../jobs/semanticCachePruneConfig";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SemanticCacheEntry {
  id: string;
  signature: string;
  model: string;
  hit_count: number;
  tokens_saved: number;
  created_at: string;
  expires_at: string;
}

export interface SemanticCacheListOptions {
  page: number;
  limit: number;
  search: string;
  model: string;
  sortBy: string;
  sortOrder: string;
}

export interface SemanticCacheListResult {
  entries: SemanticCacheEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const VALID_SORT_COLUMNS = ["created_at", "expires_at", "hit_count", "tokens_saved", "model"];

/**
 * Returns a paginated, filtered, sorted list of semantic cache entries.
 * All dynamic inputs (sortBy/sortOrder) are validated before use.
 */
export async function listSemanticCacheEntries(
  opts: SemanticCacheListOptions
): Promise<SemanticCacheListResult> {
  const { page, limit, search, model, sortBy, sortOrder } = opts;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(signature ILIKE $${params.length} OR model ILIKE $${params.length})`);
  }

  if (model) {
    params.push(model);
    conditions.push(`model = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = VALID_SORT_COLUMNS.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "ASC" : "DESC";

  const countRow = await db().queryOne<{ total: number }>(
    `SELECT COUNT(*) as total FROM semantic_cache ${whereClause}`,
    params
  );

  const rows = await db().query<Omit<SemanticCacheEntry, "id">>(
    `SELECT signature, model, hit_count, tokens_saved, created_at, expires_at
       FROM semantic_cache ${whereClause}
       ORDER BY ${orderBy} ${order}, signature
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  // The surrogate `id` column is gone; the signature is the primary key.
  const entries: SemanticCacheEntry[] = rows.map((row) => ({ ...row, id: row.signature }));
  return { entries, total: Number(countRow?.total || 0) };
}

export interface DeleteSemanticCacheBySignatureResult {
  deleted: number;
}

/**
 * Deletes the single semantic cache entry matching the given signature.
 * Returns `{ deleted: 1 }` on success.
 */
export async function deleteSemanticCacheBySignature(
  signature: string
): Promise<DeleteSemanticCacheBySignatureResult> {
  await db().execute("DELETE FROM semantic_cache WHERE signature = $1", [signature]);
  return { deleted: 1 };
}

export interface DeleteSemanticCacheByModelResult {
  deleted: number;
}

/**
 * Deletes all semantic cache entries for the given model.
 * Returns `{ deleted: N }` where N is the number of rows removed.
 */
export async function deleteSemanticCacheByModel(
  model: string
): Promise<DeleteSemanticCacheByModelResult> {
  const result = await db().execute("DELETE FROM semantic_cache WHERE model = $1", [model]);
  return { deleted: result.changes };
}

export interface SemanticCachePruneResult {
  expiredDeleted: number;
  capDeleted: number;
  batches: number;
}

/**
 * Expiry is inclusive (expires_at <= the run's ISO timestamp); future rows are untouched
 * by the expiry pass. The optional cap can evict live rows, oldest created_at then rowid.
 * Both passes share maxBatches; batches counts DELETE statements, including an empty one.
 */
export async function pruneSemanticCache(
  {
    batchSize,
    maxBatches,
    maxRows,
  }: Pick<
    SemanticCachePruneConfig,
    "batchSize" | "maxBatches" | "maxRows"
  > = getSemanticCachePruneConfig(),
  now = new Date()
): Promise<SemanticCachePruneResult> {
  const cutoff = now.toISOString();
  const result = { expiredDeleted: 0, capDeleted: 0, batches: 0 };
  const yieldBetweenBatches = () => new Promise<void>((resolve) => setImmediate(resolve));
  while (result.batches < maxBatches) {
    if (result.batches > 0) await yieldBetweenBatches();
    const { changes } = await db().execute(
      `DELETE FROM semantic_cache WHERE signature IN
       (SELECT signature FROM semantic_cache WHERE expires_at <= $1 LIMIT $2)`,
      [cutoff, batchSize]
    );
    result.expiredDeleted += changes;
    result.batches++;
    if (changes < batchSize) break;
  }

  if (maxRows <= 0 || result.batches >= maxBatches) return result;
  while (result.batches < maxBatches) {
    await yieldBetweenBatches();
    // Recount after yielding: concurrent cache writes/deletes may have changed the excess.
    const countRow = await db().queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM semantic_cache"
    );
    const excess = Number(countRow?.total ?? 0) - maxRows;
    if (excess <= 0) break;
    const limit = Math.min(batchSize, excess);
    const { changes } = await db().execute(
      `DELETE FROM semantic_cache WHERE signature IN
       (SELECT signature FROM semantic_cache ORDER BY created_at, signature LIMIT $1)`,
      [limit]
    );
    result.capDeleted += changes;
    result.batches++;
    if (changes < batchSize) break;
  }
  return result;
}
