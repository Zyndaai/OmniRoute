import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-404-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "model-404-test-secret";

const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");

test.after(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("getModelInfo returns model_not_found when unprefixed claude- model provider is not active", async () => {
  const now = new Date().toISOString();

  // Seed an active connection for openai (so activeProviders has openai, but NOT anthropic)
  await getTestBackend().execute(
    `INSERT INTO provider_connections (id, provider, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, is_active = EXCLUDED.is_active,
       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
    ["openai-test-conn", "openai", true, now, now]
  );

  const res = (await getModelInfo("claude-unrecognized-9-9")) as {
    provider: string | null;
    errorType?: string;
  };

  assert.equal(res.provider, null);
  assert.equal(res.errorType, "model_not_found");
});
