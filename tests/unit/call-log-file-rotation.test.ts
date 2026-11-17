import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-files-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_RETENTION_DAYS = process.env.CALL_LOG_RETENTION_DAYS;
const ORIGINAL_MAX_ENTRIES = process.env.CALL_LOG_MAX_ENTRIES;
const ORIGINAL_MAX_ROWS = process.env.CALL_LOGS_TABLE_MAX_ROWS;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "7";
process.env.CALL_LOG_MAX_ENTRIES = "2";

const core = await import("../../src/lib/db/core.ts");
const { rotateCallLogs, cleanupOverflowCallLogFiles, cleanupOrphanCallLogFiles } =
  await import("../../src/lib/usage/callLogs.ts");
const { getCallLogsDir, deleteCallArtifact } =
  await import("../../src/lib/usage/callLogArtifacts.ts");
const CALL_LOGS_DIR = getCallLogsDir();

type StateRow = { detail_state: string; artifact_relpath: string | null };

async function resetTestDataDir() {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await resetTestDb();
  for (const entry of fs.readdirSync(TEST_DATA_DIR)) {
    fs.rmSync(path.join(TEST_DATA_DIR, entry), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

const INSERT_CALL_LOG_SQL = `
    INSERT INTO call_logs (
      id, "timestamp", method, path, status, model, provider, account, detail_state, artifact_relpath,
      has_request_body
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `;

async function insertCallLog(row) {
  await getTestBackend().execute(INSERT_CALL_LOG_SQL, [
    row.id,
    row.timestamp,
    row.method || "POST",
    row.path || "/v1/chat/completions",
    row.status || 200,
    row.model || "openai/gpt-4.1",
    row.provider || "openai",
    row.account || "acct",
    row.detail_state || "ready",
    row.artifact_relpath || null,
    true,
  ]);
}

async function stateOf(id: string): Promise<StateRow> {
  const row = await getTestBackend().queryOne<StateRow>(
    "SELECT detail_state, artifact_relpath FROM call_logs WHERE id = $1",
    [id]
  );
  assert.ok(row, `call log ${id} should exist`);
  return row;
}

async function countWhere(where: string, params: unknown[] = []): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM call_logs ${where}`,
    params
  );
  return Number(row?.cnt);
}

function buildArtifactRelPath(date: Date, label: string) {
  const dateFolder = date.toISOString().slice(0, 10);
  const timePart = `${String(date.getUTCHours()).padStart(2, "0")}${String(
    date.getUTCMinutes()
  ).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}`;
  return `${dateFolder}/${timePart}_${label}_200.json`;
}

test.beforeEach(async () => {
  await resetTestDataDir();
});

test.after(async () => {
  await core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }

  if (ORIGINAL_RETENTION_DAYS === undefined) {
    delete process.env.CALL_LOG_RETENTION_DAYS;
  } else {
    process.env.CALL_LOG_RETENTION_DAYS = ORIGINAL_RETENTION_DAYS;
  }

  if (ORIGINAL_MAX_ENTRIES === undefined) {
    delete process.env.CALL_LOG_MAX_ENTRIES;
  } else {
    process.env.CALL_LOG_MAX_ENTRIES = ORIGINAL_MAX_ENTRIES;
  }

  if (ORIGINAL_MAX_ROWS === undefined) {
    delete process.env.CALL_LOGS_TABLE_MAX_ROWS;
  } else {
    process.env.CALL_LOGS_TABLE_MAX_ROWS = ORIGINAL_MAX_ROWS;
  }

  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("call log file rotation honors both retention days and file count", async () => {
  assert.ok(CALL_LOGS_DIR, "CALL_LOGS_DIR should resolve for test data dir");
  fs.rmSync(CALL_LOGS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const oldDate = new Date(now - 10 * oneDay);
  const keepADate = new Date(now - 3 * oneDay);
  const keepBDate = new Date(now - 2 * oneDay);
  const keepCDate = new Date(now - oneDay);

  const oldRelPath = buildArtifactRelPath(oldDate, "old");
  const keepARelPath = buildArtifactRelPath(keepADate, "keep-a");
  const keepBRelPath = buildArtifactRelPath(keepBDate, "keep-b");
  const keepCRelPath = buildArtifactRelPath(keepCDate, "keep-c");

  for (const relativePath of [oldRelPath, keepARelPath, keepBRelPath, keepCRelPath]) {
    const absolutePath = path.join(CALL_LOGS_DIR, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify({ relativePath }), "utf8");
  }

  await insertCallLog({
    id: "old-log",
    timestamp: oldDate.toISOString(),
    artifact_relpath: oldRelPath,
  });
  await insertCallLog({
    id: "keep-a",
    timestamp: keepADate.toISOString(),
    artifact_relpath: keepARelPath,
  });
  await insertCallLog({
    id: "keep-b",
    timestamp: keepBDate.toISOString(),
    artifact_relpath: keepBRelPath,
  });
  await insertCallLog({
    id: "keep-c",
    timestamp: keepCDate.toISOString(),
    artifact_relpath: keepCRelPath,
  });
  fs.utimesSync(
    path.join(CALL_LOGS_DIR, oldRelPath),
    new Date(now - 10 * oneDay),
    new Date(now - 10 * oneDay)
  );
  fs.utimesSync(
    path.join(CALL_LOGS_DIR, keepARelPath),
    new Date(now - 3 * oneDay),
    new Date(now - 3 * oneDay)
  );
  fs.utimesSync(
    path.join(CALL_LOGS_DIR, keepBRelPath),
    new Date(now - 2 * oneDay),
    new Date(now - 2 * oneDay)
  );
  fs.utimesSync(
    path.join(CALL_LOGS_DIR, keepCRelPath),
    new Date(now - oneDay),
    new Date(now - oneDay)
  );

  await rotateCallLogs();

  assert.equal(await countWhere("WHERE id = $1", ["old-log"]), 0);
  assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, oldRelPath)), false);

  const typedKeepARow = await stateOf("keep-a");
  assert.equal(typedKeepARow.detail_state, "missing");
  assert.equal(typedKeepARow.artifact_relpath, null);
  assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, keepARelPath)), false);

  assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, keepBRelPath)), true);
  assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, keepCRelPath)), true);
});

test("rotateCallLogs swallows filesystem errors during cleanup", async () => {
  assert.ok(CALL_LOGS_DIR, "CALL_LOGS_DIR should resolve for test data dir");
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });

  const originalOpendirSync = fs.opendirSync;
  const originalConsoleError = console.error;
  const consoleCalls = [];

  fs.opendirSync = () => {
    throw new Error("simulated opendir failure");
  };
  console.error = (...args) => {
    consoleCalls.push(args.join(" "));
  };

  try {
    await assert.doesNotReject(() => rotateCallLogs());
  } finally {
    fs.opendirSync = originalOpendirSync;
    console.error = originalConsoleError;
  }

  assert.ok(consoleCalls.some((line) => /simulated opendir failure/.test(line)));
});

test("cleanupOverflowCallLogFiles ignores rmSync failures for old artifacts", async () => {
  assert.ok(CALL_LOGS_DIR, "CALL_LOGS_DIR should resolve for test data dir");
  fs.rmSync(CALL_LOGS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });

  const dayDir = path.join(CALL_LOGS_DIR, "2026-04-02");
  fs.mkdirSync(dayDir, { recursive: true });

  const newerRelPath = "2026-04-02/110000_keep.json";
  const olderRelPath = "2026-04-02/100000_remove.json";
  const newerFile = path.join(CALL_LOGS_DIR, newerRelPath);
  const olderFile = path.join(CALL_LOGS_DIR, olderRelPath);
  fs.writeFileSync(newerFile, "{}");
  fs.writeFileSync(olderFile, "{}");

  await insertCallLog({
    id: "keep",
    timestamp: "2026-04-02T11:00:00.000Z",
    artifact_relpath: newerRelPath,
  });
  await insertCallLog({
    id: "remove",
    timestamp: "2026-04-02T10:00:00.000Z",
    artifact_relpath: olderRelPath,
  });

  const now = Date.now();
  fs.utimesSync(newerFile, new Date(now), new Date(now));
  fs.utimesSync(olderFile, new Date(now - 5_000), new Date(now - 5_000));

  const originalRmSync = fs.rmSync;
  fs.rmSync = (targetPath, options) => {
    if (targetPath === olderFile) {
      throw new Error("simulated rm failure");
    }
    return originalRmSync.call(fs, targetPath, options);
  };

  try {
    await assert.doesNotReject(() => cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 1));
  } finally {
    fs.rmSync = originalRmSync;
  }

  assert.equal(fs.existsSync(newerFile), true);
  assert.equal(fs.existsSync(olderFile), true);
});

test("artifact deletion never removes an equivalent trailing-slash root", () => {
  const baseDir = path.join(TEST_DATA_DIR, "root-preservation");
  const artifactPath = path.join(baseDir, "root.json");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(artifactPath, "{}");

  assert.equal(deleteCallArtifact("root.json", `${baseDir}${path.sep}`), true);
  assert.equal(fs.existsSync(artifactPath), false);
  assert.equal(fs.existsSync(baseDir), true);
});

test("scheduled rotation caps retention and max-row trimming at 100 each", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  process.env.CALL_LOG_RETENTION_DAYS = "1";
  process.env.CALL_LOGS_TABLE_MAX_ROWS = "150";

  const oldBase = Date.parse("2020-01-01T00:00:00.000Z");
  const freshBase = Date.now() - 60_000;
  for (let i = 0; i < 250; i++) {
    await insertCallLog({ id: `old-${i}`, timestamp: new Date(oldBase + i).toISOString() });
  }
  for (let i = 0; i < 250; i++) {
    await insertCallLog({ id: `fresh-${i}`, timestamp: new Date(freshBase + i).toISOString() });
  }

  await rotateCallLogs();
  assert.equal(await countWhere("WHERE id LIKE 'old-%'"), 50);
  assert.equal(await countWhere(""), 300);
});

test("overflow cleanup removes at most 100 artifacts and continues across calls", async () => {
  assert.ok(CALL_LOGS_DIR);
  const now = Date.now();
  for (let i = 0; i < 205; i++) {
    const relPath = `2026-04-03/${String(i).padStart(4, "0")}.json`;
    const absPath = path.join(CALL_LOGS_DIR, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, "{}");
    await insertCallLog({
      id: `overflow-${i}`,
      timestamp: new Date(now + i).toISOString(),
      artifact_relpath: relPath,
    });
  }

  assert.equal(await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 5, 100), 100);
  assert.equal(await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 5, 100), 100);
  assert.equal(await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 5, 100), 0);
  assert.equal(await countWhere("WHERE artifact_relpath IS NOT NULL"), 5);
});

test("overflow cleanup frees references whose files are already gone", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.rmSync(CALL_LOGS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });

  // Nine rows, ceiling 3: rows 8, 7, 6 stay under the ceiling (all with a
  // file), rows 5..0 are overflow. Files exist for ranks {0, 3, 6, 7, 8} so
  // every kept rank has its file; ranks {1, 2, 4, 5} are missing.
  const now = Date.now();
  const present = new Set([0, 3, 6, 7, 8]);
  const relPaths: string[] = [];
  for (let i = 0; i < 9; i++) {
    const relPath = `2026-04-06/${String(i).padStart(4, "0")}.json`;
    relPaths.push(relPath);
    if (present.has(i)) {
      const absPath = path.join(CALL_LOGS_DIR, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, "{}");
    }
    await insertCallLog({
      id: `gone-${i}`,
      timestamp: new Date(now + i).toISOString(),
      artifact_relpath: relPath,
    });
  }

  // Overflow window (OFFSET 3) is ranks 5, 4, 3, 2, 1, 0: 2 deletions
  // (ranks 3, 0) + 4 freed missing references (ranks 5, 4, 2, 1).
  assert.equal(await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 3), 6);

  assert.equal(await countWhere("WHERE artifact_relpath IS NOT NULL"), 3);
  for (const i of [1, 2, 4, 5]) {
    const row = await stateOf(`gone-${i}`);
    assert.equal(row.detail_state, "missing");
    assert.equal(row.artifact_relpath, null);
  }
  for (const i of [6, 7, 8]) {
    const row = await stateOf(`gone-${i}`);
    assert.equal(row.detail_state, "ready");
    assert.notEqual(row.artifact_relpath, null);
    assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, relPaths[i])), true);
  }
  for (const i of [0, 3]) {
    assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, relPaths[i])), false);
  }
});

test("overflow cleanup frees a full window of missing files and lets the next pass finish", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.rmSync(CALL_LOGS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });

  // Six rows without any file, ceiling 2: the 4 oldest are overflow, the 2
  // newest stay under the ceiling and keep their references (no sweep below
  // the ceiling).
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    await insertCallLog({
      id: `empty-${i}`,
      timestamp: new Date(now + i).toISOString(),
      artifact_relpath: `2026-04-07/${String(i).padStart(4, "0")}.json`,
    });
  }

  assert.equal(await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 2), 4);

  for (const i of [0, 1, 2, 3]) {
    const row = await stateOf(`empty-${i}`);
    assert.equal(row.detail_state, "missing");
    assert.equal(row.artifact_relpath, null);
  }
  for (const i of [4, 5]) {
    const row = await stateOf(`empty-${i}`);
    assert.equal(row.detail_state, "ready");
    assert.notEqual(row.artifact_relpath, null);
  }
  assert.equal(await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 2), 0);
});

test("overflow cleanup keeps references when deletion is refused", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.rmSync(CALL_LOGS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });

  const dayDir = path.join(CALL_LOGS_DIR, "2026-04-08");
  fs.mkdirSync(dayDir, { recursive: true });
  const newerRelPath = "2026-04-08/110000_keep.json";
  const olderRelPath = "2026-04-08/100000_keep.json";
  const newerFile = path.join(CALL_LOGS_DIR, newerRelPath);
  const olderFile = path.join(CALL_LOGS_DIR, olderRelPath);
  fs.writeFileSync(newerFile, "{}");
  fs.writeFileSync(olderFile, "{}");
  await insertCallLog({
    id: "refused-keep",
    timestamp: "2026-04-08T11:00:00.000Z",
    artifact_relpath: newerRelPath,
  });
  await insertCallLog({
    id: "refused-old",
    timestamp: "2026-04-08T10:00:00.000Z",
    artifact_relpath: olderRelPath,
  });

  const originalRmSync = fs.rmSync;
  fs.rmSync = (targetPath, options) => {
    if (targetPath === olderFile) {
      throw new Error("simulated rm failure");
    }
    return originalRmSync.call(fs, targetPath, options);
  };
  let freed: number | undefined;
  try {
    freed = await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 1);
  } finally {
    fs.rmSync = originalRmSync;
  }
  assert.equal(freed, 0);

  for (const id of ["refused-keep", "refused-old"]) {
    const row = await stateOf(id);
    assert.equal(row.detail_state, "ready");
    assert.notEqual(row.artifact_relpath, null);
  }
  assert.equal(fs.existsSync(newerFile), true);
  assert.equal(fs.existsSync(olderFile), true);
});

test("overflow cleanup frees an empty artifact reference instead of stalling", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.rmSync(CALL_LOGS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });

  // Ceiling 2: the two newest rows stay kept (both with a file); the empty
  // reference and the witness row are both overflow. The helper maps '' to
  // NULL, so the empty reference is inserted with raw SQL.
  const now = Date.now();
  const keptA = "2026-04-09/110000_keep_a.json";
  const keptB = "2026-04-09/105000_keep_b.json";
  const witness = "2026-04-09/100000_witness.json";
  for (const relPath of [keptA, keptB, witness]) {
    const absPath = path.join(CALL_LOGS_DIR, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, "{}");
  }
  await insertCallLog({
    id: "empty-kept-a",
    timestamp: new Date(now + 3).toISOString(),
    artifact_relpath: keptA,
  });
  await insertCallLog({
    id: "empty-kept-b",
    timestamp: new Date(now + 2).toISOString(),
    artifact_relpath: keptB,
  });
  await getTestBackend().execute(INSERT_CALL_LOG_SQL, [
    "empty-ref",
    new Date(now + 1).toISOString(),
    "POST",
    "/v1/chat/completions",
    200,
    "openai/gpt-4.1",
    "openai",
    "acct",
    "ready",
    "",
    true,
  ]);
  await insertCallLog({
    id: "empty-witness",
    timestamp: new Date(now).toISOString(),
    artifact_relpath: witness,
  });

  assert.equal(await cleanupOverflowCallLogFiles(CALL_LOGS_DIR, 2), 2);

  const emptyRow = await stateOf("empty-ref");
  assert.equal(emptyRow.detail_state, "missing");
  assert.equal(emptyRow.artifact_relpath, null);
  const witnessRow = await stateOf("empty-witness");
  assert.equal(witnessRow.detail_state, "missing");
  assert.equal(witnessRow.artifact_relpath, null);
  assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, witness)), false);
  assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, keptA)), true);
  assert.equal(fs.existsSync(path.join(CALL_LOGS_DIR, keptB)), true);
});

test("orphan cleanup scans at most 100 candidates, resumes, and protects fresh files", async () => {
  assert.ok(CALL_LOGS_DIR);
  const dayDir = path.join(CALL_LOGS_DIR, "2026-04-04");
  fs.mkdirSync(dayDir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000);
  for (let i = 0; i < 205; i++) {
    const file = path.join(dayDir, `${String(i).padStart(4, "0")}.json`);
    fs.writeFileSync(file, "{}");
    fs.utimesSync(file, old, old);
  }
  assert.equal(
    await cleanupOrphanCallLogFiles(CALL_LOGS_DIR, { maxCandidates: 100, minAgeMs: 0 }),
    100
  );
  assert.equal(
    await cleanupOrphanCallLogFiles(CALL_LOGS_DIR, { maxCandidates: 100, minAgeMs: 0 }),
    100
  );

  const freshFile = path.join(dayDir, "fresh.json");
  fs.writeFileSync(freshFile, "{}");
  const third = await cleanupOrphanCallLogFiles(CALL_LOGS_DIR, {
    maxCandidates: 100,
    minAgeMs: 5 * 60_000,
  });
  assert.equal(third, 5);
  assert.equal(fs.existsSync(freshFile), true);
});

test("orphan traversal bounds every directory operation and resumes", async () => {
  const baseDir = path.join(TEST_DATA_DIR, "odd-artifact-tree");
  const dayDir = path.join(baseDir, "2026-04-05");
  fs.mkdirSync(dayDir, { recursive: true });
  for (let i = 0; i < 150; i++) {
    fs.writeFileSync(path.join(dayDir, `${String(i).padStart(4, "0")}.tmp`), "{}");
  }
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(dayDir, `${String(i).padStart(4, "0")}.json`), "{}");
  }

  const originalOpendirSync = fs.opendirSync;
  let operations = 0;
  fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
    operations++;
    const dir = originalOpendirSync(...args);
    const originalReadSync = dir.readSync.bind(dir);
    dir.readSync = () => {
      operations++;
      return originalReadSync();
    };
    return dir;
  }) as typeof fs.opendirSync;

  const passOperations: number[] = [];
  let deleted = 0;
  try {
    for (let pass = 0; pass < 2; pass++) {
      operations = 0;
      deleted += await cleanupOrphanCallLogFiles(baseDir, {
        maxCandidates: 100,
        maxScanEntries: 100,
        minAgeMs: 0,
      });
      passOperations.push(operations);
    }
  } finally {
    fs.opendirSync = originalOpendirSync;
  }

  assert.equal(passOperations[0], 100);
  assert.ok(passOperations[1] > 0 && passOperations[1] <= 100);
  assert.equal(deleted, 10);
  assert.equal(fs.readdirSync(dayDir).filter((entry) => entry.endsWith(".json")).length, 0);
});

test("hot rotation avoids full artifact listing and bounds stat calls", async () => {
  assert.ok(CALL_LOGS_DIR);
  const dayDir = path.join(CALL_LOGS_DIR, "2026-04-05");
  fs.mkdirSync(dayDir, { recursive: true });
  for (let i = 0; i < 150; i++) {
    fs.writeFileSync(path.join(dayDir, `${String(i).padStart(4, "0")}.json`), "{}");
  }

  const originalStatSync = fs.statSync;
  let statCalls = 0;
  fs.statSync = (...args) => {
    statCalls++;
    return originalStatSync.apply(fs, args);
  };
  try {
    await rotateCallLogs();
  } finally {
    fs.statSync = originalStatSync;
  }
  assert.ok(statCalls <= 100, `expected at most 100 stat calls, got ${statCalls}`);
});

test("rotateCallLogs recovers a pending artifact write abandoned past its deadline (#15608)", async () => {
  // A process that dies between the call_logs INSERT (detail_state='pending') and the
  // artifact publish leaves the row pending. Rotation must turn an expired pending row
  // into terminal 'missing' so the dashboard stops treating it as in-flight; a write
  // still inside its deadline must stay pending.
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  const now = new Date().toISOString();
  await insertCallLog({ id: "pending-expired", timestamp: now, detail_state: "pending" });
  await insertCallLog({ id: "pending-live", timestamp: now, detail_state: "pending" });
  const db = getTestBackend();
  const setDeadline = (id: string, deadlineMs: number) =>
    db.execute("UPDATE call_logs SET detail_pending_until = $1 WHERE id = $2", [
      new Date(deadlineMs).toISOString(),
      id,
    ]);
  await setDeadline("pending-expired", Date.now() - 1_000);
  await setDeadline("pending-live", Date.now() + 60_000);

  await rotateCallLogs();

  const state = (id: string) =>
    db.queryOne<{ detail_state: string; detail_pending_until: string | null }>(
      "SELECT detail_state, detail_pending_until FROM call_logs WHERE id = $1",
      [id]
    ) as Promise<{ detail_state: string; detail_pending_until: string | null }>;
  assert.equal((await state("pending-expired")).detail_state, "missing");
  assert.equal((await state("pending-expired")).detail_pending_until, null);
  assert.equal((await state("pending-live")).detail_state, "pending");
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function clearPersistedRetention() {
  await getTestBackend().execute(
    "DELETE FROM config_entries WHERE namespace = 'databaseSettings' AND key = 'retention.callLogs'"
  );
}

/** Counts reads of the saved retention through the process backend; `restore` undoes it. */
function countPersistedRetentionReads() {
  const db = getTestBackend();
  const originalQuery = db.query;
  const originalQueryOne = db.queryOne;
  const counter = { reads: 0 };
  const isRetentionRead = (sql: unknown) =>
    typeof sql === "string" && sql.includes("databaseSettings") && sql.includes("config_entries");
  db.query = ((sql: string, ...rest: unknown[]) => {
    if (isRetentionRead(sql)) counter.reads++;
    return (originalQuery as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.query;
  db.queryOne = ((sql: string, ...rest: unknown[]) => {
    if (isRetentionRead(sql)) counter.reads++;
    return (originalQueryOne as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.queryOne;
  return {
    counter,
    restore: () => {
      db.query = originalQuery;
      db.queryOne = originalQueryOne;
    },
  };
}

async function persistDashboardRetention(days: number) {
  await clearPersistedRetention();
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('databaseSettings', 'retention.callLogs', $1::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(days)]
  );
}

function countCallLog(id: string): Promise<number> {
  return countWhere("WHERE id = $1", [id]);
}

test("rotation keeps a 30-day-old request log when the dashboard keeps 90 days", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  delete process.env.CALL_LOG_RETENTION_DAYS;
  await persistDashboardRetention(90);
  try {
    await insertCallLog({
      id: "dashboard-kept",
      timestamp: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });

    await rotateCallLogs();

    assert.equal(await countCallLog("dashboard-kept"), 1);
  } finally {
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("rotation drops a 30-day-old request log when the variable caps at 7 days", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  process.env.CALL_LOG_RETENTION_DAYS = "7";
  await persistDashboardRetention(90);
  try {
    await insertCallLog({
      id: "variable-capped",
      timestamp: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });

    await rotateCallLogs();

    assert.equal(await countCallLog("variable-capped"), 0);
  } finally {
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("rotation drops an 8-day-old request log when neither setting nor variable is set", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  delete process.env.CALL_LOG_RETENTION_DAYS;
  await clearPersistedRetention();
  try {
    await insertCallLog({
      id: "default-dropped",
      timestamp: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    });

    await rotateCallLogs();

    assert.equal(await countCallLog("default-dropped"), 0);
  } finally {
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("rotation falls back to the variable when settings are unavailable", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  delete process.env.CALL_LOG_RETENTION_DAYS;
  await clearPersistedRetention();
  const db = getTestBackend();
  await db.execute("ALTER TABLE config_entries RENAME TO config_entries_backup");
  try {
    await assert.rejects(() =>
      db.query("SELECT key, value FROM config_entries WHERE namespace = $1", ["settings"])
    );

    await assert.doesNotReject(() => rotateCallLogs());
    await insertCallLog({
      id: "fallback-dropped",
      timestamp: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    });
    await rotateCallLogs();

    assert.equal(await countCallLog("fallback-dropped"), 0);
  } finally {
    await db.execute("ALTER TABLE config_entries_backup RENAME TO config_entries");
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("retention falls back when the persisted value is out of contract", async () => {
  delete process.env.CALL_LOG_RETENTION_DAYS;
  await persistDashboardRetention(0);
  try {
    const { resolveCallLogRetentionDays } = await import("../../src/lib/usage/callLogRetention.ts");
    // 0 is a saved value (>= 0 is accepted by the settings reader); it is only out of
    // contract for the rotation, which falls back to the 7-day default.
    assert.equal(await resolveCallLogRetentionDays(), 7);
  } finally {
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("retention honors the dashboard when the variable is invalid", async () => {
  process.env.CALL_LOG_RETENTION_DAYS = "abc";
  await persistDashboardRetention(90);
  try {
    const { resolveCallLogRetentionDays } = await import("../../src/lib/usage/callLogRetention.ts");
    assert.equal(await resolveCallLogRetentionDays(), 90);
  } finally {
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("retention reads no settings when the variable is set", async () => {
  process.env.CALL_LOG_RETENTION_DAYS = "30";
  await persistDashboardRetention(90);
  const db = getTestBackend();
  await db.execute("ALTER TABLE config_entries RENAME TO config_entries_backup");
  try {
    const { resolveCallLogRetentionDays } = await import("../../src/lib/usage/callLogRetention.ts");
    assert.equal(await resolveCallLogRetentionDays(), 30);
  } finally {
    await db.execute("ALTER TABLE config_entries_backup RENAME TO config_entries");
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("rotation reads the settings once per pass while the dashboard decides", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  delete process.env.CALL_LOG_RETENTION_DAYS;
  await persistDashboardRetention(90);
  const spy = countPersistedRetentionReads();
  try {
    await rotateCallLogs();
    assert.equal(spy.counter.reads, 1);
    await rotateCallLogs();
    assert.equal(spy.counter.reads, 2);
  } finally {
    spy.restore();
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});

test("rotation reads no settings when the variable decides", async () => {
  assert.ok(CALL_LOGS_DIR);
  fs.mkdirSync(CALL_LOGS_DIR, { recursive: true });
  process.env.CALL_LOG_RETENTION_DAYS = "7";
  await persistDashboardRetention(90);
  const spy = countPersistedRetentionReads();
  try {
    await rotateCallLogs();

    assert.equal(spy.counter.reads, 0);
  } finally {
    spy.restore();
    process.env.CALL_LOG_RETENTION_DAYS = "7";
    await clearPersistedRetention();
  }
});
