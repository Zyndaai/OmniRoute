import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-no-retry-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const { isQuotaExhaustionResponse } =
  await import("../../../open-sse/services/combo/quotaExhaustion.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");

test.after(async () => {
  await resetDbInstance();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("quota-only classification does not initialize the retry feature-flag database", async () => {
  // Point the database at an unreachable server: if classification touched the database it
  // would fail to connect. The SQLite file check of the old test has no PostgreSQL equivalent.
  const originalUrl = process.env.OMNIROUTE_POSTGRES_URL;
  process.env.OMNIROUTE_POSTGRES_URL = "postgres://unreachable:unreachable@127.0.0.1:1/none";
  try {
    for (const status of [402, 403, 429]) {
      const response = Response.json(
        { error: { code: "insufficient_quota", message: "Payment required; retry after 30s" } },
        { status, headers: { "Retry-After": "60" } }
      );
      assert.equal(await isQuotaExhaustionResponse(response, "openai", "model"), true);
      assert.equal(response.bodyUsed, false);
    }
  } finally {
    if (originalUrl === undefined) delete process.env.OMNIROUTE_POSTGRES_URL;
    else process.env.OMNIROUTE_POSTGRES_URL = originalUrl;
  }
});
