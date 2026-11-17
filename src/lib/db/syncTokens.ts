import { v4 as uuidv4 } from "uuid";
import { db, ts } from "@/lib/db/pg";

export interface SyncTokenRecord {
  id: string;
  name: string;
  tokenHash: string;
  syncApiKeyId: string | null;
  /** Kind of principal that issued the token (`session`, `cli`, …); null for rows written before these columns existed. */
  issuedBy: string | null;
  /** ISO timestamp after which the token is dead; null for rows written before these columns existed (no expiry). */
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SyncTokenRow {
  id?: unknown;
  name?: unknown;
  token_hash?: unknown;
  sync_api_key_id?: unknown;
  issued_by?: unknown;
  expires_at?: unknown;
  revoked_at?: unknown;
  last_used_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

/** The env key is not a row in `api_keys`; a token for it is stored unlinked (NULL). */
const ENV_KEY_ID = "env-key";

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toSyncTokenRecord(row: SyncTokenRow | undefined): SyncTokenRecord | null {
  if (!row || typeof row.id !== "string" || typeof row.name !== "string") return null;

  return {
    id: row.id,
    name: row.name,
    tokenHash: typeof row.token_hash === "string" ? row.token_hash : "",
    syncApiKeyId: optionalString(row.sync_api_key_id),
    issuedBy: optionalString(row.issued_by),
    expiresAt: optionalString(row.expires_at),
    revokedAt: optionalString(row.revoked_at),
    lastUsedAt: optionalString(row.last_used_at),
    createdAt: optionalString(row.created_at) ?? new Date().toISOString(),
    updatedAt: optionalString(row.updated_at) ?? new Date().toISOString(),
  };
}

export async function listSyncTokens(): Promise<SyncTokenRecord[]> {
  const rows = await db().query<SyncTokenRow>(
    "SELECT * FROM sync_tokens ORDER BY created_at DESC, lower(name) ASC"
  );

  return rows
    .map((row) => toSyncTokenRecord(row))
    .filter((row): row is SyncTokenRecord => row !== null);
}

export async function getSyncTokenById(id: string): Promise<SyncTokenRecord | null> {
  const row = await db().queryOne<SyncTokenRow>("SELECT * FROM sync_tokens WHERE id = $1", [id]);
  return toSyncTokenRecord(row);
}

export async function getSyncTokenByHash(tokenHash: string): Promise<SyncTokenRecord | null> {
  const row = await db().queryOne<SyncTokenRow>("SELECT * FROM sync_tokens WHERE token_hash = $1", [
    tokenHash,
  ]);
  return toSyncTokenRecord(row);
}

export async function createSyncTokenRecord(data: {
  name: string;
  tokenHash: string;
  syncApiKeyId?: string | null;
  issuedBy?: string | null;
  expiresAt?: string | null;
}): Promise<SyncTokenRecord> {
  const now = new Date().toISOString();
  const syncApiKeyId =
    data.syncApiKeyId && data.syncApiKeyId !== ENV_KEY_ID ? data.syncApiKeyId : null;
  const record: SyncTokenRecord = {
    id: uuidv4(),
    name: data.name,
    tokenHash: data.tokenHash,
    syncApiKeyId,
    issuedBy: data.issuedBy || null,
    expiresAt: data.expiresAt || null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db().execute(
    `INSERT INTO sync_tokens (
      id, name, token_hash, sync_api_key_id, issued_by, expires_at, revoked_at, last_used_at,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      record.id,
      record.name,
      record.tokenHash,
      record.syncApiKeyId,
      record.issuedBy,
      ts(record.expiresAt),
      null,
      null,
      record.createdAt,
      record.updatedAt,
    ]
  );

  return record;
}

export async function revokeSyncToken(id: string): Promise<SyncTokenRecord | null> {
  const existing = await getSyncTokenById(id);
  if (!existing) return null;
  if (existing.revokedAt) return existing;

  await db().execute(
    "UPDATE sync_tokens SET revoked_at = now(), updated_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [id]
  );
  return await getSyncTokenById(id);
}

export async function touchSyncTokenLastUsed(
  id: string,
  usedAt = new Date().toISOString()
): Promise<boolean> {
  const stamp = ts(usedAt) ?? new Date().toISOString();
  const result = await db().execute(
    "UPDATE sync_tokens SET last_used_at = $1, updated_at = $1 WHERE id = $2",
    [stamp, id]
  );
  return Number(result.changes || 0) > 0;
}
