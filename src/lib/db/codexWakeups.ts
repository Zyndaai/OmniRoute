/**
 * Database module: scheduled Codex account wakeups.
 *
 * Tables `codex_wakeup_tasks` and `codex_wakeup_runs`. A run row is also the
 * cross-process lease: the partial unique index `(task_id) WHERE status = 'running'`
 * lets `claimCodexWakeupRun` insert a new `running` run only when no other run of
 * the same task is running, so two processes sharing the database cannot both run
 * the same task.
 */
import { randomUUID } from "node:crypto";
import { db, jsonb, toMs, type DbExecutor } from "./pg";
import type {
  CodexWakeupSchedule,
  CodexWakeupTaskInput,
} from "@/shared/validation/codexWakeupSchemas";

export const CODEX_WAKEUP_MAX_TASKS = 100;
export const CODEX_WAKEUP_MAX_RUNS = 100;
/** Lease budget per account: the 60s ping timeout plus margin for the quota read. */
const LEASE_MS_PER_ACCOUNT = 65_000;
const LEASE_BASE_MS = 10_000;

export type CodexWakeupTrigger = "scheduled" | "manual";
export type CodexWakeupResultStatus = "succeeded" | "failed" | "skipped";
export type CodexWakeupRunStatus = "running" | CodexWakeupResultStatus | "partial" | "interrupted";

export interface CodexWakeupTask {
  id: string;
  name: string;
  connectionIds: string[];
  schedule: CodexWakeupSchedule;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodexWakeupRunResult {
  connectionId: string;
  status: CodexWakeupResultStatus;
  reason: string;
  durationMs: number;
}

export interface CodexWakeupRun {
  id: string;
  taskId: string;
  taskName: string;
  trigger: CodexWakeupTrigger;
  status: CodexWakeupRunStatus;
  results: CodexWakeupRunResult[];
  startedAt: string;
  finishedAt: string | null;
  leaseExpiresAt: number;
}

export interface CodexWakeupClaim {
  run: CodexWakeupRun;
  task: CodexWakeupTask;
}

export type CodexWakeupStoreErrorCode = "not_found" | "running" | "limit";

export class CodexWakeupStoreError extends Error {
  readonly code: CodexWakeupStoreErrorCode;
  constructor(code: CodexWakeupStoreErrorCode) {
    super(`codex wakeup: ${code}`);
    this.name = "CodexWakeupStoreError";
    this.code = code;
  }
}

type TaskRow = {
  id: string;
  name: string;
  connection_ids: unknown;
  schedule: unknown;
  enabled: boolean;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  task_id: string;
  task_name: string;
  trigger_kind: CodexWakeupTrigger;
  status: CodexWakeupRunStatus;
  results: unknown;
  started_at: string;
  finished_at: string | null;
  lease_expires_at: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** jsonb arrives parsed; a legacy JSON string is still accepted. */
function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toTask(row: TaskRow): CodexWakeupTask {
  return {
    id: row.id,
    name: row.name,
    connectionIds: parseJsonArray<string>(row.connection_ids),
    schedule: (typeof row.schedule === "string"
      ? JSON.parse(row.schedule)
      : row.schedule) as CodexWakeupSchedule,
    enabled: row.enabled === true,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): CodexWakeupRun {
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    trigger: row.trigger_kind,
    status: row.status,
    results: parseJsonArray<CodexWakeupRunResult>(row.results),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    leaseExpiresAt: toMs(row.lease_expires_at) ?? 0,
  };
}

function msIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `forUpdate` locks the task row so concurrent claims/edits of one task serialize. */
async function selectTask(
  tx: DbExecutor,
  id: string,
  forUpdate = false
): Promise<TaskRow | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  return tx.queryOne<TaskRow>(
    `SELECT * FROM codex_wakeup_tasks WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [id]
  );
}

async function hasLiveRun(tx: DbExecutor, taskId: string, nowMs: number): Promise<boolean> {
  const row = await tx.queryOne(
    "SELECT 1 FROM codex_wakeup_runs WHERE task_id = $1 AND status = 'running' AND lease_expires_at > $2 LIMIT 1",
    [taskId, msIso(nowMs)]
  );
  return Boolean(row);
}

export async function listCodexWakeupTasks(): Promise<CodexWakeupTask[]> {
  const rows = await db().query<TaskRow>(
    "SELECT * FROM codex_wakeup_tasks ORDER BY created_at ASC, id ASC"
  );
  return rows.map(toTask);
}

export async function getCodexWakeupTask(id: string): Promise<CodexWakeupTask | null> {
  const row = await selectTask(db(), id);
  return row ? toTask(row) : null;
}

export async function createCodexWakeupTask(
  input: CodexWakeupTaskInput,
  nextRunAt: string | null,
  nowMs: number = Date.now()
): Promise<CodexWakeupTask> {
  const id = randomUUID();
  const now = msIso(nowMs);
  const row = await db().transaction(async (tx) => {
    // The task cap is a count check; serialize creators so two processes cannot both pass it.
    await tx.execute("SELECT pg_advisory_xact_lock(hashtext('codex_wakeup_tasks'))");
    const counted = await tx.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM codex_wakeup_tasks"
    );
    if ((counted?.n ?? 0) >= CODEX_WAKEUP_MAX_TASKS) throw new CodexWakeupStoreError("limit");
    return tx.queryOne<TaskRow>(
      `INSERT INTO codex_wakeup_tasks
         (id, name, connection_ids, schedule, enabled, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $7)
       RETURNING *`,
      [
        id,
        input.name,
        jsonb(input.connectionIds),
        jsonb(input.schedule),
        Boolean(input.enabled),
        input.enabled ? nextRunAt : null,
        now,
      ]
    );
  });
  return toTask(row as TaskRow);
}

export async function updateCodexWakeupTask(
  id: string,
  input: CodexWakeupTaskInput,
  nextRunAt: string | null,
  nowMs: number = Date.now()
): Promise<CodexWakeupTask> {
  const row = await db().transaction(async (tx) => {
    if (!(await selectTask(tx, id, true))) throw new CodexWakeupStoreError("not_found");
    if (await hasLiveRun(tx, id, nowMs)) throw new CodexWakeupStoreError("running");
    return tx.queryOne<TaskRow>(
      `UPDATE codex_wakeup_tasks
          SET name = $1, connection_ids = $2::jsonb, schedule = $3::jsonb, enabled = $4,
              next_run_at = $5, updated_at = $6
        WHERE id = $7
        RETURNING *`,
      [
        input.name,
        jsonb(input.connectionIds),
        jsonb(input.schedule),
        Boolean(input.enabled),
        input.enabled ? nextRunAt : null,
        msIso(nowMs),
        id,
      ]
    );
  });
  return toTask(row as TaskRow);
}

export async function deleteCodexWakeupTask(
  id: string,
  nowMs: number = Date.now()
): Promise<void> {
  await db().transaction(async (tx) => {
    if (!(await selectTask(tx, id, true))) throw new CodexWakeupStoreError("not_found");
    if (await hasLiveRun(tx, id, nowMs)) throw new CodexWakeupStoreError("running");
    // The runs go with the task through their foreign key.
    await tx.execute("DELETE FROM codex_wakeup_tasks WHERE id = $1", [id]);
  });
}

/**
 * Claim a run of `taskId`. Returns null — without side effects — when a scheduled claim
 * finds the task disabled or not yet due, or when another run of the task still holds a
 * live lease. A scheduled claim moves `next_run_at` to the next slot after `nowMs`, so a
 * slot missed while the server was down runs once and is never replayed.
 * A run whose lease already expired is marked `interrupted` first, because the
 * unique index allows one `running` run per task.
 * Throws `not_found` for an unknown task.
 */
export async function claimCodexWakeupRun(
  taskId: string,
  trigger: CodexWakeupTrigger,
  nowMs: number,
  computeNextRunAt: (schedule: CodexWakeupSchedule, after: number) => string | null
): Promise<CodexWakeupClaim | null> {
  return db().transaction(async (tx): Promise<CodexWakeupClaim | null> => {
    const row = await selectTask(tx, taskId, true);
    if (!row) throw new CodexWakeupStoreError("not_found");
    const task = toTask(row);
    if (trigger === "scheduled") {
      const dueMs = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN;
      if (!task.enabled || !Number.isFinite(dueMs) || dueMs > nowMs) return null;
    }
    if (await hasLiveRun(tx, taskId, nowMs)) return null;
    await tx.execute(
      `UPDATE codex_wakeup_runs SET status = 'interrupted', finished_at = $2
        WHERE task_id = $1 AND status = 'running' AND lease_expires_at <= $2`,
      [taskId, msIso(nowMs)]
    );
    const run: CodexWakeupRun = {
      id: randomUUID(),
      taskId,
      taskName: task.name,
      trigger,
      status: "running",
      results: [],
      startedAt: msIso(nowMs),
      finishedAt: null,
      leaseExpiresAt: nowMs + task.connectionIds.length * LEASE_MS_PER_ACCOUNT + LEASE_BASE_MS,
    };
    // The unique index is the cross-process guard: a lost race inserts nothing.
    const inserted = await tx.queryOne(
      `INSERT INTO codex_wakeup_runs
         (id, task_id, task_name, trigger_kind, status, results, started_at, lease_expires_at)
       VALUES ($1, $2, $3, $4, 'running', '[]'::jsonb, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [run.id, taskId, run.taskName, trigger, run.startedAt, msIso(run.leaseExpiresAt)]
    );
    if (!inserted) return null;
    if (trigger === "scheduled") {
      task.nextRunAt = computeNextRunAt(task.schedule, nowMs);
      await tx.execute("UPDATE codex_wakeup_tasks SET next_run_at = $1, updated_at = now() WHERE id = $2", [
        task.nextRunAt,
        taskId,
      ]);
    }
    return { run, task };
  });
}

/** Append one account result to a run that is still running (a recovered run ignores it). */
export async function recordCodexWakeupResult(
  runId: string,
  result: CodexWakeupRunResult
): Promise<void> {
  if (!UUID_RE.test(runId)) return;
  await db().execute(
    "UPDATE codex_wakeup_runs SET results = results || $2::jsonb WHERE id = $1 AND status = 'running'",
    [runId, jsonb([result])]
  );
}

function deriveRunStatus(
  results: CodexWakeupRunResult[],
  interrupted: boolean
): CodexWakeupRunStatus {
  const statuses = new Set(results.map((result) => result.status));
  if (interrupted || statuses.size === 0) return "interrupted";
  return statuses.size === 1 ? results[0].status : "partial";
}

async function pruneRuns(tx: DbExecutor): Promise<void> {
  await tx.execute(
    `DELETE FROM codex_wakeup_runs
      WHERE status != 'running'
        AND id NOT IN (
          SELECT id FROM codex_wakeup_runs WHERE status != 'running'
           ORDER BY started_at DESC, id DESC LIMIT $1
        )`,
    [CODEX_WAKEUP_MAX_RUNS]
  );
}

/** Close a running run with a status derived from its results; prunes old history. */
export async function finishCodexWakeupRun(
  runId: string,
  nowMs: number = Date.now(),
  interrupted = false
): Promise<CodexWakeupRun | null> {
  if (!UUID_RE.test(runId)) return null;
  return db().transaction(async (tx): Promise<CodexWakeupRun | null> => {
    const row = await tx.queryOne<RunRow>(
      "SELECT * FROM codex_wakeup_runs WHERE id = $1 AND status = 'running' FOR UPDATE",
      [runId]
    );
    if (!row) return null;
    const run = toRun(row);
    run.status = deriveRunStatus(run.results, interrupted);
    run.finishedAt = msIso(nowMs);
    await tx.execute("UPDATE codex_wakeup_runs SET status = $1, finished_at = $2 WHERE id = $3", [
      run.status,
      run.finishedAt,
      runId,
    ]);
    await pruneRuns(tx);
    return run;
  });
}

/** Mark runs whose lease expired while still running (process died mid-run) as interrupted. */
export async function recoverCodexWakeupRuns(nowMs: number = Date.now()): Promise<number> {
  const result = await db().execute(
    `UPDATE codex_wakeup_runs SET status = 'interrupted', finished_at = $1
      WHERE status = 'running' AND lease_expires_at <= $1`,
    [msIso(nowMs)]
  );
  return result.changes;
}

export async function listCodexWakeupRuns(limit = 20): Promise<CodexWakeupRun[]> {
  const rows = await db().query<RunRow>(
    "SELECT * FROM codex_wakeup_runs ORDER BY started_at DESC, id DESC LIMIT $1",
    [Math.max(1, Math.min(Math.floor(limit), CODEX_WAKEUP_MAX_RUNS))]
  );
  return rows.map(toRun);
}
