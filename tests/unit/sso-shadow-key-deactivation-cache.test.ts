// Deactivating an SSO shadow key (a user who lost every key group) must clear the API-key
// validation cache at once, so the key stops authenticating immediately instead of staying
// valid until its cache entry expires.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(process.env.DATA_DIR || os.tmpdir(), "omniroute-sso-shadow-cache-")
);
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
};
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "sso-shadow-cache-api-key-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { setSsoKeyActive } = await import("../../src/lib/db/ssoIdentities.ts");

test.after(async () => {
  apiKeysDb.resetApiKeyState();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("setSsoKeyActive(false) drops a cached validation pass immediately", async () => {
  const created = await apiKeysDb.createApiKey("sso:shadow-user", "machine-sso", []);

  // Warm the validation cache with a passing result.
  assert.equal(await apiKeysDb.validateApiKey(created.key), true);

  assert.equal(await setSsoKeyActive(created.id, false), true);
  assert.equal(
    await apiKeysDb.validateApiKey(created.key),
    false,
    "a deactivated shadow key must not authenticate from a stale cache entry"
  );

  assert.equal(await setSsoKeyActive(created.id, true), true);
  assert.equal(await apiKeysDb.validateApiKey(created.key), true);
});

test("setSsoKeyActive reports no change for a repeat call", async () => {
  const created = await apiKeysDb.createApiKey("sso:repeat-user", "machine-sso", []);
  assert.equal(await setSsoKeyActive(created.id, true), false);
  assert.equal(await setSsoKeyActive(created.id, false), true);
  assert.equal(await setSsoKeyActive(created.id, false), false);
});
