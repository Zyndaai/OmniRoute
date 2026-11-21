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
