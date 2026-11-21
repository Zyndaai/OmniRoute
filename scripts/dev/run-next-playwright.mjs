#!/usr/bin/env node
// Playwright web server: `node scripts/dev/run-next-playwright.mjs <dev|start>`.
// Bootstraps an isolated E2E environment (own DATA_DIR, background services off, a known login
// password or the open bootstrap mode) and runs the launcher (run-server.mjs) in that mode.
// `start` builds first (`npm run build`) unless OMNIROUTE_PLAYWRIGHT_SKIP_BUILD=1.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  resolveRuntimePorts,
  sanitizeColorEnv,
  spawnWithForwardedSignals,
  withRuntimePortEnv,
} from "../build/runtime-env.mjs";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";
import { resolveServerBundlePath } from "./run-server.mjs";

const LAUNCHER = fileURLToPath(new URL("./run-server.mjs", import.meta.url));

export function resolvePlaywrightDataDir({ cwd, env, pid = process.pid }) {
  if (typeof env.DATA_DIR === "string" && env.DATA_DIR.trim().length > 0) {
    return env.DATA_DIR;
  }
  return join(cwd, ".tmp", "playwright-data", String(pid));
}

/** Env for the E2E server process; `bootstrapEnvVars` comes from bootstrapEnv(). */
export function buildPlaywrightServerEnv({ mode, env, bootstrapEnvVars, dataDir, runtimePorts }) {
  const bootstrapMode = env.OMNIROUTE_E2E_BOOTSTRAP_MODE || "auth";
  const password = env.OMNIROUTE_E2E_PASSWORD || env.INITIAL_PASSWORD || "omniroute-e2e-password";
  const serverEnv = {
    ...sanitizeColorEnv(bootstrapEnvVars),
    ...sanitizeColorEnv(env),
    NODE_ENV: mode === "start" ? "production" : "development",
    DATA_DIR: dataDir,
    NEXT_PUBLIC_OMNIROUTE_E2E_MODE: env.NEXT_PUBLIC_OMNIROUTE_E2E_MODE || "1",
    OMNIROUTE_DISABLE_BACKGROUND_SERVICES: env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES || "true",
    OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK: env.OMNIROUTE_DISABLE_TOKEN_HEALTHCHECK || "true",
    OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK: env.OMNIROUTE_DISABLE_LOCAL_HEALTHCHECK || "true",
    OMNIROUTE_HIDE_HEALTHCHECK_LOGS: env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS || "true",
    ...(bootstrapMode === "open"
      ? { INITIAL_PASSWORD: "", OMNIROUTE_E2E_PASSWORD: "", OMNIROUTE_API_KEY: "" }
      : { INITIAL_PASSWORD: password, OMNIROUTE_E2E_PASSWORD: password }),
  };
  return {
    ...withRuntimePortEnv(serverEnv, runtimePorts),
    PORT: String(runtimePorts.dashboardPort),
    HOSTNAME: env.HOSTNAME || "127.0.0.1",
    // The env above is final; the launcher must not bootstrap again.
    OMNIROUTE_LAUNCHER_ENV_READY: "1",
  };
}

function runChild(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    const forward = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });
}

/** Runs `npm run build`, through the npm CLI that started this process when there is one. */
async function runBuild(env) {
  console.log("[Playwright WebServer] Building a fresh app for this run...");
  const npmCli = process.env.npm_execpath;
  const result =
    npmCli && npmCli.endsWith(".js")
      ? await runChild(process.execPath, [npmCli, "run", "build"], { env })
      : await runChild("npm", ["run", "build"], { env, shell: process.platform === "win32" });
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (result.code !== 0) process.exit(result.code);
}

export async function main() {
  const mode = process.argv[2] === "start" ? "start" : "dev";
  const cwd = process.cwd();
  const dataDir = resolvePlaywrightDataDir({ cwd, env: process.env });
  const bootstrapEnvVars = bootstrapEnv({ quiet: true, dataDirOverride: dataDir });
  const runtimePorts = resolveRuntimePorts(bootstrapEnvVars);
  const serverEnv = buildPlaywrightServerEnv({
    mode,
    env: process.env,
    bootstrapEnvVars,
    dataDir,
    runtimePorts,
  });

  if (mode === "start" && process.env.OMNIROUTE_PLAYWRIGHT_SKIP_BUILD !== "1") {
    await runBuild(serverEnv);
  }
  if (mode === "start" && !existsSync(resolveServerBundlePath(cwd, serverEnv))) {
    console.error(
      `[Playwright WebServer] No server bundle at ${resolveServerBundlePath(cwd, serverEnv)}.`
    );
    process.exit(1);
  }

  spawnWithForwardedSignals(process.execPath, [LAUNCHER, mode], {
    stdio: "inherit",
    env: serverEnv,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
