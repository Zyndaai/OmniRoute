import { createHash } from "crypto";

import { db, ts } from "../pg";
import type { SessionAccountAffinityRecord } from "./store";

// Backed by the `session_affinities` table. The module keeps its historical name (and the
// `sqliteSessionAffinityStore` export) because the Redis store and the factory import it.

const CLEANUP_INTERVAL_MS = 5 * 60_000;
const ACCOUNT_IDENTITY_PATTERN = /^[a-f0-9]{64}$/;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

type AffinityRow = {
  connection_id: string;
  account_identity: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
};

function normalizePositiveTtl(ttlMs: number | null | undefined): number {
  return Number.isFinite(ttlMs) && Number(ttlMs) > 0 ? Number(ttlMs) : 0;
}

function sessionHash(sessionKey: string, provider: string): string {
  return createHash("sha256").update(`${provider}:${sessionKey}`).digest("hex");
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function rowToRecord(row: AffinityRow): SessionAccountAffinityRecord {
  return {
    connectionId: row.connection_id,
    ...(row.account_identity && ACCOUNT_IDENTITY_PATTERN.test(row.account_identity)
      ? { accountIdentity: row.account_identity }
      : {}),
    createdAt: toIso(row.created_at),
    lastUsedAt: toIso(row.last_used_at),
    expiresAt: toIso(row.expires_at),
  };
}

/** Parses a serialized record (the Redis store keeps these as JSON text). */
export function parseRecord(value: unknown): SessionAccountAffinityRecord | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<SessionAccountAffinityRecord>;
    if (typeof parsed.connectionId !== "string" || parsed.connectionId.trim().length === 0) {
      return null;
    }
    if (typeof parsed.expiresAt !== "string" || Number.isNaN(Date.parse(parsed.expiresAt))) {
      return null;
    }
    return {
      connectionId: parsed.connectionId,
      ...(typeof parsed.accountIdentity === "string" &&
      ACCOUNT_IDENTITY_PATTERN.test(parsed.accountIdentity)
        ? { accountIdentity: parsed.accountIdentity }
        : {}),
      createdAt:
        typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt))
          ? parsed.createdAt
          : parsed.expiresAt,
      lastUsedAt:
        typeof parsed.lastUsedAt === "string" && !Number.isNaN(Date.parse(parsed.lastUsedAt))
          ? parsed.lastUsedAt
          : parsed.expiresAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function readRow(sessionKey: string, provider: string): Promise<AffinityRow | undefined> {
  return db().queryOne<AffinityRow>(
    `SELECT connection_id, account_identity, created_at, last_used_at, expires_at
       FROM session_affinities WHERE provider = $1 AND session_hash = $2`,
    [provider, sessionHash(sessionKey, provider)]
  );
}

async function deleteAffinity(sessionKey: string, provider: string): Promise<void> {
  await db().execute("DELETE FROM session_affinities WHERE provider = $1 AND session_hash = $2", [
    provider,
    sessionHash(sessionKey, provider),
  ]);
}

/** Redis-only fallback provenance: the stored record as the JSON text `persist` wrote. */
export async function getSessionAccountAffinitySerialized(
  sessionKey: string,
  provider: string
): Promise<string | null> {
  if (!sessionKey || !provider) return null;
  const row = await readRow(sessionKey, provider);
  return row ? JSON.stringify(rowToRecord(row)) : null;
}

/** Deletes the row only when it still holds exactly `serializedValue`. */
export async function deleteSessionAccountAffinityIfValue(
  sessionKey: string,
  provider: string,
  serializedValue: string
): Promise<boolean> {
  if (!sessionKey || !provider || typeof serializedValue !== "string") return false;
  const record = parseRecord(serializedValue);
  if (!record) return false;
  const { changes } = await db().execute(
    `DELETE FROM session_affinities
      WHERE provider = $1 AND session_hash = $2 AND connection_id = $3
        AND account_identity IS NOT DISTINCT FROM $4
        AND created_at = $5 AND last_used_at = $6 AND expires_at = $7`,
    [
      provider,
      sessionHash(sessionKey, provider),
      record.connectionId,
      record.accountIdentity ?? null,
      ts(record.createdAt),
      ts(record.lastUsedAt),
      ts(record.expiresAt),
    ]
  );
  return changes > 0;
}

export async function getSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  ttlMs = 0,
  now: number = Date.now()
): Promise<SessionAccountAffinityRecord | null> {
  if (!sessionKey || !provider || normalizePositiveTtl(ttlMs) <= 0) return null;

  const row = await readRow(sessionKey, provider);
  if (!row) return null;
  const record = rowToRecord(row);

  if (Date.parse(record.expiresAt) <= now) {
    await db().execute(
      "DELETE FROM session_affinities WHERE provider = $1 AND session_hash = $2 AND expires_at <= $3",
      [provider, sessionHash(sessionKey, provider), ts(now)]
    );
    return null;
  }

  return record;
}

/** The creation time survives while the existing row is still live; an expired row restarts it. */
export async function upsertSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  connectionId: string,
  now: number = Date.now(),
  ttlMs = 0,
  accountIdentity?: string
): Promise<void> {
  const normalizedTtlMs = normalizePositiveTtl(ttlMs);
  if (!sessionKey || !provider || !connectionId || normalizedTtlMs <= 0) return;

  const timestamp = isoFromMs(now);
  await db().execute(
    `INSERT INTO session_affinities
       (provider, session_hash, connection_id, account_identity, created_at, last_used_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6)
     ON CONFLICT (provider, session_hash) DO UPDATE SET
       connection_id = EXCLUDED.connection_id,
       account_identity = EXCLUDED.account_identity,
       created_at = CASE WHEN session_affinities.expires_at > $5
                         THEN session_affinities.created_at ELSE EXCLUDED.created_at END,
       last_used_at = EXCLUDED.last_used_at,
       expires_at = EXCLUDED.expires_at`,
    [
      provider,
      sessionHash(sessionKey, provider),
      connectionId,
      accountIdentity && ACCOUNT_IDENTITY_PATTERN.test(accountIdentity) ? accountIdentity : null,
      timestamp,
      isoFromMs(now + normalizedTtlMs),
    ]
  );
}

/** Persist an exact local record; also used to seed identity-guard regression tests. */
async function persistSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  record: SessionAccountAffinityRecord
): Promise<void> {
  await db().execute(
    `INSERT INTO session_affinities
       (provider, session_hash, connection_id, account_identity, created_at, last_used_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, session_hash) DO UPDATE SET
       connection_id = EXCLUDED.connection_id,
       account_identity = EXCLUDED.account_identity,
       created_at = EXCLUDED.created_at,
       last_used_at = EXCLUDED.last_used_at,
       expires_at = EXCLUDED.expires_at`,
    [
      provider,
      sessionHash(sessionKey, provider),
      record.connectionId,
      record.accountIdentity ?? null,
      ts(record.createdAt),
      ts(record.lastUsedAt),
      ts(record.expiresAt),
    ]
  );
}

/** Slides the expiry of a live row (no index covers these columns, so the update stays HOT). */
export async function touchSessionAccountAffinity(
  sessionKey: string,
  provider: string,
  now: number = Date.now(),
  ttlMs = 0
): Promise<void> {
  const normalizedTtlMs = normalizePositiveTtl(ttlMs);
  if (!sessionKey || !provider || normalizedTtlMs <= 0) return;

  await db().execute(
    `UPDATE session_affinities SET last_used_at = $3, expires_at = $4
      WHERE provider = $1 AND session_hash = $2 AND expires_at > $3`,
    [provider, sessionHash(sessionKey, provider), isoFromMs(now), isoFromMs(now + normalizedTtlMs)]
  );
}

export async function deleteSessionAccountAffinity(
  sessionKey: string,
  provider: string
): Promise<void> {
  if (!sessionKey || !provider) return;
  await deleteAffinity(sessionKey, provider);
}

/**
 * #6219 — Evict a session's pin ONLY when it currently points at `connectionId`.
 *
 * Used by the account-failover paths in chat.ts: when the pinned connection is
 * marked unavailable/exhausted, the sticky pin must be dropped so the next
 * request fails over to another account instead of re-pinning the dead one
 * (previously the session stayed pinned until process restart).
 *
 * Unlike `getSessionAccountAffinity`, this reads the stored record INDEPENDENT
 * of the TTL gate. The connection-match guard is preserved here so a pin
 * pointing at a different (still-healthy) connection is never nuked. When both
 * the stored pin and the caller carry an account identity, the identity decides.
 * Returns true when a pin was evicted.
 */
export async function evictSessionAccountAffinityForConnection(
  sessionKey: string,
  provider: string,
  connectionId: string,
  accountIdentity?: string
): Promise<boolean> {
  if (!sessionKey || !provider || !connectionId) return false;

  const { changes } = await db().execute(
    `DELETE FROM session_affinities
      WHERE provider = $1 AND session_hash = $2
        AND CASE WHEN account_identity IS NOT NULL AND $4::text IS NOT NULL
                 THEN account_identity = $4::text
                 ELSE connection_id = $3 END`,
    [provider, sessionHash(sessionKey, provider), connectionId, accountIdentity || null]
  );
  return changes > 0;
}

export async function cleanupStaleSessionAccountAffinities(
  _ttlMs: number = 30 * 60 * 1000,
  now: number = Date.now()
): Promise<number> {
  const { changes } = await db().execute("DELETE FROM session_affinities WHERE expires_at <= $1", [
    ts(now),
  ]);
  return changes;
}

// Exact-record seeding stays here for the identity regression tests; it is not part of
// SessionAffinityStore and is never called by the Redis driver.
export const sqliteSessionAffinityStore = {
  driver: "sqlite" as const,
  get: getSessionAccountAffinity,
  upsert: upsertSessionAccountAffinity,
  upsertShadow: persistSessionAccountAffinity,
  touch: touchSessionAccountAffinity,
  delete: deleteSessionAccountAffinity,
  deleteIfValue: deleteSessionAccountAffinityIfValue,
  getSerialized: getSessionAccountAffinitySerialized,
  evict: evictSessionAccountAffinityForConnection,
};

export function startSessionAccountAffinityCleanup(): void {
  if (cleanupTimer) return;

  cleanupStaleSessionAccountAffinities().catch((error) => {
    console.warn("[SESSION_AFFINITY] Startup cleanup failed:", error);
  });

  cleanupTimer = setInterval(() => {
    cleanupStaleSessionAccountAffinities().catch((error) => {
      console.warn("[SESSION_AFFINITY] Periodic cleanup failed:", error);
    });
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) cleanupTimer.unref?.();
}
