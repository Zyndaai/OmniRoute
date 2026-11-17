import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PR #5015 — hydrate the in-memory quota cache from persisted snapshots.
 *
 * After a restart the in-memory quota cache is empty, so a connection that was
 * known-exhausted before the restart looked healthy again until it was queried
 * organically and re-fetched. `isAccountQuotaExhausted` now lazily hydrates the
 * cache from `quota_snapshots` on the first miss, so persisted exhaustion is
 * honoured immediately.
 *
 * Regression guard: without the hydration path, a fresh cache returns `false`
 * (no entry) even though a persisted exhausted snapshot exists — this test
 * would fail on the pre-#5015 tip.
 */
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-hydrate-5015-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetTestDb } = await import("../helpers/postgres.ts");
const quotaSnapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const providersDb = await import("../../src/lib/db/providers.ts");

test.after(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#5015 isAccountQuotaExhausted hydrates exhausted state from a persisted snapshot", async () => {
  // quota_snapshots.connection_id is a foreign key: the snapshot needs a real connection row.
  const connectionId = (
    await providersDb.createProviderConnection({
      provider: "openai",
      apiKey: "test-key",
      isActive: true,
    })
  ).id;
  // Persist an exhausted snapshot with no reset time (so it does not auto-advance)
  // and a fresh created_at (so it does not expire via EXHAUSTED_TTL).
  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: connectionId,
    window_key: "weekly",
    remaining_percentage: 0,
    is_exhausted: 1,
    next_reset_at: null,
    window_duration_ms: null,
    raw_data: JSON.stringify({ source: "test" }),
  });

  // Simulate a fresh boot: an empty in-memory cache, then the boot hydration step
  // (src/instrumentation-node.ts). The sync getter must then report the persisted exhaustion.
  quotaCache.__clearForTests();
  await quotaCache.ensureQuotaCacheHydrated();
  assert.equal(
    quotaCache.isAccountQuotaExhausted(connectionId),
    true,
    "exhausted state persisted in quota_snapshots must hydrate the empty cache"
  );
});

test("#5015 a connection with no snapshot is not reported exhausted", () => {
  assert.equal(
    quotaCache.isAccountQuotaExhausted("conn-unknown-5015"),
    false,
    "no snapshot → no hydration → not exhausted"
  );
});

test("mixed persisted Z.AI quota windows keep chat requests eligible", async () => {
  const connectionId = (
    await providersDb.createProviderConnection({ provider: "zai", apiKey: "test-key", isActive: true })
  ).id;

  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "zai",
    connection_id: connectionId,
    window_key: "session",
    remaining_percentage: 93,
    is_exhausted: 0,
    next_reset_at: "2099-01-01T00:00:00.000Z",
    window_duration_ms: null,
    raw_data: null,
  });
  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "zai",
    connection_id: connectionId,
    window_key: "mcp_monthly",
    remaining_percentage: 0,
    is_exhausted: 1,
    next_reset_at: "2099-02-01T00:00:00.000Z",
    window_duration_ms: null,
    raw_data: null,
  });
  quotaCache.__clearForTests();
  await quotaCache.ensureQuotaCacheHydrated();

  assert.equal(
    quotaCache.isQuotaExhaustedForRequest(connectionId, "zai", "glm-5.2"),
    false,
    "an exhausted tools window must not block chat while the session window has quota"
  );
});
