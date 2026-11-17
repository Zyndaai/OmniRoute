import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-metrics-deleted-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const providerMetricsRoute = await import("../../src/app/api/provider-metrics/route.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

type ProviderMetricsResponse = {
  metrics: Record<string, unknown>;
  topology: { providers: string[]; lastProvider: string; errorProvider: string };
};

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});
test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("#10714: a provider deleted from provider_connections must NOT keep showing as an errored topology node", async () => {
  const backend = getTestBackend();

  await backend.execute(
    `INSERT INTO provider_connections (id, provider, created_at, updated_at) VALUES ($1, $2, $3, $4)`,
    ["conn-openai-1", "openai", "2026-08-19T09:00:00.000Z", "2026-08-19T09:00:00.000Z"]
  );
  await backend.execute(
    `INSERT INTO call_logs (id, "timestamp", provider, status, duration, error_summary) VALUES ($1, $2, $3, $4, $5, $6)`,
    ["openai-error", "2026-08-19T10:00:00.000Z", "openai", 500, 80, "upstream error"]
  );

  // Deleted provider: historical call_logs rows exist, but no provider_connections row.
  await backend.execute(
    `INSERT INTO call_logs (id, "timestamp", provider, status, duration, error_summary) VALUES ($1, $2, $3, $4, $5, $6)`,
    ["g4f-pollinations-error", "2026-08-19T11:00:00.000Z", "g4f-pollinations", 402, 50, "payment required"]
  );

  const response = await providerMetricsRoute.GET();
  const body = (await response.json()) as ProviderMetricsResponse;

  assert.equal(response.status, 200);
  assert.equal(body.topology.providers.includes("g4f-pollinations"), false);
  assert.equal(body.metrics["g4f-pollinations"], undefined);
  assert.notEqual(body.topology.errorProvider, "g4f-pollinations");
  assert.equal(body.topology.providers.includes("openai"), true);
  assert.equal(body.topology.errorProvider, "openai");
});
