// Regression guard for tests/_setup/isolateDataDir.ts — the test-only module that
// gives each test process its own DATA_DIR so concurrent test files never share the
// on-disk SQLite DB. Removing or breaking it brings back the cross-file state races
// (the `test:unit` hang under high concurrency and the non-deterministic Stryker
// baseline that forced concurrency: 1).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepStaleTestDataDirs } from "../_setup/isolateDataDir.ts";

function dataDirFromChild(envDataDir: string | undefined): string {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/_setup/isolateDataDir.ts",
      "-e",
      "console.log(process.env.DATA_DIR ?? '')",
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      // Pass DATA_DIR through verbatim; an empty string means "unset" for the module's
      // `if (!process.env.DATA_DIR)` guard.
      env: { ...process.env, DATA_DIR: envDataDir ?? "" },
    }
  );
  return result.stdout.trim().split("\n").pop() ?? "";
}

const PROBE_PREFIX = "PLUGIN_DIR_PROBE ";

// Runs the real plugin-dir resolver in a child that loads the setup. DATA_DIR is blanked
// so the child mints its own, and OMNIROUTE_PLUGINS_DIR is pinned so the parent runner's
// value never leaks in. The scanner logs on resolve, so the result line is found by its
// prefix instead of assumed to be the last line.
function pluginDirFromChild(envPluginsDir: string): { dataDir: string; pluginDir: string } {
  const script = [
    'const { getDefaultPluginDir } = await import("./src/lib/plugins/scanner.ts");',
    `console.log(${JSON.stringify(PROBE_PREFIX)} + JSON.stringify({`,
    "  dataDir: process.env.DATA_DIR,",
    "  pluginDir: getDefaultPluginDir(),",
    "}));",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/_setup/isolateDataDir.ts",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: "", OMNIROUTE_PLUGINS_DIR: envPluginsDir },
    }
  );
  assert.equal(result.status, 0, `plugin-dir probe exited ${result.status}: ${result.stderr}`);
  const line = result.stdout.split("\n").find((l) => l.startsWith(PROBE_PREFIX));
  assert.ok(line, `plugin-dir probe printed no result line; stdout: ${result.stdout}`);
  return JSON.parse(line.slice(PROBE_PREFIX.length));
}

test("isolateDataDir assigns a unique temp DATA_DIR when none is set", () => {
  const a = dataDirFromChild(undefined);
  const b = dataDirFromChild(undefined);

  assert.ok(a.startsWith(os.tmpdir()), `expected a temp dir under ${os.tmpdir()}, got ${a}`);
  assert.match(a, /omniroute-test-/, `expected the omniroute-test- prefix, got ${a}`);
  assert.notEqual(a, b, "two processes must each get their own DATA_DIR");
});

test("isolateDataDir respects an explicitly set DATA_DIR", () => {
  const explicit = "/tmp/omniroute-explicit-fixture";
  assert.equal(dataDirFromChild(explicit), explicit);
});

test("isolateDataDir resolves the default plugin dir under the per-process DATA_DIR", () => {
  // A blank override counts as unset, as it does in the scanner itself.
  for (const unset of ["", "   "]) {
    const { dataDir, pluginDir } = pluginDirFromChild(unset);

    assert.match(dataDir, /omniroute-test-/, `expected an isolated DATA_DIR, got ${dataDir}`);
    assert.equal(
      pluginDir,
      path.join(dataDir, "plugins"),
      `OMNIROUTE_PLUGINS_DIR=${JSON.stringify(unset)}`
    );
  }
});

test("isolateDataDir respects an explicitly set OMNIROUTE_PLUGINS_DIR", () => {
  const explicit = "/tmp/omniroute-explicit-plugins-fixture";
  assert.equal(pluginDirFromChild(explicit).pluginDir, explicit);
});

const OPEN_DB_PREFIX = "OPEN_DB_PROBE ";

// A child that opens the real SQLite DB in its isolated DATA_DIR and exits without closing
// it, as most test files do. On Windows the open handle makes the exit hook's rmSync fail.
function dataDirWithOpenDbFromChild(): string {
  const script = [
    'const { getDbInstance } = await import("./src/lib/db/core.ts");',
    "getDbInstance();",
    `console.log(${JSON.stringify(OPEN_DB_PREFIX)} + process.env.DATA_DIR);`,
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/_setup/isolateDataDir.ts",
      "--input-type=module",
      "-e",
      script,
    ],
    { encoding: "utf8", cwd: process.cwd(), env: { ...process.env, DATA_DIR: "" } }
  );
  assert.equal(result.status, 0, `open-db probe exited ${result.status}: ${result.stderr}`);
  const line = result.stdout.split("\n").find((l) => l.startsWith(OPEN_DB_PREFIX));
  assert.ok(line, `open-db probe printed no result line; stdout: ${result.stdout}`);
  return line.slice(OPEN_DB_PREFIX.length).trim();
}

test("isolateDataDir leaves no DATA_DIR behind once the next test process starts", () => {
  // Windows leaked one of these per test file (7,236 dirs, 39 GB in three days) because the
  // exit hook cannot remove a DB that is still open. POSIX removes it at exit already.
  const leaked = dataDirWithOpenDbFromChild();
  dataDirFromChild(undefined);
  assert.equal(fs.existsSync(leaked), false, `expected ${leaked} to be swept`);
});

test("sweepStaleTestDataDirs removes only dirs whose owner is gone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-fixture-"));
  try {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    const dirs = {
      deadOwner: `omniroute-test-${deadPid}-AbC123`,
      liveOwner: `omniroute-test-${process.pid}-AbC123`,
      oldUntagged: "omniroute-test-OldOne",
      freshUntagged: "omniroute-test-NewOne",
      otherPrefix: "omniroute-test-adversarial-pii-AbC123",
      unrelated: "something-else",
    };
    for (const name of Object.values(dirs)) {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, "storage.sqlite"), "");
    }
    for (const name of [dirs.deadOwner, dirs.oldUntagged, dirs.otherPrefix, dirs.unrelated]) {
      fs.utimesSync(path.join(root, name), twoHoursAgo, twoHoursAgo);
    }

    sweepStaleTestDataDirs(root, now);

    const left = new Set(fs.readdirSync(root));
    assert.equal(left.has(dirs.deadOwner), false, "a dead owner's dir is removed");
    assert.equal(
      left.has(dirs.oldUntagged),
      false,
      "an untagged dir older than an hour is removed"
    );
    assert.ok(left.has(dirs.liveOwner), "a live owner's dir is kept");
    assert.ok(left.has(dirs.freshUntagged), "a fresh untagged dir may belong to a live run");
    assert.ok(left.has(dirs.otherPrefix), "other test prefixes are left to their own cleanup");
    assert.ok(left.has(dirs.unrelated), "unrelated temp dirs are never touched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
