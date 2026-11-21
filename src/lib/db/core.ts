/**
 * db/core.ts — process-level database lifecycle and shared environment facts.
 *
 * OmniRoute stores everything in PostgreSQL (`backends/postgres/migrations/0001_init.sql`).
 * Domain modules run SQL through `db()` from `./pg`; this module only starts the backend,
 * applies migrations, keeps the log partitions current, and closes the pool on shutdown.
 */

import { isWorker } from "../cluster/role";
import { resolveWritableDataDir } from "../dataPaths";
import {
  getBundledPostgresMigrationHead,
  getPostgresMigrationHead,
  runPostgresMigrations,
} from "./backends/postgres/migrationRunner";
import type { DbBackend } from "./backends/types";
import { getDbBackend, initDbBackend, resetDbBackendForTests } from "./backends/selection";
import { invalidateDbCache } from "./readCache";
import { resetAllDbModuleState } from "./stateReset";

// Re-exported so existing call sites that pull these helpers off the core module keep working.
export { toSnakeCase, toCamelCase, objToSnake, rowToCamel, cleanNulls } from "./caseMapping";

// ──────────────── Environment ────────────────

export const isCloud = typeof globalThis.caches === "object" && globalThis.caches !== null;

/** Files that stay on disk (call-log artifacts, service installs, uploads). */
export const DATA_DIR = resolveWritableDataDir({ isCloud });

// ──────────────── Lifecycle ────────────────

let initPromise: Promise<void> | null = null;

const DEFAULT_WORKER_MIGRATION_WAIT_MS = 10 * 60_000;
const WORKER_MIGRATION_POLL_MS = 2_000;

/** `pg-0003` → 3 (null for anything else). */
function migrationNumber(version: string | null): number | null {
  const match = /^pg-(\d+)$/.exec(version ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * A worker never migrates (the leader does, under the schema lock). It waits until the
 * database reaches the migration head bundled in its own image, then serves.
 * Exported for tests: `deps` replaces the clock and the head lookups.
 */
export async function waitForMigrationHead(
  backend: DbBackend,
  deps: {
    bundledHead?: string | null;
    readHead?: () => Promise<string | null>;
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (line: string) => void;
  } = {}
): Promise<string | null> {
  const bundled =
    deps.bundledHead !== undefined ? deps.bundledHead : getBundledPostgresMigrationHead();
  const readHead = deps.readHead ?? (() => getPostgresMigrationHead(backend));
  const timeoutMs =
    deps.timeoutMs ??
    (Number(process.env.OMNIROUTE_WORKER_MIGRATION_WAIT_MS) || DEFAULT_WORKER_MIGRATION_WAIT_MS);
  const pollMs = deps.pollMs ?? WORKER_MIGRATION_POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));

  const want = migrationNumber(bundled);
  if (want === null) return readHead();
  const deadline = now() + timeoutMs;
  let announced = false;
  for (;;) {
    const head = await readHead();
    const have = migrationNumber(head);
    if (have !== null && have > want) {
      throw new Error(
        `[DB] The database is at migration ${head}, newer than this image (${bundled}). ` +
          "This worker runs an older release than the leader; deploy the same image to both."
      );
    }
    if (have === want) return head;
    if (now() >= deadline) {
      throw new Error(
        `[DB] Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the leader to migrate ` +
          `the database to ${bundled} (it is at ${head ?? "nothing"}). Is the leader running?`
      );
    }
    if (!announced) {
      log(
        `[DB] Worker waiting for the leader to migrate the database to ${bundled} (now ${head ?? "empty"})`
      );
      announced = true;
    }
    await sleep(pollMs);
  }
}

/**
 * Connects to PostgreSQL, applies pending migrations and creates the log partitions.
 * A worker only connects and waits for the leader's migrations (`waitForMigrationHead`).
 * Fails startup when the database is unreachable (there is no fallback store).
 * Idempotent per process.
 */
export function ensureDbInitialized(): Promise<void> {
  initPromise ??= (async () => {
    const backend = await initDbBackend();
    if (isWorker()) {
      await waitForMigrationHead(backend);
      return;
    }
    const { applied, head } = await runPostgresMigrations(backend, {
      logger: { info: (m) => console.log(m) },
    });
    if (applied.length > 0)
      console.log(`[DB] Applied ${applied.length} migration(s); head ${head}`);
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

/**
 * Test helper: drop the process backend, the read caches and the module caches registered with
 * `registerDbStateResetter` (as the SQLite-era reset did), so the next call reconnects.
 */
export async function resetDbInstance(): Promise<void> {
  await shutdownDbInstance();
  invalidateDbCache();
  resetAllDbModuleState();
}
