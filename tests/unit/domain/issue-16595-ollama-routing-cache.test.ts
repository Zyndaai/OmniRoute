import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-ollama-routing-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const cache = await import("../../../src/domain/quotaCache.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const snapshotsDb = await import("../../../src/lib/db/quotaSnapshots.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

test.beforeEach(async () => {
  await resetTestDb();
  cache.__clearForTests();
});

test.after(async () => {
  cache.stopBackgroundRefresh();
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const quotas = (remaining: unknown, verified = true, currency = "USD") => ({
  monthly: { remainingPercentage: 0, ollamaApiBalance: true },
  credits: { remaining, currency, ollamaApiBalance: verified },
});

/** quota_snapshots.connection_id is a foreign key: the snapshot needs a real connection row. */
async function connection(provider: string): Promise<string> {
  return (await providersDb.createProviderConnection({ provider, apiKey: "k", isActive: true }))
    .id;
}

/**
 * setQuotaCache persists fire-and-forget. Wait until the stored rows of a connection exist and
 * stop changing, so a following simulated restart reads what the cache last wrote.
 */
async function persisted(connectionId: string): Promise<void> {
  let previous = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = await snapshotsDb.getLatestQuotaSnapshotsForConnection(connectionId);
    const current = JSON.stringify(rows);
    if (rows.length > 0 && current === previous) return;
    previous = current;
  }
  throw new Error(`quota snapshots for ${connectionId} never settled`);
}

/** A process restart: empty in-memory cache, then the boot hydration step. */
async function restart(): Promise<void> {
  cache.__clearForTests();
  await cache.ensureQuotaCacheHydrated();
}

test("paid Ollama credits keep account headroom unknown across restart and transitions", async () => {
  const paid = await connection("ollama-cloud");
  cache.setQuotaCache(paid, "ollama-cloud", quotas(5));
  await persisted(paid);
  for (const doRestart of [false, true]) {
    if (doRestart) await restart();
    assert.equal(cache.isQuotaExhaustedForRequest(paid, "ollama-cloud"), false);
    assert.equal(cache.getQuotaWeightedRemainingPercent(paid), null);
    assert.equal(cache.getQuotaWindowStatus(paid, "monthly")?.reachedThreshold, false);
  }
  cache.setQuotaCache(paid, "ollama-cloud", quotas(0));
  await persisted(paid);
  await restart();
  assert.equal(cache.isQuotaExhaustedForRequest(paid, "ollama-cloud"), true);
  cache.setQuotaCache(paid, "ollama-cloud", quotas(5));
  await persisted(paid);
  await restart();
  assert.equal(cache.isQuotaExhaustedForRequest(paid, "ollama-cloud"), false);
});

test("zero, malformed, unverified and other-provider credits never bypass an included cap", async () => {
  for (const [provider, amount, verified] of [
    ["ollama-cloud", 0, true],
    ["ollama-cloud", -1, true],
    ["ollama-cloud", "5", true],
    ["ollama-cloud", NaN, true],
    ["ollama-cloud", Infinity, true],
    ["ollama-cloud", null, true],
    ["ollama-cloud", 5, false],
    ["openai", 5, true],
  ] as const) {
    const id = await connection(String(provider));
    cache.setQuotaCache(id, String(provider), quotas(amount, verified === true));
    assert.equal(cache.isAccountQuotaExhausted(id), true);
    await persisted(id);
    await restart();
    assert.equal(cache.isAccountQuotaExhausted(id), true);
  }
});

test("a real upstream 429 remains authoritative over paid balance telemetry", () => {
  cache.markAccountExhaustedFrom429("real-429", "ollama-cloud");
  const fetchedAt = cache.getQuotaCache("real-429")?.fetchedAt;
  cache.setQuotaCache("real-429", "ollama-cloud", quotas(5));
  assert.equal(cache.isQuotaExhaustedForRequest("real-429", "ollama-cloud"), true);
  assert.equal(cache.getQuotaCache("real-429")?.fetchedAt, fetchedAt);
});

test("unknown currency cannot turn purchased telemetry into routing permission", async () => {
  const id = await connection("ollama-cloud");
  cache.setQuotaCache(id, "ollama-cloud", quotas(5, true, "EUR"));
  assert.equal(cache.isQuotaExhaustedForRequest(id, "ollama-cloud"), true);
  await persisted(id);
  await restart();
  assert.equal(cache.isQuotaExhaustedForRequest(id, "ollama-cloud"), true);
});
