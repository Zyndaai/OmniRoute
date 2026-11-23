// Test-only Postgres isolation, the counterpart of isolateDataDir.ts.
//
// Loaded via `node --import ./tests/_setup/isolatePostgres.ts`. A no-op unless
// OMNIROUTE_TEST_POSTGRES_URL (an admin URL) is set. Otherwise this process gets its own
// database cloned from a migrated template (scripts/db/test-db.mjs) and the app is pointed at
// it before any test module loads.
//
// Cleanup: the pool's idle clients keep the event loop alive, so `beforeExit` only fires
// when the backend is closed; under `--test-force-exit` the process goes straight to `exit`,
// where the drop is handed to a detached child (`test-db.mjs drop`) that the exiting process
// does not wait for: waiting cost ~220 ms per test file (node start + connect + drop).
// `DROP DATABASE ... WITH (FORCE)` disconnects any still-open pool. A killed process leaves its
// database behind: `node scripts/db/test-db.mjs clean` removes those.
//
// The `node --test` runner process itself loads every --import too, but only spawns the test
// files and never touches the app, so it gets no database (unless --test-isolation=none runs
// the tests inside it).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore -- plain .mjs without type declarations
import { createTestDatabase, dropDatabase } from "../../scripts/db/test-db.mjs";

const adminUrl = process.env.OMNIROUTE_TEST_POSTGRES_URL?.trim();
const isTestRunnerParent =
  !process.env.NODE_TEST_CONTEXT &&
  process.execArgv.includes("--test") &&
  !process.execArgv.some((arg) => /^--(experimental-)?test-isolation=none$/.test(arg));

if (adminUrl && !isTestRunnerParent) {
  const db: { name: string; url: string } = await createTestDatabase(adminUrl);
  process.env.OMNIROUTE_POSTGRES_URL = db.url;

  let dropped = false;

  process.on("beforeExit", async () => {
    if (dropped) return;
    dropped = true;
    try {
      await (
        globalThis as { __omnirouteDbBackend?: { close(): Promise<void> } }
      ).__omnirouteDbBackend?.close();
    } catch {
      // the drop below forces connections closed anyway
    }
    await dropDatabase(adminUrl, db.name).catch(() => {});
  });

  process.on("exit", () => {
    if (dropped) return;
    dropped = true;
    const script = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../scripts/db/test-db.mjs"
    );
    // Credentials travel in the inherited env, never argv. `windowsHide`: a test process
    // without a console would otherwise open a console window for this child on Windows.
    // Detached and unref'd: the drop finishes after this process has exited.
    spawn(process.execPath, [script, "drop", db.name], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  });
}
