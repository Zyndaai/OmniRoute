import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");

// connection_limits_cache rows are only written while their connection exists (foreign key),
// so every connection id used below is seeded first.
async function seedConnections(ids: string[]) {
  const backend = getTestBackend();
  for (const id of ids) {
    await backend.execute(
      "INSERT INTO provider_connections (id, provider) VALUES ($1, 'test-provider') ON CONFLICT (id) DO NOTHING",
      [id]
    );
  }
}

test.beforeEach(async () => {
  await resetTestDb();
});

test("providerLimits cache returns empty defaults before any writes", async () => {
  assert.equal(await providerLimitsDb.getProviderLimitsCache("conn-1"), null);
  assert.deepEqual(await providerLimitsDb.getAllProviderLimitsCache(), {});
  assert.equal(await providerLimitsDb.setProviderLimitsCacheBatch([]), 0);
});

test("providerLimits cache preserves Codex banked reset credits", async () => {
  await seedConnections(["codex-conn"]);
  const entry = await providerLimitsDb.setProviderLimitsCache("codex-conn", {
    quotas: { session: { remainingPercentage: 90 } },
    plan: null,
    message: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "sync",
    bankedResetCredits: 3,
  });

  assert.equal(entry.bankedResetCredits, 3);
  assert.equal((await providerLimitsDb.getProviderLimitsCache("codex-conn"))?.bankedResetCredits, 3);
  assert.equal(
    (await providerLimitsDb.getAllProviderLimitsCache())["codex-conn"]?.bankedResetCredits,
    3
  );
});

test("providerLimits cache persists Codex paid credits independently of reset credits", async () => {
  await seedConnections(["paid-codex"]);
  const paidCredits = {
    hasCredits: true,
    unlimited: false,
    overageLimitReached: false,
    balance: null,
  };
  await providerLimitsDb.setProviderLimitsCache("paid-codex", {
    quotas: { session: { remainingPercentage: 0 } },
    plan: "business",
    message: null,
    fetchedAt: "2026-09-11T00:00:00.000Z",
    paidCredits,
    bankedResetCredits: 2,
  });
  const cached = await providerLimitsDb.getProviderLimitsCache("paid-codex");
  assert.deepEqual(cached?.paidCredits, paidCredits);
  assert.equal(cached?.bankedResetCredits, 2);
  assert.deepEqual(cached?.quotas, { session: { remainingPercentage: 0 } });
});

test("providerLimits cache supports single writes, batch writes and deletions", async () => {
  await seedConnections(["conn-1", "conn-2", "conn-3"]);
  const first = await providerLimitsDb.setProviderLimitsCache("conn-1", {
    quotas: { remaining: 12 },
    plan: "pro",
    message: "ok",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    source: "sync",
  });

  assert.equal(first.plan, "pro");
  assert.deepEqual(await providerLimitsDb.getProviderLimitsCache("conn-1"), first);

  const inserted = await providerLimitsDb.setProviderLimitsCacheBatch([
    {
      connectionId: "conn-2",
      entry: {
        quotas: { remaining: 10 },
        plan: { tier: "team" },
        message: null,
        fetchedAt: "2026-01-01T01:00:00.000Z",
      },
    },
    {
      connectionId: "conn-3",
      entry: {
        quotas: null,
        plan: null,
        message: "empty",
        fetchedAt: "2026-01-01T02:00:00.000Z",
      },
    },
  ]);

  assert.equal(inserted, 2);
  assert.equal(Object.keys(await providerLimitsDb.getAllProviderLimitsCache()).length, 3);

  await providerLimitsDb.deleteProviderLimitsCache("conn-2");
  assert.equal(await providerLimitsDb.getProviderLimitsCache("conn-2"), null);
});

test("providerLimits cache ignores malformed stored values", async () => {
  await seedConnections(["broken-json", "missing-fetched-at"]);
  const backend = getTestBackend();
  // The column is jsonb, so text that is not valid JSON cannot be stored at all; the
  // malformed cases that can exist are a non-object JSON value and an object without fetchedAt.
  await backend.execute(
    "INSERT INTO connection_limits_cache (connection_id, data) VALUES ($1, $2::jsonb)",
    ["broken-json", JSON.stringify("not-an-object")]
  );
  await backend.execute(
    "INSERT INTO connection_limits_cache (connection_id, data) VALUES ($1, $2::jsonb)",
    ["missing-fetched-at", JSON.stringify({ quotas: { remaining: 5 } })]
  );

  assert.equal(await providerLimitsDb.getProviderLimitsCache("broken-json"), null);
  assert.equal(await providerLimitsDb.getProviderLimitsCache("missing-fetched-at"), null);
  assert.deepEqual(await providerLimitsDb.getAllProviderLimitsCache(), {});
});
