// Test-only Postgres isolation, the counterpart of isolateDataDir.ts.
//
// Loaded via `node --import ./tests/_setup/isolatePostgres.ts`. A no-op unless
// OMNIROUTE_TEST_POSTGRES_URL (an admin URL) is set. Otherwise this process gets its own
// database cloned from a migrated template (scripts/db/test-db.mjs) and the app is pointed at
// it before any test module loads.
//
// Cleanup: the pool's idle clients keep the event loop alive, so `beforeExit` only fires
// when the backend is closed; under `--test-force-exit` the process goes straight to `exit`,
// where the drop is done synchronously by a short-lived child (`test-db.mjs drop`, ~100 ms).
// `DROP DATABASE ... WITH (FORCE)` disconnects any still-open pool. A killed process leaves its
// database behind: `node scripts/db/test-db.mjs clean` removes those.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore -- plain .mjs without type declarations
import { createTestDatabase, dropDatabase } from "../../scripts/db/test-db.mjs";

const adminUrl = process.env.OMNIROUTE_TEST_POSTGRES_URL?.trim();

if (adminUrl) {
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
    // Credentials travel in the inherited env, never argv.
    spawnSync(process.execPath, [script, "drop", db.name], { stdio: "ignore", timeout: 15_000 });
  });
}
