import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

// One registry row per valid `localCoreEndpoint` entry. Real loopback TCP
// servers stand in for reachable cores; a port closed after binding stands in
// for an unreachable one. No ESM stubbing — every verdict is a real probe.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sub-plural-core-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const proxies = await import("../../../src/lib/db/proxies.ts");
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

function startTcpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.end());
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({ port: addr.port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

async function closedPort(): Promise<number> {
  const srv = await startTcpServer();
  const port = srv.port;
  await srv.close();
  return port;
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

const NEEDS_CORE_FEED = "ss://YWVzLTI1Ni1nY206cGFzcw@203.0.113.9:8388#ss-node";

async function insertSubscription(id: string, url: string, localCoreEndpoint: string | null) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO proxy_subscriptions
      (id, name, url, enabled, mode, rule_providers, local_core_endpoint, update_interval_minutes, status, created_at, updated_at)
     VALUES ($1, $2, $3, true, 'global', NULL, $4, 60, 'empty', $5, $6)`,
    [id, `sub-${id}`, url, localCoreEndpoint, now, now]
  );
}

async function rowsForSub(id: string) {
  return getTestBackend().query<{ id: string; name: string; host: string; port: number }>(
    "SELECT id, name, host, port FROM proxy_registry WHERE subscription_id = $1",
    [id]
  );
}

async function errorOf(id: string): Promise<string | null> {
  const row = await getTestBackend().queryOne<{ error: string | null }>(
    "SELECT error FROM proxy_subscriptions WHERE id = $1",
    [id]
  );
  return row?.error ?? null;
}

async function detailOf(id: string): Promise<{ code?: string; detail?: string } | null> {
  const raw = await errorOf(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

test("single entry keeps the exact legacy name, row and status", async () => {
  await reset();
  const tcp = await startTcpServer();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription("s1", feed.url, `socks5://127.0.0.1:${tcp.port}`);
    const result = await sub.syncSubscription("s1");
    assert.equal(result.status, "ok");
    assert.equal(result.error, null);
    const rows = await rowsForSub("s1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "sub-s1 (local core)");
  } finally {
    await feed.close();
    await tcp.close();
  }
});

test("single gate-rejected entry warns INVALID with a redacted invalid detail", async () => {
  await reset();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription("s1", feed.url, "socks5://user:pass@192.0.2.1:1080");
    const result = await sub.syncSubscription("s1");
    assert.equal(result.status, "error");
    assert.equal((await rowsForSub("s1")).length, 0);
    const parsed = await detailOf("s1");
    assert.equal(parsed?.code, "LOCAL_CORE_ENDPOINT_INVALID");
    assert.ok(parsed?.detail?.includes("invalid:"), `detail: ${parsed?.detail}`);
    assert.ok(!parsed?.detail?.includes("pass"), `password leaked: ${parsed?.detail}`);
    assert.ok(!parsed?.detail?.includes("user@"), `userinfo leaked: ${parsed?.detail}`);
  } finally {
    await feed.close();
  }
});

test("three reachable entries create three rows and three pool members", async () => {
  await reset();
  const a = await startTcpServer();
  const b = await startTcpServer();
  const c = await startTcpServer();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      `socks5://127.0.0.1:${a.port}\nsocks5://127.0.0.1:${b.port}\nsocks5://127.0.0.1:${c.port}`
    );
    const result = await sub.syncSubscription("s1");
    assert.equal(result.status, "ok");
    const rows = await rowsForSub("s1");
    assert.equal(rows.length, 3);
    const seen = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const r = await proxies.resolveProxyForScopeFromRegistry("global", "");
      const port = (r as { proxy: { port: number } } | null)?.proxy?.port;
      if (port) seen.add(port);
      if (seen.size === 3) break;
    }
    assert.ok(seen.has(a.port), `member :${a.port} never visited`);
    assert.ok(seen.has(b.port), `member :${b.port} never visited`);
    assert.ok(seen.has(c.port), `member :${c.port} never visited`);
  } finally {
    await feed.close();
    await a.close();
    await b.close();
    await c.close();
  }
});

test("gate-rejected entry creates no row but warns with a redacted detail", async () => {
  await reset();
  const a = await startTcpServer();
  const b = await startTcpServer();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      `socks5://127.0.0.1:${a.port}\nsocks5://user:pass@192.0.2.1:1080\nsocks5://127.0.0.1:${b.port}`
    );
    const result = await sub.syncSubscription("s1");
    assert.equal(result.status, "ok");
    assert.equal((await rowsForSub("s1")).length, 2);
    const parsed = await detailOf("s1");
    assert.equal(parsed?.code, "LOCAL_CORE_ENDPOINT_INVALID");
    assert.ok(parsed?.detail?.includes("invalid:"), `detail: ${parsed?.detail}`);
    assert.ok(!parsed?.detail?.includes("pass"), `password leaked: ${parsed?.detail}`);
    assert.ok(!parsed?.detail?.includes("user@"), `userinfo leaked: ${parsed?.detail}`);
  } finally {
    await feed.close();
    await a.close();
    await b.close();
  }
});

test("unreachable entry still creates its row and is listed as unreachable", async () => {
  await reset();
  const open = await startTcpServer();
  const shut = await closedPort();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      `socks5://127.0.0.1:${open.port}\nsocks5://127.0.0.1:${shut}`
    );
    const result = await sub.syncSubscription("s1");
    assert.equal(result.status, "ok");
    assert.equal((await rowsForSub("s1")).length, 2);
    const parsed = await detailOf("s1");
    assert.equal(parsed?.code, "LOCAL_CORE_ENDPOINT_INVALID");
    assert.ok(parsed?.detail?.includes("unreachable:"), `detail: ${parsed?.detail}`);
    assert.ok(parsed?.detail?.includes(String(shut)), `detail: ${parsed?.detail}`);
  } finally {
    await feed.close();
    await open.close();
  }
});

test("re-sync of an unreachable entry keeps the row id and its assignments", async () => {
  await reset();
  const shut = await closedPort();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription("s1", feed.url, `socks5://127.0.0.1:${shut}`);
    await sub.syncSubscription("s1");
    const before = await rowsForSub("s1");
    assert.equal(before.length, 1);
    const pooled = await getTestBackend().queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM proxy_assignments WHERE proxy_id = $1",
      [before[0].id]
    );
    assert.equal(pooled?.n, 1);

    await sub.syncSubscription("s1");

    const after = await rowsForSub("s1");
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before[0].id);
    const pooled2 = await getTestBackend().queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM proxy_assignments WHERE proxy_id = $1",
      [before[0].id]
    );
    assert.equal(pooled2?.n, 1);
  } finally {
    await feed.close();
  }
});

test("removing an entry from the field deletes its row on re-sync", async () => {
  await reset();
  const a = await startTcpServer();
  const b = await startTcpServer();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      `socks5://127.0.0.1:${a.port}\nsocks5://127.0.0.1:${b.port}`
    );
    await sub.syncSubscription("s1");
    assert.equal((await rowsForSub("s1")).length, 2);

    await getTestBackend().execute(
      "UPDATE proxy_subscriptions SET local_core_endpoint = $1 WHERE id = $2",
      [`socks5://127.0.0.1:${a.port}`, "s1"]
    );
    await sub.syncSubscription("s1");

    const rows = await rowsForSub("s1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].port, a.port);
  } finally {
    await feed.close();
    await a.close();
    await b.close();
  }
});

test("scheme collision on one key creates one row and an exact key-collision prefix", async () => {
  await reset();
  const tcp = await startTcpServer();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      `http://127.0.0.1:${tcp.port}\nsocks5://127.0.0.1:${tcp.port}`
    );
    await sub.syncSubscription("s1");
    assert.equal((await rowsForSub("s1")).length, 1);
    const parsed = await detailOf("s1");
    assert.equal(parsed?.code, "LOCAL_CORE_ENDPOINT_INVALID");
    assert.ok(parsed?.detail?.includes("key-collision:"), `detail: ${parsed?.detail}`);
  } finally {
    await feed.close();
    await tcp.close();
  }
});

test("combined feed lists all three motifs joined in order", async () => {
  await reset();
  const open = await startTcpServer();
  const shut = await closedPort();
  const clash = await startTcpServer();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      [
        `socks5://127.0.0.1:${open.port}`,
        "socks5://192.0.2.1:1080",
        `socks5://127.0.0.1:${shut}`,
        `http://127.0.0.1:${clash.port}`,
        `socks5://127.0.0.1:${clash.port}`,
      ].join("\n")
    );
    await sub.syncSubscription("s1");
    assert.equal((await rowsForSub("s1")).length, 3);
    const parsed = await detailOf("s1");
    assert.equal(parsed?.code, "LOCAL_CORE_ENDPOINT_INVALID");
    const detail = parsed?.detail ?? "";
    const iInvalid = detail.indexOf("invalid:");
    const iUnreachable = detail.indexOf("unreachable:");
    const iCollision = detail.indexOf("key-collision:");
    assert.ok(iInvalid >= 0 && iUnreachable >= 0 && iCollision >= 0, `detail: ${detail}`);
    assert.ok(iInvalid < iUnreachable && iUnreachable < iCollision, `detail: ${detail}`);
    assert.ok(detail.includes(" | "), `detail: ${detail}`);
  } finally {
    await feed.close();
    await open.close();
    await clash.close();
  }
});

test("detail never carries a password or userinfo", async () => {
  await reset();
  const shut = await closedPort();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      `socks5://operator:s3cret@127.0.0.1:${shut}\nsocks5://intruder:hunter2@192.0.2.1:1080`
    );
    await sub.syncSubscription("s1");
    const raw = (await errorOf("s1")) ?? "";
    for (const secret of ["s3cret", "hunter2", "operator@", "intruder@"]) {
      assert.ok(!raw.includes(secret), `leaked ${secret}: ${raw}`);
    }
  } finally {
    await feed.close();
  }
});

test("port-less entry probes the row port, not the probe default", async () => {
  await reset();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    // A listener on the upsert-rule port (8080) proves the verdict came from
    // the row's effective port, not the probe's scheme default (socks5→1080).
    const probe = await new Promise<{ port: number; close: () => Promise<void> }>(
      (resolve, reject) => {
        const srv = net.createServer((sock) => sock.end());
        srv.on("error", reject);
        srv.listen(8080, "127.0.0.1", () =>
          resolve({ port: 8080, close: () => new Promise((r) => srv.close(() => r())) })
        );
      }
    );
    try {
      await insertSubscription("s1", feed.url, "socks5://127.0.0.1");
      await sub.syncSubscription("s1");
      const rows = await rowsForSub("s1");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].port, 8080);
      const warning = await errorOf("s1");
      assert.equal(warning, null, `port-less reachable entry must not warn: ${warning}`);
    } finally {
      await probe.close();
    }
  } finally {
    await feed.close();
  }
});

test("concurrent probes do not stack sequential timeouts", async () => {
  await reset();
  const a = await startTcpServer();
  const b = await startTcpServer();
  const c = await startTcpServer();
  const feed = await startFeedServer(NEEDS_CORE_FEED);
  try {
    await insertSubscription(
      "s1",
      feed.url,
      `socks5://127.0.0.1:${a.port}\nsocks5://127.0.0.1:${b.port}\nsocks5://127.0.0.1:${c.port}`
    );
    const started = Date.now();
    await sub.syncSubscription("s1");
    const elapsed = Date.now() - started;
    assert.equal((await rowsForSub("s1")).length, 3);
    // Three reachable loopback probes fan out: far below one full probe
    // timeout each, let alone three stacked. Generous bound — flakes only if
    // the probes ever serialize again.
    assert.ok(elapsed < 6000, `3 probes took ${elapsed}ms, expected concurrent fan-out`);
  } finally {
    await feed.close();
    await a.close();
    await b.close();
    await c.close();
  }
});
