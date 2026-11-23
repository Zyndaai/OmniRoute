// Port of upstream #19466 (account path): a Vertex shared-capacity 429 neither locks the model
// nor cools the account. The createErrorResult/upstreamErrorBody half stays with utils/error.ts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-vertex-shared-429-"));
process.env.DATA_DIR = dataDir;

const { resetTestDb } = await import("../../helpers/postgres.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const fallback = await import("../../../open-sse/services/accountFallback.ts");

const MODEL = "gemini-2.5-pro";
const SHARED =
  '{"error":{"code":429,"message":"Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.","status":"RESOURCE_EXHAUSTED"}}';
const QUOTA =
  '{"error":{"code":429,"message":"Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model.","status":"RESOURCE_EXHAUSTED"}}';
const WITH_RETRY_INFO =
  '{"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}';

test.beforeEach(async () => {
  await resetTestDb();
  fallback.clearAllModelLockouts();
});

test.after(async () => {
  fallback.clearAllModelLockouts();
  await resetTestDb();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seed(provider: string, name: string) {
  const created = await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey: `sk-synthetic-${name}`,
    isActive: true,
    testStatus: "active",
  });
  assert.ok(created?.id);
  return created.id as string;
}

async function coolingState(provider: string, id: string) {
  const row = (await providersDb.getProviderConnectionById(id)) as Record<string, unknown>;
  return {
    modelLock: fallback.getModelLockoutInfo(provider, id, MODEL),
    connectionUntil: row.rateLimitedUntil ?? null,
  };
}

for (const provider of ["vertex", "vertex-partner"]) {
  test(`${provider}: a shared-capacity 429 neither locks the model nor cools the account`, async () => {
    const id = await seed(provider, `${provider}-shared`);
    const result = await auth.markAccountUnavailable(id, 429, SHARED, provider, MODEL);

    assert.equal(result.shouldFallback, true, "the request still moves to the next account");
    assert.equal(result.cooldownMs, 0);
    const state = await coolingState(provider, id);
    assert.equal(state.modelLock, null);
    assert.equal(state.connectionUntil, null);
  });

  test(`${provider}: a quota 429 still takes the model out`, async () => {
    const id = await seed(provider, `${provider}-quota`);
    const result = await auth.markAccountUnavailable(id, 429, QUOTA, provider, MODEL);
    assert.ok(result.cooldownMs > 0);
    const state = await coolingState(provider, id);
    assert.ok(state.modelLock || state.connectionUntil);
  });

  test(`${provider}: a 429 with retry details still cools`, async () => {
    const id = await seed(provider, `${provider}-details`);
    const result = await auth.markAccountUnavailable(id, 429, WITH_RETRY_INFO, provider, MODEL);
    assert.ok(result.cooldownMs > 0);
  });

  test(`${provider}: plain message plus the upstream body, shared capacity neither locks nor cools`, async () => {
    const id = await seed(provider, `${provider}-shared-plain`);
    const upstream = JSON.parse(SHARED);
    const result = await auth.markAccountUnavailable(
      id,
      429,
      upstream.error.message,
      provider,
      MODEL,
      null,
      { upstreamErrorBody: upstream }
    );
    assert.equal(result.shouldFallback, true);
    assert.equal(result.cooldownMs, 0);
    const state = await coolingState(provider, id);
    assert.equal(state.modelLock, null);
    assert.equal(state.connectionUntil, null);
  });
}

test("the same body on another provider keeps cooling as before", async () => {
  const id = await seed("gemini", "gemini-shared");
  const result = await auth.markAccountUnavailable(id, 429, SHARED, "gemini", MODEL);
  assert.ok(result.cooldownMs > 0);
});

test("a 503 with the same body is not a shared-capacity 429 and still locks the model", async () => {
  const id = await seed("vertex", "vertex-503");
  const result = await auth.markAccountUnavailable(id, 503, SHARED, "vertex", MODEL);
  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.ok((await coolingState("vertex", id)).modelLock);
});

test("a plain message with no upstream body is not enough to skip the cooldown", async () => {
  const id = await seed("vertex", "vertex-message-only");
  const result = await auth.markAccountUnavailable(
    id,
    429,
    JSON.parse(SHARED).error.message,
    "vertex",
    MODEL
  );
  assert.ok(result.cooldownMs > 0);
});
