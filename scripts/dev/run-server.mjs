#!/usr/bin/env node
// OmniRoute HTTP launcher: `node scripts/dev/run-server.mjs [start|dev]` (default `start`).
//
// This process owns the transport (listener, TLS, timeouts, method/HEAD/h2c guards, peer-IP
// stamp, WebSocket upgrades, shutdown signals, systemd notify) and hands every HTTP request to the
// server bundle's `app(req, res)` after `await boot()`:
//   start  `<app root>/.build/app/server/index.js` (OMNIROUTE_BUILD_DIR overrides `.build/app`).
//   dev    `src/server/app.ts` through Vite in middleware mode (Vite's middlewares first).
// The process first changes to the app root (OMNIROUTE_APP_DIR, default two levels above this
// file): runtime code reads migrations, docs, public files and worker bundles relative to
// process.cwd(), and callers (PM2, the CLI supervisor, Docker) start it from different
// directories.
//
// Environment: unless OMNIROUTE_LAUNCHER_ENV_READY=1 (set by run-standalone.mjs, which already
// did it), the launcher bootstraps secrets/ports itself (bootstrap-env.mjs). It then loads the
// app-dir `.env` files without overriding variables that are already set.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { exitWithParent } from "../build/runtime-env.mjs";
import { createOmnirouteWsBridge } from "./v1-ws-bridge.mjs";
import { createResponsesWsProxy } from "./responses-ws-proxy.mjs";
import { ensurePeerStampToken, stampPeerIp } from "./peer-stamp.mjs";
import { maybeHandleWebdav, WEBDAV_PREFIX } from "./webdav-handler.mjs";
import methodGuard from "./http-method-guard.cjs";
import headResponseGuard from "./head-response-guard.cjs";
import h2cUpgradeGuard from "./h2c-upgrade-guard.cjs";
import { resolveTlsOptions, createServerListener } from "./tls-options.mjs";
import { getMainServerTimeoutConfig } from "./main-server-timeouts.mjs";
import { createSystemdNotifier } from "./systemd-notify.mjs";
import { attachRequestStreamGuards, installProcessCrashGuard } from "./httpClientAbortGuard.mjs";
import { listenWithRetry } from "./listen-with-retry.mjs";

const { maybeHandleDisallowedMethod } = methodGuard;
const { wrapRequestListenerWithHeadResponseGuard } = headResponseGuard;
const { handleH2cUpgrade } = h2cUpgradeGuard;

/** Set by a parent wrapper (run-standalone.mjs) that already merged bootstrap env and ports. */
export const LAUNCHER_ENV_READY = "OMNIROUTE_LAUNCHER_ENV_READY";

/** Default request body ceiling; large file uploads (/v1/files) must still fit. */
export const DEFAULT_MAX_REQUEST_BODY_MB = 512;

/**
 * The `.env` files read from the app dir, highest priority first (the first file that defines a
 * key wins), matching the dotenv convention the app was configured with.
 */
export function envFilesForMode(mode) {
  const nodeEnv = mode === "dev" ? "development" : "production";
  return [`.env.${nodeEnv}.local`, ".env.local", `.env.${nodeEnv}`, ".env"];
}

/**
 * Load `.env` files from `dir` into `env` without overriding any key that is already present,
 * including keys set to the empty string (the E2E open mode blanks credentials on purpose).
 * Variable expansion (`$OTHER`) is not performed. Returns the files that were read.
 */
export function loadEnvFiles(
  dir,
  mode,
  env = process.env,
  { readFileSync = fs.readFileSync } = {}
) {
  const loaded = [];
  const fromFiles = {};
  for (const file of envFilesForMode(mode)) {
    let contents;
    try {
      contents = readFileSync(path.join(dir, file), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EISDIR") {
        console.warn(`[env] could not read ${file}: ${error?.code || error?.message || error}`);
      }
      continue;
    }
    let parsed;
    try {
      parsed = parseEnv(contents);
    } catch (error) {
      console.warn(`[env] could not parse ${file}: ${error?.message || error}`);
      continue;
    }
    loaded.push(file);
    for (const [key, value] of Object.entries(parsed)) {
      if (!Object.hasOwn(fromFiles, key)) fromFiles[key] = value;
    }
  }
  for (const [key, value] of Object.entries(fromFiles)) {
    if (env[key] === undefined) env[key] = value;
  }
  return loaded;
}

/** Interface the listener binds: HOST, then HOSTNAME (Docker, CLI, bootstrap), then all. */
export function resolveBindHost(env = process.env) {
  return env.HOST || env.HOSTNAME || "0.0.0.0";
}

export function resolveListenPort(env = process.env) {
  const parsed = Number.parseInt(env.DASHBOARD_PORT || env.PORT || "20128", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20128;
}

/** Bytes; 0 disables the check. */
export function resolveMaxRequestBodyBytes(env = process.env) {
  const raw = env.OMNIROUTE_MAX_REQUEST_BODY_MB;
  const mb = raw == null || raw.trim() === "" ? DEFAULT_MAX_REQUEST_BODY_MB : Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return DEFAULT_MAX_REQUEST_BODY_MB * 1024 * 1024;
  return Math.floor(mb * 1024 * 1024);
}

/** Server bundle entry for production, honouring OMNIROUTE_BUILD_DIR (relative to cwd). */
export function resolveServerBundlePath(cwd = process.cwd(), env = process.env) {
  return path.join(
    path.resolve(cwd, env.OMNIROUTE_BUILD_DIR || ".build/app"),
    "server",
    "index.js"
  );
}

/** `/live-ws`, or the path of NEXT_PUBLIC_LIVE_WS_PUBLIC_URL when that is a ws(s) URL. */
export function deriveLiveWsPath(env = process.env) {
  const publicUrl = env.NEXT_PUBLIC_LIVE_WS_PUBLIC_URL;
  if (!publicUrl) return "/live-ws";
  if (!publicUrl.startsWith("ws://") && !publicUrl.startsWith("wss://")) return "/live-ws";
  try {
    const pathname = new URL(publicUrl).pathname;
    return pathname && pathname !== "/" ? pathname : "/live-ws";
  } catch {
    return "/live-ws";
  }
}

function sendJsonError(res, status, code, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: { code, message } }));
}

/** Answers 413 when Content-Length exceeds the ceiling. Returns true when it answered. */
export function maybeRejectOversizedBody(req, res, maxBytes) {
  if (!maxBytes) return false;
  const declared = Number(req.headers["content-length"]);
  if (!Number.isFinite(declared) || declared <= maxBytes) return false;
  res.setHeader("Connection", "close");
  sendJsonError(res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  return true;
}

function proxyLiveWs(req, socket, head) {
  const targetPort = Number.parseInt(process.env.LIVE_WS_PORT || "20132", 10);
  const targetSocket = net.connect(targetPort, "127.0.0.1", () => {
    let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [key, val] of Object.entries(req.headers)) {
      if (Array.isArray(val)) {
        for (const v of val) rawRequest += `${key}: ${v}\r\n`;
      } else {
        rawRequest += `${key}: ${val}\r\n`;
      }
    }
    rawRequest += "\r\n";
    targetSocket.write(rawRequest);
    if (head && head.length > 0) targetSocket.write(head);
    targetSocket.pipe(socket);
    socket.pipe(targetSocket);
  });
  targetSocket.on("error", () => !socket.destroyed && socket.destroy());
  socket.on("error", () => !targetSocket.destroyed && targetSocket.destroy());
}

function rejectUpgrade(socket) {
  if (socket.destroyed) return;
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function isViteHmrUpgrade(req) {
  const protocol = req.headers["sec-websocket-protocol"];
  return protocol === "vite-hmr" || protocol === "vite-ping";
}

/** Data dir pre-read from ./.env so bootstrap resolves the operator's chosen DATA_DIR. */
function preReadDataDir() {
  if (process.env.DATA_DIR) return;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    const value = parseEnv(raw).DATA_DIR;
    if (value?.trim()) process.env.DATA_DIR = value.trim();
  } catch {
    // No readable .env: bootstrap falls back to the default data dir.
  }
}

async function prepareEnvironment(mode) {
  if (process.env[LAUNCHER_ENV_READY] !== "1") {
    preReadDataDir();
    if (mode === "dev") {
      // The env bootstrap and the WebDAV handler load better-sqlite3; rebuild it after a Node
      // version switch. No-op when the ABI matches.
      const { ensureNativeSqlite } = await import("./ensure-native-sqlite.mjs");
      ensureNativeSqlite();
    }
    const { bootstrapEnv } = await import("../build/bootstrap-env.mjs");
    const { resolveRuntimePorts, withRuntimePortEnv } = await import("../build/runtime-env.mjs");
    const bootstrapped = bootstrapEnv();
    const merged = withRuntimePortEnv(bootstrapped, resolveRuntimePorts(bootstrapped));
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined) process.env[key] = value;
    }
  }

  // `.env` may say NODE_ENV=production (the shipped example does); the run mode decides.
  process.env.NODE_ENV = mode === "dev" ? "development" : "production";

  // E2E open-mode bootstrap (#11535): harnesses rely on an auth-disabled bootstrap so management
  // endpoints are exercised unauthenticated. bootstrap-env drops empty values, so a blank
  // credential cannot survive the merge above; set them to "" here (not deleted) so the `.env`
  // loader below, which never overrides a present key, cannot bring a real password back.
  if (process.env.OMNIROUTE_E2E_BOOTSTRAP_MODE === "open") {
    process.env.INITIAL_PASSWORD = "";
    process.env.OMNIROUTE_E2E_PASSWORD = "";
    process.env.OMNIROUTE_API_KEY = "";
  }

  loadEnvFiles(process.cwd(), mode);
}

/**
 * Loads `{ app, boot }`. Development returns a per-request loader so Vite serves edited modules;
 * production imports the bundle once.
 */
async function loadServerModule(mode, httpServer) {
  if (mode === "dev") {
    const vite = await import("vite");
    const viteDevServer = await vite.createServer({
      // HMR shares this listener (the upgrade dispatcher leaves `vite-hmr` sockets to Vite), so
      // no second port is opened.
      server: { middlewareMode: true, ws: { server: httpServer } },
    });
    const load = () => viteDevServer.ssrLoadModule("./src/server/app.ts");
    return { viteDevServer, load, initial: await load() };
  }
  const bundlePath = resolveServerBundlePath();
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Server bundle not found at ${bundlePath}. Run \`npm run build\` first.`);
  }
  const mod = await import(pathToFileURL(bundlePath).href);
  return { viteDevServer: null, load: null, initial: mod };
}

/** The directory holding package.json, scripts/ and the build. */
/** Whether the `/v1/ws` WebSocket bridge runs: always in dev, opt-in in `start`. */
export function isV1WsBridgeEnabled(mode, env = process.env) {
  return mode === "dev" || /^(1|true|yes|on)$/i.test(String(env.OMNIROUTE_ENABLE_V1_WS ?? ""));
}

export function resolveAppRoot(env = process.env) {
  return env.OMNIROUTE_APP_DIR
    ? path.resolve(env.OMNIROUTE_APP_DIR)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

async function main() {
  const mode = process.argv[2] === "dev" ? "dev" : "start";
  process.chdir(resolveAppRoot());
  process.title = "omniroute";
  await prepareEnvironment(mode);

  // A client abort or a recoverable upstream timeout must not become an uncaughtException that
  // takes the whole server down (#12861). Genuine bugs still crash loudly.
  installProcessCrashGuard();

  // systemd sd_notify: this process owns READY and the watchdog pings, so a frozen event loop
  // stops the pings. No-op without NOTIFY_SOCKET. Created after the env merge so
  // OMNIROUTE_DISABLE_SD_NOTIFY from `.env` is honoured.
  const systemdNotifier = createSystemdNotifier();

  // Opt-in native HTTPS (#5242): both OMNIROUTE_TLS_CERT and OMNIROUTE_TLS_KEY readable, else HTTP.
  const tlsOptions = resolveTlsOptions(process.env);
  process.env.OMNIROUTE_INTERNAL_SCHEME = tlsOptions ? "https" : "http";
  if (tlsOptions) {
    console.log(`[omniroute][tls] HTTPS enabled; terminating TLS with cert=${tlsOptions.certPath}`);
  }

  const port = resolveListenPort();
  const hostname = resolveBindHost();
  // In-process code (src/lib/startup/nonLoopbackApiKeyGuard.ts) warns about an exposed anonymous
  // /v1 based on the interface actually bound (#13695).
  process.env.OMNIROUTE_BOUND_HOST = hostname;
  process.env.OMNIROUTE_WS_BRIDGE_SECRET ||= randomUUID();
  // Per-process secret proving the trusted peer-IP stamp came from this server (peer-stamp.mjs).
  ensurePeerStampToken();
  // This launcher owns process exit: initGracefulShutdown() registers its cleanup as
  // globalThis.__omnirouteRequestShutdown instead of installing competing signal handlers.
  globalThis.__omnirouteCustomServerOwnsShutdown = true;

  const maxBodyBytes = resolveMaxRequestBodyBytes();
  let handleAppRequest = (_req, res) => sendJsonError(res, 503, "STARTING", "Server is starting");

  const handleWithBody = (req, res) => {
    if (maybeRejectOversizedBody(req, res, maxBodyBytes)) return;
    // The app decides LOCAL_ONLY locality from the real TCP peer, never from the Host header.
    stampPeerIp(req);
    handleAppRequest(req, res);
  };

  const requestListener = wrapRequestListenerWithHeadResponseGuard((req, res) => {
    attachRequestStreamGuards(req, res);
    if (maybeHandleDisallowedMethod(req, res)) return;
    if (!(req.url || "").startsWith(WEBDAV_PREFIX)) {
      handleWithBody(req, res);
      return;
    }
    // WebDAV (Obsidian sync) is served here with its own auth and PUT cap; anything it does not
    // claim, or a failure inside it, falls through to the app.
    maybeHandleWebdav(req, res).then(
      (handled) => {
        if (!handled) handleWithBody(req, res);
      },
      () => {
        if (!res.headersSent && !res.writableEnded) handleWithBody(req, res);
      }
    );
  });

  const server = createServerListener([requestListener], tlsOptions);

  // Node's default keepAliveTimeout (5 s) races pooled keep-alive clients such as the JDK
  // HttpClient, which reuse a socket the server already closed and read 0 bytes (#7003).
  const timeouts = getMainServerTimeoutConfig();
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.headersTimeout = timeouts.headersTimeoutMs;
  if (timeouts.tcpKeepAliveInitialDelayMs > 0) {
    server.on("connection", (socket) => {
      socket.setKeepAlive(true, timeouts.tcpKeepAliveInitialDelayMs);
    });
  }

  const internalBaseUrl = `http://127.0.0.1:${port}`;
  const responsesWsProxy = createResponsesWsProxy({
    baseUrl: internalBaseUrl,
    bridgeSecret: process.env.OMNIROUTE_WS_BRIDGE_SECRET,
  });
  // The OpenAI-compatible `/v1/ws` bridge serves external WebSocket clients; the dashboard only
  // uses the HTTP handshake route. It runs in development, and in `start` (the production image,
  // PM2, `npm start`) only when OMNIROUTE_ENABLE_V1_WS=1.
  const wsBridge = isV1WsBridgeEnabled(mode)
    ? createOmnirouteWsBridge({ baseUrl: internalBaseUrl })
    : null;
  const liveWsPath = deriveLiveWsPath();

  server.on("upgrade", async (req, socket, head) => {
    try {
      // Cleartext `Upgrade: h2c` (JDK HttpClient) is not a WebSocket upgrade: serve as HTTP/1.1.
      if (handleH2cUpgrade(server, req, socket, head)) return;
      // Vite's own upgrade listener on this server answers its HMR sockets.
      if (mode === "dev" && isViteHmrUpgrade(req)) return;
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname === liveWsPath || pathname.startsWith(`${liveWsPath}/`)) {
        proxyLiveWs(req, socket, head);
        return;
      }
      if (await responsesWsProxy.handleUpgrade(req, socket, head)) return;
      if (wsBridge && (await wsBridge.handleUpgrade(req, socket, head))) return;
      rejectUpgrade(socket);
    } catch (error) {
      if (!socket.destroyed) socket.destroy(error instanceof Error ? error : undefined);
      console.error("[WS] Upgrade handling failed:", error?.message ?? error);
    }
  });

  let viteDevServer = null;
  let shutdownStarted = false;
  const shutdown = async (signal) => {
    // Duplicate signals are normal (a terminal Ctrl+C reaches this process and the parent
    // wrapper, which forwards it too); the force-exit timer bounds the whole sequence.
    if (shutdownStarted) return;
    shutdownStarted = true;
    const drainMs = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "30000", 10);
    // gracefulShutdown waits up to SHUTDOWN_TIMEOUT_MS for in-flight requests; the margin covers
    // the flush/checkpoint work after it.
    const forceExitMs = (Number.isFinite(drainMs) && drainMs >= 0 ? drainMs : 30000) + 5000;
    const forceExitTimer = setTimeout(() => {
      console.warn(`[Shutdown] Cleanup still running after ${forceExitMs}ms; forcing exit.`);
      process.exit(0);
    }, forceExitMs);
    forceExitTimer.unref?.();
    systemdNotifier.stopping();
    try {
      // Stop accepting connections; in-flight requests keep running until the drain below.
      if (server.listening) server.close(() => {});
      server.closeIdleConnections?.();
    } catch (error) {
      console.error("[Shutdown] Closing the HTTP server failed:", error?.message ?? error);
    }
    try {
      // Undefined when boot never got that far (signal during startup): just exit.
      await globalThis.__omnirouteRequestShutdown?.(signal);
      await viteDevServer?.close();
    } catch (error) {
      console.error("[Shutdown] Cleanup failed during", signal, error?.message ?? error);
    } finally {
      clearTimeout(forceExitTimer);
      // One macrotask before exit (#13306: let libuv teardown settle on Windows).
      setTimeout(() => process.exit(0), 0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // #8045: Windows maps console-window close to SIGHUP.
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  // Started by run-standalone.mjs (Docker CMD, PM2): if the launcher is killed outright, shut
  // down with it instead of holding the port as an unmanaged orphan.
  exitWithParent(() => void shutdown("parent-exit"));

  const loaded = await loadServerModule(mode, server);
  viteDevServer = loaded.viteDevServer;

  if (viteDevServer) {
    const load = loaded.load;
    handleAppRequest = (req, res) => {
      viteDevServer.middlewares(req, res, () => {
        load()
          .then((mod) => mod.app(req, res))
          .catch((error) => {
            if (error instanceof Error) viteDevServer.ssrFixStacktrace(error);
            console.error("[dev] Request failed:", error);
            sendJsonError(res, 500, "INTERNAL_ERROR", "Internal server error");
          });
      });
    };
  } else {
    const { app } = loaded.initial;
    handleAppRequest = (req, res) => {
      Promise.resolve()
        .then(() => app(req, res))
        .catch((error) => {
          console.error("[server] Request failed:", error?.message ?? error);
          sendJsonError(res, 500, "INTERNAL_ERROR", "Internal server error");
        });
    };
  }

  try {
    await loaded.initial.boot();
  } catch (error) {
    // The listener still comes up so health routes can report the failure; boot code that must
    // stop the process (cluster fencing) exits on its own.
    console.error("[FATAL] Server boot failed:", error);
  }

  // Bounded EADDRINUSE retry: test harnesses pick the port with a bind(0)-release well before the
  // server binds (base-red #15306).
  try {
    await listenWithRetry(server, { port, host: hostname });
  } catch (error) {
    console.error("[FATAL] HTTP server failed to listen:", error);
    process.exit(1);
  }
  server.on("error", (error) => {
    console.error("[FATAL] HTTP server failed:", error);
    process.exit(1);
  });
  const scheme = tlsOptions ? "https" : "http";
  console.log(`[omniroute] ${mode} server listening on ${scheme}://${hostname}:${port}`);
  systemdNotifier.ready();
  systemdNotifier.startWatchdog();
}

// Compared by real path: Node resolves symlinks for the entry module's URL but not for argv[1],
// and a launcher reached through a symlink must still start.
function isEntryModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  main().catch((error) => {
    console.error("[FATAL] Failed to start the OmniRoute server:", error);
    process.exit(1);
  });
}
