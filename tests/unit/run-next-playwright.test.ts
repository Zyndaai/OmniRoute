import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const playwrightRunner = await import("../../scripts/dev/run-next-playwright.mjs");

const PORTS = { basePort: 20190, apiPort: 20190, dashboardPort: 20190 };

test("the Playwright web server runs the single launcher", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/dev/run-next-playwright.mjs"),
    "utf8"
  );
  assert.match(source, /new URL\("\.\/run-server\.mjs", import\.meta\.url\)/);
  assert.match(source, /spawnWithForwardedSignals\(process\.execPath, \[LAUNCHER, mode\]/);
  assert.doesNotMatch(source, /node_modules\/next\//);
});

test("resolvePlaywrightDataDir isolates each run unless DATA_DIR is set", () => {
  assert.equal(
    playwrightRunner.resolvePlaywrightDataDir({ cwd: "/repo", env: {}, pid: 7 }),
    path.join("/repo", ".tmp", "playwright-data", "7")
  );
  assert.equal(
    playwrightRunner.resolvePlaywrightDataDir({ cwd: "/repo", env: { DATA_DIR: "/d" } }),
    "/d"
  );
});

test("buildPlaywrightServerEnv: auth mode pins a known password, production NODE_ENV for start", () => {
  const env = playwrightRunner.buildPlaywrightServerEnv({
    mode: "start",
    env: {},
    bootstrapEnvVars: { JWT_SECRET: "x" },
    dataDir: "/data",
    runtimePorts: PORTS,
  });
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.DATA_DIR, "/data");
  assert.equal(env.PORT, "20190");
  assert.equal(env.HOSTNAME, "127.0.0.1");
  assert.equal(env.INITIAL_PASSWORD, "omniroute-e2e-password");
  assert.equal(env.OMNIROUTE_E2E_PASSWORD, "omniroute-e2e-password");
  assert.equal(env.NEXT_PUBLIC_OMNIROUTE_E2E_MODE, "1");
  assert.equal(env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES, "true");
  assert.equal(env.OMNIROUTE_LAUNCHER_ENV_READY, "1", "the launcher must not bootstrap again");
  assert.equal(env.JWT_SECRET, "x");
});

test("buildPlaywrightServerEnv: open bootstrap mode blanks every credential", () => {
  const env = playwrightRunner.buildPlaywrightServerEnv({
    mode: "dev",
    env: { OMNIROUTE_E2E_BOOTSTRAP_MODE: "open", INITIAL_PASSWORD: "secret" },
    bootstrapEnvVars: { OMNIROUTE_API_KEY: "k" },
    dataDir: "/data",
    runtimePorts: PORTS,
  });
  assert.equal(env.NODE_ENV, "development");
  assert.equal(env.INITIAL_PASSWORD, "");
  assert.equal(env.OMNIROUTE_E2E_PASSWORD, "");
  assert.equal(env.OMNIROUTE_API_KEY, "");
});
