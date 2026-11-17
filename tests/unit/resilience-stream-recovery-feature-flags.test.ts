import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stream-recovery-flags-"));
process.env.DATA_DIR = tmpDir;

const core = await import("../../src/lib/db/core.ts");
const { setFeatureFlagOverride, clearAllFeatureFlagOverrides } =
  await import("../../src/lib/db/featureFlags.ts");
const { resolveResilienceSettings } = await import("../../src/lib/resilience/settings.ts");
// Flag reads are synchronous and served from an in-process snapshot of the DB overrides
// (src/shared/utils/featureFlags.ts); a write is only visible after the snapshot reloads.
const { refreshFeatureFlagSnapshot } = await import("../../src/shared/utils/featureFlags.ts");

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("stream recovery feature flags seed resilience defaults", async () => {
  await clearAllFeatureFlagOverrides();
  await setFeatureFlagOverride("STREAM_RECOVERY_ENABLED", "true");
  await setFeatureFlagOverride("STREAM_RECOVERY_MIDSTREAM_ENABLED", "true");
  await refreshFeatureFlagSnapshot();

  const resolved = await resolveResilienceSettings({});

  assert.equal(resolved.streamRecovery.enabled, true);
  assert.equal(resolved.streamRecovery.continueMidStream, true);
});

test("stored stream recovery settings override feature flag defaults", async () => {
  await clearAllFeatureFlagOverrides();
  await setFeatureFlagOverride("STREAM_RECOVERY_ENABLED", "true");
  await setFeatureFlagOverride("STREAM_RECOVERY_MIDSTREAM_ENABLED", "true");

  const resolved = await resolveResilienceSettings({
    resilienceSettings: { streamRecovery: { enabled: false, continueMidStream: false } },
  });

  assert.equal(resolved.streamRecovery.enabled, false);
  assert.equal(resolved.streamRecovery.continueMidStream, false);
});
