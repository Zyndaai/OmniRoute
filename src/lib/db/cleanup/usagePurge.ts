/**
 * Low-level table/artifact purge primitives backing {@link resetUsageHistory}
 * (see `../cleanup.ts`). Split out of `cleanup.ts` to keep that file under the
 * repo's file-size cap — these helpers have no state of their own, so they are
 * safe to call from any reset routine that needs generic "wipe" / "wipe before
 * cutoff" semantics.
 *
 * Table and column names come from internal constants; they are validated as plain
 * identifiers before being spliced into SQL.
 *
 * @module lib/db/cleanup/usagePurge
 */
import { db, type DbExecutor } from "../pg";
import { cleanupEmptyCallLogDirs, deleteCallArtifact } from "@/lib/usage/callLogArtifacts";

export type DeleteByPeriodTarget = {
  table: string;
  column: string;
  /** `iso` compares a timestamptz column, `date` a `date` column (UTC day). */
  cutoff: "iso" | "date";
  /** Extra condition that keeps a shared table's other rows out of the purge. */
  extraWhere?: string;
};

const DELETE_BATCH_SIZE = 10_000;
// Partitioned log tables nothing references: TRUNCATE empties all partitions at once.
// Other tables may be referenced by a foreign key, which TRUNCATE refuses.
const TRUNCATABLE_TABLES = new Set(["call_logs", "usage_history", "proxy_logs"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return name;
}

function cutoffParam(target: DeleteByPeriodTarget, cutoffIso: string): string {
  return target.cutoff === "date" ? cutoffIso.slice(0, 10) : cutoffIso;
}

function whereBefore(target: DeleteByPeriodTarget): string {
  const column = assertIdentifier(target.column);
  const compare = target.cutoff === "date" ? `"${column}" < $1::date` : `"${column}" < $1`;
  return target.extraWhere ? `${compare} AND ${target.extraWhere}` : compare;
}

export async function tableExists(
  table: string,
  executor: DbExecutor = db()
): Promise<boolean> {
  const row = await executor.queryOne<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [assertIdentifier(table)]
  );
  return row?.present === true;
}

/**
 * Empties a table (or the rows matching `extraWhere`). Counts rows first: TRUNCATE, the
 * fast way to empty a partitioned table, reports none. Pass a transaction's `tx` to make
 * several purges atomic.
 */
export async function deleteAllFromTable(
  table: string,
  extraWhere?: string,
  executor: DbExecutor = db()
): Promise<number> {
  const name = assertIdentifier(table);
  if (!(await tableExists(name, executor))) return 0;
  if (extraWhere || !TRUNCATABLE_TABLES.has(name)) {
    return (
      await executor.execute(`DELETE FROM ${name}${extraWhere ? ` WHERE ${extraWhere}` : ""}`)
    ).changes;
  }
  const counted = await executor.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
  await executor.execute(`TRUNCATE ${name}`);
  return Number(counted?.n ?? 0);
}

export async function deleteFromTableBefore(
  target: DeleteByPeriodTarget,
  cutoffIso: string,
  executor: DbExecutor = db()
): Promise<number> {
  const table = assertIdentifier(target.table);
  if (!(await tableExists(table, executor))) return 0;

  return (
    await executor.execute(`DELETE FROM ${table} WHERE ${whereBefore(target)}`, [
      cutoffParam(target, cutoffIso),
    ])
  ).changes;
}

/**
 * Batched delete that yields between batches. Batches go by `ctid`, so use it on plain
 * (non-partitioned) tables only: a partitioned parent has one ctid space per partition.
 */
export async function deleteFromTableBeforeInBatches(
  target: DeleteByPeriodTarget,
  cutoffIso: string
): Promise<number> {
  const table = assertIdentifier(target.table);
  if (!(await tableExists(table))) return 0;

  const sql = `DELETE FROM ${table}
     WHERE ctid = ANY(ARRAY(
       SELECT ctid FROM ${table}
       WHERE ${whereBefore(target)}
       LIMIT $2
     ))`;
  const cutoff = cutoffParam(target, cutoffIso);
  let deleted = 0;

  while (true) {
    const batch = (await db().execute(sql, [cutoff, DELETE_BATCH_SIZE])).changes;
    deleted += batch;
    if (batch < DELETE_BATCH_SIZE) return deleted;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function collectCallLogArtifactsBefore(
  cutoffIso: string,
  executor: DbExecutor = db()
): Promise<string[]> {
  const rows = await executor.query<{ artifact_relpath?: string | null }>(
    `SELECT artifact_relpath FROM call_logs WHERE "timestamp" < $1 AND artifact_relpath IS NOT NULL`,
    [cutoffIso]
  );

  return rows
    .map((row) => row.artifact_relpath)
    .filter((relPath): relPath is string => typeof relPath === "string" && relPath.length > 0);
}

export function deleteCallLogArtifacts(relativePaths: string[]): {
  deletedArtifacts: number;
  errors: number;
} {
  const result = { deletedArtifacts: 0, errors: 0 };

  for (const relPath of new Set(relativePaths)) {
    if (deleteCallArtifact(relPath)) {
      result.deletedArtifacts++;
    }
  }

  cleanupEmptyCallLogDirs();
  return result;
}
