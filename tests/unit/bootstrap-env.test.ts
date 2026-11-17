import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bootstrapEnv } from "../../scripts/build/bootstrap-env.mjs";

function withTempEnv(fn) {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-bootstrap-test-"));
  const tempCwd = path.join(tempRoot, "cwd");
  const tempHome = path.join(tempRoot, "home");

  fs.mkdirSync(tempCwd, { recursive: true });
  fs.mkdirSync(tempHome, { recursive: true });

  delete process.env.DATA_DIR;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  delete process.env.JWT_SECRET;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  delete process.env.STORAGE_ENCRYPTION_KEY_VERSION;
  delete process.env.API_KEY_SECRET;
  delete process.env.INITIAL_PASSWORD;
  process.env.HOME = tempHome;
  process.chdir(tempCwd);

  try {
    fn({ tempRoot, tempCwd, tempHome, dataDir: path.join(tempHome, ".omniroute") });
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function captureStderr(fn) {
  const write = mock.method(process.stderr, "write", () => true);
  try {
    fn();
  } finally {
    write.mock.restore();
  }
  return write.mock.calls.map((call) => String(call.arguments[0])).join("");
}

test("bootstrapEnv prefers ~/.omniroute/.env over server.env", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, ".env"),
      "STORAGE_ENCRYPTION_KEY=from-dot-env\nJWT_SECRET=jwt-from-dot-env\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dataDir, "server.env"),
      "STORAGE_ENCRYPTION_KEY=from-server-env\nJWT_SECRET=jwt-from-server-env\n",
      "utf8"
    );

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.STORAGE_ENCRYPTION_KEY, "from-dot-env");
    assert.equal(env.JWT_SECRET, "jwt-from-dot-env");
  });
});

test("bootstrapEnv strips matching quotes from env values", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "server.env"),
      'JWT_SECRET="jwt-from-server-env"\nCLAUDE_USER_AGENT="claude-cli/2.1.219 (external, cli)"\n',
      "utf8"
    );

    const env = bootstrapEnv({ quiet: true });

    assert.equal(env.JWT_SECRET, "jwt-from-server-env");
    assert.equal(env.CLAUDE_USER_AGENT, "claude-cli/2.1.219 (external, cli)");
  });
});

test("bootstrapEnv ignores blank process.env values that would override persisted secrets (#6824)", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });

    // Persisted secrets in server.env
    fs.writeFileSync(
      path.join(dataDir, "server.env"),
      "STORAGE_ENCRYPTION_KEY=persisted-key\nJWT_SECRET=persisted-jwt\n",
      "utf8"
    );

    // Simulate Docker `-e STORAGE_ENCRYPTION_KEY=` — sets an empty string
    process.env.STORAGE_ENCRYPTION_KEY = "";
    process.env.JWT_SECRET = "";

    const env = bootstrapEnv({ quiet: true });

    // Empty process.env values must NOT override persisted secrets
    assert.equal(env.STORAGE_ENCRYPTION_KEY, "persisted-key");
    assert.equal(env.JWT_SECRET, "persisted-jwt");
  });
});

test("bootstrapEnv ignores blank dataDirOverride values", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, ".env"), "JWT_SECRET=jwt-from-dot-env\n", "utf8");

    const env = bootstrapEnv({ dataDirOverride: "   ", quiet: true });

    assert.equal(env.JWT_SECRET, "jwt-from-dot-env");
  });
});

test("bootstrapEnv does not claim a CHANGEME default when INITIAL_PASSWORD is unset", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;

    const output = captureStderr(() => bootstrapEnv());

    assert.match(output, /INITIAL_PASSWORD is unset here/);
    assert.match(output, /onboarding wizard/);
    assert.doesNotMatch(output, /CHANGEME/);
  });
});

test("bootstrapEnv warns that the CHANGEME placeholder becomes the password", () => {
  withTempEnv(({ tempCwd, dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.writeFileSync(path.join(tempCwd, ".env"), "INITIAL_PASSWORD=CHANGEME\n", "utf8");

    const output = captureStderr(() => bootstrapEnv());

    assert.match(output, /placeholder 'CHANGEME', a publicly known/);
    assert.match(output, /In Docker, do it before the/);
    assert.match(output, /reset-password/);
    assert.doesNotMatch(output, /is unset here/);
  });
});

test("bootstrapEnv warns on placeholder spellings that differ by case or surrounding whitespace", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    process.env.INITIAL_PASSWORD = " changeme ";

    const output = captureStderr(() => bootstrapEnv());

    assert.match(output, /placeholder 'CHANGEME', a publicly known/);
    assert.doesNotMatch(output, /is unset here/);
    assert.doesNotMatch(output, /only whitespace/);
  });
});

test("bootstrapEnv leaves ./.env to Next.js when another .env is preferred", () => {
  // When another .env is preferred, bootstrap never reads ./.env, so a directory there
  // cannot stop startup on this path.
  withTempEnv(({ tempCwd, dataDir }) => {
    process.env.DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, ".env"), "JWT_SECRET=jwt-from-dot-env\n", "utf8");
    fs.mkdirSync(path.join(tempCwd, ".env"));

    const output = captureStderr(() => bootstrapEnv());

    assert.match(output, /INITIAL_PASSWORD is unset here/);
    assert.doesNotMatch(output, /CHANGEME/);
  });
});

test("bootstrapEnv warns that a whitespace-only INITIAL_PASSWORD becomes the password", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    process.env.INITIAL_PASSWORD = "   ";

    const output = captureStderr(() => bootstrapEnv());

    assert.match(output, /only whitespace/);
    assert.match(output, /works from any address/);
    assert.match(output, /Set a real/);
    assert.doesNotMatch(output, /CHANGEME|is unset here/);
  });
});

test("bootstrapEnv prints no password warning for a real INITIAL_PASSWORD", () => {
  withTempEnv(({ dataDir }) => {
    process.env.DATA_DIR = dataDir;
    process.env.INITIAL_PASSWORD = "a-strong-unique-password";

    const output = captureStderr(() => bootstrapEnv());

    assert.doesNotMatch(output, /INITIAL_PASSWORD/);
  });
});
