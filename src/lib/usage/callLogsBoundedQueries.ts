import { db, ts, type DbExecutor } from "../db/pg";

// call_logs is partitioned by day with PK (id, "timestamp"). Row batches are addressed by that
// pair so each statement prunes to the partitions it needs, and bounded pages keep memory flat on
// a large table (#5618).
const CALL_LOG_QUERY_PAGE = 5000;

/** The primary key of a call_logs row. */
export type CallLogKey = { id: string; timestamp: string };

const ARTIFACT_PATH_PATTERN =
  /^\d{4}-\d{2}-\d{2}\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z_(.+)\.json$/;

/**
 * Recovers the (id, timestamp) of the row that owns an artifact path, which
 * `buildArtifactRelativePath` derives from exactly those two values:
 * `<day>/<timestamp with ':' as '-'>_<id>.json`. Legacy paths that do not follow
 * the pattern return null.
 */
export function parseArtifactRelPath(relativePath: string): CallLogKey | null {
  const match = ARTIFACT_PATH_PATTERN.exec(relativePath);
  if (!match) return null;
  const [, day, hour, minute, seconds, id] = match;
  return { id, timestamp: `${day}T${hour}:${minute}:${seconds}Z` };
}

/** `(id, "timestamp") IN (($1, $2), ...)` over bound parameters, starting at `$offset + 1`. */
export function keyInList(
  keys: CallLogKey[],
  offset = 0
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = keys.map((key) => {
    params.push(key.id, ts(key.timestamp));
    const base = offset + params.length;
    return `($${base - 1}, $${base}::timestamptz)`;
  });
  return { sql: `(id, "timestamp") IN (${tuples.join(", ")})`, params };
}

/**
 * Collect every non-null `artifact_relpath` referenced by call_logs, paging with
 * LIMIT/OFFSET so a huge table never loads into memory in one query.
 */
export async function collectReferencedArtifacts(): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (let offset = 0; ; offset += CALL_LOG_QUERY_PAGE) {
    const rows = await db().query<{ artifact_relpath: string | null }>(
      `SELECT artifact_relpath FROM call_logs WHERE artifact_relpath IS NOT NULL
        ORDER BY "timestamp", id LIMIT $1 OFFSET $2`,
      [CALL_LOG_QUERY_PAGE, offset]
    );
    for (const row of rows) {
      if (typeof row.artifact_relpath === "string") referenced.add(row.artifact_relpath);
    }
    if (rows.length < CALL_LOG_QUERY_PAGE) break;
  }
  return referenced;
}

/**
 * Select one bounded page of call_log keys older than `cutoff` (oldest first).
 * Callers loop until it returns an empty page, deleting each batch, so the key
 * list never grows to the full retention backlog at once.
 */
export async function selectCallLogIdsBefore(
  cutoff: string,
  limit = CALL_LOG_QUERY_PAGE,
  executor: DbExecutor = db()
): Promise<CallLogKey[]> {
  const rows = await executor.query<{ id: string; timestamp: string }>(
    `SELECT id, "timestamp" FROM call_logs WHERE "timestamp" < $1 ORDER BY "timestamp" ASC LIMIT $2`,
    [ts(cutoff), limit]
  );
  return rows.map((row) => ({ id: String(row.id), timestamp: row.timestamp }));
}

/** Artifact paths of the rows beyond the newest `maxEntries` that still hold a published artifact. */
export async function selectOverflowArtifactPaths(
  maxEntries: number,
  limit: number
): Promise<string[]> {
  const rows = await db().query<{ artifact_relpath: string }>(
    `SELECT artifact_relpath
       FROM call_logs
       WHERE detail_state = 'ready' AND artifact_relpath IS NOT NULL
       ORDER BY "timestamp" DESC, id DESC
       LIMIT $1 OFFSET $2`,
    [limit, maxEntries]
  );
  return rows.map((row) => row.artifact_relpath);
}

/** Which of these artifact paths still belong to a call_logs row. */
export async function findReferencedArtifacts(relativePaths: string[]): Promise<Set<string>> {
  if (relativePaths.length === 0) return new Set();

  const referenced = new Set<string>();
  const keys: CallLogKey[] = [];
  const legacyPaths: string[] = [];
  for (const relativePath of relativePaths) {
    const key = parseArtifactRelPath(relativePath);
    if (key) keys.push(key);
    else legacyPaths.push(relativePath);
  }

  if (keys.length > 0) {
    const list = keyInList(keys);
    const rows = await db().query<{ artifact_relpath: string | null }>(
      `SELECT artifact_relpath FROM call_logs WHERE ${list.sql}`,
      list.params
    );
    for (const row of rows) {
      if (row.artifact_relpath) referenced.add(row.artifact_relpath);
    }
  }
  if (legacyPaths.length > 0) {
    const rows = await db().query<{ artifact_relpath: string }>(
      `SELECT DISTINCT artifact_relpath FROM call_logs WHERE artifact_relpath = ANY($1::text[])`,
      [legacyPaths]
    );
    for (const row of rows) referenced.add(row.artifact_relpath);
  }
  return referenced;
}
