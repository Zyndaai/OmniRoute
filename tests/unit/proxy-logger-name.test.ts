import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-logger-name-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const core = await import("../../src/lib/db/core.ts");
const proxyLogger = await import("../../src/lib/proxyLogger.ts");

async function resetStorage() {
  // Batched persistence: logProxyEvent() enqueues and flushes on a timer, so a
  // queued entry from a previous test would otherwise be written into the fresh
  // DB after the reset. Drain the queue (and stop the timer) before clearing.
  await proxyLogger.flushProxyLogsSync();
  await proxyLogger.clearProxyLogs();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  await core.resetDbInstance();
});

test("proxy logs carry the registry name on the proxy entry", () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "nous-research",
    targetUrl: "nous/deepseek/deepseek-v4-flash-0731",
    level: "provider",
    levelId: "nous-research",
    proxy: { type: "http", host: "gw-eu.murphyproxies.com", port: 7777, name: "murphy-eu-fr" },
  });

  const [log] = proxyLogger.getProxyLogs();
  assert.equal(log.proxy.name, "murphy-eu-fr");
  assert.equal(log.proxy.host, "gw-eu.murphyproxies.com");
});

test("registry name survives database persist + hydrate", async () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "nous-research",
    proxy: { type: "http", host: "gw-eu.murphyproxies.com", port: 7777, name: "murphy-eu-de" },
  });

  // logProxyEvent() enqueues writes on the batched persistence path; force the
  // flush to the database before inspecting the raw row.
  await proxyLogger.flushProxyLogsSync();
  const rows = await getTestBackend().query<{ proxy_name: string; proxy_host: string }>(
    "SELECT proxy_name, proxy_host FROM proxy_logs"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proxy_name, "murphy-eu-de");
  assert.equal(rows[0].proxy_host, "gw-eu.murphyproxies.com");
});

test("search matches the registry name", () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "nous-research",
    proxy: { type: "http", host: "gw-eu.murphyproxies.com", port: 7777, name: "murphy-eu-fr" },
  });
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "openrouter",
  });

  const hits = proxyLogger.getProxyLogs({ search: "murphy-eu-fr" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].proxy.name, "murphy-eu-fr");
});

test("legacy rows without a name hydrate cleanly (host:port only)", () => {
  proxyLogger.logProxyEvent({
    status: "success",
    provider: "openrouter",
    proxy: { type: "http", host: "203.0.113.50", port: 8080 },
  });

  const [log] = proxyLogger.getProxyLogs();
  assert.equal(log.proxy.name, undefined);
  assert.equal(log.proxy.host, "203.0.113.50");
});
