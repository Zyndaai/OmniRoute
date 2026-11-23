import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CALL_LOG_SETTLE_TIMEOUT_MS } from "../../helpers/callLogSettle.ts";
import { getTestBackend } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-drain-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const artifactWriter = await import("../../../src/lib/usage/callLogArtifactWriter.ts");

test.after(async () => {
  await artifactWriter.closeCallLogArtifactWriter();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("call-log drain waits for artifact metadata and summary commit", async () => {
  const id = "drain-write-1";
  void callLogs.saveCallLog({
    id,
    timestamp: "2026-08-11T12:34:56.789Z",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    requestBody: { pending: true },
    responseBody: { committed: true },
  });

  // The first cold spawn of the worker_threads artifact worker (loaded via tsx)
  // takes seconds before queued artifact writes even start draining; the bound
  // only fails a genuinely stuck drain (see CALL_LOG_SETTLE_TIMEOUT_MS).
  assert.equal(await callLogs.waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS), true);

  const row = (await getTestBackend().queryOne<{
    detail_state: string;
    artifact_relpath: string | null;
    artifact_size_bytes: number | null;
    artifact_sha256: string | null;
  }>(
    `SELECT detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256
       FROM call_logs WHERE id = $1`,
    [id]
  ))!;

  assert.equal(row.detail_state, "ready");
  assert.ok(row.artifact_relpath);
  assert.ok(row.artifact_size_bytes && row.artifact_size_bytes > 0);
  assert.match(row.artifact_sha256 || "", /^[0-9a-f]{8}$/);
  assert.equal(fs.existsSync(path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath)), true);
});

test("forced close settles tracked saves before rejecting late saves", async () => {
  const pendingId = "drain-forced-close";
  const pending = callLogs.saveCallLog({
    id: pendingId,
    timestamp: "2026-08-11T12:35:56.789Z",
    status: 200,
    model: "test-model",
    provider: "test-provider",
    requestBody: { pending: true },
  });

  await callLogs.closeCallLogSaves(0);
  await pending;

  const row = (await getTestBackend().queryOne<{
    detail_state: string;
    artifact_relpath: string | null;
    artifact_size_bytes: number | null;
    artifact_sha256: string | null;
  }>(
    `SELECT detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256
       FROM call_logs WHERE id = $1`,
    [pendingId]
  ))!;
  assert.equal(row.detail_state, "missing");
  // artifact_relpath is a pure function of (timestamp, id) and is stored at INSERT
  // (docs/architecture/postgres-schema-mapping.md); a failed write leaves it set but
  // never publishes a file, size or checksum.
  if (row.artifact_relpath) {
    assert.equal(fs.existsSync(path.join(TEST_DATA_DIR, "call_logs", row.artifact_relpath)), false);
  }
  assert.equal(row.artifact_size_bytes, null);
  assert.equal(row.artifact_sha256, null);

  await callLogs.saveCallLog({
    id: "drain-late-save",
    timestamp: "2026-08-11T12:36:56.789Z",
    status: 200,
    model: "test-model",
    provider: "test-provider",
  });
  const lateCount = await getTestBackend().queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM call_logs WHERE id = $1",
    ["drain-late-save"]
  );
  assert.equal(Number(lateCount?.count), 0);
});
