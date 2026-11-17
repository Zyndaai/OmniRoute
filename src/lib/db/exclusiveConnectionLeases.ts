import { createHash } from "node:crypto";

import { db, type DbExecutor } from "./pg";

export const LEASE_OWNER_PATTERN = /^vlo_[A-Za-z0-9_-]{43}$/;
const DEFAULT_EXCLUSIVE_LEASE_TTL_MS = 120_000;
const MIN_EXCLUSIVE_LEASE_TTL_MS = 1_000;
const MAX_EXCLUSIVE_LEASE_TTL_MS = 1_800_000;
type ExclusiveLeaseState = "ACTIVE" | "RELEASED" | "EXPIRED" | "INVALIDATED";
export type ExclusiveLeaseEndReason =
  | "AUTHORIZATION_CHANGED"
  | "CLIENT_CANCELLED"
  | "CONNECTION_INELIGIBLE"
  | "HEALTH_OR_COOLDOWN"
  | "MANAGED_KEY_REVOKED"
  | "MODEL_INELIGIBLE"
  | "OWNER_EXIT"
  | "QUOTA_UNAVAILABLE"
  | "TTL_EXPIRED";
export type ExclusiveConnectionLease = {
  id: number;
  leaseOwnerHash: string;
  apiKeyId: string;
  provider: string;
  connectionId: string;
  generation: number;
  state: ExclusiveLeaseState;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
};
type LeaseRow = {
  id: number;
  lease_owner_hash: string;
  api_key_id: string;
  provider: string;
  connection_id: string;
  generation: number;
  state: ExclusiveLeaseState;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  ended_at: string | null;
  end_reason: string | null;
};
type LeaseStatusRow = LeaseRow & {
  connection_provider: string;
  connection_auth_type: string | null;
  connection_name: string | null;
  connection_email: string | null;
  connection_display_name: string | null;
};
type LeaseSuccess = {
  kind: "ACQUIRED" | "REUSED" | "TRANSITIONED";
  lease: ExclusiveConnectionLease;
};
type LeaseConflict =
  | { kind: "CONNECTION_BUSY"; retryAfter: string | null }
  | { kind: "OWNER_ALREADY_ACTIVE"; lease: ExclusiveConnectionLease };
type LeaseUpdateResult<T extends string> =
  { kind: T; lease: ExclusiveConnectionLease } | { kind: "STALE" };

// The partial unique indexes on (connection_id) and (lease_owner_hash) WHERE state = 'ACTIVE'
// give mutual exclusion across processes. An insert that loses the race returns no row
// (ON CONFLICT DO NOTHING) and raises this signal, which rolls the transaction back.
class LeaseConflictSignal extends Error {}

const ACTIVE_SQL = "SELECT * FROM exclusive_connection_leases WHERE state = 'ACTIVE' AND ";
// Projection, not a cast: joined SELECTs (the status query) carry connection_*
// identity columns (email/display name) that must never escape on the lease object.
const lease = (row: LeaseRow): ExclusiveConnectionLease => ({
  id: Number(row.id),
  leaseOwnerHash: row.lease_owner_hash,
  apiKeyId: row.api_key_id,
  provider: row.provider,
  connectionId: row.connection_id,
  generation: row.generation,
  state: row.state,
  acquiredAt: row.acquired_at,
  renewedAt: row.renewed_at,
  expiresAt: row.expires_at,
  endedAt: row.ended_at ?? null,
  endReason: row.end_reason ?? null,
});
function timestamp(value?: string): string {
  const parsed = Date.parse(value ?? new Date().toISOString());
  if (!Number.isFinite(parsed)) throw new Error("now must be a valid ISO timestamp");
  return new Date(parsed).toISOString();
}
function expiry(now: string, ttlMs?: number): string {
  const ttl = Math.min(
    MAX_EXCLUSIVE_LEASE_TTL_MS,
    Math.max(MIN_EXCLUSIVE_LEASE_TTL_MS, ttlMs ?? DEFAULT_EXCLUSIVE_LEASE_TTL_MS)
  );
  return new Date(Date.parse(now) + ttl).toISOString();
}

export function hashLeaseOwnerId(leaseOwnerId: string): string {
  if (!LEASE_OWNER_PATTERN.test(leaseOwnerId))
    throw new Error("lease owner must use the canonical vlo_ base64url format");
  return createHash("sha256").update(leaseOwnerId).digest("hex");
}

async function expire(tx: DbExecutor, now: string): Promise<number> {
  return (
    await tx.execute(
      `UPDATE exclusive_connection_leases
       SET state = 'EXPIRED', ended_at = $1, end_reason = 'TTL_EXPIRED'
       WHERE state = 'ACTIVE' AND expires_at <= $1`,
      [now]
    )
  ).changes;
}
// `lock` takes the row FOR UPDATE: a concurrent release/invalidate/transition of the same owner
// waits, and Postgres re-checks state = 'ACTIVE' afterwards, so a lease ended meanwhile reads as
// absent instead of being acted on stale.
function active(
  tx: DbExecutor,
  column: "lease_owner_hash" | "connection_id",
  value: string,
  lock = false
) {
  return tx.queryOne<LeaseRow>(`${ACTIVE_SQL}${column} = $1${lock ? " FOR UPDATE" : ""}`, [value]);
}

function configuredConnectionName(row: LeaseStatusRow): string | null {
  const name = row.connection_name?.trim();
  if (!name || name.includes("@")) return null;

  if (row.connection_auth_type === "oauth" || row.connection_auth_type === "access_token") {
    const normalized = name.toLowerCase();
    const generatedFallbacks = [row.connection_email, row.connection_display_name]
      .map((value) => value?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value));
    if (generatedFallbacks.includes(normalized)) return null;
  }

  return name;
}

function historical(tx: DbExecutor, ownerHash: string, generation: number) {
  return tx.queryOne<LeaseRow>(
    `SELECT * FROM exclusive_connection_leases
     WHERE lease_owner_hash = $1 AND generation = $2 ORDER BY id DESC LIMIT 1`,
    [ownerHash, generation]
  );
}

async function nextGeneration(tx: DbExecutor, ownerHash: string): Promise<number> {
  const row = await tx.queryOne<{ generation: number }>(
    "SELECT COALESCE(MAX(generation), 0) AS generation FROM exclusive_connection_leases WHERE lease_owner_hash = $1",
    [ownerHash]
  );
  const generation = Number(row?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation <= 0)
    throw new Error("lease generation exhausted");
  return generation;
}

async function insert(
  tx: DbExecutor,
  input: {
    ownerHash: string;
    apiKeyId: string;
    provider: string;
    connectionId: string;
    generation: number;
    now: string;
    ttlMs?: number;
  }
): Promise<ExclusiveConnectionLease> {
  const row = await tx.queryOne<LeaseRow>(
    `INSERT INTO exclusive_connection_leases
     (lease_owner_hash, api_key_id, provider, connection_id, generation, state,
      acquired_at, renewed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      input.ownerHash,
      input.apiKeyId,
      input.provider,
      input.connectionId,
      input.generation,
      input.now,
      expiry(input.now, input.ttlMs),
    ]
  );
  if (!row) throw new LeaseConflictSignal();
  return lease(row);
}

async function conflict(ownerHash: string, connectionId: string): Promise<LeaseConflict> {
  const owner = await active(db(), "lease_owner_hash", ownerHash);
  return owner
    ? { kind: "OWNER_ALREADY_ACTIVE", lease: lease(owner) }
    : {
        kind: "CONNECTION_BUSY",
        retryAfter: (await active(db(), "connection_id", connectionId))?.expires_at ?? null,
      };
}

async function update<T extends string>(input: {
  ownerHash: string;
  generation: number;
  now: string;
  kind: T;
  sql: string;
  args: unknown[];
  accept?: (row: LeaseRow | undefined) => boolean;
}): Promise<LeaseUpdateResult<T>> {
  return db().transaction(async (tx) => {
    await expire(tx, input.now);
    const changed = (await tx.execute(input.sql, input.args)).changes === 1;
    const row = await historical(tx, input.ownerHash, input.generation);
    return changed || input.accept?.(row)
      ? { kind: input.kind, lease: lease(row!) }
      : { kind: "STALE" as const };
  });
}

export async function reconcileExpiredExclusiveConnectionLeases(now?: string): Promise<number> {
  return expire(db(), timestamp(now));
}

export async function getExclusiveConnectionLeaseStatus(input: {
  leaseOwnerId: string;
  generation: number;
  apiKeyId: string;
  now?: string;
}): Promise<{
  lease: ExclusiveConnectionLease;
  provider: string;
  connectionName: string | null;
} | null> {
  const ownerHash = hashLeaseOwnerId(input.leaseOwnerId);
  const now = timestamp(input.now);
  return db().transaction(async (tx) => {
    await expire(tx, now);
    const row = await tx.queryOne<LeaseStatusRow>(
      `SELECT leases.*, connections.provider AS connection_provider,
              connections.auth_type AS connection_auth_type,
              connections.name AS connection_name,
              connections.email AS connection_email,
              connections.display_name AS connection_display_name
       FROM exclusive_connection_leases leases
       INNER JOIN provider_connections connections ON connections.id = leases.connection_id
       WHERE leases.lease_owner_hash = $1 AND leases.api_key_id = $2
         AND leases.generation = $3 AND leases.state = 'ACTIVE' AND leases.expires_at > $4
       LIMIT 1`,
      [ownerHash, input.apiKeyId, input.generation, now]
    );
    return row
      ? {
          lease: lease(row),
          provider: row.connection_provider,
          connectionName: configuredConnectionName(row),
        }
      : null;
  });
}

export async function acquireExclusiveConnectionLease(input: {
  leaseOwnerId: string;
  apiKeyId: string;
  provider: string;
  connectionId: string;
  now?: string;
  ttlMs?: number;
}): Promise<LeaseSuccess | LeaseConflict> {
  const ownerHash = hashLeaseOwnerId(input.leaseOwnerId);
  const now = timestamp(input.now);
  try {
    return await db().transaction<LeaseSuccess | LeaseConflict>(async (tx) => {
      await expire(tx, now);
      const owner = await active(tx, "lease_owner_hash", ownerHash, true);
      if (owner) {
        if (owner.api_key_id !== input.apiKeyId || owner.connection_id !== input.connectionId) {
          return { kind: "OWNER_ALREADY_ACTIVE", lease: lease(owner) };
        }
        const renewed = await tx.queryOne<LeaseRow>(
          `UPDATE exclusive_connection_leases SET renewed_at = $1, expires_at = $2,
           provider = $3 WHERE id = $4 AND state = 'ACTIVE' AND api_key_id = $5
           RETURNING *`,
          [now, expiry(now, input.ttlMs), input.provider, owner.id, input.apiKeyId]
        );
        return { kind: "REUSED", lease: lease(renewed!) };
      }
      const occupied = await active(tx, "connection_id", input.connectionId);
      if (occupied) return { kind: "CONNECTION_BUSY", retryAfter: occupied.expires_at };
      return {
        kind: "ACQUIRED",
        lease: await insert(tx, {
          ...input,
          ownerHash,
          generation: await nextGeneration(tx, ownerHash),
          now,
        }),
      };
    });
  } catch (error) {
    if (!(error instanceof LeaseConflictSignal)) throw error;
    return conflict(ownerHash, input.connectionId);
  }
}

export async function transitionExclusiveConnectionLease(input: {
  leaseOwnerId: string;
  generation: number;
  apiKeyId: string;
  provider: string;
  connectionId: string;
  reason: ExclusiveLeaseEndReason;
  now?: string;
  ttlMs?: number;
}): Promise<LeaseSuccess | LeaseConflict | { kind: "STALE" }> {
  const ownerHash = hashLeaseOwnerId(input.leaseOwnerId);
  const now = timestamp(input.now);
  try {
    return await db().transaction<LeaseSuccess | LeaseConflict | { kind: "STALE" }>(
      async (tx) => {
        await expire(tx, now);
        const owner = await active(tx, "lease_owner_hash", ownerHash, true);
        if (
          !owner ||
          owner.generation !== input.generation ||
          owner.api_key_id !== input.apiKeyId
        )
          return { kind: "STALE" };
        if (owner.connection_id === input.connectionId) {
          return { kind: "REUSED", lease: lease(owner) };
        }
        const occupied = await active(tx, "connection_id", input.connectionId);
        if (occupied) return { kind: "CONNECTION_BUSY", retryAfter: occupied.expires_at };
        const ended = await tx.execute(
          `UPDATE exclusive_connection_leases SET state = 'INVALIDATED', ended_at = $1,
           end_reason = $2 WHERE id = $3 AND state = 'ACTIVE'`,
          [now, input.reason, owner.id]
        );
        if (ended.changes !== 1) return { kind: "STALE" };
        return {
          kind: "TRANSITIONED",
          lease: await insert(tx, { ...input, ownerHash, now }),
        };
      }
    );
  } catch (error) {
    if (!(error instanceof LeaseConflictSignal)) throw error;
    return conflict(ownerHash, input.connectionId);
  }
}

export async function invalidateExclusiveConnectionLease(input: {
  leaseOwnerId: string;
  generation: number;
  apiKeyId: string;
  reason: ExclusiveLeaseEndReason;
  now?: string;
}): Promise<LeaseUpdateResult<"INVALIDATED">> {
  const ownerHash = hashLeaseOwnerId(input.leaseOwnerId);
  const now = timestamp(input.now);
  return update({
    ownerHash,
    generation: input.generation,
    now,
    kind: "INVALIDATED",
    sql: `UPDATE exclusive_connection_leases SET state = 'INVALIDATED', ended_at = $1, end_reason = $2
          WHERE lease_owner_hash = $3 AND generation = $4 AND api_key_id = $5
          AND state = 'ACTIVE' AND expires_at > $1`,
    args: [now, input.reason, ownerHash, input.generation, input.apiKeyId],
  });
}

export async function renewExclusiveConnectionLease(input: {
  leaseOwnerId: string;
  generation: number;
  apiKeyId: string;
  now?: string;
  ttlMs?: number;
}): Promise<LeaseUpdateResult<"RENEWED">> {
  const ownerHash = hashLeaseOwnerId(input.leaseOwnerId);
  const now = timestamp(input.now);
  return update({
    ownerHash,
    generation: input.generation,
    now,
    kind: "RENEWED",
    sql: `UPDATE exclusive_connection_leases SET renewed_at = $1, expires_at = $2
          WHERE lease_owner_hash = $3 AND generation = $4 AND api_key_id = $5
          AND state = 'ACTIVE' AND expires_at > $1`,
    args: [now, expiry(now, input.ttlMs), ownerHash, input.generation, input.apiKeyId],
  });
}

export async function releaseExclusiveConnectionLease(input: {
  leaseOwnerId: string;
  generation: number;
  apiKeyId: string;
  reason?: "OWNER_EXIT" | "CLIENT_CANCELLED";
  now?: string;
}): Promise<LeaseUpdateResult<"RELEASED">> {
  const ownerHash = hashLeaseOwnerId(input.leaseOwnerId);
  const now = timestamp(input.now);
  return update({
    ownerHash,
    generation: input.generation,
    now,
    kind: "RELEASED",
    sql: `UPDATE exclusive_connection_leases SET state = 'RELEASED', ended_at = $1, end_reason = $2
          WHERE lease_owner_hash = $3 AND generation = $4 AND api_key_id = $5
          AND state = 'ACTIVE' AND expires_at > $1`,
    args: [now, input.reason ?? "OWNER_EXIT", ownerHash, input.generation, input.apiKeyId],
    accept: (row) => row?.state === "RELEASED" && row.api_key_id === input.apiKeyId,
  });
}

export async function assertExclusiveConnectionLeaseFence(input: {
  leaseOwnerId: string;
  generation: number;
  apiKeyId: string;
  connectionId: string;
  now?: string;
}): Promise<
  | { kind: "VALID"; lease: ExclusiveConnectionLease }
  | { kind: "AUTHORIZATION_MISMATCH" | "CONNECTION_MISMATCH"; lease: ExclusiveConnectionLease }
  | { kind: "REQUIRED" | "STALE" }
> {
  const ownerHash = hashLeaseOwnerId(input.leaseOwnerId);
  await reconcileExpiredExclusiveConnectionLeases(input.now);
  const row = await active(db(), "lease_owner_hash", ownerHash);
  if (!row) return { kind: "REQUIRED" };
  if (row.generation !== input.generation) return { kind: "STALE" };
  const current = lease(row);
  if (row.api_key_id !== input.apiKeyId) return { kind: "AUTHORIZATION_MISMATCH", lease: current };
  return row.connection_id === input.connectionId
    ? { kind: "VALID", lease: current }
    : { kind: "CONNECTION_MISMATCH", lease: current };
}

export async function getActiveExclusiveConnectionLease(leaseOwnerId: string, now?: string) {
  const ownerHash = hashLeaseOwnerId(leaseOwnerId);
  await reconcileExpiredExclusiveConnectionLeases(now);
  const row = await active(db(), "lease_owner_hash", ownerHash);
  return row ? lease(row) : null;
}

export async function getExclusiveLeaseOccupancy(connectionIds: readonly string[], now?: string) {
  await reconcileExpiredExclusiveConnectionLeases(now);
  if (connectionIds.length === 0) return new Map();
  const rows = await db().query<{
    connection_id: string;
    lease_owner_hash: string;
    expires_at: string;
  }>(
    `SELECT connection_id, lease_owner_hash, expires_at FROM exclusive_connection_leases
     WHERE state = 'ACTIVE' AND connection_id = ANY($1::text[])`,
    [[...connectionIds]]
  );
  return new Map(
    rows.map((row) => [
      row.connection_id,
      { leaseOwnerHash: row.lease_owner_hash, expiresAt: row.expires_at },
    ])
  );
}

export async function isExclusiveConnectionActivelyLeased(
  connectionId: string,
  now?: string
): Promise<boolean> {
  if (!connectionId) return false;
  await reconcileExpiredExclusiveConnectionLeases(now);
  return (await active(db(), "connection_id", connectionId)) !== undefined;
}
