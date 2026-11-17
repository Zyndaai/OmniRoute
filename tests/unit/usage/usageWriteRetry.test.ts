/**
 * Gate tests for the shared deferred write retry.
 *
 * The lock predicate accepts every transient conflict shape (retryable kind,
 * serialization failure, deadlock, lock timeout, statement timeout) and rejects
 * any other error. The generic scheduler runs a deferred task once after the
 * delay, reports a second failure through the abandon callback, and never
 * chains a third run. The usage entry point keeps its deferred single retry
 * through the usage writer below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

// Isolate the DB from other tests and from the real data dir.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-write-retry-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// Dynamic imports so DATA_DIR is set before any module initialises the DB.
const core = await import("../../../src/lib/db/core.ts");
const { getTestBackend } = await import("../../helpers/postgres.ts");
const usageHistory = await import("../../../src/lib/usage/usageHistory.ts");
const { saveRequestUsage } = usageHistory;

// Cleanup: close DB handle and temp directory so the test runner doesn't hang.
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── helpers ──────────────────────────────────────────────────────────────────

let entrySeq = 0;

function makeEntry(overrides: Record<string, unknown> = {}) {
  entrySeq++;
  const timestamp = new Date(Date.now() + entrySeq).toISOString();

  return {
    provider: "test-provider",
    model: "test-model",
    connectionId: `conn-retry-${entrySeq}`,
    apiKeyId: null,
    apiKeyName: null,
    tokens: { input_tokens: 10, output_tokens: 20 },
    status: "success",
    success: true,
    latencyMs: 100,
    timeToFirstTokenMs: 50,
    errorCode: null,
    comboStrategy: null,
    endpoint: "/v1/chat/completions",
    timestamp,
    ...overrides,
  };
}

async function countRows(): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    "SELECT COUNT(*)::int AS cnt FROM usage_history"
  );
  return Number(row?.cnt ?? 0);
}

async function countRowsFor(connectionId: string): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    "SELECT COUNT(*)::int AS cnt FROM usage_history WHERE connection_id = $1",
    [connectionId]
  );
  return Number(row?.cnt ?? 0);
}

type WriteLock = { release: () => Promise<void> };

/**
 * Hold a SHARE lock on usage_history from a second connection until released.
 * SHARE blocks the usage inserts (ROW EXCLUSIVE) but not reads, so the test can
 * still count rows while the lock is held. A usage insert then waits on the
 * lock and fails with a statement timeout (57014), a retryable conflict.
 * `release` is idempotent, so a test can release early and again in `finally`.
 */
async function holdWriteLock(): Promise<WriteLock> {
  const client = new pg.Client({ connectionString: process.env.OMNIROUTE_POSTGRES_URL });
  await client.connect();
  await client.query("BEGIN");
  await client.query("LOCK TABLE usage_history IN SHARE MODE");
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    },
  };
}

/** Wait until `check()` is true, up to `timeoutMs`, polling every 50 ms. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Ref'd polling handle that keeps the loop alive past an unref'd retry timer. */
async function waitForGeneric(check: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ── predicate ────────────────────────────────────────────────────────────────

test("write lock predicate accepts transient conflicts and rejects other errors", async () => {
  const { isWriteLockError } = await import("../../../src/lib/usage/usageWriteRetry.ts");
  assert.equal(isWriteLockError({ kind: "retryable", message: "conflict" }), true);
  assert.equal(isWriteLockError({ code: "40001" }), true, "serialization failure");
  assert.equal(isWriteLockError({ code: "40P01" }), true, "deadlock detected");
  assert.equal(isWriteLockError({ code: "55P03" }), true, "lock not available");
  assert.equal(isWriteLockError({ code: "57014" }), true, "statement timeout");
  assert.equal(isWriteLockError(new Error("deadlock detected")), false, "no code, no retry");
  assert.equal(isWriteLockError({ code: "23505" }), false, "unique violation is not a conflict");
  assert.equal(isWriteLockError({ code: "42P01" }), false, "missing table is not a conflict");
  assert.equal(isWriteLockError(new Error("no such table: usage_history")), false);
});

// ── generic scheduler: deferred task runs once, failure reported, never chained ──

test("generic retry runs the deferred task once after the delay", async () => {
  const { scheduleWriteRetry } = await import("../../../src/lib/usage/usageWriteRetry.ts");
  let calls = 0;
  let failures = 0;
  // The retry rides an unref'd timer, so awaiting it alone would let the
  // loop drain; the polling waitFor below keeps a ref'd handle alive instead.
  const done = scheduleWriteRetry(
    () => {
      calls++;
    },
    () => {
      failures++;
    }
  );
  assert.equal(await waitForGeneric(() => calls === 1), true);
  await done;
  assert.equal(calls, 1);
  assert.equal(failures, 0);
});

test("generic retry reports the second failure and never chains a third run", async () => {
  const { scheduleWriteRetry } = await import("../../../src/lib/usage/usageWriteRetry.ts");
  let calls = 0;
  const seen: unknown[] = [];
  const failing = () => {
    calls++;
    throw new Error("database is locked");
  };
  const done = scheduleWriteRetry(failing, (err) => {
    seen.push(err);
  });
  assert.equal(await waitForGeneric(() => calls === 1), true);
  await done;
  assert.equal(calls, 1);
  assert.equal(seen.length, 1);
  assert.match(String((seen[0] as Error)?.message ?? seen[0]), /database is locked/);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(calls, 1);
  assert.equal(seen.length, 1);
});

// ── gate 1: locked first, free second → one row ──────────────────────────────

test("usage write locked on the first attempt is written once the lock clears", async () => {
  const before = await countRows();
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const locker = await holdWriteLock();
  const entry = makeEntry();
  try {
    // The first attempt waits on the lock, times out and is deferred. The row cannot land yet.
    await saveRequestUsage(entry as never);
    assert.equal(await countRows(), before);

    // Free the table before the deferred attempt runs.
    await locker.release();

    assert.equal(await waitFor(async () => (await countRows()) === before + 1, 8000), true);
    assert.equal(await countRows(), before + 1);
    assert.equal(errors.length, 0);
  } finally {
    await locker.release();
    console.error = log;
  }
});

// ── gate 2: locked twice → dropped, logged, no third attempt ────────────────

test("usage write locked on both attempts is dropped with one log line", async () => {
  const before = await countRows();
  const errors: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  const locker = await holdWriteLock();
  const entry = makeEntry();
  try {
    await saveRequestUsage(entry as never);

    // Keep the lock held past the deferred attempt, then wait past any
    // further attempt: a third try would need another full delay window.
    assert.equal(await waitFor(() => errors.length > 0, 20000), true);
    const logged = errors.length;
    assert.equal(logged, 1);
    assert.match(String(errors[0][0]), /Failed to save usage stats:/);
    await locker.release();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(errors.length, logged);
    assert.equal(await countRows(), before);
  } finally {
    await locker.release();
    console.error = log;
  }
});

// ── gate 3: non-lock error → current behaviour, no second attempt ────────────

test("usage write failing on another error is logged at once and never retried", async () => {
  const before = await countRows();
  const errors: unknown[][] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    // A missing table is never a lock: the current path logs and stops.
    const b = getTestBackend();
    await b.execute("ALTER TABLE usage_history RENAME TO usage_history_backup");
    try {
      await saveRequestUsage(makeEntry() as never);
    } finally {
      await b.execute("ALTER TABLE usage_history_backup RENAME TO usage_history");
    }

    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /Failed to save usage stats:/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(errors.length, 1);
    assert.equal(await countRows(), before);
  } finally {
    console.error = log;
  }
});

// ── frozen timestamp: first attempt and retry share one value ───────────────

test("usage write retry replays the first-attempt timestamp", async () => {
  const log = console.error;
  console.error = (..._args: unknown[]) => {};
  const locker = await holdWriteLock();
  // No timestamp on the entry: the envelope freezes one at the first attempt.
  const entry = makeEntry({ connectionId: "conn-retry-frozen-ts" }) as Record<string, unknown>;
  delete entry.timestamp;
  try {
    const t0 = new Date().toISOString();
    await saveRequestUsage(entry as never);

    // Free the table before the deferred attempt runs.
    await locker.release();

    assert.equal(
      await waitFor(async () => (await countRowsFor("conn-retry-frozen-ts")) === 1, 8000),
      true
    );
    const t1 = new Date().toISOString();
    const row = await getTestBackend().queryOne<{ ts: string }>(
      'SELECT "timestamp" AS ts FROM usage_history WHERE connection_id = $1',
      ["conn-retry-frozen-ts"]
    );
    // The retry replayed the frozen value, not one recomputed ~1 s later.
    const rowTs = Date.parse(String(row?.ts));
    assert.ok(rowTs >= Date.parse(t0) && rowTs <= Date.parse(t1));
    assert.ok(Date.parse(t1) - rowTs >= 500);
  } finally {
    await locker.release();
    console.error = log;
  }
});

// ── gate 4: first-attempt success → no second attempt ────────────────────────
test("usage write succeeding on the first attempt never writes twice", async () => {
  const before = await countRows();
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await saveRequestUsage(makeEntry() as never);
    assert.equal(await countRows(), before + 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await countRows(), before + 1);
    assert.equal(errors.length, 0);
  } finally {
    console.error = log;
  }
});
