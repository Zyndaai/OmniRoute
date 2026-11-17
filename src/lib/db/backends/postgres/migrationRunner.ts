import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { DbBackend, DbExecutor } from "../types";

/**
 * Postgres migration runner. SQL files are `NNNN_name.sql`; the ledger version
 * is `pg-NNNN` so it can never collide with the SQLite ledger's numeric slots.
 */

const LEDGER_TABLE = "_omniroute_migrations";
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('omniroute:schema'))";
const FILE_RE = /^(\d{4,})_(.+)\.sql$/;

export interface MigrationLogger {
  debug?(message: string): void;
  info?(message: string): void;
}

interface MigrationFile {
  version: string;
  name: string;
  path: string;
}

function resolveBundledDir(): string {
  const configured = process.env.OMNIROUTE_PG_MIGRATIONS_DIR;
  if (configured && configured.trim()) return path.resolve(configured);

  const rel = path.join("src", "lib", "db", "backends", "postgres", "migrations");
  const probe = (base: string): string | null => {
    for (const loc of [
      path.join(base, "migrations"),
      path.join(base, rel),
      path.join(base, "app", rel),
    ]) {
      if (fs.existsSync(loc)) return loc;
    }
    return null;
  };

  try {
    // Start at this module's own directory so `./migrations` wins, then walk up
    // (covers the Next standalone layout, same approach as the SQLite runner).
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (dir !== path.dirname(dir)) {
      const found = probe(dir);
      if (found) return found;
      dir = path.dirname(dir);
    }
  } catch {
    // import.meta.url can be a non-file URL in some packaged installs; fall back to cwd.
  }
  return probe(process.cwd()) ?? path.join(process.cwd(), rel);
}

function readMigrationFiles(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  const files: Array<MigrationFile & { n: number }> = [];
  for (const filename of fs.readdirSync(dir)) {
    const match = FILE_RE.exec(filename);
    if (!match) continue;
    const n = Number(match[1]);
    files.push({
      n,
      version: `pg-${String(n).padStart(4, "0")}`,
      name: match[2],
      path: path.join(dir, filename),
    });
  }
  files.sort((a, b) => a.n - b.n);
  for (let i = 1; i < files.length; i++) {
    if (files[i].version === files[i - 1].version) {
      throw new Error(`Duplicate Postgres migration version ${files[i].version}`);
    }
  }
  return files;
}

export function getBundledPostgresMigrationHead(dir: string = resolveBundledDir()): string | null {
  const files = readMigrationFiles(dir);
  return files.length ? files[files.length - 1].version : null;
}

/** Highest applied `pg-NNNN` version, or null when the ledger is missing/empty. */
export async function getPostgresMigrationHead(backend: DbBackend): Promise<string | null> {
  try {
    const rows = await backend.query<{ version: string }>(
      `SELECT version FROM ${LEDGER_TABLE} WHERE version LIKE 'pg-%' ORDER BY version DESC LIMIT 1`
    );
    return rows[0]?.version ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

async function ensureLedger(tx: DbExecutor): Promise<void> {
  await tx.execute(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
       version text PRIMARY KEY,
       name text NOT NULL,
       applied_at text NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
     )`
  );
}

/**
 * Applies pending migrations in order. Each file runs in its own transaction
 * together with its ledger insert. The advisory lock is transaction-scoped and
 * taken inside every migration transaction (then the ledger is re-checked), so
 * concurrent replicas serialize per file without needing a dedicated
 * connection that outlives a transaction; a replica that loses the race sees
 * the version already recorded and skips it.
 */
export async function runPostgresMigrations(
  backend: DbBackend,
  options: { dir?: string; logger?: MigrationLogger } = {}
): Promise<{ applied: string[]; head: string | null }> {
  const dir = options.dir ?? resolveBundledDir();
  const log = options.logger ?? {};
  const files = readMigrationFiles(dir);
  const applied: string[] = [];

  await backend.transaction(async (tx) => {
    await tx.execute(LOCK_SQL);
    await ensureLedger(tx);
  });

  for (const file of files) {
    const sql = fs.readFileSync(file.path, "utf8");
    const ran = await backend.transaction(async (tx) => {
      await tx.execute(LOCK_SQL);
      const done = await tx.queryOne(`SELECT 1 AS ok FROM ${LEDGER_TABLE} WHERE version = $1`, [
        file.version,
      ]);
      if (done) {
        log.debug?.(`[pg-migrate] ${file.version} already applied`);
        return false;
      }
      // Migrations may legitimately exceed the pool's 5s statement timeout.
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      await tx.execute(sql);
      await tx.execute(`INSERT INTO ${LEDGER_TABLE} (version, name) VALUES ($1, $2)`, [
        file.version,
        file.name,
      ]);
      return true;
    });
    if (ran) {
      applied.push(file.version);
      log.info?.(`[pg-migrate] applied ${file.version}_${file.name}`);
    }
  }

  return { applied, head: await getPostgresMigrationHead(backend) };
}
