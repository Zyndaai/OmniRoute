import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-unknown-quota-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const cache = await import("../../../src/domain/quotaCache.ts");
const snapshots = await import("../../../src/lib/db/quotaSnapshots.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

test.after(async () => {
  cache.stopBackgroundRefresh();
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await resetTestDb();
  cache.__clearForTests();
});

/** quota_snapshots references provider_connections; seed the connection so its rows persist. */
async function seedConnection(connectionId: string, provider: string) {
  await getTestBackend().execute(
    "INSERT INTO provider_connections (id, provider) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [connectionId, provider]
  );
}

/**
 * setQuotaCache persists snapshots fire-and-forget. Before a simulated restart, wait until the
 * stored rows satisfy `ready`; without a predicate, wait until the rows stop changing.
 * Gives up after a deadline and lets the caller's assertions report the state it found.
 */
async function waitForPersistence(
  connectionId: string,
  ready?: (rows: Array<Record<string, unknown>>) => boolean
) {
  const deadline = Date.now() + 5000;
  let previous: string | null = null;
  for (;;) {
    const rows = (await snapshots.getLatestQuotaSnapshotsForConnection(
      connectionId
    )) as unknown as Array<Record<string, unknown>>;
    const signature = JSON.stringify(
      rows.map((r) => [r.windowKey, r.isExhausted, r.rawData, r.createdAt])
    );
    const settled = ready ? ready(rows) : previous !== null && signature === previous;
    if (settled || Date.now() > deadline) return;
    previous = signature;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Simulates a process restart: wait for the stored state, drop the cache, reload it from storage. */
async function restartFromSnapshots(
  connectionId: string,
  ready?: (rows: Array<Record<string, unknown>>) => boolean
) {
  await waitForPersistence(connectionId, ready);
  cache.__clearForTests();
  return cache.hydrateQuotaCacheFromSnapshots(connectionId);
}

const hasWindow = (window: string) => (rows: Array<Record<string, unknown>>) =>
  rows.some((r) => r.windowKey === window);

test("Vertex spend telemetry cannot exhaust an account, including after restart", async () => {
  await seedConnection("vertex-spend", "vertex");
  cache.setQuotaCache("vertex-spend", "vertex", {
    spend: {
      used: 0.326845,
      displayName: "Spend (USD)",
      quotaSource: "localUsageHistory",
      resetAt: null,
      unlimited: false,
    },
  });
  assert.equal(cache.isQuotaExhaustedForRequest("vertex-spend", "vertex"), false);
  assert.equal(cache.getQuotaWindowStatus("vertex-spend", "spend")?.reachedThreshold, false);
  await restartFromSnapshots("vertex-spend", hasWindow("spend"));
  assert.equal(cache.isAccountQuotaExhausted("vertex-spend"), false);
  assert.equal(cache.getQuotaWindowStatus("vertex-spend", "spend")?.reachedThreshold, false);
});

test("unknown and unlimited windows remain non-blocking after snapshot hydration", async () => {
  for (const [index, quota] of [
    { used: 12 },
    { total: 0, used: 0 },
    { remainingPercentage: NaN },
    { remainingPercentage: 0, fractionReported: false },
    { remainingPercentage: 0, unlimited: true },
  ].entries()) {
    const id = `unknown-${index}`;
    await seedConnection(id, "openai");
    cache.setQuotaCache(id, "openai", { daily: quota });
    assert.equal(cache.isAccountQuotaExhausted(id), false);
    assert.equal(cache.getQuotaWindowStatus(id, "daily")?.reachedThreshold, false);
    await restartFromSnapshots(id);
    assert.equal(cache.isAccountQuotaExhausted(id), false);
    assert.equal(cache.getQuotaWindowStatus(id, "daily")?.reachedThreshold, false);
  }
});

test("informational windows do not mask a genuinely exhausted quota", async () => {
  await seedConnection("mixed", "vertex");
  cache.setQuotaCache("mixed", "vertex", {
    spend: { used: 1 },
    daily: { total: 100, used: 100 },
  });
  assert.equal(cache.isAccountQuotaExhausted("mixed"), true);
  assert.equal(cache.getQuotaWindowStatus("mixed", "daily")?.reachedThreshold, true);
  const hydrated = await restartFromSnapshots("mixed", hasWindow("daily"));
  assert.ok(hydrated, "the stored snapshots must hydrate an entry after restart");
  assert.equal(cache.isAccountQuotaExhausted("mixed"), true);
});

test("known percentages, bounded usage and explicit 429 exhaustion remain enforced", async () => {
  await seedConnection("known", "openai");
  await seedConnection("bounded", "openai");
  await seedConnection("real-429", "vertex");
  cache.setQuotaCache("known", "openai", { daily: { remainingPercentage: 0 } });
  assert.equal(cache.isAccountQuotaExhausted("known"), true);
  cache.setQuotaCache("bounded", "openai", { daily: { total: 100, used: 25 } });
  assert.equal(cache.getQuotaWindowStatus("bounded", "daily")?.remainingPercentage, 75);
  assert.equal(cache.isAccountQuotaExhausted("bounded"), false);
  cache.markAccountExhaustedFrom429("real-429", "vertex");
  assert.equal(cache.isQuotaExhaustedForRequest("real-429", "vertex"), true);
  const fetchedAt = cache.getQuotaCache("real-429")?.fetchedAt;
  cache.setQuotaCache("real-429", "vertex", { spend: { used: 1 } });
  assert.equal(cache.isQuotaExhaustedForRequest("real-429", "vertex"), true);
  assert.equal(cache.getQuotaCache("real-429")?.fetchedAt, fetchedAt);
  cache.setQuotaCache("real-429", "vertex", { daily: { remainingPercentage: 100 } });
  assert.equal(cache.isQuotaExhaustedForRequest("real-429", "vertex"), false);
});

test("legacy Vertex spend-only snapshots never restore a false lockout", async () => {
  for (const provider of ["vertex", "vertex-partner"]) {
    const connectionId = `legacy-${provider}`;
    await seedConnection(connectionId, provider);
    await snapshots.saveQuotaSnapshot({
      provider,
      connection_id: connectionId,
      window_key: "spend",
      remaining_percentage: 0,
      is_exhausted: 1,
      next_reset_at: null,
      window_duration_ms: null,
      raw_data: null,
    });
    cache.__clearForTests();
    const hydrated = await cache.hydrateQuotaCacheFromSnapshots(connectionId);
    assert.ok(hydrated, "the stored legacy snapshot must hydrate an entry");
    assert.equal(cache.isQuotaExhaustedForRequest(connectionId, provider), false);
    assert.equal(cache.getQuotaWindowStatus(connectionId, "spend")?.reachedThreshold, false);
  }
});

test("unknown-to-known zero transitions persist without losing exhaustion on restart", async () => {
  await seedConnection("transition", "openai");
  cache.setQuotaCache("transition", "openai", { daily: { used: 0 } });
  cache.setQuotaCache("transition", "openai", { daily: { remainingPercentage: 0 } });
  await restartFromSnapshots("transition", (rows) =>
    rows.some((r) => r.windowKey === "daily" && r.isExhausted === 1)
  );
  assert.equal(cache.isAccountQuotaExhausted("transition"), true);
  cache.setQuotaCache("transition", "openai", { daily: { fractionReported: false } });
  await restartFromSnapshots("transition", (rows) =>
    rows.some((r) => r.windowKey === "daily" && r.rawData != null)
  );
  assert.equal(cache.isAccountQuotaExhausted("transition"), false);
});
