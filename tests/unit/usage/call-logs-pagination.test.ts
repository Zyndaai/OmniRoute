import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression for #2565: the dashboard log viewer paginates by growing its
// fetch window. getCallLogs must honor `limit` and `offset` and keep a stable
// `timestamp DESC` ordering so each page returns the expected rows.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-pagination-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
process.env.CALL_LOG_MAX_ENTRIES = "100000";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");

async function insertCallLog(row: { id: string; timestamp: string }) {
  await getTestBackend().execute(
    `
    INSERT INTO call_logs (
      id, "timestamp", method, path, status, model, provider, cache_source, detail_state
    )
    VALUES ($1, $2, 'POST', '/v1/chat/completions', 200, 'openai/gpt-4.1', 'openai', 'upstream', 'none')
  `,
    [row.id, row.timestamp]
  );
}

test.before(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // Seed 25 rows with strictly increasing timestamps (id N -> minute N).
  for (let i = 0; i < 25; i++) {
    const mm = String(i).padStart(2, "0");
    await insertCallLog({ id: `log_${mm}`, timestamp: `2026-05-22T10:${mm}:00.000Z` });
  }
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#2565: getCallLogs honors limit and returns newest-first", async () => {
  const page = await callLogs.getCallLogs({ limit: 10 });
  assert.equal(page.length, 10);
  // Newest first: log_24 down to log_15.
  assert.equal(page[0].id, "log_24");
  assert.equal(page[9].id, "log_15");
});

test("#2565: getCallLogs offset returns the next page without overlap", async () => {
  const first = await callLogs.getCallLogs({ limit: 10, offset: 0 });
  const second = await callLogs.getCallLogs({ limit: 10, offset: 10 });

  assert.equal(second.length, 10);
  // Second page continues where the first ended.
  assert.equal(second[0].id, "log_14");
  assert.equal(second[9].id, "log_05");

  // No overlap between pages.
  const firstIds = new Set(first.map((l: { id: string }) => l.id));
  assert.ok(second.every((l: { id: string }) => !firstIds.has(l.id)));
});

test("#2565: growing window includes everything the paged windows cover", async () => {
  const grown = await callLogs.getCallLogs({ limit: 20 });
  assert.equal(grown.length, 20);
  assert.equal(grown[0].id, "log_24");
  assert.equal(grown[19].id, "log_05");
});

test("#2565: offset past the end yields an empty page", async () => {
  const beyond = await callLogs.getCallLogs({ limit: 10, offset: 100 });
  assert.equal(beyond.length, 0);
});
