// Port of upstream #18898 (first request of a cold window counted twice) and #19031 (reasoning
// tokens counted twice) for the history seed in tokenLimitCounter.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-seed-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const tokenLimits = await import("../../../src/lib/db/tokenLimits.ts");
const counter = await import("../../../open-sse/services/tokenLimitCounter.ts");

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    value = await read();
  }
  return value;
}

async function seedKey(id: string) {
  await getTestBackend().execute(
    "INSERT INTO api_keys (id, name, key, key_hash) VALUES ($1, $2, $3, $4)",
    [id, id, "test-secret", createHash("sha256").update(id).digest("hex")]
  );
}

async function insertUsage(
  apiKeyId: string,
  input: number,
  output: number,
  ts: string,
  reasoning = 0
) {
  await getTestBackend().execute(
    `INSERT INTO usage_history
       (provider, model, api_key_id, tokens_input, tokens_output, tokens_reasoning, success, "timestamp")
     VALUES ('openai', 'gpt-4o', $1, $2, $3, $4, true, $5)`,
    [apiKeyId, input, output, reasoning, ts]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
  counter.clearTokenLimitCache();
  await seedKey("k-seed");
});

test.after(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function dailyLimit() {
  return tokenLimits.upsertTokenLimit({
    apiKeyId: "k-seed",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 1_000_000,
    resetInterval: "daily",
  });
}

test("#19031 reasoning inside output is not added again in the history seed", async () => {
  const limit = await dailyLimit();
  await insertUsage("k-seed", 100, 50, new Date().toISOString(), 40);
  assert.equal(await counter.seedWindowUsageFromHistory(limit), 150);
});

test("#19031 reasoning larger than output is a separate bucket and is billed", async () => {
  const limit = await dailyLimit();
  await insertUsage("k-seed", 100, 10, new Date().toISOString(), 40);
  assert.equal(await counter.seedWindowUsageFromHistory(limit), 150);
});

test("#18898 the request's own usage_history row is not counted on top of its delta", async () => {
  const limit = await dailyLimit();
  const startedAt = Date.now();
  // Prior usage from before the request started (counted) ...
  await insertUsage("k-seed", 400, 100, new Date(startedAt - 60_000).toISOString());
  // ... and the request's own row, written before the counter increment runs (must not be).
  await insertUsage("k-seed", 70, 30, new Date(startedAt + 20).toISOString());

  assert.equal(
    await counter.seedWindowUsageFromHistory(limit, Date.now(), undefined, startedAt),
    500
  );

  counter.recordTokenUsage("k-seed", "openai", "gpt-4o", 100, startedAt);
  const usage = await eventually(
    () => tokenLimits.getWindowUsage(limit, Date.now()),
    (n) => n >= 600
  );
  assert.equal(usage, 600);
});
