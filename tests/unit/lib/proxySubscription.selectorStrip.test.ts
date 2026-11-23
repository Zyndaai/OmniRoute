import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

// RED-first guard: tagged localCoreEndpoint lines must sync exactly like the
// bare URL (byte-identical registry rows), and invalid tags pin the line
// without a fatal error.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-selector-strip-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const sub = await import("../../../src/lib/proxySubscription/index.ts");

async function reset() {
  await resetTestDb();
}

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const NEEDS_CORE_FEED = "ss://YWVzLTI1Ni1nY206cGFzcw@203.0.113.9:8388#ss-node";

async function insertSubscription(id: string, url: string, localCoreEndpoint: string | null) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO proxy_subscriptions
        (id, name, url, enabled, mode, rule_providers, update_interval_minutes, local_core_endpoint, status, created_at, updated_at)
       VALUES ($1, $2, $3, true, 'global', NULL, 60, $4, 'empty', $5, $6)`,
    [id, `sub-${id}`, url, localCoreEndpoint, now, now]
  );
}

test("tagged line syncs the same row as the bare URL", async () => {
  await reset();
  const http = await import("node:http");
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(NEEDS_CORE_FEED);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}/list`;
  try {
    await insertSubscription("s1", url, "socks5://127.0.0.1:1080 selector=group-a");
    const result = await sub.syncSubscription("s1");
    assert.equal(result.status, "ok");
    const rows = await getTestBackend().query<{ host: string; port: number; type: string }>(
      "SELECT host, port, type FROM proxy_registry WHERE subscription_id = 's1'"
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { host: "127.0.0.1", port: 1080, type: "socks5" });
    // No TCP listener on :1080 here, so the probe verdict lands in the warning
    // detail — the row itself is byte-identical to the bare-URL sync.
    assert.match(result.error ?? "", /unreachable: socks5:\/\/127\.0\.0\.1:1080/);
  } finally {
    await new Promise((r) => srv.close(() => r()));
  }
});

test("invalid tag pins the line: invalid warning, no fatal", async () => {
  await reset();
  const http = await import("node:http");
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(NEEDS_CORE_FEED);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  const url = `http://127.0.0.1:${addr.port}/list`;
  try {
    await insertSubscription("s1", url, "socks5://127.0.0.1:1080 selector=../");
    const result = await sub.syncSubscription("s1");
    const rows = await getTestBackend().query<{ id: string }>(
      "SELECT id FROM proxy_registry WHERE subscription_id = 's1'"
    );
    assert.equal(rows.length, 0);
    assert.match(result.error ?? "", /LOCAL_CORE_ENDPOINT_INVALID/);
  } finally {
    await new Promise((r) => srv.close(() => r()));
  }
});
