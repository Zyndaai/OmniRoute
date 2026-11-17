/**
 * Log-export destination persistence.
 *
 * snake_case columns, camelCase in the returned objects. `config` is jsonb whose secret
 * keys are already ciphertext when they reach this module — encryption lives in
 * src/lib/logExport/secrets.ts, next to the destination registry that knows which keys
 * are secret.
 *
 * The export cursor is `call_logs.seq` (column `cursor_seq`); the field keeps its old
 * name `cursorRowId` for the callers, and `cursorSeq` is the same value.
 */

import { randomUUID } from "node:crypto";
import { db, jsonb } from "./pg";

export interface LogExportDestinationRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  batchSize: number;
  includeBodies: boolean;
  maxBodyBytes: number;
  maxRowsPerRun: number;
  /** Last exported `call_logs.seq`. */
  cursorRowId: number;
  cursorSeq: number;
  exportedTotal: number;
  lastRunAt: string | null;
  lastStatus: "success" | "failure" | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLogExportDestinationInput {
  name: string;
  type: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  batchSize?: number;
  includeBodies?: boolean;
  maxBodyBytes?: number;
  maxRowsPerRun?: number;
}

export interface UpdateLogExportDestinationInput {
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  batchSize?: number;
  includeBodies?: boolean;
  maxBodyBytes?: number;
  maxRowsPerRun?: number;
}

function mapRow(row: any): LogExportDestinationRow {
  let config: Record<string, unknown> = {};
  let raw = row.config;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) config = raw;
  const cursor = row.cursor_seq ?? 0;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled === true,
    config,
    batchSize: row.batch_size,
    includeBodies: row.include_bodies === true,
    maxBodyBytes: row.max_body_bytes ?? 262_144,
    maxRowsPerRun: row.max_rows_per_run,
    cursorRowId: cursor,
    cursorSeq: cursor,
    exportedTotal: row.exported_total ?? 0,
    lastRunAt: row.last_run_at ?? null,
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getLogExportDestinations(): Promise<LogExportDestinationRow[]> {
  const rows = await db().query("SELECT * FROM log_export_destinations ORDER BY created_at ASC");
  return rows.map(mapRow);
}

export async function getEnabledLogExportDestinations(): Promise<LogExportDestinationRow[]> {
  const rows = await db().query(
    "SELECT * FROM log_export_destinations WHERE enabled ORDER BY created_at ASC"
  );
  return rows.map(mapRow);
}

export async function getLogExportDestination(id: string): Promise<LogExportDestinationRow | null> {
  const row = await db().queryOne("SELECT * FROM log_export_destinations WHERE id = $1", [id]);
  return row ? mapRow(row) : null;
}

export async function createLogExportDestination(
  input: CreateLogExportDestinationInput
): Promise<LogExportDestinationRow> {
  const id = randomUUID();
  const row = await db().queryOne(
    `INSERT INTO log_export_destinations
       (id, name, type, enabled, config, batch_size, include_bodies, max_body_bytes,
        max_rows_per_run, cursor_seq, exported_total)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 0, 0)
     RETURNING *`,
    [
      id,
      input.name,
      input.type,
      Boolean(input.enabled),
      jsonb(input.config ?? {}),
      input.batchSize ?? 500,
      Boolean(input.includeBodies),
      input.maxBodyBytes ?? 262_144,
      input.maxRowsPerRun ?? 10_000,
    ]
  );
  return mapRow(row);
}

export async function updateLogExportDestination(
  id: string,
  input: UpdateLogExportDestinationInput
): Promise<LogExportDestinationRow | null> {
  const existing = await getLogExportDestination(id);
  if (!existing) return null;

  const row = await db().queryOne(
    `UPDATE log_export_destinations
        SET name = $2,
            enabled = $3,
            config = $4::jsonb,
            batch_size = $5,
            include_bodies = $6,
            max_body_bytes = $7,
            max_rows_per_run = $8,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      id,
      input.name ?? existing.name,
      input.enabled ?? existing.enabled,
      jsonb(input.config ?? existing.config),
      input.batchSize ?? existing.batchSize,
      input.includeBodies ?? existing.includeBodies,
      input.maxBodyBytes ?? existing.maxBodyBytes,
      input.maxRowsPerRun ?? existing.maxRowsPerRun,
    ]
  );
  return row ? mapRow(row) : null;
}

export async function deleteLogExportDestination(id: string): Promise<boolean> {
  const result = await db().execute("DELETE FROM log_export_destinations WHERE id = $1", [id]);
  return result.changes > 0;
}

/** Advance the cursor after a batch is durably accepted by the destination. */
export async function advanceLogExportCursor(
  id: string,
  cursorRowId: number,
  exported: number
): Promise<void> {
  await db().execute(
    `UPDATE log_export_destinations
        SET cursor_seq = $2,
            exported_total = exported_total + $3,
            updated_at = now()
      WHERE id = $1`,
    [id, cursorRowId, Math.round(exported)]
  );
}

/**
 * Rewind the cursor. Used by the truncation guard: when `call_logs` has been purged
 * the surviving max(seq) can be lower than the stored cursor, which would otherwise
 * make every future row invisible to the exporter.
 */
export async function resetLogExportCursor(id: string, cursorRowId = 0): Promise<void> {
  await db().execute(
    `UPDATE log_export_destinations
        SET cursor_seq = $2, updated_at = now()
      WHERE id = $1`,
    [id, cursorRowId]
  );
}

export async function recordLogExportRun(
  id: string,
  status: "success" | "failure",
  error: string | null
): Promise<void> {
  await db().execute(
    `UPDATE log_export_destinations
        SET last_run_at = now(), last_status = $2, last_error = $3, updated_at = now()
      WHERE id = $1`,
    [id, status, error]
  );
}
