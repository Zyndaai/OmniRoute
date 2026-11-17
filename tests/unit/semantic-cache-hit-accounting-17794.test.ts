import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cache-hit-accounting-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");
const { clearCache, generateSignature, getCacheStats, recordSemanticCacheHit, setCachedResponse } =
  await import("../../src/lib/semanticCache.ts");

async function readEntries() {
  return getTestBackend().query<{ signature: string; prompt_hash: string; hit_count: number }>(
    "SELECT signature, prompt_hash, hit_count FROM semantic_cache ORDER BY signature"
  );
}

async function store(signature: string) {
  await setCachedResponse(signature, "synthetic-model", {
    choices: [{ message: { content: "cached" } }],
  });
}

test.beforeEach(async () => {
  await clearCache();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#17794 a hit increments only the exact entry in a shared API-key namespace", async () => {
  const signatures = ["prompt-a", "prompt-b"].map((content) =>
    generateSignature(
      "synthetic-model",
      [{ role: "user", content }],
      0,
      1,
      "synthetic-key-namespace"
    )
  );
  for (const signature of signatures) await store(signature);
  const before = await readEntries();
  assert.equal(before.length, 2);
  assert.notEqual(signatures[0], signatures[1]);
  assert.equal(before[0].prompt_hash, before[1].prompt_hash);
  assert.ok(before.every((entry) => entry.hit_count === 0));

  await recordSemanticCacheHit(signatures[0], 7);

  assert.deepEqual(
    await readEntries(),
    before.map((entry) => ({ ...entry, hit_count: entry.signature === signatures[0] ? 1 : 0 }))
  );
  assert.equal((await getCacheStats()).hits, 1);
  assert.equal((await getCacheStats()).tokensSaved, 7);
});

test("#17794 an unnamespaced signature does not increment another row sharing its prefix", async () => {
  const signature = "a".repeat(64);
  const sibling = "a".repeat(16) + "b".repeat(48);
  await store(signature);
  await store(sibling);
  const before = await readEntries();
  assert.equal(before.length, 2);
  assert.equal(before[0].prompt_hash, before[1].prompt_hash);

  await recordSemanticCacheHit(signature);

  assert.deepEqual(
    await readEntries(),
    before.map((entry) => ({ ...entry, hit_count: entry.signature === signature ? 1 : 0 }))
  );
  assert.equal((await getCacheStats()).hits, 1);
  assert.equal((await getCacheStats()).tokensSaved, 0);
});

test("#17794 an unmatched Layer-1 hash changes no row but still increments global metrics", async () => {
  const target = "c".repeat(64);
  await store(target.slice(0, 16) + "d".repeat(48));
  await store("synthetic-other-key." + "e".repeat(64));
  const before = await readEntries();
  assert.equal(before.length, 2);
  assert.ok(before.every((entry) => entry.signature !== target));
  assert.ok(before.some((entry) => entry.prompt_hash === target.slice(0, 16)));

  await recordSemanticCacheHit(target, 11);

  assert.deepEqual(await readEntries(), before);
  assert.equal((await getCacheStats()).hits, 1);
  assert.equal((await getCacheStats()).tokensSaved, 11);
});
