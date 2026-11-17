import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { resetTestDb } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-fixes-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { createProxy } = await import("@/lib/db/proxies");
const localDb = { createProxy };
const tokenRefresh = await import("../../open-sse/services/tokenRefresh.ts");
const proxyFetch = await import("../../open-sse/utils/proxyFetch.ts");
const proxyDispatcher = await import("../../open-sse/utils/proxyDispatcher.ts");
const proxySettingsRoute = await import("../../src/app/api/settings/proxy/route.ts");
const proxyTestRoute = await import("../../src/app/api/settings/proxy/test/route.ts");
const shutdownRoute = await import("../../src/app/api/shutdown/route.ts");
const restartRoute = await import("../../src/app/api/restart/route.ts");

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function resetStorage() {
  await resetTestDb();
}

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("token refresh dedupe key avoids collision for same-prefix tokens", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, options = {}) => {
    const refreshToken = options.body?.get?.("refresh_token") || "unknown";
    requests.push(refreshToken);
    return new Response(
      JSON.stringify({
        access_token: `access-${refreshToken}`,
        refresh_token: `refresh-${refreshToken}`,
        expires_in: 3600,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    const prefix = "abcdefghijklmnop";
    const tokenA = `${prefix}-account-a`;
    const tokenB = `${prefix}-account-b`;

    const [resultA, resultB] = await Promise.all([
      tokenRefresh.getAccessToken("codex", { refreshToken: tokenA }, null),
      tokenRefresh.getAccessToken("codex", { refreshToken: tokenB }, null),
    ]);

    assert.equal(requests.length, 2);
    assert.equal(resultA.accessToken, `access-${tokenA}`);
    assert.equal(resultB.accessToken, `access-${tokenB}`);
    assert.notEqual(resultA.accessToken, resultB.accessToken);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider connection persists rateLimitProtection across reopen", async () => {
  await resetStorage();

  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "rl-test",
    apiKey: "sk-test",
  });

  await providersDb.updateProviderConnection((created as any).id, { rateLimitProtection: true });

  const firstRead = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal(firstRead.rateLimitProtection, true);

  await core.resetDbInstance();
  const secondRead = await providersDb.getProviderConnectionById((created as any).id);
  assert.equal(secondRead.rateLimitProtection, true);
});

test("shutdown route uses SIGTERM for graceful shutdown", async () => {
  const originalKill = process.kill;
  const originalSetTimeout = globalThis.setTimeout;
  const calls = [];

  process.kill = (pid, signal) => {
    calls.push({ pid, signal });
    return true;
  };
  globalThis.setTimeout = (callback) => {
    callback();
    return 0;
  };

  try {
    const response = await shutdownRoute.POST();
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ pid: process.pid, signal: "SIGTERM" }]);
  } finally {
    process.kill = originalKill;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("restart route uses SIGTERM for graceful restart", async () => {
  const originalKill = process.kill;
  const originalSetTimeout = globalThis.setTimeout;
  const calls = [];

  process.kill = (pid, signal) => {
    calls.push({ pid, signal });
    return true;
  };
  globalThis.setTimeout = (callback) => {
    callback();
    return 0;
  };

  try {
    const response = await restartRoute.POST();
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ pid: process.pid, signal: "SIGTERM" }]);
  } finally {
    process.kill = originalKill;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("resolveProxyForConnection applies combo proxy for object/string model entries", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    email: "combo-test@example.com",
    accessToken: "access",
    refreshToken: "refresh",
  });

  const combo = await combosDb.createCombo({
    id: "combo-proxy-test",
    name: "combo-proxy-test",
    strategy: "priority",
    models: ["openai/gpt-5", { model: "cc/claude-sonnet-4-5-20250929", weight: 100 }],
  });

  await settingsDb.setProxyForLevel("combo", (combo as any).id, {
    type: "http",
    host: "127.0.0.1",
    port: "8080",
  });

  const resolved = await settingsDb.resolveProxyForConnection((conn as any).id);
  assert.equal(resolved.level, "combo");
  assert.equal(resolved.levelId, combo.id);
});

test("normalizeProxyUrl accepts socks5 only when explicitly allowed", () => {
  const socksUrl = "socks5://127.0.0.1:1080";

  const normalized = proxyDispatcher.normalizeProxyUrl(socksUrl, "test proxy", {
    allowSocks5: true,
  });
  assert.match(normalized, /^socks5:\/\/127\.0\.0\.1:1080\/?$/);

  assert.throws(
    () =>
      proxyDispatcher.normalizeProxyUrl(socksUrl, "test proxy", {
        allowSocks5: false,
      }),
    /SOCKS5 proxy is disabled/i
  );
});

test("createProxyDispatcher builds dispatchers for http, https, and socks5", async () => {
  await withEnv("ENABLE_SOCKS5_PROXY", "true", async () => {
    const httpDispatcher = proxyDispatcher.createProxyDispatcher("http://127.0.0.1:8080");
    const httpsDispatcher = proxyDispatcher.createProxyDispatcher("https://127.0.0.1:8443");
    const socksDispatcher = proxyDispatcher.createProxyDispatcher("socks5://127.0.0.1:1080");

    assert.equal(typeof httpDispatcher.dispatch, "function");
    assert.equal(typeof httpsDispatcher.dispatch, "function");
    assert.equal(typeof socksDispatcher.dispatch, "function");
  });
});

test("proxy fetch fails closed when context proxy is invalid", async () => {
  await assert.rejects(
    proxyFetch.runWithProxyContext({ type: "http", host: "127.0.0.1", port: "9" }, async () =>
      fetch("https://example.com")
    )
  );
});

test("proxy fetch rejects socks5 context when feature flag is disabled", async () => {
  await withEnv("ENABLE_SOCKS5_PROXY", "false", async () => {
    await assert.rejects(
      proxyFetch.runWithProxyContext(
        { type: "socks5", host: "127.0.0.1", port: "1080" },
        async () => fetch("https://example.com")
      ),
      /ENABLE_SOCKS5_PROXY/i
    );
  });
});

test("proxy fetch accepts socks5 context when feature flag is enabled", async () => {
  await withEnv("ENABLE_SOCKS5_PROXY", "true", async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const result = await proxyFetch.runWithProxyContext(
        { type: "socks5", host: "127.0.0.1", port: String(address.port) },
        async () => "ok"
      );
      assert.equal(result, "ok");
    } finally {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });
});

test("proxy settings route blocks socks5 with backend flag disabled", async () => {
  await resetStorage();

  await withEnv("ENABLE_SOCKS5_PROXY", "false", async () => {
    const request = new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        level: "global",
        proxy: {
          type: "socks5",
          host: "127.0.0.1",
          port: "1080",
        },
      }),
    });

    const response = await proxySettingsRoute.PUT(request);
    const payload = (await response.json()) as any;
    assert.equal(response.status, 400);
    assert.match(payload.error.message, /SOCKS5 proxy is disabled/i);
  });
});

test("proxy settings route accepts socks5 with backend flag enabled", async () => {
  await resetStorage();

  await withEnv("ENABLE_SOCKS5_PROXY", "true", async () => {
    const request = new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        level: "global",
        proxy: {
          type: "SOCKS5",
          host: "127.0.0.1",
          port: "1080",
        },
      }),
    });

    const response = await proxySettingsRoute.PUT(request);
    const payload = (await response.json()) as any;
    assert.equal(response.status, 200);
    assert.equal(payload.global.type, "socks5");
  });
});

test("proxy test route rejects socks5 when backend flag is disabled", async () => {
  await withEnv("ENABLE_SOCKS5_PROXY", "false", async () => {
    const request = new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: {
          type: "socks5",
          host: "127.0.0.1",
          port: "1080",
        },
      }),
    });

    const response = await proxyTestRoute.POST(request);
    const payload = (await response.json()) as any;

    assert.equal(response.status, 400);
    assert.match(payload.error.message, /SOCKS5 proxy is disabled/i);
  });
});

test("proxy test route runs socks5 test when backend flag is enabled", async () => {
  await withEnv("ENABLE_SOCKS5_PROXY", "true", async () => {
    const request = new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: {
          type: "socks5",
          host: "127.0.0.1",
          port: "1",
        },
      }),
    });

    const response = await proxyTestRoute.POST(request);
    const payload = (await response.json()) as any;

    assert.notEqual(response.status, 400);
    assert.equal(payload.success, false);
    assert.equal(payload.proxyUrl, "socks5://127.0.0.1:1");
  });
});

test("proxy test route validates JSON, schema, and proxy types before dispatching", async () => {
  await resetStorage();

  const invalidJsonResponse = await proxyTestRoute.POST(
    new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
  );
  const invalidJsonBody = (await invalidJsonResponse.json()) as any;
  assert.equal(invalidJsonResponse.status, 400);
  assert.equal(invalidJsonBody.error.message, "Invalid JSON body");

  const invalidBodyResponse = await proxyTestRoute.POST(
    new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proxy: { port: "8080" } }),
    })
  );
  const invalidBody = (await invalidBodyResponse.json()) as any;
  assert.equal(invalidBodyResponse.status, 400);
  assert.equal(invalidBody.error.message, "Invalid request");

  const socks4Response = await proxyTestRoute.POST(
    new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: {
          type: "socks4",
          host: "127.0.0.1",
          port: "1080",
        },
      }),
    })
  );
  const socks4Body = (await socks4Response.json()) as any;
  assert.equal(socks4Response.status, 400);
  assert.match(socks4Body.error.message, /proxy\.type must be http(, https, or socks5| or https)/i);

  const unsupportedResponse = await proxyTestRoute.POST(
    new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: {
          type: "ftp",
          host: "127.0.0.1",
          port: "21",
        },
      }),
    })
  );
  const unsupportedBody = (await unsupportedResponse.json()) as any;
  assert.equal(unsupportedResponse.status, 400);
  assert.match(
    unsupportedBody.error.message,
    /proxy\.type must be http(, https, or socks5| or https)/i
  );
});

test("proxy test route handles invalid proxy ports and uses stored proxy config when proxyId is provided", async () => {
  await resetStorage();

  const invalidPortResponse = await proxyTestRoute.POST(
    new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxy: {
          type: "http",
          host: "127.0.0.1",
          port: "70000",
        },
      }),
    })
  );
  const invalidPortBody = (await invalidPortResponse.json()) as any;
  assert.equal(invalidPortResponse.status, 400);
  assert.match(invalidPortBody.error.message, /invalid proxy port/i);

  const storedProxy = await localDb.createProxy({
    name: "Stored Proxy",
    type: "http",
    host: "127.0.0.1",
    port: 1,
    username: "alice",
    password: "secret",
  });

  const proxyIdResponse = await proxyTestRoute.POST(
    new Request("http://localhost/api/settings/proxy/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proxyId: storedProxy.id,
        proxy: {
          host: "127.0.0.1",
          port: 0,
        },
      }),
    })
  );
  const proxyIdBody = (await proxyIdResponse.json()) as any;
  assert.notEqual(proxyIdResponse.status, 400);
  assert.equal(proxyIdBody.success, false);
  assert.equal(proxyIdBody.proxyUrl, "http://127.0.0.1:1");
});
