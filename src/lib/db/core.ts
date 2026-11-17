/**
 * db/core.ts — process-level database lifecycle and shared environment facts.
 *
 * OmniRoute stores everything in PostgreSQL (`backends/postgres/migrations/0001_init.sql`).
 * Domain modules run SQL through `db()` from `./pg`; this module only starts the backend,
 * applies migrations, keeps the log partitions current, and closes the pool on shutdown.
 */

import { isNextBuildPhase } from "../buildPhase";
import { resolveWritableDataDir } from "../dataPaths";
import { getPostgresMigrationHead, runPostgresMigrations } from "./backends/postgres/migrationRunner";
import { getDbBackend, initDbBackend, resetDbBackendForTests } from "./backends/selection";
import { invalidateDbCache } from "./readCache";

// Re-exported so existing call sites that pull these helpers off the core module keep working.
export { toSnakeCase, toCamelCase, objToSnake, rowToCamel, cleanNulls } from "./caseMapping";

// ──────────────── Environment ────────────────

export const isCloud = typeof globalThis.caches === "object" && globalThis.caches !== null;

// Next.js build workers sometimes drop NEXT_PHASE from their env; see src/lib/buildPhase.ts.
// No database is opened during the build.
export const isBuildPhase = isNextBuildPhase();

/** Files that stay on disk (call-log artifacts, service installs, uploads). */
export const DATA_DIR = resolveWritableDataDir({ isCloud });

// ──────────────── Lifecycle ────────────────

let initPromise: Promise<void> | null = null;

/**
 * Connects to PostgreSQL, applies pending migrations and creates the log partitions.
 * Fails startup when the database is unreachable (there is no fallback store).
 * Idempotent per process.
 */
export function ensureDbInitialized(): Promise<void> {
  if (isBuildPhase) return Promise.resolve();
  initPromise ??= (async () => {
    const backend = await initDbBackend();
    const { applied, head } = await runPostgresMigrations(backend, {
      logger: { info: (m) => console.log(m) },
    });
    if (applied.length > 0) console.log(`[DB] Applied ${applied.length} migration(s); head ${head}`);
    await ensureLogPartitions();
  })().catch((error) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

/**
 * Creates today's and the next 14 days' partitions of the per-request log tables
 * (and moves stray rows out of the default partitions). The leader calls this at
 * startup and on every cleanup pass; running it twice is harmless.
 */
export async function ensureLogPartitions(daysAhead = 14): Promise<void> {
  await getDbBackend().transaction(async (tx) => {
    await tx.execute("SET LOCAL statement_timeout = '60s'");
    await tx.execute("SELECT omniroute_ensure_log_partitions(1, $1)", [daysAhead]);
  });
}

/** Liveness probe for /api/health: true when `SELECT 1` succeeds. */
export async function pingDb(): Promise<boolean> {
  return (await getDbBackend().health()).ok;
}

/** Migration head recorded in the database (null before the first migration). */
export async function getSchemaVersion(): Promise<string | null> {
  return getPostgresMigrationHead(getDbBackend());
}

/** Closes the pool. Returns true when a backend was open. */
export async function shutdownDbInstance(): Promise<boolean> {
  if (!globalThis.__omnirouteDbBackend) return false;
  const backend = getDbBackend();
  resetDbBackendForTests();
  initPromise = null;
  await backend.close();
  return true;
}

/** Test helper: drop the process backend and read caches so the next call reconnects. */
export async function resetDbInstance(): Promise<void> {
  await shutdownDbInstance();
  invalidateDbCache();
}
