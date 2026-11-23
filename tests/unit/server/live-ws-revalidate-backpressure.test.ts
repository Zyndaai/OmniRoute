// Live dashboard WebSocket (upstream v3.8.54, #19111 / #19112):
// - the heartbeat re-runs the connect-time credential check, so a key revoked while the
//   socket is open is closed with 4001 at the next heartbeat;
// - a connection whose unsent output passes 4 MiB is dropped, and the welcome backlog
//   replay is bounded to the newest events that fit in 1 MiB.
import { after, before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { WebSocket } from "ws";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-live-ws-revalidate-"));
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  JWT_SECRET: process.env.JWT_SECRET,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
  LIVE_WS_HOST: process.env.LIVE_WS_HOST,
  OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
  ROUTER_API_KEY: process.env.ROUTER_API_KEY,
};
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-live-ws-revalidate";
process.env.API_KEY_SECRET = "test-api-key-secret-live-ws-revalidate";
delete process.env.LIVE_WS_HOST;
delete process.env.OMNIROUTE_API_KEY;
delete process.env.ROUTER_API_KEY;

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const {
  startLiveDashboardServer,
  beginClientRevalidation,
  shouldCloseClientAfterRevalidation,
  isOverOutboundLimit,
  newestWithinBytes,
} = await import("../../../src/server/ws/liveServer.ts");

const HEARTBEAT_MS = 15_000;
const SETTLE_MS = 5_000;
const opened: WebSocket[] = [];

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Could not allocate a port"));
      });
    });
  });
}

type Frame = { type: string; code?: string; message?: string };

function connect(port: number, headers: Record<string, string>) {
  return new Promise<{ ws: WebSocket; frames: Frame[]; closed: Promise<number> }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live-ws`, {
      origin: "http://127.0.0.1:20128",
      headers,
    });
    opened.push(ws);
    const frames: Frame[] = [];
    const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
    ws.once("open", () => ws.send(JSON.stringify({ type: "subscribe", channels: ["requests"] })));
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      frames.push(frame);
      if (frame.type === "welcome") resolve({ ws, frames, closed });
    });
    ws.on("error", () => {});
  });
}

function closeCodeWithin(closed: Promise<number>, ms: number): Promise<number | "open"> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    closed.finally(() => clearTimeout(timer)),
    new Promise<"open">((resolve) => {
      timer = setTimeout(() => resolve("open"), ms);
    }),
  ]);
}

describe("LiveWS heartbeat credential re-check", () => {
  let server: import("http").Server | null = null;
  let port = 0;

  before(async () => {
    core.resetDbInstance();
    await updateSettings({ requireLogin: true, password: "hashed-password-for-test" });
    port = await getFreePort();
    // Only setInterval is mocked so the 15 s heartbeat is stepped exactly.
    mock.timers.enable({ apis: ["setInterval"] });
    server = await startLiveDashboardServer(port, "127.0.0.1");
  });

  after(async () => {
    mock.timers.reset();
    for (const ws of opened) ws.terminate();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    apiKeysDb.resetApiKeyState();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a key revoked while connected is closed with 4001 at the next heartbeat", async () => {
    const revoked = await apiKeysDb.createApiKey("revoked-live", "machine-live-ws", ["manage"]);
    const control = await apiKeysDb.createApiKey("control-live", "machine-live-ws", ["manage"]);
    const a = await connect(port, { authorization: `Bearer ${revoked.key}` });
    const b = await connect(port, { authorization: `Bearer ${control.key}` });

    mock.timers.tick(HEARTBEAT_MS);
    assert.equal(await closeCodeWithin(a.closed, 300), "open", "closed while key was valid");

    await apiKeysDb.revokeApiKey(revoked.id);
    mock.timers.tick(HEARTBEAT_MS);
    assert.equal(await closeCodeWithin(a.closed, SETTLE_MS), 4001);
    assert.equal(a.frames.filter((f) => f.type === "error").at(-1)?.code, "UNAUTHORIZED");
    assert.equal(b.ws.readyState, WebSocket.OPEN, "control connection was closed");
  });
});

describe("LiveWS revalidation guards", () => {
  test("beginClientRevalidation refuses a second in-flight check", () => {
    const client = { revalidating: false };
    assert.equal(beginClientRevalidation(client), true);
    assert.equal(beginClientRevalidation(client), false);
    client.revalidating = false;
    assert.equal(beginClientRevalidation(client), true);
  });

  test("shouldCloseClientAfterRevalidation skips authorized and replaced clients", () => {
    const client = { id: "old" };
    const replacement = { id: "new" };
    const map = new Map<string, object>([["c1", client]]);
    assert.equal(shouldCloseClientAfterRevalidation(true, "c1", client, map), false);
    assert.equal(shouldCloseClientAfterRevalidation(false, "c1", client, map), true);
    map.set("c1", replacement);
    assert.equal(shouldCloseClientAfterRevalidation(false, "c1", client, map), false);
    map.delete("c1");
    assert.equal(shouldCloseClientAfterRevalidation(false, "c1", client, map), false);
  });
});

describe("LiveWS outbound backpressure", () => {
  test("isOverOutboundLimit trips just past 4 MiB", () => {
    assert.equal(isOverOutboundLimit(4 * 1024 * 1024), false);
    assert.equal(isOverOutboundLimit(4 * 1024 * 1024 + 1), true);
  });

  test("newestWithinBytes keeps the newest entries that fit, oldest first, without gaps", () => {
    const entries = ["a".repeat(98), "b".repeat(98), "c".repeat(98)]; // 100 bytes each as JSON
    assert.deepEqual(newestWithinBytes(entries, 250), [entries[1], entries[2]]);
    assert.deepEqual(newestWithinBytes(entries, 1000), entries);
    assert.deepEqual(newestWithinBytes(entries, 50), []);
  });
});
