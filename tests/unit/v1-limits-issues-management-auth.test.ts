// /api/v1/providers/[provider]/limits, /api/v1/accounts/[id]/limits and POST
// /api/v1/issues/report are management surfaces (they change issuance limits or file issues
// with the operator's GitHub token), so they take the same credential as /api/v1/registered-keys:
// dashboard session, local CLI token, or an API key with `manage`/`admin` scope. A plain
// inference key (read / write scope) must get 403.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(process.env.DATA_DIR || os.tmpdir(), "omniroute-v1-limits-auth-")
);
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
  JWT_SECRET: process.env.JWT_SECRET,
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD,
  GITHUB_ISSUES_REPO: process.env.GITHUB_ISSUES_REPO,
  GITHUB_ISSUES_TOKEN: process.env.GITHUB_ISSUES_TOKEN,
};

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "v1-limits-auth-api-key-secret";
process.env.JWT_SECRET = "v1-limits-auth-jwt-secret";
process.env.INITIAL_PASSWORD = "v1-limits-auth-password";
delete process.env.GITHUB_ISSUES_REPO;
delete process.env.GITHUB_ISSUES_TOKEN;

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const providerLimits = await import("../../src/app/api/v1/providers/[provider]/limits/route.ts");
const accountLimits = await import("../../src/app/api/v1/accounts/[id]/limits/route.ts");
const issuesReport = await import("../../src/app/api/v1/issues/report/route.ts");

await updateSettings({ requireLogin: true });
const readKey = await apiKeysDb.createApiKey("read-automation", "machine-limits", ["read"]);
const writeKey = await apiKeysDb.createApiKey("write-automation", "machine-limits", ["write"]);
const manageKey = await apiKeysDb.createApiKey("manage-automation", "machine-limits", ["manage"]);

test.after(async () => {
  apiKeysDb.resetApiKeyState();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type RequestFactory = (url: string, method: string, body?: unknown) => Promise<Request>;

function plainRequest(headers: Record<string, string> = {}): RequestFactory {
  return async (url, method, body) =>
    new Request(url, {
      method,
      headers: body ? { ...headers, "content-type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
}

const sessionRequest: RequestFactory = (url, method, body) =>
  makeManagementSessionRequest(url, { method, body: body as Record<string, unknown> });

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

interface Surface {
  name: string;
  okStatus: number;
  invoke: (make: RequestFactory) => Promise<Response>;
}

const BASE = "http://localhost:20128/api/v1";
const LIMITS_BODY = { maxActiveKeys: 3 };

const SURFACES: Surface[] = [
  {
    name: "GET /api/v1/providers/[provider]/limits",
    okStatus: 200,
    invoke: async (make) =>
      providerLimits.GET(await make(`${BASE}/providers/openai/limits`, "GET"), {
        params: Promise.resolve({ provider: "openai" }),
      }),
  },
  {
    name: "PUT /api/v1/providers/[provider]/limits",
    okStatus: 200,
    invoke: async (make) =>
      providerLimits.PUT(await make(`${BASE}/providers/openai/limits`, "PUT", LIMITS_BODY), {
        params: Promise.resolve({ provider: "openai" }),
      }),
  },
  {
    name: "GET /api/v1/accounts/[id]/limits",
    okStatus: 200,
    invoke: async (make) =>
      accountLimits.GET(await make(`${BASE}/accounts/acct-1/limits`, "GET"), {
        params: Promise.resolve({ id: "acct-1" }),
      }),
  },
  {
    name: "PUT /api/v1/accounts/[id]/limits",
    okStatus: 200,
    invoke: async (make) =>
      accountLimits.PUT(await make(`${BASE}/accounts/acct-1/limits`, "PUT", LIMITS_BODY), {
        params: Promise.resolve({ id: "acct-1" }),
      }),
  },
  {
    name: "POST /api/v1/issues/report",
    okStatus: 202,
    invoke: async (make) =>
      issuesReport.POST(await make(`${BASE}/issues/report`, "POST", { title: "quota exceeded" })),
  },
];

for (const surface of SURFACES) {
  test(`${surface.name}: unauthenticated callers get 401`, async () => {
    const response = await surface.invoke(plainRequest());
    assert.equal(response.status, 401);
  });

  test(`${surface.name}: read- and write-scoped API keys get 403`, async () => {
    for (const key of [readKey.key, writeKey.key]) {
      const response = await surface.invoke(plainRequest(bearer(key)));
      const text = await response.text();
      assert.equal(response.status, 403, text);
      assert.ok(!text.includes(key), "error body must not echo the credential");
    }
  });

  test(`${surface.name}: a manage-scoped API key is allowed`, async () => {
    const response = await surface.invoke(plainRequest(bearer(manageKey.key)));
    assert.equal(response.status, surface.okStatus, await response.text());
  });

  test(`${surface.name}: a dashboard session is allowed`, async () => {
    const response = await surface.invoke(sessionRequest);
    assert.equal(response.status, surface.okStatus, await response.text());
  });
}
