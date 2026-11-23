import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sub-svc-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const proxies = await import("../../../src/lib/db/proxies.ts");
const sub = await import("../../../src/lib/proxySubscription/index.ts");

async function reset() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

async function insertSubscription(
  id: string,
  mode: "global" | "rule",
  opts: { enabled?: boolean; ruleProviders?: string[] } = {}
) {
  await getTestBackend().execute(
    `INSERT INTO proxy_subscriptions
      (id, name, url, enabled, mode, rule_providers, update_interval_minutes, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'empty', $8, $9)`,
    [
      id,
      `sub-${id}`,
      `https://example.com/${id}`,
      opts.enabled !== false,
      mode,
      opts.ruleProviders ? JSON.stringify(opts.ruleProviders) : null,
      60,
      nowIso(),
      nowIso(),
    ]
  );
}

// Feature flags and settings live in config_entries (jsonb values).
async function readProxyEnabled(): Promise<unknown> {
  const row = await getTestBackend().queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace='settings' AND key='proxyEnabled'"
  );
  return row?.value;
}

async function insertProviderConnection(id: string, provider: string) {
  await getTestBackend().execute(
    "INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES ($1,$2,$3,$4)",
    [id, provider, nowIso(), nowIso()]
  );
}

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("global subscription binds its pool to the global scope and is resolvable", async () => {
  await reset();
  await insertSubscription("s1", "global", { enabled: true });
  await proxies.createProxy({
    name: "node1",
    type: "http",
    host: "10.0.0.1",
    port: 8080,
    source: "subscription",
    subscriptionId: "s1",
    status: "active",
  });

  await sub.applySubscription("s1");

  const resolved = await proxies.resolveProxyForConnectionFromRegistry("conn-xyz");
  assert.ok(resolved, "expected a global proxy to be resolved");
  assert.equal(resolved?.proxy.host, "10.0.0.1");

  assert.equal(await readProxyEnabled(), true);

  // Unapply -> proxy removed from global scope, proxyEnabled recomputed to false.
  await sub.unapplySubscription("s1");
  const resolved2 = await proxies.resolveProxyForConnectionFromRegistry("conn-xyz");
  assert.equal(resolved2, null, "expected direct (no proxy) after unapply");

  assert.equal(await readProxyEnabled(), false);
});

test("rule subscription binds only the selected provider scope", async () => {
  await reset();
  await insertSubscription("s2", "rule", { enabled: true, ruleProviders: ["provA"] });
  await proxies.createProxy({
    name: "node2",
    type: "http",
    host: "10.0.0.2",
    port: 8080,
    source: "subscription",
    subscriptionId: "s2",
    status: "active",
  });

  await sub.applySubscription("s2");

  await insertProviderConnection("connA", "provA");
  await insertProviderConnection("connB", "provB");

  const rA = await proxies.resolveProxyForConnectionFromRegistry("connA");
  assert.ok(rA, "provider A should resolve the rule proxy");
  assert.equal(rA?.proxy.host, "10.0.0.2");

  const rB = await proxies.resolveProxyForConnectionFromRegistry("connB");
  assert.equal(rB, null, "provider B is not in the rule set -> direct");
});

test("fail-closed: a dead subscription proxy blocks the connection instead of leaking", async () => {
  await reset();
  await insertSubscription("s3", "global", { enabled: true });
  await proxies.createProxy({
    name: "deadnode",
    type: "http",
    host: "10.0.0.9",
    port: 1,
    source: "subscription",
    subscriptionId: "s3",
    status: "dead",
  });

  await sub.applySubscription("s3");

  assert.equal(await readProxyEnabled(), true);

  // Dead proxy is excluded from resolution -> request would go direct.
  const resolved = await proxies.resolveProxyForConnectionFromRegistry("connZ");
  assert.equal(resolved, null);

  // But the operator assigned a (now dead) proxy, so this must be blocked.
  const blocked = await proxies.hasBlockingProxyAssignment("connZ");
  assert.equal(blocked, true);
});

test("deleteSubscription unbinds and removes its proxy rows", async () => {
  await reset();
  await insertSubscription("s4", "global", { enabled: true });
  await proxies.createProxy({
    name: "node4",
    type: "http",
    host: "10.0.0.4",
    port: 8080,
    source: "subscription",
    subscriptionId: "s4",
    status: "active",
  });
  await sub.applySubscription("s4");

  const ok = await sub.deleteSubscription("s4");
  assert.equal(ok, true);

  const rows = await getTestBackend().query<{ id: string }>(
    "SELECT id FROM proxy_registry WHERE subscription_id = $1",
    ["s4"]
  );
  assert.equal(rows.length, 0, "subscription proxy rows should be removed");

  const assignments = await getTestBackend().queryOne(
    "SELECT 1 FROM proxy_assignments a JOIN proxy_registry p ON p.id=a.proxy_id WHERE p.source='subscription' LIMIT 1"
  );
  assert.ok(!assignments, "no subscription proxy should remain assigned");

  const subRow = await getTestBackend().queryOne("SELECT 1 FROM proxy_subscriptions WHERE id='s4'");
  assert.ok(!subRow, "subscription row should be deleted");
});

test("global→rule switch re-evaluates binding: drops global, binds the selected provider scope", async () => {
  await reset();

  // Start in GLOBAL mode and bind the pool to the global scope.
  // The subscription row must exist before its proxy rows (proxy_registry FK).
  await insertSubscription("s5", "global", { enabled: true });

  // Seed a proxy node directly (avoids a network fetch for this part).
  await proxies.createProxy({
    name: "node5",
    type: "http",
    host: "10.0.0.5",
    port: 8080,
    source: "subscription",
    subscriptionId: "s5",
    status: "active",
  });
  await sub.applySubscription("s5");

  const before = await proxies.resolveProxyForConnectionFromRegistry("connAny");
  assert.ok(before, "global mode should resolve the node for any connection");
  assert.equal(before?.proxy.host, "10.0.0.5");

  // Switch to RULE mode targeting provider provA. updateSubscription must
  // detach the previous global binding (unapplySubscription) and re-bind the
  // pool to the selected provider scope. Stub fetch so syncSubscription's
  // re-fetch returns a body that keeps node5 around.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () =>
      "proxies:\n  - name: node5\n    type: http\n    server: 10.0.0.5\n    port: 8080\n",
  })) as unknown as typeof fetch;
  try {
    await sub.updateSubscription("s5", { mode: "rule", ruleProviders: ["provA"] });
  } finally {
    globalThis.fetch = realFetch;
  }

  // The global binding must be gone.
  const afterGlobal = await proxies.resolveProxyForConnectionFromRegistry("connAny");
  assert.equal(afterGlobal, null, "global binding should be dropped after switching to rule mode");

  // The provider-scope binding must now resolve the node.
  await insertProviderConnection("connA", "provA");
  const afterRule = await proxies.resolveProxyForConnectionFromRegistry("connA");
  assert.ok(afterRule, "rule mode should bind the node to provider provA");
  assert.equal(afterRule?.proxy.host, "10.0.0.5");
});

// ─────────────────── Regression: #10158 local proxy subscription ───────────────────
// Promoted from the TDD probe (was RED on release/v3.8.50: createSubscription against a
// real local (127.0.0.1) HTTP server failed with "Fetch failed: Subscription URL is not
// allowed (scheme or host blocked)" even though coreEndpoint.ts already permits routing
// through a loopback core). Uses a REAL local HTTP server (not a fetch stub) so the fix
// is proven end-to-end through assertSafeFetchTarget's SSRF guard.

function startLocalSubscriptionServer(
  body: string
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(body);
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}/list`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

test("#10158: createSubscription against a real local (127.0.0.1) HTTP server syncs ok", async () => {
  await reset();
  const LIST_BODY = [
    "proxies:",
    "  - name: local-node",
    "    type: http",
    "    server: 127.0.0.1",
    "    port: 8080",
  ].join("\n");
  const { url, close } = await startLocalSubscriptionServer(LIST_BODY);
  try {
    const created = await sub.createSubscription({
      name: "local-list",
      url,
      enabled: true,
      mode: "global",
    });
    assert.equal(
      created.status,
      "ok",
      `expected ok, got status=${created.status} error=${created.error}`
    );
    assert.ok((created.lastNodes ?? []).length >= 1, "expected at least one parsed node");
  } finally {
    await close();
  }
});
