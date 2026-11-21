#!/usr/bin/env node
/**
 * `npm run build`: the React Router build plus the steps it cannot do itself.
 *
 *   1. `react-router build` into OMNIROUTE_BUILD_DIR (default `.build/app`): `client/` (static
 *      files, `public/` included) and `server/index.js` (the app module the launcher imports).
 *   2. The built `client/sw.js` gets the build id and base path, so a new deployment is a new
 *      service-worker generation (browsers compare the worker's bytes, not its URL).
 *   3. Files that must sit at fixed paths under the app's working directory go to
 *      `<buildDir>/app-root/`, laid out exactly as they belong there:
 *        - the three worker entry points the server starts by file path (worker_threads /
 *          child_process), bundled by esbuild because they are not part of the server bundle;
 *        - the Linux TPROXY addon, when it can be built.
 *      A deployment copies `app-root/.` onto the app directory. A source checkout does not need
 *      it: there the runtime finds the `.ts` sources and runs them through tsx.
 *
 * Switches: OMNIROUTE_BUILD_BACKEND_ONLY=1 builds the endpoints without pages;
 * OMNIROUTE_BUILD_PROFILE=minimal compiles four privileged modules out (vite.config.ts);
 * OMNIROUTE_BUILD_MEMORY_MB sets the build heap (default 8192) unless NODE_OPTIONS already does.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "vite";

import { buildTproxyNative } from "./build-tproxy-native.mjs";
import { runBuildTool } from "./buildToolRunner.mjs";
import { normalizeBasePath } from "./normalizeBasePath.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Worker entry points, as paths relative to the app's working directory. */
export const WORKER_ENTRIES = [
  // usage/callLogArtifactWriter.ts → resolveCallLogArtifactWorker()
  "src/lib/usage/callLogArtifactWorker",
  // logExport/childRunner.ts → resolveLogExportChild()
  "src/lib/logExport/exportChild",
  // compression/compressionWorkerPool.ts → resolveWorkerFile()
  "open-sse/services/compression/compressionWorker",
];

const TPROXY_ADDON = "src/mitm/tproxy/native/build/Release/transparent.node";

/** The id stamped into both the browser bundle and `sw.js`; fixed once per build run. */
export function resolveSwBuildId(env = process.env, now = Date.now()) {
  return env.OMNIROUTE_SW_BUILD_ID || env.SOURCE_VERSION || String(now);
}

/** Environment for `react-router build`. */
export function resolveBuildEnv(env = process.env) {
  const buildEnv = { ...env, OMNIROUTE_SW_BUILD_ID: resolveSwBuildId(env) };
  if (!/--max-old-space-size/.test(env.NODE_OPTIONS || "")) {
    const heapMb = Number(env.OMNIROUTE_BUILD_MEMORY_MB) || 8192;
    buildEnv.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --max-old-space-size=${heapMb}`.trim();
  }
  return buildEnv;
}

export function resolveBuildDir(env = process.env, root = ROOT) {
  return resolve(root, env.OMNIROUTE_BUILD_DIR || ".build/app");
}

/**
 * The built service worker: CACHE_NAME carries the build id and BASE_PATH the deploy subpath.
 * Throws when either line is missing so a reworded `public/sw.js` cannot silently ship unstamped.
 */
export function stampServiceWorker(source, { buildId, basePath }) {
  const cacheLine = /^const CACHE_NAME = "omniroute-pwa-v3";$/m;
  const baseLine = /^const BASE_PATH = "";$/m;
  if (!cacheLine.test(source) || !baseLine.test(source)) {
    throw new Error(
      'sw.js must contain `const CACHE_NAME = "omniroute-pwa-v3";` and `const BASE_PATH = "";`'
    );
  }
  return source
    .replace(cacheLine, `const CACHE_NAME = "omniroute-pwa-v3-${buildId}"; // build ${buildId}`)
    .replace(baseLine, `const BASE_PATH = ${JSON.stringify(basePath)};`);
}

/**
 * Each worker is an ES module in a `.js` file; a `{"type":"module"}` package.json beside it
 * makes Node load it as ESM whatever the app directory's own package.json says, and tells
 * compressionWorkerPool.ts that the `.js` is a built worker rather than a source placeholder.
 */
export function writeEsmWorkerScopes(dirs) {
  const written = [];
  for (const dir of new Set(dirs)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) continue;
    writeFileSync(file, `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8");
    written.push(file);
  }
  return written;
}

/** Bundles the worker entry points into `<appRoot>/<entry>.js`; a failure fails the build. */
export function bundleWorkers(appRoot, { root = ROOT, run = runBuildTool } = {}) {
  const dirs = [];
  for (const entry of WORKER_ENTRIES) {
    const outfile = join(appRoot, `${entry}.js`);
    mkdirSync(dirname(outfile), { recursive: true });
    run(
      "esbuild",
      "esbuild",
      [
        join(root, `${entry}.ts`),
        "--bundle",
        "--platform=node",
        "--packages=external",
        "--format=esm",
        `--outfile=${outfile}`,
      ],
      { stdio: "inherit", cwd: root }
    );
    dirs.push(dirname(outfile));
  }
  return writeEsmWorkerScopes(dirs);
}

/**
 * The build's environment: the shell plus the `.env*` files (the shell wins), the same set
 * vite.config.ts reads, so the base path and build id stamped here match the bundles.
 */
export function loadBuildEnvironment(root = ROOT) {
  return loadEnv("production", root, "");
}

/** Extra command-line arguments are passed to `react-router build` (e.g. `--sourcemapServer`). */
export function main(env = loadBuildEnvironment(), extraArgs = process.argv.slice(2)) {
  const buildDir = resolveBuildDir(env);
  const buildEnv = resolveBuildEnv(env);
  const basePath = normalizeBasePath(env.OMNIROUTE_BASE_PATH);
  if (buildEnv.OMNIROUTE_BUILD_BACKEND_ONLY === "1") {
    console.log("[build] OMNIROUTE_BUILD_BACKEND_ONLY=1: endpoints only, no pages");
  }

  runBuildTool("@react-router/dev", "react-router", ["build", ...extraArgs], {
    stdio: "inherit",
    cwd: ROOT,
    env: buildEnv,
  });

  const swFile = join(buildDir, "client", "sw.js");
  writeFileSync(
    swFile,
    stampServiceWorker(readFileSync(swFile, "utf8"), {
      buildId: buildEnv.OMNIROUTE_SW_BUILD_ID,
      basePath,
    })
  );
  console.log(`[build] sw.js stamped with build ${buildEnv.OMNIROUTE_SW_BUILD_ID}`);

  const appRoot = join(buildDir, "app-root");
  bundleWorkers(appRoot);
  console.log(`[build] ${WORKER_ENTRIES.length} workers bundled into ${appRoot}`);

  // Optional: without the addon the TPROXY capture mode reports itself unavailable.
  const tproxy = buildTproxyNative(ROOT);
  if (tproxy.built) {
    const target = join(appRoot, TPROXY_ADDON);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, TPROXY_ADDON), target);
    console.log("[build] TPROXY addon built");
  } else {
    console.log(`[build] TPROXY addon skipped: ${tproxy.reason}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error("[build] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
