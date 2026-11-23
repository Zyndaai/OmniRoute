// batch_item_checkpoints and files had NO automatic cleanup path at all: the only
// existing sweep for batches (deleteCompletedBatches(), the operator-triggered
// DELETE /api/v1/batches/delete-completed route) is scoped to `status = 'completed'`
// with no age filter and must be called manually, and files' own `expires_at` was
// never enforced by anything. Observed live: batch_item_checkpoints had grown to
// 182K rows / 5.25 GB and files to 1,874 rows / 5.19 GB, with nothing ever pruning
// either automatically.
//
// This pins deleteTerminalBatchesOlderThan() (batches.ts) and pruneExpiredFiles()
// (files.ts) directly -- the same way db-backup-retention-shared.test.ts pins the
// shared retention helper core.ts's health-check path now calls -- plus the
// cleanup.ts wrappers that wire them into the automatic sweep.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { createFile, getFileContent, pruneExpiredFiles } = await import("../../../src/lib/db/files.ts");
const { createBatch, getBatch, deleteTerminalBatchesOlderThan } =
  await import("../../../src/lib/db/batches.ts");
const { cleanupOldBatches, cleanupExpiredFiles } = await import("../../../src/lib/db/cleanup.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

const DAY = 24 * 60 * 60;

async function backdateBatch(batchId: string, column: string, epochSeconds: number, status: string) {
  await getTestBackend().execute(
    `UPDATE batches SET ${column} = to_timestamp($1), status = $2 WHERE id = $3`,
    [epochSeconds, status, batchId]
  );
}

async function seedBatchWithCheckpoint(overrides: {
  column: string;
  ageDays: number;
  status: string;
}) {
  const inputFile = await createFile({
    bytes: 4,
    filename: "in.jsonl",
    purpose: "batch",
    content: Buffer.from("{}"),
  });
  const batch = await createBatch({
    endpoint: "/v1/chat/completions",
    completionWindow: "24h",
    inputFileId: inputFile.id,
    status: "validating",
  });
  const cutoffSeconds = Math.floor(Date.now() / 1000) - overrides.ageDays * DAY;
  await backdateBatch(batch.id, overrides.column, cutoffSeconds, overrides.status);
  await getTestBackend().execute(
    `INSERT INTO batch_item_checkpoints (batch_id, line_number, status, created_at, updated_at)
     VALUES ($1, 0, 'completed', to_timestamp($2), to_timestamp($2))`,
    [batch.id, cutoffSeconds]
  );
  return { batch, inputFile };
}

async function checkpointCount(batchId: string): Promise<number> {
  const row = await getTestBackend().queryOne<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM batch_item_checkpoints WHERE batch_id = $1",
    [batchId]
  );
  return Number(row?.n ?? 0);
}

describe("deleteTerminalBatchesOlderThan", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("deletes a completed batch older than the retention window, and its checkpoint", async () => {
    const { batch } = await seedBatchWithCheckpoint({
      column: "completed_at",
      ageDays: 40,
      status: "completed",
    });

    const result = await deleteTerminalBatchesOlderThan(30);

    assert.equal(result.deletedBatches, 1);
    assert.equal(await getBatch(batch.id), null);
    assert.equal(await checkpointCount(batch.id), 0);
  });

  it("leaves a completed batch newer than the retention window untouched", async () => {
    const { batch } = await seedBatchWithCheckpoint({
      column: "completed_at",
      ageDays: 5,
      status: "completed",
    });

    const result = await deleteTerminalBatchesOlderThan(30);

    assert.equal(result.deletedBatches, 0);
    assert.ok(await getBatch(batch.id), "batch newer than the retention window must survive");
  });

  it("also covers failed, cancelled, and expired batches -- not just completed", async () => {
    await seedBatchWithCheckpoint({ column: "failed_at", ageDays: 40, status: "failed" });
    await seedBatchWithCheckpoint({ column: "cancelled_at", ageDays: 40, status: "cancelled" });
    await seedBatchWithCheckpoint({ column: "expired_at", ageDays: 40, status: "expired" });

    const result = await deleteTerminalBatchesOlderThan(30);

    assert.equal(
      result.deletedBatches,
      3,
      "deleteCompletedBatches() only ever covered 'completed'; the automatic sweep must cover every terminal status"
    );
  });

  it("never touches a batch that is still in progress, regardless of age", async () => {
    const { batch } = await seedBatchWithCheckpoint({
      column: "created_at",
      ageDays: 90,
      status: "in_progress",
    });

    const result = await deleteTerminalBatchesOlderThan(30);

    assert.equal(result.deletedBatches, 0);
    assert.ok(
      await getBatch(batch.id),
      "a non-terminal batch must never be swept, no matter how old"
    );
  });

  it("cleanupOldBatches() wraps the same behavior with the OMNIROUTE_BATCH_RETENTION_DAYS default, when BATCH_AND_FILE_AUTO_CLEANUP_ENABLED=true", async () => {
    await seedBatchWithCheckpoint({ column: "completed_at", ageDays: 40, status: "completed" });

    process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED = "true";
    try {
      const result = await cleanupOldBatches();
      assert.equal(result.deleted, 1);
      assert.equal(result.errors, 0);
    } finally {
      delete process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED;
    }
  });

  it("cleanupOldBatches() deletes nothing by default (BATCH_AND_FILE_AUTO_CLEANUP_ENABLED unset -- fail closed, #12999)", async () => {
    const { batch } = await seedBatchWithCheckpoint({
      column: "completed_at",
      ageDays: 40,
      status: "completed",
    });

    delete process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED;
    const result = await cleanupOldBatches();

    assert.equal(
      result.deleted,
      0,
      "default behavior must stay identical until an operator opts in"
    );
    assert.equal(result.errors, 0);
    assert.ok(await getBatch(batch.id), "the terminal batch must survive with the flag unset");
  });

  it("cleanupOldBatches() deletes nothing when BATCH_AND_FILE_AUTO_CLEANUP_ENABLED=false", async () => {
    const { batch } = await seedBatchWithCheckpoint({
      column: "completed_at",
      ageDays: 40,
      status: "completed",
    });

    process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED = "false";
    try {
      const result = await cleanupOldBatches();
      assert.equal(result.deleted, 0);
      assert.ok(await getBatch(batch.id));
    } finally {
      delete process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED;
    }
  });
});

describe("pruneExpiredFiles", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("clears content for a file past its own expires_at, keeping the row", async () => {
    const now = Math.floor(Date.now() / 1000);
    const file = await createFile({
      bytes: 4,
      filename: "expired.jsonl",
      purpose: "batch",
      content: Buffer.from("data"),
      expiresAt: now - DAY,
    });

    const deleted = await pruneExpiredFiles(now);

    assert.equal(deleted, 1);
    // The row survives (metadata/audit trail) -- only the BLOB is what was
    // actually consuming the 5.19 GB observed live.
    const row = await getTestBackend().queryOne<{ deleted_at: string | null; content: Buffer | null }>(
      "SELECT deleted_at, content FROM files WHERE id = $1",
      [file.id]
    );
    assert.ok(row?.deleted_at, "deleted_at must be set");
    assert.equal(row?.content, null, "content BLOB must be cleared");
  });

  it("leaves a file with no expiry, or one not yet expired, untouched", async () => {
    const now = Math.floor(Date.now() / 1000);
    const neverExpires = await createFile({
      // "batch" auto-assigns a 30-day expires_at (see createFile()) -- a
      // different purpose is needed here to get a genuinely null expiry.
      bytes: 4,
      filename: "no-expiry.jsonl",
      purpose: "assistants",
      content: Buffer.from("data"),
    });
    const notYetExpired = await createFile({
      bytes: 4,
      filename: "future.jsonl",
      purpose: "batch",
      content: Buffer.from("data"),
      expiresAt: now + DAY,
    });

    const deleted = await pruneExpiredFiles(now);

    assert.equal(deleted, 0);
    assert.ok(await getFileContent(neverExpires.id), "a file with no expiry must keep its content");
    assert.ok(
      await getFileContent(notYetExpired.id),
      "a not-yet-expired file must keep its content"
    );
  });

  it("never re-processes a file that was already explicitly deleted", async () => {
    const now = Math.floor(Date.now() / 1000);
    const file = await createFile({
      bytes: 4,
      filename: "already-deleted.jsonl",
      purpose: "batch",
      content: Buffer.from("data"),
      expiresAt: now - DAY,
    });
    await getTestBackend().execute(
      "UPDATE files SET deleted_at = to_timestamp($1), content = NULL WHERE id = $2",
      [now - 100, file.id]
    );

    const deleted = await pruneExpiredFiles(now);

    assert.equal(deleted, 0, "an already-deleted row must not be counted again");
  });

  it("cleanupExpiredFiles() wraps the same behavior for the automatic sweep, when BATCH_AND_FILE_AUTO_CLEANUP_ENABLED=true", async () => {
    const now = Math.floor(Date.now() / 1000);
    await createFile({
      bytes: 4,
      filename: "expired-2.jsonl",
      purpose: "batch",
      content: Buffer.from("data"),
      expiresAt: now - DAY,
    });

    process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED = "true";
    let result: Awaited<ReturnType<typeof cleanupExpiredFiles>>;
    try {
      result = await cleanupExpiredFiles();
    } finally {
      delete process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED;
    }

    assert.equal(result.deleted, 1);
    assert.equal(result.errors, 0);
  });

  it("cleanupExpiredFiles() clears nothing by default (BATCH_AND_FILE_AUTO_CLEANUP_ENABLED unset -- fail closed, #12999)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const file = await createFile({
      bytes: 4,
      filename: "expired-3.jsonl",
      purpose: "batch",
      content: Buffer.from("data"),
      expiresAt: now - DAY,
    });

    delete process.env.BATCH_AND_FILE_AUTO_CLEANUP_ENABLED;
    const result = await cleanupExpiredFiles();

    assert.equal(
      result.deleted,
      0,
      "default behavior must stay identical until an operator opts in"
    );
    assert.equal(result.errors, 0);
    assert.ok(
      await getFileContent(file.id),
      "the expired file's content must survive with the flag unset"
    );
  });
});
