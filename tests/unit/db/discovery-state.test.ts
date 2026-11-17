/**
 * Unit coverage for the per-connection discovery outcome store.
 *
 * The store keeps one entry per connection (the discovery_* columns of
 * connection_model_sync, keyed by connection id), so a repeated discovery replaces the
 * entry instead of piling up rows, and a deleted connection leaves nothing behind.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const discoveryState = await import("../../../src/lib/db/discoveryState.ts");

type StoredRow = { key: string; status: string; cause: string | null; at: string };

/** Connections with a stored discovery outcome, read straight from the table. */
async function storedRows(): Promise<StoredRow[]> {
  const rows = await getTestBackend().query<{
    connection_id: string;
    provider: string;
    discovery_status: string;
    discovery_cause: string | null;
    discovery_at: string;
  }>(
    `SELECT connection_id, provider, discovery_status, discovery_cause, discovery_at
       FROM connection_model_sync
      WHERE discovery_status IS NOT NULL
      ORDER BY connection_id`
  );
  return rows.map((row) => ({
    key: `${row.provider}:${row.connection_id}`,
    status: row.discovery_status,
    cause: row.discovery_cause,
    at: row.discovery_at,
  }));
}

/** The store only keeps outcomes for connections that exist, so seed the connections. */
async function seedConnection(provider: string, id: string): Promise<void> {
  await getTestBackend().execute(
    "INSERT INTO provider_connections (id, provider) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [id, provider]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
  await seedConnection("aimlapi", "conn-1");
  await seedConnection("aimlapi", "conn-2");
  await seedConnection("aimlapi", "conn-broken");
  await seedConnection("poe", "conn-3");
});

test("the outcome is stored under the provider and connection key", async () => {
  await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
    status: "degraded",
    cause: "HTTP 500",
  });

  const rows = await storedRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "aimlapi:conn-1");
  assert.equal(rows[0].status, "degraded");
  assert.equal(rows[0].cause, "HTTP 500");
  assert.ok(Number.isFinite(Date.parse(rows[0].at)));
});

test("a repeated discovery replaces the entry instead of adding a row", async () => {
  for (let attempt = 0; attempt < 25; attempt++) {
    await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
      status: "degraded",
      cause: "HTTP 500",
    });
  }

  assert.equal((await storedRows()).length, 1);
});

test("the outcome is read back per connection", async () => {
  await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
    status: "degraded",
    cause: "HTTP 500",
  });
  await discoveryState.saveDiscoveryState("aimlapi", "conn-2", { status: "healthy", cause: null });

  const states = await discoveryState.getDiscoveryStatesForConnections([
    { provider: "aimlapi", id: "conn-1" },
    { provider: "aimlapi", id: "conn-2" },
  ]);

  assert.equal(states.size, 2);
  assert.equal(states.get("aimlapi:conn-1")?.status, "degraded");
  assert.equal(states.get("aimlapi:conn-1")?.cause, "HTTP 500");
  assert.equal(states.get("aimlapi:conn-2")?.status, "healthy");
  assert.equal(states.get("aimlapi:conn-2")?.cause, null);
});

test("a connection without a stored outcome reads as unknown", async () => {
  await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
    status: "degraded",
    cause: "HTTP 500",
  });

  const states = await discoveryState.getDiscoveryStatesForConnections([
    { provider: "aimlapi", id: "conn-1" },
    { provider: "aimlapi", id: "conn-unknown" },
  ]);

  assert.equal(states.size, 1);
  assert.equal(states.has("aimlapi:conn-unknown"), false);
});

test("an incomplete entry reads as absent, never as healthy", async () => {
  // A status without its timestamp is not a readable outcome: the read must skip it.
  await getTestBackend().execute(
    `INSERT INTO connection_model_sync (connection_id, provider, discovery_status, discovery_at)
     VALUES ($1, $2, 'healthy', NULL)`,
    ["conn-broken", "aimlapi"]
  );

  const states = await discoveryState.getDiscoveryStatesForConnections([
    { provider: "aimlapi", id: "conn-broken" },
  ]);

  assert.equal(states.size, 0);
});

test("the outcome is not stored for a connection that does not exist", async () => {
  await discoveryState.saveDiscoveryState("aimlapi", "conn-missing", {
    status: "degraded",
    cause: "HTTP 500",
  });

  assert.equal((await storedRows()).length, 0);
});

test("deleting a connection drops its stored outcome", async () => {
  await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
    status: "degraded",
    cause: "HTTP 500",
  });
  await discoveryState.saveDiscoveryState("aimlapi", "conn-2", { status: "healthy", cause: null });

  const removed = await discoveryState.deleteDiscoveryStatesForConnections([
    { provider: "aimlapi", id: "conn-1" },
  ]);

  assert.equal(removed, 1);
  const rows = await storedRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "aimlapi:conn-2");
});

test("deleting a provider drops every connection it owned", async () => {
  await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
    status: "degraded",
    cause: "HTTP 500",
  });
  await discoveryState.saveDiscoveryState("aimlapi", "conn-2", { status: "healthy", cause: null });
  await discoveryState.saveDiscoveryState("poe", "conn-3", {
    status: "degraded",
    cause: "HTTP 500",
  });

  const removed = await discoveryState.deleteDiscoveryStatesForProvider("aimlapi");

  assert.equal(removed, 2);
  const rows = await storedRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "poe:conn-3");
});

test("the store holds one entry per connection and nothing after the deletion", async () => {
  await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
    status: "degraded",
    cause: "HTTP 500",
  });
  for (let attempt = 0; attempt < 10; attempt++) {
    await discoveryState.saveDiscoveryState("aimlapi", "conn-1", {
      status: "degraded",
      cause: "HTTP 500",
    });
  }
  assert.equal((await storedRows()).length, 1);

  await discoveryState.deleteDiscoveryStatesForConnections([{ provider: "aimlapi", id: "conn-1" }]);
  assert.equal((await storedRows()).length, 0);
});
