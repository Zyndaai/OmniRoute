import { db, ts } from "@/lib/db/pg";
import { emit } from "@/lib/events/eventBus";
import { jsonTextParam, jsonValueParam, stripNul } from "@/lib/db/pgJsonText";

/**
 * Publish an `agent.task.updated` transition for the orchestration canvas (Fase 2, Task B2).
 * Best-effort: a listener throwing must never break the DB write path that triggered it.
 */
function emitAgentTaskUpdated(source: "cloud-agent" | "a2a", taskId: string, state: string): void {
  try {
    emit("agent.task.updated", { source, taskId, state, timestamp: Date.now() });
  } catch {
    /* listeners never derail the write path */
  }
}

/**
 * The JSON columns (`source`, `options`, `result`, `activities`) are jsonb in the
 * database; this row keeps them as JSON text so callers `JSON.parse` them as before.
 */
export interface CloudAgentTaskRow {
  id: string;
  provider_id: string;
  external_id: string | null;
  status: string;
  prompt: string;
  source: string;
  options: string;
  result: string | null;
  activities: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const JSON_COLUMNS = new Set(["source", "options", "result", "activities"]);

/** The table is created by the PostgreSQL migration; kept so existing call sites stay valid. */
export function createCloudAgentTaskTable(): void {}

function toJsonParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? jsonTextParam(value) : jsonValueParam(value);
}

function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function mapRow(row: Record<string, unknown>): CloudAgentTaskRow {
  return {
    id: row.id as string,
    provider_id: row.provider_id as string,
    external_id: (row.external_id as string | null) ?? null,
    status: row.status as string,
    prompt: row.prompt as string,
    source: jsonText(row.source) ?? "{}",
    options: jsonText(row.options) ?? "{}",
    result: jsonText(row.result),
    activities: jsonText(row.activities) ?? "[]",
    error: (row.error as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    completed_at: (row.completed_at as string | null) ?? null,
  };
}

export async function insertCloudAgentTask(task: CloudAgentTaskRow): Promise<void> {
  await db().execute(
    `INSERT INTO cloud_agent_tasks (
       id, provider_id, external_id, status, prompt, source,
       options, result, activities, error, created_at, updated_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb,
       $7::jsonb, $8::jsonb, $9::jsonb, $10,
       COALESCE($11::timestamptz, now()), COALESCE($12::timestamptz, now()), $13::timestamptz
     )`,
    [
      task.id,
      task.provider_id,
      task.external_id ?? null,
      task.status,
      stripNul(task.prompt),
      toJsonParam(task.source) ?? "{}",
      toJsonParam(task.options) ?? "{}",
      toJsonParam(task.result),
      toJsonParam(task.activities) ?? "[]",
      task.error == null ? null : stripNul(task.error),
      ts(task.created_at),
      ts(task.updated_at),
      ts(task.completed_at),
    ]
  );
  emitAgentTaskUpdated("cloud-agent", task.id, task.status);
}

// Whitelist of allowed columns for update operations
const ALLOWED_UPDATE_COLUMNS = new Set([
  "status",
  "prompt",
  "source",
  "options",
  "result",
  "activities",
  "error",
  "completed_at",
]);

export async function updateCloudAgentTask(
  id: string,
  updates: Partial<Omit<CloudAgentTaskRow, "id">>
): Promise<void> {
  // Column names come from the whitelist only; values are always bound.
  const sets: string[] = [];
  const params: unknown[] = [];
  let status: string | undefined;

  for (const [key, value] of Object.entries(updates)) {
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) continue;
    if (key === "status") status = value as string;
    if (JSON_COLUMNS.has(key)) {
      params.push(toJsonParam(value));
      sets.push(`${key} = $${params.length}::jsonb`);
    } else if (key === "completed_at") {
      params.push(ts(value as string | null));
      sets.push(`${key} = $${params.length}::timestamptz`);
    } else {
      params.push(typeof value === "string" ? stripNul(value) : value);
      sets.push(`${key} = $${params.length}`);
    }
  }

  if (sets.length === 0) return; // No valid updates

  params.push(id);
  const result = await db().execute(
    `UPDATE cloud_agent_tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`,
    params
  );
  // Publish the row's real status: an update that only touches result/activities/error must
  // not fabricate a state the canvas has never heard of. No row means nothing was written.
  if (result.changes === 0) return;
  const state = status ?? (await getCloudAgentTaskById(id))?.status;
  if (state) emitAgentTaskUpdated("cloud-agent", id, state);
}

export async function getCloudAgentTaskById(id: string): Promise<CloudAgentTaskRow | null> {
  const row = await db().queryOne<Record<string, unknown>>(
    "SELECT * FROM cloud_agent_tasks WHERE id = $1",
    [id]
  );
  return row ? mapRow(row) : null;
}

export async function getCloudAgentTasksByProvider(
  providerId: string,
  limit = 50
): Promise<CloudAgentTaskRow[]> {
  const rows = await db().query<Record<string, unknown>>(
    "SELECT * FROM cloud_agent_tasks WHERE provider_id = $1 ORDER BY created_at DESC LIMIT $2",
    [providerId, limit]
  );
  return rows.map(mapRow);
}

export async function getCloudAgentTasksByStatus(
  status: string,
  limit = 50
): Promise<CloudAgentTaskRow[]> {
  const rows = await db().query<Record<string, unknown>>(
    "SELECT * FROM cloud_agent_tasks WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
    [status, limit]
  );
  return rows.map(mapRow);
}

export async function getAllCloudAgentTasks(limit = 100): Promise<CloudAgentTaskRow[]> {
  const rows = await db().query<Record<string, unknown>>(
    "SELECT * FROM cloud_agent_tasks ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return rows.map(mapRow);
}

export async function deleteCloudAgentTask(id: string): Promise<void> {
  await db().execute("DELETE FROM cloud_agent_tasks WHERE id = $1", [id]);
}
