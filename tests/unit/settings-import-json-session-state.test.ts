/**
 * `POST /api/settings/import-json` must not write the dashboard session state a password change
 * or a sign-out leaves behind (`sessionsValidAfter`, `revokedDashboardSessions`), nor a
 * `currentPassword`. Those keys are not settings an operator configures: importing an older
 * backup that carries them (or that carries an empty revocation list / a zero cutoff) would
 * revive dashboard sessions the password change or the logout already ended.
 *
 * The import-json route itself was removed with the SQLite-to-PostgreSQL migration (JSON import
 * is gone), so the cases that drove it are deleted. The constant-level guards that the import
 * stripping relied on remain in `src/shared/constants/securityImpactingSettings.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-import-session-state-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "import-session-state-jwt-secret";

const core = await import("../../src/lib/db/core.ts");
const securitySettings = await import("../../src/shared/constants/securityImpactingSettings.ts");
const sessionToken = await import("../../src/shared/utils/dashboardSessionToken.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");

test.beforeEach(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("the session-state keys stripped by import-json are the ones the session verifier reads", () => {
  assert.deepEqual(
    [...securitySettings.DASHBOARD_SESSION_STATE_SETTINGS_KEYS].sort(),
    [sessionToken.REVOKED_SESSIONS_SETTING, sessionToken.SESSIONS_VALID_AFTER_SETTING].sort()
  );
});

test("import-json drops password, currentPassword, session state and every re-auth-gated key", () => {
  const stripped = new Set<string>(securitySettings.IMPORT_STRIPPED_SETTINGS_KEYS);
  for (const key of [
    "password",
    "currentPassword",
    ...securitySettings.SECURITY_IMPACTING_SETTINGS_KEYS,
    ...securitySettings.DASHBOARD_SESSION_STATE_SETTINGS_KEYS,
  ]) {
    assert.ok(stripped.has(key), key);
  }
});
