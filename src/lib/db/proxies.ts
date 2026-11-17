// Convention: when type is a relay (vercel | deno | cloudflare), the `notes` column stores JSON
// { relayAuth: "<token>" } used by proxyFetch.ts to route requests through the relay edge function
// (Vercel Edge, Deno Deploy, or Cloudflare Workers) instead of an undici ProxyAgent. All relay
// types share the exact same x-relay-target / x-relay-path / x-relay-auth header spec; only the
// deployment surface differs.
import { randomUUID } from "crypto";
import { db, type DbExecutor } from "@/lib/db/pg";
import type {
  JsonRecord,
  ProxyRegistryRecord,
  ProxyAssignmentRecord,
  ProxyPayload,
  ProxyAssignmentPayload,
  ProxyMutationResult,
  LegacyProxyClearStatus,
  ProxyTransactionResult,
  LegacyProxyConfig,
  ProxyRotationStrategy,
} from "./proxies/types";
import {
  isScopeIdMissing,
  mapProxyRow,
  mapAssignmentRow,
  normalizeScope,
  normalizeAssignmentScopeId,
  toLegacyProxyLevel,
  coerceProxyPayload,
  redactProxySecrets,
} from "./proxies/mappers";
import { isGlobalProxyEnabled } from "./proxies/guards";
import { bumpProxyRegistryGeneration } from "./proxies/registryGeneration";
import { appendProxiesToScopePool } from "./proxies/scopePool";
import { decryptProxyPassword, encryptProxyPassword, stripNul } from "./proxies/sanitize";
import { isProxyRegistryStatus } from "@/shared/constants/proxyRegistryStatus";
export {
  hasBlockingProxyAssignment,
  hasBlockingProxyAssignmentForProvider,
} from "./proxies/guards";
export { extractRelayAuth, redactProxySecrets } from "./proxies/mappers";
export { addProxiesToScopePool } from "./proxySubscriptions";
export {
  bumpProxyRegistryGeneration,
  getProxyRegistryGeneration,
} from "./proxies/registryGeneration";
import {
  normalizeRotationScopeId,
  clearRotationState,
  resetRotationCursor,
  normalizeRotationStrategy,
  getScopePoolEgressRows,
  getScopeProxyPool,
  getScopeRotationStrategy,
  resolveProxyForConnectionFromRegistry,
  resolveProxyForScopeFromRegistry,
} from "./proxies/rotation";
export {
  getScopePoolEgressRows,
  getScopeProxyPool,
  getScopeRotationStrategy,
  resolveProxyForConnectionFromRegistry,
  resolveProxyForScopeFromRegistry,
};

const PROXY_COLUMNS =
  "id, name, type, host, port, username, password, region, notes, status, source, family, subscription_id, created_at, updated_at";
const ASSIGNMENT_COLUMNS = "id, proxy_id, scope, scope_id, position, created_at, updated_at";

function readProxyRow(row: unknown): ProxyRegistryRecord {
  const proxy = mapProxyRow(row);
  return { ...proxy, password: decryptProxyPassword(proxy.password) };
}

async function assertSubscriptionExists(
  executor: DbExecutor,
  subscriptionId: string
): Promise<void> {
  const row = await executor.queryOne("SELECT 1 AS one FROM proxy_subscriptions WHERE id = $1", [
    subscriptionId,
  ]);
  if (!row) {
    const err = new Error("Subscription not found") as Error & { status?: number };
    err.status = 404;
    throw err;
  }
}

async function writeProxyConfigEntry(
  executor: DbExecutor,
  key: string,
  valueJson: string
): Promise<void> {
  await executor.execute(
    `INSERT INTO config_entries (namespace, key, value, updated_at)
     VALUES ('proxyConfig', $1, $2::jsonb, now())
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, valueJson]
  );
}

// Mutate legacy proxyConfig rows directly so these writes stay inside the same
// transaction as the proxy registry row and assignment upsert.
async function clearLegacyProxyForAssignment(
  executor: DbExecutor,
  assignment: ProxyAssignmentPayload
): Promise<LegacyProxyClearStatus> {
  const normalizedScope = normalizeScope(assignment.scope);
  const scopeId = normalizeAssignmentScopeId(normalizedScope, assignment.scopeId);
  const level = toLegacyProxyLevel(normalizedScope);

  if (level === "global") {
    const row = await executor.queryOne<{ value: unknown }>(
      "SELECT value FROM config_entries WHERE namespace = 'proxyConfig' AND key = 'global' FOR UPDATE"
    );
    if (!row) return "absent";
    if (row.value === null) return "absent";

    await writeProxyConfigEntry(executor, "global", JSON.stringify(null));
    return "cleared";
  }

  if (!scopeId) return "absent";

  const mapKey = `${level}s`;
  const row = await executor.queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace = 'proxyConfig' AND key = $1 FOR UPDATE",
    [mapKey]
  );
  if (!row) return "absent";

  let map: JsonRecord = {};
  let shouldWrite = false;
  const stored = row.value;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    map = stored as JsonRecord;
  } else {
    shouldWrite = true;
  }

  if (Object.prototype.hasOwnProperty.call(map, scopeId)) {
    delete map[scopeId];
    shouldWrite = true;
  }

  if (!shouldWrite) return "absent";

  await writeProxyConfigEntry(executor, mapKey, JSON.stringify(map));
  return "cleared";
}

async function insertProxyRow(
  executor: DbExecutor,
  id: string,
  payload: ProxyPayload,
  now: string
): Promise<void> {
  await executor.execute(
    `INSERT INTO proxy_registry
      (id, name, type, host, port, username, password, region, notes, status, source, family, subscription_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
    [
      id,
      stripNul(payload.name),
      payload.type,
      stripNul(payload.host),
      Number(payload.port),
      stripNul(payload.username || ""),
      encryptProxyPassword(payload.password || ""),
      stripNul(payload.region || null),
      stripNul(payload.notes || null),
      payload.status || "active",
      payload.source || "manual",
      payload.family || "auto",
      payload.subscriptionId ?? null,
      now,
    ]
  );
}

async function updateProxyRow(
  executor: DbExecutor,
  id: string,
  existing: ProxyRegistryRecord,
  payload: Partial<ProxyPayload>,
  now: string
): Promise<void> {
  const incomingUsername =
    typeof payload.username === "string" ? payload.username.trim() : undefined;
  const incomingPassword =
    typeof payload.password === "string" ? payload.password.trim() : undefined;

  const merged = {
    ...existing,
    ...payload,
    // Omitted credentials mean preserve; explicitly provided blanks clear stored auth.
    username: incomingUsername === undefined ? existing.username : incomingUsername,
    password: incomingPassword === undefined ? existing.password : incomingPassword,
    // subscription_id: only override when the caller explicitly passes it (string|null);
    // otherwise preserve whatever the existing row already carries.
    subscriptionId:
      payload.subscriptionId === undefined ? existing.subscriptionId : payload.subscriptionId,
    updatedAt: now,
  };

  await executor.execute(
    `UPDATE proxy_registry
       SET name = $1, type = $2, host = $3, port = $4, username = $5, password = $6, region = $7, notes = $8, status = $9, source = $10, family = $11, subscription_id = $12, updated_at = $13
     WHERE id = $14`,
    [
      stripNul(merged.name),
      merged.type,
      stripNul(merged.host),
      Number(merged.port),
      stripNul(merged.username || ""),
      encryptProxyPassword(merged.password || ""),
      stripNul(merged.region || null),
      stripNul(merged.notes || null),
      merged.status || "active",
      merged.source || "manual",
      merged.family || "auto",
      merged.subscriptionId ?? null,
      merged.updatedAt,
      id,
    ]
  );
}

async function upsertAssignmentRow(
  executor: DbExecutor,
  assignment: ProxyAssignmentPayload,
  proxyId: string,
  now: string
): Promise<void> {
  const normalizedScope = normalizeScope(assignment.scope);
  const normalizedScopeId = normalizeAssignmentScopeId(normalizedScope, assignment.scopeId);
  // Contract: normalizedScope is already normalized — the raw-scope guard applies to it directly.
  if (isScopeIdMissing(normalizedScope, normalizedScopeId) || normalizedScopeId === null) {
    throw new Error("scopeId is required for non-global proxy assignments");
  }

  // Single-assignment (replace) semantics: since #6365 lifted UNIQUE(scope,
  // scope_id) to allow proxy POOLS, this path keeps the legacy behavior where a
  // scope resolves to exactly one proxy — clear any existing pool and set a
  // 1-element pool at position 0. Pools are built explicitly via
  // addProxyToScopePool().
  await replaceScopeWithSingleProxy(executor, normalizedScope, normalizedScopeId, proxyId, now);
}

// Replace whatever proxies are attached to (scope, scope_id) with a single proxy
// at position 0. Callers run it inside a transaction so the delete and the
// insert are one unit.
async function replaceScopeWithSingleProxy(
  executor: DbExecutor,
  normalizedScope: string,
  normalizedScopeId: string,
  proxyId: string,
  now: string
): Promise<void> {
  await executor.execute("DELETE FROM proxy_assignments WHERE scope = $1 AND scope_id = $2", [
    normalizedScope,
    normalizedScopeId,
  ]);
  await executor.execute(
    `INSERT INTO proxy_assignments (proxy_id, scope, scope_id, position, created_at, updated_at)
     VALUES ($1, $2, $3, 0, $4, $4)`,
    [proxyId, normalizedScope, normalizedScopeId, now]
  );
}

async function getAssignmentRow(
  executor: DbExecutor,
  scope: string,
  scopeId?: string | null
): Promise<ProxyAssignmentRecord | null> {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeAssignmentScopeId(normalizedScope, scopeId);
  if (normalizedScopeId === null) return null;
  const row = await executor.queryOne(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM proxy_assignments WHERE scope = $1 AND scope_id = $2 ORDER BY position ASC, id ASC LIMIT 1`,
    [normalizedScope, normalizedScopeId]
  );
  return row ? mapAssignmentRow(row) : null;
}

export async function listProxies(options?: {
  includeSecrets?: boolean;
  limit?: number;
  offset?: number;
}) {
  const includeSecrets = options?.includeSecrets === true;
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  let sql = `SELECT ${PROXY_COLUMNS} FROM proxy_registry ORDER BY updated_at DESC, name ASC`;
  const params: unknown[] = [];
  if (limit !== undefined) {
    sql += " LIMIT $1 OFFSET $2";
    params.push(limit, offset);
  }
  const rows = await db().query(sql, params);
  const totalRow = await db().queryOne<{ cnt: number }>(
    "SELECT count(*) AS cnt FROM proxy_registry"
  );
  const proxies = rows.map(readProxyRow);
  return {
    items: includeSecrets ? proxies : proxies.map(redactProxySecrets),
    total: Number(totalRow?.cnt ?? 0),
  };
}

export async function getProxyById(id: string, options?: { includeSecrets?: boolean }) {
  return getProxyRowById(db(), id, options);
}

async function getProxyRowById(
  executor: DbExecutor,
  id: string,
  options?: { includeSecrets?: boolean; forUpdate?: boolean }
): Promise<ProxyRegistryRecord | null> {
  const includeSecrets = options?.includeSecrets === true;
  const row = await executor.queryOne(
    `SELECT ${PROXY_COLUMNS} FROM proxy_registry WHERE id = $1${options?.forUpdate ? " FOR UPDATE" : ""}`,
    [id]
  );
  if (!row) return null;
  const proxy = readProxyRow(row);
  return includeSecrets ? proxy : redactProxySecrets(proxy);
}

async function getProxyRowByIdOrThrow(
  executor: DbExecutor,
  id: string,
  options?: { includeSecrets?: boolean }
): Promise<ProxyRegistryRecord> {
  const proxy = await getProxyRowById(executor, id, options);
  if (!proxy) {
    throw new Error(`Failed to read proxy after mutation: ${id}`);
  }
  return proxy;
}

export async function createProxy(payload: ProxyPayload) {
  const id = randomUUID();
  const now = new Date().toISOString();

  await insertProxyRow(db(), id, payload, now);

  bumpProxyRegistryGeneration();
  return getProxyById(id, { includeSecrets: false });
}

/**
 * Upsert a proxy by its identity tuple (host+port+username).
 * If a proxy with the same host, port, and username already exists, update it.
 * Otherwise, create a new one. Used by the bulk import feature.
 *
 * #7594: host+port alone is NOT a stable identity. Rotating residential/gateway
 * proxies route every credential through one shared host:port, so keying only on
 * host+port collapsed distinct-credential imports onto the first existing row
 * (the same entry got "updated" N times instead of N entries being created).
 *
 * #7703: password is mutable and must not be part of the identity key. Including
 * it caused password-only credential rotations to create duplicate entries.
 *
 * The identity has no unique index, so the lookup and the write run in one
 * transaction under a per-identity advisory lock: two concurrent imports of the
 * same tuple cannot both insert.
 *
 * On an existing row the status is written only when the payload carries a valid one,
 * so a write that omits it never revives a proxy the operator or auto-disable turned off.
 *
 * `claimOwnership: false` is reserved for subscription sync: a matched row whose
 * subscription_id differs from the payload's (manual rows included), or whose source
 * differs from the payload's (a manual row attached to the subscription by id), is not
 * written at all and the call returns `action: "skipped"`. The sync always sends its subscriptionId:
 * a caller that omits it would find manual rows (null === null) counted as owned.
 *
 * `type` may be omitted: a matched row keeps its stored type, a new row gets "http"
 * (the single-create default). Defaulting it in the import schema instead would
 * rewrite an existing socks5 row to http on a re-import that leaves `type` out.
 */
type ProxyUpsertPayload = Omit<ProxyPayload, "type"> & { type?: string };

export async function upsertProxy(
  payload: ProxyUpsertPayload
): Promise<{ proxy: ProxyRegistryRecord | null; action: "created" | "updated" }>;
export async function upsertProxy(
  payload: ProxyUpsertPayload,
  options: { claimOwnership?: boolean }
): Promise<{ proxy: ProxyRegistryRecord | null; action: "created" | "updated" | "skipped" }>;
export async function upsertProxy(
  payload: ProxyUpsertPayload,
  options: { claimOwnership?: boolean } = {}
): Promise<{ proxy: ProxyRegistryRecord | null; action: "created" | "updated" | "skipped" }> {
  const host = (payload.host || "").trim();
  const port = Number(payload.port);
  const username = (payload.username || "").trim();

  const outcome = await db().transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `proxy_registry:${host}:${port}:${username}`,
    ]);
    const existing = await tx.queryOne<{
      id: string;
      subscription_id: string | null;
      source: string | null;
    }>(
      "SELECT id, subscription_id, source FROM proxy_registry WHERE host = $1 AND port = $2 AND COALESCE(username, '') = $3 ORDER BY created_at ASC, id ASC LIMIT 1",
      [host, port, username]
    );

    if (existing) {
      const claimOwnership = options.claimOwnership ?? true;
      const ownerChanged = (existing.subscription_id ?? null) !== (payload.subscriptionId ?? null);
      // A manual row attached to the subscription by id shares its owner but not its
      // source: the sync must not rewrite it into a synced row (which a later feed
      // omission would then delete).
      const sourceChanged =
        payload.source !== undefined && (existing.source ?? "manual") !== payload.source;
      if (!claimOwnership && (ownerChanged || sourceChanged)) {
        return { id: null, action: "skipped" as const };
      }
      const { status, ...rest } = payload;
      const changes: Partial<ProxyPayload> = isProxyRegistryStatus(status)
        ? { ...rest, status }
        : rest;
      // Sync and import paths delegate here with an already-proven subscription
      // (sync checks the subscription once up front; import payloads never carry
      // one), so the existence check is skipped on this path. Route updates go
      // through updateProxy directly and keep the check.
      await updateProxyInTx(tx, existing.id, changes, { skipSubscriptionCheck: true });
      return { id: existing.id, action: "updated" as const };
    }

    const id = randomUUID();
    await insertProxyRow(tx, id, { ...payload, type: payload.type ?? "http" }, new Date().toISOString());
    return { id, action: "created" as const };
  });

  if (outcome.action === "skipped") return { proxy: null, action: "skipped" };
  bumpProxyRegistryGeneration();
  const proxy = await getProxyById(outcome.id as string, { includeSecrets: false });
  return { proxy, action: outcome.action };
}

async function updateProxyInTx(
  tx: DbExecutor,
  id: string,
  payload: Partial<ProxyPayload>,
  options?: { skipSubscriptionCheck?: boolean }
): Promise<boolean> {
  // Row lock: the merge below reads the stored credentials, so two concurrent
  // partial updates must not both start from the same snapshot.
  const existing = await getProxyRowById(tx, id, { includeSecrets: true, forUpdate: true });
  if (!existing) return false;

  if (
    !options?.skipSubscriptionCheck &&
    payload.subscriptionId !== undefined &&
    payload.subscriptionId !== null
  ) {
    await assertSubscriptionExists(tx, payload.subscriptionId);
  }

  await updateProxyRow(tx, id, existing, payload, new Date().toISOString());
  return true;
}

export async function updateProxy(
  id: string,
  payload: Partial<ProxyPayload>,
  options?: { skipSubscriptionCheck?: boolean }
) {
  // No status filtering here: callers own the status they send. Writes that must
  // preserve the stored status filter it in upsertProxy before calling this.
  const updated = await db().transaction((tx) => updateProxyInTx(tx, id, payload, options));
  if (!updated) return null;

  bumpProxyRegistryGeneration();
  return getProxyById(id, { includeSecrets: false });
}

export async function createProxyAndAssign(
  payload: ProxyPayload,
  assignment: ProxyAssignmentPayload
): Promise<ProxyMutationResult> {
  const id = randomUUID();
  const now = new Date().toISOString();

  const result = await db().transaction(async (tx): Promise<ProxyTransactionResult> => {
    await insertProxyRow(tx, id, payload, now);
    await upsertAssignmentRow(tx, assignment, id, now);
    const legacyClearStatus = await clearLegacyProxyForAssignment(tx, assignment);
    return {
      legacyClearStatus,
      proxy: await getProxyRowByIdOrThrow(tx, id, { includeSecrets: false }),
      assignment: await getAssignmentRow(tx, assignment.scope, assignment.scopeId),
    };
  });

  bumpProxyRegistryGeneration();
  if (result.legacyClearStatus === "cleared") {
    // Dynamic import avoids a static proxies.ts -> settings.ts cycle; settings.ts
    // imports registry helpers for proxy resolution.
    const { bumpProxyConfigGeneration } = await import("./settings");
    bumpProxyConfigGeneration();
  }
  return {
    proxy: result.proxy,
    assignment: result.assignment,
  };
}

export async function updateProxyAndAssign(
  id: string,
  payload: Partial<ProxyPayload>,
  assignment: ProxyAssignmentPayload
): Promise<ProxyMutationResult | null> {
  const now = new Date().toISOString();

  const result = await db().transaction(async (tx): Promise<ProxyTransactionResult | null> => {
    const existing = await getProxyRowById(tx, id, { includeSecrets: true, forUpdate: true });
    if (!existing) return null;

    if (payload.subscriptionId !== undefined && payload.subscriptionId !== null) {
      await assertSubscriptionExists(tx, payload.subscriptionId);
    }

    await updateProxyRow(tx, id, existing, payload, now);
    await upsertAssignmentRow(tx, assignment, id, now);
    const legacyClearStatus = await clearLegacyProxyForAssignment(tx, assignment);
    return {
      legacyClearStatus,
      proxy: await getProxyRowByIdOrThrow(tx, id, { includeSecrets: false }),
      assignment: await getAssignmentRow(tx, assignment.scope, assignment.scopeId),
    };
  });
  if (!result) return null;

  bumpProxyRegistryGeneration();
  if (result.legacyClearStatus === "cleared") {
    // Dynamic import avoids a static proxies.ts -> settings.ts cycle; settings.ts
    // imports registry helpers for proxy resolution.
    const { bumpProxyConfigGeneration } = await import("./settings");
    bumpProxyConfigGeneration();
  }
  return {
    proxy: result.proxy,
    assignment: result.assignment,
  };
}

export async function getProxyAssignments(filters?: { proxyId?: string; scope?: string }) {
  if (filters?.proxyId) {
    const rows = await db().query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM proxy_assignments WHERE proxy_id = $1 ORDER BY scope, scope_id`,
      [filters.proxyId]
    );
    return rows.map(mapAssignmentRow);
  }

  if (filters?.scope) {
    const rows = await db().query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM proxy_assignments WHERE scope = $1 ORDER BY scope_id`,
      [normalizeScope(filters.scope)]
    );
    return rows.map(mapAssignmentRow);
  }

  const rows = await db().query(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM proxy_assignments ORDER BY scope, scope_id`
  );
  return rows.map(mapAssignmentRow);
}

export async function getProxyWhereUsed(proxyId: string) {
  return proxyWhereUsed(db(), proxyId);
}

async function proxyWhereUsed(executor: DbExecutor, proxyId: string) {
  const rows = (
    await executor.query(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM proxy_assignments WHERE proxy_id = $1 ORDER BY scope, scope_id`,
      [proxyId]
    )
  ).map(mapAssignmentRow);

  // Only connections that carry an accountProxies array can reference a proxy.
  const connectionRows = await executor.query<{
    id?: string;
    provider?: string;
    provider_specific_data?: unknown;
  }>(
    `SELECT id, provider, provider_specific_data FROM provider_connections
      WHERE jsonb_typeof(provider_specific_data -> 'accountProxies') = 'array'
      ORDER BY created_at, id`
  );
  const accountReferences: Array<{
    connectionId: string;
    provider: string;
    accountCount: number;
  }> = [];
  let accountReferenceCount = 0;
  for (const connection of connectionRows) {
    if (typeof connection.id !== "string" || typeof connection.provider !== "string") continue;
    const providerSpecificData = connection.provider_specific_data;
    if (!providerSpecificData || typeof providerSpecificData !== "object") continue;
    const accountProxies = (providerSpecificData as { accountProxies?: unknown }).accountProxies;
    if (!Array.isArray(accountProxies)) continue;
    const accountCount = accountProxies.filter(
      (entry) =>
        !!entry && typeof entry === "object" && (entry as { proxyId?: unknown }).proxyId === proxyId
    ).length;
    if (accountCount === 0) continue;
    accountReferenceCount += accountCount;
    accountReferences.push({
      connectionId: connection.id,
      provider: connection.provider,
      accountCount,
    });
  }

  return {
    count: rows.length + accountReferenceCount,
    assignmentCount: rows.length,
    assignments: rows,
    accountReferenceCount,
    accountReferences,
  };
}

export async function assignProxyToScope(
  scope: string,
  scopeId: string | null,
  proxyId: string | null
): Promise<ProxyAssignmentRecord | null> {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeAssignmentScopeId(normalizedScope, scopeId);
  // Contract: scope already normalized above — the raw-scope guard applies to it directly.
  if (isScopeIdMissing(normalizedScope, normalizedScopeId) || normalizedScopeId === null) {
    throw new Error("scopeId is required for non-global proxy assignments");
  }

  if (!proxyId) {
    await db().transaction(async (tx) => {
      await tx.execute("DELETE FROM proxy_assignments WHERE scope = $1 AND scope_id = $2", [
        normalizedScope,
        normalizedScopeId,
      ]);
      await clearRotationState(tx, normalizedScope, normalizedScopeId);
    });
    bumpProxyRegistryGeneration();
    return null;
  }

  const proxy = await getProxyById(proxyId, { includeSecrets: true });
  if (!proxy) {
    const err = new Error(`Proxy not found: ${proxyId}`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const now = new Date().toISOString();
  // Replace semantics (#6365): a plain assignProxyToScope always yields a
  // 1-element pool. Reset any round-robin cursor so the fresh single assignment
  // starts clean. Multi-proxy pools are built via addProxyToScopePool().
  const assignment = await db().transaction(async (tx) => {
    await replaceScopeWithSingleProxy(tx, normalizedScope, normalizedScopeId, proxyId, now);
    await resetRotationCursor(tx, normalizedScope, normalizedScopeId);
    return getAssignmentRow(tx, normalizedScope, normalizedScopeId);
  });

  bumpProxyRegistryGeneration();
  return assignment;
}

// ──────────────── Proxy Pools & Rotation (#6365) ────────────────
// Pure rotation helpers (cursor math, strategy normalization, alive-pool
// resolution) live in ./proxies/rotation.ts — imported above, re-exported below.

/**
 * Add a proxy to a scope's rotation POOL (#6365). Idempotent per
 * (scope, scope_id, proxy_id): re-adding the same proxy is a no-op. New members
 * are appended after the current highest `position` so round-robin order is stable.
 */
export async function addProxyToScopePool(
  scope: string,
  scopeId: string | null,
  proxyId: string
): Promise<ProxyAssignmentRecord | null> {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeAssignmentScopeId(normalizedScope, scopeId);
  // Contract: normalizedScope is already normalized — the raw-scope guard applies to it directly.
  if (isScopeIdMissing(normalizedScope, normalizedScopeId) || normalizedScopeId === null) {
    throw new Error("scopeId is required for non-global proxy assignments");
  }

  const proxy = await getProxyById(proxyId, { includeSecrets: true });
  if (!proxy) {
    const err = new Error(`Proxy not found: ${proxyId}`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const added = await appendProxiesToScopePool(db(), normalizedScope, normalizedScopeId, [
    proxyId,
  ]);
  if (added > 0) bumpProxyRegistryGeneration();

  const row = await db().queryOne(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM proxy_assignments WHERE scope = $1 AND scope_id = $2 AND proxy_id = $3 LIMIT 1`,
    [normalizedScope, normalizedScopeId, proxyId]
  );
  return row ? mapAssignmentRow(row) : null;
}

// addProxiesToScopePool moved to ./proxySubscriptions.ts to keep this file under
// the frozen size cap; re-exported below for existing callers.

/**
 * Remove one proxy from a scope's pool (#6365). Returns true if a row was deleted.
 * Leaves other pool members (and the rotation cursor) intact.
 */
export async function removeProxyFromScopePool(
  scope: string,
  scopeId: string | null,
  proxyId: string
): Promise<boolean> {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeAssignmentScopeId(normalizedScope, scopeId);
  if (normalizedScopeId === null) return false;
  const result = await db().execute(
    "DELETE FROM proxy_assignments WHERE scope = $1 AND scope_id = $2 AND proxy_id = $3",
    [normalizedScope, normalizedScopeId, proxyId]
  );
  if (result.changes > 0) bumpProxyRegistryGeneration();
  return result.changes > 0;
}

/**
 * Set the rotation strategy for a scope's pool (#6365). Unknown values fall back
 * to the default (`round-robin`). Preserves the existing cursor so switching to
 * and back from `random` does not reset round-robin fairness.
 */
export async function setScopeRotationStrategy(
  scope: string,
  scopeId: string | null,
  strategy: ProxyRotationStrategy | string,
  options?: { stickyWindowMinutes?: number }
): Promise<ProxyRotationStrategy> {
  const normalizedScope = normalizeScope(scope);
  const rotationScopeId = normalizeRotationScopeId(normalizedScope, scopeId);
  const normalizedStrategy = normalizeRotationStrategy(strategy);

  const stickyWindow =
    options?.stickyWindowMinutes !== undefined && Number.isFinite(options.stickyWindowMinutes)
      ? Math.max(1, Math.floor(options.stickyWindowMinutes))
      : null;

  if (stickyWindow !== null) {
    await db().execute(
      `INSERT INTO proxy_scope_rotation (scope, scope_id, strategy, sticky_window_minutes, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (scope, scope_id)
       DO UPDATE SET strategy = EXCLUDED.strategy, sticky_window_minutes = EXCLUDED.sticky_window_minutes, updated_at = EXCLUDED.updated_at`,
      [normalizedScope, rotationScopeId, normalizedStrategy, stickyWindow]
    );
  } else {
    await db().execute(
      `INSERT INTO proxy_scope_rotation (scope, scope_id, strategy, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (scope, scope_id)
       DO UPDATE SET strategy = EXCLUDED.strategy, updated_at = EXCLUDED.updated_at`,
      [normalizedScope, rotationScopeId, normalizedStrategy]
    );
  }

  bumpProxyRegistryGeneration();
  return normalizedStrategy;
}

export async function deleteProxyById(id: string, options?: { force?: boolean }) {
  const force = options?.force === true;
  const usage = await getProxyWhereUsed(id);

  if (!force && usage.count > 0) {
    const err = new Error(
      "Proxy is still in use. Remove assignments or account references first, or use force=true"
    ) as Error & {
      status?: number;
      code?: string;
      details?: unknown;
    };
    err.status = 409;
    err.code = "proxy_in_use";
    err.details = usage;
    throw err;
  }

  const deleted = await db().transaction(async (tx) => {
    if (force && usage.count > 0) {
      // Account proxyId references intentionally remain as unresolved required bindings.
      // Only an explicit account edit may unbind them; clearing them here would make
      // the next request silently fall back to direct egress.
      await tx.execute("DELETE FROM proxy_assignments WHERE proxy_id = $1", [id]);
    }
    const result = await tx.execute("DELETE FROM proxy_registry WHERE id = $1", [id]);
    return result.changes > 0;
  });
  bumpProxyRegistryGeneration();
  return deleted;
}

export async function migrateLegacyProxyConfigToRegistry(options?: { force?: boolean }) {
  const force = options?.force === true;

  const existingCountRow = await db().queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM proxy_registry"
  );
  const existingCount = Number(existingCountRow?.cnt || 0);
  if (!force && existingCount > 0) {
    return { migrated: 0, skipped: true, reason: "registry_not_empty" as const };
  }

  const rows = await db().query<{ key?: string; value?: unknown }>(
    "SELECT key, value FROM config_entries WHERE namespace = 'proxyConfig'"
  );

  const raw: LegacyProxyConfig = {};
  for (const row of rows) {
    if (!row?.key) continue;
    // jsonb arrives parsed: an object map, a proxy URL string or null.
    (raw as Record<string, unknown>)[row.key] = row.value;
  }

  let migrated = 0;

  if (raw.global) {
    const payload = coerceProxyPayload(raw.global, "Legacy Global Proxy");
    if (payload) {
      const created = await createProxy(payload);
      if (created?.id) {
        await assignProxyToScope("global", null, created.id);
        migrated++;
      }
    }
  }

  for (const [providerId, proxyValue] of Object.entries(raw.providers || {})) {
    const payload = coerceProxyPayload(proxyValue, `Legacy Provider Proxy (${providerId})`);
    if (!payload) continue;
    const created = await createProxy(payload);
    if (created?.id) {
      await assignProxyToScope("provider", providerId, created.id);
      migrated++;
    }
  }

  for (const [comboId, proxyValue] of Object.entries(raw.combos || {})) {
    const payload = coerceProxyPayload(proxyValue, `Legacy Combo Proxy (${comboId})`);
    if (!payload) continue;
    const created = await createProxy(payload);
    if (created?.id) {
      await assignProxyToScope("combo", comboId, created.id);
      migrated++;
    }
  }

  for (const [connectionId, proxyValue] of Object.entries(raw.keys || {})) {
    const payload = coerceProxyPayload(proxyValue, `Legacy Account Proxy (${connectionId})`);
    if (!payload) continue;
    const created = await createProxy(payload);
    if (created?.id) {
      await assignProxyToScope("account", connectionId, created.id);
      migrated++;
    }
  }

  return { migrated, skipped: false as const };
}

/**
 * Upstream failure spread grouped by provider, read from the proxy log. One row
 * per provider with real (non connection-test) requests since `since`, and per
 * exit (distinct proxy host + port) the attempts and 5xx counts behind that
 * provider. Providers with a null or blank name are excluded: they can never
 * own a regime line. Only numbers leave this function.
 */
export type ProviderUpstreamExit = { exit: string; attempts: number; serverErrors: number };

export type ProviderUpstreamRow = {
  provider: string;
  attempts: number;
  measured: number;
  serverErrors: number;
  exits: ProviderUpstreamExit[];
};

export async function getProviderUpstreamSummary(since: string): Promise<ProviderUpstreamRow[]> {
  const rows = await db().query<{
    provider: string;
    exit_host: string | null;
    exit_port: number | null;
    attempts: number;
    measured: number;
    server_errors: number;
  }>(
    `SELECT
       provider,
       proxy_host AS exit_host,
       proxy_port AS exit_port,
       COUNT(*) AS attempts,
       SUM(CASE WHEN upstream_status IS NOT NULL THEN 1 ELSE 0 END) AS measured,
       SUM(CASE WHEN upstream_status >= 500 AND upstream_status < 600 THEN 1 ELSE 0 END) AS server_errors
     FROM proxy_logs
     WHERE "timestamp" >= $1
       AND provider IS NOT NULL AND TRIM(provider) <> ''
       AND (target_url NOT LIKE '%/connection-test' OR target_url IS NULL)
     GROUP BY provider, proxy_host, proxy_port`,
    [since]
  );

  const byProvider = new Map<string, ProviderUpstreamRow>();
  for (const row of rows) {
    const provider = row.provider;
    let entry = byProvider.get(provider);
    if (!entry) {
      entry = { provider, attempts: 0, measured: 0, serverErrors: 0, exits: [] };
      byProvider.set(provider, entry);
    }
    const attempts = Number(row.attempts || 0);
    const measured = Number(row.measured || 0);
    const serverErrors = Number(row.server_errors || 0);
    entry.attempts += attempts;
    entry.measured += measured;
    entry.serverErrors += serverErrors;
    entry.exits.push({
      exit: `${row.exit_host ?? "?"}:${row.exit_port ?? "?"}`,
      attempts,
      serverErrors,
    });
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

export async function getProxyHealthStats(options?: { hours?: number }) {
  const hours = Math.max(1, Math.min(24 * 30, Number(options?.hours || 24)));
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = await db().query<Record<string, unknown>>(
    `SELECT
       p.id as proxy_id,
       p.name as proxy_name,
       p.type as proxy_type,
       p.host as proxy_host,
       p.port as proxy_port,
       p.status as proxy_status,
       COUNT(l.id) as total_requests,
       SUM(CASE WHEN l.status = 'success' THEN 1 ELSE 0 END) as success_count,
       SUM(CASE WHEN l.status = 'error' THEN 1 ELSE 0 END) as error_count,
       SUM(CASE WHEN l.status = 'timeout' THEN 1 ELSE 0 END) as timeout_count,
       SUM(CASE WHEN l.id IS NOT NULL AND l.target_url LIKE '%/connection-test' THEN 1 ELSE 0 END) as connection_tests,
       SUM(CASE WHEN l.id IS NOT NULL AND l.target_url LIKE '%/connection-test' AND l.status = 'success' THEN 1 ELSE 0 END) as connection_test_success,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) THEN 1 ELSE 0 END) as real_requests,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) AND l.upstream_status IS NOT NULL THEN 1 ELSE 0 END) as measured_requests,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) AND (l.upstream_status IS NOT NULL OR l.status = 'success') THEN 1 ELSE 0 END) as transport_ok,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) AND l.status IN ('error', 'timeout') AND l.upstream_status IS NULL AND NOT (COALESCE(l.attempt_issue, '') = 'abandoned' AND COALESCE(l.error, '') LIKE 'OpencodeHeadersWaitTimeout:%') AND NOT (l.attempt_issue IS NOT NULL AND COALESCE(l.error, '') LIKE '%Request aborted%') THEN 1 ELSE 0 END) as transport_failures,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) AND l.status IN ('error', 'timeout') AND l.upstream_status IS NULL AND COALESCE(l.attempt_issue, '') = 'abandoned' AND COALESCE(l.error, '') LIKE 'OpencodeHeadersWaitTimeout:%' THEN 1 ELSE 0 END) as slow_abandoned,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) AND l.status IN ('error', 'timeout') AND l.upstream_status IS NULL AND l.attempt_issue IS NOT NULL AND COALESCE(l.error, '') LIKE '%Request aborted%' THEN 1 ELSE 0 END) as client_aborted,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) AND l.upstream_status >= 400 AND l.upstream_status < 500 THEN 1 ELSE 0 END) as upstream_4xx,
       SUM(CASE WHEN l.id IS NOT NULL AND (l.target_url NOT LIKE '%/connection-test' OR l.target_url IS NULL) AND l.upstream_status >= 500 AND l.upstream_status < 600 THEN 1 ELSE 0 END) as upstream_5xx,
       AVG(CASE WHEN l.latency_ms IS NOT NULL THEN l.latency_ms END) as avg_latency_ms,
       MAX(l."timestamp") as last_seen_at
     FROM proxy_registry p
     LEFT JOIN proxy_logs l
       ON l.proxy_host = p.host
      AND l.proxy_type = p.type
      AND l.proxy_port = p.port
      AND l."timestamp" >= $1
     GROUP BY p.id, p.name, p.type, p.host, p.port
     ORDER BY p.name ASC`,
    [sinceIso]
  );

  return rows.map((row) => {
    const total = Number(row.total_requests || 0);
    const success = Number(row.success_count || 0);
    const error = Number(row.error_count || 0);
    const timeout = Number(row.timeout_count || 0);
    const successRate = total > 0 ? Math.round((success / total) * 10000) / 100 : null;
    const realRequests = Number(row.real_requests || 0);
    const transportOk = Number(row.transport_ok || 0);
    const transportFailures = Number(row.transport_failures || 0);
    const slowAbandoned = Number(row.slow_abandoned || 0);
    const clientAborted = Number(row.client_aborted || 0);
    const measuredRequests = Number(row.measured_requests || 0);
    const transportRate =
      !measuredRequests || transportOk + transportFailures === 0
        ? null
        : Math.round((transportOk / (transportOk + transportFailures)) * 10000) / 100;

    return {
      proxyId: String(row.proxy_id || ""),
      name: String(row.proxy_name || ""),
      type: String(row.proxy_type || "http"),
      host: String(row.proxy_host || ""),
      port: Number(row.proxy_port || 0),
      status: String(row.proxy_status || "active"),
      totalRequests: total,
      successCount: success,
      errorCount: error,
      timeoutCount: timeout,
      successRate,
      connectionTests: Number(row.connection_tests || 0),
      connectionTestSuccess: Number(row.connection_test_success || 0),
      realRequests,
      measuredRequests,
      measured: measuredRequests > 0,
      transportOk,
      transportFailures,
      slowAbandoned,
      clientAborted,
      transportRate,
      upstream4xx: Number(row.upstream_4xx || 0),
      upstream5xx: Number(row.upstream_5xx || 0),
      avgLatencyMs:
        row.avg_latency_ms === null || row.avg_latency_ms === undefined
          ? null
          : Math.round(Number(row.avg_latency_ms)),
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    };
  });
}

export async function bulkAssignProxyToScope(
  scope: string,
  scopeIds: string[],
  proxyId: string | null
): Promise<{ updated: number; failed: Array<{ scopeId: string; reason: string }> }> {
  const uniqueScopeIds = [
    ...new Set((scopeIds || []).map((id) => String(id).trim()).filter(Boolean)),
  ];
  const failed: Array<{ scopeId: string; reason: string }> = [];
  let updated = 0;

  if (scope === "global") {
    await assignProxyToScope("global", null, proxyId);
    return { updated: 1, failed: [] };
  }

  for (const scopeId of uniqueScopeIds) {
    try {
      await assignProxyToScope(scope, scopeId, proxyId);
      updated++;
    } catch (error) {
      failed.push({
        scopeId,
        reason: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { updated, failed };
}

/**
 * Resolve proxy for a provider (without connection ID).
 * Used during OAuth flow before connection is created.
 * Priority: provider-level → global → null
 */
export async function resolveProxyForProvider(providerId: string) {
  if (!(await isGlobalProxyEnabled())) return null;

  // Resolve by specificity across both storage backends. The GUI Custom tab
  // still writes provider/global proxies to the legacy config, while Saved
  // Proxy uses the registry. A registry-global fallback must not shadow a
  // more-specific legacy provider proxy (#2601).
  const registryProvider = await resolveProxyForScopeFromRegistry("provider", providerId);
  if (registryProvider?.proxy) return registryProvider.proxy;

  // Fallback: honor the legacy per-provider / global proxy config (set via
  // /api/settings/proxy?level=provider&id=...). The proxy registry only tracks
  // explicit assignments; without this fallback the OAuth token exchange and
  // token-refresh paths ignore a proxy configured the legacy way and connect
  // directly — which on a VPS trips Anthropic's IP rate limit (#2456).
  // resolveProxyForConnection already has this fallback; mirror it here.
  // Dynamic import avoids a static cycle (settings.ts imports from proxies.ts).
  const { getProxyForLevel } = await import("./settings");
  const legacyProvider = await getProxyForLevel("provider", providerId);
  if (legacyProvider && typeof legacyProvider === "object" && legacyProvider.host) {
    return {
      type: legacyProvider.type,
      host: legacyProvider.host,
      port: legacyProvider.port,
      username: legacyProvider.username,
      password: legacyProvider.password,
    };
  }

  const registryGlobal = await resolveProxyForScopeFromRegistry("global");
  if (registryGlobal?.proxy) return registryGlobal.proxy;

  const legacyGlobal = await getProxyForLevel("global");
  if (legacyGlobal && typeof legacyGlobal === "object" && legacyGlobal.host) {
    return {
      type: legacyGlobal.type,
      host: legacyGlobal.host,
      port: legacyGlobal.port,
      username: legacyGlobal.username,
      password: legacyGlobal.password,
    };
  }

  return null;
}
