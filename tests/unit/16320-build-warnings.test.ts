/**
 * #16320 — the login route module prints a `[SECURITY] FATAL: JWT_SECRET is not set` warning
 * at import time. The warning must stay for the runtime: a missing secret disables login.
 * The build no longer imports route modules, so there is no build phase to suppress it in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-16320-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-jwt-secret-16320";

const loginRoute = await import("../../src/app/api/auth/login/route.ts");
const shouldWarn = loginRoute.authRouteInternals.shouldWarnMissingJwtSecret;

const savedJwtSecret = process.env.JWT_SECRET;

test.after(async () => {
  if (savedJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedJwtSecret;
  const core = await import("../../src/lib/db/core.ts");
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("the runtime warning is preserved when JWT_SECRET is missing", () => {
  delete process.env.JWT_SECRET;

  assert.equal(shouldWarn(), true);
});

test("no warning when JWT_SECRET is configured at runtime", () => {
  process.env.JWT_SECRET = "configured-secret";

  assert.equal(shouldWarn(), false);
});
