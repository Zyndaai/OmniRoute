import test from "node:test";
import assert from "node:assert/strict";

const stats = await import("../../../src/lib/db/callLogStats.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb();
});

test("getFallbackStats on empty DB returns zeros, not nulls", async () => {
  const row = await stats.getFallbackStats("", {});
  assert.deepEqual(row, {
    total: 0,
    with_requested: 0,
    fallback_eligible: 0,
    fallbacks: 0,
  });
});

test("error_type NULL splits into pre_migration vs unclassified by timestamp", async () => {
  const backend = getTestBackend();
  const now = new Date().toISOString();
  await backend.execute(
    `INSERT INTO provider_connections (id, provider, created_at, updated_at)
     VALUES ('conn-1', 'openai', $1, $2)`,
    [now, now]
  );
  await backend.execute(
    `INSERT INTO call_logs (id, "timestamp", provider, status, error_type)
     VALUES ('old-1', '2026-08-01T00:00:00.000Z', 'openai', 500, NULL),
            ('new-1', $1, 'openai', 500, NULL)`,
    [now]
  );

  const breakdown = await stats.getErrorTypeBreakdown("", {});
  const byType = new Map(breakdown.map((b) => [b.errorType, b.count]));
  assert.equal(byType.get("pre_migration"), 1);
  assert.equal(byType.get("unclassified"), 1);
});
