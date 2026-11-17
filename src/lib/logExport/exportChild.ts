/**
 * One short-lived OS process per destination run. It opens its own PostgreSQL pool (the
 * pool is per process) and closes it before exiting, so a stuck destination never holds
 * a connection of the server.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { db as getDb } from "../db/pg";
import { resolveDataDir } from "../dataPaths";
import {
  attachExportBodies,
  getCallLogsForExport,
  getMaxCallLogRowId,
} from "../usage/callLogExportQueries";
import { resolveCallLogDetail, type CallLogDetailEntry } from "../usage/callLogDetailResolver";
import { getLogExportDestinationType, __registerLogExportDestinationTypeForTest } from "./registry";
import { exportSecretValues, safeExportError } from "./safeExportError";
import { installExportProxyDispatcher } from "./childProxy";
import type { ExportChildReply, ExportChildStart } from "./childProtocol";

installExportProxyDispatcher();

function post(message: ExportChildReply): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("Log export IPC disconnected"));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
let ack: { cursor: number; resolve: () => void } | null = null;
let started = false;
process.on("disconnect", () => process.exit(1));
process.on("message", (message: ExportChildStart | { kind: "ack"; cursorRowId: number }) => {
  if (message.kind === "ack") {
    if (ack && message.cursorRowId === ack.cursor) {
      const pending = ack;
      ack = null;
      pending.resolve();
    }
    return;
  }
  if (message.kind !== "start" || started) return;
  started = true;
  void run(message);
});

async function run(start: ExportChildStart) {
  let db: ReturnType<typeof getDb> | undefined;
  let secretValues: string[] = [];
  try {
    // Only parent-injected test code can register fixture destinations or stub fetch.
    // No environment variable or persisted config can enable this in a production run.
    if (start.testModulePath) {
      const fixture = await import(pathToFileURL(start.testModulePath).href);
      fixture.register?.(__registerLogExportDestinationTypeForTest);
      fixture.installBigQueryFetchFixture?.(start.testConfig ?? {});
    }
    const type = getLogExportDestinationType(start.destination.type);
    if (!type) throw new Error("Unknown log export destination type");
    secretValues = exportSecretValues(start.config, type.secretFields);
    const client = type.createClient(start.config);
    db = getDb();
    const readDb = db;
    // Snapshot the insertion boundary (`seq`), not a long-lived read transaction:
    // writers stay free while destination I/O awaits.
    const throughRowId = await getMaxCallLogRowId(readDb);
    const baseDir = path.join(resolveDataDir(), "call_logs");
    let cursor = start.cursorRowId;
    let exported = 0;
    let prepared = false;
    while (exported < start.maxRowsPerRun) {
      const summaries = await getCallLogsForExport(
        readDb,
        cursor,
        Math.min(start.batchSize, start.maxRowsPerRun - exported),
        throughRowId,
        { includeBodies: start.includeBodies }
      );
      if (!summaries.length) break;
      const batch = start.includeBodies
        ? await attachExportBodies(summaries, start.maxBodyBytes, async (id, timestamp) => {
            const row = await readDb.queryOne<Record<string, unknown>>(
              `SELECT id, "timestamp", model, status, detail_state, artifact_relpath, error_summary, has_pipeline_details
                 FROM call_logs WHERE id = $1 AND ($2::timestamptz IS NULL OR "timestamp" = $2::timestamptz)
                 ORDER BY "timestamp" DESC LIMIT 1`,
              [id, timestamp]
            );
            if (!row) return null;
            const detailState = String(row.detail_state ?? "none");
            const entry: CallLogDetailEntry = {
              id: String(row.id),
              timestamp: row.timestamp as string | null,
              model: row.model as string | null,
              status: Number(row.status),
              detailState,
              // The path is stored at insert; it names an artifact only once published.
              artifactRelPath: detailState === "ready" ? (row.artifact_relpath as string | null) : null,
              error: row.error_summary,
              hasPipelineDetails: row.has_pipeline_details === true,
            };
            return resolveCallLogDetail(entry, baseDir);
          })
        : summaries;
      if (!prepared) {
        await client.prepare();
        prepared = true;
      }
      await client.send(batch.map((row) => row.record));
      cursor = batch[batch.length - 1].rowId;
      // Install the waiter BEFORE sending, including for an immediately responding parent.
      const acknowledged = new Promise<void>((resolve) => {
        ack = { cursor, resolve };
      });
      await post({ kind: "batch", cursorRowId: cursor, count: batch.length });
      await acknowledged;
      exported += batch.length;
      if (batch.length < start.batchSize) break;
    }
    await db.close();
    db = undefined;
    await post({ kind: "done" });
    process.exit(0);
  } catch (error) {
    await db?.close().catch(() => {});
    try {
      await post({ kind: "error", message: safeExportError(error, secretValues) });
    } catch {
      /* Parent disconnected; there is no run left to notify. */
    }
    process.exit(1);
  }
}
