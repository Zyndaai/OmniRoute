/**
 * A dashboard data request (`/x.data`, what React Router fetches for loaders and actions) without
 * a valid session must send the browser to the login page. A plain 307 does not: `fetch()`
 * follows it (a POST stays a POST, so `/login` answers 405) and the page lands on its error
 * boundary. React Router's client reads a 204 with `X-Remix-Redirect` as a redirect instead;
 * `X-Remix-Reload-Document` makes it a full page load, so the login page starts clean.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupTempDataDir } from "../../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-data-login-redirect-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "data-login-redirect-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "data-login-redirect-jwt-secret-0123456789";
const STAMP = "data-login-redirect-stamp-token";
process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { createAppHandler } = await import("../../../src/server/http/handler.ts");

const ORIGIN = "http://127.0.0.1:20128";

function handlerAt(base: string) {
  return createAppHandler({
    basePath: () => base,
    render: async () => new Response("rendered", { status: 200 }),
  });
}

function send(handle: ReturnType<typeof handlerAt>, pathname: string, method = "GET") {
  return handle(
    new Request(`${ORIGIN}${pathname}`, {
      method,
      headers: {
        host: "127.0.0.1:20128",
        origin: ORIGIN,
        "x-omniroute-peer-ip": `${STAMP}|127.0.0.1`,
        "x-omniroute-via-proxy": `${STAMP}|0`,
        cookie: "auth_token=expired-or-forged",
      },
      body: method === "GET" ? undefined : "{}",
    })
  );
}

test.beforeEach(async () => {
  await resetTestDb();
  await settingsDb.updateSettings({ requireLogin: true, password: "x" });
});

test.after(async () => {
  await core.resetDbInstance();
  await cleanupTempDataDir(TEST_DATA_DIR);
});

for (const method of ["GET", "POST"]) {
  test(`a ${method} data request without a session gets React Router's redirect to /login`, async () => {
    const response = await send(handlerAt(""), "/dashboard/mcp.data", method);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("x-remix-redirect"), "/login");
    assert.equal(response.headers.get("x-remix-reload-document"), "true");
    assert.equal(response.headers.get("location"), null);
    assert.match(response.headers.get("set-cookie") ?? "", /auth_token=;/);
  });
}

test("a page request without a session still gets a plain redirect to /login", async () => {
  const response = await send(handlerAt(""), "/dashboard/mcp");
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/login");
  assert.equal(response.headers.get("x-remix-redirect"), null);
});

test("under a base path the data redirect keeps the base path", async () => {
  const response = await send(handlerAt("/omniroute"), "/omniroute/dashboard/mcp.data");
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("x-remix-redirect"), "/omniroute/login");
});
