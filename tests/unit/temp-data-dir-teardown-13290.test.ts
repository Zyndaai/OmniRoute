import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTempDataDir, cleanupTempDataDir } from "../_setup/tempDataDir.ts";

// #13290 — teardown that removes a temp DATA_DIR must not throw or leave the
// directory behind. (The SQLite-handle case is gone: the database is PostgreSQL now.)

test("createTempDataDir points DATA_DIR at a fresh directory", () => {
  const previous = process.env.DATA_DIR;
  const { dir, cleanup } = createTempDataDir("omniroute-tempdatadir-test-");
  try {
    assert.equal(process.env.DATA_DIR, dir);
    assert.ok(fs.existsSync(dir), "directory must exist");
  } finally {
    void cleanup();
    process.env.DATA_DIR = previous;
  }
});

test("cleanup never throws when the directory is already gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tempdatadir-missing-"));
  fs.rmSync(dir, { recursive: true, force: true });

  await assert.doesNotReject(() => cleanupTempDataDir(dir));
});
