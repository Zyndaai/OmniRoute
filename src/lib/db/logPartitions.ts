/**
 * Retention for the three day-partitioned log tables (`call_logs`, `usage_history`,
 * `proxy_logs`): whole UTC days are dropped instead of deleting rows, and
 * the call-log artifact directories of the dropped days go with them.
 *
 * Retention is rounded to whole UTC days: the newest dropped day ends at or before the
 * cutoff. The cutoff is bound as a parameter (never `now() - interval` in SQL) so the planner
 * prunes partitions at plan time.
 *
 * @module lib/db/logPartitions
 */

import fs from "node:fs";
import path from "node:path";
import { db } from "./pg";
import { getCallLogsDir } from "../usage/callLogArtifacts";

export type PartitionedLogTable = "call_logs" | "usage_history" | "proxy_logs";

const DAY_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day (YYYY-MM-DD) that contains `cutoff`. Whole days before it are droppable. */
export function cutoffDay(cutoff: Date): string {
  return cutoff.toISOString().slice(0, 10);
}

/** Makes sure every log table has partitions from yesterday to two weeks ahead. */
export async function ensureLogPartitions(daysBack = 1, daysAhead = 14): Promise<number> {
  const row = await db().queryOne<{ created: number }>(
    "SELECT omniroute_ensure_log_partitions($1, $2) AS created",
    [daysBack, daysAhead]
  );
  return Number(row?.created ?? 0);
}

/**
 * Deletes the artifact day directories (`<callLogsDir>/<YYYY-MM-DD>`, UTC) before `day`.
 * Returns the number of artifact files removed.
 */
export function removeCallLogArtifactDaysBefore(day: string): number {
  const baseDir = getCallLogsDir();
  if (!baseDir || !fs.existsSync(baseDir)) return 0;

  let deletedArtifacts = 0;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DAY_DIR_PATTERN.test(entry.name) || entry.name >= day) continue;
    const dir = path.join(baseDir, entry.name);
    try {
      deletedArtifacts += fs.readdirSync(dir).filter((file) => file.endsWith(".json")).length;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `[Cleanup] Failed to remove call log artifacts of ${entry.name}:`,
        (error as Error).message
      );
    }
  }
  return deletedArtifacts;
}

export type DropLogPartitionsResult = {
  droppedPartitions: number;
  /** Rows that were in the dropped partitions plus stragglers deleted from the default partition. */
  deletedRows: number;
  /** Artifact files removed with the dropped call_logs days. */
  deletedArtifacts: number;
};

/**
 * Drops every daily partition of `table` that lies wholly before `cutoff`, then deletes the
 * few rows older than the cutoff day that landed in the default partition (back-dated writes).
 * Dropping needs a short lock: when it times out, the error is thrown and the next
 * cleanup pass retries.
 */
export async function dropLogPartitionsBefore(
  table: PartitionedLogTable,
  cutoff: Date
): Promise<DropLogPartitionsResult> {
  const day = cutoffDay(cutoff);
  const dayStart = `${day}T00:00:00.000Z`;

  const counted = await db().queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE "timestamp" < $1`,
    [dayStart]
  );
  const rowsBefore = Number(counted?.n ?? 0);

  const dropped = await db().queryOne<{ dropped: number }>(
    "SELECT omniroute_drop_daily_partitions_before($1, $2::date) AS dropped",
    [table, day]
  );
  // Whatever is left before the cutoff day sits in the default partition.
  await db().execute(`DELETE FROM ${table} WHERE "timestamp" < $1`, [dayStart]);

  // rowsBefore covers the dropped days and the stragglers alike.
  const deletedArtifacts = table === "call_logs" ? removeCallLogArtifactDaysBefore(day) : 0;
  return {
    droppedPartitions: Number(dropped?.dropped ?? 0),
    deletedRows: rowsBefore,
    deletedArtifacts,
  };
}

/** Logs when late or back-dated writes ended up in a default partition. */
export async function warnOnDefaultPartitionRows(): Promise<void> {
  for (const table of ["call_logs", "usage_history", "proxy_logs"] as const) {
    const row = await db().queryOne<{ used: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table}_default) AS used`
    );
    if (row?.used) {
      console.warn(`[Cleanup] ${table}_default holds rows: back-dated writes outside the daily partitions.`);
    }
  }
}
