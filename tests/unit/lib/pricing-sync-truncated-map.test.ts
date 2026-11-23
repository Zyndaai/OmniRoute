import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #19566: a price sync that returns an empty map, or less than half of the stored models, is
// rejected and the stored prices stay.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pricing-truncated-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const pricingSync = await import("../../../src/lib/pricingSync.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

function fixture(count: number) {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    out[`openai/model-${i}`] = {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      litellm_provider: "openai",
      mode: "chat",
    };
  }
  return out;
}

function serve(count: number) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(fixture(count)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test.beforeEach(async () => {
  pricingSync.stopPeriodicSync();
  await resetTestDb();
  console.warn = () => {};
});

test.after(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("an empty or less-than-half map is rejected and the stored prices stay", async () => {
  serve(10);
  assert.equal((await pricingSync.syncPricingFromSources()).success, true);

  serve(4);
  const halved = await pricingSync.syncPricingFromSources();
  assert.equal(halved.success, false);
  assert.match(String(halved.error), /rejected/);

  serve(0);
  const empty = await pricingSync.syncPricingFromSources();
  assert.equal(empty.success, false);

  const stored = await pricingSync.getSyncedPricing();
  assert.equal(Object.keys(stored.openai ?? {}).length, 10);
});

test("exactly half still syncs, so real removals go through", async () => {
  serve(10);
  await pricingSync.syncPricingFromSources();
  serve(5);
  assert.equal((await pricingSync.syncPricingFromSources()).success, true);
});
