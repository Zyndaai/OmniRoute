/**
 * Durable second tier for the CCR block store (#9061).
 *
 * The CCR engine's in-process `Map` stays the hot cache; this module is what makes its
 * promise survive an eviction, a TTL sweep, a restart, or a retrieve that lands on
 * another instance. Every function here is best-effort: the caller treats a throw as
 * "not durable this time", never as a request failure.
 */
import { db, ts, toMs } from "@/lib/db/pg";

export interface CcrBlockRow {
  principalId: string;
  hash: string;
  content: string;
  bytes: number;
  chars: number;
  lines: number;
  contentType: string;
  source: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
}

interface CcrBlockDbRow {
  content: string;
  bytes: number;
  chars: number;
  lines: number;
  content_type: string;
  source: string;
  created_at: string;
  last_accessed_at: string;
  expires_at: string;
}

/**
 * Writes older than this are not worth a prune scan on every call.
 * ponytail: counter-based throttle, swap for a scheduled sweep if the table ever grows
 * fast enough that 200 writes of drift matters.
 */
const PRUNE_EVERY_N_WRITES = 200;
let writesSincePrune = 0;

/** Postgres rejects U+0000 in text. */
function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

export async function persistCcrBlock(row: CcrBlockRow): Promise<void> {
  await db().execute(
    `INSERT INTO ccr_blocks (
       principal_id, hash, content, bytes, chars, lines,
       content_type, source, created_at, last_accessed_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (principal_id, hash) DO UPDATE SET
       content = EXCLUDED.content,
       bytes = EXCLUDED.bytes,
       chars = EXCLUDED.chars,
       lines = EXCLUDED.lines,
       content_type = EXCLUDED.content_type,
       source = EXCLUDED.source,
       created_at = EXCLUDED.created_at,
       last_accessed_at = EXCLUDED.last_accessed_at,
       expires_at = EXCLUDED.expires_at`,
    [
      row.principalId,
      row.hash,
      stripNul(row.content),
      Math.round(row.bytes),
      Math.round(row.chars),
      Math.round(row.lines),
      row.contentType,
      row.source,
      ts(row.createdAt),
      ts(row.lastAccessedAt),
      ts(row.expiresAt),
    ]
  );

  if (++writesSincePrune >= PRUNE_EVERY_N_WRITES) {
    writesSincePrune = 0;
    await pruneExpiredCcrBlocks(Date.now());
  }
}

/** Returns the block only while it is unexpired; an expired row is deleted and read as a miss. */
export async function loadCcrBlock(
  principalId: string,
  hash: string,
  now: number
): Promise<CcrBlockRow | null> {
  const row = await db().queryOne<CcrBlockDbRow>(
    `SELECT content, bytes, chars, lines, content_type, source,
            created_at, last_accessed_at, expires_at
       FROM ccr_blocks WHERE principal_id = $1 AND hash = $2`,
    [principalId, hash]
  );

  if (!row) return null;
  const expiresAt = toMs(row.expires_at) ?? 0;
  if (expiresAt <= now) {
    await deleteCcrBlockRow(principalId, hash);
    return null;
  }

  return {
    principalId,
    hash,
    content: row.content,
    bytes: row.bytes,
    chars: row.chars,
    lines: row.lines,
    contentType: row.content_type,
    source: row.source,
    createdAt: toMs(row.created_at) ?? 0,
    lastAccessedAt: toMs(row.last_accessed_at) ?? 0,
    expiresAt,
  };
}

export async function touchCcrBlock(
  principalId: string,
  hash: string,
  lastAccessedAt: number
): Promise<void> {
  await db().execute(
    `UPDATE ccr_blocks SET last_accessed_at = $1 WHERE principal_id = $2 AND hash = $3`,
    [ts(lastAccessedAt), principalId, hash]
  );
}

export async function deleteCcrBlockRow(principalId: string, hash: string): Promise<void> {
  await db().execute(`DELETE FROM ccr_blocks WHERE principal_id = $1 AND hash = $2`, [
    principalId,
    hash,
  ]);
}

/**
 * Drops every durable block. Mirrors the engine's `resetCcrStore()` so that "reset" keeps
 * meaning reset once the store has a second tier.
 */
export async function deleteAllCcrBlocks(): Promise<void> {
  await db().execute(`DELETE FROM ccr_blocks`);
}

/** Drops every block whose TTL has passed. Returns how many rows went. */
export async function pruneExpiredCcrBlocks(now: number): Promise<number> {
  const result = await db().execute(`DELETE FROM ccr_blocks WHERE expires_at <= $1`, [ts(now)]);
  return result.changes ?? 0;
}

export async function countCcrBlocks(principalId?: string): Promise<number> {
  const row =
    principalId === undefined
      ? await db().queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ccr_blocks`)
      : await db().queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ccr_blocks WHERE principal_id = $1`,
          [principalId]
        );
  return Number(row?.n ?? 0);
}
