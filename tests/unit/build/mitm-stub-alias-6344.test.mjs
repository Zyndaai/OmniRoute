// Regression test for #6344 — a default-on @/mitm/manager build stub shipped to every npm /
// Electron / VPS artifact, breaking Agent Bridge start ("MITM manager stub reached at runtime").
// The stub alias must be opt-in (Docker sets OMNIROUTE_MITM_STUB=1); a default production build
// must bundle the REAL manager.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { shouldStubMitmManager } = await import("../../../scripts/build/mitm-stub-flag.mjs");
const { shouldStubBetterSqlite3 } =
  await import("../../../scripts/build/better-sqlite3-stub-flag.mjs");

describe("mitm manager stub alias (#6344)", () => {
  it("default env does NOT stub the manager (npm/Electron/VPS builds get the real module)", () => {
    assert.equal(shouldStubMitmManager({}), false);
  });

  it("OMNIROUTE_MITM_STUB=1 opts into the stub (Docker graceful degradation, #3390)", () => {
    assert.equal(shouldStubMitmManager({ OMNIROUTE_MITM_STUB: "1" }), true);
    assert.equal(shouldStubMitmManager({ OMNIROUTE_MITM_STUB: "0" }), false);
  });

  it("the better-sqlite3 stub is opt-in too (#11343)", () => {
    assert.equal(shouldStubBetterSqlite3({}), false);
    assert.equal(shouldStubBetterSqlite3({ OMNIROUTE_BETTER_SQLITE3_STUB: "1" }), true);
  });

  it("vite.config.ts adds each stub alias only behind its flag", () => {
    const config = readFileSync(new URL("../../../vite.config.ts", import.meta.url), "utf8");
    assert.match(
      config,
      /if \(shouldStubMitmManager\(env\)\) \{\s*aliases\.push\(stub\("@\/mitm\/manager", "\.\/src\/mitm\/manager\.stub\.ts"\)\);/
    );
    assert.match(
      config,
      /if \(shouldStubBetterSqlite3\(env\)\) \{\s*aliases\.push\(stub\("better-sqlite3", "\.\/src\/lib\/db\/better-sqlite3\.stub\.js"\)\);/
    );
    // Only the guarded pushes may mention a stub file.
    assert.equal(config.match(/manager\.stub\.ts/g)?.length, 1);
    assert.equal(config.match(/better-sqlite3\.stub\.js/g)?.length, 1);
    assert.match(config, /alias: moduleStubs\(env\)/);
  });

  it("the Dockerfile keeps Docker on the stub via OMNIROUTE_MITM_STUB=1", () => {
    const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
    assert.match(dockerfile, /^ENV OMNIROUTE_MITM_STUB=1$/m);
  });
});
