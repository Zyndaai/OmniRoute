/**
 * db/quotaPools.ts — CRUD for quota_pools and quota_allocations tables.
 *
 * Quota pools group provider connections with per-API-key weight + cap +
 * policy allocations. Used by the Quota Sharing Engine (plan 22, Group B).
 *
 * Membership lives only in quota_pool_connections: `position` 0 is the pool's
 * primary connection (QuotaPool.connectionId). Schedules, model caps, memberships
 * and allocations are removed with the pool by their foreign keys.
 *
 * All SQL goes through parameterised statements — never raw string interpolation.
 */

import { db, type DbExecutor } from "./pg";
import { clearApiKeyCaches } from "./apiKeys";
import { getCachedProviderConnectionById, invalidateModelCatalogCache } from "./readCache";
// Phase B2: auto-mint/prune quotaShared-* combos when pool allocations change.
// Imported lazily (dynamic import in the hook) to avoid circular-dependency
// risk between db/ and quota/ modules. Sync hooks are fire-and-forget; deletion
// awaits its guarded cleanup while metadata is available. Combo failures never
// break pool CRUD.
const quotaComboMaintenance = new Map<string, Promise<unknown>>();
const deletingPools = new Set<string>();

function serializeQuotaComboMaintenance<T>(
  poolId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = quotaComboMaintenance.get(poolId);
  const current = previous ? previous.catch(() => undefined).then(operation) : operation();
  quotaComboMaintenance.set(poolId, current);
  const cleanup = () => {
    if (quotaComboMaintenance.get(poolId) === current) quotaComboMaintenance.delete(poolId);
  };
  void current.then(cleanup, cleanup);
  return current;
}

async function syncQuotaCombosGuarded(poolId: string): Promise<void> {
  try {
    const { syncQuotaCombos } = await import("@/lib/quota/quotaCombos");
    await syncQuotaCombos(poolId);
  } catch (err) {
    // Guard: combo-sync failure must never break pool CRUD callers.
    console.warn("[quota-pools] syncQuotaCombos failed (non-fatal):", (err as Error)?.message);
  }
}

async function removeQuotaCombosGuarded(poolId: string): Promise<void> {
  try {
    const { removeQuotaCombosForPool } = await import("@/lib/quota/quotaCombos");
    await removeQuotaCombosForPool(poolId);
  } catch (err) {
    console.warn(
      "[quota-pools] removeQuotaCombosForPool failed (non-fatal):",
      (err as Error)?.message
    );
  }
}

// ---------------------------------------------------------------------------
// Local type shapes (aligned with src/lib/quota/dimensions.ts — merged by F7)
// ---------------------------------------------------------------------------

type QuotaUnit = "percent" | "requests" | "tokens" | "usd";
type Policy = "hard" | "soft" | "burst";

export interface PoolAllocation {
  apiKeyId: string;
  weight: number;
  capValue?: number;
  capUnit?: QuotaUnit;
  policy: Policy;
}

export interface QuotaPool {
  id: string;
  /** Primary connection (membership position 0). Kept for back-compat. */
  connectionId: string;
  /** All member connections (≥1). Primary is always connectionIds[0]. */
  connectionIds: string[];
  name: string;
  /** Group this pool belongs to. Defaults to 'group-demo' for legacy pools. */
  groupId: string;
  createdAt: string;
  allocations: PoolAllocation[];
}

export interface PoolCreate {
  connectionId: string;
  name: string;
  /** Group to assign this pool to. Defaults to 'group-demo' when omitted. */
  groupId?: string;
  allocations?: PoolAllocation[];
  /**
   * Full member list. When provided, connectionId is ignored for the join table
   * and connectionIds[0] is used as the primary. When omitted, defaults to
   * [connectionId].
   */
  connectionIds?: string[];
}

export interface PoolUpdate {
  name?: string;
  /** When provided, updates the pool's group assignment. */
  groupId?: string;
  allocations?: PoolAllocation[];
  /**
   * When provided, replaces the entire membership for this pool; the first
   * element becomes the primary connection (position 0).
   */
  connectionIds?: string[];
}

export interface EnsurePoolResult {
  pool: QuotaPool;
  created: boolean;
  updated: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that all connections in the list belong to the same provider.
 * Throws if mixed providers are detected. No-op when list has 0 or 1 entry.
 */
async function assertSingleProvider(connectionIds: string[]): Promise<void> {
  if (!connectionIds || connectionIds.length <= 1) return;
  const rows = await db().query<{ provider: string }>(
    "SELECT DISTINCT provider FROM provider_connections WHERE id = ANY($1::text[])",
    [connectionIds]
  );
  const providers = rows.map((r) => r.provider).filter(Boolean);
  if (new Set(providers).size > 1) {
    throw new Error(
      `A quota pool must use a single provider (got: ${[...new Set(providers)].join(", ")})`
    );
  }
}

interface PoolRow {
  id: string;
  name: string;
  group_id: string | null;
  created_at: string;
}

interface AllocationRow {
  pool_id: string;
  api_key_id: string;
  weight: number;
  cap_value: number | null;
  cap_unit: string | null;
  policy: string;
}

const POOL_COLUMNS = "id, name, group_id, created_at";

const VALID_POLICIES: ReadonlySet<string> = new Set<Policy>(["hard", "soft", "burst"]);

/**
 * Fail-safe policy normalization at the DB read boundary. A column value outside
 * `hard | soft | burst` is coerced to the most restrictive policy, `hard`,
 * instead of being trusted via a raw `as Policy` cast. This prevents an unknown
 * policy from reaching the fair-share engine, where it would otherwise be a
 * silent fail-OPEN (issue #10).
 */
function normalizePolicy(value: string): Policy {
  return VALID_POLICIES.has(value) ? (value as Policy) : "hard";
}

function rowToAllocation(row: AllocationRow): PoolAllocation {
  const alloc: PoolAllocation = {
    apiKeyId: row.api_key_id,
    weight: row.weight,
    policy: normalizePolicy(row.policy),
  };
  if (row.cap_value != null) alloc.capValue = row.cap_value;
  if (row.cap_unit != null) alloc.capUnit = row.cap_unit as QuotaUnit;
  return alloc;
}

async function batchBuildPools(rows: PoolRow[], executor: DbExecutor = db()): Promise<QuotaPool[]> {
  if (rows.length === 0) return [];
  const poolIds = rows.map((r) => r.id);

  // Batch allocations: 1 query for all pools
  const allocRows = await executor.query<AllocationRow>(
    `SELECT pool_id, api_key_id, weight, cap_value, cap_unit, policy
     FROM quota_allocations WHERE pool_id = ANY($1::text[])`,
    [poolIds]
  );
  const allocsByPool = new Map<string, AllocationRow[]>();
  for (const row of allocRows) {
    const list = allocsByPool.get(row.pool_id);
    if (list) list.push(row);
    else allocsByPool.set(row.pool_id, [row]);
  }

  // Batch connections: 1 query for all pools, primary first
  const connRows = await executor.query<{ pool_id: string; connection_id: string }>(
    `SELECT pool_id, connection_id FROM quota_pool_connections
     WHERE pool_id = ANY($1::text[]) ORDER BY pool_id, position ASC`,
    [poolIds]
  );
  const connsByPool = new Map<string, string[]>();
  for (const row of connRows) {
    const list = connsByPool.get(row.pool_id);
    if (list) list.push(row.connection_id);
    else connsByPool.set(row.pool_id, [row.connection_id]);
  }

  return rows.map((row) => {
    const connectionIds = connsByPool.get(row.id) || [];
    return {
      id: row.id,
      connectionId: connectionIds[0] ?? "",
      connectionIds,
      name: row.name,
      groupId: row.group_id || "group-demo",
      createdAt: row.created_at,
      allocations: (allocsByPool.get(row.id) || []).map(rowToAllocation),
    };
  });
}

function makeId(): string {
  return crypto.randomUUID();
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** Insert the pool's members at positions 0..n-1 (the caller passes a deduplicated list). */
async function insertMembers(tx: DbExecutor, poolId: string, members: string[]): Promise<void> {
  for (let position = 0; position < members.length; position++) {
    // No ON CONFLICT: the (pool_id, position) unique constraint is deferrable, which
    // ON CONFLICT cannot arbitrate. The list is deduplicated, so a conflict is a real error.
    await tx.execute(
      "INSERT INTO quota_pool_connections (pool_id, connection_id, position) VALUES ($1, $2, $3)",
      [poolId, members[position], position]
    );
  }
}

/**
 * Make the pool's allocations exactly `allocations`: upsert the listed keys and
 * delete the others. Upserting (not delete-all + insert) keeps the per-model
 * caps of surviving allocations, which cascade from the allocation row.
 */
async function replaceAllocations(
  tx: DbExecutor,
  poolId: string,
  allocations: PoolAllocation[]
): Promise<void> {
  for (const alloc of allocations) {
    await tx.execute(
      `INSERT INTO quota_allocations (pool_id, api_key_id, weight, cap_value, cap_unit, policy)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pool_id, api_key_id) DO UPDATE SET
         weight = EXCLUDED.weight,
         cap_value = EXCLUDED.cap_value,
         cap_unit = EXCLUDED.cap_unit,
         policy = EXCLUDED.policy`,
      [
        poolId,
        alloc.apiKeyId,
        alloc.weight,
        alloc.capValue ?? null,
        alloc.capUnit ?? null,
        alloc.policy,
      ]
    );
  }
  await tx.execute(
    "DELETE FROM quota_allocations WHERE pool_id = $1 AND api_key_id <> ALL($2::text[])",
    [poolId, dedupe(allocations.map((a) => a.apiKeyId))]
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all quota pools that belong to a specific group.
 * Returns an empty array when no pools match the given groupId.
 */
export async function getPoolsByGroup(
  groupId: string,
  limit?: number,
  offset?: number
): Promise<QuotaPool[]> {
  let sql = `SELECT ${POOL_COLUMNS} FROM quota_pools WHERE group_id = $1 ORDER BY created_at ASC, id ASC`;
  const params: unknown[] = [groupId];
  if (limit !== undefined && limit > 0) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    if (offset !== undefined) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
  }
  const rows = await db().query<PoolRow>(sql, params);
  return batchBuildPools(rows);
}

/**
 * List all quota pools with their allocations.
 */
export async function listPools(options?: { limit?: number; offset?: number }): Promise<{
  items: QuotaPool[];
  total: number;
}> {
  const limit = options?.limit;
  const offset = options?.offset;
  let sql = `SELECT ${POOL_COLUMNS} FROM quota_pools ORDER BY created_at ASC, id ASC`;
  const params: unknown[] = [];
  if (limit !== undefined && limit > 0) {
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    if (offset !== undefined) {
      params.push(offset);
      sql += ` OFFSET $${params.length}`;
    }
  }
  const rows = await db().query<PoolRow>(sql, params);
  const totalRow = await db().queryOne<{ cnt: number }>("SELECT count(*) AS cnt FROM quota_pools");
  return { items: await batchBuildPools(rows), total: totalRow?.cnt ?? 0 };
}

/**
 * Get a single pool by id, or null if not found.
 */
export async function getPool(id: string): Promise<QuotaPool | null> {
  const row = await db().queryOne<PoolRow>(
    `SELECT ${POOL_COLUMNS} FROM quota_pools WHERE id = $1`,
    [id]
  );
  if (!row) return null;
  return (await batchBuildPools([row]))[0];
}

/**
 * Create a new quota pool, optionally with initial allocations and member connections.
 * When `connectionIds` is provided, its first element becomes the primary connection.
 * When omitted, defaults to [connectionId].
 */
export async function createPool(input: PoolCreate): Promise<QuotaPool> {
  const id = makeId();

  // Resolve effective member list (primary first).
  const members = dedupe(
    input.connectionIds && input.connectionIds.length > 0
      ? input.connectionIds
      : [input.connectionId]
  );

  // Guard: a pool must use a single provider.
  if (input.connectionIds && input.connectionIds.length > 1) {
    await assertSingleProvider(input.connectionIds);
  }

  const groupId = input.groupId || "group-demo";

  const result = await db().transaction(async (tx) => {
    const row = await tx.queryOne<PoolRow>(
      `INSERT INTO quota_pools (id, name, group_id) VALUES ($1, $2, $3) RETURNING ${POOL_COLUMNS}`,
      [id, input.name, groupId]
    );
    await insertMembers(tx, id, members);
    if (input.allocations && input.allocations.length > 0) {
      await replaceAllocations(tx, id, input.allocations);
    }
    return (await batchBuildPools([row as PoolRow], tx))[0];
  });

  // Phase B2: fire-and-forget combo sync; failures are logged but never thrown.
  void serializeQuotaComboMaintenance(id, () => syncQuotaCombosGuarded(id));

  invalidateModelCatalogCache();

  return result;
}

function allocationFingerprint(allocations: PoolAllocation[] = []): string {
  return JSON.stringify(
    allocations
      .map((allocation) => ({
        apiKeyId: allocation.apiKeyId,
        weight: allocation.weight,
        capValue: allocation.capValue ?? null,
        capUnit: allocation.capUnit ?? null,
        policy: allocation.policy,
      }))
      .sort((left, right) => left.apiKeyId.localeCompare(right.apiKeyId))
  );
}

/** Idempotent pool management for automation and bounded CLI callers. */
export async function ensurePool(input: PoolCreate): Promise<EnsurePoolResult> {
  const members =
    input.connectionIds && input.connectionIds.length > 0
      ? input.connectionIds
      : [input.connectionId];
  const groupId = input.groupId || "group-demo";
  const existing = (await listPools()).items.find((pool) => {
    return pool.name === input.name && pool.groupId === groupId;
  });

  if (!existing) return { pool: await createPool(input), created: true, updated: false };

  const allocationsChanged =
    input.allocations !== undefined &&
    allocationFingerprint(existing.allocations) !== allocationFingerprint(input.allocations);
  const membersChanged =
    existing.connectionIds.length !== members.length ||
    existing.connectionIds.some((id) => !members.includes(id));
  if (!allocationsChanged && !membersChanged) {
    return { pool: existing, created: false, updated: false };
  }

  const update: PoolUpdate = { connectionIds: members };
  if (input.allocations !== undefined) update.allocations = input.allocations;
  if (input.groupId !== undefined) update.groupId = input.groupId;
  const updated = await updatePool(existing.id, update);
  if (!updated) throw new Error(`Quota pool disappeared during ensure: ${existing.id}`);
  return { pool: updated, created: false, updated: true };
}

/**
 * Update an existing pool's name, allocations, and/or member connections.
 * Returns updated pool, or null if pool not found.
 * When `connectionIds` is provided, the membership is replaced atomically with
 * `position` = array index (the unique position check runs at commit).
 */
export async function updatePool(id: string, input: PoolUpdate): Promise<QuotaPool | null> {
  if (deletingPools.has(id)) return null;

  const exists = await db().queryOne<{ id: string }>("SELECT id FROM quota_pools WHERE id = $1", [
    id,
  ]);
  if (!exists) return null;

  // Guard: a pool must use a single provider.
  if (input.connectionIds && input.connectionIds.length > 1) {
    await assertSingleProvider(input.connectionIds);
  }

  const result = await db().transaction(async (tx) => {
    // Serializes concurrent edits of one pool: two membership replacements would otherwise both
    // delete the same old rows and then collide on the re-insert.
    const locked = await tx.queryOne<{ id: string }>(
      "SELECT id FROM quota_pools WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!locked) return null;

    if (input.name !== undefined) {
      await tx.execute("UPDATE quota_pools SET name = $1 WHERE id = $2", [input.name, id]);
    }

    if (input.groupId !== undefined) {
      await tx.execute("UPDATE quota_pools SET group_id = $1 WHERE id = $2", [input.groupId, id]);
    }

    if (input.connectionIds !== undefined && input.connectionIds.length > 0) {
      await tx.execute("DELETE FROM quota_pool_connections WHERE pool_id = $1", [id]);
      await insertMembers(tx, id, dedupe(input.connectionIds));
    }

    if (input.allocations !== undefined) {
      await replaceAllocations(tx, id, input.allocations);
    }

    const row = await tx.queryOne<PoolRow>(`SELECT ${POOL_COLUMNS} FROM quota_pools WHERE id = $1`, [
      id,
    ]);
    return row ? (await batchBuildPools([row], tx))[0] : null;
  });
  if (!result) return null;

  // Phase B2: fire-and-forget combo sync; failures are logged but never thrown.
  void serializeQuotaComboMaintenance(id, () => syncQuotaCombosGuarded(id));

  invalidateModelCatalogCache();

  return result;
}

/**
 * Delete a pool by id. Memberships, allocations (with their model caps) and
 * schedules go with it through their foreign keys.
 * Returns true if a row was deleted, false if not found.
 */
export async function deletePool(id: string): Promise<boolean> {
  if (deletingPools.has(id)) return false;
  const exists = await db().queryOne<{ id: string }>("SELECT id FROM quota_pools WHERE id = $1", [
    id,
  ]);
  if (!exists) return false;
  deletingPools.add(id);

  const deletion = serializeQuotaComboMaintenance(id, async () => {
    // Phase B2: remove quota combos BEFORE deleting the pool row so that
    // removeQuotaCombosForPool can still resolve the pool name → slug.
    await removeQuotaCombosGuarded(id);

    const deleted = await db().transaction(async (tx) => {
      // Prune this pool id from every key's allowed_quotas JSON array.
      await tx.execute(
        `UPDATE api_keys SET allowed_quotas = COALESCE(
           (SELECT jsonb_agg(v) FROM jsonb_array_elements(api_keys.allowed_quotas) AS v
            WHERE v <> to_jsonb($1::text)),
           '[]'::jsonb)
         WHERE allowed_quotas @> jsonb_build_array($1::text)`,
        [id]
      );
      return tx.execute("DELETE FROM quota_pools WHERE id = $1", [id]);
    });
    if (deleted.changes <= 0) return false;

    // Direct rewrite of key permission metadata happens above; clear API-key
    // caches so any primed permission entries pick up the new allowed_quotas set.
    clearApiKeyCaches();
    invalidateModelCatalogCache();

    return true;
  });
  const clearDeleting = () => deletingPools.delete(id);
  void deletion.then(clearDeleting, clearDeleting);
  return deletion;
}

/**
 * Replace all allocations for a pool with the provided list,
 * and propagate the same allocation rows to EVERY other pool in the same group.
 *
 * Task B6 — Group-level allocation propagation:
 * A key allocated to any pool of group G should be able to call any other
 * pool's model in G and have fair-share enforced. The mechanism is propagation:
 * we write the identical key/weight/cap/policy rows to every pool in the group
 * so that whichever pool's model the key calls, that pool already has the
 * allocation row for the key → enforceQuotaShare finds it and applies weight.
 *
 * Propagation semantics:
 * - The target pool (poolId) is the authoritative source; its allocations replace
 *   the allocations in every sibling pool in the same group.
 * - Idempotent: upsert the listed keys and delete the rest, per pool.
 * - Single-pool group: trivially correct — the group loop has exactly one pool.
 * - Cross-group isolation: pools in OTHER groups are never touched.
 *
 * Exclusivity reconciliation (reconcilePoolExclusivity, Phase C3):
 * That function operates at the key's allowedQuotas level and is invoked at the
 * API route layer (src/app/api/quota/pools/[id]/route.ts PATCH handler) after
 * updatePool, NOT inside upsertAllocations. We do NOT call reconcilePoolExclusivity
 * here to avoid double-firing side-effects on sibling pools.
 *
 * Combo sync (Phase B2):
 * Only the target pool triggers syncQuotaCombosGuarded. Sibling pools are already
 * synced whenever they themselves are created/updated; propagation only affects
 * allocation rows, not the pool's combo catalog.
 *
 * Runs atomically: all pool writes are inside a single transaction.
 */
export async function upsertAllocations(
  poolId: string,
  allocations: PoolAllocation[]
): Promise<void> {
  if (deletingPools.has(poolId)) return;

  // Normalize: when all weights are 0, distribute equally so the pool is usable
  // without requiring a manual re-save. Persists the normalized weights.
  const totalWeight = allocations.reduce(
    (s, a) => s + (Number.isFinite(a.weight) ? a.weight : 0),
    0
  );
  const normalizedAllocations =
    totalWeight === 0 && allocations.length > 0
      ? allocations.map((a) => ({ ...a, weight: 100 / allocations.length }))
      : allocations;

  await db().transaction(async (tx) => {
    // Resolve the target pool's group so we can propagate to siblings.
    // Defensive: fall back to [poolId] (single-pool semantics) if pool not found.
    const targetPool = await tx.queryOne<PoolRow>(
      `SELECT ${POOL_COLUMNS} FROM quota_pools WHERE id = $1`,
      [poolId]
    );

    // Collect all pools in the group (includes the target pool itself).
    let poolIdsInGroup: string[] = [poolId];
    if (targetPool?.group_id) {
      const groupRows = await tx.query<{ id: string }>(
        "SELECT id FROM quota_pools WHERE group_id = $1 ORDER BY id",
        [targetPool.group_id]
      );
      if (groupRows.length > 0) poolIdsInGroup = groupRows.map((r) => r.id);
    }

    for (const pid of poolIdsInGroup) {
      await replaceAllocations(tx, pid, normalizedAllocations);
    }
  });

  // Phase B2: fire-and-forget combo sync for the target pool only; failures are
  // logged but never thrown. Sibling pools' combos are synced on their own lifecycle.
  void serializeQuotaComboMaintenance(poolId, () => syncQuotaCombosGuarded(poolId));
}

/**
 * List all allocations across all pools where apiKeyId is assigned.
 * Returns pairs of { poolId, allocation }.
 */
export async function listAllocationsForApiKey(
  apiKeyId: string
): Promise<Array<{ poolId: string; allocation: PoolAllocation }>> {
  const rows = await db().query<AllocationRow>(
    `SELECT pool_id, api_key_id, weight, cap_value, cap_unit, policy
     FROM quota_allocations
     WHERE api_key_id = $1`,
    [apiKeyId]
  );
  return rows.map((row) => ({ poolId: row.pool_id, allocation: rowToAllocation(row) }));
}

/**
 * Sync quota combos for all pools associated with a provider.
 * Triggered when custom models or synced models change for that provider.
 */
export async function syncQuotaCombosForProvider(providerId: string): Promise<void> {
  try {
    const { items: pools } = await listPools();
    for (const pool of pools) {
      let matches = false;
      const connectionIds = pool.connectionIds?.length ? pool.connectionIds : [pool.connectionId];
      for (const connId of connectionIds) {
        if (!connId) continue;
        const conn = (await getCachedProviderConnectionById(connId).catch(() => null)) as {
          provider?: string;
        } | null;
        if (conn?.provider === providerId) {
          matches = true;
          break;
        }
      }
      if (matches) {
        void serializeQuotaComboMaintenance(pool.id, () => syncQuotaCombosGuarded(pool.id));
      }
    }
  } catch (err) {
    console.warn(
      "[quota-pools] syncQuotaCombosForProvider failed (non-fatal):",
      (err as Error)?.message
    );
  }
}
