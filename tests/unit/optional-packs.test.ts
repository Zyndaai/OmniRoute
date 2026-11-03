import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OPTIONAL_PACK_NAMES,
  packInstallDir,
  packNodeModulesDir,
  packsRootDir,
  installedPackNodePaths,
  packMemberInstalled,
} from "../../open-sse/utils/optionalPacks.ts";

/**
 * Stage 7 (issue #10321) — runtime-side optional pack resolution.
 *
 * Helpers must be fail-open: absent packs never throw, and every path derives
 * from the same DATA_DIR contract as the rest of the runtime.
 */

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opt-pack-runtime-"));
}

test("packs dirs derive from DATA_DIR override without touching the real home", () => {
  const dataDir = tmpDataDir();
  assert.equal(packsRootDir(dataDir), path.join(dataDir, "packs"));
  assert.equal(
    packInstallDir("browser-runtime", dataDir),
    path.join(dataDir, "packs", "browser-runtime")
  );
  assert.equal(
    packNodeModulesDir("browser-runtime", dataDir),
    path.join(dataDir, "packs", "browser-runtime", "node_modules")
  );
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("installedPackNodePaths lists only packs with an existing node_modules dir, in manifest order", () => {
  const dataDir = tmpDataDir();
  assert.deepEqual(installedPackNodePaths(dataDir), []);

  // A marker file (not a node_modules dir) must not count as installed.
  fs.mkdirSync(path.join(dataDir, "packs", "browser-runtime"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "packs", "browser-runtime", "marker.txt"), "");
  assert.deepEqual(installedPackNodePaths(dataDir), []);

  // A directory for a name outside the manifest is ignored.
  fs.mkdirSync(packNodeModulesDir("unknown-pack", dataDir), { recursive: true });
  fs.mkdirSync(packNodeModulesDir("browser-runtime", dataDir), { recursive: true });
  assert.deepEqual(installedPackNodePaths(dataDir), [
    path.join(dataDir, "packs", "browser-runtime", "node_modules"),
  ]);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("packMemberInstalled probes installed pack trees with optional node_modules prefix", () => {
  const dataDir = tmpDataDir();
  const memberPkg = path.join(
    packNodeModulesDir("browser-runtime", dataDir),
    "playwright-core",
    "package.json"
  );
  fs.mkdirSync(path.dirname(memberPkg), { recursive: true });
  fs.writeFileSync(memberPkg, "{}");

  assert.equal(packMemberInstalled("playwright-core/package.json", dataDir), true);
  assert.equal(packMemberInstalled(path.join("playwright-core", "package.json"), dataDir), true);
  assert.equal(packMemberInstalled("node_modules/playwright-core/package.json", dataDir), true);
  assert.equal(
    packMemberInstalled(path.join("node_modules", "playwright-core", "package.json"), dataDir),
    true
  );
  assert.equal(packMemberInstalled("playwright/package.json", dataDir), false);
  assert.equal(
    packMemberInstalled("playwright-core/package.json", path.join(dataDir, "absent")),
    false
  );
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("manifest and runtime pack lists stay in sync", async () => {
  // open-sse/utils/optionalPacks.ts embeds the names instead of importing the
  // build-side manifest (the server must not depend on build tooling), so the
  // two lists can drift — pin them together against the real module.
  const manifest = (await import("../../scripts/packs/optionalPackManifest.mjs")) as {
    OPTIONAL_PACKS: { name: string }[];
  };
  assert.deepEqual(
    [...OPTIONAL_PACK_NAMES],
    manifest.OPTIONAL_PACKS.map((p) => p.name)
  );
});
