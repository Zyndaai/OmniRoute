/**
 * Key-health persistence writes only the `apiKeyHealth` slice of the stored connection.
 *
 * `creds.providerSpecificData` is the per-request copy taken when the connection was selected.
 * Writing it back whole replaced whatever another writer stored in the meantime (here: the Codex
 * Spark cooldown persisted by the 429 rotation, which the `chatcore-codex-account-pool` describe in
 * `tests/unit/chatcore/codex-openai.test.ts` saw vanish intermittently) and stored request-local
 * keys on the shared row.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-key-health-merge-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "key-health-merge-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const { recordKeyHealthStatus } = await import("../../open-sse/handlers/chatCore/keyHealth.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  await cleanupTempDataDir(TEST_DATA_DIR);
});

async function waitForKeyHealth(id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const row = await providersDb.getProviderConnectionById(id);
    const psd = (row?.providerSpecificData ?? {}) as Record<string, unknown>;
    if (psd.apiKeyHealth) return psd;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("apiKeyHealth was never persisted");
}

test("a 429 key cooldown keeps what another writer stored after the request's snapshot", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "key-health-merge",
    apiKey: "sk-key-health-merge",
    isActive: true,
    providerSpecificData: { stored: "before" },
  });
  const id = connection.id as string;
  // The request's copy: taken at selection time, plus request-local keys.
  const snapshot = { stored: "before", ccSessionId: "request-local", selectedKeyId: "primary" };

  // Another writer changes the stored row while the request is in flight.
  await providersDb.mergeConnectionProviderSpecificData(id, { concurrent: "kept" });

  recordKeyHealthStatus(429, {
    connectionId: id,
    provider: "openai",
    apiKey: "sk-key-health-merge",
    providerSpecificData: snapshot,
  });

  const psd = await waitForKeyHealth(id);
  assert.equal(psd.concurrent, "kept", "the concurrent write survives");
  assert.equal(psd.stored, "before");
  assert.equal(psd.ccSessionId, undefined, "request-local keys stay off the shared row");
  assert.equal(
    typeof (psd.apiKeyHealth as Record<string, { cooldownUntil?: unknown }>).primary
      ?.cooldownUntil,
    "string"
  );
});

test("a credential failure keeps a concurrent write too", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "key-health-merge-401",
    apiKey: "sk-key-health-merge-401",
    isActive: true,
    providerSpecificData: {},
  });
  const id = connection.id as string;
  await providersDb.mergeConnectionProviderSpecificData(id, { concurrent: "kept" });

  recordKeyHealthStatus(401, {
    connectionId: id,
    provider: "openai",
    apiKey: "sk-key-health-merge-401",
    providerSpecificData: {},
  });

  const psd = await waitForKeyHealth(id);
  assert.equal(psd.concurrent, "kept");
});
