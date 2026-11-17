// Vitest counterpart of isolatePostgres.ts (vitest.mcp.config.ts `setupFiles`).
//
// Runs before every test file. Vitest reuses worker threads across files and the DB backend
// is a globalThis singleton, so each file closes whatever backend the previous file in this
// thread left, gets its own database cloned from the migrated template, and drops it when the
// file finishes. A no-op unless OMNIROUTE_TEST_POSTGRES_URL (an admin URL) is set.
import { afterAll } from "vitest";
// @ts-ignore -- plain .mjs without type declarations
import { createTestDatabase, dropDatabase } from "../../scripts/db/test-db.mjs";

type BackendSlot = { __omnirouteDbBackend?: { close(): Promise<void> } };

async function closeProcessBackend(): Promise<void> {
  const slot = globalThis as BackendSlot;
  const backend = slot.__omnirouteDbBackend;
  slot.__omnirouteDbBackend = undefined;
  await backend?.close().catch(() => {});
}

const adminUrl = process.env.OMNIROUTE_TEST_POSTGRES_URL?.trim();

if (adminUrl) {
  await closeProcessBackend();
  const db: { name: string; url: string } = await createTestDatabase(adminUrl);
  process.env.OMNIROUTE_POSTGRES_URL = db.url;

  afterAll(async () => {
    await closeProcessBackend();
    await dropDatabase(adminUrl, db.name).catch(() => {});
  });
}
