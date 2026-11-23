// When STORAGE_ENCRYPTION_KEY is not in the process environment, src/lib/db/encryption.ts
// reads it from a .env file itself. That fallback used `split("=", 2)[1]`, which drops
// everything after a second "=", so a base64 key (`openssl rand -base64 32`) lost its
// padding and derived a different AES key than the CLI and the bootstrap, which split on
// the first "=" (upstream #19106). Data written under the truncated value stays readable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

import { parseEnvValue as cliParseEnvValue } from "../../../bin/cli/utils/parseEnvValue.mjs";

const { isEncryptionEnabled, decrypt } = await import("../../../src/lib/db/encryption.ts");

const KEY = "STORAGE_ENCRYPTION_KEY";

// ensureSecretLoaded() returns early in a test context, so drop the markers that
// isTestContext() looks at while the fallback runs.
function withoutTestFlags<T>(fn: () => T): T {
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    VITEST: process.env.VITEST,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
  };
  const savedExec = process.execArgv.slice();
  const savedArgv = process.argv.slice();
  const strip = (list: string[]) => list.filter((arg) => arg !== "--test");
  try {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_TEST_CONTEXT;
    process.execArgv.splice(0, process.execArgv.length, ...strip(savedExec));
    process.argv.splice(0, process.argv.length, ...strip(savedArgv));
    return fn();
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.execArgv.splice(0, process.execArgv.length, ...savedExec);
    process.argv.splice(0, process.argv.length, ...savedArgv);
  }
}

/** Run `fn` with DATA_DIR/.env holding `envText`, the key unset and test markers removed. */
function withEnvFile<T>(envText: string, fn: () => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enc-env-parse-"));
  const dataDir = path.join(root, "data");
  const emptyDir = path.join(root, "empty");
  fs.mkdirSync(dataDir);
  fs.mkdirSync(emptyDir);
  fs.writeFileSync(path.join(dataDir, ".env"), envText);
  const saved = {
    DATA_DIR: process.env.DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    [KEY]: process.env[KEY],
  };
  const savedCwd = process.cwd();
  try {
    process.env.DATA_DIR = dataDir;
    process.env.HOME = emptyDir;
    process.env.USERPROFILE = emptyDir;
    process.chdir(emptyDir);
    delete process.env[KEY];
    return withoutTestFlags(fn);
  } finally {
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function loadFromEnvFile(envText: string): string | undefined {
  return withEnvFile(envText, () => {
    isEncryptionEnabled();
    return process.env[KEY];
  });
}

test("keeps base64 padding on the key", () => {
  const b64 = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
  assert.equal(loadFromEnvFile(`${KEY}=${b64}\n`), b64);
  assert.equal(loadFromEnvFile(`${KEY}="${b64}"\n`), b64);
  assert.equal(loadFromEnvFile(`${KEY}=c2hvcnQ==\r\n`), "c2hvcnQ==");
});

test("keeps every '=' after the first one", () => {
  assert.equal(loadFromEnvFile(`${KEY}=a=b=c\n`), "a=b=c");
  assert.equal(loadFromEnvFile(`${KEY}==leading\n`), "=leading");
});

test("ignores lines without '=' and lines for other keys", () => {
  assert.equal(loadFromEnvFile(`${KEY}\n`), undefined);
  assert.equal(loadFromEnvFile(`${KEY}_OLD=nope\nOTHER=${KEY}=x\n`), undefined);
  assert.equal(loadFromEnvFile(`# ${KEY}=commented\n${KEY}\n${KEY}=real=\n`), "real=");
});

test("trims the key name and keeps the first non-empty value", () => {
  assert.equal(loadFromEnvFile(`${KEY} = spaced=\n`), "spaced=");
  assert.equal(loadFromEnvFile(`${KEY}= "quoted after space="\n`), "quoted after space=");
  assert.equal(loadFromEnvFile(`${KEY}=\n${KEY}=first=\n${KEY}=second\n`), "first=");
});

test("reads the same value as the CLI .env parser", () => {
  for (const value of [
    "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=",
    "a=b=c",
    `"q=#=v"`,
    "x # c",
  ]) {
    assert.equal(loadFromEnvFile(`${KEY}=${value}\n`), cliParseEnvValue(value));
  }
});

test("data written under the old truncated reading still decrypts", () => {
  const full = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
  const truncated = full.slice(0, -1); // what split("=", 2)[1] returned
  const key = scryptSync(truncated, "omniroute-field-encryption-v1", 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = cipher.update("secret-token", "utf8", "hex") + cipher.final("hex");
  const stored = `enc:v1:${iv.toString("hex")}:${body}:${cipher.getAuthTag().toString("hex")}`;

  const result = withEnvFile(`${KEY}=${full}\n`, () => decrypt(stored, { quiet: true }));
  assert.equal(result, "secret-token");
});
