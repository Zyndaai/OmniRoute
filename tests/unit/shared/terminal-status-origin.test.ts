import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-t11-"));
process.env.DATA_DIR = DIR;
const { getTestBackend } = await import("../../helpers/postgres.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { runAsProbe } = await import("../../../src/shared/utils/probeOrigin.ts");
const { writeTerminalStatus } = await import("../../../src/shared/utils/terminalStatus.ts");

test.after(() => {
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function row(id: string): Promise<{ is_active: boolean; test_status: string }> {
  const result = await getTestBackend().queryOne<{ is_active: boolean; test_status: string }>(
    "SELECT is_active, test_status FROM provider_connections WHERE id=$1",
    [id]
  );
  assert.ok(result && typeof result === "object");
  return result;
}

test("probe-origin writeTerminalStatus records error but never deactivates", async () => {
  const conn = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "t11",
    apiKey: "sk-t11",
    isActive: true,
    testStatus: "active",
  });
  const id = String(conn.id);
  await runAsProbe(async () => {
    await writeTerminalStatus(
      id,
      {
        testStatus: "banned",
        isActive: false,
        lastError: "probe 403",
        errorCode: "403",
        lastErrorType: "FORBIDDEN",
      },
      "probe"
    );
  });
  const r = await row(id);
  assert.equal(r.is_active, true); // probe n'a jamais désactivé
  assert.equal(r.test_status, "active"); // terminal non posé
});

test("production writeTerminalStatus deactivates on terminal", async () => {
  const conn = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "t11b",
    apiKey: "sk-t11b",
    isActive: true,
    testStatus: "active",
  });
  const id = String(conn.id);
  await writeTerminalStatus(
    id,
    {
      testStatus: "banned",
      isActive: false,
      lastError: "real 403",
      errorCode: "403",
      lastErrorType: "FORBIDDEN",
    },
    "production"
  );
  const r = await row(id);
  assert.equal(r.is_active, false);
  assert.equal(r.test_status, "banned");
});
