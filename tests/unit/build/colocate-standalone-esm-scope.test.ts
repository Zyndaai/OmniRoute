import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  WORKER_ENTRIES,
  bundleWorkers,
  writeEsmWorkerScopes,
} from "../../../scripts/build/build.mjs";

/**
 * The built workers are ESM `.js` files that sit under the app's working directory, whose own
 * package.json is CommonJS (or absent). A `"type":"module"` package.json scoped to each
 * worker's directory makes Node load them as ESM without changing how the rest of the tree is
 * parsed; putting it on the app root instead would break every CommonJS file there.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..");

test("writeEsmWorkerScopes writes a scoped type:module beside each worker", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-scope-"));
  try {
    const workerA = join(root, "src", "lib", "usage");
    const workerB = join(root, "open-sse", "services", "compression");
    mkdirSync(workerA, { recursive: true });
    mkdirSync(workerB, { recursive: true });

    const written = writeEsmWorkerScopes([workerA, workerB]);
    assert.equal(written.length, 2, "both worker dirs get a package.json");

    for (const dir of [workerA, workerB]) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      assert.equal(pkg.type, "module", `${dir} declares type:module`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("writeEsmWorkerScopes writes one manifest per directory", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-scope-dedupe-"));
  try {
    const dir = join(root, "src", "lib", "usage");
    mkdirSync(dir, { recursive: true });
    assert.equal(writeEsmWorkerScopes([dir, dir]).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("writeEsmWorkerScopes never touches the app root package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-scope-root-"));
  try {
    const rootPkgPath = join(root, "package.json");
    writeFileSync(rootPkgPath, JSON.stringify({ name: "omniroute" }, null, 2) + "\n");

    const workerDir = join(root, "src", "lib", "usage");
    mkdirSync(workerDir, { recursive: true });
    writeEsmWorkerScopes([workerDir]);

    const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
    assert.equal(rootPkg.type, undefined, "the root stays type-less so its CommonJS files parse");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("writeEsmWorkerScopes is no-clobber: it leaves an existing package.json intact", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-scope-noclobber-"));
  try {
    const workerDir = join(root, "src", "lib", "usage");
    mkdirSync(workerDir, { recursive: true });
    const existing = { name: "already-there", type: "module", version: "9.9.9" };
    writeFileSync(join(workerDir, "package.json"), JSON.stringify(existing, null, 2) + "\n");

    const written = writeEsmWorkerScopes([workerDir]);
    assert.equal(written.length, 0, "existing package.json is not rewritten");

    const pkg = JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8"));
    assert.equal(pkg.version, "9.9.9");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// End-to-end proof under Node's nearest-package.json module resolution: a CommonJS file and an
// ESM worker.js coexist when only the worker directory carries `type: module`.
test("scoped layout runs a CJS entry and an ESM worker.js side by side", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-scope-e2e-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app" }) + "\n");
    writeFileSync(
      join(root, "entry.js"),
      'const path = require("path");\nprocess.stdout.write("CJS_OK:" + path.basename(__filename));\n'
    );

    const workerDir = join(root, "src", "lib", "usage");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "callLogArtifactWorker.js"),
      'import os from "node:os";\nprocess.stdout.write("ESM_OK:" + typeof os.cpus);\n'
    );
    writeEsmWorkerScopes([workerDir]);

    const cjsOut = execFileSync(process.execPath, [join(root, "entry.js")], { encoding: "utf8" });
    assert.match(cjsOut, /CJS_OK:entry\.js/);

    const workerOut = execFileSync(
      process.execPath,
      [join(workerDir, "callLogArtifactWorker.js")],
      { encoding: "utf8" }
    );
    assert.match(workerOut, /ESM_OK:function/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("bundleWorkers runs esbuild once per worker entry and scopes each output directory", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "bundle-workers-fake-"));
  try {
    const calls: string[][] = [];
    const written = bundleWorkers(appRoot, {
      root: "/repo",
      run: (_pkg: string, _bin: string, args: string[]) => {
        calls.push(args);
      },
    });

    assert.equal(calls.length, WORKER_ENTRIES.length);
    for (const [index, entry] of WORKER_ENTRIES.entries()) {
      assert.ok(calls[index].includes("--bundle"));
      assert.ok(calls[index].includes("--packages=external"), "npm packages stay runtime imports");
      assert.ok(calls[index].includes("--format=esm"));
      assert.ok(calls[index].some((arg) => arg.endsWith(`${entry.split("/").pop()}.ts`)));
      assert.ok(existsSync(join(appRoot, entry, "..", "package.json")));
    }
    assert.equal(
      written.length,
      new Set(WORKER_ENTRIES.map((e) => e.split("/").slice(0, -1).join("/"))).size
    );
  } finally {
    rmSync(appRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("bundleWorkers builds the required compression worker with a real esbuild run", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "bundle-workers-real-"));
  try {
    bundleWorkers(appRoot, { root: repoRoot });
    const workerDir = join(appRoot, "open-sse", "services", "compression");
    assert.equal(existsSync(join(workerDir, "compressionWorker.js")), true);
    assert.equal(JSON.parse(readFileSync(join(workerDir, "package.json"), "utf8")).type, "module");
  } finally {
    rmSync(appRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
