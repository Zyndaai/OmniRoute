import { test } from "node:test";
import assert from "node:assert/strict";

import { runBuildTool } from "../../../scripts/build/buildToolRunner.mjs";
import { rebuildInvocation } from "../../../scripts/dev/ensure-native-sqlite.mjs";

// Since the CVE-2024-27980 hardening, Node refuses to spawn a `.cmd`/`.bat` without a
// shell and throws EINVAL. `ensure-native-sqlite` spawned `npm.cmd` that way, so its
// rebuild always reported failure on Windows.

test("runBuildTool returns the tool's stdout so callers can parse tsc output", () => {
  const out = runBuildTool("typescript", "tsc", ["--version"], { encoding: "utf8" });
  assert.match(String(out), /^Version \d+\.\d+/);
});

test("ensure-native-sqlite spawns npm.cmd through the shell on win32", () => {
  const win = rebuildInvocation("win32");
  assert.equal(win.shell, true, "npm.cmd without a shell is EINVAL on Windows");
  assert.equal(win.file, "npm.cmd rebuild better-sqlite3");
  assert.deepEqual(win.args, [], "a shell command with an args array trips DEP0190");

  assert.deepEqual(rebuildInvocation("linux"), {
    file: "npm",
    args: ["rebuild", "better-sqlite3"],
    shell: false,
  });
});
