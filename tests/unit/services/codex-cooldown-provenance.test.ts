import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #19134: a Codex child cooldown records where it came from. A real upstream cooldown replaces a
// preflight one, and a late preflight never overwrites it.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-provenance-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const codexAccount = await import("../../../open-sse/services/codexAccount/index.ts");

function futureIso(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seed() {
  return providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    apiKey: null,
    isActive: true,
    testStatus: "active",
    accessToken: "provenance-access",
    refreshToken: "provenance-refresh",
    providerSpecificData: { workspacePlanType: "plus" },
  });
}

test("a preflight cooldown is tagged quota_preflight", async () => {
  const account = await seed();
  await codexAccount.persistCodexChildCooldown({
    connectionId: account.id,
    model: "gpt-5.5",
    rateLimitedUntil: futureIso(120_000),
    source: "quota_preflight",
  });
  const persisted = await providersDb.getProviderConnectionById(account.id);
  assert.equal(persisted.providerSpecificData.codexScopeRateLimitSource.codex, "quota_preflight");
});

test("an upstream cooldown replaces preflight provenance and a late preflight does not overwrite it", async () => {
  const account = await seed();
  await codexAccount.persistCodexChildCooldown({
    connectionId: account.id,
    model: "gpt-5.5",
    rateLimitedUntil: futureIso(120_000),
    source: "quota_preflight",
  });
  const real = futureIso(180_000);
  await codexAccount.persistCodexChildCooldown({
    connectionId: account.id,
    model: "gpt-5.5",
    rateLimitedUntil: real,
  });
  await codexAccount.persistCodexChildCooldown({
    connectionId: account.id,
    model: "gpt-5.5",
    rateLimitedUntil: futureIso(240_000),
    source: "quota_preflight",
  });
  const persisted = await providersDb.getProviderConnectionById(account.id);
  assert.equal(persisted.providerSpecificData.codexScopeRateLimitSource.codex, "fallback");
  assert.equal(persisted.providerSpecificData.codexScopeRateLimitedUntil.codex, real);
});
