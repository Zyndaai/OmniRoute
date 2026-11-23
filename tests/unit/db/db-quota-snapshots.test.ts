import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const quotaSnapshotsDb = await import("../../../src/lib/db/quotaSnapshots.ts");

// quota_snapshots rows reference provider_connections (foreign key), so the connection ids used
// below are seeded before each test.
const CONNECTION_IDS = ["conn-1", "conn-2", "conn-a", "old-conn"];

test.beforeEach(async () => {
  await resetTestDb();
  const backend = getTestBackend();
  for (const id of CONNECTION_IDS) {
    await backend.execute(
      "INSERT INTO provider_connections (id, provider) VALUES ($1, 'openai') ON CONFLICT (id) DO NOTHING",
      [id]
    );
  }
});

test("quotaSnapshots save and query rows with provider and connection filters", async () => {
  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: "conn-1",
    window_key: "hourly",
    remaining_percentage: 60,
    is_exhausted: 0,
    next_reset_at: "2026-01-01T01:00:00.000Z",
    window_duration_ms: 3600000,
    raw_data: JSON.stringify({ source: "first" }),
  });
  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "anthropic",
    connection_id: "conn-2",
    window_key: "daily",
    remaining_percentage: 30,
    is_exhausted: 1,
    next_reset_at: "2026-01-02T00:00:00.000Z",
    window_duration_ms: 86400000,
    raw_data: JSON.stringify({ source: "second" }),
  });

  const openaiRows = await quotaSnapshotsDb.getQuotaSnapshots({
    provider: "openai",
    connectionId: "conn-1",
    since: "2000-01-01T00:00:00.000Z",
  });

  assert.equal(openaiRows.length, 1);
  assert.equal(openaiRows[0].provider, "openai");
  assert.equal(openaiRows[0].connectionId, "conn-1");
});

test("quotaSnapshots aggregates by provider or connection and rejects invalid buckets", async () => {
  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: "conn-a",
    window_key: "hourly",
    remaining_percentage: 50,
    is_exhausted: 0,
    next_reset_at: "2026-01-01T01:00:00.000Z",
    window_duration_ms: 3600000,
    raw_data: "{}",
  });
  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: "conn-a",
    window_key: "hourly",
    remaining_percentage: 70,
    is_exhausted: 0,
    next_reset_at: "2026-01-01T01:10:00.000Z",
    window_duration_ms: 3600000,
    raw_data: "{}",
  });

  const providerAgg = await quotaSnapshotsDb.getAggregatedSnapshots({
    provider: "openai",
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
  });
  const connectionAgg = await quotaSnapshotsDb.getAggregatedSnapshots({
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
    aggregateBy: "connection",
  });

  assert.equal(providerAgg.length, 1);
  assert.equal(providerAgg[0].remainingPct, 60);
  assert.equal(connectionAgg[0].provider, "openai:conn-a");

  await assert.rejects(
    () =>
      quotaSnapshotsDb.getAggregatedSnapshots({
        since: "2000-01-01T00:00:00.000Z",
        bucketMinutes: 0,
      }),
    /Invalid bucket size/
  );
});

test("quotaSnapshots cleanup removes old rows and throttles repeated execution", async () => {
  await getTestBackend().execute(
    `INSERT INTO quota_snapshots
     (provider, connection_id, window_key, remaining_percentage, is_exhausted, next_reset_at, window_duration_ms, raw_data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      "openai",
      "old-conn",
      "hourly",
      20,
      true,
      "2000-01-01T01:00:00.000Z",
      3600000,
      "{}",
      "2000-01-01T00:00:00.000Z",
    ]
  );

  const deleted = await quotaSnapshotsDb.cleanupOldSnapshots(1);
  const throttled = await quotaSnapshotsDb.cleanupOldSnapshots(1);

  assert.equal(deleted, 1);
  assert.equal(throttled, 0);
});

test("quotaSnapshots aggregation returns one row per bucket with the tightest window", async () => {
  const backend = getTestBackend();
  const row = (
    windowKey: string,
    remaining: number,
    exhausted: boolean,
    createdAt: string
  ) =>
    backend.execute(
      `INSERT INTO quota_snapshots
       (provider, connection_id, window_key, remaining_percentage, is_exhausted, next_reset_at, window_duration_ms, raw_data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      ["claude", "conn-1", windowKey, remaining, exhausted, null, null, "{}", createdAt]
    );

  // 10:00 bucket: the 5h session is almost full but the weekly window is exhausted.
  await row("session (5h)", 97, false, "2026-01-01T10:05:00.000Z");
  await row("weekly (7d)", 20, false, "2026-01-01T10:10:00.000Z");
  await row("weekly (7d)", 0, true, "2026-01-01T10:40:00.000Z");
  // 11:00 bucket: both windows have headroom, the weekly one is still the tightest.
  await row("session (5h)", 90, false, "2026-01-01T11:05:00.000Z");
  await row("weekly (7d)", 40, false, "2026-01-01T11:10:00.000Z");

  const byProvider = await quotaSnapshotsDb.getAggregatedSnapshots({
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
  });

  assert.equal(byProvider.length, 2, "one row per bucket, not one per quota window");
  assert.deepEqual(
    byProvider.map((point) => point.timestamp),
    ["2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z"]
  );
  // Window samples are still averaged inside a bucket (weekly: (20 + 0) / 2 = 10), then the tightest wins.
  assert.equal(byProvider[0].remainingPct, 10);
  assert.equal(byProvider[0].isExhausted, true);
  assert.equal(byProvider[0].windowKey, "weekly (7d)");
  assert.equal(byProvider[1].remainingPct, 40);
  assert.equal(byProvider[1].isExhausted, false);
  assert.equal(byProvider[1].windowKey, "weekly (7d)");

  const byConnection = await quotaSnapshotsDb.getAggregatedSnapshots({
    since: "2000-01-01T00:00:00.000Z",
    bucketMinutes: 60,
    aggregateBy: "connection",
  });
  assert.equal(byConnection.length, 2);
  assert.equal(byConnection[0].provider, "claude:conn-1");
  assert.equal(byConnection[0].remainingPct, 10);
});
