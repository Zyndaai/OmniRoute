/**
 * db/a2aTasks.ts — A2A task history writer/reader over `a2a_tasks` and `a2a_task_events`.
 *
 * Owner visibility mirrors `A2ATaskManager.isVisibleTo` (src/lib/a2a/taskManager.ts): with an
 * `owner` given, a row is visible when `api_key_id IS NULL OR api_key_id = owner`; without one,
 * every row is visible.
 *
 * The `input` / `output` / `data` columns are jsonb; the row types keep the legacy
 * `*_json` fields as JSON text so callers do not change.
 */
import { db, ts } from "./pg";
import { jsonTextParam } from "./pgJsonText";

export interface A2ATaskHistoryRow {
  id: string;
  state: string;
  skill_id: string | null;
  input_json: string | null;
  output_json: string | null;
  api_key_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface A2ATaskHistoryEventRow {
  event_type: string;
  data_json: string | null;
  created_at: string;
}

export interface A2AHistoryFilter {
  /** ISO timestamp — created_at >= from */
  from?: string;
  /** ISO timestamp — created_at <= to */
  to?: string;
  skill?: string;
  state?: string;
  /** See owner semantics in the module doc comment above. */
  owner?: string;
  limit: number;
  offset: number;
}

export interface UpsertA2ATaskInput {
  id: string;
  state: string;
  skillId: string | null;
  inputJson: string | null;
  outputJson: string | null;
  apiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const HISTORY_COLUMNS =
  "id, state, skill_id, input::text AS input_json, output::text AS output_json, api_key_id, created_at, updated_at, completed_at";

/** Builds the shared WHERE clause (+ params) for filter/owner conditions used by list/count. */
function buildHistoryWhere(f: Pick<A2AHistoryFilter, "from" | "to" | "skill" | "state" | "owner">) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (f.from !== undefined) clauses.push(`created_at >= ${add(ts(f.from))}`);
  if (f.to !== undefined) clauses.push(`created_at <= ${add(ts(f.to))}`);
  if (f.skill !== undefined) clauses.push(`skill_id = ${add(f.skill)}`);
  if (f.state !== undefined) clauses.push(`state = ${add(f.state)}`);
  if (f.owner !== undefined) {
    clauses.push(`(api_key_id IS NULL OR api_key_id = ${add(f.owner)})`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

/**
 * Insert a new task history row, or update the mutable fields of an existing one keyed by `id`.
 */
export async function upsertA2ATask(row: UpsertA2ATaskInput): Promise<void> {
  await db().execute(
    `INSERT INTO a2a_tasks (
       id, state, skill_id, input, output, api_key_id, created_at, updated_at, completed_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       state = EXCLUDED.state,
       output = EXCLUDED.output,
       updated_at = EXCLUDED.updated_at,
       completed_at = EXCLUDED.completed_at`,
    [
      row.id,
      row.state,
      row.skillId,
      jsonTextParam(row.inputJson),
      jsonTextParam(row.outputJson),
      row.apiKeyId,
      ts(row.createdAt) ?? new Date().toISOString(),
      ts(row.updatedAt) ?? new Date().toISOString(),
      ts(row.completedAt),
    ]
  );
}

/** Append an event to a task's event log. */
export async function appendA2ATaskEvent(
  taskId: string,
  eventType: string,
  dataJson?: string
): Promise<void> {
  await db().execute(
    `INSERT INTO a2a_task_events (task_id, event_type, data) VALUES ($1, $2, $3::jsonb)`,
    [taskId, eventType, jsonTextParam(dataJson ?? null)]
  );
}

/** List a task's events in insertion order (oldest first). */
export async function listA2ATaskEvents(taskId: string): Promise<A2ATaskHistoryEventRow[]> {
  return db().query<A2ATaskHistoryEventRow>(
    `SELECT event_type, data::text AS data_json, created_at
       FROM a2a_task_events
      WHERE task_id = $1
      ORDER BY id ASC`,
    [taskId]
  );
}

/** List finished/in-flight task history, newest first, filtered and paginated. */
export async function listA2ATaskHistory(f: A2AHistoryFilter): Promise<{
  rows: A2ATaskHistoryRow[];
  total: number;
}> {
  const { where, params } = buildHistoryWhere(f);

  const total = await db().queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM a2a_tasks ${where}`,
    params
  );

  const rows = await db().query<A2ATaskHistoryRow>(
    `SELECT ${HISTORY_COLUMNS}
       FROM a2a_tasks
       ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.limit, f.offset]
  );

  return { rows, total: Number(total?.count ?? 0) };
}

/**
 * Fetch a single task history row by id, applying the same owner rule as `listA2ATaskHistory`.
 * Returns `null` when the row does not exist or is not visible to `owner`.
 */
export async function getA2ATaskHistoryById(
  id: string,
  owner?: string
): Promise<A2ATaskHistoryRow | null> {
  const { where, params } = buildHistoryWhere({ owner });
  const idParam = `$${params.length + 1}`;
  const clause = where ? `${where} AND id = ${idParam}` : `WHERE id = ${idParam}`;

  const row = await db().queryOne<A2ATaskHistoryRow>(
    `SELECT ${HISTORY_COLUMNS} FROM a2a_tasks ${clause}`,
    [...params, id]
  );
  return row ?? null;
}

/**
 * Delete task history rows older than `retentionDays`, along with their events. There is no
 * foreign key between the tables, so both deletes run inside one transaction.
 * Returns the number of `a2a_tasks` rows deleted.
 */
export async function purgeA2AHistory(retentionDays: number): Promise<number> {
  if (!Number.isFinite(retentionDays)) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  return db().transaction(async (tx) => {
    await tx.execute(
      `DELETE FROM a2a_task_events
        WHERE task_id IN (SELECT id FROM a2a_tasks WHERE created_at < $1)`,
      [cutoff]
    );
    const result = await tx.execute(`DELETE FROM a2a_tasks WHERE created_at < $1`, [cutoff]);
    return result.changes;
  });
}
