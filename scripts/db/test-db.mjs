#!/usr/bin/env node
// Per-process Postgres test databases.
//
// A template database (`omni_tpl_<hash12>`) holds the full migrated schema. Each test process
// clones it with `CREATE DATABASE ... TEMPLATE` (tens of ms) instead of re-running migrations.
// The hash covers the migration files and the ledger DDL below, so any change builds a new
// template and the old one is dropped.
//
// Plain `pg` is used instead of the TS migration runner so the CLI and the --import setup work
// without tsx. The cost: the ledger DDL / row shape is duplicated from
// src/lib/db/backends/postgres/migrationRunner.ts (version `pg-NNNN`); it is part of the hash,
// and tests/unit/db/backends/test-db-isolation.test.ts asserts the ledger rows.
//
// CLI: `node scripts/db/test-db.mjs ensure | clean | tune | drop <name>`; admin URL from
// OMNIROUTE_TEST_POSTGRES_URL (never printed). Run `tune` once per new test container.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const TEMPLATE_PREFIX = "omni_tpl_";
export const TEST_DB_PREFIX = "omni_t_";
const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('omni:test-template'))";
const FILE_RE = /^(\d{4,})_(.+)\.sql$/;
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS _omniroute_migrations (
       version text PRIMARY KEY,
       name text NOT NULL,
       applied_at text NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
     )`;

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsDir() {
  const configured = process.env.OMNIROUTE_PG_MIGRATIONS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(here, "../../src/lib/db/backends/postgres/migrations");
}

function readMigrations(dir) {
  return fs
    .readdirSync(dir)
    .map((file) => ({ file, match: FILE_RE.exec(file) }))
    .filter((e) => e.match)
    .map((e) => ({
      n: Number(e.match[1]),
      name: e.match[2],
      file: e.file,
      sql: fs.readFileSync(path.join(dir, e.file), "utf8"),
    }))
    .sort((a, b) => a.n - b.n);
}

function templateNameFor(migrations) {
  const hash = crypto.createHash("sha256");
  hash.update(LEDGER_DDL);
  for (const m of [...migrations].sort((a, b) => (a.file < b.file ? -1 : 1))) {
    hash.update("\0" + m.file + "\0" + m.sql);
  }
  return TEMPLATE_PREFIX + hash.digest("hex").slice(0, 12);
}

export function urlForDatabase(adminUrl, dbName) {
  const u = new URL(adminUrl);
  u.pathname = "/" + dbName;
  return u.toString();
}

const q = (ident) => `"${ident.replace(/"/g, '""')}"`;

async function withAdmin(adminUrl, fn) {
  const admin = new pg.Client({ connectionString: adminUrl });
  admin.on("error", () => {});
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end().catch(() => {});
  }
}

// Session-level advisory lock: serializes template build + clone across test processes.
async function withLock(adminUrl, fn) {
  return withAdmin(adminUrl, async (admin) => {
    await admin.query(LOCK_SQL);
    return fn(admin);
  });
}

async function buildTemplate(admin, adminUrl, name, migrations) {
  await admin.query(
    `CREATE DATABASE ${q(name)} TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'`
  );
  const client = new pg.Client({ connectionString: urlForDatabase(adminUrl, name) });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.query(LEDGER_DDL);
    for (const m of migrations) {
      const version = `pg-${String(m.n).padStart(4, "0")}`;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO _omniroute_migrations (version, name) VALUES ($1, $2)", [
          version,
          m.name,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`test template: migration ${m.file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  await admin.query(`ALTER DATABASE ${q(name)} IS_TEMPLATE true`);
  await admin.query(`ALTER DATABASE ${q(name)} ALLOW_CONNECTIONS false`);
}

async function dropTemplate(admin, name) {
  await admin.query(`ALTER DATABASE ${q(name)} IS_TEMPLATE false`);
  await admin.query(`ALTER DATABASE ${q(name)} ALLOW_CONNECTIONS true`);
  await admin.query(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`);
}

async function dropStaleTemplates(admin, keep) {
  const { rows } = await admin.query(
    "SELECT datname FROM pg_database WHERE datname LIKE 'omni\\_tpl\\_%' AND datname <> $1",
    [keep]
  );
  for (const { datname } of rows) {
    try {
      await dropTemplate(admin, datname);
    } catch {
      // Best effort: another process may be cloning it right now.
    }
  }
}

// Caller holds the lock.
async function ensureTemplateLocked(admin, adminUrl) {
  const migrations = readMigrations(migrationsDir());
  if (migrations.length === 0)
    throw new Error(`test template: no migrations in ${migrationsDir()}`);
  const name = templateNameFor(migrations);
  const { rows } = await admin.query("SELECT datistemplate FROM pg_database WHERE datname = $1", [
    name,
  ]);
  if (rows[0]?.datistemplate) return name;
  if (rows.length) await dropTemplate(admin, name); // half-built by a crashed process
  await buildTemplate(admin, adminUrl, name, migrations);
  await dropStaleTemplates(admin, name);
  return name;
}

export async function ensureTemplate(adminUrl) {
  return withLock(adminUrl, (admin) => ensureTemplateLocked(admin, adminUrl));
}

/** Ensures the template and clones a fresh `omni_t_<pid>_<random>` database. */
export async function createTestDatabase(adminUrl) {
  return withLock(adminUrl, async (admin) => {
    const template = await ensureTemplateLocked(admin, adminUrl);
    const dbName = `${TEST_DB_PREFIX}${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${q(dbName)} TEMPLATE ${q(template)}`);
    return { name: dbName, url: urlForDatabase(adminUrl, dbName), template };
  });
}

export async function dropDatabase(adminUrl, name) {
  if (!name.startsWith(TEST_DB_PREFIX)) throw new Error(`refusing to drop ${name}`);
  await withAdmin(adminUrl, (admin) =>
    admin.query(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`)
  );
}

/** Drops every leftover `omni_t_*` database and every template that is not current. */
export async function cleanTestDatabases(adminUrl) {
  return withLock(adminUrl, async (admin) => {
    const { rows } = await admin.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'omni\\_t\\_%'"
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${q(datname)} WITH (FORCE)`);
    }
    const keep = templateNameFor(readMigrations(migrationsDir()));
    await dropStaleTemplates(admin, keep);
    return rows.length;
  });
}

/**
 * Turns off crash safety on the throwaway TEST server: every test file clones and drops a
 * database, and on Docker for Windows each disk sync is slow. Persisted with ALTER SYSTEM
 * (postgresql.auto.conf), so it survives restarts; rerun after recreating the container.
 * Never point this at a server that holds real data.
 */
export async function tuneTestServer(adminUrl) {
  return withAdmin(adminUrl, async (admin) => {
    for (const setting of ["fsync = off", "synchronous_commit = off", "full_page_writes = off"]) {
      await admin.query(`ALTER SYSTEM SET ${setting}`);
    }
    await admin.query("SELECT pg_reload_conf()");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const adminUrl = process.env.OMNIROUTE_TEST_POSTGRES_URL?.trim();
  const [cmd, arg] = process.argv.slice(2);
  if (!adminUrl) {
    console.error("OMNIROUTE_TEST_POSTGRES_URL is not set.");
    process.exit(2);
  }
  try {
    if (cmd === "ensure") console.log(await ensureTemplate(adminUrl));
    else if (cmd === "clean")
      console.log(`dropped ${await cleanTestDatabases(adminUrl)} database(s)`);
    else if (cmd === "drop" && arg) await dropDatabase(adminUrl, arg);
    else if (cmd === "tune") {
      await tuneTestServer(adminUrl);
      console.log("test server: fsync, synchronous_commit and full_page_writes off");
    } else {
      console.error("usage: test-db.mjs ensure | clean | tune | drop <omni_t_name>");
      process.exit(2);
    }
  } catch (err) {
    // pg messages can echo host details but not the password.
    console.error(`test-db ${cmd} failed: ${err.message}`);
    process.exit(1);
  }
}
