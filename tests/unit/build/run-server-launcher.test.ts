import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/dev/run-server.mjs is the single launcher for `npm run dev`, `npm start` and the
// production image (via run-standalone.mjs). It owns the transport and hands every request to the
// server bundle's `app(req, res)` after `await boot()`. These tests start it in `start` mode
// against a stub bundle (OMNIROUTE_BUILD_DIR) that echoes what reached it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LAUNCHER = path.join(ROOT, "scripts/dev/run-server.mjs");

const launcher = await import("../../../scripts/dev/run-server.mjs");

const STUB_BUNDLE = String.raw`
const log = (msg) => process.stdout.write("EVENT " + msg + "\n");
const mode = process.env.STUB_MODE || "normal";
let booted = false;
export async function boot() {
  await new Promise((r) => setTimeout(r, 100));
  booted = true;
  if (mode !== "no-cleanup") {
    globalThis.__omnirouteRequestShutdown = async (signal) => {
      log("cleanup-start " + signal);
      if (mode === "hang") {
        setInterval(() => {}, 1000);
        return new Promise(() => {});
      }
      await new Promise((r) => setTimeout(r, 300));
      log("cleanup-done");
    };
  }
  log("booted");
}
export function app(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      booted,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
      env: {
        NODE_ENV: process.env.NODE_ENV,
        OMNIROUTE_INTERNAL_SCHEME: process.env.OMNIROUTE_INTERNAL_SCHEME,
        OMNIROUTE_BOUND_HOST: process.env.OMNIROUTE_BOUND_HOST,
        OMNIROUTE_PEER_STAMP_TOKEN: process.env.OMNIROUTE_PEER_STAMP_TOKEN,
        OMNIROUTE_WS_BRIDGE_SECRET: Boolean(process.env.OMNIROUTE_WS_BRIDGE_SECRET),
        FROM_DOTENV: process.env.FROM_DOTENV,
        ownsShutdown: globalThis.__omnirouteCustomServerOwnsShutdown === true,
      },
    }));
  });
}
`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

type Started = { child: ChildProcess; port: number; dir: string; output: () => string };

async function startLauncher(env: Record<string, string> = {}): Promise<Started> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-launcher-"));
  fs.mkdirSync(path.join(dir, "bundle", "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bundle", "server", "index.js"), STUB_BUNDLE);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(dir, ".env"), "FROM_DOTENV=from-file\nNODE_ENV=development\n");
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OMNIROUTE_LAUNCHER_ENV_READY: "1",
    OMNIROUTE_APP_DIR: dir,
    OMNIROUTE_BUILD_DIR: path.join(dir, "bundle"),
    DATA_DIR: path.join(dir, "data"),
    PORT: String(port),
    DASHBOARD_PORT: String(port),
    HOST: "127.0.0.1",
    ...env,
  };
  delete childEnv.NOTIFY_SOCKET;
  delete childEnv.OMNIROUTE_PEER_STAMP_TOKEN;
  delete childEnv.FROM_DOTENV;
  delete childEnv.OMNIROUTE_ENABLE_V1_WS;
  const child = spawn(process.execPath, [LAUNCHER, "start"], {
    cwd: dir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 15_000;
  while (!out.includes("server listening on")) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill("SIGKILL");
      throw new Error(`launcher never became ready:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { child, port, dir, output: () => out };
}

async function stop(started: Started) {
  if (started.child.exitCode === null) {
    const exited = new Promise((r) => started.child.once("exit", r));
    started.child.kill("SIGKILL");
    await exited;
  }
  fs.rmSync(started.dir, { recursive: true, force: true });
}

/** Raw HTTP/1.1 exchange, so HEAD bodies and upgrade answers are visible byte for byte. */
async function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.on("data", (d) => (data += d.toString("latin1")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 3000);
  });
}

test("requests reach the bundle after boot, peer-stamped, with the launcher env", async () => {
  const s = await startLauncher();
  try {
    assert.ok(s.output().indexOf("EVENT booted") < s.output().indexOf("server listening on"));
    const res = await fetch(`http://127.0.0.1:${s.port}/api/echo?x=1`, {
      headers: { "x-omniroute-peer-ip": "forged|8.8.8.8" },
    });
    const body = await res.json();
    assert.equal(body.booted, true);
    assert.equal(body.url, "/api/echo?x=1");
    const token = body.env.OMNIROUTE_PEER_STAMP_TOKEN;
    assert.ok(token, "the launcher generates the per-process stamp token");
    assert.equal(body.headers["x-omniroute-peer-ip"], `${token}|127.0.0.1`);
    assert.equal(body.headers["x-omniroute-via-proxy"], `${token}|0`);
    assert.equal(body.env.NODE_ENV, "production", "the run mode wins over .env");
    assert.equal(body.env.FROM_DOTENV, "from-file", ".env in the app dir is loaded");
    assert.equal(body.env.OMNIROUTE_INTERNAL_SCHEME, "http");
    assert.equal(body.env.OMNIROUTE_BOUND_HOST, "127.0.0.1");
    assert.equal(body.env.OMNIROUTE_WS_BRIDGE_SECRET, true);
    assert.equal(body.env.ownsShutdown, true);

    // A streamed body must reach the bundle whole: no layer may defer the handoff past the
    // first chunk (multipart uploads used to hang that way).
    const streamed = await fetch(`http://127.0.0.1:${s.port}/api/upload`, {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("part-1,"));
          controller.enqueue(new TextEncoder().encode("part-2"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    assert.equal((await streamed.json()).body, "part-1,part-2");
  } finally {
    await stop(s);
  }
});

test("transport guards answer before the bundle", async () => {
  const s = await startLauncher();
  try {
    const trace = await rawRequest(s.port, "TRACE /api/x HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.match(trace, /^HTTP\/1\.1 405 /);
    assert.match(trace, /METHOD_NOT_ALLOWED/);

    const login = await fetch(`http://127.0.0.1:${s.port}/api/auth/login`, { method: "GET" });
    assert.equal(login.status, 405);
    assert.equal(login.headers.get("allow"), "POST");

    const head = await rawRequest(s.port, "HEAD /api/echo HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.match(head, /^HTTP\/1\.1 200 /);
    assert.match(head, /Connection: close/i);
    assert.equal(head.slice(head.indexOf("\r\n\r\n") + 4), "", "HEAD carries no body");

    const big = await rawRequest(
      s.port,
      "POST /api/echo HTTP/1.1\r\nHost: x\r\nContent-Length: 999999999999\r\n\r\n"
    );
    assert.match(big, /^HTTP\/1\.1 413 /);

    const webdav = await rawRequest(
      s.port,
      "PROPFIND /api/v1/webdav/ HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n"
    );
    assert.match(webdav, /^HTTP\/1\.1 503 /, "WebDAV is intercepted in front of the bundle");
  } finally {
    await stop(s);
  }
});

test("upgrades: h2c is served as HTTP/1.1, unclaimed WebSockets get 404", async () => {
  const s = await startLauncher();
  try {
    const h2c = await rawRequest(
      s.port,
      "POST /api/echo HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, HTTP2-Settings\r\n" +
        "Upgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQCAAAAAAIAAAAA\r\nContent-Length: 2\r\n\r\nhi"
    );
    assert.match(h2c, /^HTTP\/1\.1 200 /);
    assert.match(h2c, /"method":"POST"/);
    assert.match(h2c, /"body":"hi"/);

    const ws = await rawRequest(
      s.port,
      "GET /not-a-socket HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    assert.match(ws, /^HTTP\/1\.1 404 /);

    // The /v1/ws bridge is off in start mode unless OMNIROUTE_ENABLE_V1_WS is set.
    const bridge = await rawRequest(
      s.port,
      "GET /v1/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    assert.match(bridge, /^HTTP\/1\.1 404 /);
  } finally {
    await stop(s);
  }
});

test("the /v1/ws bridge runs in dev, and in start only when enabled", () => {
  assert.equal(launcher.isV1WsBridgeEnabled("dev", {}), true);
  assert.equal(launcher.isV1WsBridgeEnabled("start", {}), false);
  assert.equal(launcher.isV1WsBridgeEnabled("start", { OMNIROUTE_ENABLE_V1_WS: "1" }), true);
  assert.equal(launcher.isV1WsBridgeEnabled("start", { OMNIROUTE_ENABLE_V1_WS: "false" }), false);
});

// Windows has no POSIX signals: child.kill("SIGTERM"/"SIGINT") terminates the child outright,
// so handlers (and the cleanup they run) never get a chance to execute.
const posixSignals = process.platform === "win32" && "POSIX signal semantics";

async function signalAndWait(s: Started, signals: NodeJS.Signals[]) {
  const exited = new Promise<{ code: number | null }>((resolve) =>
    s.child.once("exit", (code) => resolve({ code }))
  );
  const sentAt = Date.now();
  for (const sig of signals) s.child.kill(sig);
  const killer = setTimeout(() => s.child.kill("SIGKILL"), 15_000);
  const { code } = await exited;
  clearTimeout(killer);
  const events = s
    .output()
    .split("\n")
    .filter((l) => l.startsWith("EVENT "))
    .map((l) => l.slice("EVENT ".length));
  return { code, events, ms: Date.now() - sentAt };
}

test("SIGTERM: application cleanup finishes before exit", { skip: posixSignals }, async () => {
  const s = await startLauncher();
  try {
    const r = await signalAndWait(s, ["SIGTERM"]);
    assert.equal(r.code, 0);
    assert.ok(r.events.includes("cleanup-start SIGTERM"), `${r.events}`);
    assert.ok(r.events.includes("cleanup-done"), `${r.events}`);
    assert.ok(r.ms < 5_000, `took ${r.ms} ms`);
  } finally {
    await stop(s);
  }
});

test("duplicate signals do not cut cleanup short", { skip: posixSignals }, async () => {
  const s = await startLauncher();
  try {
    const r = await signalAndWait(s, ["SIGINT", "SIGTERM"]);
    assert.equal(r.code, 0);
    assert.ok(r.events.includes("cleanup-done"), `${r.events}`);
  } finally {
    await stop(s);
  }
});

test("a signal without registered cleanup exits promptly", { skip: posixSignals }, async () => {
  const s = await startLauncher({ STUB_MODE: "no-cleanup" });
  try {
    const r = await signalAndWait(s, ["SIGTERM"]);
    assert.equal(r.code, 0);
    assert.ok(r.ms < 3_000, `took ${r.ms} ms`);
  } finally {
    await stop(s);
  }
});

test(
  "a cleanup that never settles is bounded by the force-exit timer",
  {
    skip: posixSignals,
  },
  async () => {
    const s = await startLauncher({ STUB_MODE: "hang", SHUTDOWN_TIMEOUT_MS: "100" });
    try {
      const r = await signalAndWait(s, ["SIGTERM"]);
      assert.ok(!r.events.includes("cleanup-done"));
      assert.equal(r.code, 0);
      assert.ok(r.ms >= 4_000 && r.ms < 9_000, `force exit expected at ~5.1 s, took ${r.ms} ms`);
    } finally {
      await stop(s);
    }
  }
);

test("loadEnvFiles: mode-specific precedence, never overrides a present key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-envfiles-"));
  try {
    fs.writeFileSync(path.join(dir, ".env"), "A=env\nB=env\nC=env\nD=env\nE=env\n");
    fs.writeFileSync(path.join(dir, ".env.production"), "A=prod\nB=prod\nC=prod\n");
    fs.writeFileSync(path.join(dir, ".env.local"), "A=local\nB=local\n");
    fs.writeFileSync(path.join(dir, ".env.production.local"), "A=prodlocal\n");
    fs.writeFileSync(path.join(dir, ".env.development"), "D=dev\n");
    const env: Record<string, string | undefined> = { E: "", PRESET: "keep" };
    const loaded = launcher.loadEnvFiles(dir, "start", env);
    assert.deepEqual(loaded, [".env.production.local", ".env.local", ".env.production", ".env"]);
    assert.equal(env.A, "prodlocal");
    assert.equal(env.B, "local");
    assert.equal(env.C, "prod");
    assert.equal(env.D, "env", ".env.development is not read in start mode");
    assert.equal(env.E, "", "an empty value already set is kept");
    assert.equal(env.PRESET, "keep");

    const devEnv: Record<string, string | undefined> = {};
    launcher.loadEnvFiles(dir, "dev", devEnv);
    assert.equal(devEnv.D, "dev");
    assert.equal(devEnv.A, "local");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bind host, port, bundle path and body ceiling resolve from env", () => {
  assert.equal(launcher.resolveBindHost({ HOST: "127.0.0.1", HOSTNAME: "0.0.0.0" }), "127.0.0.1");
  assert.equal(launcher.resolveBindHost({ HOSTNAME: "::" }), "::");
  assert.equal(launcher.resolveBindHost({}), "0.0.0.0");
  assert.equal(launcher.resolveListenPort({ PORT: "1", DASHBOARD_PORT: "2" }), 2);
  assert.equal(launcher.resolveListenPort({}), 20128);
  assert.equal(
    launcher.resolveServerBundlePath("/app", {}),
    path.join(path.resolve("/app", ".build/app"), "server", "index.js")
  );
  assert.equal(
    launcher.resolveServerBundlePath("/app", { OMNIROUTE_BUILD_DIR: "out" }),
    path.join(path.resolve("/app", "out"), "server", "index.js")
  );
  assert.equal(launcher.resolveMaxRequestBodyBytes({}), 512 * 1024 * 1024);
  assert.equal(launcher.resolveMaxRequestBodyBytes({ OMNIROUTE_MAX_REQUEST_BODY_MB: "0" }), 0);
  assert.equal(launcher.deriveLiveWsPath({}), "/live-ws");
  assert.equal(
    launcher.deriveLiveWsPath({ NEXT_PUBLIC_LIVE_WS_PUBLIC_URL: "wss://h.example/ws/live" }),
    "/ws/live"
  );
});
