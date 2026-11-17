/**
 * db/museSessionOwnership.ts — persistence for Muse Code session ownership.
 *
 * Rows live in the `muse_session_ownership` table (key, value text, touched_at):
 *   session:<scope>            owner JSON (connection id + credential/account hashes)
 *   served:<scope>             "1" once output was served (pins the owner)
 *   opaque:<scope>:<hash>      generation that received an encrypted_content item
 *   reference:<scope>:<hash>   generation that received a tool call / output item id
 *   touched:<scope>            last activity (epoch ms in value, mirrored in touched_at) — drives idle pruning
 *   cursor                     round-robin cursor for fresh sessions
 *
 * Only SHA-256 digests are stored, never prompts or credentials. The hashing and the
 * ownership rules stay in src/sse/services/museSessionOwnership.ts; this module owns the SQL.
 *
 * Inside `runMuseOwnershipTransaction`, pass the `tx` the callback receives to every helper
 * here, so each statement runs on the transaction's connection.
 */

import { db, ts, type DbExecutor } from "./pg";

const TOUCHED_PREFIX = "touched:";

/** A session idle for this long is forgotten: its owner pin and recorded items are dropped. */
export const MUSE_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 200;

export async function readMuseOwnershipValue(
  key: string,
  ex: DbExecutor = db()
): Promise<string | undefined> {
  const row = await ex.queryOne<{ value: string }>(
    "SELECT value FROM muse_session_ownership WHERE key = $1",
    [key]
  );
  return row?.value;
}

export async function writeMuseOwnershipValue(
  key: string,
  value: string,
  ex: DbExecutor = db()
): Promise<void> {
  const touchedAt = key.startsWith(TOUCHED_PREFIX) ? ts(Number(value)) : null;
  await ex.execute(
    `INSERT INTO muse_session_ownership (key, value, touched_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, touched_at = EXCLUDED.touched_at, updated_at = now()`,
    [key, value, touchedAt]
  );
}

/**
 * Run `fn` in one transaction so claim/bind decisions are atomic. A transaction-scoped
 * advisory lock serialises every claim/bind (they also share the global round-robin cursor).
 */
export async function runMuseOwnershipTransaction(
  fn: (tx: DbExecutor) => Promise<void>
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute("SELECT pg_advisory_xact_lock(hashtext('muse_session_ownership'))");
    await fn(tx);
  });
}

/** Whether replayable history (encrypted reasoning or tool references) was recorded. */
export async function museScopeHasRecordedItems(
  scope: string,
  ex: DbExecutor = db()
): Promise<boolean> {
  for (const prefix of [`opaque:${scope}:`, `reference:${scope}:`]) {
    const hit = await ex.queryOne(
      "SELECT 1 AS hit FROM muse_session_ownership WHERE starts_with(key, $1) LIMIT 1",
      [prefix]
    );
    if (hit) return true;
  }
  return false;
}

export async function touchMuseOwnershipScope(
  scope: string,
  now: number = Date.now(),
  ex: DbExecutor = db()
): Promise<void> {
  await writeMuseOwnershipValue(`${TOUCHED_PREFIX}${scope}`, String(now), ex);
}

/**
 * Delete every row of the sessions idle longer than `ttlMs`. Bounded per call so a large
 * backlog never stalls a request; the caller throttles how often it runs.
 */
export async function pruneIdleMuseOwnershipScopes(
  now: number = Date.now(),
  ttlMs: number = MUSE_SESSION_IDLE_TTL_MS,
  limit: number = PRUNE_BATCH_SIZE
): Promise<number> {
  const stale = await db().query<{ key: string }>(
    `SELECT key FROM muse_session_ownership
      WHERE starts_with(key, $1) AND touched_at < $2
      LIMIT $3`,
    [TOUCHED_PREFIX, ts(now - ttlMs), limit]
  );
  if (!stale.length) return 0;
  await db().transaction(async (tx) => {
    for (const { key } of stale) {
      const scope = key.slice(TOUCHED_PREFIX.length);
      await tx.execute(
        `DELETE FROM muse_session_ownership
          WHERE key = ANY($1::text[]) OR starts_with(key, $2) OR starts_with(key, $3)`,
        [[`session:${scope}`, `served:${scope}`, key], `opaque:${scope}:`, `reference:${scope}:`]
      );
    }
  });
  return stale.length;
}
