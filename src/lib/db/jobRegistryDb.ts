/**
 * JobRegistry persistence layer.
 *
 * CRUD for the `jobs` and `job_runs` tables. Timestamps are timestamptz columns and
 * come back as ISO-8601 strings; the registry computes thresholds in JS and binds them.
 *
 * Column naming follows the rest of src/lib/db: snake_case columns, camelCase in the
 * returned objects (mapRow). `enabled` is boolean, `config` is jsonb (already parsed).
 */

import { db, jsonb, ts } from "./pg";
import type { JobRecord, JobRun } from "../jobRegistry/core";

function mapJob(row: any): JobRecord {
  const config = row.config;
  return {
    id: row.id,
    type: row.type,
    cron: row.cron,
    intervalMs: row.interval_ms,
    enabled: row.enabled === true,
    envFlag: row.env_flag,
    config: config && typeof config === "object" ? config : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: any): JobRun {
  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    errorMessage: row.error_message,
    recordsAffected: row.records_affected ?? 0,
    durationMs: row.duration_ms,
  };
}

export async function getAllJobs(): Promise<JobRecord[]> {
  const rows = await db().query("SELECT * FROM jobs ORDER BY id");
  return rows.map(mapJob);
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const row = await db().queryOne("SELECT * FROM jobs WHERE id = $1", [id]);
  return row ? mapJob(row) : null;
}

/**
 * Idempotent register: insert on first sight, then a column-level UPDATE that refreshes
 * scheduling fields (type/cron/interval/env_flag/config) and bumps updated_at - but NEVER
 * overwrites `enabled` (the user's API-driven toggle) nor `created_at`. Pass enabled=true
 * for new jobs; the UPDATE simply skips the column.
 */
export async function upsertJob(job: JobRecord): Promise<void> {
  await db().execute(
    `INSERT INTO jobs (id, type, cron, interval_ms, enabled, env_flag, config, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, now()), now())
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type,
       cron = EXCLUDED.cron,
       interval_ms = EXCLUDED.interval_ms,
       env_flag = EXCLUDED.env_flag,
       config = EXCLUDED.config,
       updated_at = now()`,
    [
      job.id,
      job.type,
      job.cron,
      job.intervalMs == null ? null : Math.round(job.intervalMs),
      job.enabled,
      job.envFlag,
      jsonb(job.config ?? {}),
      ts(job.createdAt),
    ]
  );
}

export async function updateJobEnabled(id: string, enabled: boolean): Promise<void> {
  await db().execute("UPDATE jobs SET enabled = $1, updated_at = now() WHERE id = $2", [
    enabled,
    id,
  ]);
}

export interface RecordRunOptions {
  startedAt?: string;
  durationMs?: number;
  errorMessage?: string;
  recordsAffected?: number;
}

/**
 * Insert a completed run. `startedAt` is captured by the registry before the handler
 * runs; `finishedAt` is derived from startedAt + durationMs so the two never drift.
 * A status='running' insert leaves finishedAt NULL (used to mark in-flight work).
 */
export async function recordRun(
  jobId: string,
  status: JobRun["status"],
  opts: RecordRunOptions = {}
): Promise<void> {
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const finishedAt =
    status === "running"
      ? null
      : opts.startedAt && opts.durationMs != null
        ? new Date(new Date(opts.startedAt).getTime() + opts.durationMs).toISOString()
        : new Date().toISOString();
  await db().execute(
    `INSERT INTO job_runs (job_id, started_at, finished_at, status, error_message, records_affected, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      jobId,
      ts(startedAt),
      ts(finishedAt),
      status,
      opts.errorMessage ?? null,
      Math.round(opts.recordsAffected ?? 0),
      opts.durationMs == null ? null : Math.round(opts.durationMs),
    ]
  );
}

/**
 * Dual-dimension pruning: keep the most recent `maxRuns` OR anything younger than
 * `maxDays`. A run is deleted only when it is BOTH outside the recent-N window AND
 * older than maxDays - so a job that runs rarely keeps its full history.
 */
export async function pruneRuns(jobId: string, maxRuns = 100, maxDays = 30): Promise<void> {
  const threshold = new Date(Date.now() - maxDays * 86_400_000).toISOString();
  await db().execute(
    `DELETE FROM job_runs
     WHERE job_id = $1
       AND id NOT IN (
         SELECT id FROM job_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT $2
       )
       AND started_at < $3::timestamptz`,
    [jobId, maxRuns, threshold]
  );
}

export async function getRuns(jobId: string, limit = 20): Promise<JobRun[]> {
  const rows = await db().query(
    "SELECT * FROM job_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT $2",
    [jobId, limit]
  );
  return rows.map(mapRun);
}

/**
 * Startup repair: any run still marked `running` whose started_at is older than
 * `timeoutMinutes` is a leftover from a crashed/hung process. Mark it `failure` so
 * the history is accurate and the slot frees up. The 5-minute default avoids
 * clobbering a genuinely in-flight run on a slow box.
 */
export async function cleanupOrphanedRuns(timeoutMinutes = 5): Promise<void> {
  const threshold = new Date(Date.now() - timeoutMinutes * 60_000).toISOString();
  await db().execute(
    `UPDATE job_runs
     SET status = 'failure',
         error_message = 'orphaned: exceeded timeout',
         finished_at = now()
     WHERE status = 'running' AND started_at < $1::timestamptz`,
    [threshold]
  );
}
