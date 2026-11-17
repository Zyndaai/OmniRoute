import { db, ts, type DbExecutor } from "./pg";

/** Recover writes that can no longer block a body-export cursor. */
export async function expirePendingCallLogDetails(
  executor: DbExecutor = db(),
  now: number = Date.now()
): Promise<void> {
  // The time bound limits the scan to the last day or two of partitions.
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  await executor.execute(
    `UPDATE call_logs
        SET detail_state = 'missing', detail_pending_until = NULL
      WHERE "timestamp" > $1
        AND detail_state = 'pending'
        AND (detail_pending_until IS NULL OR detail_pending_until <= $2)`,
    [dayAgo, ts(now)]
  );
}

/**
 * Only a still-pending write may publish its artifact after expiry recovery.
 * Pass the row's `timestamp` when the writer has it so the update prunes to one partition.
 */
export async function publishPendingCallLogDetail(
  executor: DbExecutor = db(),
  id: string,
  artifact: { relPath: string; sizeBytes: number; sha256: string },
  timestamp?: string | null
): Promise<boolean> {
  const rowTs = ts(timestamp);
  const result = await executor.execute(
    `UPDATE call_logs
        SET detail_state = 'ready', detail_pending_until = NULL,
            artifact_relpath = $1, artifact_size_bytes = $2, artifact_sha256 = $3
      WHERE id = $4 AND detail_state = 'pending'
        AND detail_pending_until > $5${rowTs ? ` AND "timestamp" = $6` : ""}`,
    [
      artifact.relPath,
      artifact.sizeBytes,
      artifact.sha256,
      id,
      new Date().toISOString(),
      ...(rowTs ? [rowTs] : []),
    ]
  );
  return result.changes === 1;
}

export async function failPendingCallLogDetail(
  executor: DbExecutor = db(),
  id: string,
  timestamp?: string | null
): Promise<void> {
  const rowTs = ts(timestamp);
  await executor.execute(
    `UPDATE call_logs SET detail_state = 'missing', detail_pending_until = NULL
      WHERE id = $1 AND detail_state = 'pending'${rowTs ? ` AND "timestamp" = $2` : ""}`,
    rowTs ? [id, rowTs] : [id]
  );
}
