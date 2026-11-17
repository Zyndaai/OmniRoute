import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pricing-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

interface PricingWithSourcesPayload {
  pricing: Record<string, Record<string, Record<string, number>>>;
  sourceMap: Record<string, Record<string, "default" | "litellm" | "modelsDev" | "user">>;
}

const settingsDb = await import("../../src/lib/db/settings.ts");
const pricingRoute = await import("../../src/app/api/pricing/route.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

async function resetDb() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetDb();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("pricing GET keeps legacy payload by default and exposes source metadata on demand", async () => {
  const backend = getTestBackend();

  await backend.execute(
    "INSERT INTO model_pricing (source, provider, models) VALUES ('litellm', $1, $2::jsonb)",
    [
      "route-provider",
      JSON.stringify({
        "model-litellm": { prompt: 1 },
        "model-user": { prompt: 2 },
      }),
    ]
  );
  await backend.execute(
    "INSERT INTO model_pricing (source, provider, models) VALUES ('models_dev', $1, $2::jsonb)",
    [
      "route-provider",
      JSON.stringify({
        "model-modelsdev": { prompt: 3 },
        "model-user": { completion: 4 },
      }),
    ]
  );

  await settingsDb.updatePricing({
    "route-provider": {
      "model-user": { cached: 5 },
    },
  });

  const legacyResponse = await pricingRoute.GET(new Request("http://localhost/api/pricing"));
  assert.equal(legacyResponse.status, 200);
  const legacyPayload = await legacyResponse.json();

  assert.equal("sourceMap" in legacyPayload, false);
  assert.deepEqual(legacyPayload["route-provider"]["model-user"], {
    prompt: 2,
    completion: 4,
    cached: 5,
  });

  const sourceResponse = await pricingRoute.GET(
    new Request("http://localhost/api/pricing?includeSources=1")
  );
  assert.equal(sourceResponse.status, 200);

  const payload = (await sourceResponse.json()) as PricingWithSourcesPayload;
  assert.deepEqual(payload.pricing["route-provider"]["model-user"], {
    prompt: 2,
    completion: 4,
    cached: 5,
  });
  assert.equal(payload.sourceMap["route-provider"]["model-litellm"], "litellm");
  assert.equal(payload.sourceMap["route-provider"]["model-modelsdev"], "modelsDev");
  assert.equal(payload.sourceMap["route-provider"]["model-user"], "user");
  assert.equal(payload.sourceMap.openai["gpt-4o"], "default");
});
