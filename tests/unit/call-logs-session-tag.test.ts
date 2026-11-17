import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #8249: caller session tag (X-OmniRoute-Session-Id header) propagated into call_logs
// so operators can attribute cost per caller session. Isolated DATA_DIR per PII learnings §3
// (resetDbInstance() + handle cleanup in test.after so the node:test runner doesn't hang).
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-session-tag-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");

const sessionTagOf = (id: string) =>
  getTestBackend().queryOne<{ id: string; session_tag: string | null }>(
    "SELECT id, session_tag FROM call_logs WHERE id = $1",
    [id]
  );

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("saveCallLog persists sessionTag when explicitly supplied", async () => {
  const testId = `test-sessiontag-${Date.now()}`;

  await callLogs.saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 10, out: 5 },
    sessionTag: "sess-abc",
  });

  const row = await sessionTagOf(testId);
  assert.ok(row, "row should exist in call_logs");
  assert.equal(row.session_tag, "sess-abc");
});

test("saveCallLog stores NULL session_tag when absent (never synthesized)", async () => {
  const testId = `test-nosessiontag-${Date.now()}`;

  await callLogs.saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 10, out: 5 },
  });

  const row = await sessionTagOf(testId);
  assert.ok(row, "row should exist in call_logs");
  assert.equal(row.session_tag, null, "session_tag must be null when no header was supplied");
});

test("getCallLogs returns sessionTag on the mapped row", async () => {
  const testId = `test-getsessiontag-${Date.now()}`;

  await callLogs.saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 10, out: 5 },
    sessionTag: "sess-roundtrip",
  });

  const logs = await callLogs.getCallLogs({ limit: 200 });
  const found = logs.find((l: { id: string }) => l.id === testId);
  assert.ok(found, "log entry should be found via getCallLogs");
  assert.equal(found.sessionTag, "sess-roundtrip");
});

test("getCallLogs filters by sessionTag (substring match, mirroring correlationId)", async () => {
  const idMatch = `test-filter-match-${Date.now()}`;
  const idOther = `test-filter-other-${Date.now()}`;

  await callLogs.saveCallLog({
    id: idMatch,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 10, out: 5 },
    sessionTag: "customer-42-session",
  });
  await callLogs.saveCallLog({
    id: idOther,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 10, out: 5 },
    sessionTag: "unrelated-session",
  });

  const results = await callLogs.getCallLogs({ sessionTag: "customer-42" });
  const ids = results.map((r: { id: string }) => r.id);
  assert.ok(ids.includes(idMatch), "matching sessionTag row must be returned");
  assert.ok(!ids.includes(idOther), "non-matching sessionTag row must be excluded");
});

test("call_logs.session_tag column exists in the schema", async () => {
  const columns = await getTestBackend().query<{ name: string }>(
    "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'"
  );
  assert.ok(
    columns.some((c) => c.name === "session_tag"),
    "call_logs.session_tag column must exist"
  );
});
