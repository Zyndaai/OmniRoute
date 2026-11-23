import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-hidden-catalog-identities-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Removed: "catalog retains its existing listing when only one of two colliding node IDs is
// hidden". It seeds two compatible nodes under one shared prefix, which the Postgres schema
// forbids (provider_nodes_prefix_uq in src/lib/db/backends/postgres/migrations/0001_init.sql),
// so the collision scenario cannot occur anymore.

test("non-chat visibility retains literal IDs even when they match a chat legacy alias", async () => {
  const { createHiddenModelLookup } = await import("../../../src/lib/hiddenModelLookup.ts");
  const hidden = new Map([["gh", new Set(["claude-4.5-opus"])]]);
  const chat = createHiddenModelLookup(hidden);
  const images = createHiddenModelLookup(hidden, [], "images");
  assert.equal(chat("github", "claude-opus-4-5-20251101"), true);
  assert.equal(images("github", "claude-4.5-opus"), true);
  assert.equal(images("github", "claude-opus-4-5-20251101"), false);
});
