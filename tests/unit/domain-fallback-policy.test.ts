import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-domain-fallback-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const fallbackPolicy = await import("../../src/domain/fallbackPolicy.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");

async function resetStorage() {
  await fallbackPolicy.resetAllFallbacks();
  core.resetDbInstance();
  await resetTestDb();

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      break;
    } catch (error: any) {
      if ((error?.code === "EBUSY" || error?.code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }

  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await fallbackPolicy.resetAllFallbacks();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("registerFallback sorts by priority and defaults missing flags to enabled", async () => {
  await fallbackPolicy.registerFallback("gpt-4o-mini", [
    { provider: "azure", priority: 20 },
    { provider: "openai" },
    { provider: "github", priority: 10, enabled: false },
  ]);

  assert.deepEqual(await fallbackPolicy.resolveFallbackChain("gpt-4o-mini"), [
    { provider: "openai", priority: 0, enabled: true },
    { provider: "azure", priority: 20, enabled: true },
  ]);
  assert.equal(await fallbackPolicy.hasFallback("gpt-4o-mini"), true);
});

test("resolveFallbackChain and getNextFallback respect exclusions and disabled providers", async () => {
  await fallbackPolicy.registerFallback("claude-sonnet", [
    { provider: "anthropic", priority: 1, enabled: false },
    { provider: "vertex", priority: 2, enabled: true },
    { provider: "bedrock", priority: 3, enabled: true },
  ]);

  assert.deepEqual(await fallbackPolicy.resolveFallbackChain("claude-sonnet", ["vertex"]), [
    { provider: "bedrock", priority: 3, enabled: true },
  ]);
  assert.equal(await fallbackPolicy.getNextFallback("claude-sonnet"), "vertex");
  assert.equal(await fallbackPolicy.getNextFallback("claude-sonnet", ["vertex", "bedrock"]), null);
});

test("removeFallback and resetAllFallbacks clear registered chains", async () => {
  await fallbackPolicy.registerFallback("model-a", [{ provider: "provider-a", priority: 1 }]);
  await fallbackPolicy.registerFallback("model-b", [{ provider: "provider-b", priority: 1 }]);

  assert.deepEqual(Object.keys(await fallbackPolicy.getAllFallbackChains()).sort(), [
    "model-a",
    "model-b",
  ]);
  assert.equal(await fallbackPolicy.removeFallback("model-a"), true);
  assert.equal(await fallbackPolicy.removeFallback("model-a"), false);
  assert.equal(await fallbackPolicy.hasFallback("model-a"), false);

  await fallbackPolicy.resetAllFallbacks();
  assert.deepEqual(await fallbackPolicy.getAllFallbackChains(), {});
});
