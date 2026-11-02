// Regression guard for #7226: API-only smoke/nightly workflows must build with
// OMNIROUTE_BUILD_BACKEND_ONLY=1 so `npm run build:cli`'s fallback full build
// (scripts/build/prepublish.ts -> build-next-isolated.mjs) skips the ~126-leaf-page
// dashboard UI graph these workflows never exercise. Without this env var, the
// "Build CLI bundle" step silently runs a full Next.js production build inline,
// which is the actual source of the multi-minute variance/timeouts reported in #7226.
//
import test from "node:test";
import assert from "node:assert/strict";
import { isBackendOnlyBuild } from "../../../scripts/build/backendOnlyPages.mjs";

test("contributor build profile enables backend-only mode", () => {
  assert.equal(isBackendOnlyBuild({ OMNIROUTE_BUILD_PROFILE: "contributor" }), true);
});

test("full build remains the default when no backend-only profile is set", () => {
  assert.equal(isBackendOnlyBuild({}), false);
});
