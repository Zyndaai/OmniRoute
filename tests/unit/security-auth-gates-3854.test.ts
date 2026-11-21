// Routes that could be reached without a credential (fixed upstream in 3.8.54):
//  - /api/init starts background sync jobs, so it needs management auth when login is on;
//  - POST /api/a2a/tasks was open whenever OMNIROUTE_API_KEY was unset, even with
//    REQUIRE_API_KEY on;
//  - the two skill installers write a global skill injected into every key's requests;
//  - a security feature flag (REQUIRE_API_KEY, SSRF switches) written with login off would turn
//    the control off for everyone at once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auth-gates-3854-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ??= "auth-gates-3854-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");
const { refreshFeatureFlagSnapshot } = await import("../../src/shared/utils/featureFlags.ts");

const initRoute = await import("../../src/app/api/init/route.ts");
const a2aTasksRoute = await import("../../src/app/api/a2a/tasks/route.ts");
const marketplaceInstall = await import("../../src/app/api/skills/marketplace/install/route.ts");
const skillsshInstall = await import("../../src/app/api/skills/skillssh/install/route.ts");
const featureFlagsRoute = await import("../../src/app/api/settings/feature-flags/route.ts");

const ORIGINAL_ENV = {
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  REQUIRE_API_KEY: process.env.REQUIRE_API_KEY,
  OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
};

test.beforeEach(async () => {
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  await resetTestDb();
  featureFlagsDb.clearFeatureFlagOverrideCache();
  await refreshFeatureFlagSnapshot();
  // Login off: the local-first default, where plain isAuthenticated lets everyone in.
  delete process.env.INITIAL_PASSWORD;
  delete process.env.REQUIRE_API_KEY;
  delete process.env.OMNIROUTE_API_KEY;
});

test.after(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function jsonRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const refused = (status: number) => status === 401 || status === 403;

test("/api/init requires management auth when login is on", async () => {
  process.env.INITIAL_PASSWORD = "auth-gates-3854-password";
  const res = await initRoute.GET(jsonRequest("GET", "http://localhost/api/init"));
  assert.ok(refused(res.status), `expected 401/403, got ${res.status}`);
});

test("POST /api/a2a/tasks needs a key under REQUIRE_API_KEY even without OMNIROUTE_API_KEY", async () => {
  process.env.REQUIRE_API_KEY = "true";
  const res = await a2aTasksRoute.POST(
    jsonRequest("POST", "http://localhost/api/a2a/tasks", {
      skill: "conductor",
      messages: [{ role: "user", content: "hi" }],
    })
  );
  assert.equal(res.status, 401);
});

for (const [name, route, body] of [
  [
    "marketplace",
    marketplaceInstall,
    { name: "x", description: "y", skillMdContent: "# x", version: "1.0.0" },
  ],
  ["skills.sh", skillsshInstall, { name: "x", description: "y", source: "o/r", skillId: "x" }],
] as const) {
  test(`${name} skill install needs a credential even with login off`, async () => {
    const res = await route.POST(jsonRequest("POST", "http://localhost/api/skills/install", body));
    assert.ok(refused(res.status), `expected 401/403, got ${res.status}`);
  });
}

test("a security feature flag cannot be written without a credential when login is off", async () => {
  const put = await featureFlagsRoute.PUT(
    jsonRequest("PUT", "http://localhost/api/settings/feature-flags", {
      key: "REQUIRE_API_KEY",
      value: "false",
    })
  );
  assert.ok(refused(put.status), `expected 401/403, got ${put.status}`);
});

test("an ordinary feature flag can still be written with login off", async () => {
  const put = await featureFlagsRoute.PUT(
    jsonRequest("PUT", "http://localhost/api/settings/feature-flags", {
      key: "PROXY_AUTO_SELECT_ENABLED",
      value: "false",
    })
  );
  assert.equal(put.status, 200);
});
