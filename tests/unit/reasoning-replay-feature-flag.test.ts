/**
 * Reasoning Replay feature flag — write/lookup short-circuit when disabled.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-reasoning-replay-flag-"));
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "reasoning-replay-flag-test-secret";

const { cacheReasoning, lookupReasoning, clearReasoningCacheAll } =
  await import("../../open-sse/services/reasoningCache.ts");
const { getReasoningCache, setReasoningCache } = await import("../../src/lib/db/reasoningCache.ts");
const { removeFeatureFlagOverride, setFeatureFlagOverride } =
  await import("../../src/lib/db/featureFlags.ts");
const { refreshFeatureFlagSnapshot } = await import("../../src/shared/utils/featureFlags.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

/** The sync flag read serves an in-process snapshot, so refresh it after each override write. */
async function setFlag(value: string | null): Promise<void> {
  if (value === null) await removeFeatureFlagOverride("REASONING_REPLAY_ENABLED");
  else await setFeatureFlagOverride("REASONING_REPLAY_ENABLED", value);
  await refreshFeatureFlagSnapshot();
}

/** cacheReasoning() persists to the DB best-effort in the background, so poll for the row. */
async function waitForDbRow(key: string) {
  for (let i = 0; i < 40; i++) {
    const row = await getReasoningCache(key);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

after(async () => {
  await setFlag(null);
  await clearReasoningCacheAll();
  await resetDbInstance();
});

describe("REASONING_REPLAY_ENABLED flag", () => {
  it("should stop storing and replaying reasoning when disabled", async () => {
    await clearReasoningCacheAll();
    await setFlag("false");
    try {
      cacheReasoning("call_disabled_write", "deepseek", "deepseek-chat", "Do not store");
      assert.equal(await getReasoningCache("call_disabled_write"), null);

      await setReasoningCache("call_disabled_read", "deepseek", "deepseek-chat", "Do not replay");
      assert.equal(lookupReasoning("call_disabled_read"), null);
    } finally {
      await setFlag(null);
      await clearReasoningCacheAll();
    }
  });

  it("should store and replay reasoning when the flag is left at its on-by-default value", async () => {
    await clearReasoningCacheAll();
    await setFlag(null);
    cacheReasoning("call_enabled_write", "deepseek", "deepseek-chat", "Store me");
    assert.equal((await waitForDbRow("call_enabled_write"))?.reasoning, "Store me");
    assert.equal(lookupReasoning("call_enabled_write"), "Store me");
  });
});
