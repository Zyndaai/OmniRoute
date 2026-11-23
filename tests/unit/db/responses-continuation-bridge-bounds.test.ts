import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Bounds of the in-memory bridge that stands in for a Responses API call-log row until its
// artifact lands (upstream #19053), and replay of omitted-encrypted-reasoning markers (#19434).
// Its own file on purpose: the sweep timer starts once per process, on the first seed.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-continuation-bridge-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const store = await import("../../../src/lib/db/responsesContinuationStore.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

const API_KEY_ID = "key-bridge-bounds";
const INPUT = [{ type: "message", role: "user", content: "history" }];
const OUTPUT = [{ type: "message", role: "assistant", content: "answer" }];
const PIPELINE = {
  clientRawRequest: { body: { input: INPUT } },
  clientResponse: { output: OUTPUT },
};
const STATE = { input: INPUT, output: OUTPUT };
const SEED_TTL_MS = 60_000;
const SWEEP_MS = 30_000;
const MAX_ENTRIES = 512;

test.before(async () => {
  await resetTestDb();
  void getTestBackend;
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seed(responseId: string) {
  store.seedPendingContinuationState(responseId, API_KEY_ID, PIPELINE, false);
}

function resolve(responseId: string) {
  return store.resolvePreviousResponseState(responseId, API_KEY_ID);
}

test("the sweep evicts expired entries that nothing reads again", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  seed("resp-swept");
  assert.equal(store.getPendingContinuationStateCount(), 1);

  t.mock.timers.tick(SWEEP_MS);
  assert.equal(store.getPendingContinuationStateCount(), 1);

  t.mock.timers.tick(SWEEP_MS);
  assert.equal(store.getPendingContinuationStateCount(), 0);
});

test("seeding evicts entries that are already expired", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  seed("resp-expired");
  t.mock.timers.setTime(2_000_000 + SEED_TTL_MS);
  seed("resp-fresh");
  assert.equal(store.getPendingContinuationStateCount(), 1);
  store.clearPendingContinuationState("resp-fresh");
});

test("the bridge never holds more than the cap and reseeding refreshes FIFO order", async () => {
  // One slot short of the cap, so the reseed itself evicts nothing.
  const ids = Array.from({ length: MAX_ENTRIES - 1 }, (_, i) => `resp-fifo-${i}`);
  const added = ["resp-fifo-new-1", "resp-fifo-new-2"];
  ids.forEach(seed);
  seed(ids[0]);
  added.forEach(seed);

  assert.equal(store.getPendingContinuationStateCount(), MAX_ENTRIES);
  assert.deepEqual(await resolve(ids[0]), STATE);
  assert.equal(await resolve(ids[1]), null);

  [...ids, ...added].forEach(store.clearPendingContinuationState);
  assert.equal(store.getPendingContinuationStateCount(), 0);
});

test("a bridged continuation does not replay the encrypted reasoning marker", async () => {
  const userMessage = { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] };
  const marker = "[omitted: encrypted reasoning, 3005 chars]";
  const bare = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: marker };
  const withSummary = {
    type: "reasoning",
    id: "rs_2",
    summary: [{ type: "summary_text", text: "thought" }],
    encrypted_content: marker,
  };
  const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
  store.seedPendingContinuationState(
    "resp-bridge-marker",
    API_KEY_ID,
    {
      clientRawRequest: { effectiveInput: [userMessage, { ...bare, id: "rs_0" }] },
      clientResponse: { output: [bare, withSummary, answer] },
    },
    false
  );

  const state = await resolve("resp-bridge-marker");
  store.clearPendingContinuationState("resp-bridge-marker");

  assert.ok(state, "the continuation still resolves");
  assert.ok(!JSON.stringify(state).includes("[omitted: encrypted reasoning"));
  assert.deepEqual(state.input, [userMessage]);
  assert.deepEqual(state.output, [
    { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "thought" }] },
    answer,
  ]);
});

test("a response whose only output was an omitted reasoning marker fails closed", async () => {
  store.seedPendingContinuationState(
    "resp-only-marker",
    API_KEY_ID,
    {
      clientRawRequest: { body: { input: INPUT } },
      clientResponse: {
        output: [{ type: "reasoning", summary: [], encrypted_content: "[omitted: encrypted reasoning]" }],
      },
    },
    false
  );
  assert.equal(await resolve("resp-only-marker"), null);
});

test("a truncated log that still reached response.completed is continuable", async () => {
  store.seedPendingContinuationState(
    "resp-truncated-completed",
    API_KEY_ID,
    {
      clientRawRequest: { body: { input: INPUT } },
      clientResponse: { _truncated: true, summary: { status: "completed", output: OUTPUT } },
    },
    false
  );
  assert.deepEqual(await resolve("resp-truncated-completed"), STATE);
  store.clearPendingContinuationState("resp-truncated-completed");

  store.seedPendingContinuationState(
    "resp-truncated-open",
    API_KEY_ID,
    {
      clientRawRequest: { body: { input: INPUT } },
      clientResponse: { _truncated: true, summary: { status: "in_progress", output: OUTPUT } },
    },
    false
  );
  assert.equal(await resolve("resp-truncated-open"), null);
});
