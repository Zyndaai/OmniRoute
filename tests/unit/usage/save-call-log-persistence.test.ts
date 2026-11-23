import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend } from "../../helpers/postgres.ts";
import { saveCallLog, getCallLogs } from "../../../src/lib/usage/callLogs.ts";

test("saveCallLog persists to DB with correlationId", async () => {
  const b = getTestBackend();
  const testId = `test-corr-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    duration: 1234,
    tokens: { in: 10, out: 5 },
    correlationId: "test-correlation-id-123",
    sourceFormat: "openai",
    targetFormat: "openai",
  });

  const row = (await b.queryOne(
    "SELECT id, correlation_id, status, model FROM call_logs WHERE id = $1",
    [testId]
  )) as Record<string, unknown> | null;
  assert.ok(row, "row should exist in call_logs");
  assert.equal(row.id, testId);
  assert.equal(row.correlation_id, "test-correlation-id-123");
  assert.equal(row.status, 200);
  assert.equal(row.model, "test-model");

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});

test("saveCallLog persists null correlationId when not provided", async () => {
  const b = getTestBackend();
  const testId = `test-nocorr-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 404,
    model: "test-model-2",
    provider: "test-provider",
    duration: 500,
    tokens: {},
  });

  const row = (await b.queryOne("SELECT id, correlation_id FROM call_logs WHERE id = $1", [
    testId,
  ])) as Record<string, unknown> | null;
  assert.ok(row, "row should exist");
  assert.equal(row.correlation_id, null, "correlation_id should be null when not provided");

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});

test("getCallLogs returns correlationId", async () => {
  const b = getTestBackend();
  const testId = `test-getcid-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "test-model-3",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 20, out: 10 },
    correlationId: "cid-roundtrip-test",
  });

  const logs = await getCallLogs({ limit: 100 });
  const found = logs.find((l: { id: string }) => l.id === testId);
  assert.ok(found, "log entry should be found via getCallLogs");
  assert.equal(found.correlationId, "cid-roundtrip-test");

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});

test("call_logs table has correlation_id column", async () => {
  const b = getTestBackend();
  const columns = await b.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'"
  );
  const colNames = columns.map((c) => c.column_name);
  assert.ok(colNames.includes("correlation_id"), "call_logs should have correlation_id column");

  const indexes = await b.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'call_logs'"
  );
  const idxNames = indexes.map((i) => i.indexname);
  assert.ok(
    idxNames.includes("call_logs_correlation_idx"),
    "call_logs should have call_logs_correlation_idx index"
  );
});

test("call_logs table has model_pinned column", async () => {
  const b = getTestBackend();
  const columns = await b.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'"
  );
  const colNames = columns.map((c) => c.column_name);
  assert.ok(colNames.includes("model_pinned"), "call_logs should have model_pinned column");
});

test("saveCallLog persists modelPinned=true as true", async () => {
  const b = getTestBackend();
  const testId = `test-pinned-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "pinned-model",
    provider: "test-provider",
    duration: 500,
    tokens: { in: 10, out: 5 },
    modelPinned: true,
  });

  const row = (await b.queryOne("SELECT id, model_pinned FROM call_logs WHERE id = $1", [
    testId,
  ])) as Record<string, unknown> | null;
  assert.ok(row, "row should exist");
  assert.equal(row.model_pinned, true, "model_pinned should be true when modelPinned=true");

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});

test("saveCallLog persists modelPinned=false as false", async () => {
  const b = getTestBackend();
  const testId = `test-notpinned-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "normal-model",
    provider: "test-provider",
    duration: 500,
    tokens: { in: 10, out: 5 },
    modelPinned: false,
  });

  const row = (await b.queryOne("SELECT id, model_pinned FROM call_logs WHERE id = $1", [
    testId,
  ])) as Record<string, unknown> | null;
  assert.ok(row, "row should exist");
  assert.equal(row.model_pinned, false, "model_pinned should be false when modelPinned=false");

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});

test("call_logs table has video_content_removed column", async () => {
  const b = getTestBackend();
  const columns = await b.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'call_logs'"
  );
  const colNames = columns.map((c) => c.column_name);
  assert.ok(
    colNames.includes("video_content_removed"),
    "call_logs should have video_content_removed column"
  );
});

test("saveCallLog persists videoContentRemoved=true as true (#12150 P2)", async () => {
  const b = getTestBackend();
  const testId = `test-videoremoved-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/responses",
    status: 200,
    model: "video-model",
    provider: "test-provider",
    duration: 500,
    tokens: { in: 10, out: 5 },
    videoContentRemoved: true,
  });

  const row = (await b.queryOne(
    "SELECT id, video_content_removed FROM call_logs WHERE id = $1",
    [testId]
  )) as Record<string, unknown> | null;
  assert.ok(row, "row should exist");
  assert.equal(
    row.video_content_removed,
    true,
    "video_content_removed should be true when videoContentRemoved=true"
  );

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});

test("saveCallLog defaults video_content_removed to false when absent (#12150 P2)", async () => {
  const b = getTestBackend();
  const testId = `test-novideoremoved-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "normal-model",
    provider: "test-provider",
    duration: 500,
    tokens: { in: 10, out: 5 },
  });

  const row = (await b.queryOne(
    "SELECT id, video_content_removed FROM call_logs WHERE id = $1",
    [testId]
  )) as Record<string, unknown> | null;
  assert.ok(row, "row should exist");
  assert.equal(
    row.video_content_removed,
    false,
    "video_content_removed should default to false when not provided"
  );

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});

test("getCallLogs returns modelPinned boolean", async () => {
  const b = getTestBackend();
  const testId = `test-pinned-roundtrip-${Date.now()}`;

  await saveCallLog({
    id: testId,
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "pinned-model-rt",
    provider: "test-provider",
    duration: 100,
    tokens: { in: 20, out: 10 },
    modelPinned: true,
  });

  const logs = await getCallLogs({ limit: 100 });
  const found = logs.find((l: { id: string }) => l.id === testId);
  assert.ok(found, "log entry should be found via getCallLogs");
  assert.equal(found.modelPinned, true, "getCallLogs should return modelPinned as boolean true");

  await b.execute("DELETE FROM call_logs WHERE id = $1", [testId]);
});
