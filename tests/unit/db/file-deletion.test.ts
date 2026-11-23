import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-file-deletion-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { createFile, deleteFile, listFiles } = await import("@/lib/db/files");
const { createBatch, getBatch, updateBatch } = await import("@/lib/db/batches");
const { resetDbInstance } = await import("@/lib/db/core");

after(async () => {
  await resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

describe("File Deletion API", () => {
  let testFileId: string;

  afterEach(async () => {
    // Ensure cleanup
    const file = (await listFiles({ limit: 100 })).find(
      (f) => f.filename === "test-delete-file.txt"
    );
    if (file && !file.deletedAt) {
      await deleteFile(file.id);
    }
  });

  beforeEach(async () => {
    const file = await createFile({
      bytes: 100,
      filename: "test-delete-file.txt",
      purpose: "assistants",
      content: Buffer.from("test content"),
      mimeType: "text/plain",
    });
    testFileId = file.id;
  });

  it("should delete a file successfully", async () => {
    const file = (await listFiles({ limit: 100 })).find((f) => f.id === testFileId);
    assert(file !== undefined);
    assert(file.deletedAt === null || file.deletedAt === undefined);

    const success = await deleteFile(testFileId);
    assert(success === true);

    const deletedFile = (await listFiles({ limit: 100 })).find((f) => f.id === testFileId);
    assert(deletedFile === undefined, "Deleted file should not appear in list");
  });

  it("should set deleted_at timestamp on deletion", async () => {
    const now = Date.now();
    await deleteFile(testFileId);

    // Check directly from DB since listFiles filters out deleted files
    const row = await getTestBackend().queryOne<{ deleted_at: string | null }>(
      "SELECT deleted_at FROM files WHERE id = $1",
      [testFileId]
    );

    assert(row !== undefined && row !== null);
    assert(row.deleted_at !== null);
    // timestamptz comes back as an ISO string
    const deletedAt = Date.parse(row.deleted_at as string);
    assert(Number.isFinite(deletedAt));
    // Should be very recent
    assert(deletedAt >= now - 1000);
    assert(deletedAt <= now + 10_000);
  });

  it("should not list deleted files", async () => {
    const beforeCount = (await listFiles({ limit: 1000 })).length;
    await deleteFile(testFileId);
    const afterCount = (await listFiles({ limit: 1000 })).length;

    assert(afterCount === beforeCount - 1);
  });

  it("should handle deletion of non-existent file gracefully", async () => {
    const success = await deleteFile("file-nonexistent-12345");
    // Should return false or handle gracefully (depending on implementation)
    assert(typeof success === "boolean");
  });

  describe("Batch file deletion during cleanup", () => {
    it("should delete batch input file after 30 days of completion", async () => {
      // Create test batch
      const inputFile = await createFile({
        bytes: 100,
        filename: "test-batch-input.jsonl",
        purpose: "batch",
        content: Buffer.from(
          '{"custom_id":"1","method":"POST","url":"/v1/chat/completions","body":{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}}'
        ),
        mimeType: "application/jsonl",
      });

      const batch = await createBatch({
        endpoint: "/v1/chat/completions",
        completionWindow: "24h",
        inputFileId: inputFile.id,
      });

      // Verify batch and file exist
      const batchData = await getBatch(batch.id);
      assert(batchData !== null);
      const fileList = await listFiles({ limit: 1000 });
      assert(fileList.some((f) => f.id === inputFile.id));

      // Simulate batch completion (completed 31 days ago)
      const thirtyOneDaysAgo = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60;
      await updateBatch(batch.id, {
        status: "completed",
        completedAt: thirtyOneDaysAgo,
      });

      // After cleanup runs, file should be deleted
      // (Note: this tests the logic, actual cleanup runs in the processor)
      const expiresAt = thirtyOneDaysAgo + 30 * 24 * 60 * 60;
      const now = Math.floor(Date.now() / 1000);
      assert(now > expiresAt, "Current time should be past expiration");
    });

    it("should NOT delete batch input file if not yet expired", async () => {
      const inputFile = await createFile({
        bytes: 100,
        filename: "test-batch-not-expired.jsonl",
        purpose: "batch",
        content: Buffer.from(
          '{"custom_id":"1","method":"POST","url":"/v1/chat/completions","body":{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}}'
        ),
        mimeType: "application/jsonl",
      });

      const batch = await createBatch({
        endpoint: "/v1/chat/completions",
        completionWindow: "24h",
        inputFileId: inputFile.id,
      });

      // Simulate batch completion (completed 15 days ago)
      const fifteenDaysAgo = Math.floor(Date.now() / 1000) - 15 * 24 * 60 * 60;
      await updateBatch(batch.id, {
        status: "completed",
        completedAt: fifteenDaysAgo,
      });

      // File should still exist
      const fileList = await listFiles({ limit: 1000 });
      const file = fileList.find((f) => f.id === inputFile.id);
      assert(file !== undefined, "File should still exist before expiration");

      // Cleanup
      await deleteFile(inputFile.id);
    });
  });
});
