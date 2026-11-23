import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cid-substr-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const { getTestBackend } = await import("../../helpers/postgres.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// The primary key is (id, timestamp): a fixed timestamp keeps the repeated seeding idempotent.
const SEED_TIMESTAMP = new Date().toISOString();

const INSERT_LOG_SQL = `INSERT INTO call_logs (id, "timestamp", method, path, status, model, provider, account, duration, tokens_in, tokens_out, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id, "timestamp") DO NOTHING`;

// Seed test data
async function seedLogs() {
  const db = getTestBackend();
  const now = SEED_TIMESTAMP;
  const path = "/v1/chat/completions";
  await db.execute(INSERT_LOG_SQL, [
    "log-1",
    now,
    "POST",
    path,
    200,
    "gpt-4",
    "openai",
    "acc1",
    100,
    10,
    20,
    "abc123-def456-ghi789",
  ]);
  await db.execute(INSERT_LOG_SQL, [
    "log-2",
    now,
    "POST",
    path,
    200,
    "claude-3",
    "anthropic",
    "acc2",
    200,
    15,
    30,
    "xyz999-uvw888-tsr777",
  ]);
  await db.execute(INSERT_LOG_SQL, [
    "log-3",
    now,
    "POST",
    path,
    500,
    "gpt-4",
    "openai",
    "acc1",
    50,
    0,
    0,
    null,
  ]);
}

// ── Exact match ───────────────────────────────────────────────────────────

test("correlationId exact match returns single entry", async () => {
  await seedLogs();
  const results = await callLogs.getCallLogs({ correlationId: "abc123-def456-ghi789" });
  assert.equal(results.length, 1);
  assert.equal(results[0].correlationId, "abc123-def456-ghi789");
});

// ── Substring match ───────────────────────────────────────────────────────

test("correlationId substring match (prefix)", async () => {
  await seedLogs();
  const results = await callLogs.getCallLogs({ correlationId: "abc123" });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "log-1");
});

test("correlationId substring match (middle)", async () => {
  await seedLogs();
  const results = await callLogs.getCallLogs({ correlationId: "def456" });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "log-1");
});

test("correlationId substring match (suffix)", async () => {
  await seedLogs();
  const results = await callLogs.getCallLogs({ correlationId: "ghi789" });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "log-1");
});

test("correlationId substring match returns multiple when shared", async () => {
  await seedLogs();
  // Add another log sharing a substring
  await getTestBackend().execute(INSERT_LOG_SQL, [
    "log-4",
    SEED_TIMESTAMP,
    "POST",
    "/v1/chat/completions",
    200,
    "gpt-4",
    "openai",
    "acc1",
    100,
    10,
    20,
    "abc123-RETRY-suffix",
  ]);

  const results = await callLogs.getCallLogs({ correlationId: "abc123" });
  assert.equal(results.length, 2);
  const ids = results.map((r: { id: string }) => r.id).sort();
  assert.deepEqual(ids, ["log-1", "log-4"]);
});

// ── No match ──────────────────────────────────────────────────────────────

test("correlationId no match returns empty", async () => {
  await seedLogs();
  const results = await callLogs.getCallLogs({ correlationId: "nonexistent" });
  assert.equal(results.length, 0);
});

// ── Null/empty correlationId rows excluded ─────────────────────────────────

test("rows with null correlationId are excluded from substring search", async () => {
  await seedLogs();
  // Search for a unique substring that only matches log-1
  const results = await callLogs.getCallLogs({ correlationId: "ghi789" });
  const ids = results.map((r: { id: string }) => r.id);
  assert.ok(!ids.includes("log-3"), "null correlation_id rows must be excluded");
  assert.equal(results.length, 1);
});
