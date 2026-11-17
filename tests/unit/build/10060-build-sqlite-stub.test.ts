/**
 * #10060 — the Next.js production build signals itself to every build worker with
 * OMNIROUTE_BUILDING=1 (set by build-next-isolated.mjs and inherited by every spawned
 * worker, because Next.js workers sometimes drop NEXT_PHASE).
 *
 * The SQLite stub that used to consume this signal is gone with the SQLite drivers;
 * the build-env contract itself is still pinned here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveNextBuildEnv } from "../../../scripts/build/build-next-isolated.mjs";

describe("#10060 build env carries OMNIROUTE_BUILDING", () => {
  it("resolveNextBuildEnv sets OMNIROUTE_BUILDING=1", () => {
    const env = resolveNextBuildEnv({}, "linux");
    assert.equal(env.OMNIROUTE_BUILDING, "1");
  });

  it("preserves provided env keys and does not clobber the build-worker flag", () => {
    const env = resolveNextBuildEnv({ NEXT_PRIVATE_BUILD_WORKER: "1" }, "linux");
    assert.equal(env.NEXT_PRIVATE_BUILD_WORKER, "1");
    assert.equal(env.OMNIROUTE_BUILDING, "1");
  });
});
