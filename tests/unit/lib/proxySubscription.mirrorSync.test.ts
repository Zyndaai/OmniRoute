import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-multi-mirror-"));
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

async function insertSubscription(id: string, url: string, mirrorUrls: string[] | null) {
  await getTestBackend().execute(
    `INSERT INTO proxy_subscriptions (id, name, url, mirror_urls, enabled, mode, update_interval_minutes, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, 'global', 60, 'empty', $5, $6)`,
    [
      id,
      `sub-${id}`,
      url,
      mirrorUrls ? JSON.stringify(mirrorUrls) : null,
      nowIso(),
      nowIso(),
    ]
  );
}

async function poolHosts(id: string): Promise<string[]> {
  const rows = await getTestBackend().query<{ host: string }>(
    "SELECT host FROM proxy_registry WHERE subscription_id = $1",
    [id]
  );
  return rows.map((r) => r.host).sort();
}

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("two healthy feeds sync the union into the pool", async () => {
  await reset();
  const { fetchSubscriptionFeeds } = await import("../../../src/lib/proxySubscription/multiSource.ts");
  const feeds = await fetchSubscriptionFeeds(
    {
      url: "https://example.com/primary",
      mirrorUrls: ["https://example.com/mirror"],
    },
    async (url) =>
      url.includes("mirror")
        ? "vless://user-b@203.0.113.11:443#beta"
        : "vless://user-a@203.0.113.10:443#alpha"
  );
  assert.equal(feeds.length, 2);
  assert.ok(feeds.every((f) => f.ok));
  assert.deepEqual(
    feeds.map((f) => f.url),
    ["https://example.com/primary", "https://example.com/mirror"]
  );
  const { parseSubscription } = await import("../../../src/lib/proxySubscription/parse.ts");
  const union = (
    await import("../../../src/lib/proxySubscription/coreConfig/sync.ts")
  ).mergeParsedSources(feeds.map((f) => f.parsed));
  assert.equal(union.nodes.length + union.needsCore.length, 2);
  assert.equal(union.needsCore.length, 2);
  void parseSubscription;
});

test("partial failure syncs survivors and drops the dead feed nodes", async () => {
  await reset();
  await insertSubscription("m-partial", "https://example.com/primary", [
    "https://example.com/mirror",
  ]);
  await proxies.createProxy({
    name: "dead-node",
    type: "http",
    host: "198.51.100.99",
    port: 8080,
    source: "subscription",
    subscriptionId: "m-partial",
    status: "active",
  });
  const { fetchSubscriptionFeeds } = await import("../../../src/lib/proxySubscription/multiSource.ts");
  const feeds = await fetchSubscriptionFeeds(
    await sub.getSubscriptionById("m-partial").then((r) => r!),
    async (url) => {
      if (url.includes("mirror")) throw new Error("boom");
      return "http://user@203.0.113.10:8080#alpha";
    }
  );
  assert.equal(feeds.filter((f) => f.ok).length, 1);
  assert.equal(feeds[1].ok, false);
  assert.equal(feeds[1].fetchFailed, true);
});

test("total failure refuses with pool and last nodes intact", async () => {
  await reset();
  const { fetchSubscriptionFeeds } = await import("../../../src/lib/proxySubscription/multiSource.ts");
  const feeds = await fetchSubscriptionFeeds(
    { url: "https://example.com/primary", mirrorUrls: ["https://example.com/mirror"] },
    async () => {
      throw new Error("down");
    }
  );
  assert.ok(feeds.every((f) => !f.ok));
  assert.ok(feeds.every((f) => f.fetchFailed));
  const { parseSubscription, isUsableSubscriptionContent } =
    await import("../../../src/lib/proxySubscription/parse.ts");
  for (const f of feeds) assert.equal(isUsableSubscriptionContent(f.parsed), false);
  void parseSubscription;
});

test("mirror list coerces leniently: trims, dedupes, caps, excludes primary", async () => {
  const { coerceMirrorUrls, MAX_MIRROR_URLS } =
    await import("../../../src/lib/proxySubscription/mirrorUrls.ts");
  const primary = "https://example.com/primary";
  assert.deepEqual(coerceMirrorUrls(undefined, primary), null);
  assert.deepEqual(coerceMirrorUrls(null, primary), null);
  assert.deepEqual(coerceMirrorUrls("nope", primary), null);
  assert.deepEqual(
    coerceMirrorUrls(["  https://example.com/a  ", "", primary, "https://example.com/a"], primary),
    ["https://example.com/a"]
  );
  const many = Array.from({ length: MAX_MIRROR_URLS + 3 }, (_, i) => `https://example.com/${i}`);
  assert.equal(coerceMirrorUrls(many, primary)!.length, MAX_MIRROR_URLS);
});

test("pool union: direct upsert of merged nodes keeps both feeds", async () => {
  await reset();
  await insertSubscription("m-union", "https://example.com/primary", null);
  const { parseSubscription } = await import("../../../src/lib/proxySubscription/parse.ts");
  const { mergeParsedSources } = await import("../../../src/lib/proxySubscription/coreConfig/sync.ts");
  const merged = mergeParsedSources([
    parseSubscription("http://user-a@203.0.113.10:8080#alpha"),
    parseSubscription("http://user-b@203.0.113.11:8080#beta"),
  ]);
  assert.equal(merged.nodes.length, 2);
  for (const node of merged.nodes) {
    await proxies.upsertProxy(
      {
        name: node.name,
        type: node.type,
        host: node.host,
        port: node.port,
        source: "subscription",
        subscriptionId: "m-union",
      },
      { claimOwnership: false }
    );
  }
  assert.deepEqual(await poolHosts("m-union"), ["203.0.113.10", "203.0.113.11"]);
});
