// Consumer half of upstream #18942: a quota the preflight could not read (`quota_unavailable`) skips
// the account for that request only. Nothing is persisted, so a healthy account is not cooled.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-preflight-unknown-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET ||= "preflight-unknown-test-secret";

const { resetTestDb } = await import("../helpers/postgres.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { markQuotaPreflightAccountUnavailable } =
  await import("../../src/sse/services/quotaPreflightUnavailable.ts");

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seedCodex() {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "preflight-unknown",
    email: "preflight-unknown@example.com",
    accessToken: "preflight-unknown-access",
    refreshToken: "preflight-unknown-refresh",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { workspacePlanType: "plus" },
  });
}

test("quota_unavailable persists no cooldown", async () => {
  const connection = await seedCodex();
  const until = await markQuotaPreflightAccountUnavailable(
    "codex",
    connection.id,
    { reason: "quota_unavailable" },
    "gpt-5.5"
  );
  assert.equal(until, null);
  const after = await providersDb.getProviderConnectionById(connection.id);
  assert.ok(after);
  assert.equal(after.testStatus, "active");
  assert.ok(!after.rateLimitedUntil);
  assert.equal(
    (after.providerSpecificData as Record<string, unknown>).codexScopeRateLimitedUntil,
    undefined
  );
});

test("a measured exhausted quota still persists a child cooldown", async () => {
  const connection = await seedCodex();
  const until = await markQuotaPreflightAccountUnavailable(
    "codex",
    connection.id,
    { quotaPercent: 1, resetAt: new Date(Date.now() + 120_000).toISOString() },
    "gpt-5.5"
  );
  assert.ok(until);
  const after = await providersDb.getProviderConnectionById(connection.id);
  assert.ok(after);
  assert.ok(
    (after.providerSpecificData as Record<string, unknown>).codexScopeRateLimitedUntil,
    "child cooldown persisted"
  );
  // #19134 provenance: the preflight records its own source so a later quota reset can tell it
  // apart from a real 429 fallback cooldown.
  const sources = (after.providerSpecificData as Record<string, unknown>)
    .codexScopeRateLimitSource as Record<string, unknown> | undefined;
  assert.equal(sources?.codex, "quota_preflight");
});
