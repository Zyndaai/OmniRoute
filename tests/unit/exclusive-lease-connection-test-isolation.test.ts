import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTestBackend } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lease-test-isolation-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

let externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  externalCalls += 1;
  throw new Error("unexpected external provider/model call");
};

const core = await import("../../src/lib/db/core.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");
const providerModels = await import("../../src/app/api/providers/[id]/models/route.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");
const codexResetCredits = await import("../../src/lib/usage/codexResetCredits.ts");

const OWNER = "vlo_TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";

async function insertConnection(input: {
  id: string;
  provider: string;
  name: string;
  apiKey: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO provider_connections
     (id, provider, auth_type, name, api_key, is_active, test_status, created_at, updated_at)
     VALUES ($1, $2, 'apikey', $3, $4, true, 'active', $5, $6)`,
    [input.id, input.provider, input.name, input.apiKey, now, now]
  );
}

test.after(async () => {
  globalThis.fetch = originalFetch;
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("connection verification skips an ACTIVE exclusive lease before any probe or mutation", async () => {
  await insertConnection({
    id: "leased-test-connection",
    provider: "openai",
    name: "leased test connection",
    apiKey: "synthetic-key",
  });
  const acquired = await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: OWNER,
    apiKeyId: "managed-key",
    provider: "openai",
    connectionId: "leased-test-connection",
  });
  assert.equal(acquired.kind, "ACQUIRED");

  const result = await testSingleConnection("leased-test-connection");

  assert.equal(result.valid, false);
  assert.equal(result.skipped, true);
  assert.equal(result.diagnosis?.code, "exclusive_lease_active");
  assert.equal(externalCalls, 0);
  const row = await getTestBackend().queryOne<{
    test_status: string;
    last_tested: string | null;
    last_error: string | null;
  }>("SELECT test_status, last_tested, last_error FROM provider_connections WHERE id = $1", [
    "leased-test-connection",
  ]);
  assert.ok(row, "connection row should exist");
  assert.equal(row.test_status, "active");
  assert.equal(row.last_tested, null);
  assert.equal(row.last_error, null);
});

test("model discovery and reset-credit paths reject ACTIVE leased connections", async () => {
  const response = await providerModels.GET(
    new Request("http://omniroute.local/api/providers/leased-test-connection/models"),
    { params: { id: "leased-test-connection" } }
  );
  assert.equal(response.status, 409);

  await assert.rejects(
    codexResetCredits.listCodexResetCredits("leased-test-connection"),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { status?: number }).status === 409 &&
      /exclusive lease/i.test(error.message)
  );
  assert.equal(externalCalls, 0);
});

test("quota refresh proceeds on an ACTIVE leased usage-supported connection", async () => {
  await insertConnection({
    id: "leased-quota-connection",
    provider: "deepseek",
    name: "leased quota connection",
    apiKey: "synthetic-deepseek-key",
  });
  const acquired = await leases.acquireExclusiveConnectionLease({
    leaseOwnerId: "vlo_QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
    apiKeyId: "managed-quota-key",
    provider: "deepseek",
    connectionId: "leased-quota-connection",
  });
  assert.equal(acquired.kind, "ACQUIRED");

  externalCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    externalCalls += 1;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://api.deepseek.com/user/balance") {
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: "USD",
              total_balance: "10.00",
              granted_balance: "0.00",
              topped_up_balance: "10.00",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    throw new Error(`unexpected fetch call: ${url}`);
  };

  const result = await providerLimits.fetchLiveProviderLimits("leased-quota-connection");
  assert.equal(result.connection.id, "leased-quota-connection");
  const quotas = result.usage.quotas as { credits_usd?: { remaining?: number } };
  assert.equal(quotas?.credits_usd?.remaining, 10);
  assert.equal(externalCalls, 1);
});
