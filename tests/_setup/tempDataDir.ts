// Shared teardown for tests that own their own temporary DATA_DIR.
//
// Why this exists (#13290): Windows refuses to remove a directory while any handle on it is
// still open (call-log artifact files, for example), so the DB pool is closed first. The
// database itself lives in PostgreSQL; DATA_DIR only holds files.
//
// `maxRetries` cannot help while a handle stays open. The `process.on("exit")` fallback in isolateDataDir.ts
// does not cover these tests either — it only runs when the test does NOT set
// DATA_DIR itself, which is exactly the case that fails here.
//
// The cleanup is deliberately best-effort. A leftover temp directory is a disk
// nuisance the OS eventually reaps; a throwing teardown is a red test that hides
// a green assertion. Failing to remove the directory must never fail the test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Close the DB pool if the DB module was ever loaded.
 *
 * Imported lazily and defensively: most callers never touch the database, and a
 * static import would drag the whole DB layer into every test that only needs a
 * scratch directory. If the module was never loaded, there is nothing to close.
 */
async function closeDbIfOpen(): Promise<void> {
  try {
    const core = await import("../../src/lib/db/core.ts");
    await core.resetDbInstance?.();
  } catch {
    // The DB module is absent, failed to load, or was never initialised.
    // Nothing to close — cleanup continues.
  }
}

/** Remove a directory, swallowing any failure. Never throws. */
function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort: see the file header. A leftover temp dir must not fail a test.
  }
}

/**
 * Create a temporary DATA_DIR and point `process.env.DATA_DIR` at it.
 *
 * Returns the directory path plus a `cleanup()` that closes the database before
 * removing it. Pass `cleanup` straight to `test.after()`:
 *
 * ```ts
 * const { dir: TEST_DATA_DIR, cleanup } = createTempDataDir("my-suite-");
 * test.after(cleanup);
 * ```
 */
export function createTempDataDir(prefix = "omniroute-test-"): {
  dir: string;
  cleanup: () => Promise<void>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dir;

  return {
    dir,
    cleanup: async () => {
      await closeDbIfOpen();
      removeQuietly(dir);
    },
  };
}

/**
 * Teardown for a temp DATA_DIR that was created by hand.
 *
 * For existing tests that already have their own `mkdtempSync` call and only need
 * the close-then-remove ordering fixed:
 *
 * ```ts
 * test.after(() => cleanupTempDataDir(TEST_DATA_DIR));
 * ```
 */
export async function cleanupTempDataDir(dir: string): Promise<void> {
  await closeDbIfOpen();
  removeQuietly(dir);
}
