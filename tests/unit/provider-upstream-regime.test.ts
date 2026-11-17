import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Uniform 5xx regime read from the proxy log: a provider whose exits fail
// together is an upstream problem, not an exit problem. The pure rule decides
// on shares over exits with traffic; the SQL groups real requests per
// provider and per exit. Rows go through INSERT statements with the same
// columns and the same connection-test filter the readers use.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-upstream-regime-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.PROXY_POOL_EGRESS_OBSERVATION = "true";

const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const core = await import("../../src/lib/db/core.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const regime = await import("../../src/lib/proxyPoolEgressObservation.ts");

async function resetStorage() {
  regime.resetUniformEgressRegimeCache();
  regime.resetPoolEgressObservationCache();
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

const THRESHOLDS = {
  shareThreshold: 0.3,
  majorityRatio: 0.5,
  minAttemptsPerExit: 5,
  minExitsWithTraffic: 2,
};

// Exit rows through the production reader: one INSERT per request, grouped by
// the same SQL the reader uses, so order and fields match production.
async function seedExits(
  provider: string,
  shares: Array<{ exits: number; share: number; perExit?: number; status?: number | null }>
): Promise<void> {
  let host = 0;
  for (const group of shares) {
    const perExit = group.perExit ?? 10;
    const failing = Math.round(perExit * group.share);
    for (let exit = 0; exit < group.exits; exit++) {
      host += 1;
      for (let n = 0; n < perExit; n++) {
        await insertLog(provider, `10.8.0.${host}`, 8080, n < failing ? (group.status ?? 503) : 200);
      }
    }
  }
}

async function readerRows(provider: string): Promise<Array<{ attempts: number; serverErrors: number }>> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const summary = (await proxiesDb.getProviderUpstreamSummary(since)).find(
    (entry) => entry.provider === provider
  );
  assert.ok(summary, `expected a summary for ${provider}`);
  return summary.exits;
}

async function insertLog(
  provider: string | null,
  host: string,
  port: number,
  upstreamStatus: number | null,
  targetUrl: string | null = "https://api.example.com/v1/chat",
  ageMs = 30 * 60 * 1000
) {
  await getTestBackend().execute(
    `INSERT INTO proxy_logs (id, "timestamp", status, proxy_type, proxy_host, proxy_port, provider, target_url, upstream_status)
     VALUES ($1, $2, 'error', 'http', $3, $4, $5, $6, $7)`,
    [
      randomUUID(),
      new Date(Date.now() - ageMs).toISOString(),
      host,
      port,
      provider,
      targetUrl,
      upstreamStatus,
    ]
  );
}

test("flags every exit above the share as a uniform regime", async () => {
  await seedExits("pure-uniform", [{ exits: 15, share: 0.4 }]);
  const result = regime.isUpstreamRegime(await readerRows("pure-uniform"), THRESHOLDS);
  assert.equal(result.uniform, true);
  assert.equal(result.state, "measured");
  assert.equal(result.exitsWithTraffic, 15);
  assert.equal(result.affectedExits, 15);
});

test("a single affected exit is not a uniform regime", async () => {
  await seedExits("pure-single", [
    { exits: 1, share: 0.9 },
    { exits: 14, share: 0 },
  ]);
  const result = regime.isUpstreamRegime(await readerRows("pure-single"), THRESHOLDS);
  assert.equal(result.uniform, false);
  assert.equal(result.state, "measured");
});

test("client errors alone never flag a 5xx regime", async () => {
  await seedExits("pure-4xx", [{ exits: 4, share: 0, status: 429 }]);
  const rows = await readerRows("pure-4xx");
  assert.equal(
    rows.reduce((sum, row) => sum + row.attempts, 0),
    40
  );
  // 429s land in measured, never in serverErrors: the SQL only counts 5xx.
  const result = regime.isUpstreamRegime(
    rows.map((row) => ({ ...row, measured: row.attempts })),
    THRESHOLDS
  );
  assert.equal(result.uniform, false);
  assert.equal(result.state, "measured");
});

test("exits below the traffic minimum do not count", async () => {
  await seedExits("pure-thin", [{ exits: 2, share: 1, perExit: 2 }]);
  const result = regime.isUpstreamRegime(await readerRows("pure-thin"), THRESHOLDS);
  assert.equal(result.uniform, false);
  assert.equal(result.exitsWithTraffic, 0);
});

test("one exit with traffic is never uniform", async () => {
  await seedExits("pure-lone", [{ exits: 1, share: 1 }]);
  const result = regime.isUpstreamRegime(await readerRows("pure-lone"), THRESHOLDS);
  assert.equal(result.uniform, false);
});

test("no measured request means unmeasured and no conclusion", async () => {
  // Every row without an upstream status: the reader counts attempts, not measured.
  for (let host = 1; host <= 2; host++) {
    for (let n = 0; n < 10; n++) await insertLog("pure-unmeasured", `10.8.9.${host}`, 8080, null);
  }
  const summary = (
    await proxiesDb.getProviderUpstreamSummary(new Date(Date.now() - 60 * 60 * 1000).toISOString())
  ).find((entry) => entry.provider === "pure-unmeasured");
  assert.ok(summary);
  assert.equal(summary.measured, 0);
  const result = regime.isUpstreamRegime(
    summary.exits.map((row) => ({ ...row, measured: 0 })),
    THRESHOLDS
  );
  assert.equal(result.uniform, false);
  assert.equal(result.state, "unmeasured");
});

test("SQL groups real requests per provider and excludes connection tests", async () => {
  for (let exit = 0; exit < 3; exit++) {
    for (let n = 0; n < 6; n++) {
      await insertLog("acme", `10.9.0.${exit + 1}`, 8080, n < 2 ? 500 : 200);
    }
  }
  await insertLog("acme", "10.9.0.1", 8080, 200, "acme/connection-test");
  await insertLog(null, "10.9.0.9", 8080, 500);
  await insertLog("  ", "10.9.0.9", 8080, 500);
  for (let n = 0; n < 6; n++) await insertLog("other", "10.9.0.9", 8080, 500);

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const summaries = await proxiesDb.getProviderUpstreamSummary(since);
  const acme = summaries.find((entry) => entry.provider === "acme");
  assert.ok(acme);
  assert.equal(acme.attempts, 18);
  assert.equal(acme.measured, 18);
  assert.equal(acme.exits.length, 3);
  assert.ok(
    summaries.every((entry) => entry.provider.trim() !== ""),
    "blank providers are excluded"
  );
  const stale = await proxiesDb.getProviderUpstreamSummary(
    new Date(Date.now() - 60 * 1000).toISOString()
  );
  assert.equal(
    stale.find((entry) => entry.provider === "acme")?.attempts ?? 0,
    0,
    "the window lower bound applies"
  );
});

test("a uniform provider reads back as uniform through the cached reader", async () => {
  for (let exit = 0; exit < 15; exit++) {
    for (let n = 0; n < 6; n++) {
      await insertLog("storm", `10.9.1.${exit + 1}`, 8080, n < 3 ? 503 : 200);
    }
  }
  const now = Date.now();
  const first = await regime.readUniformEgressRegime("storm", 1, now);
  assert.equal(first?.uniform, true);
  assert.equal(first?.state, "measured");
  assert.equal(first?.exitsWithTraffic, 15);
  await insertLog("storm", "10.9.9.9", 8080, 200);
  assert.equal(
    (await regime.readUniformEgressRegime("storm", 1, now + 1000))?.attempts,
    first?.attempts
  );
});

test("a cached regime is re-read after 30 seconds", async () => {
  for (let exit = 0; exit < 3; exit++) {
    for (let n = 0; n < 6; n++) {
      await insertLog("ttl", `10.9.4.${exit + 1}`, 8080, n < 2 ? 503 : 200);
    }
  }
  const now = Date.now();
  const first = await regime.readUniformEgressRegime("ttl", 1, now);
  assert.ok(first);
  await insertLog("ttl", "10.9.4.1", 8080, 200);
  assert.equal(
    (await regime.readUniformEgressRegime("ttl", 1, now + 29_000))?.attempts,
    first?.attempts,
    "within TTL the first read is reused"
  );
  const fresh = await regime.readUniformEgressRegime("ttl", 1, now + 31_000);
  assert.equal(fresh?.attempts, (first?.attempts ?? 0) + 1, "past the TTL the log is read again");
});

test("a failed read is traced server-side, returns null, and is not cached", async () => {
  for (let n = 0; n < 6; n++) await insertLog("traced", "10.9.6.1", 8080, 200);
  for (let n = 0; n < 6; n++) await insertLog("traced", "10.9.6.2", 8080, 200);
  const errors: Array<{ msg: unknown; message: unknown }> = [];
  const logger = await import("../../src/shared/utils/logger.ts");
  const original = logger.logger.error.bind(logger.logger);
  (logger.logger as { error: (...args: unknown[]) => void }).error = (...args: unknown[]) => {
    errors.push({ msg: args[0], message: args[1] });
  };
  const b = getTestBackend();
  await b.execute("ALTER TABLE proxy_logs RENAME TO proxy_logs_hidden");
  try {
    assert.equal(await regime.readUniformEgressRegime("traced", 1), null, "client still gets null");
  } finally {
    await b.execute("ALTER TABLE proxy_logs_hidden RENAME TO proxy_logs");
    logger.logger.error = original;
  }
  assert.equal(errors.length, 1, "one server-side trace");
  assert.match(
    String((errors[0].message as string) ?? ""),
    /proxy_logs/i,
    "sanitized failure text"
  );
  assert.equal(
    (errors[0].msg as Record<string, unknown>)?.provider,
    "traced",
    "provider travels in the log meta"
  );
  assert.equal((await regime.readUniformEgressRegime("traced", 1))?.exitsWithTraffic, 2);
});

test("a failed read returns null and is not cached", async () => {
  for (let n = 0; n < 6; n++) await insertLog("flaky", "10.9.5.1", 8080, 200);
  for (let n = 0; n < 6; n++) await insertLog("flaky", "10.9.5.2", 8080, 200);
  const b = getTestBackend();
  await b.execute("ALTER TABLE proxy_logs RENAME TO proxy_logs_hidden");
  try {
    assert.equal(await regime.readUniformEgressRegime("flaky", 1), null);
  } finally {
    await b.execute("ALTER TABLE proxy_logs_hidden RENAME TO proxy_logs");
  }
  assert.ok(
    await regime.readUniformEgressRegime("flaky", 1),
    "the failure left no cache entry behind"
  );
});
