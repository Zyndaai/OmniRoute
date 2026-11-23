import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-management-password-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const managementPassword = await import("../../../src/lib/auth/managementPassword.ts");

async function resetStorage() {
  await resetTestDb();
  delete process.env.INITIAL_PASSWORD;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_INITIAL_PASSWORD === undefined) {
    delete process.env.INITIAL_PASSWORD;
  } else {
    process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  }
});

test("ensurePersistentManagementPasswordHash migrates INITIAL_PASSWORD into a persisted bcrypt hash", async () => {
  process.env.INITIAL_PASSWORD = "bootstrap-secret";

  const result = await managementPassword.ensurePersistentManagementPasswordHash({
    source: "test",
  });
  const settings = await settingsDb.getSettings();

  assert.equal(result.migrated, true);
  assert.equal(result.source, "env");
  assert.equal(managementPassword.isBcryptHash(settings.password), true);
  assert.notEqual(settings.password, "bootstrap-secret");
  assert.equal(
    await managementPassword.verifyManagementPassword(
      "bootstrap-secret",
      (settings as any).password
    ),
    true
  );
  assert.equal(settings.requireLogin, true);
  assert.equal(settings.setupComplete, true);
});

test("ensurePersistentManagementPasswordHash migrates legacy plaintext settings passwords", async () => {
  await settingsDb.updateSettings({
    password: "legacy-password",
    requireLogin: true,
    setupComplete: true,
  });

  const result = await managementPassword.ensurePersistentManagementPasswordHash({
    source: "test",
  });
  const settings = await settingsDb.getSettings();

  assert.equal(result.migrated, true);
  assert.equal(result.source, "stored_plaintext");
  assert.equal(managementPassword.isBcryptHash(settings.password), true);
  assert.notEqual(settings.password, "legacy-password");
  assert.equal(
    await managementPassword.verifyManagementPassword(
      "legacy-password" as any,
      (settings as any).password
    ),
    true
  );
});

