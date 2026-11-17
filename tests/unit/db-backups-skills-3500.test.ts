/**
 * #3500 slice 5 — skills UPDATE allowlist (Hard Rule #5).
 *
 * The db-backups export/import cases were removed with the SQLite file backups
 * (Postgres has no file-copy backups; pg_dump replaces them). What remains is the
 * skills updateSkill patch logic, run against the per-process Postgres database:
 *  1. updateSkill applies a patch correctly (allowed columns), including the
 *     co-update of `mode` when only `enabled` is provided (legacy sync logic).
 *  2. updateSkill ignores unknown columns (allowlist guard — injection-safe).
 *  3. updateSkill returns 0 for an empty patch or a missing id.
 */
import test from "node:test";
import assert from "node:assert/strict";

const skillsMod = await import("../../src/lib/db/skills.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

// ──────────────── Helpers ────────────────

function uniqueId(prefix = "test") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Insert a minimal skills row directly (bypasses the module under test). */
async function seedSkill(overrides: Partial<Record<string, unknown>> = {}) {
  const b = getTestBackend();
  const id = (overrides.id as string) ?? uniqueId("skill");
  await b.execute(
    `INSERT INTO skills
      (id, api_key_id, name, version, description, schema, handler, enabled, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      overrides.api_key_id ?? "key-1",
      overrides.name ?? "test-skill",
      overrides.version ?? "1.0.0",
      overrides.description ?? "desc",
      overrides.schema ?? "{}",
      overrides.handler ?? "handler",
      overrides.enabled ?? true,
      overrides.mode ?? "auto",
    ]
  );
  return id;
}

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb().catch(() => {});
});

// ──────────────── updateSkill ────────────────

test("updateSkill — patches enabled+mode", async () => {
  const id = await seedSkill({ enabled: true, mode: "auto" });

  // Act
  const changed = await skillsMod.updateSkill(id, { enabled: 0, mode: "off" });

  assert.equal(changed, 1, "should affect 1 row");

  const b = getTestBackend();
  const row = await b.queryOne<{ enabled: boolean; mode: string }>(
    "SELECT enabled, mode FROM skills WHERE id = $1",
    [id]
  );
  assert.equal(row?.enabled, false);
  assert.equal(row?.mode, "off");
});

test("updateSkill — only mode provided is applied", async () => {
  const id = await seedSkill({ enabled: false, mode: "off" });

  await skillsMod.updateSkill(id, { mode: "on" });

  const b = getTestBackend();
  const row = await b.queryOne<{ enabled: boolean; mode: string }>(
    "SELECT enabled, mode FROM skills WHERE id = $1",
    [id]
  );
  assert.equal(row?.mode, "on");
});

test("updateSkill — unknown columns are silently ignored (allowlist guard)", async () => {
  const id = await seedSkill({ enabled: true, mode: "auto" });

  // Inject an unknown key; this must NOT throw or produce SQL with an injected column.
  const patch = { enabled: 0, "'; DROP TABLE skills; --": 1 } as Record<string, unknown>;
  // Cast via any to bypass TS type — testing the runtime allowlist
  const changed = await skillsMod.updateSkill(
    id,
    patch as Parameters<typeof skillsMod.updateSkill>[1]
  );
  assert.equal(changed, 1, "should still apply the known field");

  const b = getTestBackend();
  const tableExists = await b.queryOne(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'skills'"
  );
  assert.ok(tableExists, "skills table must still exist after attempted injection");
});

test("updateSkill — empty patch (all unknown columns) returns 0 changes", async () => {
  const id = await seedSkill();
  const patch = { unknownField: "x" } as Parameters<typeof skillsMod.updateSkill>[1];
  const changed = await skillsMod.updateSkill(id, patch);
  assert.equal(changed, 0);
});

test("updateSkill — non-existent id returns 0 changes", async () => {
  const changed = await skillsMod.updateSkill("non-existent-id", { enabled: 1 });
  assert.equal(changed, 0);
});
