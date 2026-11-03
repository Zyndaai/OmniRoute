import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  computeDependencyClosure,
  colocateOptionalPackages,
  SEED_PACKAGES,
} from "../../scripts/build/colocateOptionals.mjs";

/** Create a fake installed package with a manifest and optional extra files. */
function mkPkg(
  nmDir: string,
  name: string,
  manifest: Record<string, unknown> = {},
  files: Record<string, string> = {}
): void {
  const dir = join(nmDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  for (const [rel, content] of Object.entries(files)) {
    const fp = join(dir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
}

/**
 * Root tree with the real optional shape: js-tiktoken → dep base64-js, plus an
 * unrelated peer that must not be pulled in. Each package has a resolvable
 * entrypoint because isPackageIntact checks entrypoint integrity.
 */
function buildRoot(rootDir: string): void {
  const rootNm = join(rootDir, "node_modules");
  mkPkg(
    rootNm,
    "js-tiktoken",
    {
      main: "dist/index.js",
      dependencies: { "base64-js": "^1.5.1" },
      peerDependencies: { "some-peer": "*" },
    },
    { "dist/index.js": "export const tiktoken = true;\n" }
  );
  mkPkg(rootNm, "base64-js", { main: "index.js" }, { "index.js": "export const base64 = true;\n" });
  mkPkg(rootNm, "some-peer", { version: "5.0.0" });
}

test("SEED_PACKAGES is the js-tiktoken token counter", () => {
  assert.deepEqual(SEED_PACKAGES, ["js-tiktoken"]);
});

test("computeDependencyClosure walks deps transitively and skips peers", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-colocate-closure-"));
  try {
    buildRoot(root);
    const closure = computeDependencyClosure(join(root, "node_modules"));
    assert.deepEqual(closure, ["js-tiktoken", "base64-js"]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("colocateOptionalPackages copies the closure and never clobbers a traced package", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-colocate-copy-"));
  try {
    buildRoot(root);
    const distNm = join(root, "dist", "node_modules");
    // The trace already materialized base64-js at a different version — it must survive.
    mkPkg(distNm, "base64-js", { main: "index.js", version: "9.9.9" }, { "index.js": "" });

    const result = colocateOptionalPackages({ rootDir: root });
    assert.equal(result.skipped, false);

    assert.ok(existsSync(join(distNm, "js-tiktoken", "dist", "index.js")), "payload copied");
    const traced = JSON.parse(readFileSync(join(distNm, "base64-js", "package.json"), "utf8"));
    assert.equal(traced.version, "9.9.9", "a traced package is never overwritten");
    assert.ok(!existsSync(join(distNm, "some-peer")), "peers are not co-located");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("colocateOptionalPackages is idempotent (second run is a no-op)", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-colocate-idem-"));
  try {
    buildRoot(root);
    mkdirSync(join(root, "dist", "node_modules"), { recursive: true });

    assert.equal(colocateOptionalPackages({ rootDir: root }).skipped, false);
    const second = colocateOptionalPackages({ rootDir: root });
    assert.equal(second.skipped, true);
    if (second.skipped === true) assert.equal(second.reason, "already co-located");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("colocateOptionalPackages skips when the optionals are not installed", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-colocate-noopt-"));
  try {
    mkdirSync(join(root, "dist", "node_modules"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });

    const result = colocateOptionalPackages({ rootDir: root });
    assert.equal(result.skipped, true);
    if (result.skipped === true) {
      assert.equal(result.reason, "optional packages not installed at root");
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("colocateOptionalPackages skips when there is no standalone dist bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "omniroute-colocate-nodist-"));
  try {
    buildRoot(root);
    const result = colocateOptionalPackages({ rootDir: root });
    assert.equal(result.skipped, true);
    if (result.skipped === true) assert.equal(result.reason, "no standalone dist/node_modules");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("colocateOptionalPackages fills a Next-traced stub (package.json only) instead of skipping it", () => {
  // Next's trace can leave a stub directory for a dynamically loaded optional
  // dependency: package.json but not the files its `main` points at.
  const root = mkdtempSync(join(tmpdir(), "omniroute-colocate-stub-"));
  try {
    buildRoot(root);
    const stubDir = join(root, "dist", "node_modules", "js-tiktoken");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      join(stubDir, "package.json"),
      readFileSync(join(root, "node_modules", "js-tiktoken", "package.json"), "utf8")
    );

    const result = colocateOptionalPackages({ rootDir: root });
    assert.equal(result.skipped, false, "must not treat the stub as already co-located");
    assert.ok(existsSync(join(stubDir, "dist", "index.js")), "the real payload is filled in");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
