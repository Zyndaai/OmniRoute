/**
 * Tests for jobRegistry persistence (jobRegistryDb.ts, PostgreSQL backend).
 *
 * Verifies:
 *  - 3 built-in jobs seeded by the migration
 *  - upsertJob insert + column-level update (preserves enabled + created_at)
 *  - recordRun writes ISO-8601 timestamps
 *  - pruneRuns count dimension (150 rows -> keep 100)
 *  - pruneRuns time dimension (rows older than 30 days deleted)
 *  - pruneRuns dual dimension (150 rows, 50 older than 30 days -> keep 100)
 *  - cleanupOrphanedRuns fixes stale 'running' records past the timeout
 *
 * Runs against an isolated temp DATA_DIR so the real ~/.omniroute DB is never touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-jr-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const db = await import("../../../src/lib/db/jobRegistryDb.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("seed: a fresh database has no jobs (built-in jobs are registered at boot, not seeded)", async () => {
  // The SQLite migration 139 seeded warmup/budget_reset/token_health_check. The PostgreSQL
  // init migration does not seed `jobs`; src/lib/jobRegistry/registry.ts upserts jobs at boot.
  assert.deepEqual(await db.getAllJobs(), []);
});

test("upsertJob: insert a new job then update scheduling fields", async () => {
  const created = new Date().toISOString();
  await db.upsertJob({
    id: "custom",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: { foo: "bar" },
    createdAt: created,
    updatedAt: created,
  });
  let job = await db.getJob("custom");
  assert.ok(job);
  assert.equal(job.type, "interval");
  assert.equal(job.intervalMs, 1000);
  assert.deepEqual(job.config, { foo: "bar" });

  // Update interval + config; created_at must not change.
  await db.upsertJob({
    ...job!,
    intervalMs: 2000,
    config: { foo: "baz" },
  });
  job = await db.getJob("custom");
  assert.equal(job!.intervalMs, 2000);
  assert.deepEqual(job!.config, { foo: "baz" });
  assert.equal(job!.createdAt, created);
});

test("upsertJob: does NOT overwrite enabled (user toggle preserved)", async () => {
  const ts = new Date().toISOString();
  await db.upsertJob({
    id: "toggle",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: ts,
    updatedAt: ts,
  });
  await db.updateJobEnabled("toggle", false);
  // Re-register with enabled=true - must not flip the user's disabled state.
  await db.upsertJob({
    id: "toggle",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: ts,
    updatedAt: ts,
  });
  assert.equal((await db.getJob("toggle"))!.enabled, false);
});

test("recordRun: writes a completed run with ISO timestamps", async () => {
  await db.upsertJob({
    id: "j",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await db.recordRun("j", "success", {
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 123,
    recordsAffected: 7,
  });
  const runs = await db.getRuns("j");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "success");
  assert.equal(runs[0].recordsAffected, 7);
  assert.equal(runs[0].durationMs, 123);
  assert.equal(runs[0].startedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(runs[0].finishedAt, "finishedAt must be set for a completed run");
});

test("recordRun: running status leaves finishedAt NULL", async () => {
  await db.upsertJob({
    id: "j",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await db.recordRun("j", "running", { startedAt: "2026-01-01T00:00:00.000Z" });
  const runs = await db.getRuns("j");
  assert.equal(runs[0].status, "running");
  assert.equal(runs[0].finishedAt, null);
});

test("pruneRuns: count dimension keeps the most recent 100 of 150", async () => {
  await db.upsertJob({
    id: "j",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Insert 150 rows, oldest first, 1s apart.
  for (let i = 0; i < 150; i++) {
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await db.recordRun("j", "success", { startedAt: t, durationMs: 1 });
  }
  await db.pruneRuns("j", 100, 30);
  const runs = await db.getRuns("j", 200);
  assert.equal(runs.length, 100);
  // The oldest surviving row is the 50th (i=50); rows i=0..49 are pruned.
  const oldestSec = new Date(runs[runs.length - 1].startedAt).getUTCSeconds();
  assert.equal(oldestSec, 50);
});

test("pruneRuns: time dimension deletes rows older than 30 days (once outside recent-100)", async () => {
  // Dual-dimension semantics: a row is deleted only when it is BOTH outside the
  // recent-100 window AND older than maxDays. So we insert 100 recent rows to push
  // the 40-day-old row out of the recent-100, where age then prunes it.
  await db.upsertJob({
    id: "j",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const now = Date.now();
  await db.recordRun("j", "success", {
    startedAt: new Date(now - 40 * 86_400_000).toISOString(),
    durationMs: 1,
  });
  // 100 genuinely-recent rows (hourly, within the last ~4 days) fill the recent-100 window.
  for (let i = 0; i < 100; i++) {
    await db.recordRun("j", "success", {
      startedAt: new Date(now - i * 3_600_000).toISOString(),
      durationMs: 1,
    });
  }
  await db.pruneRuns("j", 100, 30);
  const runs = await db.getRuns("j", 200);
  // The 40-day-old row is outside recent-100 and >30 days -> deleted.
  // Of the 100 recent rows, those aged 31..99 days are also pruned (outside recent-100? no -
  // they're within recent-100 by rank). Only the single 40-day outlier is deleted.
  const hasOld = runs.some((r) => new Date(r.startedAt).getTime() < now - 30 * 86_400_000);
  assert.equal(hasOld, false, "no run older than 30 days should survive");
  assert.equal(runs.length, 100);
});

test("pruneRuns: dual dimension - old rows inside the recent-100 are kept", async () => {
  await db.upsertJob({
    id: "j",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const now = Date.now();
  // 150 rows total: the 50 oldest are >30 days ago, the newest 100 are recent.
  for (let i = 0; i < 150; i++) {
    // Row i=0 oldest. Newest 100 (i=50..149) are recent; oldest 50 (i=0..49) are 40 days old.
    const ageDays = i < 50 ? 40 : 1;
    const t = new Date(now - ageDays * 86_400_000 - (149 - i) * 1000).toISOString();
    await db.recordRun("j", "success", { startedAt: t, durationMs: 1 });
  }
  await db.pruneRuns("j", 100, 30);
  const runs = await db.getRuns("j", 200);
  // The 50 rows older than 30 days are all outside the recent-100 -> deleted.
  // The 100 recent rows survive.
  assert.equal(runs.length, 100);
});

test("cleanupOrphanedRuns: fixes only running rows past the timeout", async () => {
  await db.upsertJob({
    id: "j",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const now = Date.now();
  // Orphaned: running, started 10 minutes ago.
  await db.recordRun("j", "running", { startedAt: new Date(now - 10 * 60_000).toISOString() });
  // Fresh: running, started now - must NOT be touched.
  await db.recordRun("j", "running", { startedAt: new Date(now).toISOString() });

  await db.cleanupOrphanedRuns(5);
  const runs = await db.getRuns("j", 200);
  const orphaned = runs.find((r) => new Date(r.startedAt).getTime() <= now - 10 * 60_000);
  const fresh = runs.find((r) => new Date(r.startedAt).getTime() > now - 60_000);
  assert.equal(orphaned.status, "failure");
  assert.equal(orphaned.errorMessage, "orphaned: exceeded timeout");
  assert.equal(fresh.status, "running");
});
