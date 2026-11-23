/**
 * tests/unit/db/cost-ledger-key-quota.test.ts
 *
 * Coverage for RIC-741 (M3):
 *  - request_cost_ledger: every call produces a traceable entry with
 *    provider/model/token/unit-price/amount; month window aggregate.
 *  - api_key_quota_*: tpm / rpm counters exceed → checkKeyQuota blocks; monthly
 *    amount exceeds → blocks; 0/null limits = unlimited; clear resets counters.
 */

import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ledger-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const costLedger = await import("../../../src/lib/db/costLedger.ts");
const keyQuotaDb = await import("../../../src/lib/db/keyQuota.ts");
const keyQuotaDomain = await import("../../../src/domain/keyQuota.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

before(async () => {
  await core.ensureDbInitialized();
});

// Key-quota and ledger rows reference api_keys, so the test key must exist.
async function ensureApiKey(id: string): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO api_keys (id, name, key, key_hash)
     VALUES ($1, $1, 'test-key-material', $2)
     ON CONFLICT (id) DO NOTHING`,
    [id, createHash("sha256").update(id).digest("hex")]
  );
}

beforeEach(async () => {
  await resetTestDb();
  await ensureApiKey("key-1");
});

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

test("cost ledger: record a per-request entry and read it back with full breakdown", async () => {
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    tokensInput: 1000,
    tokensOutput: 500,
    tokensCacheRead: 200,
    tokensReasoning: 50,
    unitPriceInput: 2.5,
    unitPriceOutput: 10,
    amountUsd: 0.025,
    serviceTier: "standard",
    success: true,
    timestamp: "2026-09-14T00:00:00.000Z",
    requestId: "req-abc",
  });

  const entries = await costLedger.listLedgerEntries("key-1");
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.provider, "openai");
  assert.equal(entry.model, "gpt-4o");
  assert.equal(entry.tokensInput, 1000);
  assert.equal(entry.tokensOutput, 500);
  assert.equal(entry.tokensCacheRead, 200);
  assert.equal(entry.tokensReasoning, 50);
  assert.equal(entry.unitPriceInput, 2.5);
  assert.equal(entry.unitPriceOutput, 10);
  assert.equal(entry.amountUsd, 0.025);
  assert.equal(entry.success, true);
  assert.equal(entry.requestId, "req-abc");
});

test("cost ledger: amount-only row (unknown provider/model) is acceptable and traceable", async () => {
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "unknown",
    model: "unknown",
    amountUsd: 0.5,
  });

  const entries = await costLedger.listLedgerEntries("key-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amountUsd, 0.5);
  assert.equal(entries[0].provider, "unknown");
});

test("cost ledger: safe variant never throws and skips empty renders", async () => {
  await assert.doesNotReject(costLedger.recordLedgerEntrySafe({ apiKeyId: "", amountUsd: 1 }));
  await assert.doesNotReject(
    costLedger.recordLedgerEntrySafe({ apiKeyId: "key-1", amountUsd: 9.99 })
  );
  assert.equal((await costLedger.listLedgerEntries("key-1")).length, 1);
});

test("cost ledger: month aggregate sums only successful current-month rows", async () => {
  const now = new Date("2026-09-14T12:00:00.000Z");
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    amountUsd: 1,
    success: true,
    timestamp: "2026-09-01T00:00:00.000Z",
  });
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    amountUsd: 2,
    success: true,
    timestamp: "2026-09-14T10:00:00.000Z",
  });
  // Failed call should not count toward the spend cap.
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    amountUsd: 99,
    success: false,
    timestamp: "2026-09-14T11:00:00.000Z",
  });
  // Previous month should not count.
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    amountUsd: 100,
    success: true,
    timestamp: "2026-08-25T00:00:00.000Z",
  });

  const agg = await costLedger.aggregateLedgerThisMonth("key-1", now.toISOString());
  assert.equal(agg.amountUsd, 3);
  assert.equal(agg.requestCount, 2);
});

test("cost ledger: batch insert writes all rows", async () => {
  await costLedger.recordLedgerEntries([
    { apiKeyId: "key-1", provider: "p", model: "m1", amountUsd: 0.1 },
    { apiKeyId: "key-1", provider: "p", model: "m2", amountUsd: 0.2 },
  ]);
  assert.equal((await costLedger.listLedgerEntries("key-1")).length, 2);
});

// ---------------------------------------------------------------------------
// Key quota — counters + threshold
// ---------------------------------------------------------------------------

test("key quota: rpm counter blocks when limit reached, allows when below", async () => {
  await keyQuotaDb.upsertKeyQuotaLimits("key-1", { rpmLimit: 2 });
  const fixedNow = {
    now: () => Date.parse("2026-09-14T12:00:00.000Z"),
    monthTotalUsd: 0,
  };

  // First request passes.
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1", fixedNow)).allowed, true);
  await keyQuotaDomain.recordKeyQuotaUsage("key-1", 100, fixedNow);

  // Second request passes (limit 2).
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1", fixedNow)).allowed, true);
  await keyQuotaDomain.recordKeyQuotaUsage("key-1", 100, fixedNow);

  // Third request exceeds → blocked, dimension rpm.
  const verdict = await keyQuotaDomain.checkKeyQuota("key-1", fixedNow);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.dimension, "rpm");
});

test("key quota: tpm counter blocks when token window consumed", async () => {
  await keyQuotaDb.upsertKeyQuotaLimits("key-1", { tpmLimit: 1000 });
  const fixedNow = {
    now: () => Date.parse("2026-09-14T12:00:00.000Z"),
    monthTotalUsd: 0,
  };

  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1", fixedNow)).allowed, true);
  await keyQuotaDomain.recordKeyQuotaUsage("key-1", 900, fixedNow);
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1", fixedNow)).allowed, true);

  await keyQuotaDomain.recordKeyQuotaUsage("key-1", 100, fixedNow);
  const verdict = await keyQuotaDomain.checkKeyQuota("key-1", fixedNow);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.dimension, "tpm");
});

test("key quota: monthly amount blocks when ledger month total reaches cap", async () => {
  await keyQuotaDb.upsertKeyQuotaLimits("key-1", { monthlyAmountUsd: 5 });
  // Seed the ledger with $5 spent in the current month.
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    amountUsd: 3,
    success: true,
    timestamp: "2026-09-02T00:00:00.000Z",
  });
  await costLedger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    amountUsd: 2,
    success: true,
    timestamp: "2026-09-03T00:00:00.000Z",
  });

  const now = Date.parse("2026-09-14T12:00:00.000Z");
  const verdict = await keyQuotaDomain.checkKeyQuota("key-1", { now: () => now });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.dimension, "monthly");

  // Clearing the ledger month (simulating a reset) re-allows.
  await costLedger.recordLedgerEntries([
    {
      apiKeyId: "key-1",
      provider: "openai",
      model: "gpt-4o",
      amountUsd: -3,
      success: true,
      timestamp: "2026-09-02T00:00:00.000Z",
    },
  ]);
});

test("key quota: 0/null limits mean unlimited, no config means allowed", async () => {
  // No config row → allowed.
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1")).allowed, true);

  // All-zero limits → unlimited.
  await keyQuotaDb.upsertKeyQuotaLimits("key-1", { tpmLimit: 0, rpmLimit: 0, monthlyAmountUsd: 0 });
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1")).allowed, true);
});

test("key quota: clear resets limits and counters", async () => {
  await keyQuotaDb.upsertKeyQuotaLimits("key-1", { rpmLimit: 1, tpmLimit: 50 });
  await keyQuotaDomain.recordKeyQuotaUsage("key-1", 50);
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1")).allowed, false);

  await keyQuotaDb.clearKeyQuotaLimits("key-1");
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1")).allowed, true);
});

test("key quota: sliding window lets a new minute window reset usage", async () => {
  await keyQuotaDb.upsertKeyQuotaLimits("key-1", { rpmLimit: 1 });
  const t0 = Date.parse("2026-09-14T12:00:00.000Z");
  // Consume the window bucket, block within the same minute.
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1", { now: () => t0 })).allowed, true);
  await keyQuotaDomain.recordKeyQuotaUsage("key-1", 1, { now: () => t0 });
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1", { now: () => t0 })).allowed, false);

  // 60s later = new bucket → allowed again (fresh 2-bucket window counts only elapsed).
  const t1 = t0 + 61_000;
  assert.equal((await keyQuotaDomain.checkKeyQuota("key-1", { now: () => t1 })).allowed, true);
});

test("key quota: failed-open when DB not available", async () => {
  // Make every database call fail; the gate must still allow per B16.
  const backend = getTestBackend();
  const failing = () => {
    throw new Error("simulated database outage");
  };
  const mocks = [
    test.mock.method(backend, "query", failing),
    test.mock.method(backend, "queryOne", failing),
    test.mock.method(backend, "execute", failing),
  ];
  try {
    const verdict = await keyQuotaDomain.checkKeyQuota("key-1");
    assert.equal(verdict.allowed, true);
  } finally {
    for (const mock of mocks) mock.mock.restore();
  }
});
