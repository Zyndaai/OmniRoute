// A key can hold one token limit per (scope, reset interval). Regression for the operator
// report "adding a token limit replaces the previous record": the old UNIQUE
// (api_key_id, scope_type, scope_value) made a weekly global limit overwrite the daily one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limits-window-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { createHash } = await import("node:crypto");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const tokenLimits = await import("../../src/lib/db/tokenLimits.ts");
const counter = await import("../../open-sse/services/tokenLimitCounter.ts");
const route = await import("../../src/app/api/usage/token-limits/route.ts");

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const KEY_IDS = ["k1", "k2", "k3", "k4", "k5", "k6"];

test.beforeEach(async () => {
  await resetTestDb();
  // token limits reference api_keys (FK): seed the keys these tests use.
  const backend = getTestBackend();
  for (const id of KEY_IDS) {
    await backend.execute("INSERT INTO api_keys (id, name, key, key_hash) VALUES ($1, $2, $3, $4)", [
      id,
      id,
      "test-secret",
      createHash("sha256").update(id).digest("hex"),
    ]);
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  counter.clearTokenLimitCache();
});

test.after(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function postLimit(body: Record<string, unknown>) {
  return route.POST(
    new Request("http://localhost/api/usage/token-limits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

test("daily and weekly global limits for one key both persist", async () => {
  const daily = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k1",
    scopeType: "global",
    tokenLimit: 1000,
    resetInterval: "daily",
  });
  const weekly = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k1",
    scopeType: "global",
    tokenLimit: 5000,
    resetInterval: "weekly",
  });

  const rows = await tokenLimits.listTokenLimits("k1");
  assert.equal(rows.length, 2);
  assert.notEqual(daily.id, weekly.id);
  assert.deepEqual(rows.map((r) => [r.resetInterval, r.tokenLimit]).sort(), [
    ["daily", 1000],
    ["weekly", 5000],
  ]);
});

test("re-posting the same scope and window updates that row in place", async () => {
  const first = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k2",
    scopeType: "provider",
    scopeValue: "claude",
    tokenLimit: 100,
    resetInterval: "daily",
  });
  const second = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k2",
    scopeType: "provider",
    scopeValue: "claude",
    tokenLimit: 250,
    resetInterval: "daily",
  });

  assert.equal(second.id, first.id);
  assert.equal(second.tokenLimit, 250);
  assert.equal((await tokenLimits.listTokenLimits("k2")).length, 1);
});

test("updating by id can change the window and leaves other rows alone", async () => {
  const daily = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k3",
    scopeType: "global",
    tokenLimit: 100,
    resetInterval: "daily",
  });
  const model = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k3",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 50,
    resetInterval: "daily",
  });

  const updated = await tokenLimits.upsertTokenLimit({
    id: daily.id,
    apiKeyId: "k3",
    scopeType: "global",
    tokenLimit: 700,
    resetInterval: "monthly",
  });

  assert.equal(updated.id, daily.id);
  assert.equal(updated.resetInterval, "monthly");
  assert.equal(updated.tokenLimit, 700);
  const untouched = (await tokenLimits.listTokenLimits("k3")).find((r) => r.id === model.id);
  assert.equal(untouched?.tokenLimit, 50);
});

test("both windows are enforced: the daily limit breaches before the weekly one", async () => {
  const daily = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k4",
    scopeType: "global",
    tokenLimit: 100,
    resetInterval: "daily",
  });
  await tokenLimits.upsertTokenLimit({
    apiKeyId: "k4",
    scopeType: "global",
    tokenLimit: 10_000,
    resetInterval: "weekly",
  });
  const ws = tokenLimits.resetWindowIfElapsed(daily, NOW).windowStart;
  await tokenLimits.incrementWindowTokens(daily.id, ws, 150);

  const breach = await counter.checkTokenLimits("k4", "openai", "gpt-4o", NOW);
  assert.ok(breach);
  assert.equal(breach!.limitValue, 100);
});

test("route: an update by id that collides with another window returns 409 without a stack", async () => {
  const daily = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k5",
    scopeType: "global",
    tokenLimit: 100,
    resetInterval: "daily",
  });
  await tokenLimits.upsertTokenLimit({
    apiKeyId: "k5",
    scopeType: "global",
    tokenLimit: 500,
    resetInterval: "weekly",
  });

  const res = await postLimit({
    id: daily.id,
    apiKeyId: "k5",
    scopeType: "global",
    tokenLimit: 100,
    resetInterval: "weekly",
  });

  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: { message: string } };
  assert.match(body.error.message, /already has a weekly global token limit/);
  assert.ok(!body.error.message.includes("at /"));
  assert.equal((await tokenLimits.listTokenLimits("k5")).length, 2);
});

test("route: updating an unknown id returns 404", async () => {
  const res = await postLimit({
    id: "does-not-exist",
    apiKeyId: "k6",
    scopeType: "global",
    tokenLimit: 100,
    resetInterval: "daily",
  });
  assert.equal(res.status, 404);
});
