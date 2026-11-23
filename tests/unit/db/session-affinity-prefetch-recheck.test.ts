import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTestBackend } from "../../helpers/postgres.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-affinity-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "synthetic-affinity-secret";
delete process.env.REDIS_URL;
delete process.env.OMNIROUTE_SESSION_AFFINITY_STORE;
const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const apiKeys = await import("../../../src/lib/db/apiKeys.ts");
const leases = await import("../../../src/lib/db/exclusiveConnectionLeases.ts");
const sqlite = await import("../../../src/lib/db/sessionAffinity/sqliteStore.ts");
const factory = await import("../../../src/lib/db/sessionAffinity/storeFactory.ts");
const pin = await import("../../../src/sse/services/sessionAffinityPin.ts");
const auth = await import("../../../src/sse/services/auth.ts");

// In-memory command double only; no Redis server or Lua execution.
class FakeRedis {
  values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, _mode: "PX", _ttl: number) {
    this.values.set(key, value);
    return "OK";
  }
  async del(key: string) {
    return Number(this.values.delete(key));
  }
  async eval(
    _script: string,
    _keys: number,
    key: string,
    expected: string,
    replacement: string,
    _ttl: number
  ) {
    if (expected === undefined) return [await this.get(key), this.values.has(key) ? 60_000 : -2];
    if ((this.values.get(key) ?? "") !== expected) return [0, await this.get(key), 60_000];
    if (!replacement) return [Number(this.values.delete(key)), null, -2];
    this.values.set(key, replacement);
    return [1, replacement, _ttl];
  }
}

test.beforeEach(() => {
  factory._setSessionAffinityRedisForTests(null);
  delete process.env.OMNIROUTE_SESSION_AFFINITY_STORE;
});
test.after(async () => {
  factory._setSessionAffinityRedisForTests(null);
  await core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const driver of ["sqlite", "redis"] as const) {
  for (const leasePath of [false, true]) {
    test(`${driver} ${leasePath ? "lease" : "non-lease"} auth selection after mid-flight pin eviction`, async (t) => {
      const sessionKey = `synthetic-race-${driver}-${leasePath}`;
      const redis = new FakeRedis();
      if (driver === "redis") {
        factory._setSessionAffinityRedisForTests({
          getClient: async () => redis,
          isConfigured: () => true,
        });
        process.env.OMNIROUTE_SESSION_AFFINITY_STORE = "redis";
      }
      const store = factory.getSessionAffinityStore();
      const makeConnection = async (name: string, priority: number) => {
        const connection = await providers.createProviderConnection({
          provider: "glm",
          authType: "apikey",
          name: `${sessionKey}-${name}`,
          apiKey: `synthetic-${sessionKey}-${name}`,
          isActive: true,
          testStatus: "active",
          priority,
        });
        return String(connection.id);
      };
      const a = await makeConnection("A", 2);
      const b = await makeConnection("B", 1);
      await store.upsert(sessionKey, "glm", a, Date.now(), 60_000);
      const get = t.mock.method(store, "get");
      let evicted = false;
      let readsAtEviction = -1;
      // The process backend is the singleton that production db() returns, so wrapping its
      // query() intercepts the lease-policy read. That query runs inside the async lease-policy
      // step, after the old prefetch and before the planner/selector. Both candidates stay eligible.
      const backend = getTestBackend();
      const query = backend.query.bind(backend);
      t.mock.method(backend, "query", async (sql: string, params?: unknown[]) => {
        if (!evicted && sql.includes("SELECT connection_id, lease_owner_hash, expires_at")) {
          evicted = true;
          readsAtEviction = get.mock.callCount();
          if (driver === "sqlite")
            assert.equal(
              await sqlite.evictSessionAccountAffinityForConnection(sessionKey, "glm", a),
              true
            );
          else
            assert.equal(
              await sqlite.evictSessionAccountAffinityForConnection(sessionKey, "glm", a),
              false,
              "shared upsert must not have installed a local mirror"
            );
          redis.values.clear(); // The shared eviction has landed too.
        }
        return query(sql, params);
      });
      const owner = `vlo_${(driver === "redis" ? "R" : "S").repeat(43)}`;
      const key = leasePath
        ? await apiKeys.createApiKey("synthetic", "test", ["lease:exclusive"], {
            allowedConnections: [a, b],
          })
        : null;
      const selected = await auth.getProviderCredentials("glm", null, [a, b], null, {
        sessionKey,
        sessionAffinityTtlMs: 60_000,
        materializeCredentials: false,
        ...(key
          ? {
              lease: {
                apiKeyId: key.id,
                context: {
                  leaseOwnerId: owner,
                  leaseOwnerHash: leases.hashLeaseOwnerId(owner),
                  ownerDiagnostic: "synthetic",
                  generation: 1,
                },
                mode: "acquire" as const,
              },
            }
          : {}),
      });
      assert.equal(evicted, true, "must exercise the prefetch-to-selection window");
      // Every store is async, so getProviderCredentials prefetches the pin once for every
      // driver (#5903 needs it, and planning is synchronous). Both drivers behave alike:
      // - lease planning is synchronous and intentionally uses the prefetched snapshot A
      //   (the accepted window: an eviction landing after the prefetch is not seen);
      // - the non-lease selector re-reads the store, sees the miss and picks LRU B.
      assert.equal(selected?.connectionId, leasePath ? a : b);
      assert.equal(readsAtEviction, 1, "the pin was prefetched before the eviction window");
      if (leasePath) assert.equal(get.mock.callCount(), 1, "lease planning reuses the prefetch");
      else {
        // The prefetch, then the selector's own read (which sees the eviction).
        assert.equal(get.mock.callCount(), 2);
      }
      if (key) {
        leases.invalidateExclusiveConnectionLease({
          leaseOwnerId: owner,
          generation: 1,
          apiKeyId: key.id,
          reason: "CONNECTION_INELIGIBLE",
        });
      }
    });
  }
}

test("SQLite selector reads at entry without an async store-read yield", async (t) => {
  const store = factory.getSessionAffinityStore();
  await sqlite.upsertSessionAccountAffinity("synthetic-entry", "glm", "A", Date.now(), 60_000);
  const selection = pin.selectSessionAffinityConnection(
    "glm",
    "synthetic-entry",
    [{ id: "A" }, { id: "B", priority: 1 }],
    60_000
  );
  // The read-count guard (0 store reads) only held for the removed synchronous SQLite getter;
  // PostgreSQL reads the pin through the async store, so only the selection result is asserted.
  assert.equal((await selection)?.id, "A");
});

test("SQLite forced-pin override uses its own synchronous read without prefetch", async (t) => {
  const connection = await providers.createProviderConnection({
    provider: "glm",
    authType: "apikey",
    name: "synthetic-forced-connection",
    apiKey: "synthetic-forced-key",
    isActive: true,
    testStatus: "active",
  });
  const a = String(connection.id);
  await sqlite.upsertSessionAccountAffinity("synthetic-forced", "glm", a, Date.now(), 60_000);
  const selected = await auth.getProviderCredentials("glm", null, [a], null, {
    sessionKey: "synthetic-forced",
    sessionAffinityTtlMs: 60_000,
    forcedConnectionId: a,
    materializeCredentials: false,
  });
  assert.equal(selected?.connectionId, a);
});
