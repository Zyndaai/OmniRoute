import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-video-drilldown-hardening-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "video-drilldown-hardening-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const route = await import("../../src/app/api/v1/video-bridge/drilldown/route.ts");
const { VideoDrilldownLifecycle } =
  await import("../../src/lib/guardrails/videoBridgeDrilldownLifecycle.ts");
const { VideoDrilldownCache } = await import("../../src/lib/guardrails/videoBridgeDrilldown.ts");
const { resolveEndpointCategory } = await import("../../src/shared/constants/endpointCategories.ts");

test.beforeEach(async () => {
  apiKeysDb.resetApiKeyState();
  await resetTestDb();
});
test.after(async () => {
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const derivation = {
  parentContentHash: `sha256:${"a".repeat(64)}`,
  policy: "uniform",
  version: "video-drilldown/v1",
} as const;

async function jpegDataUri(): Promise<string> {
  const jpeg = await sharp({ create: { width: 640, height: 360, channels: 3, background: "blue" } })
    .jpeg()
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

async function payload() {
  return {
    derivation,
    durationSeconds: 10,
    frames: [{ dataUri: await jpegDataUri(), timestampSeconds: 2 }],
  };
}

function req(url: string, key: string, method = "GET", signal?: AbortSignal): Request {
  return new Request(`http://omniroute.local${url}`, {
    headers: { Authorization: `Bearer ${key}` },
    method,
    signal,
  });
}

function newLifecycle() {
  return new VideoDrilldownLifecycle({
    cache: new VideoDrilldownCache({ maxEntries: 8, ttlMs: 60_000 }),
  });
}

test("drill-down paths belong to the video endpoint category", () => {
  assert.equal(resolveEndpointCategory("/v1/video-bridge/drilldown"), "video");
});

test("consumer applies the video endpoint policy to both aliases and honors changed permissions", async () => {
  const { key } = await apiKeysDb.createApiKey("drill-policy", "test", []);
  const lifecycle = newLifecycle();
  const { enforceApiKeyPolicy } = await import("../../src/shared/utils/apiKeyPolicy.ts");
  const policy = await enforceApiKeyPolicy(req("/x", key), null);
  const principalId = policy.apiKeyInfo!.id;
  const { handle } = await lifecycle.produce(principalId, await payload());
  const deps = { isRemoteAccessEnabled: () => true, lifecycle };

  await apiKeysDb.updateApiKeyPermissions(principalId, { allowedEndpoints: ["embeddings"] });
  for (const prefix of ["/v1", "/api/v1"]) {
    for (const method of ["GET", "DELETE"]) {
      const response = await route.handleVideoBridgeDrilldownConsumerRequest(
        req(`${prefix}/video-bridge/drilldown?handle=${handle}`, key, method),
        deps
      );
      assert.equal(response.status, 403, `${method} ${prefix}`);
    }
  }

  await apiKeysDb.updateApiKeyPermissions(principalId, { allowedEndpoints: ["video"] });
  const allowed = await route.handleVideoBridgeDrilldownConsumerRequest(
    req(`/v1/video-bridge/drilldown?handle=${handle}`, key),
    deps
  );
  assert.equal(allowed.status, 200);
  const deleted = await route.handleVideoBridgeDrilldownConsumerRequest(
    req(`/api/v1/video-bridge/drilldown?handle=${handle}`, key, "DELETE"),
    deps
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { removed: 1 });
});

test("consumer rejects ambiguous duplicate queries and reversed focus windows", async () => {
  const { key } = await apiKeysDb.createApiKey("drill-ambiguous", "test", []);
  for (const suffix of ["&frames=1&frames=8", "&start=4&end=2", "&start=4&end=4"]) {
    const response = await route.handleVideoBridgeDrilldownConsumerRequest(
      req(`/api/v1/video-bridge/drilldown?handle=${"a".repeat(64)}${suffix}`, key),
      { isRemoteAccessEnabled: () => true }
    );
    assert.equal(response.status, 400, suffix);
  }
});

test("the remote response JSON is bounded by 32 MiB including base64 and envelope", async () => {
  const { key } = await apiKeysDb.createApiKey("drill-bounded", "test", []);
  const lifecycle = newLifecycle();
  Object.assign(lifecycle, {
    resolve: async () => ({ frames: [{ dataUri: "x".repeat(32 * 1024 * 1024) }] }),
  });
  const response = await route.handleVideoBridgeDrilldownConsumerRequest(
    req(`/api/v1/video-bridge/drilldown?handle=${"a".repeat(64)}`, key),
    { isRemoteAccessEnabled: () => true, lifecycle }
  );
  assert.equal(response.status, 413);
  assert.ok(Buffer.byteLength(await response.text(), "utf8") < 1024);
});

test("a cancelled read does not derive or return any frame", async () => {
  const lifecycle = newLifecycle();
  const { handle } = await lifecycle.produce("owner", await payload());
  await assert.rejects(
    lifecycle.resolve("owner", handle, { signal: AbortSignal.abort(), variant: "preview" }),
    { name: "AbortError" }
  );
  assert.ok(await lifecycle.resolve("owner", handle, {}), "cancellation must not corrupt the source");
});

test("handle TTL sweep releases retained bytes even when cache TTL is longer", async () => {
  let now = 1_000;
  const cache = new VideoDrilldownCache({ maxEntries: 4, ttlMs: 60_000, now: () => now });
  const lifecycle = new VideoDrilldownLifecycle({ cache, ttlMs: 1_000, now: () => now });
  await lifecycle.produce("owner", await payload());
  now += 2_000;
  assert.equal(lifecycle.cleanup(), 1);
  assert.equal(lifecycle.getUsage("owner").totalBytes, 0);
});

test("idle handles release retained bytes at TTL without waiting for another request", async () => {
  const cache = new VideoDrilldownCache({ maxEntries: 4, ttlMs: 60_000 });
  const lifecycle = new VideoDrilldownLifecycle({ cache, ttlMs: 50 });
  await lifecycle.produce("owner", await payload());
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(cache.getUsage("owner").totalBytes, 0, "an idle process must not retain expired JPEGs");
  lifecycle.clearAll();
});

test("remote configuration failures and cancellation are sanitized HTTP responses", async () => {
  const url = `http://omniroute.local/api/v1/video-bridge/drilldown?handle=${"a".repeat(64)}`;
  const failure = await route.handleVideoBridgeDrilldownConsumerRequest(new Request(url), {
    isRemoteAccessEnabled: () => {
      throw new Error("private-provider-secret\nat /private/source.ts:12");
    },
  });
  assert.equal(failure.status, 503);
  const message = (await failure.json()).error.message;
  assert.ok(!message.includes("private-provider-secret"));
  assert.ok(!message.includes("at /"));
  const cancelled = await route.handleVideoBridgeDrilldownConsumerRequest(
    new Request(url, { signal: AbortSignal.abort() }),
    { isRemoteAccessEnabled: () => true }
  );
  assert.equal(cancelled.status, 499);
});
