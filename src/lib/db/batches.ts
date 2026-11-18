import { db, sqlLimit, ts, type DbExecutor } from "./pg";
import { jsonTextParam, jsonValueParam, stripNul } from "./pgJsonText";
import { deleteFile, deleteFileOwnedBy } from "./files";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("DB_BATCHES");

/** Epoch-seconds projection of a timestamptz column (the public shape stays numeric). */
const epoch = (column: string, alias: string) =>
  `floor(extract(epoch FROM ${column}))::bigint AS "${alias}"`;

const BATCH_SELECT = `SELECT id, endpoint, completion_window AS "completionWindow", status,
  input_file_id AS "inputFileId", output_file_id AS "outputFileId", error_file_id AS "errorFileId",
  api_key_id AS "apiKeyId", model,
  request_counts_total AS "requestCountsTotal",
  request_counts_completed AS "requestCountsCompleted",
  request_counts_failed AS "requestCountsFailed",
  metadata, errors, usage,
  output_expires_after_seconds AS "outputExpiresAfterSeconds",
  output_expires_after_anchor AS "outputExpiresAfterAnchor",
  ${epoch("created_at", "createdAt")}, ${epoch("in_progress_at", "inProgressAt")},
  ${epoch("finalizing_at", "finalizingAt")}, ${epoch("completed_at", "completedAt")},
  ${epoch("failed_at", "failedAt")}, ${epoch("expired_at", "expiredAt")},
  ${epoch("cancelling_at", "cancellingAt")}, ${epoch("cancelled_at", "cancelledAt")}
  FROM batches`;

function parseBatchRow(row: any): BatchRecord {
  const camel = { ...row } as any;
  for (const key of ["metadata", "errors", "usage"] as const) {
    if (typeof camel[key] === "string") {
      try {
        camel[key] = JSON.parse(camel[key]);
      } catch {
        camel[key] = null;
      }
    }
  }
  // Normalize numeric date fields to ensure they are valid numbers
  const coerceNum = (v: any): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  camel.createdAt = coerceNum(camel.createdAt) ?? 0;
  camel.inProgressAt = coerceNum(camel.inProgressAt);
  // `expires_at` was never written and is gone; the field stays for the public shape.
  camel.expiresAt = null;
  camel.finalizingAt = coerceNum(camel.finalizingAt);
  camel.completedAt = coerceNum(camel.completedAt);
  camel.failedAt = coerceNum(camel.failedAt);
  camel.expiredAt = coerceNum(camel.expiredAt);
  camel.cancellingAt = coerceNum(camel.cancellingAt);
  camel.cancelledAt = coerceNum(camel.cancelledAt);
  return camel as BatchRecord;
}

export interface BatchRecord {
  id: string;
  endpoint: string;
  completionWindow: string;
  status:
    | "validating"
    | "failed"
    | "in_progress"
    | "finalizing"
    | "completed"
    | "expired"
    | "cancelling"
    | "cancelled";
  inputFileId: string;
  outputFileId?: string | null;
  errorFileId?: string | null;
  createdAt: number;
  inProgressAt?: number | null;
  expiresAt?: number | null;
  finalizingAt?: number | null;
  completedAt?: number | null;
  failedAt?: number | null;
  expiredAt?: number | null;
  cancellingAt?: number | null;
  cancelledAt?: number | null;
  requestCountsTotal: number;
  requestCountsCompleted: number;
  requestCountsFailed: number;
  metadata?: Record<string, any> | null;
  apiKeyId?: string | null;
  errors?: any | null;
  model?: string | null;
  usage?: any | null;
  outputExpiresAfterSeconds?: number | null;
  outputExpiresAfterAnchor?: string | null;
}

export type BatchItemCheckpointStatus = "pending" | "processing" | "completed" | "errored";

export interface BatchItemCheckpoint {
  batchId: string;
  lineNumber: number;
  customId: string | null;
  status: BatchItemCheckpointStatus;
  result: any | null;
  error: any | null;
  createdAt: number;
  updatedAt: number;
}

function parseJsonColumn(value: unknown): any | null {
  // jsonb arrives already parsed; a top-level string is a real value, not JSON text.
  return value ?? null;
}

const safeCustomId = (id: string | null) => (id == null ? null : stripNul(id));

function parseBatchItemCheckpoint(row: any): BatchItemCheckpoint {
  return {
    batchId: row.batch_id,
    lineNumber: Number(row.line_number),
    customId: row.custom_id ?? null,
    status: row.status,
    result: parseJsonColumn(row.result),
    error: parseJsonColumn(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

type ColumnWriter = { column: string; value: (v: any) => unknown; cast?: string };

const timestampWriter = (column: string): ColumnWriter => ({ column, value: (v) => ts(v) });
const jsonWriter = (column: string): ColumnWriter => ({
  column,
  cast: "::jsonb",
  value: (v) => (v ? (typeof v === "string" ? jsonTextParam(v) : jsonValueParam(v)) : null),
});

/** BatchRecord field -> column. Fields not listed here (e.g. `expiresAt`) have no column. */
const BATCH_COLUMNS: Record<string, ColumnWriter> = {
  id: { column: "id", value: (v) => v },
  endpoint: { column: "endpoint", value: (v) => v },
  completionWindow: { column: "completion_window", value: (v) => v },
  status: { column: "status", value: (v) => v },
  inputFileId: { column: "input_file_id", value: (v) => v },
  outputFileId: { column: "output_file_id", value: (v) => v ?? null },
  errorFileId: { column: "error_file_id", value: (v) => v ?? null },
  apiKeyId: { column: "api_key_id", value: (v) => v ?? null },
  model: { column: "model", value: (v) => v ?? null },
  requestCountsTotal: {
    column: "request_counts_total",
    value: (v) => Math.max(0, Math.round(Number(v) || 0)),
  },
  requestCountsCompleted: {
    column: "request_counts_completed",
    value: (v) => Math.max(0, Math.round(Number(v) || 0)),
  },
  requestCountsFailed: {
    column: "request_counts_failed",
    value: (v) => Math.max(0, Math.round(Number(v) || 0)),
  },
  metadata: jsonWriter("metadata"),
  errors: jsonWriter("errors"),
  usage: jsonWriter("usage"),
  outputExpiresAfterSeconds: {
    column: "output_expires_after_seconds",
    value: (v) => (v == null ? null : Math.round(Number(v))),
  },
  outputExpiresAfterAnchor: { column: "output_expires_after_anchor", value: (v) => v ?? null },
  createdAt: timestampWriter("created_at"),
  inProgressAt: timestampWriter("in_progress_at"),
  finalizingAt: timestampWriter("finalizing_at"),
  completedAt: timestampWriter("completed_at"),
  failedAt: timestampWriter("failed_at"),
  expiredAt: timestampWriter("expired_at"),
  cancellingAt: timestampWriter("cancelling_at"),
  cancelledAt: timestampWriter("cancelled_at"),
};

function writableEntries(record: Record<string, unknown>) {
  const entries: Array<{ writer: ColumnWriter; value: unknown }> = [];
  for (const [key, raw] of Object.entries(record)) {
    const writer = BATCH_COLUMNS[key];
    if (!writer || raw === undefined) continue;
    entries.push({ writer, value: writer.value(raw) });
  }
  return entries;
}

export async function createBatch(
  batch: Omit<
    BatchRecord,
    | "id"
    | "createdAt"
    | "requestCountsTotal"
    | "requestCountsCompleted"
    | "requestCountsFailed"
    | "status"
  > & { status?: BatchRecord["status"] }
): Promise<BatchRecord> {
  const id = "batch_" + uuidv4().replaceAll("-", "").substring(0, 24);
  const createdAt = Math.floor(Date.now() / 1000);
  const record: BatchRecord = {
    ...batch,
    id,
    createdAt,
    status: batch.status || "validating",
    requestCountsTotal: 0,
    requestCountsCompleted: 0,
    requestCountsFailed: 0,
    errors: batch.errors || null,
    model: batch.model || null,
    usage: batch.usage || null,
    outputExpiresAfterSeconds: batch.outputExpiresAfterSeconds || null,
    outputExpiresAfterAnchor: batch.outputExpiresAfterAnchor || null,
  };

  const entries = writableEntries(record as unknown as Record<string, unknown>);
  const columns = entries.map((e) => e.writer.column);
  const placeholders = entries.map((e, i) => `$${i + 1}${e.writer.cast ?? ""}`);

  await db().execute(
    `INSERT INTO batches (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
    entries.map((e) => e.value)
  );

  return record;
}

export async function getBatch(id: string): Promise<BatchRecord | null> {
  const row = await db().queryOne(`${BATCH_SELECT} WHERE id = $1`, [id]);
  if (!row) return null;
  return parseBatchRow(row);
}

export async function updateBatch(id: string, updates: Partial<BatchRecord>): Promise<boolean> {
  const entries = writableEntries(updates as Record<string, unknown>);
  if (entries.length === 0) return false;

  const setClause = entries.map((e, i) => `${e.writer.column} = $${i + 1}${e.writer.cast ?? ""}`);
  const result = await db().execute(
    `UPDATE batches SET ${setClause.join(", ")} WHERE id = $${entries.length + 1}`,
    [...entries.map((e) => e.value), id]
  );
  return result.changes > 0;
}

const CHECKPOINT_INSERT_CHUNK = 5000;

export async function ensureBatchItemCheckpoints(
  batchId: string,
  items: Array<{ lineNumber: number; customId: string | null }>
): Promise<void> {
  if (items.length === 0) return;

  const now = ts(Math.floor(Date.now() / 1000));
  await db().transaction(async (tx) => {
    for (let i = 0; i < items.length; i += CHECKPOINT_INSERT_CHUNK) {
      const chunk = items.slice(i, i + CHECKPOINT_INSERT_CHUNK);
      await tx.execute(
        `INSERT INTO batch_item_checkpoints (batch_id, line_number, custom_id, status, created_at, updated_at)
         SELECT $1, t.line_number, t.custom_id, 'pending', $4::timestamptz, $4::timestamptz
           FROM unnest($2::int[], $3::text[]) AS t(line_number, custom_id)
         ON CONFLICT (batch_id, line_number) DO NOTHING`,
        [batchId, chunk.map((c) => c.lineNumber), chunk.map((c) => safeCustomId(c.customId)), now]
      );
    }
  });
}

export async function countBatchItemCheckpoints(batchId: string): Promise<number> {
  const row = await db().queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM batch_item_checkpoints WHERE batch_id = $1`,
    [batchId]
  );
  return row ? Number(row.c) : 0;
}

export async function listBatchItemCheckpoints(batchId: string): Promise<BatchItemCheckpoint[]> {
  const rows = await db().query(
    `SELECT batch_id, line_number, custom_id, status, result, error,
            floor(extract(epoch FROM created_at))::bigint AS created_at,
            floor(extract(epoch FROM updated_at))::bigint AS updated_at
       FROM batch_item_checkpoints
      WHERE batch_id = $1
      ORDER BY line_number ASC`,
    [batchId]
  );
  return rows.map((row) => parseBatchItemCheckpoint(row));
}

export async function markBatchItemProcessing(
  batchId: string,
  item: { lineNumber: number; customId: string | null }
): Promise<void> {
  const now = ts(Math.floor(Date.now() / 1000));
  await db().execute(
    `INSERT INTO batch_item_checkpoints (
       batch_id, line_number, custom_id, status, result, error, created_at, updated_at
     ) VALUES ($1, $2, $3, 'processing', NULL, NULL, $4, $4)
     ON CONFLICT (batch_id, line_number) DO UPDATE SET
       custom_id = EXCLUDED.custom_id,
       status = 'processing',
       result = NULL,
       error = NULL,
       updated_at = EXCLUDED.updated_at`,
    [batchId, item.lineNumber, safeCustomId(item.customId), now]
  );
}

export async function markBatchItemResult(
  batchId: string,
  item: { lineNumber: number; customId: string | null },
  result: any
): Promise<void> {
  await db().execute(
    `UPDATE batch_item_checkpoints
        SET custom_id = $1, status = 'completed', result = $2::jsonb, error = NULL, updated_at = $3
      WHERE batch_id = $4 AND line_number = $5`,
    [
      safeCustomId(item.customId),
      jsonValueParam(result),
      ts(Math.floor(Date.now() / 1000)),
      batchId,
      item.lineNumber,
    ]
  );
}

export async function markBatchItemError(
  batchId: string,
  item: { lineNumber: number; customId: string | null },
  error: any
): Promise<void> {
  await db().execute(
    `UPDATE batch_item_checkpoints
        SET custom_id = $1, status = 'errored', result = NULL, error = $2::jsonb, updated_at = $3
      WHERE batch_id = $4 AND line_number = $5`,
    [
      safeCustomId(item.customId),
      jsonValueParam(error),
      ts(Math.floor(Date.now() / 1000)),
      batchId,
      item.lineNumber,
    ]
  );
}

export async function listBatches(
  apiKeyId?: string,
  limit: number = 20,
  after?: string
): Promise<BatchRecord[]> {
  const resolvedAfterBatch = after ? await getBatch(after) : null;
  // #14481 item 5/LEDGER-20: `getBatch()` applies no owner filter, so an
  // `after` cursor belonging to a DIFFERENT tenant used to still resolve and
  // its `created_at` was used as the pagination bound — an existence +
  // timestamp oracle for another tenant's batch. When this call IS
  // owner-scoped (`apiKeyId` set), treat a foreign-owned cursor exactly like
  // an unknown one (ignore it) instead of trusting its timestamp.
  const afterBatch =
    apiKeyId && resolvedAfterBatch && resolvedAfterBatch.apiKeyId !== apiKeyId
      ? null
      : resolvedAfterBatch;

  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses: string[] = [];
  if (apiKeyId) clauses.push(`api_key_id = ${add(apiKeyId)}`);
  if (afterBatch) {
    const at = add(ts(afterBatch.createdAt));
    clauses.push(`(created_at < ${at} OR (created_at = ${at} AND id < ${add(after)}))`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db().query(
    `${BATCH_SELECT} ${where} ORDER BY created_at DESC, id DESC LIMIT ${add(sqlLimit(limit))}`,
    params
  );
  return rows.map((row) => parseBatchRow(row));
}

export async function countBatches(apiKeyId?: string): Promise<number> {
  const row = apiKeyId
    ? await db().queryOne<{ c: number }>(
        `SELECT COUNT(*) AS c FROM batches WHERE api_key_id = $1`,
        [apiKeyId]
      )
    : await db().queryOne<{ c: number }>(`SELECT COUNT(*) AS c FROM batches`);
  return row ? Number(row.c) : 0;
}

export async function getPendingBatches(): Promise<BatchRecord[]> {
  const rows = await db().query(
    `${BATCH_SELECT} WHERE status IN ('validating', 'in_progress', 'finalizing', 'cancelling')`
  );
  return rows.map((row) => parseBatchRow(row));
}

export async function getTerminalBatches(): Promise<BatchRecord[]> {
  const rows = await db().query(
    `${BATCH_SELECT} WHERE status IN ('completed', 'failed', 'cancelled', 'expired') ORDER BY created_at ASC`
  );
  return rows.map((row) => parseBatchRow(row));
}

export async function deleteBatch(id: string): Promise<boolean> {
  return db().transaction(async (tx) => {
    // Lock the row so two concurrent deletes of one batch cannot both pass the check.
    const batch = await tx.queryOne<{
      inputFileId: string | null;
      outputFileId: string | null;
      errorFileId: string | null;
    }>(
      `SELECT input_file_id AS "inputFileId", output_file_id AS "outputFileId",
              error_file_id AS "errorFileId"
         FROM batches WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!batch) return false;

    await tx.execute(`DELETE FROM batch_item_checkpoints WHERE batch_id = $1`, [id]);

    // The batch row goes first so the file references below no longer see it.
    const result = await tx.execute(`DELETE FROM batches WHERE id = $1`, [id]);

    // Soft-delete associated files (input, output, error) — but only when no
    // OTHER batch still references the same file id (#13681). A file shared
    // across batches (e.g. one input file reused for several batch submissions)
    // must survive as long as any sibling batch still points at it.
    for (const fileId of [batch.inputFileId, batch.outputFileId, batch.errorFileId]) {
      if (!fileId) continue;
      if (await isFileReferencedByOtherBatch(fileId, [id], tx)) continue;
      try {
        await deleteFile(fileId, tx);
      } catch {
        /* ignore */
      }
    }

    return result.changes > 0;
  });
}

/**
 * Scope of a `deleteBatchesMatching` sweep. The intent is explicit on purpose:
 * a caller either names the API key whose batches it may sweep, or states
 * `allTenants: true` — there is no default that widens to the whole instance.
 */
export type DeleteCompletedBatchesScope = { apiKeyId: string } | { allTenants: true };

/** Both sweep modes commit in chunks of this many batches (SEC-D, LEDGER-4). */
export const INSTANCE_SWEEP_CHUNK = 200;

/**
 * Upper bound on the number of `INSTANCE_SWEEP_CHUNK`-sized chunks a single
 * `deleteCompletedBatches` call may run (#13680). 25 × 200 = 5000 batches/request
 * is a judgment call, not a hard constraint; any caller with more to sweep gets
 * `hasMore: true` back and resumes by calling again — already-swept rows are gone,
 * so the next SELECT picks up the next surviving rows on its own.
 */
export const MAX_CHUNKS_PER_REQUEST = 25;

/**
 * True when some batch OTHER than one of `excludeBatchIds` still references
 * `fileId` as its input/output/error file (#13681). Used before soft-deleting
 * a file to avoid nulling content a surviving batch still needs. `executor`
 * lets a caller run the check inside its own transaction.
 */
export async function isFileReferencedByOtherBatch(
  fileId: string,
  excludeBatchIds: string[],
  executor: DbExecutor = db()
): Promise<boolean> {
  const row = await executor.queryOne(
    `SELECT 1 AS found FROM batches
      WHERE (input_file_id = $1 OR output_file_id = $1 OR error_file_id = $1)
        AND NOT (id = ANY($2::text[]))
      LIMIT 1`,
    [fileId, excludeBatchIds]
  );
  return !!row;
}

/**
 * Delete the batches matching `whereSql`/`params` and the files they
 * reference. Shared by `deleteCompletedBatches()` (the operator-triggered
 * DELETE /api/v1/batches/delete-completed route -- exact contract preserved:
 * only `status = 'completed'`, no age filter) and
 * `deleteTerminalBatchesOlderThan()` (the automatic cleanup sweep -- every
 * terminal status, gated by age). `whereSql` references its `params` as
 * `$1..$n`.
 *
 * `{ apiKeyId }` additionally restricts the match to that key's own batches,
 * exactly like `listBatches`/`countBatches`. `{ allTenants: true }` covers
 * every matching row regardless of owner and is reserved for an authenticated
 * dashboard session or an internal cron sweep with no untrusted caller
 * (GHSA-wvxc-jp3v-5mg5). A missing/empty `apiKeyId` without `allTenants`
 * throws instead of silently widening the sweep, and a scope carrying BOTH
 * `apiKeyId` and `allTenants` is rejected rather than widened.
 *
 * Batches whose `api_key_id` IS NULL are intentionally OUT of a key-scoped sweep.
 * In key mode the file half is owner-scoped too: only files whose api_key_id
 * is the caller's are soft-deleted; a referenced file another tenant owns (or
 * an unowned one) is left intact and is not counted in deletedFiles.
 *
 * The file soft-deletes, the checkpoint DELETE and the batches DELETE for a
 * set of batch ids run in one transaction per chunk of `INSTANCE_SWEEP_CHUNK`
 * ids, so a failure inside chunk N leaves chunks < N committed, chunk N fully
 * rolled back, and rethrows. A single call commits at most
 * `MAX_CHUNKS_PER_REQUEST` chunks (#13680); beyond that it returns `hasMore: true`.
 *
 * The loop must make progress: it remembers the first id of the previous chunk
 * and throws if the next chunk starts with the same id (LEDGER-22).
 */
async function deleteBatchesMatching(
  whereSql: string,
  params: unknown[],
  scope: DeleteCompletedBatchesScope
): Promise<{
  deletedBatches: number;
  deletedFiles: number;
  hasMore: boolean;
}> {
  const scopeObj = scope && typeof scope === "object" ? scope : {};
  const allTenants = "allTenants" in scopeObj && scopeObj.allTenants === true;
  const apiKeyId = "apiKeyId" in scopeObj ? scopeObj.apiKeyId : undefined;
  if (!allTenants && (typeof apiKeyId !== "string" || apiKeyId.trim() === "")) {
    throw new Error("deleteBatchesMatching: apiKeyId required unless allTenants");
  }
  // Presence, not truthiness: `{ allTenants: true, apiKeyId: "" }` (or null) is a
  // caller that named both fields and must be refused, not widened (LEDGER-18).
  if (allTenants && "apiKeyId" in scopeObj) {
    throw new Error("deleteBatchesMatching: apiKeyId and allTenants are mutually exclusive");
  }

  // One consistent unit: file soft-deletes → checkpoints → batch rows for a
  // given set of batch ids, committed once per chunk.
  const sweepIds = (ids: string[]) =>
    db().transaction(async (tx) => {
      if (ids.length === 0) return { deletedBatches: 0, deletedFiles: 0 };
      const rows = await tx.query<{
        input_file_id: string | null;
        output_file_id: string | null;
        error_file_id: string | null;
      }>(
        `SELECT input_file_id, output_file_id, error_file_id FROM batches
          WHERE id = ANY($1::text[]) FOR UPDATE`,
        [ids]
      );

      const fileIds = new Set<string>();
      for (const row of rows) {
        if (row.input_file_id) fileIds.add(row.input_file_id);
        if (row.output_file_id) fileIds.add(row.output_file_id);
        if (row.error_file_id) fileIds.add(row.error_file_id);
      }

      let deletedFiles = 0;
      for (const fid of fileIds) {
        // #13681: a file referenced by a batch outside this chunk must survive this chunk.
        if (await isFileReferencedByOtherBatch(fid, ids, tx)) continue;
        // Postgres aborts the whole transaction after any error (25P02), so the
        // step that may fail runs inside a savepoint and is rolled back alone.
        await tx.execute("SAVEPOINT sweep_file");
        try {
          // Key mode: only the key's OWN files (SEC-C). Instance mode keeps the
          // unconditional soft delete.
          const removed = allTenants
            ? await deleteFile(fid, tx)
            : await deleteFileOwnedBy(fid, apiKeyId as string, tx);
          await tx.execute("RELEASE SAVEPOINT sweep_file");
          if (removed) deletedFiles++;
        } catch (err) {
          await tx.execute("ROLLBACK TO SAVEPOINT sweep_file");
          await tx.execute("RELEASE SAVEPOINT sweep_file");
          log.warn("deleteCompletedBatches: file soft-delete failed", {
            fid,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await tx.execute(`DELETE FROM batch_item_checkpoints WHERE batch_id = ANY($1::text[])`, [
        ids,
      ]);
      const result = await tx.execute(`DELETE FROM batches WHERE id = ANY($1::text[])`, [ids]);
      return { deletedBatches: result.changes, deletedFiles };
    });

  const nextIds = async (): Promise<string[]> => {
    const rows = allTenants
      ? await db().query<{ id: string }>(
          `SELECT id FROM batches WHERE ${whereSql} ORDER BY created_at, id LIMIT $${params.length + 1}`,
          [...params, INSTANCE_SWEEP_CHUNK]
        )
      : await db().query<{ id: string }>(
          `SELECT id FROM batches WHERE ${whereSql} AND api_key_id = $${params.length + 1}
            ORDER BY created_at, id LIMIT $${params.length + 2}`,
          [...params, apiKeyId, INSTANCE_SWEEP_CHUNK]
        );
    return rows.map((r) => r.id);
  };

  const totals = { deletedBatches: 0, deletedFiles: 0, hasMore: false };
  let previousFirstId: string | null = null;
  let chunkCount = 0;
  for (;;) {
    const ids = await nextIds();
    if (ids.length === 0) break;
    // Chunk cap (#13680): peek only tells the caller whether more work remains.
    if (chunkCount >= MAX_CHUNKS_PER_REQUEST) {
      totals.hasMore = true;
      break;
    }
    // Forward-progress guard (LEDGER-22): a repeated first id means the previous
    // DELETE removed nothing and the loop would spin forever.
    if (ids[0] === previousFirstId) {
      throw new Error(`deleteBatchesMatching: no progress — chunk repeated (id ${ids[0]})`);
    }
    previousFirstId = ids[0];
    const part = await sweepIds(ids);
    totals.deletedBatches += part.deletedBatches;
    totals.deletedFiles += part.deletedFiles;
    chunkCount++;
  }
  return totals;
}

export async function deleteCompletedBatches(scope: DeleteCompletedBatchesScope): Promise<{
  deletedBatches: number;
  deletedFiles: number;
  hasMore: boolean;
}> {
  return deleteBatchesMatching("status = 'completed'", [], scope);
}

/**
 * Automatic sweep for the daily cleanup job (see lib/db/cleanup.ts): unlike
 * deleteCompletedBatches() above, this covers every terminal status. Gated by age
 * so a batch's results stay retrievable for a while after finishing, matching
 * OpenAI's own Batch API retention behavior.
 *
 * Always instance-wide: called only by the internal cron sweep, never by an
 * untrusted API-key-authenticated caller, so it always uses the allTenants
 * path rather than taking a scope of its own.
 */
export async function deleteTerminalBatchesOlderThan(days: number): Promise<{
  deletedBatches: number;
  deletedFiles: number;
  hasMore: boolean;
}> {
  if (!Number.isFinite(days)) return { deletedBatches: 0, deletedFiles: 0, hasMore: false };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return deleteBatchesMatching(
    `status IN ('completed', 'failed', 'cancelled', 'expired')
       AND COALESCE(completed_at, failed_at, cancelled_at, expired_at, created_at) < $1`,
    [cutoff],
    { allTenants: true }
  );
}
