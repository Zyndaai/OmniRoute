import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "arena-freshness-16428-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const { getArenaEloSyncStatus, stopArenaEloSync } = await import("../../src/lib/arenaEloSync.ts");

const db = getTestBackend();

const INSERT_SQL = `INSERT INTO model_intelligence (model, source, category, score, synced_at)
  VALUES ($1, $2, $3, $4, $5)`;

before(async () => {
  await resetTestDb();
});

after(async () => {
  stopArenaEloSync();
  await core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("fresh process reports persisted Arena ELO freshness without fetching", async () => {
  await db.execute(INSERT_SQL, ["fixture", "arena_elo", "text", 0.8, "2026-10-14T10:20:30Z"]);
  await db.execute(INSERT_SQL, ["other", "models_dev_tier", "text", 0.9, "2026-10-15T10:20:30Z"]);
  const status = await getArenaEloSyncStatus();
  assert.equal(status.lastSync, "2026-10-14T10:20:30.000Z");
  assert.equal(status.nextSync, null, "reading persisted data must not start a scheduler");
  assert.equal(status.lastSyncModelCount, 0, "process-local last-run count must not be fabricated");
});

test("clearing persisted Arena data removes freshness despite other sources", async () => {
  await db.execute("DELETE FROM model_intelligence WHERE source = $1", ["arena_elo"]);
  assert.equal((await getArenaEloSyncStatus()).lastSync, null);
});

// The SQLite-era "invalid persisted timestamp reports unknown" case is gone: synced_at is a
// timestamptz now, so an unparsable value cannot be stored.

test("ISO timestamps preserve explicit offsets", async () => {
  await db.execute(INSERT_SQL, ["offset", "arena_elo", "text", 0.8, "2026-10-14T07:20:30-03:00"]);
  assert.equal((await getArenaEloSyncStatus()).lastSync, "2026-10-14T10:20:30.000Z");
});
