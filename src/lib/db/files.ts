import { v4 as uuidv4 } from "uuid";
import { DEFAULT_BATCH_EXPIRATION_SECONDS } from "@/shared/constants/batch";
import { db, sqlLimit, ts, type DbExecutor } from "./pg";

export interface FileRecord {
  id: string;
  bytes: number;
  /** Epoch seconds. */
  createdAt: number;
  filename: string;
  purpose: string;
  content?: Buffer | null;
  mimeType?: string | null;
  apiKeyId?: string | null;
  /** Epoch seconds. */
  expiresAt?: number | null;
  /** Epoch seconds. */
  deletedAt?: number | null;
}

// Timestamps stay epoch seconds in the public shape; the columns are timestamptz.
const FILE_METADATA_COLUMNS = `id, bytes,
  floor(extract(epoch FROM created_at))::bigint AS "createdAt",
  filename, purpose,
  mime_type AS "mimeType", api_key_id AS "apiKeyId",
  floor(extract(epoch FROM expires_at))::bigint AS "expiresAt",
  floor(extract(epoch FROM deleted_at))::bigint AS "deletedAt"`;

function toBuffer(content: Buffer | Uint8Array | string): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

export async function createFile(file: Omit<FileRecord, "id" | "createdAt">): Promise<FileRecord> {
  const id = "file-" + uuidv4().replaceAll("-", "").substring(0, 24);
  const createdAt = Math.floor(Date.now() / 1000);

  let expiresAt = file.expiresAt;
  if (expiresAt === undefined && file.purpose === "batch") {
    // Default: batch files expire after 30 days
    expiresAt = createdAt + DEFAULT_BATCH_EXPIRATION_SECONDS;
  }

  const record: FileRecord = {
    id,
    bytes: file.bytes,
    createdAt,
    filename: file.filename,
    purpose: file.purpose,
    content: file.content ?? null,
    mimeType: file.mimeType ?? null,
    apiKeyId: file.apiKeyId ?? null,
    expiresAt: expiresAt ?? null,
    deletedAt: null,
  };

  await db().execute(
    `INSERT INTO files (id, bytes, created_at, filename, purpose, content, mime_type, api_key_id, expires_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      record.id,
      record.bytes,
      ts(record.createdAt),
      record.filename,
      record.purpose,
      record.content,
      record.mimeType,
      record.apiKeyId,
      ts(record.expiresAt),
      null,
    ]
  );

  return record;
}

export async function getFile(id: string): Promise<FileRecord | null> {
  const row = await db().queryOne<FileRecord>(
    `SELECT ${FILE_METADATA_COLUMNS} FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return row ?? null;
}

export async function getFileContent(id: string): Promise<Buffer | null> {
  const row = await db().queryOne<{ content: Buffer | Uint8Array | string | null }>(
    `SELECT content FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  if (!row?.content) return null;
  return toBuffer(row.content);
}

export async function listFiles(
  options: {
    apiKeyId?: string;
    purpose?: string;
    limit?: number;
    after?: string;
    order?: "asc" | "desc";
  } = {}
): Promise<FileRecord[]> {
  const { apiKeyId, purpose, limit = 20, after, order = "desc" } = options;

  let query = `SELECT ${FILE_METADATA_COLUMNS} FROM files WHERE deleted_at IS NULL`;
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (apiKeyId) query += ` AND api_key_id = ${add(apiKeyId)}`;
  if (purpose) query += ` AND purpose = ${add(purpose)}`;

  if (after) {
    // #14481 item 5/LEDGER-20/21 (same pattern as listBatches()): getFile()
    // applies no owner filter, so a foreign tenant's file id used to still
    // resolve here and its created_at was used as the pagination bound — an
    // existence + timestamp oracle for another tenant's file. When this call
    // IS owner-scoped, a cursor belonging to a DIFFERENT owner is treated
    // exactly like an unknown one (ignored) instead of trusted.
    const resolvedAfterFile = await getFile(after);
    const afterFile =
      apiKeyId && resolvedAfterFile && resolvedAfterFile.apiKeyId !== apiKeyId
        ? null
        : resolvedAfterFile;
    if (afterFile) {
      const cmp = order === "desc" ? "<" : ">";
      const at = add(ts(afterFile.createdAt));
      query += ` AND (created_at ${cmp} ${at} OR (created_at = ${at} AND id ${cmp} ${add(after)}))`;
    }
  }

  const dir = order === "asc" ? "ASC" : "DESC";
  query += ` ORDER BY created_at ${dir}, id ${dir} LIMIT ${add(sqlLimit(limit))}`;

  return db().query<FileRecord>(query, params);
}

export async function countFiles(
  options: { apiKeyId?: string; purpose?: string } = {}
): Promise<number> {
  const { apiKeyId, purpose } = options;
  let query = "SELECT COUNT(*) AS c FROM files WHERE deleted_at IS NULL";
  const params: unknown[] = [];
  if (apiKeyId) {
    params.push(apiKeyId);
    query += ` AND api_key_id = $${params.length}`;
  }
  if (purpose) {
    params.push(purpose);
    query += ` AND purpose = $${params.length}`;
  }
  const row = await db().queryOne<{ c: number }>(query, params);
  return row ? Number(row.c) : 0;
}

export function formatFileResponse(file: FileRecord) {
  // Ensure numeric date fields are valid numbers to avoid NaN in API responses
  const createdAt =
    typeof file.createdAt === "number" && Number.isFinite(file.createdAt) ? file.createdAt : 0;
  const expiresAt =
    typeof file.expiresAt === "number" && Number.isFinite(file.expiresAt) ? file.expiresAt : null;

  return {
    id: file.id,
    bytes: file.bytes,
    created_at: createdAt,
    filename: file.filename,
    object: "file",
    purpose: file.purpose,
    expires_at: expiresAt,
  };
}

/** `executor` lets a caller run the soft delete inside its own transaction. */
export async function deleteFile(id: string, executor: DbExecutor = db()): Promise<boolean> {
  const result = await executor.execute(
    `UPDATE files SET deleted_at = $1, content = NULL WHERE id = $2`,
    [ts(Math.floor(Date.now() / 1000)), id]
  );
  return result.changes > 0;
}

/**
 * Owner-scoped soft delete: same effect as `deleteFile`, but only when the
 * file belongs to `apiKeyId`. Used by the key-scoped completed-batch sweep so
 * a batch that references another tenant's (or an unowned) file never nulls
 * that file's content (GHSA-wvxc-jp3v-5mg5, SEC-C). Returns false when the
 * row is not the caller's; throws on an empty owner so a caller cannot widen
 * the delete by passing a blank id.
 */
export async function deleteFileOwnedBy(
  id: string,
  apiKeyId: string,
  executor: DbExecutor = db()
): Promise<boolean> {
  if (typeof apiKeyId !== "string" || apiKeyId.trim() === "") {
    throw new Error("deleteFileOwnedBy: apiKeyId is required");
  }
  const result = await executor.execute(
    `UPDATE files SET deleted_at = $1, content = NULL WHERE id = $2 AND api_key_id = $3`,
    [ts(Math.floor(Date.now() / 1000)), id, apiKeyId]
  );
  return result.changes > 0;
}

/**
 * Clears the content of files past their own `expires_at`, mirroring the
 * deleteFile() soft-delete shape (row kept for metadata/audit, content freed).
 * `now` is epoch seconds. Returns the number of files cleared.
 */
export async function pruneExpiredFiles(now: number): Promise<number> {
  const at = ts(now);
  const result = await db().execute(
    `UPDATE files SET deleted_at = $1, content = NULL
      WHERE expires_at IS NOT NULL AND expires_at < $1 AND deleted_at IS NULL`,
    [at]
  );
  return result.changes ?? 0;
}
