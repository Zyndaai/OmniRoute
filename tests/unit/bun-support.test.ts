import test from "node:test";
import assert from "node:assert/strict";
import { getNodeRuntimeSupport } from "../../src/shared/utils/nodeRuntimeSupport.ts";

test("getNodeRuntimeSupport detects Bun as a supported runtime", () => {
  const originalBun = process.versions.bun;
  try {
    (process.versions as Record<string, string>).bun = "1.1.20";
    const support = getNodeRuntimeSupport("22.0.0");
    assert.equal(support.nodeCompatible, true);
    assert.equal(support.reason, "supported-bun");
    assert.match(support.nodeVersion, /^bun-1\.1\.20/);
    assert.match(support.supportedDisplay, /Bun 1\.1\+/);
  } finally {
    if (originalBun === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      process.versions.bun = originalBun;
    }
  }
});

// Bun/Node detection must not silently override an explicit operator build choice.
// Automatic low-memory webpack fallback only applies when the variable is unset.
test("resolveNextBuildBundlerFlag uses the same memory and override rules under Bun and Node", async () => {
  const buildIsolated = await import("../../scripts/build/build-next-isolated.mjs");
  const originalBun = process.versions.bun;
  const GiB = 1024 ** 3;
  try {
    for (const bun of [undefined, "1.1.20", "1.3.14"]) {
      if (bun === undefined) {
        delete (process.versions as Record<string, string | undefined>).bun;
      } else {
        (process.versions as Record<string, string>).bun = bun;
      }
      const where = `bun=${bun ?? "absent"}`;
      assert.equal(buildIsolated.resolveNextBuildBundlerFlag({}, 8 * GiB), "--webpack", where);
      assert.equal(buildIsolated.resolveNextBuildBundlerFlag({}, 32 * GiB), "--turbopack", where);
      assert.equal(
        buildIsolated.resolveNextBuildBundlerFlag({ OMNIROUTE_USE_TURBOPACK: "1" }, 8 * GiB),
        "--turbopack",
        where
      );
      assert.equal(
        buildIsolated.resolveNextBuildBundlerFlag({ OMNIROUTE_USE_TURBOPACK: "0" }, 32 * GiB),
        "--webpack",
        where
      );
    }
  } finally {
    if (originalBun === undefined) {
      delete (process.versions as Record<string, string | undefined>).bun;
    } else {
      process.versions.bun = originalBun;
    }
  }
});
