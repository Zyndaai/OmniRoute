import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cpa-auth-index-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("saveRequestUsage persists the opaque auth index and a later attempt backfills it", async () => {
  const timestamp = "2026-09-22T12:00:00.000Z";
  await usageHistory.saveRequestUsage({
    provider: "cliproxyapi",
    model: "gpt-4o-mini",
    tokens: { input: 3, output: 4 },
    success: false,
    latencyMs: 10,
    timestamp,
    endpoint: "/v1/chat/completions",
  });
  await usageHistory.saveRequestUsage({
    provider: "cliproxyapi",
    model: "gpt-4o-mini",
    tokens: { input: 3, output: 4 },
    success: true,
    latencyMs: 20,
    timestamp,
    endpoint: "/v1/chat/completions",
    cpaAuthIndex: "acct-9",
  });

  const row = await getTestBackend().queryOne<{ cpa_auth_index: string | null }>(
    "SELECT cpa_auth_index FROM usage_history WHERE provider = $1",
    ["cliproxyapi"]
  );
  assert.equal(row?.cpa_auth_index, "acct-9");

  const history = (await usageHistory.getUsageDb()).data.history;
  const saved = history.find((entry) => entry.cpaAuthIndex === "acct-9");
  assert.ok(saved);
  assert.equal(saved.cpaAccountLabel, null);
});
