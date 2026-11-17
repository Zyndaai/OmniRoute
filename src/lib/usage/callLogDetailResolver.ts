import fs from "node:fs";
import path from "node:path";

export interface CallLogDetailEntry {
  id: string;
  timestamp: string | null;
  model: string | null;
  status: number;
  detailState: string;
  artifactRelPath: string | null;
  error: unknown;
  hasPipelineDetails: boolean;
}
interface DetailFileIo {
  readFile(file: string): string | Promise<string>;
  readdir(dir: string): string[] | Promise<string[]>;
}
const asyncIo: DetailFileIo = {
  readFile: (file) => fs.promises.readFile(file, "utf8"),
  readdir: (dir) => fs.promises.readdir(dir),
};
/** Dashboard compatibility: its existing detail path still reads synchronously. */
export const dashboardDetailIo: DetailFileIo = {
  readFile: (file) => fs.readFileSync(file, "utf8"),
  readdir: (dir) => fs.readdirSync(dir),
};

async function legacyDisk(
  entry: CallLogDetailEntry,
  baseDir: string | null,
  io: DetailFileIo
): Promise<Record<string, unknown> | null> {
  if (!baseDir || !entry.timestamp) return null;
  const date = new Date(entry.timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const dir = path.join(baseDir, dateFolder);
  const time = `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
  const safeModel = (entry.model || "unknown").replace(/[/:]/g, "-");
  try {
    try {
      return JSON.parse(
        await io.readFile(path.join(dir, `${time}_${safeModel}_${entry.status}.json`))
      ) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const files = (await io.readdir(dir)).filter(
      (file) => file.startsWith(time) && file.endsWith(`_${entry.status}.json`)
    );
    return files.length
      ? (JSON.parse(await io.readFile(path.join(dir, files[0]))) as Record<string, unknown>)
      : null;
  } catch {
    // Missing/corrupt historical files intentionally export summary-only records.
    return null;
  }
}

type ArtifactState = "missing" | "corrupt";
type DetailPayload = Record<string, unknown>;
interface ArtifactRead {
  payload: DetailPayload | null;
  detailState: string;
  artifactRelPath: string | null;
  pipelinePayloads: DetailPayload | null;
}

async function readArtifactPayload(
  entry: CallLogDetailEntry,
  baseDir: string | null,
  io: DetailFileIo,
  onArtifactState?: (relativePath: string, state: ArtifactState) => void | Promise<void>
): Promise<ArtifactRead> {
  const relPath = entry.artifactRelPath;
  const unchanged: ArtifactRead = {
    payload: null,
    detailState: entry.detailState,
    artifactRelPath: relPath,
    pipelinePayloads: null,
  };
  if (!relPath || !baseDir) return unchanged;
  try {
    const payload = JSON.parse(await io.readFile(path.join(baseDir, relPath))) as DetailPayload;
    if (!payload) return unchanged;
    return {
      payload,
      detailState: "ready",
      artifactRelPath: relPath,
      pipelinePayloads: (payload.pipeline ?? null) as DetailPayload | null,
    };
  } catch (error) {
    const state: ArtifactState =
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt";
    await onArtifactState?.(relPath, state);
    return {
      payload: null,
      detailState: state,
      artifactRelPath: state === "missing" ? null : relPath,
      pipelinePayloads: null,
    };
  }
}

/** Body/error fields; an inline legacy row's error wins even when null (historical shape). */
function detailBodyFields(payload: DetailPayload | null, entryError: unknown) {
  return {
    requestBody: payload?.requestBody ?? null,
    responseBody: payload?.responseBody ?? null,
    error: payload?.error ?? entryError,
  };
}

/**
 * Pure detail resolution: artifact → legacy-disk → none.
 * Never updates the database. The dashboard owns missing/corrupt bookkeeping via onArtifactState;
 * the export child deliberately supplies no callback and uses asynchronous filesystem IO.
 * The old `request_detail_logs` and `call_logs_v1_legacy` fallbacks left with the SQLite schema.
 */
export async function resolveCallLogDetail<T extends CallLogDetailEntry>(
  entry: T,
  baseDir: string | null,
  options: {
    io?: DetailFileIo;
    onArtifactState?: (relativePath: string, state: ArtifactState) => void | Promise<void>;
  } = {}
) {
  const io = options.io ?? asyncIo;
  const artifact = await readArtifactPayload(entry, baseDir, io, options.onArtifactState);
  const artifactReady = artifact.payload !== null;
  const payload = artifact.payload ?? (await legacyDisk(entry, baseDir, io));
  const pipelinePayloads = artifact.pipelinePayloads;
  const hasPipelineDetails = artifactReady ? Boolean(payload?.pipeline) : Boolean(pipelinePayloads);
  return {
    ...entry,
    detailState: artifact.detailState,
    artifactRelPath: artifact.artifactRelPath,
    ...detailBodyFields(payload, entry.error),
    pipelinePayloads,
    hasPipelineDetails: hasPipelineDetails || entry.hasPipelineDetails,
    active: false,
  };
}
