import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalDataDir = process.env.DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auto-routing-analytics-"));
process.env.DATA_DIR = testDataDir;

const core = await import("../../../src/lib/db/core.ts");
const usageLogs = await import("../../../src/lib/db/usageLogs.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

test.before(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
});

test("auto-routing analytics use requested models from the runtime schema", async () => {
  const backend = getTestBackend();
  const insert = (id: string, model: string, requested: string, provider: string, ts: string) =>
    backend.execute(
      `INSERT INTO call_logs (id, model, requested_model, provider, "timestamp")
       VALUES ($1, $2, $3, $4, $5)`,
      [id, model, requested, provider, ts]
    );
  const timestamp = new Date().toISOString();

  await insert("auto-default", "claude-opus-5", "auto", "anthropic", timestamp);
  await insert("auto-fast-1", "gpt-5.6-luna", "auto/fast", "openai", timestamp);
  await insert("auto-fast-2", "gpt-5.6-terra", "auto/fast", "openai", timestamp);
  await insert("direct", "gpt-4", "gpt-4", "openai", timestamp);

  assert.deepEqual(await usageLogs.getAutoRoutingTotalCount(), { count: 3 });
  assert.deepEqual(await usageLogs.getAutoRoutingVariantBreakdown(), [
    { variant: "fast", count: 2 },
    { variant: "default", count: 1 },
  ]);
  assert.deepEqual(await usageLogs.getAutoRoutingTopProviders(), [
    { provider: "openai", count: 2 },
    { provider: "anthropic", count: 1 },
  ]);
});
