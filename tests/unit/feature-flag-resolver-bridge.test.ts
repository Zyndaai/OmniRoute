import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// imageRegistry must not import the DB-backed featureFlags module (it is reachable from
// client bundles, #10692) — it resolves GROK_SUBSCRIPTION_IMAGES_ENABLED through the
// dependency-free bridge, which featureFlags.ts feeds on the server.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-flag-bridge-"));
process.env.DATA_DIR = tmpDir;
delete process.env.GROK_SUBSCRIPTION_IMAGES_ENABLED;

const bridge = await import("../../src/shared/utils/featureFlagResolverBridge.ts");
const imageRegistry = await import("../../open-sse/config/imageRegistry.ts");

test.after(async () => {
  const core = await import("../../src/lib/db/core.ts");
  await core.resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("imageRegistry source does not statically import the server-only featureFlags module", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../open-sse/config/imageRegistry.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /from "@\/shared\/utils\/featureFlags(\.ts)?"/);
});

test("without a registered resolver the bridge falls back to the env var only", () => {
  bridge.registerFeatureFlagResolver(null);
  try {
    assert.equal(imageRegistry.isGrokSubscriptionImagesEnabled(), false);
    process.env.GROK_SUBSCRIPTION_IMAGES_ENABLED = "true";
    assert.equal(imageRegistry.isGrokSubscriptionImagesEnabled(), true);
  } finally {
    delete process.env.GROK_SUBSCRIPTION_IMAGES_ENABLED;
  }
});

test("loading featureFlags registers the DB-aware resolver (DB override wins over env)", async () => {
  // First load of featureFlags in this process (the previous test cleared the bridge).
  const { refreshFeatureFlagSnapshot } =
    await import("../../src/shared/utils/featureFlags.ts");
  const { setFeatureFlagOverride, removeFeatureFlagOverride } =
    await import("../../src/lib/db/featureFlags.ts");

  // Flag reads are synchronous and served from an in-process snapshot of the DB
  // overrides, so the snapshot must be reloaded after each write for the new value to show.
  await setFeatureFlagOverride("GROK_SUBSCRIPTION_IMAGES_ENABLED", "true");
  await refreshFeatureFlagSnapshot();
  try {
    assert.equal(imageRegistry.isGrokSubscriptionImagesEnabled(), true);
    assert.ok(imageRegistry.getImageProvider("xai-oauth"), "subscription provider visible");
  } finally {
    await removeFeatureFlagOverride("GROK_SUBSCRIPTION_IMAGES_ENABLED");
    await refreshFeatureFlagSnapshot();
  }
  assert.equal(imageRegistry.isGrokSubscriptionImagesEnabled(), false);
  assert.equal(imageRegistry.getImageProvider("xai-oauth") ?? null, null);
});
