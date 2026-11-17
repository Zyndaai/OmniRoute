/** Server compatibility wrappers; query/mapping code is shared with the export child. */
import { db } from "../db/pg";
import { expirePendingCallLogDetails } from "../db/callLogDetails";
import { getCallLogById } from "./callLogs";
import * as queries from "./callLogExportQueries";
import type { LogExportSourceRow } from "../logExport/types";
export function getMaxCallLogRowId(): Promise<number> {
  return queries.getMaxCallLogRowId(db());
}
export function countCallLogsAfterRowId(afterRowId: number): Promise<number> {
  return queries.countCallLogsAfterRowId(db(), afterRowId);
}
export function getCallLogsForExport(
  afterRowId: number,
  limit: number,
  options: { includeBodies?: boolean } = {}
): Promise<LogExportSourceRow[]> {
  return queries.getCallLogsForExport(
    db(),
    afterRowId,
    limit,
    Number.MAX_SAFE_INTEGER,
    options
  );
}
/**
 * Make abandoned artifact writes terminal before a body export reads the barrier.
 */
export function expirePendingExportDetails(): Promise<void> {
  return expirePendingCallLogDetails(db());
}
export function attachExportBodies(
  rows: LogExportSourceRow[],
  maxBodyBytes = queries.DEFAULT_MAX_BODY_BYTES
): Promise<LogExportSourceRow[]> {
  return queries.attachExportBodies(rows, maxBodyBytes, (id, timestamp) =>
    getCallLogById(id, timestamp)
  );
}
