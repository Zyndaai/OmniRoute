import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";
import { resetTestDb } from "../../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-forecast-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const quotaSnapshotsDb = await import("../../../src/lib/db/quotaSnapshots.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const comboForecast = await import("../../../src/lib/usage/comboForecast.ts");
const route = await import("../../../src/app/api/usage/combo-forecast/route.ts");
const { normalizeComboStep } = await import("../../../src/lib/combos/steps.ts");

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/**
 * Creates a real provider connection and returns its generated id. Quota
 * snapshots and call logs reference connections by foreign key on Postgres, so
 * fixtures cannot use made-up connection ids.
 */
async function seedConnection(provider: string, name: string): Promise<string> {
  const connection = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `sk-${name}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
  return String((connection as { id: string }).id);
}

async function enableManagementAuth() {
  process.env.INITIAL_PASSWORD = "combo-forecast-password";
  await settingsDb.updateSettings({ requireLogin: true, password: "" });
}

async function seedPricing() {
  await settingsDb.updatePricing({
    openai: {
      "gpt-4o-mini": {
        input: 1,
        output: 2,
        cached: 0.5,
        cache_creation: 1,
        reasoning: 2,
      },
    },
  });
}

async function seedForecastCombo() {
  const connectionA = await seedConnection("openai", "forecast-a");
  const connectionB = await seedConnection("openai", "forecast-b");
  const comboInput = {
    name: "combo-forecast-structured",
    strategy: "weighted",
    models: [
      {
        kind: "model",
        providerId: "openai",
        model: "openai/gpt-4o-mini",
        connectionId: connectionA,
        label: "Forecast A",
      },
      {
        kind: "model",
        providerId: "openai",
        model: "openai/gpt-4o-mini",
        connectionId: connectionB,
        label: "Forecast B",
      },
    ],
  };
  const combo = await combosDb.createCombo(comboInput);
  const firstStep = normalizeComboStep(comboInput.models[0], {
    comboName: comboInput.name,
    index: 0,
  });
  const secondStep = normalizeComboStep(comboInput.models[1], {
    comboName: comboInput.name,
    index: 1,
  });
  return { combo, comboInput, firstStep, secondStep, connectionA, connectionB };
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;

  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;

  if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
});

test("combo forecast projects cost and quota risk from combo history", async () => {
  await seedPricing();
  const { combo, comboInput, firstStep, secondStep, connectionA, connectionB } =
    await seedForecastCombo();
  const timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  await callLogs.saveCallLog({
    id: "combo-forecast-1",
    timestamp,
    status: 200,
    model: "openai/gpt-4o-mini",
    requestedModel: comboInput.name,
    provider: "openai",
    connectionId: connectionA,
    tokens: { prompt_tokens: 1_000, completion_tokens: 500 },
    comboName: comboInput.name,
    comboStepId: firstStep.id,
    comboExecutionKey: firstStep.id,
  });
  await callLogs.saveCallLog({
    id: "combo-forecast-2",
    timestamp,
    status: 200,
    model: "openai/gpt-4o-mini",
    requestedModel: comboInput.name,
    provider: "openai",
    connectionId: connectionB,
    tokens: { prompt_tokens: 2_000, completion_tokens: 1_000 },
    comboName: comboInput.name,
    comboStepId: secondStep.id,
    comboExecutionKey: secondStep.id,
  });

  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: connectionA,
    window_key: "daily",
    remaining_percentage: 90,
    is_exhausted: 0,
    next_reset_at: null,
    window_duration_ms: 86_400_000,
    raw_data: null,
  });
  await quotaSnapshotsDb.saveQuotaSnapshot({
    provider: "openai",
    connection_id: connectionA,
    window_key: "daily",
    remaining_percentage: 20,
    is_exhausted: 0,
    next_reset_at: null,
    window_duration_ms: 86_400_000,
    raw_data: null,
  });

  const forecast = await comboForecast.buildComboForecastResponse({
    range: "7d",
    horizon: "7d",
    comboId: String(combo.id),
  });

  assert.equal(forecast.combos.length, 1);
  assert.equal(forecast.combos[0].history.requests, 2);
  assert.equal(forecast.combos[0].forecast.projectedRequests, 2);
  assert.ok(forecast.combos[0].history.costUsd > 0);
  assert.equal(forecast.combos[0].dataQuality.pricingCoveragePct, 100);
  assert.equal(forecast.combos[0].targets.length, 2);
  assert.equal(forecast.combos[0].targets[0].quota.scope, "connection");
  assert.notEqual(forecast.combos[0].quotaRisk.level, "unknown");
});

test("combo forecast returns no_data confidence for combos without history", async () => {
  const { combo } = await seedForecastCombo();

  const forecast = await comboForecast.buildComboForecastResponse({
    range: "24h",
    horizon: "7d",
    comboId: String(combo.id),
  });

  assert.equal(forecast.combos.length, 1);
  assert.equal(forecast.combos[0].confidence, "no_data");
  assert.equal(forecast.combos[0].history.requests, 0);
  assert.equal(forecast.combos[0].forecast.projectedCostUsd, 0);
});

test("combo forecast API requires management auth and validates query", async () => {
  await enableManagementAuth();
  const { combo } = await seedForecastCombo();

  const unauthenticated = await route.GET(
    new Request(`http://localhost/api/usage/combo-forecast?comboId=${combo.id}`)
  );
  assert.equal(unauthenticated.status, 401);

  const invalid = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/usage/combo-forecast?range=bad")
  );
  assert.equal(invalid.status, 400);

  const missing = await route.GET(
    await makeManagementSessionRequest(
      "http://localhost/api/usage/combo-forecast?comboId=11111111-1111-4111-8111-111111111111"
    )
  );
  assert.equal(missing.status, 404);

  const authenticated = await route.GET(
    await makeManagementSessionRequest(
      `http://localhost/api/usage/combo-forecast?range=24h&horizon=7d&comboId=${combo.id}`
    )
  );
  assert.equal(authenticated.status, 200);
  const body = await authenticated.json();
  assert.equal(body.combos.length, 1);
});

test("combo forecast reports credit-metered providers as unpriced, not as a zero tariff", async () => {
  // A tariff this high makes any token-based charge unmistakable: the row must still
  // come out unpriced, because credits are the bill and `call_logs` carries no cost.
  await settingsDb.updatePricing({ kiro: { "gpt-5.6-luna": { input: 999, output: 999 } } });
  const creditConnection = await seedConnection("kiro", "forecast-credit");
  const comboInput = {
    name: "combo-forecast-credit",
    strategy: "weighted",
    models: [
      {
        kind: "model",
        providerId: "kiro",
        model: "kiro/gpt-5.6-luna",
        connectionId: creditConnection,
        label: "Credit",
      },
    ],
  };
  const combo = await combosDb.createCombo(comboInput);
  const step = normalizeComboStep(comboInput.models[0], {
    comboName: comboInput.name,
    index: 0,
  });

  await callLogs.saveCallLog({
    id: "combo-forecast-credit-1",
    timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    status: 200,
    model: "kiro/gpt-5.6-luna",
    requestedModel: comboInput.name,
    provider: "kiro",
    connectionId: creditConnection,
    tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 },
    comboName: comboInput.name,
    comboStepId: step.id,
    comboExecutionKey: step.id,
  });

  const forecast = await comboForecast.buildComboForecastResponse({
    range: "7d",
    horizon: "7d",
    comboId: String(combo.id),
  });

  assert.equal(forecast.combos.length, 1);
  assert.equal(forecast.combos[0].history.costUsd, 0);
  assert.equal(forecast.combos[0].dataQuality.pricingCoveragePct, 0);
});
