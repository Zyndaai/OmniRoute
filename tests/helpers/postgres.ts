import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getDbBackend } from "../../src/lib/db/backends/selection.ts";
import { fromPglite } from "../../src/lib/db/backends/postgres/pglite.ts";
import { createPostgresBackend } from "../../src/lib/db/backends/postgres/postgresBackend.ts";
import { runPostgresMigrations } from "../../src/lib/db/backends/postgres/migrationRunner.ts";
import type { DbBackend } from "../../src/lib/db/backends/types.ts";
import { PG_TYPE_PARSERS } from "../../src/lib/db/backends/postgres/typeParsers.ts";

/** The process backend; requires the run to use tests/_setup/isolatePostgres.ts. */
export function getTestBackend(): DbBackend {
  if (!process.env.OMNIROUTE_POSTGRES_URL) {
    throw new Error(
      "getTestBackend: OMNIROUTE_POSTGRES_URL is not set (set OMNIROUTE_TEST_POSTGRES_URL and load tests/_setup/isolatePostgres.ts)."
    );
  }
  return getDbBackend();
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Empties every `public` table except the migration ledger (and `except`), in one statement. */
export async function truncateAll(
  backend: DbBackend,
  options: { except?: string[] } = {}
): Promise<void> {
  const skip = new Set(["_omniroute_migrations", ...(options.except ?? [])]);
  const rows = await backend.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  const tables = rows.map((r) => r.tablename).filter((t) => !skip.has(t));
  if (tables.length === 0) return;
  await backend.execute(`TRUNCATE ${tables.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`);
}

/** In-process Postgres (no Docker) with the migrations applied; closed after `fn`. */
export async function withPglite<T>(
  fn: (backend: DbBackend) => Promise<T>,
  options: { migrationsDir?: string } = {}
): Promise<T> {
  // Same row shapes as production `pg` (ISO timestamp strings, numeric bigints).
  const db = new PGlite({ parsers: PG_TYPE_PARSERS });
  const backend = createPostgresBackend(fromPglite(db));
  try {
    const dir =
      options.migrationsDir ??
      process.env.OMNIROUTE_PG_MIGRATIONS_DIR?.trim() ??
      path.resolve("src/lib/db/backends/postgres/migrations");
    if (!fs.existsSync(dir)) throw new Error(`withPglite: migrations dir not found: ${dir}`);
    await runPostgresMigrations(backend, { dir });
    return await fn(backend);
  } finally {
    await backend.close().catch(() => {});
  }
}
