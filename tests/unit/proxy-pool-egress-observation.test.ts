import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

// A pool's member count says nothing about how many egress IPs really served it. These
// tests pin the observation read from the proxy log: numbers only, the scope normalized
// the same way the pool itself is read, and any failure isolated as null. The observation is
// opt-in (PROXY_POOL_EGRESS_OBSERVATION feature flag, default off): tests opt in explicitly.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pool-egress-obs-"));
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.PROXY_POOL_EGRESS_OBSERVATION;

const core = await import("../../src/lib/db/core.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const observation = await import("../../src/lib/proxyPoolEgressObservation.ts");

const HOUR_MS = 60 * 60 * 1000;
let nextPort = 20000;

async function resetStorage() {
  observation.resetPoolEgressObservationCache();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  process.env.PROXY_POOL_EGRESS_OBSERVATION = "true";
  await resetStorage();
});

test.after(async () => {
  delete process.env.PROXY_POOL_EGRESS_OBSERVATION;
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type Member = { host: string; port: number };

async function registryProxy(): Promise<Member & { id: string }> {
  nextPort++;
  const proxy = await proxiesDb.createProxy({
    name: `proxy ${nextPort}`,
    type: "http",
    host: "10.9.0.1",
    port: nextPort,
  });
  return { id: proxy.id, host: "10.9.0.1", port: nextPort };
}

async function poolMember(scope: string, scopeId: string | null): Promise<Member> {
  const proxy = await registryProxy();
  await proxiesDb.addProxyToScopePool(scope, scopeId, proxy.id);
  return proxy;
}

async function logRow(
  member: Member,
  egressIp: string | null,
  connectionId: string | null,
  ageMs = HOUR_MS
) {
  await getTestBackend().execute(
    `INSERT INTO proxy_logs (id, "timestamp", status, proxy_type, proxy_host, proxy_port, level, connection_id, egress_ip)
     VALUES ($1, $2, 'success', 'http', $3, $4, 'provider', $5, $6)`,
    [
      randomUUID(),
      new Date(Date.now() - ageMs).toISOString(),
      member.host,
      member.port,
      connectionId,
      egressIp,
    ]
  );
}

test("counts distinct exits, connections and the busiest exit of a pool", async () => {
  const a = await poolMember("provider", "openai");
  const b = await poolMember("provider", "openai");
  const c = await poolMember("provider", "openai");
  for (const conn of ["c1", "c2", "c3", "c4"]) await logRow(a, "203.0.113.1", conn);
  for (const conn of ["c5", "c6", "c7"]) await logRow(a, "203.0.113.2", conn);
  for (const conn of ["c8", "c9"]) await logRow(b, "203.0.113.3", conn);
  for (const conn of ["c10", "c11"]) await logRow(b, "203.0.113.4", conn);
  await logRow(c, "203.0.113.5", "c12");
  await logRow(c, "203.0.113.5", "c1");
  await logRow(c, "203.0.113.5", "c12");

  const outsider = await registryProxy();
  await logRow(outsider, "198.51.100.9", "x1");
  await logRow(a, null, "x2");
  await logRow(a, "203.0.113.9", null);
  await logRow(a, "203.0.113.8", "x3", 25 * HOUR_MS);

  assert.deepEqual(await observation.readPoolEgressObservation("provider", "openai"), {
    connections: 12,
    distinctExits: 5,
    maxConnectionsOnOneExit: 4,
    windowHours: 24,
    failures: {
      byExit: [],
      byFamily: [],
      unattributed: 0,
      attributionNote: "per-family breakdown covers only requests logged with attribution on",
    },
  });
});

test("the global pool is read under its stored scope id", async () => {
  const member = await poolMember("global", null);
  await logRow(member, "203.0.113.1", "c1");
  assert.deepEqual(await observation.readPoolEgressObservation("global", null), {
    connections: 1,
    distinctExits: 1,
    maxConnectionsOnOneExit: 1,
    windowHours: 24,
    failures: {
      byExit: [],
      byFamily: [],
      unattributed: 0,
      attributionNote: "per-family breakdown covers only requests logged with attribution on",
    },
  });
});

test("scope key is the account scope and shares its cache entry", async () => {
  const member = await poolMember("account", "acc-1");
  await logRow(member, "203.0.113.1", "c1");
  const now = Date.now();
  assert.equal(
    (await observation.readPoolEgressObservation("account", "acc-1", now))?.connections,
    1
  );

  await logRow(member, "203.0.113.1", "c2");
  assert.equal(
    (await observation.readPoolEgressObservation("key", "acc-1", now + 1000))?.connections,
    1
  );

  observation.resetPoolEgressObservationCache();
  assert.equal(
    (await observation.readPoolEgressObservation("key", "acc-1", now + 2000))?.connections,
    2
  );
});

test("an empty pool yields zeros, not null", async () => {
  assert.deepEqual(await observation.readPoolEgressObservation("provider", "nobody"), {
    connections: 0,
    distinctExits: 0,
    maxConnectionsOnOneExit: 0,
    windowHours: 24,
    failures: {
      byExit: [],
      byFamily: [],
      unattributed: 0,
      attributionNote: "per-family breakdown covers only requests logged with attribution on",
    },
  });
});

test("a result is reused for 30 seconds, then read again", async () => {
  const member = await poolMember("provider", "openai");
  await logRow(member, "203.0.113.1", "c1");
  const now = Date.now();
  assert.equal(
    (await observation.readPoolEgressObservation("provider", "openai", now))?.connections,
    1
  );

  await logRow(member, "203.0.113.2", "c2");
  const cached = await observation.readPoolEgressObservation("provider", "openai", now + 29_000);
  assert.equal(cached?.connections, 1);
  const fresh = await observation.readPoolEgressObservation("provider", "openai", now + 31_000);
  assert.equal(fresh?.connections, 2);
});

test("any SQL failure yields null and is not cached", async () => {
  const member = await poolMember("provider", "openai");
  await logRow(member, "203.0.113.1", "c1");
  const backend = getTestBackend();
  await backend.execute("ALTER TABLE proxy_logs RENAME TO proxy_logs_hidden");
  try {
    assert.equal(await observation.readPoolEgressObservation("provider", "openai"), null);
  } finally {
    await backend.execute("ALTER TABLE proxy_logs_hidden RENAME TO proxy_logs");
  }
  assert.equal(
    (await observation.readPoolEgressObservation("provider", "openai"))?.connections,
    1
  );
});

test("the observation stays off unless the feature flag is on", async () => {
  const member = await poolMember("provider", "openai");
  await logRow(member, "203.0.113.1", "c1");
  delete process.env.PROXY_POOL_EGRESS_OBSERVATION;
  assert.equal(await observation.readPoolEgressObservation("provider", "openai"), null, "default");
  for (const value of ["false", "0", "no", "off"]) {
    process.env.PROXY_POOL_EGRESS_OBSERVATION = value;
    assert.equal(await observation.readPoolEgressObservation("provider", "openai"), null, value);
  }
  process.env.PROXY_POOL_EGRESS_OBSERVATION = "true";
  assert.equal(
    (await observation.readPoolEgressObservation("provider", "openai"))?.connections,
    1
  );
});

test("a DB override turning the flag off wins over the environment", async () => {
  const flagsDb = await import("../../src/lib/db/featureFlags.ts");
  const { refreshFeatureFlagSnapshot } = await import("../../src/shared/utils/featureFlags.ts");
  const member = await poolMember("provider", "openai");
  await logRow(member, "203.0.113.1", "c1");
  await flagsDb.setFeatureFlagOverride("PROXY_POOL_EGRESS_OBSERVATION", "false");
  // Flag reads are synchronous against an in-process snapshot: load the new override first.
  await refreshFeatureFlagSnapshot();
  assert.equal(await observation.readPoolEgressObservation("provider", "openai"), null);
});
