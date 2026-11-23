import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

// A manual refresh of a disabled subscription keeps a preview sync but must
// never drop attached rows that are missing from the feed.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sub-disabled-refresh-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const sub = await import("../../../src/lib/proxySubscription/index.ts");

async function reset() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function feed(entries: Array<{ name: string; port: number }>) {
  const lines = ["proxies:"];
  for (const e of entries) {
    lines.push(
      `  - name: ${e.name}`,
      "    type: http",
      "    server: 127.0.0.1",
      `    port: ${e.port}`
    );
  }
  return lines.join("\n");
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

async function insertSubscription(id: string, url: string, enabled: number) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO proxy_subscriptions
      (id, name, url, enabled, mode, rule_providers, update_interval_minutes, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'global', NULL, 60, 'empty', $5, $6)`,
    [id, `sub-${id}`, url, enabled !== 0, now, now]
  );
}

async function rowsFor(subscriptionId: string): Promise<
  Array<{
    id: string;
    name: string;
    host: string;
    port: number;
    status: string;
  }>
> {
  return getTestBackend().query<{
    id: string;
    name: string;
    host: string;
    port: number;
    status: string;
  }>(
    "SELECT id, name, host, port, status FROM proxy_registry WHERE subscription_id = $1 ORDER BY port",
    [subscriptionId]
  );
}

test("a refresh of a disabled subscription keeps rows missing from the feed", async () => {
  await reset();
  const server = await startFeedServer(
    feed([
      { name: "node-a", port: 18211 },
      { name: "node-b", port: 18212 },
    ])
  );
  try {
    await insertSubscription("s1", server.url, 0);
    await sub.syncSubscription("s1");
    const before = await rowsFor("s1");
    assert.equal(before.length, 2);

    server.setBody(feed([{ name: "node-a", port: 18211 }]));
    const result = await sub.syncSubscription("s1");

    assert.deepEqual(await rowsFor("s1"), before);
    assert.equal(result.applied, false);
    assert.equal(result.boundProxies, 0);
  } finally {
    await server.close();
  }
});

test("a refresh of an enabled subscription still removes rows missing from the feed", async () => {
  await reset();
  const server = await startFeedServer(
    feed([
      { name: "node-a", port: 18221 },
      { name: "node-b", port: 18222 },
    ])
  );
  try {
    await insertSubscription("s1", server.url, 1);
    await sub.syncSubscription("s1");
    assert.equal((await rowsFor("s1")).length, 2);

    server.setBody(feed([{ name: "node-a", port: 18221 }]));
    const result = await sub.syncSubscription("s1");

    const after = await rowsFor("s1");
    assert.equal(after.length, 1);
    assert.equal(after[0].port, 18221);
    assert.equal(result.applied, true);
    assert.equal(result.boundProxies, 1);
  } finally {
    await server.close();
  }
});

test("a refresh of a disabled subscription with a nodeless usable feed removes nothing", async () => {
  await reset();
  const server = await startFeedServer(
    feed([
      { name: "node-a", port: 18231 },
      { name: "node-b", port: 18232 },
    ])
  );
  try {
    await insertSubscription("s1", server.url, 0);
    await sub.syncSubscription("s1");
    const before = await rowsFor("s1");
    assert.equal(before.length, 2);

    server.setBody("proxies: []");
    const result = await sub.syncSubscription("s1");

    assert.deepEqual(await rowsFor("s1"), before);
    assert.equal(result.applied, false);
    assert.equal(result.boundProxies, 0);
  } finally {
    await server.close();
  }
});
