/**
 * Bounded call-log rotation and pruning.
 *
 * Extracted from callLogs.ts (#8249/#10125 file-size gate) — deletion of expired/overflow
 * rows, orphan artifact scanning, and the throttled rotation scheduler. Pure extraction, no
 * behavior change: callLogs.ts re-exports these symbols so existing importers are unaffected.
 */

import fs from "node:fs";
import path from "node:path";
import { db } from "../db/pg";
import { expirePendingCallLogDetails } from "../db/callLogDetails";
import {
  findReferencedArtifacts,
  keyInList,
  parseArtifactRelPath,
  selectCallLogIdsBefore,
  selectOverflowArtifactPaths,
  type CallLogKey,
} from "./callLogsBoundedQueries";
import { getCallLogsDir, deleteCallArtifact, type CallLogDetailState } from "./callLogArtifacts";
import {
  getCallLogMaxEntries,
  getCallLogRetentionDays,
  getCallLogRetentionDaysOverride,
  getCallLogsTableMaxRows,
} from "../logEnv";
import { getPersistedRetentionDays } from "../db/retentionSettings";

const CALL_LOG_ROTATE_THROTTLE_MS = 60_000;
const CALL_LOG_ROTATE_BATCH_SIZE = 100;
const CALL_LOG_ORPHAN_MIN_AGE_MS = 5 * 60_000;
let lastCallLogRotationScheduledAt = 0;
let callLogRotateInFlight = false;
let callLogRotateScheduled = false;

/**
 * Request log retention in days: explicit variable override, then the dashboard-saved
 * `retention.callLogs`, then the variable-or-7-day fallback. A settings read failure
 * (very early startup) falls back to the variable.
 */
async function resolveCallLogRetentionDays(): Promise<number> {
  const override = getCallLogRetentionDaysOverride();
  if (override !== null) return override;
  try {
    return (await getPersistedRetentionDays("callLogs")) ?? getCallLogRetentionDays();
  } catch {
    return getCallLogRetentionDays();
  }
}

export type DeleteResult = {
  deletedRows: number;
  deletedArtifacts: number;
};

/**
 * Frees the artifact reference of the row that owns `relativePath`. The path is a pure
 * function of the row's (timestamp, id), so the row is found through the primary key; a
 * legacy path that does not follow the pattern falls back to a scan by path.
 */
export async function clearArtifactReference(
  relativePath: string,
  nextState: CallLogDetailState
): Promise<void> {
  const key = parseArtifactRelPath(relativePath);
  await db().execute(
    `
      UPDATE call_logs
      SET detail_state = $1,
          artifact_relpath = NULL,
          artifact_size_bytes = NULL,
          artifact_sha256 = NULL
      WHERE ${key ? `id = $3 AND "timestamp" = $4::timestamptz AND` : ""} artifact_relpath = $2
    `,
    key ? [nextState, relativePath, key.id, key.timestamp] : [nextState, relativePath]
  );
}

// Batches stay well under the 65535 bound-parameter limit (two parameters per key).
const DELETE_ID_CHUNK_SIZE = 500;

async function takeOverflowArtifactSlot(relativePath: string, baseDir: string): Promise<boolean> {
  if (deleteCallArtifact(relativePath, baseDir)) {
    await clearArtifactReference(relativePath, "missing");
    return true;
  }
  if (relativePath && fs.existsSync(path.join(baseDir, relativePath))) return false;
  // Reference without a file: free it like a detail read does,
  // so later passes select new rows instead of stalling.
  await clearArtifactReference(relativePath, "missing");
  return true;
}

async function deleteCallLogRowsByKeys(keys: CallLogKey[]): Promise<DeleteResult> {
  if (keys.length === 0) {
    return { deletedRows: 0, deletedArtifacts: 0 };
  }

  let deletedRows = 0;
  let deletedArtifacts = 0;

  for (let i = 0; i < keys.length; i += DELETE_ID_CHUNK_SIZE) {
    const list = keyInList(keys.slice(i, i + DELETE_ID_CHUNK_SIZE));
    // Each delete prunes to the partitions of its keys.
    const rows = await db().query<{ artifact_relpath: string | null }>(
      `DELETE FROM call_logs WHERE ${list.sql} RETURNING artifact_relpath`,
      list.params
    );
    deletedRows += rows.length;
    for (const row of rows) {
      if (deleteCallArtifact(row.artifact_relpath)) {
        deletedArtifacts++;
      }
    }
  }

  return {
    deletedRows,
    deletedArtifacts,
  };
}

type OrphanScanCursor = {
  baseDir: string;
  root: fs.Dir;
  day: fs.Dir | null;
  dayName: string | null;
  pendingDayName: string | null;
};

type OrphanScanBatch = {
  candidates: string[];
  exhausted: boolean;
  scannedEntries: number;
};

let orphanScanCursor: OrphanScanCursor | null = null;

function closeOrphanScanCursor(): void {
  try {
    orphanScanCursor?.day?.closeSync();
  } catch {}
  try {
    orphanScanCursor?.root.closeSync();
  } catch {}
  orphanScanCursor = null;
}

function readOrphanCandidates(
  baseDir: string,
  candidateLimit: number,
  scanLimit: number
): OrphanScanBatch {
  let scannedEntries = 0;
  if (!orphanScanCursor || orphanScanCursor.baseDir !== baseDir) {
    closeOrphanScanCursor();
    if (scannedEntries >= scanLimit) {
      return { candidates: [], exhausted: false, scannedEntries };
    }
    scannedEntries++;
    orphanScanCursor = {
      baseDir,
      root: fs.opendirSync(baseDir),
      day: null,
      dayName: null,
      pendingDayName: null,
    };
  }

  const candidates: string[] = [];
  let exhausted = false;
  while (candidates.length < candidateLimit && scannedEntries < scanLimit) {
    if (!orphanScanCursor.day) {
      if (orphanScanCursor.pendingDayName) {
        scannedEntries++;
        const dayName = orphanScanCursor.pendingDayName;
        orphanScanCursor.pendingDayName = null;
        try {
          orphanScanCursor.day = fs.opendirSync(path.join(baseDir, dayName));
          orphanScanCursor.dayName = dayName;
        } catch {
          continue;
        }
        continue;
      }

      scannedEntries++;
      const dayEntry = orphanScanCursor.root.readSync();
      if (!dayEntry) {
        closeOrphanScanCursor();
        exhausted = true;
        break;
      }
      if (!dayEntry.isDirectory()) continue;
      orphanScanCursor.pendingDayName = dayEntry.name;
      continue;
    }

    scannedEntries++;
    const fileEntry = orphanScanCursor.day.readSync();
    if (!fileEntry) {
      try {
        orphanScanCursor.day.closeSync();
      } catch {}
      orphanScanCursor.day = null;
      orphanScanCursor.dayName = null;
      continue;
    }
    if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) continue;
    candidates.push(path.posix.join(orphanScanCursor.dayName!, fileEntry.name));
  }
  return { candidates, exhausted, scannedEntries };
}

export async function cleanupOrphanCallLogFiles(
  baseDir: string | null = getCallLogsDir(),
  options: { maxCandidates?: number; maxScanEntries?: number; minAgeMs?: number } = {}
): Promise<number> {
  if (!baseDir || !fs.existsSync(baseDir)) return 0;

  const maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;
  const maxScanEntries = options.maxScanEntries ?? Number.POSITIVE_INFINITY;
  const minAgeMs = options.minAgeMs ?? 0;
  if (maxCandidates <= 0 || maxScanEntries <= 0) return 0;

  try {
    let deleted = 0;
    let remainingCandidates = maxCandidates;
    let remainingScanEntries = maxScanEntries;
    while (remainingCandidates > 0 && remainingScanEntries > 0) {
      const { candidates, exhausted, scannedEntries } = readOrphanCandidates(
        baseDir,
        Math.min(remainingCandidates, DELETE_ID_CHUNK_SIZE),
        remainingScanEntries
      );
      remainingCandidates -= candidates.length;
      remainingScanEntries -= scannedEntries;
      const oldEnough = candidates.filter((relativePath) => {
        if (minAgeMs <= 0) return true;
        try {
          return Date.now() - fs.statSync(path.join(baseDir, relativePath)).mtimeMs >= minAgeMs;
        } catch {
          return false;
        }
      });
      const referenced = await findReferencedArtifacts(oldEnough);
      for (const relativePath of oldEnough) {
        if (!referenced.has(relativePath) && deleteCallArtifact(relativePath, baseDir)) deleted++;
      }
      if (exhausted || scannedEntries === 0) break;
    }
    return deleted;
  } catch (error) {
    closeOrphanScanCursor();
    console.error("[callLogs] Failed to prune orphan request artifacts:", (error as Error).message);
    return 0;
  }
}

export async function cleanupOverflowCallLogFiles(
  baseDir: string | null = getCallLogsDir(),
  maxEntries?: number,
  maxDeletes = Number.POSITIVE_INFINITY
): Promise<number> {
  if (!baseDir || !fs.existsSync(baseDir)) return 0;

  const limit = maxEntries ?? getCallLogMaxEntries();
  if (!Number.isInteger(limit) || limit < 1 || maxDeletes <= 0) return 0;

  try {
    let deleted = 0;
    while (deleted < maxDeletes) {
      const paths = await selectOverflowArtifactPaths(
        limit,
        Math.min(DELETE_ID_CHUNK_SIZE, maxDeletes - deleted)
      );
      if (paths.length === 0) break;
      let progress = 0;
      for (const relativePath of paths) {
        if (await takeOverflowArtifactSlot(relativePath, baseDir)) progress++;
      }
      deleted += progress;
      if (progress === 0) break;
    }
    return deleted;
  } catch (error) {
    console.error(
      "[callLogs] Failed to prune overflow request artifacts:",
      (error as Error).message
    );
    return 0;
  }
}

export async function deleteCallLogsBefore(
  cutoff: string,
  maxDeletes = Number.POSITIVE_INFINITY
): Promise<DeleteResult> {
  let deletedRows = 0;
  let deletedArtifacts = 0;
  while (deletedRows < maxDeletes) {
    const keys = await selectCallLogIdsBefore(cutoff, Math.min(5000, maxDeletes - deletedRows));
    if (keys.length === 0) break;
    const result = await deleteCallLogRowsByKeys(keys);
    deletedRows += result.deletedRows;
    deletedArtifacts += result.deletedArtifacts;
    if (result.deletedRows === 0) break;
  }
  return { deletedRows, deletedArtifacts };
}

export async function trimCallLogsToMaxRows(
  maxRows = getCallLogsTableMaxRows(),
  maxDeletes = Number.POSITIVE_INFINITY
): Promise<DeleteResult> {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxDeletes <= 0) {
    return { deletedRows: 0, deletedArtifacts: 0 };
  }

  let deletedRows = 0;
  let deletedArtifacts = 0;

  while (deletedRows < maxDeletes) {
    const currentCount = await db().queryOne<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM call_logs"
    );
    const total = Number(currentCount?.cnt ?? 0);
    if (total <= maxRows) break;

    const toDelete = Math.min(total - maxRows, 5000, maxDeletes - deletedRows);
    // (id, "timestamp") pairs, oldest first: the delete then prunes to their partitions.
    const keys = (
      await db().query<{ id: string; timestamp: string }>(
        `SELECT id, "timestamp" FROM call_logs ORDER BY "timestamp" ASC LIMIT $1`,
        [toDelete]
      )
    ).map((row) => ({ id: String(row.id), timestamp: row.timestamp }));
    const result = await deleteCallLogRowsByKeys(keys);
    deletedRows += result.deletedRows;
    deletedArtifacts += result.deletedArtifacts;
    if (result.deletedRows === 0) break;
  }

  return { deletedRows, deletedArtifacts };
}

export function handleCallLogRotateError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[callLogs] Failed to rotate request artifacts:", message);
}

export async function rotateCallLogs(): Promise<void> {
  try {
    const logsDir = getCallLogsDir();
    if (!logsDir || !fs.existsSync(logsDir)) return;

    const retentionMs = (await resolveCallLogRetentionDays()) * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - retentionMs).toISOString();

    // A process that died mid-write leaves its row 'pending'; once the insert-time
    // deadline passes, the write can no longer publish, so make it terminal 'missing'.
    await expirePendingCallLogDetails(db());
    await deleteCallLogsBefore(cutoff, CALL_LOG_ROTATE_BATCH_SIZE);
    await trimCallLogsToMaxRows(getCallLogsTableMaxRows(), CALL_LOG_ROTATE_BATCH_SIZE);
    await cleanupOverflowCallLogFiles(logsDir, getCallLogMaxEntries(), CALL_LOG_ROTATE_BATCH_SIZE);
    await cleanupOrphanCallLogFiles(logsDir, {
      maxCandidates: CALL_LOG_ROTATE_BATCH_SIZE,
      maxScanEntries: CALL_LOG_ROTATE_BATCH_SIZE,
      minAgeMs: CALL_LOG_ORPHAN_MIN_AGE_MS,
    });
  } catch (error) {
    handleCallLogRotateError(error);
  }
}

function runScheduledCallLogRotation() {
  if (callLogRotateInFlight) return;
  callLogRotateInFlight = true;
  setImmediate(() => {
    rotateCallLogs()
      .catch(handleCallLogRotateError)
      .finally(() => {
        callLogRotateInFlight = false;
      });
  });
}

export function scheduleCallLogRotation() {
  if (!getCallLogsDir()) return;
  const elapsed = Date.now() - lastCallLogRotationScheduledAt;
  if (elapsed >= CALL_LOG_ROTATE_THROTTLE_MS) {
    lastCallLogRotationScheduledAt = Date.now();
    runScheduledCallLogRotation();
    return;
  }
  if (callLogRotateScheduled) return;
  callLogRotateScheduled = true;
  lastCallLogRotationScheduledAt = Date.now();
  const timer = setTimeout(() => {
    callLogRotateScheduled = false;
    runScheduledCallLogRotation();
  }, CALL_LOG_ROTATE_THROTTLE_MS - elapsed);
  timer.unref?.();
}
