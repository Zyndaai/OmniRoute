#!/usr/bin/env node
// Runs one lane of the node:test unit suite.
//
//   node scripts/dev/run-unit-tests.mjs <main|dashboard|serial> [extra node --test flags]
//
// The folder globs are built from the real subfolders of tests/unit, so a new folder is picked
// up without editing package.json (a folder missing from a hand-written brace list used to stop
// running silently). Globs are passed to node unexpanded: node expands them itself, which keeps
// the command line under the Windows argument limit.
//
// Lanes:
//   main       tests/unit/*.test.ts, every subfolder's **/*.test.ts, and all **/*.test.mjs
//   dashboard  tests/unit/dashboard/**/*.test.ts (loaded with `tsx`, not `tsx/esm`)
//   serial     tests/unit/serial/**/*.test.ts (run with --test-concurrency=1 by the scripts)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNIT = "tests/unit";

// Not part of the main lane: their own lanes (dashboard, serial), Vitest (autoCombo), and
// helper/fixture folders that hold no test files.
const NOT_MAIN = new Set(["dashboard", "serial", "autoCombo", "fixtures", "helpers"]);

export function lanePatterns(lane, root = process.cwd()) {
  if (lane === "dashboard") return [`${UNIT}/dashboard/**/*.test.ts`];
  if (lane === "serial") return [`${UNIT}/serial/**/*.test.ts`];
  if (lane !== "main") throw new Error(`unknown lane "${lane}" (main | dashboard | serial)`);
  const folders = fs
    .readdirSync(path.join(root, UNIT), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !NOT_MAIN.has(d.name))
    .map((d) => d.name)
    .sort();
  return [
    `${UNIT}/*.test.ts`,
    ...folders.map((name) => `${UNIT}/${name}/**/*.test.ts`),
    `${UNIT}/**/*.test.mjs`,
  ];
}

function laneImports(lane) {
  return [
    "--import",
    lane === "dashboard" ? "tsx" : "tsx/esm",
    "--import",
    "./open-sse/utils/setupPolyfill.ts",
    "--import",
    "./tests/_setup/isolateDataDir.ts",
    "--import",
    "./tests/_setup/isolatePostgres.ts",
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lane, ...extra] = process.argv.slice(2);
  let patterns;
  try {
    patterns = lanePatterns(lane);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const args = [
    "--max-old-space-size=8192",
    ...laneImports(lane),
    "--test",
    "--test-force-exit",
    "--test-timeout=60000",
    ...extra,
    ...patterns,
  ];
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
