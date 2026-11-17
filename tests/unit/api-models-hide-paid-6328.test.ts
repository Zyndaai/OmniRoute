/**
 * #6328 (follow-up to #6495) — the dashboard `/api/models` endpoint must also
 * REMOVE paid models when `hidePaidModels` is on (the public `/v1/models`
 * catalog already did via #6495). `openai` has no curated free roster, so its
 * chat models are paid-tier and must disappear when the toggle is on.
 * Rule #18 regression guard for the added filter in src/app/api/models/route.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-api-models-hidepaid-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const customModelsDb = await import("../../src/lib/db/models.ts");
const modelCapabilities = await import("../../src/lib/modelCapabilities.ts");
const modelsRoute = await import("../../src/app/api/models/route.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");
const { writeCatalogColumn } = await import("../../src/lib/db/models/catalogRow.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");

async function fetchModels(): Promise<
  Array<{ provider: string; model: string; supportsVision?: boolean }>
> {
  const res = await modelsRoute.GET(new Request("http://localhost/api/models?all=true"));
  const body = (await res.json()) as { models: Array<{ provider: string; model: string }> };
  return body.models;
}

test.after(async () => {
  await core.resetDbInstance();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
});

/**
 * Runs `run` while every statement that reads the custom-models document of
 * `provider_model_catalog` is passed to `onRead` (which may throw to simulate a failing read).
 */
async function withCustomModelReadHook<T>(
  onRead: (sql: string) => void,
  run: () => Promise<T>
): Promise<T> {
  const backend = getTestBackend() as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originalQuery = backend.query;
  const originalQueryOne = backend.queryOne;
  const wrap =
    (original: (...args: unknown[]) => unknown) =>
    (sql: string, ...rest: unknown[]) => {
      const normalized = String(sql).replace(/\s+/g, " ");
      if (normalized.includes("custom_models") && normalized.includes("FROM provider_model_catalog")) {
        onRead(normalized);
      }
      return original(sql, ...rest);
    };
  backend.query = wrap(originalQuery) as typeof originalQuery;
  backend.queryOne = wrap(originalQueryOne) as typeof originalQueryOne;
  try {
    return await run();
  } finally {
    backend.query = originalQuery;
    backend.queryOne = originalQueryOne;
  }
}

test("/api/models retains genuine resolved vision capability for the Video Bridge picker", async () => {
  await settingsDb.updateSettings({ hidePaidModels: false });
  await writeCatalogColumn("custom_models", "openai", [{ id: "gpt-4o", supportsVision: false }]);
  let customModelReads = 0;

  const models = await withCustomModelReadHook(
    () => {
      customModelReads++;
    },
    () => fetchModels()
  );
  const vision = models.find(
    (model) => model.provider === "openai" && model.model === "gpt-4o-mini"
  );
  const textOnly = models.find((model) => model.provider === "deepgram");
  const explicitlyDowngraded = models.find(
    (model) => model.provider === "openai" && model.model === "gpt-4o"
  );

  assert.ok(vision, "known static vision model must be present in the real producer response");
  assert.equal(vision.supportsVision, true);
  if (textOnly) assert.notEqual(textOnly.supportsVision, true);
  assert.ok(explicitlyDowngraded, "custom-overridden model must remain in the real producer");
  assert.equal(
    explicitlyDowngraded.supportsVision,
    false,
    "request snapshot must preserve the explicit custom supportsVision override"
  );
  assert.equal(
    customModelReads,
    1,
    "one request-level capability snapshot must bulk-read custom vision overrides once"
  );
});

test("custom-model vision DB failures fail open through point, bulk, snapshot, and route reads", async () => {
  // The custom-models reads really fail (the statement throws), as an unavailable database would.
  const failure = new Error("private database failure");
  const failCustomModelReads = () => {
    throw failure;
  };
  // Drop the process catalog snapshot first so each read really reaches the failing database.
  const whileReadsFail = <T>(run: () => Promise<T>) => {
    invalidateDbCache("model-capabilities");
    return withCustomModelReadHook(failCustomModelReads, run);
  };

  assert.equal(
    await whileReadsFail(() => customModelsDb.getCustomModelVisionOverride("openai", "gpt-4o")),
    null,
    "point read"
  );
  assert.equal(
    await whileReadsFail(() =>
      customModelsDb.getCustomModelVisionOverride("openai", "vendor/gpt-4o", undefined, {
        lookupKey: "openai/vendor/gpt-4o",
      })
    ),
    null,
    "point read with the path-shaped bulk fallback"
  );

  const overrides = await whileReadsFail(() => customModelsDb.listCustomModelVisionOverrides());
  assert.equal(overrides.size, 0, "bulk read");

  const snapshot = await whileReadsFail(() =>
    modelCapabilities.createModelCapabilityResolutionSnapshot()
  );
  assert.equal(snapshot.customVisionOverrides.size, 0);
  assert.equal(
    (await modelCapabilities.getResolvedModelCapabilities("openai/gpt-4o-mini", undefined, snapshot))
      .supportsVision,
    true,
    "ordinary static capability fallback must survive the optional DB read"
  );

  const response = await modelsRoute.handleGetModels(
    new Request("http://localhost/api/models?all=true"),
    {
      createCapabilitySnapshot: () =>
        whileReadsFail(() => modelCapabilities.createModelCapabilityResolutionSnapshot()),
    }
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    models: Array<{ provider: string; model: string; supportsVision?: boolean }>;
  };
  assert.equal(
    body.models.find((model) => model.provider === "openai" && model.model === "gpt-4o-mini")
      ?.supportsVision,
    true
  );
});

test("#6328 /api/models removes paid models when hidePaidModels is on", async () => {
  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "openai-main",
    apiKey: "sk-test",
    isActive: true,
  });

  const hasPaidOpenAi = (list: Array<{ provider: string; model: string }>) =>
    list.some((m) => m.provider === "openai" && /^gpt-/.test(m.model));

  await settingsDb.updateSettings({ hidePaidModels: false });
  assert.equal(
    hasPaidOpenAi(await fetchModels()),
    true,
    "paid OpenAI models visible when toggle is off"
  );

  await settingsDb.updateSettings({ hidePaidModels: true });
  assert.equal(
    hasPaidOpenAi(await fetchModels()),
    false,
    "paid OpenAI models must be removed when hidePaidModels is on (#6328)"
  );
});
