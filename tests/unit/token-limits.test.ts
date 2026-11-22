import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limits-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const tokenLimits = await import("../../src/lib/db/tokenLimits.ts");
const counter = await import("../../open-sse/services/tokenLimitCounter.ts");

// recordTokenUsage is fire-and-forget (several DB round trips in the background), so tests
// poll until the write lands instead of guessing a number of event-loop turns.
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    value = await read();
  }
  return value;
}

// Window pivots (UTC).
const NOW_JAN = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_FEB = Date.UTC(2026, 1, 15, 12, 0, 0);
const D1 = Date.UTC(2026, 0, 10, 12);
const D2 = Date.UTC(2026, 0, 11, 12);
const W1 = Date.UTC(2026, 0, 6, 12); // Tue
const W2 = Date.UTC(2026, 0, 13, 12); // next Tue

// Every api key id the tests use: token limits reference api_keys (FK), so seed them.
const KEY_IDS = [
  "k-daily",
  "k-week",
  "k-month",
  "k2",
  "k2b",
  "k2c",
  "k2d",
  "k3",
  "k3b",
  "k4",
  "k5",
  "k6",
  "k7",
  "k8",
];

async function resetStorage() {
  await resetTestDb();

  const backend = getTestBackend();
  for (const id of KEY_IDS) {
    await backend.execute("INSERT INTO api_keys (id, name, key, key_hash) VALUES ($1, $2, $3, $4)", [
      id,
      id,
      "test-secret",
      createHash("sha256").update(id).digest("hex"),
    ]);
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      break;
    } catch (error: any) {
      if ((error?.code === "EBUSY" || error?.code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }

  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function insertUsage(
  apiKeyId: string,
  provider: string,
  model: string,
  tokensInput: number,
  tokensOutput: number,
  ts: string,
  extra: { cacheRead?: number; cacheCreation?: number; reasoning?: number } = {}
) {
  await getTestBackend().execute(
    `INSERT INTO usage_history
       (provider, model, api_key_id, tokens_input, tokens_output,
        tokens_cache_read, tokens_cache_creation, tokens_reasoning, success, "timestamp")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
    [
      provider,
      model,
      apiKeyId,
      tokensInput,
      tokensOutput,
      extra.cacheRead ?? 0,
      extra.cacheCreation ?? 0,
      extra.reasoning ?? 0,
      ts,
    ]
  );
}

test.beforeEach(async () => {
  await resetStorage();
  counter.clearTokenLimitCache();
});

test.after(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("window rollover: daily/weekly/monthly produce distinct windowStart", async () => {
  const daily = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k-daily",
    scopeType: "global",
    tokenLimit: 1000,
    resetInterval: "daily",
  });
  const weekly = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k-week",
    scopeType: "global",
    tokenLimit: 1000,
    resetInterval: "weekly",
  });
  const monthly = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k-month",
    scopeType: "global",
    tokenLimit: 1000,
    resetInterval: "monthly",
  });

  // Distinct windows across a boundary.
  assert.notEqual(
    tokenLimits.resetWindowIfElapsed(daily, D1).windowStart,
    tokenLimits.resetWindowIfElapsed(daily, D2).windowStart
  );
  assert.notEqual(
    tokenLimits.resetWindowIfElapsed(weekly, W1).windowStart,
    tokenLimits.resetWindowIfElapsed(weekly, W2).windowStart
  );
  assert.notEqual(
    tokenLimits.resetWindowIfElapsed(monthly, NOW_JAN).windowStart,
    tokenLimits.resetWindowIfElapsed(monthly, NOW_FEB).windowStart
  );

  // Same window: two distinct `now`s inside the same period give same windowStart.
  const dailySameA = Date.UTC(2026, 0, 10, 1);
  const dailySameB = Date.UTC(2026, 0, 10, 23);
  assert.equal(
    tokenLimits.resetWindowIfElapsed(daily, dailySameA).windowStart,
    tokenLimits.resetWindowIfElapsed(daily, dailySameB).windowStart
  );
  // weekly same window: Mon and Sun of same week.
  const weekMon = Date.UTC(2026, 0, 5, 3); // Monday
  const weekSun = Date.UTC(2026, 0, 11, 20); // Sunday same week
  assert.equal(
    tokenLimits.resetWindowIfElapsed(weekly, weekMon).windowStart,
    tokenLimits.resetWindowIfElapsed(weekly, weekSun).windowStart
  );
  // monthly same window: two days in January.
  assert.equal(
    tokenLimits.resetWindowIfElapsed(monthly, NOW_JAN).windowStart,
    tokenLimits.resetWindowIfElapsed(monthly, Date.UTC(2026, 0, 28, 4)).windowStart
  );
});

test("seed-on-miss equals usage_history SUM for the active window", async () => {
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k2",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 100000,
    resetInterval: "monthly",
  });

  // In-window, same-model rows (counted).
  await insertUsage("k2", "openai", "gpt-4o", 100, 50, new Date(Date.UTC(2026, 0, 12)).toISOString());
  await insertUsage("k2", "openai", "gpt-4o", 30, 20, new Date(Date.UTC(2026, 0, 14)).toISOString());
  // Different month (excluded).
  await insertUsage("k2", "openai", "gpt-4o", 999, 999, new Date(Date.UTC(2025, 11, 31)).toISOString());
  // Different model (excluded).
  await insertUsage(
    "k2",
    "openai",
    "gpt-4o-mini",
    777,
    777,
    new Date(Date.UTC(2026, 0, 13)).toISOString()
  );

  const expected = 100 + 50 + 30 + 20;
  assert.equal(await counter.seedWindowUsageFromHistory(limit, NOW_JAN), expected);
});

test("getCurrentWindowUsage seeds from history and PERSISTS the seed (FIX 3)", async () => {
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k2b",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 100000,
    resetInterval: "monthly",
  });

  await insertUsage("k2b", "openai", "gpt-4o", 200, 100, new Date(Date.UTC(2026, 0, 12)).toISOString());
  const seeded = 300;
  assert.equal(await counter.seedWindowUsageFromHistory(limit, NOW_JAN), seeded);

  // FIX 3: a force-fresh read on a cold window now PERSISTS the seed to the
  // counter row (previously the seed was read-only and DB usage stayed 0).
  assert.equal(await counter.getCurrentWindowUsage(limit, NOW_JAN, true), seeded);
  assert.equal(await tokenLimits.getWindowUsage(limit, NOW_JAN), seeded);

  // A subsequent increment accumulates ON TOP of the persisted seed — the prior
  // historical usage is NOT forgotten.
  const { windowStart } = tokenLimits.resetWindowIfElapsed(limit, NOW_JAN);
  await tokenLimits.incrementWindowTokens(limit.id, windowStart, 25);
  assert.equal(await tokenLimits.getWindowUsage(limit, NOW_JAN), seeded + 25);
  assert.equal(await counter.getCurrentWindowUsage(limit, NOW_JAN, true), seeded + 25);
});

test("seed total excludes cache tokens (no double-count) (FIX 2)", async () => {
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k2c",
    scopeType: "model",
    scopeValue: "claude-sonnet",
    tokenLimit: 100000,
    resetInterval: "monthly",
  });

  // tokens_input ALREADY INCLUDES cache_read + cache_creation (these columns are a
  // breakdown, per migration 012). Billable = input + output + reasoning ONLY.
  await insertUsage(
    "k2c",
    "anthropic",
    "claude-sonnet",
    500,
    200,
    new Date(Date.UTC(2026, 0, 12)).toISOString(),
    {
      cacheRead: 300,
      cacheCreation: 100,
      reasoning: 40,
    }
  );

  // 500 + 200 = 700: reasoning (40) is inside output (200) and is not added again (#19031).
  // Must NOT add cacheRead/cacheCreation again either.
  assert.equal(await counter.seedWindowUsageFromHistory(limit, NOW_JAN), 700);
});

test("cold-window recordTokenUsage seeds from history before increment (FIX 4)", async () => {
  // recordTokenUsage uses Date.now() internally; insert history in the current window.
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k2d",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 1000000,
    resetInterval: "monthly",
  });

  // Prior historical usage in this window, but NO counter row yet (cold window).
  await insertUsage("k2d", "openai", "gpt-4o", 400, 100, new Date().toISOString());
  assert.equal(await tokenLimits.getWindowUsage(limit, Date.now()), 0); // no counter row yet

  // First record on the cold window must seed (500) then add the delta (50) = 550,
  // NOT restart from 0 (which would yield 50).
  counter.recordTokenUsage("k2d", "openai", "gpt-4o", 50);
  const usage = await eventually(
    () => tokenLimits.getWindowUsage(limit, Date.now()),
    (n) => n >= 550
  );

  assert.equal(usage, 550);
});

test("most-restrictive breach wins when model and provider both match", async () => {
  // Case A: both breach; provider has smaller limitValue (tie on remaining=0).
  const modelLimit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k3",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 100,
    resetInterval: "monthly",
  });
  const providerLimit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k3",
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 50,
    resetInterval: "monthly",
  });

  const mWs = tokenLimits.resetWindowIfElapsed(modelLimit, NOW_JAN).windowStart;
  const pWs = tokenLimits.resetWindowIfElapsed(providerLimit, NOW_JAN).windowStart;
  await tokenLimits.incrementWindowTokens(modelLimit.id, mWs, 100); // remaining 0
  await tokenLimits.incrementWindowTokens(providerLimit.id, pWs, 55); // remaining 0, smaller limitValue

  const breachA = await counter.checkTokenLimits("k3", "openai", "gpt-4o", NOW_JAN);
  assert.ok(breachA);
  assert.equal(breachA!.scopeType, "provider");
  assert.equal(breachA!.limitValue, 50);

  // Case B: only the model limit breaches → it is returned.
  const modelLimit2 = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k3b",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 100,
    resetInterval: "monthly",
  });
  const providerLimit2 = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k3b",
    scopeType: "provider",
    scopeValue: "openai",
    tokenLimit: 200,
    resetInterval: "monthly",
  });
  const mWs2 = tokenLimits.resetWindowIfElapsed(modelLimit2, NOW_JAN).windowStart;
  const pWs2 = tokenLimits.resetWindowIfElapsed(providerLimit2, NOW_JAN).windowStart;
  await tokenLimits.incrementWindowTokens(modelLimit2.id, mWs2, 100); // breach (>=100)
  await tokenLimits.incrementWindowTokens(providerLimit2.id, pWs2, 150); // 150 < 200 → no breach

  const breachB = await counter.checkTokenLimits("k3b", "openai", "gpt-4o", NOW_JAN);
  assert.ok(breachB);
  assert.equal(breachB!.scopeType, "model");
  assert.equal(breachB!.limitValue, 100);
});

test("disabled limit is ignored by checkTokenLimits", async () => {
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k4",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 10,
    resetInterval: "monthly",
    enabled: false,
  });
  const ws = tokenLimits.resetWindowIfElapsed(limit, NOW_JAN).windowStart;
  await tokenLimits.incrementWindowTokens(limit.id, ws, 999);
  assert.equal(await counter.checkTokenLimits("k4", "openai", "gpt-4o", NOW_JAN), null);
});

test("global fallback applies when no model/provider limit", async () => {
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k5",
    scopeType: "global",
    tokenLimit: 10,
    resetInterval: "monthly",
  });
  const ws = tokenLimits.resetWindowIfElapsed(limit, NOW_JAN).windowStart;
  await tokenLimits.incrementWindowTokens(limit.id, ws, 20);
  const breach = await counter.checkTokenLimits("k5", "openai", "gpt-4o", NOW_JAN);
  assert.ok(breach);
  assert.equal(breach!.scopeType, "global");
  assert.equal(breach!.limitValue, 10);
});

test("atomic increment under repeated calls has no lost updates", async () => {
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k6",
    scopeType: "global",
    tokenLimit: 1000000,
    resetInterval: "monthly",
  });
  const { windowStart } = tokenLimits.resetWindowIfElapsed(limit, NOW_JAN);
  for (let i = 0; i < 100; i++) {
    await tokenLimits.incrementWindowTokens(limit.id, windowStart, 7);
  }
  assert.equal(await tokenLimits.getWindowUsage(limit, NOW_JAN), 700);
});

test("getCurrentWindowUsage cache hit / miss / forceFresh", async () => {
  const limit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k7",
    scopeType: "global",
    tokenLimit: 1000,
    resetInterval: "monthly",
  });

  // Prime cache via write-through.
  await counter.addWindowTokens(limit, 50, NOW_JAN); // cache + DB = 50
  const { windowStart: ws } = tokenLimits.resetWindowIfElapsed(limit, NOW_JAN);

  // Mutate DB directly behind the cache → DB=80, cache stale at 50.
  await tokenLimits.incrementWindowTokens(limit.id, ws, 30);

  // Cache HIT (within TTL) returns stale 50.
  assert.equal(await counter.getCurrentWindowUsage(limit, NOW_JAN, false), 50);

  // forceFresh returns authoritative 80 and refreshes cache.
  assert.equal(await counter.getCurrentWindowUsage(limit, NOW_JAN, true), 80);

  // Subsequent normal read returns refreshed 80.
  assert.equal(await counter.getCurrentWindowUsage(limit, NOW_JAN, false), 80);
});

test("recordTokenUsage is fire-and-forget and records after microtask flush", async () => {
  // recordTokenUsage uses Date.now() internally — create + read with default now.
  const modelLimit = await tokenLimits.upsertTokenLimit({
    apiKeyId: "k8",
    scopeType: "model",
    scopeValue: "gpt-4o",
    tokenLimit: 100000,
    resetInterval: "monthly",
  });

  // Returns synchronously (void) and does not throw before the microtask runs.
  assert.equal(counter.recordTokenUsage("k8", "openai", "gpt-4o", 42), undefined);

  const recorded = await eventually(
    () => tokenLimits.getWindowUsage(modelLimit, Date.now()),
    (n) => n >= 42
  );
  assert.ok(recorded >= 42);

  // No-op cases: tokens <= 0 and empty apiKey schedule nothing.
  const before = await tokenLimits.getWindowUsage(modelLimit, Date.now());
  counter.recordTokenUsage("k8", "openai", "gpt-4o", 0);
  counter.recordTokenUsage("k8", "openai", "gpt-4o", -5);
  counter.recordTokenUsage("", "openai", "gpt-4o", 99);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await tokenLimits.getWindowUsage(modelLimit, Date.now()), before);
});
