// Port of upstream #19578 (OAuth session spreading respects connection priority, #19262) and
// #19469 (global strategies skip an account at its max_concurrent cap while a sibling has room).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auth-spread-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "auth-spread-test-secret";

const { resetTestDb } = await import("../../helpers/postgres.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const oauthOccupancy = await import("../../../open-sse/services/oauthSessionOccupancy.ts");
const semaphore = await import("../../../open-sse/services/accountSemaphore.ts");

async function resetStorage() {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function futureIso(ms = 60_000) {
  return new Date(Date.now() + ms).toISOString();
}

async function seedConnection(provider: string, overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: (overrides.authType as "apikey" | "oauth") || "oauth",
    name: (overrides.name as string) || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: (overrides.apiKey as string) || `sk-test-${Math.random().toString(16).slice(2, 10)}`,
    accessToken: (overrides.accessToken as string) || "test-access-token",
    refreshToken: (overrides.refreshToken as string) || "test-refresh-token",
    isActive: true,
    testStatus: "active",
    priority: overrides.priority as number | undefined,
    maxConcurrent: overrides.maxConcurrent as number | undefined,
    lastUsedAt: overrides.lastUsedAt as string | undefined,
    consecutiveUseCount: overrides.consecutiveUseCount as number | undefined,
  });
}

test.beforeEach(async () => {
  oauthOccupancy._clearOAuthSessionOccupancyForTest();
  semaphore.resetAll();
  await resetStorage();
});

test.after(async () => {
  semaphore.resetAll();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("OAuth session spreading does not leak to a lower priority account under fill-first (#19262)", async () => {
  await settingsDb.updateSettings({ fallbackStrategy: "fill-first", sessionAffinityTtlMs: 0 });
  const maxConn = await seedConnection("claude", { name: "claude-max-flatrate", priority: 1 });
  const paidConn = await seedConnection("claude", { name: "claude-paid-pertoken", priority: 2 });

  const creds1 = await auth.getProviderCredentials("claude", null, null, "claude-sonnet", {
    sessionKey: "session-client-1",
    reserveOAuthSession: true,
  });
  assert.equal(creds1.connectionId, maxConn.id);
  creds1.releaseOAuthSession?.();

  const releaseForeign = oauthOccupancy.reserveOAuthSession(
    maxConn.id,
    "session-foreign-worker",
    60_000
  );
  try {
    const creds2 = await auth.getProviderCredentials("claude", null, null, "claude-sonnet", {
      sessionKey: "session-client-2",
      reserveOAuthSession: true,
    });
    assert.equal(creds2.connectionId, maxConn.id);
    creds2.releaseOAuthSession?.();
  } finally {
    releaseForeign();
  }

  await providersDb.updateProviderConnection(maxConn.id, { rateLimitedUntil: futureIso(30_000) });
  const creds3 = await auth.getProviderCredentials("claude", null, null, "claude-sonnet", {
    sessionKey: "session-client-3",
    reserveOAuthSession: true,
  });
  assert.equal(creds3.connectionId, paidConn.id);
  creds3.releaseOAuthSession?.();
});

test("OAuth session spreading still spreads across accounts under round-robin", async () => {
  await settingsDb.updateSettings({ fallbackStrategy: "round-robin", sessionAffinityTtlMs: 0 });
  const connA = await seedConnection("claude", { name: "claude-sub-a", priority: 1 });
  const connB = await seedConnection("claude", { name: "claude-sub-b", priority: 2 });

  const releaseA = oauthOccupancy.reserveOAuthSession(connA.id, "session-occupying-a", 60_000);
  try {
    const creds = await auth.getProviderCredentials("claude", null, null, "claude-sonnet", {
      sessionKey: "session-client-spread",
      reserveOAuthSession: true,
    });
    assert.equal(creds.connectionId, connB.id);
    creds.releaseOAuthSession?.();
  } finally {
    releaseA();
  }
});

for (const strategy of ["fill-first", "round-robin", "least-used", "p2c"]) {
  test(`${strategy} skips an account at its max_concurrent cap while a sibling has room (#19469)`, async () => {
    await settingsDb.updateSettings({ fallbackStrategy: strategy, sessionAffinityTtlMs: 0 });
    const full = await seedConnection("openai", {
      authType: "apikey",
      name: "full",
      priority: 1,
      maxConcurrent: 1,
    });
    const open = await seedConnection("openai", {
      authType: "apikey",
      name: "open",
      priority: 2,
      maxConcurrent: 1,
    });
    const release = await semaphore.acquire(`openai:${full.id}`, { maxConcurrency: 1 });
    try {
      assert.equal(semaphore.isAccountSemaphoreFull("openai", full.id, 1), true);
      for (let i = 0; i < 3; i++) {
        const creds = await auth.getProviderCredentials("openai", null, null, "gpt-4o");
        assert.equal(creds.connectionId, open.id, `${strategy} pick ${i} queued behind a full account`);
      }
    } finally {
      release();
    }
  });
}

test("when every account is at its cap the pick is unchanged", async () => {
  await settingsDb.updateSettings({ fallbackStrategy: "fill-first", sessionAffinityTtlMs: 0 });
  const a = await seedConnection("openai", {
    authType: "apikey",
    name: "a",
    priority: 1,
    maxConcurrent: 1,
  });
  const b = await seedConnection("openai", {
    authType: "apikey",
    name: "b",
    priority: 2,
    maxConcurrent: 1,
  });
  const releaseA = await semaphore.acquire(`openai:${a.id}`, { maxConcurrency: 1 });
  const releaseB = await semaphore.acquire(`openai:${b.id}`, { maxConcurrency: 1 });
  try {
    const creds = await auth.getProviderCredentials("openai", null, null, "gpt-4o");
    assert.equal(creds.connectionId, a.id);
  } finally {
    releaseA();
    releaseB();
  }
});
