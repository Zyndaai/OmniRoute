/**
 * A dashboard loader that reads through `apiRequest()` gets the same answer the browser would
 * get from the API path itself: the in-process replay runs the whole pipeline (authz judged on
 * the `/api/...` path) with the headers the dashboard request arrived with. Rules keyed on the
 * API path — LOCAL_ONLY, always-protected paths under requireLogin=false, the manage-scope
 * bypass — must hold for the loader exactly as for a direct call.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SignJWT } from "jose";

import { cleanupTempDataDir } from "../../_setup/tempDataDir.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-dashboard-api-parity-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "dashboard-api-parity-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.JWT_SECRET = "dashboard-api-parity-jwt-secret-0123456789";
const STAMP = "dashboard-api-parity-stamp-token";
process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { createAppHandler } = await import("../../../src/server/http/handler.ts");
const { apiRequest } = await import("../../../src/server/routing/dashboardApi.server.ts");
const { issueDashboardCsrfToken } = await import("../../../src/server/authz/csrf.ts");

const ORIGIN = "http://omniroute.test";

/**
 * Stands in for React Router: an `/api/...` request is "the route" and answers 200 with what
 * it saw; a `/dashboard/probe` request is "the loader" and replays the API call named in its
 * query, answering with that call's status.
 */
async function render(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    return Response.json({
      route: url.pathname,
      method: request.method,
      authKind: request.headers.get("x-omniroute-auth-kind"),
    });
  }
  if (url.pathname === "/dashboard/probe") {
    const api = url.searchParams.get("api") ?? "";
    const method = url.searchParams.get("method") ?? "GET";
    const inner = await apiRequest(api, {
      method,
      body: method === "GET" ? undefined : { probe: true },
    });
    return Response.json({ innerStatus: inner.status, inner: await inner.json() });
  }
  return new Response("not found", { status: 404 });
}

const handle = createAppHandler({ basePath: () => "", render });

type Caller = { name: string; headers: () => Promise<Record<string, string>> };

function peer(ip: string): Record<string, string> {
  return {
    "x-omniroute-peer-ip": `${STAMP}|${ip}`,
    "x-omniroute-via-proxy": `${STAMP}|0`,
  };
}

async function sessionCookie(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
  return `auth_token=${token}`;
}

/** The status a direct call gets, and the status the loader's replay gets (null: page denied). */
async function compare(caller: Caller, api: string, method: string) {
  const headers = await caller.headers();
  const direct = await handle(new Request(`${ORIGIN}${api}`, { method, headers }));

  // The page request is a GET for a loader and a POST for an action, as React Router sends them.
  const pageMethod = method === "GET" ? "GET" : "POST";
  const pageHeaders = { ...headers };
  if (pageMethod === "POST" && pageHeaders.cookie) {
    const csrf = issueDashboardCsrfToken(new Request(ORIGIN, { headers: pageHeaders }));
    if (csrf) pageHeaders["x-omniroute-csrf"] = csrf.token;
  }
  const query = new URLSearchParams({ api, method });
  const page = await handle(
    new Request(`${ORIGIN}/dashboard/probe?${query}`, { method: pageMethod, headers: pageHeaders })
  );
  if (page.status !== 200) return { direct: direct.status, loader: null, page: page.status };
  const body = (await page.json()) as { innerStatus: number };
  return { direct: direct.status, loader: body.innerStatus, page: page.status };
}

test.beforeEach(async () => {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
});

test.after(async () => {
  await core.resetDbInstance();
  await cleanupTempDataDir(TEST_DATA_DIR);
});

test("requireLogin off: an anonymous loader is refused an always-protected route, like a direct call", async () => {
  await settingsDb.updateSettings({ requireLogin: false });
  const anonymousLoopback: Caller = { name: "anonymous", headers: async () => peer("127.0.0.1") };

  const open = await compare(anonymousLoopback, "/api/keys", "GET");
  assert.deepEqual(open, { direct: 200, loader: 200, page: 200 });

  const guarded = await compare(anonymousLoopback, "/api/providers/client", "GET");
  assert.equal(guarded.page, 200, "the dashboard page itself is open under requireLogin=false");
  assert.equal(guarded.direct, 401);
  assert.equal(guarded.loader, guarded.direct);
});

test("a remote dashboard session is refused a strict LOCAL_ONLY route, like a direct call", async () => {
  await settingsDb.updateSettings({ requireLogin: true, password: "x" });
  const cookie = await sessionCookie();
  const remoteSession: Caller = {
    name: "remote session",
    headers: async () => ({ ...peer("203.0.113.9"), cookie }),
  };

  const local = await compare(remoteSession, "/api/discovery/results", "GET");
  assert.equal(local.page, 200);
  assert.equal(local.direct, 403);
  assert.equal(local.loader, local.direct);

  // The manage-scope bypass list admits a dashboard session from a remote peer.
  const mcp = await compare(remoteSession, "/api/mcp/status", "GET");
  assert.deepEqual(mcp, { direct: 200, loader: 200, page: 200 });
});

test("a manage-scope key reaches the same routes through a loader as directly", async () => {
  await settingsDb.updateSettings({ requireLogin: true, password: "x" });
  const created = await apiKeysDb.createApiKey("parity-manage", "machine-parity", ["manage"]);
  const remoteKey: Caller = {
    name: "remote manage key",
    headers: async () => ({ ...peer("203.0.113.9"), authorization: `Bearer ${created.key}` }),
  };

  for (const api of ["/api/keys", "/api/mcp/status", "/api/discovery/results"]) {
    const result = await compare(remoteKey, api, "GET");
    assert.equal(result.page, 200, `${api}: the page accepts a manage key`);
    assert.equal(result.loader, result.direct, `${api}: loader matches the direct call`);
  }
});

test("a key without the manage scope never gets past the page, so no replay runs", async () => {
  await settingsDb.updateSettings({ requireLogin: true, password: "x" });
  const created = await apiKeysDb.createApiKey("parity-read", "machine-parity-read", ["read"]);
  const readKey: Caller = {
    name: "read key",
    headers: async () => ({ ...peer("203.0.113.9"), authorization: `Bearer ${created.key}` }),
  };
  const result = await compare(readKey, "/api/keys", "GET");
  assert.equal(result.loader, null);
  assert.notEqual(result.page, 200);
});

test("a dashboard action replays a write with the session's CSRF proof, like a direct call", async () => {
  await settingsDb.updateSettings({ requireLogin: true, password: "x" });
  const cookie = await sessionCookie();
  const session: Caller = {
    name: "loopback session",
    headers: async () => {
      const headers: Record<string, string> = { ...peer("127.0.0.1"), cookie };
      const csrf = issueDashboardCsrfToken(new Request(ORIGIN, { headers }));
      if (csrf) headers["x-omniroute-csrf"] = csrf.token;
      return headers;
    },
  };
  const result = await compare(session, "/api/keys", "POST");
  assert.equal(result.page, 200);
  assert.equal(result.loader, result.direct);
});

test("apiJson() sends a 401 to the login page under the deploy's base path", async () => {
  await settingsDb.updateSettings({ requireLogin: true, password: "x" });
  const { apiJson } = await import("../../../src/server/routing/dashboardApi.server.ts");
  // A page under /omniroute whose loader reads an API route the caller is not signed in for.
  const based = createAppHandler({
    basePath: () => "/omniroute",
    render: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/omniroute/api/")) return Response.json({}, { status: 401 });
      try {
        await apiJson("/api/keys");
        return new Response("loaded");
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      }
    },
  });
  // The page itself is public here (the onboarding page), so only the API answer decides.
  const response = await based(
    new Request(`${ORIGIN}/omniroute/dashboard/onboarding`, { headers: peer("127.0.0.1") })
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/omniroute/login");
});

test("apiRequest() refuses a path outside /api/ and a call outside a request", async () => {
  await assert.rejects(() => apiRequest("/api/keys"), /only while the server handles a request/);
  await settingsDb.updateSettings({ requireLogin: false });
  await assert.rejects(
    () =>
      handle(
        new Request(`${ORIGIN}/dashboard/probe?api=${encodeURIComponent("/dashboard/x")}`, {
          headers: peer("127.0.0.1"),
        })
      ),
    /must target \/api\//
  );
});
