import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { fromPglite } from "../../../../src/lib/db/backends/postgres/pglite.ts";
import { createPostgresBackend } from "../../../../src/lib/db/backends/postgres/postgresBackend.ts";
import {
  getBundledPostgresMigrationHead,
  getPostgresMigrationHead,
  runPostgresMigrations,
} from "../../../../src/lib/db/backends/postgres/migrationRunner.ts";
import { DbBackendError } from "../../../../src/lib/db/backends/types.ts";

async function fresh() {
  const db = new PGlite();
  const backend = createPostgresBackend(fromPglite(db));
  await backend.execute("CREATE TABLE t (id serial PRIMARY KEY, name text NOT NULL UNIQUE)");
  return backend;
}

test("query, queryOne and execute report rows and changes", async () => {
  const backend = await fresh();
  assert.deepEqual(await backend.execute("INSERT INTO t (name) VALUES ($1), ($2)", ["a", "b"]), {
    changes: 2,
  });
  assert.deepEqual(await backend.query("SELECT name FROM t ORDER BY id"), [
    { name: "a" },
    { name: "b" },
  ]);
  assert.deepEqual(await backend.queryOne("SELECT name FROM t WHERE name = $1", ["b"]), {
    name: "b",
  });
  assert.equal(await backend.queryOne("SELECT name FROM t WHERE name = $1", ["zz"]), undefined);
  assert.deepEqual(await backend.execute("DELETE FROM t WHERE name = $1", ["zz"]), { changes: 0 });
  assert.deepEqual(await backend.execute("DELETE FROM t WHERE name = $1", ["a"]), { changes: 1 });
  assert.deepEqual(await backend.health(), { ok: true });
  await backend.close();
});

test("transaction commits and rolls back", async () => {
  const backend = await fresh();
  await backend.transaction(async (tx) => {
    await tx.execute("INSERT INTO t (name) VALUES ($1)", ["kept"]);
  });
  await assert.rejects(
    backend.transaction(async (tx) => {
      await tx.execute("INSERT INTO t (name) VALUES ($1)", ["dropped"]);
      throw new Error("boom");
    }),
    /boom/
  );
  const rows = await backend.query<{ name: string }>("SELECT name FROM t");
  assert.deepEqual(
    rows.map((r) => r.name),
    ["kept"]
  );
  await backend.close();
});

test("a statement error inside a transaction rolls back and is classified", async () => {
  const backend = await fresh();
  await backend.execute("INSERT INTO t (name) VALUES ($1)", ["dup"]);
  await assert.rejects(
    backend.transaction(async (tx) => {
      await tx.execute("INSERT INTO t (name) VALUES ($1)", ["x"]);
      await tx.execute("INSERT INTO t (name) VALUES ($1)", ["dup"]);
    }),
    (err: unknown) => err instanceof DbBackendError && err.kind === "unique_violation"
  );
  assert.equal((await backend.query("SELECT 1 FROM t")).length, 1);
  // The connection is usable again after the aborted transaction.
  await backend.execute("INSERT INTO t (name) VALUES ($1)", ["after"]);
  await backend.close();
});

test("unique, not-null and fk violations are classified", async () => {
  const backend = await fresh();
  await backend.execute("CREATE TABLE c (id serial PRIMARY KEY, t_id int REFERENCES t(id))");
  await backend.execute("INSERT INTO t (name) VALUES ($1)", ["dup"]);
  const kind = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof DbBackendError);
      return err.kind;
    }
    return "none";
  };
  assert.equal(
    await kind(backend.execute("INSERT INTO t (name) VALUES ($1)", ["dup"])),
    "unique_violation"
  );
  assert.equal(
    await kind(backend.execute("INSERT INTO t (name) VALUES ($1)", [null])),
    "not_null_violation"
  );
  assert.equal(
    await kind(backend.execute("INSERT INTO c (t_id) VALUES ($1)", [999])),
    "foreign_key_violation"
  );
  await backend.close();
});

test("concurrent transactions serialize", async () => {
  const backend = await fresh();
  const order: string[] = [];
  const run = (label: string) =>
    backend.transaction(async (tx) => {
      order.push(`${label}:start`);
      await tx.execute("INSERT INTO t (name) VALUES ($1)", [label]);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`${label}:end`);
    });
  await Promise.all([run("a"), run("b")]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  await backend.close();
});

test("runPostgresMigrations applies each file once, in order, and is idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-pg-mig-"));
  fs.writeFileSync(
    path.join(dir, "0001_init.sql"),
    "CREATE TABLE a (id int PRIMARY KEY);\nINSERT INTO a VALUES (1);"
  );
  fs.writeFileSync(path.join(dir, "0002_more.sql"), "CREATE TABLE b (id int PRIMARY KEY);");
  fs.writeFileSync(path.join(dir, "README.md"), "ignored");
  const db = new PGlite();
  const backend = createPostgresBackend(fromPglite(db));
  try {
    assert.equal(await getPostgresMigrationHead(backend), null);
    const first = await runPostgresMigrations(backend, { dir });
    assert.deepEqual(first, { applied: ["pg-0001", "pg-0002"], head: "pg-0002" });
    const second = await runPostgresMigrations(backend, { dir });
    assert.deepEqual(second, { applied: [], head: "pg-0002" });

    const ledger = await backend.query<{ version: string; name: string; applied_at: string }>(
      "SELECT version, name, applied_at FROM _omniroute_migrations ORDER BY version"
    );
    assert.deepEqual(
      ledger.map((r) => [r.version, r.name]),
      [
        ["pg-0001", "init"],
        ["pg-0002", "more"],
      ]
    );
    assert.match(ledger[0].applied_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal((await backend.query("SELECT * FROM a")).length, 1);
    assert.equal(getBundledPostgresMigrationHead(dir), await getPostgresMigrationHead(backend));
  } finally {
    await backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing migration rolls back its file and its ledger row", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-pg-mig-"));
  fs.writeFileSync(path.join(dir, "0001_ok.sql"), "CREATE TABLE ok (id int);");
  fs.writeFileSync(
    path.join(dir, "0002_bad.sql"),
    "CREATE TABLE half (id int);\nSELECT * FROM does_not_exist;"
  );
  const backend = createPostgresBackend(fromPglite(new PGlite()));
  try {
    await assert.rejects(runPostgresMigrations(backend, { dir }), DbBackendError);
    assert.equal(await getPostgresMigrationHead(backend), "pg-0001");
    assert.equal((await backend.query("SELECT to_regclass('half') AS r"))[0].r, null);
  } finally {
    await backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty or missing migration directories report a null head", async () => {
  const dir = path.join(os.tmpdir(), "omni-pg-mig-does-not-exist");
  assert.equal(getBundledPostgresMigrationHead(dir), null);
});

test("a caller's own error inside a transaction reaches the caller unchanged", async () => {
  const backend = await fresh();
  class DomainError extends Error {}
  const thrown = new DomainError("quota exceeded");
  await assert.rejects(
    backend.transaction(async (tx) => {
      await tx.execute("INSERT INTO t (name) VALUES ($1)", ["rolled-back"]);
      throw thrown;
    }),
    (err) => err === thrown
  );
  assert.equal(await backend.queryOne("SELECT 1 FROM t WHERE name = $1", ["rolled-back"]), undefined);
  await backend.close();
});
