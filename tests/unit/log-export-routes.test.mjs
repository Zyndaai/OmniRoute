import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-log-export-routes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const exportRoute = await import("../../src/app/api/logs/export/route.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");

// The database-backup export (db-backups/exportAll) was removed with the SQLite storage file;
// call-log export is the remaining path covered here.
async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.updateSettings({ requireLogin: false });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("GET /api/logs/export returns explicit detailed payloads from artifact storage", async () => {
  await callLogs.saveCallLog({
    id: "export-route-log",
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "openai/gpt-4.1",
    provider: "openai",
    requestBody: { messages: [{ role: "user", content: "hello export" }] },
    responseBody: { id: "resp-export", ok: true },
  });
  await callLogs.waitForCallLogSaves(10_000);

  const response = await exportRoute.GET(
    new Request("http://localhost/api/logs/export?hours=24&type=call-logs")
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.logs[0].id, "export-route-log");
  assert.deepEqual(body.logs[0].requestBody, {
    messages: [{ role: "user", content: "hello export" }],
  });
  assert.deepEqual(body.logs[0].responseBody, { id: "resp-export", ok: true });
  assert.equal(body.logs[0].detailState, "ready");
});
