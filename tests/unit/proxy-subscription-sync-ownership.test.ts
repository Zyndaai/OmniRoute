import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

// A subscription refresh must not revive a node the operator or auto-disable turned off,
// and must never write a registry row it does not own (a manual proxy or another
// subscription's node sharing the same host/port/username).

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sub-sync-ownership-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const proxies = await import("../../src/lib/db/proxies.ts");
const sub = await import("../../src/lib/proxySubscription/index.ts");

async function reset() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function feed(name: string, port: number) {
  return [
    "proxies:",
    `  - name: ${name}`,
    "    type: http",
    "    server: 127.0.0.1",
    `    port: ${port}`,
  ].join("\n");
}

function startFeedServer(initialBody: string): Promise<{
  url: string;
  setBody: (body: string) => void;
  close: () => Promise<void>;
}> {
  let body = initialBody;
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/list`,
        setBody: (next) => {
          body = next;
        },
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

async function insertSubscription(id: string, url: string) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO proxy_subscriptions
      (id, name, url, enabled, mode, rule_providers, update_interval_minutes, status, created_at, updated_at)
     VALUES ($1, $2, $3, true, 'global', NULL, 60, 'empty', $4, $5)`,
    [id, `sub-${id}`, url, now, now]
  );
}

async function rowIdFor(port: number) {
  const row = await getTestBackend().queryOne<{ id: string }>(
    "SELECT id FROM proxy_registry WHERE host = '127.0.0.1' AND port = $1",
    [port]
  );
  assert.ok(row, `expected a registry row on port ${port}`);
  return row.id;
}

test("a refresh keeps an owned node dead and still refreshes its name", async () => {
  await reset();
  const server = await startFeedServer(feed("node-v1", 18101));
  try {
    await insertSubscription("s1", server.url);
    await sub.syncSubscription("s1");
    const id = await rowIdFor(18101);
    await proxies.updateProxy(id, { status: "dead" });

    server.setBody(feed("node-v2", 18101));
    await sub.syncSubscription("s1");

    const row = await proxies.getProxyById(id);
    assert.equal(row?.status, "dead");
    assert.equal(row?.name, "node-v2");
  } finally {
    await server.close();
  }
});

test("a refresh heals an owned node that pool validation flagged error", async () => {
  await reset();
  const server = await startFeedServer(feed("node", 18102));
  try {
    await insertSubscription("s1", server.url);
    await sub.syncSubscription("s1");
    const id = await rowIdFor(18102);
    await proxies.updateProxy(id, { status: "error" });

    await sub.syncSubscription("s1");

    assert.equal((await proxies.getProxyById(id))?.status, "active");
  } finally {
    await server.close();
  }
});

test("a new node is created active and owned by the subscription", async () => {
  await reset();
  const server = await startFeedServer(feed("node", 18103));
  try {
    await insertSubscription("s1", server.url);
    const result = await sub.syncSubscription("s1");
    const row = await proxies.getProxyById(await rowIdFor(18103));
    assert.equal(row?.status, "active");
    assert.equal(row?.source, "subscription");
    assert.equal(row?.subscriptionId, "s1");
    assert.equal(result.boundProxies, 1);
  } finally {
    await server.close();
  }
});

test("a manual proxy with the same tuple is not written, pooled or removed", async () => {
  await reset();
  const manual = await proxies.createProxy({
    name: "manual",
    type: "https",
    host: "127.0.0.1",
    port: 18104,
    password: "manual-pass",
    status: "inactive",
  });
  const before = await proxies.getProxyById(manual.id, { includeSecrets: true });
  const server = await startFeedServer(feed("feed-node", 18104));
  try {
    await insertSubscription("s1", server.url);
    const result = await sub.syncSubscription("s1");

    assert.deepEqual(await proxies.getProxyById(manual.id, { includeSecrets: true }), before);
    assert.equal(result.boundProxies, 0);
    const pooled = await getTestBackend().queryOne<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM proxy_assignments WHERE proxy_id = $1",
      [manual.id]
    );
    assert.equal(Number(pooled?.n), 0);
  } finally {
    await server.close();
  }
});

test("two subscriptions listing the same tuple: the row stays with the first one", async () => {
  await reset();
  const serverA = await startFeedServer(feed("from-a", 18105));
  const serverB = await startFeedServer(feed("from-b", 18105));
  try {
    await insertSubscription("sa", serverA.url);
    await insertSubscription("sb", serverB.url);
    await sub.syncSubscription("sa");
    const id = await rowIdFor(18105);
    const before = await proxies.getProxyById(id, { includeSecrets: true });

    const resultB = await sub.syncSubscription("sb");

    assert.deepEqual(await proxies.getProxyById(id, { includeSecrets: true }), before);
    assert.equal(before?.subscriptionId, "sa");
    assert.equal(resultB.boundProxies, 0);
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test("a refresh keeps the dead local core row a needs-core feed binds", async () => {
  await reset();
  const server = await startFeedServer("ss://YWVzLTI1Ni1nY206cGFzcw@203.0.113.9:8388#ss-node");
  try {
    await insertSubscription("s1", server.url);
    await getTestBackend().execute(
      "UPDATE proxy_subscriptions SET local_core_endpoint = $1 WHERE id = $2",
      ["socks5://127.0.0.1:18106", "s1"]
    );
    const first = await sub.syncSubscription("s1");
    const id = await rowIdFor(18106);
    assert.equal(first.boundProxies, 1);
    assert.equal((await proxies.getProxyById(id))?.subscriptionId, "s1");
    await proxies.updateProxy(id, { status: "dead" });

    await sub.syncSubscription("s1");

    assert.equal((await proxies.getProxyById(id))?.status, "dead");
  } finally {
    await server.close();
  }
});
