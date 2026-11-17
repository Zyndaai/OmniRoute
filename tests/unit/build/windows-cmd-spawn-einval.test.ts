import { test } from "node:test";
import assert from "node:assert/strict";

import { runBuildTool } from "../../../scripts/build/buildToolRunner.mjs";

// Since the CVE-2024-27980 hardening, Node refuses to spawn a `.cmd`/`.bat` without a
// shell and throws EINVAL. runBuildTool must keep working for the Windows shims.

test("runBuildTool returns the tool's stdout so callers can parse tsc output", () => {
  const out = runBuildTool("typescript", "tsc", ["--version"], { encoding: "utf8" });
  assert.match(String(out), /^Version \d+\.\d+/);
});
