import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetTestDb } from "../../helpers/postgres.ts";

// Regression test for src/lib/db/relayProxies.ts::checkRateLimit.
//
// Covers the perf change that threads an already-fetched RelayToken into
// checkRateLimit to avoid a redundant `SELECT * FROM relay_tokens WHERE id = ?`
// re-query:
//   - the `existingToken` fast-path must agree with the legacy re-query path
//     (same allowed/remaining for identical DB state)
//   - the legacy re-query path (no token passed) must still work unmodified
//   - the per-minute cap must still be enforced correctly via the fast-path

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-relay-check-rate-limit-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const relayProxies = await import("../../../src/lib/db/relayProxies.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function insertRelayToken(overrides: {
  name: string;
  maxRequestsPerMinute: number;
  maxRequestsPerDay: number;
}) {
  return relayProxies.createRelayToken({
    name: overrides.name,
    maxRequestsPerMinute: overrides.maxRequestsPerMinute,
    maxRequestsPerDay: overrides.maxRequestsPerDay,
  });
}

test("checkRateLimit: existingToken fast-path agrees with the legacy re-query path", async () => {
  const token = await insertRelayToken({
    name: "fast-path-token",
    maxRequestsPerMinute: 10,
    maxRequestsPerDay: 1000,
  });

  const legacy = await relayProxies.checkRateLimit(token.id);
  const fastPath = await relayProxies.checkRateLimit(token.id, token);

  assert.deepEqual(fastPath.allowed, legacy.allowed);
  assert.deepEqual(fastPath.remaining, legacy.remaining);
});

test("checkRateLimit: legacy re-query path (no token passed) still works when the token does not exist", async () => {
  const result = await relayProxies.checkRateLimit("does-not-exist");
  assert.equal(result.allowed, false);
  assert.equal(result.remaining, 0);
});

test("checkRateLimit: existingToken fast-path still enforces the per-minute cap", async () => {
  const token = await insertRelayToken({
    name: "cap-token",
    maxRequestsPerMinute: 2,
    maxRequestsPerDay: 1000,
  });

  // Record 2 requests in the current minute window — matches the cap.
  await relayProxies.recordRelayUsage(token.id, { model: "test-model", cost: 0 });
  await relayProxies.recordRelayUsage(token.id, { model: "test-model", cost: 0 });

  const fastPath = await relayProxies.checkRateLimit(token.id, token);
  const legacy = await relayProxies.checkRateLimit(token.id);

  assert.equal(fastPath.allowed, false);
  assert.equal(fastPath.remaining, 0);
  assert.deepEqual(fastPath, legacy);
});
