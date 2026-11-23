import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-probe-autodisable-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const settingsDb = await import("../../../src/lib/db/settings.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { maybeAutoDisableBannedAccount } =
  await import("../../../src/sse/services/autoDisableBannedAccount.ts");
const { runAsProbe } = await import("../../../src/shared/utils/probeOrigin.ts");
const { getTestBackend } = await import("../../helpers/postgres.ts");

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function readIsActive(connId: string): Promise<boolean | undefined> {
  const row = await getTestBackend().queryOne<{ is_active: boolean }>(
    "SELECT is_active FROM provider_connections WHERE id = $1",
    [connId]
  );
  return row?.is_active;
}

async function setupConnection(): Promise<string> {
  await settingsDb.updateSettings({ autoDisableBannedAccounts: true });
  const conn = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "probe-autodisable",
    apiKey: "sk-probe-autodisable", // pragma: allowlist secret
    isActive: true,
    testStatus: "active",
  });
  return String((conn as { id: string }).id);
}

const PROBE_INPUT = {
  provider: "openai",
  authType: "apikey",
  connectionProvider: "openai",
  permanent: true,
};

test("probe-origin permanent failure never disables the connection", async () => {
  const connId = await setupConnection();
  await runAsProbe(() => maybeAutoDisableBannedAccount({ connectionId: connId, ...PROBE_INPUT }));
  assert.equal(await readIsActive(connId), true);
});

test("real-path permanent failure still disables (setting ON)", async () => {
  const connId = await setupConnection();
  await maybeAutoDisableBannedAccount({ connectionId: connId, ...PROBE_INPUT });
  assert.equal(await readIsActive(connId), false);
});
