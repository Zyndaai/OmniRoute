import { randomUUID } from "crypto";
import { db, jsonb, ts } from "@/lib/db/pg";
import { stripNul, toIntOrNull } from "@/lib/db/proxies/sanitize";
import type { FreeProxyItem, FreeProxySourceId } from "@/lib/freeProxyProviders/types";

export interface FreeProxyRecord {
  id: string;
  source: FreeProxySourceId;
  host: string;
  port: number;
  type: string;
  countryCode: string | null;
  qualityScore: number | null;
  latencyMs: number | null;
  anonymity: string | null;
  lastValidated: string | null;
  inPool: boolean;
  poolProxyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FreeProxyStats {
  total: number;
  inPool: number;
  avgQuality: number | null;
  bySource: Array<{ source: string; count: number }>;
  lastSyncAt: string | null;
}

/** Source id → list of error messages from that source's last sync. */
export type FreeProxySyncErrors = Record<string, string[]>;

type DbRow = Record<string, unknown>;

function mapRow(row: unknown): FreeProxyRecord {
  const r = row as DbRow;
  const poolProxyId = r.pool_proxy_id != null ? String(r.pool_proxy_id) : null;
  return {
    id: String(r.id ?? ""),
    source: String(r.source ?? "1proxy") as FreeProxySourceId,
    host: String(r.host ?? ""),
    port: Number(r.port) || 0,
    type: String(r.type ?? "http"),
    countryCode: r.country_code != null ? String(r.country_code) : null,
    qualityScore: r.quality_score != null ? Number(r.quality_score) : null,
    latencyMs: r.latency_ms != null ? Number(r.latency_ms) : null,
    anonymity: r.anonymity != null ? String(r.anonymity) : null,
    lastValidated: r.last_validated != null ? String(r.last_validated) : null,
    inPool: poolProxyId !== null,
    poolProxyId,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

export async function upsertFreeProxy(
  item: FreeProxyItem
): Promise<{ id: string; action: "created" | "updated" }> {
  const now = new Date().toISOString();
  const lastValidated = ts(item.lastValidated) ?? now;

  // One atomic statement: the (source, host, port) unique key arbitrates two
  // concurrent syncs. `xmax = 0` is true only for a freshly inserted tuple.
  const row = await db().queryOne<{ id: string; inserted: boolean }>(
    `INSERT INTO free_proxies
       (id, source, host, port, type, country_code, quality_score, latency_ms,
        anonymity, last_validated, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     ON CONFLICT (source, host, port) DO UPDATE SET
       type = EXCLUDED.type,
       country_code = EXCLUDED.country_code,
       quality_score = EXCLUDED.quality_score,
       latency_ms = EXCLUDED.latency_ms,
       anonymity = EXCLUDED.anonymity,
       last_validated = EXCLUDED.last_validated,
       updated_at = EXCLUDED.updated_at
     RETURNING id, (xmax = 0) AS inserted`,
    [
      randomUUID(),
      item.source,
      stripNul(item.host),
      item.port,
      item.type,
      stripNul(item.countryCode ?? null),
      toIntOrNull(item.qualityScore),
      toIntOrNull(item.latencyMs),
      stripNul(item.anonymity ?? null),
      lastValidated,
      now,
    ]
  );
  if (!row) throw new Error("free proxy upsert returned no row");
  return { id: row.id, action: row.inserted ? "created" : "updated" };
}

interface FreeProxyFilters {
  sources?: FreeProxySourceId[];
  protocol?: string;
  country?: string;
  minQuality?: number;
  onlyInPool?: boolean;
  onlyNotInPool?: boolean;
  search?: string;
}

function buildFreeProxyFilter(
  options: FreeProxyFilters | undefined,
  params: unknown[]
): string {
  let sql = " WHERE 1=1";
  if (options?.sources?.length) {
    params.push(options.sources);
    sql += ` AND source = ANY($${params.length}::text[])`;
  }
  if (options?.protocol) {
    params.push(options.protocol);
    sql += ` AND type = $${params.length}`;
  }
  if (options?.country) {
    params.push(options.country.toUpperCase());
    sql += ` AND country_code = $${params.length}`;
  }
  if (options?.minQuality != null) {
    params.push(options.minQuality);
    sql += ` AND quality_score >= $${params.length}`;
  }
  if (options?.onlyInPool) {
    sql += " AND pool_proxy_id IS NOT NULL";
  }
  if (options?.onlyNotInPool) {
    sql += " AND pool_proxy_id IS NULL";
  }
  if (options?.search) {
    params.push(`%${options.search}%`);
    sql += ` AND host ILIKE $${params.length}`;
  }
  return sql;
}

export async function listFreeProxies(
  options?: FreeProxyFilters & {
    sortBy?: "quality" | "latency" | "recent";
    limit?: number;
    offset?: number;
  }
): Promise<FreeProxyRecord[]> {
  const params: unknown[] = [];
  let sql = "SELECT * FROM free_proxies" + buildFreeProxyFilter(options, params);

  // NULLS LAST keeps the SQLite ordering (NULL sorted smallest).
  const sortClause =
    options?.sortBy === "latency"
      ? "ORDER BY latency_ms ASC NULLS LAST"
      : options?.sortBy === "recent"
        ? "ORDER BY last_validated DESC NULLS LAST"
        : "ORDER BY quality_score DESC NULLS LAST, last_validated DESC NULLS LAST";
  sql += ` ${sortClause}`;

  if (options?.limit) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
    if (options?.offset) {
      params.push(options.offset);
      sql += ` OFFSET $${params.length}`;
    }
  }

  const rows = await db().query(sql, params);
  return rows.map(mapRow);
}

export async function countFreeProxies(options?: FreeProxyFilters): Promise<number> {
  const params: unknown[] = [];
  const sql = "SELECT COUNT(*) AS count FROM free_proxies" + buildFreeProxyFilter(options, params);
  const row = await db().queryOne<DbRow>(sql, params);
  return Number(row?.count ?? 0);
}

export async function listFreeProxiesBySource(
  source: FreeProxySourceId,
  filters: {
    protocol?: string;
    country?: string;
    minQuality?: number;
    limit?: number;
  }
): Promise<FreeProxyItem[]> {
  const records = await listFreeProxies({
    sources: [source],
    protocol: filters.protocol,
    country: filters.country,
    minQuality: filters.minQuality,
    limit: filters.limit,
  });
  return records.map((r) => ({
    source: r.source,
    host: r.host,
    port: r.port,
    type: r.type as FreeProxyItem["type"],
    countryCode: r.countryCode,
    qualityScore: r.qualityScore,
    latencyMs: r.latencyMs,
    anonymity: r.anonymity,
    lastValidated: r.lastValidated,
  }));
}

export async function getFreeProxyById(id: string): Promise<FreeProxyRecord | null> {
  const row = await db().queryOne("SELECT * FROM free_proxies WHERE id = $1", [id]);
  return row ? mapRow(row) : null;
}

export async function markFreeProxyInPool(id: string, poolProxyId: string): Promise<void> {
  await db().execute(
    "UPDATE free_proxies SET pool_proxy_id = $1, updated_at = now() WHERE id = $2",
    [poolProxyId, id]
  );
}

/**
 * Atomically inserts the free proxy into `proxy_registry` and links it
 * (`free_proxies.pool_proxy_id`) in a single transaction. The free-proxy row is
 * locked first, so two concurrent promotions of the same candidate cannot both
 * create a registry row: the second one finds the link and returns it.
 *
 * Returns the `poolProxyId` on success, or `null` if the free proxy id does not
 * exist (caller should return 404).
 */
export async function promoteFreeProxyToPool(
  freeProxyId: string,
  registryPayload: {
    name: string;
    type: string;
    host: string;
    port: number;
    source: string;
  }
): Promise<string | null> {
  const now = new Date().toISOString();
  const newRegistryId = randomUUID();

  return db().transaction(async (tx) => {
    const free = await tx.queryOne<{ id: string; pool_proxy_id: string | null }>(
      "SELECT id, pool_proxy_id FROM free_proxies WHERE id = $1 FOR UPDATE",
      [freeProxyId]
    );
    if (!free) return null;
    if (free.pool_proxy_id) {
      const stillThere = await tx.queryOne("SELECT 1 AS one FROM proxy_registry WHERE id = $1", [
        free.pool_proxy_id,
      ]);
      if (stillThere) return free.pool_proxy_id;
    }

    await tx.execute(
      `INSERT INTO proxy_registry
         (id, name, type, host, port, username, password, region, notes, status, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '', '', NULL, NULL, 'active', $6, $7, $7)`,
      [
        newRegistryId,
        registryPayload.name,
        registryPayload.type,
        registryPayload.host,
        Number(registryPayload.port),
        registryPayload.source,
        now,
      ]
    );

    await tx.execute("UPDATE free_proxies SET pool_proxy_id = $1, updated_at = $2 WHERE id = $3", [
      newRegistryId,
      now,
      freeProxyId,
    ]);

    return newRegistryId;
  });
}

export async function deleteFreeProxy(id: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM free_proxies WHERE id = $1", [id]);
  return result.changes > 0;
}

export async function clearFreeProxiesBySource(source: FreeProxySourceId): Promise<number> {
  const result = await db().execute(
    "DELETE FROM free_proxies WHERE source = $1 AND pool_proxy_id IS NULL",
    [source]
  );
  return result.changes;
}

/**
 * Tombstone rows for `source` whose `host:port` is no longer present in the
 * provider's latest list — e.g. Webshare recycles/retires proxy IDs between
 * syncs. Rows already promoted to the pool (`pool_proxy_id` set) are left alone
 * so runtime resolution of an in-use proxy is never disturbed; only stale,
 * not-yet-pooled candidates are pruned. Returns the number of rows removed.
 */
export async function pruneStaleFreeProxies(
  source: FreeProxySourceId,
  activeKeys: ReadonlySet<string>
): Promise<number> {
  const rows = await db().query<{ id: string; host: string; port: number }>(
    "SELECT id, host, port FROM free_proxies WHERE source = $1 AND pool_proxy_id IS NULL",
    [source]
  );

  const staleIds = rows.filter((r) => !activeKeys.has(`${r.host}:${r.port}`)).map((r) => r.id);
  if (staleIds.length === 0) return 0;

  const result = await db().execute("DELETE FROM free_proxies WHERE id = ANY($1::text[])", [
    staleIds,
  ]);
  return result.changes;
}

// #4878: the displayed "last sync" used to be derived from MAX(last_validated),
// which only advances when a provider returns at least one new/updated proxy. A
// sync that returns zero rows (or whose providers all fail) left the timestamp
// frozen, so "Sync All" appeared to do nothing. We persist an explicit sync
// timestamp in `config_entries('job_state')` and prefer it in the stats. The
// value is a raw ISO text, stored as a JSON string.
const FREE_PROXY_SYNC_NAMESPACE = "job_state";
const FREE_PROXY_SYNC_KEY = "free_proxies.last_sync_at";

/**
 * Persist the moment a free-proxy sync completed. Returns the stored ISO string
 * so the route can echo it back. `at` is overridable for deterministic tests.
 */
export async function recordFreeProxySync(at?: string): Promise<string> {
  const stamp = at ?? new Date().toISOString();
  await db().execute(
    `INSERT INTO config_entries (namespace, key, value, updated_at)
     VALUES ($1, $2, to_jsonb($3::text), now())
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [FREE_PROXY_SYNC_NAMESPACE, FREE_PROXY_SYNC_KEY, stamp]
  );
  return stamp;
}

async function getRecordedFreeProxySync(): Promise<string | null> {
  const row = await db().queryOne<{ value: string | null }>(
    "SELECT value #>> '{}' AS value FROM config_entries WHERE namespace = $1 AND key = $2",
    [FREE_PROXY_SYNC_NAMESPACE, FREE_PROXY_SYNC_KEY]
  );
  return row?.value != null ? String(row.value) : null;
}

export async function getFreeProxyStats(): Promise<FreeProxyStats> {
  const totals = (await db().queryOne<DbRow>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE pool_proxy_id IS NOT NULL) AS in_pool_count,
            AVG(quality_score) AS avg_quality,
            MAX(last_validated) AS last_sync_at
     FROM free_proxies`
  )) ?? {};

  const bySource = await db().query<DbRow>(
    "SELECT source, COUNT(*) AS count FROM free_proxies GROUP BY source ORDER BY count DESC, source ASC"
  );

  // Prefer the explicitly recorded sync timestamp (#4878); fall back to the
  // newest last_validated only when no sync has ever been recorded.
  const recordedSyncAt = await getRecordedFreeProxySync();
  const derivedSyncAt = totals.last_sync_at != null ? String(totals.last_sync_at) : null;

  return {
    total: Number(totals.total) || 0,
    inPool: Number(totals.in_pool_count) || 0,
    avgQuality: totals.avg_quality != null ? Math.round(Number(totals.avg_quality)) : null,
    bySource: bySource.map((r) => ({ source: String(r.source), count: Number(r.count) })),
    lastSyncAt: recordedSyncAt ?? derivedSyncAt,
  };
}

/**
 * Persist the most recent per-source sync errors. A successful sync for a
 * source should call clearFreeProxySyncErrors instead so the stale error
 * stops showing.
 */
export async function recordFreeProxySyncErrors(
  source: FreeProxySourceId,
  errors: string[]
): Promise<void> {
  await db().execute(
    `INSERT INTO free_proxy_sync_errors (source, errors, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (source) DO UPDATE SET errors = EXCLUDED.errors, updated_at = now()`,
    [source, jsonb(errors)]
  );
}

/** Clear a source's stored sync error (called on a successful sync). */
export async function clearFreeProxySyncErrors(source: FreeProxySourceId): Promise<void> {
  await db().execute("DELETE FROM free_proxy_sync_errors WHERE source = $1", [source]);
}

/**
 * Read all stored per-source sync errors as a plain map. Sources with no
 * recorded error are omitted, so an empty object means a clean (or un-synced)
 * state.
 */
export async function getFreeProxySyncErrors(): Promise<FreeProxySyncErrors> {
  const rows = await db().query<{ source: string; errors: unknown }>(
    "SELECT source, errors FROM free_proxy_sync_errors"
  );
  const out: FreeProxySyncErrors = {};
  for (const row of rows) {
    if (!row.source) continue;
    out[row.source] = Array.isArray(row.errors) ? row.errors.map(String) : [String(row.errors)];
  }
  return out;
}
