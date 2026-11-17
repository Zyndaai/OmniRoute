import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-hotpath-"));
process.env.DATA_DIR = dataDir;

const core = await import("../../src/lib/db/core.ts");
const { db } = await import("../../src/lib/db/pg.ts");
const { invalidateApiKeyPolicyCache } = await import("../../src/lib/db/readCache.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const quotaDb = await import("../../src/lib/db/keyQuota.ts");
const quotaDomain = await import("../../src/domain/keyQuota.ts");
const ledger = await import("../../src/lib/db/costLedger.ts");

const nowMs = Date.parse("2026-09-14T12:00:30.000Z");
const clock = { now: () => nowMs };

// Quota limits rows reference api_keys (FK), so the keys the tests use must exist.
async function seedApiKey(id: string) {
  await db().execute(
    "INSERT INTO api_keys (id, name, key, key_hash, machine_id) VALUES ($1, $2, $3, $4, $5)",
    [id, id, `raw-${id}`, createHash("sha256").update(id).digest("hex"), "machine-quota-test"]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
  await seedApiKey("key-1");
  await seedApiKey("key-2");
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function seedUsage() {
  await quotaDomain.recordKeyQuotaUsage("key-1", 900, clock);
  await quotaDomain.recordKeyQuotaUsage("key-1", 100, clock);
  await ledger.recordLedgerEntry({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-4o",
    amountUsd: 5,
    success: true,
    timestamp: "2026-09-14T12:00:00.000Z",
  });
}

// Records every SQL statement the read issues against the database backend.
// The policy cache is cleared first so each trace shows the cold read path.
async function traceReads<T>(read: () => Promise<T>) {
  invalidateApiKeyPolicyCache();
  const backend = db();
  const spies = [
    test.mock.method(backend, "query"),
    test.mock.method(backend, "queryOne"),
  ];
  try {
    const result = await read();
    const sql = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call.arguments[0])));
    return { result, sql };
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
}

// `markerReads`: a capped month that is not already blocked also looks up whether
// unpriced usage closed it (one read of unpriced_usage_since on the limits row).
function assertReads(sql: string[], counterReads: number, ledgerReads: number, markerReads = 0) {
  const markerQueries = sql.filter(
    (query) => query.includes("FROM api_key_quota_limits") && query.includes("unpriced_usage_since")
  );
  const limitQueries = sql.filter(
    (query) => query.includes("FROM api_key_quota_limits") && !query.includes("unpriced_usage_since")
  );
  assert.equal(limitQueries.length, 1);
  assert.equal(sql.filter((query) => query.includes("FROM quota_counters")).length, counterReads);
  assert.equal(
    sql.filter((query) => query.includes("FROM request_cost_ledger")).length,
    ledgerReads
  );
  assert.equal(markerQueries.length, markerReads);
  assert.equal(sql.length, 1 + counterReads + ledgerReads + markerReads);
}

for (const config of [undefined, null, 0, -1]) {
  test(`unlimited quota (${config}): reads limits only despite recorded usage`, async () => {
    await seedUsage();
    if (config !== undefined) {
      await quotaDb.upsertKeyQuotaLimits("key-1", {
        tpmLimit: config,
        rpmLimit: config,
        monthlyAmountUsd: config,
      });
    }
    const { result, sql } = await traceReads(() => quotaDomain.checkKeyQuota("key-1", clock));
    assert.equal(result.allowed, true);
    assert.equal(result.status?.enabled, false);
    assertReads(sql, 0, 0);
  });
}

for (const dimension of ["tpm", "rpm", "monthly"] as const) {
  test(`${dimension}-only quota: reads and enforces only the configured dimension`, async () => {
    await seedUsage();
    await quotaDb.upsertKeyQuotaLimits("key-1", {
      ...(dimension === "tpm" ? { tpmLimit: 1000 } : {}),
      ...(dimension === "rpm" ? { rpmLimit: 2 } : {}),
      ...(dimension === "monthly" ? { monthlyAmountUsd: 5 } : {}),
    });
    const { result, sql } = await traceReads(() => quotaDomain.checkKeyQuota("key-1", clock));
    assert.equal(result.allowed, false);
    assert.equal(result.dimension, dimension);
    assertReads(sql, dimension === "monthly" ? 0 : 1, dimension === "monthly" ? 1 : 0);
  });
}

test("minute quotas: skip the ledger and preserve sliding-window weighting", async () => {
  await quotaDb.upsertKeyQuotaLimits("key-1", { tpmLimit: 750, rpmLimit: 1.5 });
  await quotaDomain.recordKeyQuotaUsage("key-1", 1000, { now: () => nowMs - 60_000 });
  await quotaDomain.recordKeyQuotaUsage("key-1", 250, clock);
  const { result, sql } = await traceReads(() => quotaDomain.checkKeyQuota("key-1", clock));
  assert.equal(result.status?.counters.tpmUsed, 750);
  assert.equal(result.status?.counters.rpmUsed, 1.5);
  assert.equal(result.dimension, "tpm");
  assertReads(sql, 2, 0);
});

test("combined quotas: retain threshold precedence and enforce newly configured limits", async () => {
  await seedUsage();
  await quotaDb.upsertKeyQuotaLimits("key-1", {
    tpmLimit: 1000,
    rpmLimit: 2,
    monthlyAmountUsd: 5,
  });
  const { result, sql } = await traceReads(() => quotaDomain.checkKeyQuota("key-1", clock));
  assert.equal(result.dimension, "tpm");
  assert.equal(result.status?.monthlyExceeded, true);
  assertReads(sql, 2, 1);

  await quotaDb.upsertKeyQuotaLimits("key-1", { tpmLimit: null });
  assert.equal((await quotaDomain.checkKeyQuota("key-1", clock)).dimension, "rpm");
  await quotaDb.upsertKeyQuotaLimits("key-1", { rpmLimit: null });
  assert.equal((await quotaDomain.checkKeyQuota("key-1", clock)).dimension, "monthly");
  await quotaDb.upsertKeyQuotaLimits("key-1", { monthlyAmountUsd: 6 });
  assert.equal((await quotaDomain.checkKeyQuota("key-1", clock)).allowed, true);
  await quotaDb.clearKeyQuotaLimits("key-1");
  const cleared = await traceReads(() => quotaDomain.checkKeyQuota("key-1", clock));
  assert.equal(cleared.result.allowed, true);
  assertReads(cleared.sql, 0, 0);
});

test("monthly quota: an injected zero total skips the ledger but is still enforced", async () => {
  await seedUsage();
  await quotaDb.upsertKeyQuotaLimits("key-1", { monthlyAmountUsd: 5 });
  const allowed = await traceReads(() =>
    quotaDomain.checkKeyQuota("key-1", { ...clock, monthTotalUsd: 0 })
  );
  assert.equal(allowed.result.allowed, true);
  assertReads(allowed.sql, 0, 0, 1);
  const blocked = await traceReads(() =>
    quotaDomain.checkKeyQuota("key-1", { ...clock, monthTotalUsd: 5 })
  );
  assert.equal(blocked.result.dimension, "monthly");
  assertReads(blocked.sql, 0, 0);
});

test("dashboard status: reports every recorded counter for an unlimited key", async () => {
  await seedUsage();
  const { result, sql } = await traceReads(() => quotaDb.getKeyQuotaStatus("key-1", clock));
  assert.equal(result.enabled, false);
  assert.deepEqual(result.counters, { tpmUsed: 1000, rpmUsed: 2, monthlyAmountUsd: 5 });
  assertReads(sql, 2, 1);
  assert.equal((await ledger.listLedgerEntries("key-1")).length, 1);
});

test("dashboard status: reports unrestricted usage even with only an RPM limit", async () => {
  await seedUsage();
  await quotaDb.upsertKeyQuotaLimits("key-1", { rpmLimit: 3 });
  const status = await quotaDb.getKeyQuotaStatus("key-1", clock);
  assert.deepEqual(status.counters, { tpmUsed: 1000, rpmUsed: 2, monthlyAmountUsd: 5 });
  assert.equal(status.rpmExceeded, false);
});

test("quota status: uses one clock sample for counters and window reset", async () => {
  await seedUsage();
  await quotaDb.upsertKeyQuotaLimits("key-1", { rpmLimit: 2 });
  let clockReads = 0;
  const result = await quotaDomain.checkKeyQuota("key-1", {
    now: () => {
      clockReads++;
      return nowMs + (clockReads - 1) * 60_000;
    },
  });
  assert.equal(result.dimension, "rpm");
  assert.equal(result.status?.windowResetAtIso, "2026-09-14T12:01:00.000Z");
  assert.equal(clockReads, 1);
});

test("quota status: another key's recorded usage does not consume this key's limits", async () => {
  await seedUsage();
  await quotaDb.upsertKeyQuotaLimits("key-2", { tpmLimit: 1, rpmLimit: 1, monthlyAmountUsd: 1 });
  const { result, sql } = await traceReads(() => quotaDomain.checkKeyQuota("key-2", clock));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.status?.counters, { tpmUsed: 0, rpmUsed: 0, monthlyAmountUsd: 0 });
  assertReads(sql, 2, 1, 1);
});

test("missing API key: performs no database reads", async () => {
  const { result, sql } = await traceReads(() => quotaDomain.checkKeyQuota(null, clock));
  assert.deepEqual(result, { allowed: true, reason: null, dimension: null });
  assert.deepEqual(sql, []);
});

test("quota storage errors: preserve the request gate's fail-open behavior", async () => {
  const backend = db();
  const spies = [
    test.mock.method(backend, "query", () => {
      throw new Error("quota database unavailable");
    }),
    test.mock.method(backend, "queryOne", () => {
      throw new Error("quota database unavailable");
    }),
  ];
  try {
    invalidateApiKeyPolicyCache();
    assert.deepEqual(await quotaDomain.checkKeyQuota("key-1", clock), {
      allowed: true,
      reason: null,
      dimension: null,
    });
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
});
