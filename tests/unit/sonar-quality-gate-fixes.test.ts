import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for a Sonar quality-gate fix (release PR #6569 findings):
// typescript:S6544 — `isCloudEnabled()` is async; a bare `if (isCloudEnabled())`
// is always truthy, so cloud sync ran even with cloud disabled.
// (The classify-pr-changes.mjs guard tests went with the removed scripts/quality tooling.)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("kiro auto-import awaits the async isCloudEnabled() gate (S6544)", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "app", "api", "oauth", "kiro", "auto-import", "route.ts"),
    "utf8"
  );
  // `isCloudEnabled()` returns a Promise — a bare truthiness check is always true,
  // which made syncToCloud() run even when cloud sync is disabled.
  assert.doesNotMatch(src, /if\s*\(\s*isCloudEnabled\(\)/, "bare `if (isCloudEnabled())` found");
  assert.match(src, /if\s*\(\s*await isCloudEnabled\(\)/);
});
