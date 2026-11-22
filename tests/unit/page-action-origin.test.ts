/**
 * Page writes (React Router actions: a POST to a page or its `.data` URL) are origin-checked by
 * the request pipeline for every caller, against the server's trusted public origins.
 *
 * React Router's own check compares `Origin` with `request.url`, which this server builds from
 * the bound address (never the client's Host), so it cannot tell a same-origin dashboard from a
 * forged one; `react-router.config.ts` turns it off and relies on this rule instead. The authz
 * pipeline's own origin check only covers dashboard sessions, so without this rule an anonymous
 * cross-site POST (requireLogin=false) or a login-page CSRF would pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-page-action-origin-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "page-action-origin-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
const STAMP = "page-action-origin-stamp-token";
process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP;
delete process.env.OMNIROUTE_PUBLIC_BASE_URL;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const { createAppHandler } = await import("../../src/server/http/handler.ts");

// The server builds request.url from the bound address; the browser addressed `localhost`.
const BOUND = "http://127.0.0.1:20128";
const BROWSER_ORIGIN = "http://localhost:20128";

const reached: string[] = [];
const handle = createAppHandler({
  basePath: () => "",
  render: async (request) => {
    reached.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response("rendered", { status: 200 });
  },
});

function send(pathname: string, method: string, headers: Record<string, string> = {}) {
  return handle(
    new Request(`${BOUND}${pathname}`, {
      method,
      headers: {
        host: "localhost:20128",
        "x-omniroute-peer-ip": `${STAMP}|127.0.0.1`,
        "x-omniroute-via-proxy": `${STAMP}|0`,
        ...headers,
      },
      body: method === "GET" ? undefined : "{}",
    })
  );
}

test.beforeEach(async () => {
  await resetTestDb();
  await settingsDb.updateSettings({ requireLogin: false });
  reached.length = 0;
});

test.after(async () => {
  await core.resetDbInstance();
  await cleanupTempDataDir(TEST_DATA_DIR);
});

test("a cross-site page action is refused for an anonymous caller (requireLogin off)", async () => {
  const response = await send("/dashboard/mcp.data", "POST", { origin: "https://evil.example" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "INVALID_ORIGIN");
  assert.deepEqual(reached, []);
});

test("a same-origin page action reaches the route although request.url is the bound address", async () => {
  const response = await send("/dashboard/mcp.data", "POST", { origin: BROWSER_ORIGIN });
  assert.equal(response.status, 200);
  assert.deepEqual(reached, ["POST /dashboard/mcp.data"]);
});

test("Origin: null and cross-site fetch metadata are refused", async () => {
  assert.equal((await send("/dashboard/mcp.data", "POST", { origin: "null" })).status, 403);
  assert.equal(
    (
      await send("/dashboard/mcp.data", "POST", {
        origin: BROWSER_ORIGIN,
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403
  );
  assert.deepEqual(reached, []);
});

test("a page outside the authz paths is covered too (login CSRF)", async () => {
  const response = await send("/login", "POST", { origin: "https://evil.example" });
  assert.equal(response.status, 403);
  assert.deepEqual(reached, []);
});

test("reads and API endpoints are left to their existing rules", async () => {
  assert.equal(
    (await send("/dashboard/mcp.data", "GET", { origin: "https://evil.example" })).status,
    200
  );
  // An endpoint keeps its own rules (here: open mode, no session, so no origin check).
  assert.equal((await send("/api/keys", "POST", { origin: "https://evil.example" })).status, 200);
  assert.deepEqual(reached, ["GET /dashboard/mcp.data", "POST /api/keys"]);
});

test("a write without an Origin header (a non-browser client) is not an origin violation", async () => {
  assert.equal((await send("/dashboard/mcp.data", "POST")).status, 200);
});

test("endpoints outside /api (route.ts files) keep their own rules", async () => {
  // /a2a takes JSON-RPC from agents, which may run in a browser on another origin; the
  // embedded-service proxy forwards the embedded app's own writes.
  for (const pathname of ["/a2a", "/dashboard/providers/services/demo/embed/form"]) {
    const response = await send(pathname, "POST", { origin: "https://agent.example" });
    assert.equal(response.status === 403, false, `${pathname} is not judged as a page write`);
  }
  assert.ok(reached.includes("POST /a2a"));
});

test("every route.ts outside src/app/api is listed as an endpoint", async () => {
  const { isResourceRoutePath } = await import("../../src/server/http/resourceRoutes.ts");
  const { urlPatterns } = await import("../../src/app/routeConvention.ts");
  const appDir = path.resolve(import.meta.dirname, "../../src/app");
  const routeFiles = fs
    .readdirSync(appDir, { recursive: true, encoding: "utf8" })
    .map((rel) => rel.split(path.sep).join("/"))
    .filter((rel) => rel.endsWith("/route.ts") && !rel.startsWith("api/"));
  assert.ok(routeFiles.length > 0);
  for (const rel of routeFiles) {
    for (const pattern of urlPatterns(rel.split("/").slice(0, -1))) {
      // A sample URL for the pattern: `:name` -> "x", a trailing `*` -> two segments.
      const sample = pattern.replace(/:[^/]+/g, "x").replace(/\*$/, "a/b");
      assert.equal(isResourceRoutePath(sample), true, `${rel} (${sample})`);
    }
  }
  assert.equal(isResourceRoutePath("/dashboard/mcp"), false);
  assert.equal(isResourceRoutePath("/login"), false);
});
