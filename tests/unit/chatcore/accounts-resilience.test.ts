// @ts-nocheck
// Account, credential and failure-path resilience around handleChatCore: per-key 429
// cooldown, refresh guards, provider-failure call logs, resource pressure, dedup/idempotency,
// status restatement and the stream-readiness fallback. (The managed-lease inventory stays in
// tests/unit/hard-session-lease-bypass-inventory.test.ts: another test reads it as evidence.)
// Merged from eleven files so the chatCore module graph loads once; each original file is
// one `describe` below, named after the file it came from. Three of the sources carried
// `// @ts-nocheck`, so the merged file does too.
import { after, afterEach, before, beforeEach, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-accounts-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// noauth-refresh-guard
process.env.API_KEY_SECRET = "test-refresh-guard-secret";
// stream-readiness-fallback: open-sse/config/constants.ts reads these once at module load.
// The other streaming tests here answer with an immediate body, so the short budget is safe.
process.env.STREAM_READINESS_TIMEOUT_MS = "300";
process.env.STREAM_READINESS_MAX_TIMEOUT_MS = "600";

const { CALL_LOG_SETTLE_TIMEOUT_MS } = await import("../../helpers/callLogSettle.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const { invalidateCacheControlSettingsCache } =
  await import("../../../src/lib/cacheControlSettings.ts");
const { clearCache } = await import("../../../src/lib/semanticCache.ts");
const idempotencyLayer = await import("../../../src/lib/idempotencyLayer.ts");
const { clearPendingRequests } = await import("../../../src/lib/usage/usageHistory.ts");
const { getCallLogs, getCallLogById, waitForCallLogSaves } =
  await import("../../../src/lib/usage/callLogs.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const { executeChatWithBreaker } = await import("../../../src/sse/handlers/chatHelpers.ts");
const { getCircuitBreaker, resetAllCircuitBreakers, STATE } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const { handleChatCore } = await import("../../../open-sse/handlers/chatCore.ts");
const { getExecutor } = await import("../../../open-sse/executors/index.ts");
const { clearAllModelLockouts, clearModelLock } =
  await import("../../../open-sse/services/accountFallback.ts");
const { clearOpencodeFreeTierSkips } =
  await import("../../../open-sse/services/opencodeFreeTierSkip.ts");
const { computeRequestHash, deduplicate, clearInflight } =
  await import("../../../open-sse/services/requestDedup.ts");
const { resetAll: resetAccountSemaphores } =
  await import("../../../open-sse/services/accountSemaphore.ts");
const { resetPayloadRulesConfigForTests } =
  await import("../../../open-sse/services/payloadRules.ts");
const { CLAUDE_CODE_COMPATIBLE_REDACT_THINKING_BETA, CONTEXT_1M_BETA_HEADER } =
  await import("../../../open-sse/services/claudeCodeCompatible.ts");
const {
  getValidApiKey,
  recordKeyCooldown,
  parseRetryAfterMs,
  getAllKeyHealth,
  removeConnectionHealth,
  connectionHasExtraKeys,
  trackConnectionExtraKeys,
  hasEligibleKey,
  recordKeySuccess,
} = await import("../../../open-sse/services/apiKeyRotator.ts");
const { recordKeyHealthStatus } = await import("../../../open-sse/handlers/chatCore/keyHealth.ts");
const { shouldKeepConnectionActiveOnRateLimit } =
  await import("../../../open-sse/handlers/chatCore/rateLimitConnectionGuard.ts");
const { reloadResourcePressureRuntime, checkResourcePressureGuard } =
  await import("../../../open-sse/utils/resourcePressure.ts");
const { createErrorResult } = await import("../../../open-sse/utils/error.ts");
const geminiTracker = await import("../../../open-sse/services/geminiRateLimitTracker.ts");
const { applyStatusRestatement, statusRestatementRegistry } =
  await import("../../../open-sse/config/upstreamStatusRestatement.ts");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("api-key-429-cooldown", () => {
  // Per-key 429 cooldown (#14573): a rate limit on one extra key must cool only that
  // key — not mark it invalid, not disable the whole connection. The rotator skips
  // cooling keys and picks them up again once cooldownUntil passes.
  const noopLog = { warn: () => {}, error: () => {} };
  const touched: string[] = [];

  function creds(connectionId: string, psd: Record<string, unknown> = {}) {
    touched.push(connectionId);
    return { connectionId, apiKey: "sk-test", accessToken: null, providerSpecificData: psd };
  }

  afterEach(() => {
    for (const c of touched.splice(0)) removeConnectionHealth(c);
  });

  describe("parseRetryAfterMs", () => {
    it("parses delta-seconds", () => {
      assert.equal(parseRetryAfterMs("30"), 30_000);
    });

    it("parses HTTP-date", () => {
      const future = new Date(Date.now() + 45_000).toUTCString();
      const ms = parseRetryAfterMs(future);
      assert.ok(ms !== null && ms > 30_000 && ms <= 45_000, `expected ~45s, got ${ms}`);
    });

    it("returns null for garbage", () => {
      assert.equal(parseRetryAfterMs("not-a-date"), null);
      assert.equal(parseRetryAfterMs(null), null);
      assert.equal(parseRetryAfterMs(undefined), null);
    });

    it("returns 0 (not null) for an expired HTTP-date", () => {
      const past = new Date(Date.now() - 1_000).toUTCString();
      assert.equal(parseRetryAfterMs(past), 0);
    });
  });

  describe("recordKeyCooldown + rotation skip", () => {
    it("sets cooldownUntil in the future and the rotator skips the cooling key", () => {
      const conn = "cd-skip-1";
      trackConnectionExtraKeys(conn, ["sk-extra-0"]);
      recordKeyCooldown(conn, "primary", 60_000);
      const h = getAllKeyHealth()[`${conn}:primary`];
      assert.ok(h.cooldownUntil !== null && h.cooldownUntil !== undefined);
      assert.ok(new Date(h.cooldownUntil).getTime() > Date.now());
      // status stays active — a 429 is temporary, not a credential failure
      assert.equal(h.status, "active");

      const pick = getValidApiKey(conn, "sk-primary", ["sk-extra-0"]);
      assert.equal(pick?.keyId, "extra_0");
    });

    it("auto-recovers the key once cooldownUntil passes", async () => {
      const conn = "cd-recover-1";
      trackConnectionExtraKeys(conn, ["sk-extra-0"]);
      recordKeyCooldown(conn, "primary", 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const pick = getValidApiKey(conn, "sk-primary", ["sk-extra-0"]);
      assert.equal(pick?.keyId, "primary");
    });

    it("returns null when every key is cooling", () => {
      const conn = "cd-all-cooling";
      trackConnectionExtraKeys(conn, ["sk-extra-0"]);
      recordKeyCooldown(conn, "primary", 60_000);
      recordKeyCooldown(conn, "extra_0", 60_000);
      const pick = getValidApiKey(conn, "sk-primary", ["sk-extra-0"]);
      assert.equal(pick, null);
    });

    it("round-robin lands on sibling keys while one key cools", () => {
      const conn = "cd-siblings";
      trackConnectionExtraKeys(conn, ["sk-e0", "sk-e1"]);
      recordKeyCooldown(conn, "extra_0", 60_000);
      const seen = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const pick = getValidApiKey(conn, "sk-p", ["sk-e0", "sk-e1"]);
        seen.add(pick!.keyId);
      }
      assert.ok(!seen.has("extra_0"), "cooling key must never be picked");
      assert.ok(seen.has("primary") && seen.has("extra_1"));
    });

    it("in-memory clear (success) is not overridden by a stale provided cooldown", () => {
      const conn = "stale-provided-override";
      const future = new Date(Date.now() + 60_000).toISOString();
      // Stale DB snapshot still carries a cooldown window while the in-memory
      // record was already cleared by recordKeySuccess.
      trackConnectionExtraKeys(conn, ["sk-stale-e0"]);
      const health = { extra_0: { cooldownUntil: future } } as never;
      recordKeyCooldown(conn, "extra_0", 60_000);
      recordKeySuccess(conn, "extra_0");
      const seen = new Set<string>();
      for (let i = 0; i < 4; i++) {
        seen.add(getValidApiKey(conn, "sk-stale-p", ["sk-stale-e0"], health)!.keyId);
      }
      assert.ok(
        seen.has("extra_0"),
        "cleared in-memory state must win over stale provided snapshot"
      );
    });

    it("DB-provided health shadows in-memory cooldown for the same key (merged view)", () => {
      const conn = "cd-db-shadow";
      trackConnectionExtraKeys(conn, ["sk-e0"]);
      recordKeyCooldown(conn, "primary", 60_000);
      const dbHealth = {
        primary: { ...getAllKeyHealth()[`${conn}:primary`], cooldownUntil: null },
        extra_0: {
          status: "active",
          failures: 0,
          lastFailure: null,
          lastSuccess: null,
          totalRequests: 0,
          totalFailures: 0,
          cooldownUntil: null,
        },
      };
      const pick = getValidApiKey(conn, "sk-p", ["sk-e0"], dbHealth as never);
      // the in-memory cooldown write happened after startup sync, so it still wins
      assert.equal(pick?.keyId, "extra_0");
    });
  });

  describe("hasEligibleKey (connection guard input)", () => {
    it("true while any key is eligible", () => {
      const conn = "guard-eligible";
      trackConnectionExtraKeys(conn, ["sk-e0"]);
      recordKeyCooldown(conn, "primary", 60_000);
      assert.equal(hasEligibleKey(conn, "sk-p", ["sk-e0"]), true);
    });

    it("false when all keys cool or invalid", () => {
      const conn = "guard-none";
      trackConnectionExtraKeys(conn, ["sk-e0"]);
      recordKeyCooldown(conn, "primary", 60_000);
      recordKeyCooldown(conn, "extra_0", 60_000);
      assert.equal(hasEligibleKey(conn, "sk-p", ["sk-e0"]), false);
    });

    it("hasEligibleKey is a pure predicate: it never advances the rotation index", () => {
      const baseConn = "guard-baseline";
      trackConnectionExtraKeys(baseConn, ["sk-bl-e0"]);
      const baseline = [
        getValidApiKey(baseConn, "sk-bl-p", ["sk-bl-e0"])!.keyId,
        getValidApiKey(baseConn, "sk-bl-p", ["sk-bl-e0"])!.keyId,
        getValidApiKey(baseConn, "sk-bl-p", ["sk-bl-e0"])!.keyId,
      ];
      const conn = "guard-no-index-drift";
      trackConnectionExtraKeys(conn, ["sk-nd-e0"]);
      const withGuard = [
        (hasEligibleKey(conn, "sk-nd-p", ["sk-nd-e0"]),
        getValidApiKey(conn, "sk-nd-p", ["sk-nd-e0"])!.keyId),
        (hasEligibleKey(conn, "sk-nd-p", ["sk-nd-e0"]),
        getValidApiKey(conn, "sk-nd-p", ["sk-nd-e0"])!.keyId),
        (hasEligibleKey(conn, "sk-nd-p", ["sk-nd-e0"]),
        getValidApiKey(conn, "sk-nd-p", ["sk-nd-e0"])!.keyId),
      ];
      assert.deepEqual(withGuard, baseline, "predicate calls must not consume rotation steps");
    });

    it("connectionHasExtraKeys stays consistent", () => {
      const conn = "guard-extras";
      trackConnectionExtraKeys(conn, ["sk-e0"]);
      assert.equal(connectionHasExtraKeys(conn), true);
    });
  });

  describe("recordKeyHealthStatus 429 handling", () => {
    it("429 with retryAfterMs cools the selected key and keeps status active", () => {
      const conn = "kh-429-cool";
      recordKeyHealthStatus(
        429,
        creds(conn, { selectedKeyId: "extra_0" }),
        noopLog,
        undefined,
        "",
        30_000
      );
      const h = getAllKeyHealth()[`${conn}:extra_0`];
      assert.ok(h, "health entry expected");
      assert.ok(h.cooldownUntil !== null && new Date(h.cooldownUntil).getTime() > Date.now());
      assert.equal(h.status, "active");
      assert.equal(h.failures, 0);
    });

    it("429 without retryAfterMs applies the default cooldown", () => {
      const conn = "kh-429-default";
      recordKeyHealthStatus(429, creds(conn), noopLog);
      const h = getAllKeyHealth()[`${conn}:primary`];
      assert.ok(h.cooldownUntil !== null && h.cooldownUntil !== undefined);
    });

    it("429 does not touch sibling keys", () => {
      const conn = "kh-429-siblings";
      trackConnectionExtraKeys(conn, ["sk-e0"]);
      recordKeyHealthStatus(429, creds(conn, { selectedKeyId: "primary" }), noopLog);
      assert.equal(getAllKeyHealth()[`${conn}:extra_0`], undefined);
    });

    it("2xx still records success and clears cooldown", () => {
      const conn = "kh-2xx-recovers";
      recordKeyHealthStatus(429, creds(conn), noopLog, undefined, "", 60_000);
      recordKeyHealthStatus(200, creds(conn), noopLog);
      const h = getAllKeyHealth()[`${conn}:primary`];
      assert.equal(h.cooldownUntil, null);
      assert.equal(h.status, "active");
    });

    it("401 regression: still warns then invalidates, unaffected by cooldown logic", () => {
      const conn = "kh-401-regression";
      recordKeyHealthStatus(401, creds(conn), noopLog);
      recordKeyHealthStatus(401, creds(conn), noopLog);
      const h = getAllKeyHealth()[`${conn}:primary`];
      assert.equal(h.status, "invalid");
    });
  });

  describe("shouldKeepConnectionActiveOnRateLimit", () => {
    it("true when extras exist and at least one key is eligible", () => {
      const conn = "rlguard-keep";
      trackConnectionExtraKeys(conn, ["sk-e0"]);
      recordKeyCooldown(conn, "primary", 60_000);
      const creds = {
        apiKey: "sk-p",
        providerSpecificData: { extraApiKeys: ["sk-e0"], apiKeyHealth: getAllKeyHealth() },
      };
      assert.equal(shouldKeepConnectionActiveOnRateLimit(creds, conn), true);
    });

    it("false when every key is cooling (connection may be disabled)", () => {
      const conn = "rlguard-none";
      trackConnectionExtraKeys(conn, ["sk-e0"]);
      recordKeyCooldown(conn, "primary", 60_000);
      recordKeyCooldown(conn, "extra_0", 60_000);
      const creds = {
        apiKey: "sk-p",
        providerSpecificData: { extraApiKeys: ["sk-e0"], apiKeyHealth: getAllKeyHealth() },
      };
      assert.equal(shouldKeepConnectionActiveOnRateLimit(creds, conn), false);
    });

    it("false without connectionId or without extra keys", () => {
      const conn = "rlguard-noextras";
      trackConnectionExtraKeys(conn, []);
      const creds = { apiKey: "sk-p", providerSpecificData: { extraApiKeys: [] } };
      assert.equal(shouldKeepConnectionActiveOnRateLimit(creds, conn), false);
      assert.equal(shouldKeepConnectionActiveOnRateLimit(creds, null), false);
    });
  });

  describe("chatCore wiring (source-locked)", () => {
    const src = fs.readFileSync(
      new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url),
      "utf8"
    );
    const executeSrc = fs.readFileSync(
      new URL("../../../open-sse/handlers/chatCore/executeProviderRequest.ts", import.meta.url),
      "utf8"
    );

    it("streaming executor site records 429 into key health (not only 2xx/401/403)", () => {
      const i = executeSrc.search(/recordKeyHealthStatus\(\s*res\.response\.status,/);
      assert.notEqual(i, -1, "streaming recordKeyHealthStatus call site must exist");
      // Only the condition head counts — comments inside the block must not satisfy this.
      const condStart = executeSrc.lastIndexOf("if (", i);
      const cond = executeSrc.slice(condStart, condStart + 700);
      assert.ok(
        cond.includes("HTTP_STATUS.RATE_LIMITED"),
        "streaming condition head must admit 429 via HTTP_STATUS.RATE_LIMITED"
      );
    });

    it("QUOTA_EXHAUSTED branch keeps the connection active when extra keys remain eligible", () => {
      const q = src.indexOf("errorType === PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED");
      assert.notEqual(q, -1);
      const block = src.slice(q, q + 9000);
      assert.ok(
        block.includes("shouldKeepConnectionActiveOnRateLimit"),
        "quota-exhausted path must consult the extra-keys guard before disabling the connection"
      );
    });
  });
});

describe("noauth-refresh-guard", () => {
  /**
   * A 401/403 from a provider that has no token to refresh must not start a refresh.
   *
   * A no-auth provider connection carries no credentials, so every refresh attempt
   * fails after three retries (several seconds), and five failures open the
   * provider-wide refresh breaker for 30 minutes with "needs re-authentication". A
   * refusal that is scoped to the request (same verdict from every account) never
   * indicates a stale token either, keyed connection or not.
   */
  const originalFetch = globalThis.fetch;
  const REFUSAL_BODY = JSON.stringify({
    type: "error",
    error: {
      type: "FreeTierError",
      message:
        "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
    },
  });
  const AUTH_BODY = JSON.stringify({ error: { message: "invalid api key", type: "auth_error" } });
  const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

  before(async () => {
    await resetTestDb();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    clearAllModelLockouts();
    clearOpencodeFreeTierSkips();
  });

  // #14313: a free-tier refusal on noauth records a short TTL skip; drop it so later
  // cases in this file still resolve the synthetic credentials under test.
  beforeEach(() => {
    clearOpencodeFreeTierSkips();
  });

  async function refreshAttemptsFor({ provider, model, credentials, status, body }) {
    const executor = await getExecutor(provider);
    const originalRefresh = executor.refreshCredentials;
    let attempts = 0;
    executor.refreshCredentials = async () => {
      attempts += 1;
      return null;
    };
    globalThis.fetch = async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } });
    try {
      const requestBody = { model, messages: [{ role: "user", content: "hi" }], stream: false };
      await handleChatCore({
        body: structuredClone(requestBody),
        modelInfo: { provider, model, extendedContext: false },
        credentials,
        log: noopLog,
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(requestBody),
          headers: new Headers({ accept: "application/json" }),
        },
        connectionId: credentials.connectionId ?? null,
      });
      return attempts;
    } finally {
      executor.refreshCredentials = originalRefresh;
      globalThis.fetch = originalFetch;
    }
  }

  test("a request-scoped refusal on the no-auth connection starts no refresh", async () => {
    const credentials = await auth.getProviderCredentials(
      "uncloseai",
      null,
      null,
      "Lorbus/Qwen3.6-27B-int4-AutoRound"
    );
    assert.equal(credentials?.connectionId, "noauth");
    const attempts = await refreshAttemptsFor({
      provider: "uncloseai",
      model: "Lorbus/Qwen3.6-27B-int4-AutoRound",
      credentials,
      status: 403,
      body: REFUSAL_BODY,
    });
    assert.equal(attempts, 0);
  });

  test("a plain 401 on the no-auth connection starts no refresh (nothing to refresh)", async () => {
    const credentials = await auth.getProviderCredentials(
      "uncloseai",
      null,
      null,
      "Lorbus/Qwen3.6-27B-int4-AutoRound"
    );
    assert.equal(credentials?.connectionId, "noauth");
    const attempts = await refreshAttemptsFor({
      provider: "uncloseai",
      model: "Lorbus/Qwen3.6-27B-int4-AutoRound",
      credentials,
      status: 401,
      body: AUTH_BODY,
    });
    assert.equal(attempts, 0);
  });

  test("a request-scoped refusal on a keyed OpenCode connection starts no refresh", async () => {
    const attempts = await refreshAttemptsFor({
      provider: "opencode-zen",
      model: "big-pickle",
      credentials: { apiKey: "sk-test", connectionId: "conn-keyed", providerSpecificData: {} },
      status: 403,
      body: REFUSAL_BODY,
    });
    assert.equal(attempts, 0);
  });

  test("a 401 on a keyed provider still attempts the refresh (unchanged)", async () => {
    const attempts = await refreshAttemptsFor({
      provider: "openai",
      model: "gpt-4o-mini",
      credentials: { apiKey: "sk-test", connectionId: "conn-openai", providerSpecificData: {} },
      status: 401,
      body: AUTH_BODY,
    });
    assert.ok(attempts >= 1, `expected a refresh attempt, got ${attempts}`);
  });
});

describe("token-refresh-race-comprehensive", () => {
  const read = (rel: string) => readFile(path.join(REPO_ROOT, rel), "utf8");

  test("Fix A: getAccessToken accepts an onPersist parameter", async () => {
    const src = await read("open-sse/services/tokenRefresh.ts");
    // Accepts either the legacy `(result: any) => Promise<void>` or the
    // refactored named-type form (RefreshPersistFn) — the latter is preferred
    // because it satisfies the t11 any-budget.
    assert.match(
      src,
      /export async function getAccessToken\([\s\S]{0,500}onPersist\?:\s*(?:RefreshPersistFn|\(result:\s*\w+\)\s*=>\s*Promise<void>)/,
      "getAccessToken must declare onPersist as the 5th parameter"
    );
  });

  test("Fix A: getAccessToken invokes onPersist INSIDE the per-connection mutex closure", async () => {
    const src = await read("open-sse/services/tokenRefresh.ts");
    // #15002 (#14970) moved the closure into `const work = (async () => {...})()` and made the
    // shared `entry.promise` a bounded race over it; the closure is still the mutex body.
    const closureMatch = src.match(
      /(?:entry\.promise|const work)\s*=\s*\(async\s*\(\)\s*=>\s*\{([\s\S]+?)\}\)\(\)/
    );
    assert.ok(closureMatch, "Per-connection mutex closure must use the (async () => {...})() form");
    if (/const work\s*=/.test(closureMatch![0])) {
      assert.match(
        src,
        /entry\.promise\s*=\s*Promise\.race\(\[\s*work,/,
        "the shared mutex promise must be the raced `work` closure"
      );
    }
    const closureBody = closureMatch![1];
    assert.match(
      closureBody,
      /effectiveOnPersist/,
      "The mutex closure body must reference effectiveOnPersist so the persist runs before the mutex releases"
    );
  });

  test("Fix A: runWithOnPersist + getActiveOnPersist are exported for executor plumbing", async () => {
    const src = await read("open-sse/services/tokenRefresh.ts");
    assert.match(src, /export function runWithOnPersist\b/);
    assert.match(src, /export function getActiveOnPersist\b/);
    assert.match(src, /AsyncLocalStorage/);
  });

  test("Fix A: chatCore.ts wraps executor.refreshCredentials with runWithOnPersist", async () => {
    const src = await read("open-sse/handlers/chatCore.ts");
    assert.match(
      src,
      /runWithOnPersist\([\s\S]{0,200}executor\.refreshCredentials/,
      "chatCore.ts reactive 401 path must wrap refreshCredentials with runWithOnPersist"
    );
  });

  test("Fix A: base.ts proactive refresh also wraps refreshCredentials with runWithOnPersist", async () => {
    const src = await read("open-sse/executors/base.ts");
    assert.match(
      src,
      /runWithOnPersist\([\s\S]{0,200}this\.refreshCredentials/,
      "base.ts proactive needsRefresh branch must wrap refreshCredentials with runWithOnPersist"
    );
  });

  test("Fix B: refreshOAuthToken in test/route.ts includes connectionId in credentials", async () => {
    const src = await read("src/app/api/providers/[id]/test/route.ts");
    const fnIdx = src.indexOf("async function refreshOAuthToken(");
    assert.ok(fnIdx >= 0, "refreshOAuthToken function must exist");
    const fnSlice = src.slice(fnIdx, fnIdx + 2500);
    assert.match(
      fnSlice,
      /connectionId:\s*connection\.id/,
      "refreshOAuthToken credentials must include connectionId so Layer 1 (per-connection mutex) is used instead of Layer 2 (token-hash dedup)"
    );
    assert.match(
      fnSlice,
      /onPersist|async\s*\(refreshed\)\s*=>/,
      "refreshOAuthToken must pass an onPersist callback so the DB write is atomic with the network refresh"
    );
  });

  test("Fix C reverted: codexAuthImport does NOT refresh tokens on import (avoids family revocation on stale auth.json)", async () => {
    const src = await read("src/lib/oauth/utils/codexAuthImport.ts");
    assert.doesNotMatch(
      src,
      /refreshConnectionTokensOnImport\(/,
      "Fix C was reverted because auth.json files exported from Codex CLI are often partially rotated; refreshing with a stale refresh_token caused upstream to invalidate the entire token family"
    );
    assert.doesNotMatch(
      src,
      /import\s*\{[^}]*getAccessToken[^}]*\}\s*from\s*"@omniroute\/open-sse\/services\/tokenRefresh/,
      "codexAuthImport should not import getAccessToken (refresh-on-import was reverted)"
    );
  });

  test("codexAuthImport public surface keeps only consumed auth import types", async () => {
    const src = await read("src/lib/oauth/utils/codexAuthImport.ts");
    assert.doesNotMatch(src, /export interface CodexAuthFileInput\b/);
    assert.match(src, /export interface ParsedCodexAuth\b/);
    assert.match(src, /export interface CreateConnectionOptions\b/);
  });

  test("Fix D: staleness fallback returns absolute expiresAt, not raw expiresIn", async () => {
    const src = await read("open-sse/services/tokenRefresh.ts");
    // Locate the actual return statement, not the JSDoc mention.
    // The anchor is the log line "DB token is still valid. Skipping OAuth refresh."
    // which only appears in the code path (the JSDoc says "DB token is still valid it is").
    const idx = src.indexOf("DB token is still valid. Skipping");
    assert.ok(idx >= 0, "Staleness-valid log line not found");
    const slice = src.slice(idx, idx + 800);
    assert.match(
      slice,
      /expiresAt:\s*dbConnection\.expiresAt/,
      "Staleness fallback must return absolute expiresAt"
    );
    assert.doesNotMatch(
      slice,
      /expiresIn:\s*dbConnection\.expiresIn(?!\s*\/\/)/,
      "Staleness fallback must NOT return raw expiresIn (causes downstream lifetime extension)"
    );
  });

  test("Fix D: src/sse wrapper prefers expiresAt over expiresIn when recomputing", async () => {
    const src = await read("src/sse/services/tokenRefresh.ts");
    // The recompute block in checkAndRefreshToken
    assert.match(
      src,
      /expiresAt:\s*newCredentials\.expiresAt\s*\?\s*newCredentials\.expiresAt/,
      "checkAndRefreshToken must prefer the absolute expiresAt before falling back to expiresIn arithmetic"
    );
  });

  test("Fix E: chatCore.ts moves credentials mutation INSIDE the mutex closure via persistFn", async () => {
    const src = await read("open-sse/handlers/chatCore.ts");
    // The persistFn closure must do BOTH the Object.assign AND the user callback
    const persistFnMatch = src.match(
      /const\s+persistFn\s*=[\s\S]{0,800}Object\.assign\(credentials,[\s\S]{0,300}onCredentialsRefreshed/
    );
    assert.ok(
      persistFnMatch,
      "chatCore.ts must build persistFn that both Object.assigns credentials and calls onCredentialsRefreshed, so both happen INSIDE the mutex"
    );
  });

  test("Fix F removed: no over-eager skip that would bypass legitimate refreshes", async () => {
    const src = await read("open-sse/services/tokenRefresh.ts");
    // Fix F was intentionally removed because it skipped refreshes that the
    // caller (checkAndRefreshToken) had already decided were needed. Verify the
    // dead-code branch is gone (no `credentials.accessToken === dbConnection.accessToken`
    // skip path remains).
    assert.doesNotMatch(
      src,
      /credentials\.accessToken\s*===\s*dbConnection\.accessToken[\s\S]{0,300}Skipping OAuth refresh/,
      "Fix F was removed because it caused legitimate refreshes to be skipped"
    );
  });

  test("Mutex consolidation: src/sse wrapper no longer holds its own connectionRefreshMutex map", async () => {
    const src = await read("src/sse/services/tokenRefresh.ts");
    // It's OK to keep a withConnectionRefreshMutex shim for back-compat, but
    // the actual Map should not be re-instantiated here (use the open-sse one).
    const hasOwnMap = /const\s+connectionRefreshMutex\s*=\s*new\s+Map/.test(src);
    if (hasOwnMap) {
      // If a Map remains, the file must clearly document that it is a deprecated
      // shim — otherwise it's a regression that recreates the dual-mutex bug.
      assert.match(
        src,
        /deprecated|legacy|shim|redundant|kept for back-compat/i,
        "If src/sse keeps its own connectionRefreshMutex Map, the file must document it as deprecated/legacy"
      );
    }
  });

  test("Imports: chatCore.ts imports runWithOnPersist from open-sse tokenRefresh", async () => {
    const src = await read("open-sse/handlers/chatCore.ts");
    assert.match(src, /runWithOnPersist/);
    assert.match(src, /from\s+"\.\.\/services\/tokenRefresh\.ts"/);
  });

  test("Imports: base.ts imports runWithOnPersist from open-sse tokenRefresh", async () => {
    const src = await read("open-sse/executors/base.ts");
    assert.match(src, /runWithOnPersist/);
    assert.match(src, /from\s+"\.\.\/services\/tokenRefresh\.ts"/);
  });

  test("serialized refresh re-checks rotation inside the lane, not before waiting", async () => {
    const src = await read("open-sse/services/tokenRefresh.ts");
    const start = src.indexOf("async function _getAccessTokenWithStalenessCheck");
    const inner = src.indexOf("async function _refreshWithFreshCredentials");
    assert.ok(start >= 0 && inner > start, "staleness helper must wrap the freshness re-check");
    const wrapper = src.slice(start, inner);
    assert.match(
      wrapper,
      // Whitespace-tolerant: #15002 added a `log` argument, so prettier wraps the call.
      /serializeRefresh\(\s*provider,\s*\(\)\s*=>/,
      "the network POST must stay behind serializeRefresh"
    );
    assert.match(wrapper, /_refreshWithFreshCredentials/);
    assert.doesNotMatch(
      wrapper,
      /lookupRotation/,
      "lookupRotation before serializeRefresh is the race that burns a Claude refresh token"
    );
    const body = src.slice(inner, inner + 2500);
    assert.match(body, /lookupRotation\(/);
    assert.match(body, /recordRotation\(/);
    assert.match(body, /_getAccessTokenInternal\(/);
  });
});

describe("provider-request-failure-pipeline", () => {
  const originalFetch = globalThis.fetch;
  type ChatCoreArgs = Parameters<typeof handleChatCore>[0];

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  async function waitFor(fn, timeoutMs = CALL_LOG_SETTLE_TIMEOUT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const result = await fn();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  async function waitForAsyncSideEffects() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async function getLatestCallLog() {
    const rows = await getCallLogs({ limit: 5 });
    if (!Array.isArray(rows) || rows.length === 0 || rows[0].detailState !== "ready") return null;
    return getCallLogById(rows[0].id);
  }

  async function resetStorage() {
    resetPayloadRulesConfigForTests();
    invalidateCacheControlSettingsCache();
    clearCache();
    idempotencyLayer.clearIdempotency();
    clearInflight();
    clearModelLock();
    // Call-log persistence is fire-and-forget and the first cold artifact-worker
    // spawn takes seconds (see CALL_LOG_SETTLE_TIMEOUT_MS), so this test's saves may
    // still be in flight when the next test resets the DB. Drain so a late row cannot
    // land in the next test's fresh database and get picked up by its
    // waitFor(getLatestCallLog()) (#12780).
    await waitForCallLogSaves(CALL_LOG_SETTLE_TIMEOUT_MS);
    core.resetDbInstance();
    await resetTestDb();
    // A full reset must also drop the settings read-cache. Otherwise the cached
    // value (e.g. call_log_pipeline_enabled=true seeded earlier) survives the DB
    // wipe and silently masks the fact that the fresh DB has the default. In CI
    // under load this cache is evicted at unpredictable times, so tests that rely
    // on the stale cache flake. Make the reset honest and deterministic here.
    invalidateDbCache("settings");
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  // Re-seed per test, NOT once: every `afterEach` runs resetStorage(), which wipes
  // the DB and drops the settings cache. A run-once `before` only guaranteed the
  // flag for the first test; later tests depended on a stale cache surviving the
  // wipe, which flakes under CI load. beforeEach re-establishes it deterministically.
  beforeEach(async () => {
    await resetStorage();
    await settingsDb.updateSettings({ call_log_pipeline_enabled: true });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    clearPendingRequests();
    resetAccountSemaphores();
    await resetStorage();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    clearPendingRequests();
    resetAccountSemaphores();
    await resetStorage();
  });

  test("network failure persisted call log includes providerRequest in pipeline payloads", async () => {
    const body = {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };

    globalThis.fetch = async () => {
      throw new Error("Connection refused");
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
    } as unknown as ChatCoreArgs);

    assert.equal(result.success, false);
    assert.equal(result.status, 502);

    // waitFor below polls for the exact DB state with 25ms intervals — no
    // unreliable fixed-delay timer needed, even under CI load contention.
    const detail = await waitFor(getLatestCallLog);
    assert.ok(detail, "expected a call log to be persisted");

    assert.ok(
      detail.pipelinePayloads,
      "expected pipeline payloads when call_log_pipeline_enabled is true"
    );
    assert.ok(
      detail.pipelinePayloads.providerRequest,
      "providerRequest must be present in pipeline payloads even on network failure"
    );
    const providerReqBody =
      detail.pipelinePayloads.providerRequest.body ?? detail.pipelinePayloads.providerRequest;
    assert.equal(
      providerReqBody.model,
      "gpt-4o-mini",
      "providerRequest should contain the translated model"
    );
    const messages =
      providerReqBody.messages ?? (Array.isArray(providerReqBody) ? providerReqBody : null);
    if (messages) {
      assert.equal(messages[0]?.content, "hello");
    }
    assert.equal(
      detail.pipelinePayloads.providerResponse ?? null,
      null,
      "providerResponse should be null/absent on network failure (no response received)"
    );
    assert.ok(detail.pipelinePayloads.error, "pipeline payloads should include the error details");
  });

  test("network timeout persisted call log includes providerRequest in pipeline payloads", async () => {
    const executor = await getExecutor("openai");
    const originalGetTimeoutMs = executor.getTimeoutMs?.bind(executor);
    executor.getTimeoutMs = () => 200;

    const body = {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "timeout test" }],
    };

    globalThis.fetch = async () => {
      return new Promise(() => {}); // never resolve
    };

    try {
      const invocation = handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
      } as unknown as ChatCoreArgs);

      const result = await invocation;

      assert.equal(result.success, false);
      assert.ok(result.status === 504, `expected 504 timeout, got ${result.status}`);

      const detail = await waitFor(getLatestCallLog);
      assert.ok(detail, "expected a call log to be persisted");
      assert.ok(detail.pipelinePayloads, "expected pipeline payloads");

      assert.ok(
        detail.pipelinePayloads?.providerRequest,
        "providerRequest must be present in pipeline payloads on timeout"
      );
      const providerReqBody =
        detail.pipelinePayloads?.providerRequest?.body ?? detail.pipelinePayloads?.providerRequest;
      assert.equal(providerReqBody?.model, "gpt-4o-mini");
    } finally {
      if (originalGetTimeoutMs) executor.getTimeoutMs = originalGetTimeoutMs;
    }
  });

  test("provider error response (HTTP 502) includes both providerRequest and providerResponse in pipeline", async () => {
    const body = {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "trigger 502" }],
    };

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          error: { message: "Upstream provider error", type: "server_error" },
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
    } as unknown as ChatCoreArgs);

    assert.equal(result.success, false);
    assert.equal(result.status, 502);

    const detail = await waitFor(getLatestCallLog);
    assert.ok(detail, "expected a call log to be persisted");

    assert.ok(detail.pipelinePayloads, "expected pipeline payloads");
    assert.ok(
      detail.pipelinePayloads.providerRequest,
      "providerRequest must be present on HTTP error response"
    );
    assert.ok(
      detail.pipelinePayloads.providerResponse,
      "providerResponse must be present on HTTP error response (upstream responded)"
    );
    assert.equal(
      detail.pipelinePayloads.providerResponse.status,
      502,
      "providerResponse status should reflect the upstream error"
    );
  });

  test("successful response includes both providerRequest and providerResponse in pipeline", async () => {
    const body = {
      model: "gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    };

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-ok",
          object: "chat.completion",
          model: "gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "world" },
              finish_reason: "stop",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "cf-ray": "response-ray",
            server: "cloudflare",
          },
        }
      );
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
    } as unknown as ChatCoreArgs);

    assert.equal(result.success, true);

    const detail = await waitFor(getLatestCallLog);
    assert.ok(detail, "expected a call log to be persisted");

    assert.ok(detail.pipelinePayloads, "expected pipeline payloads");
    assert.ok(
      detail.pipelinePayloads.providerRequest,
      "providerRequest must be present on success"
    );
    assert.ok(
      detail.pipelinePayloads.providerResponse,
      "providerResponse must be present on success"
    );
    assert.equal(
      detail.pipelinePayloads.providerRequest.headers["cf-ray"],
      undefined,
      "providerRequest headers must not be overwritten with upstream response headers"
    );
    assert.equal(
      detail.pipelinePayloads.providerRequest.headers.server,
      undefined,
      "providerRequest headers must not include upstream response server header"
    );
    assert.equal(detail.pipelinePayloads.providerRequest.headers.Accept, "application/json");
    assert.equal(
      detail.pipelinePayloads.providerRequest.headers["Content-Type"],
      "application/json"
    );
    assert.equal(detail.pipelinePayloads.providerRequest.headers.Authorization, "[REDACTED]");
  });

  test("streaming response preserves request headers in providerRequest pipeline payload", async () => {
    const body = {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    };

    const upstreamPayload = [
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { role: "assistant", content: "world" } }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    globalThis.fetch = async () => {
      return new Response(upstreamPayload, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "cf-ray": "stream-response-ray",
          server: "cloudflare",
        },
      });
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream" }),
      },
      userAgent: "unit-test",
    } as unknown as ChatCoreArgs);

    assert.equal(result.success, true);
    await result.response.text();

    const detail = await waitFor(getLatestCallLog);
    assert.ok(detail, "expected a call log to be persisted");
    assert.ok(detail.pipelinePayloads, "expected pipeline payloads");

    const providerRequest = detail.pipelinePayloads.providerRequest;
    assert.ok(providerRequest, "providerRequest must be present on streaming success");
    assert.equal(
      providerRequest.headers["cf-ray"],
      undefined,
      "streaming providerRequest headers must not be response headers"
    );
    assert.equal(providerRequest.headers.server, undefined);
    assert.equal(providerRequest.headers.Accept, "text/event-stream");
    assert.equal(providerRequest.headers["Content-Type"], "application/json");
    assert.equal(providerRequest.headers.Authorization, "[REDACTED]");
  });

  test("CC-compatible providerRequest log keeps request beta headers and summarized thinking body", async () => {
    const body = {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    };

    const upstreamPayload = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-6","usage":{"input_tokens":7,"output_tokens":0}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    globalThis.fetch = async () => {
      return new Response(upstreamPayload, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "cf-ray": "cc-response-ray",
          server: "cloudflare",
        },
      });
    };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: {
        provider: "anthropic-compatible-cc-test",
        model: "claude-opus-4-6",
        extendedContext: false,
      },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: {
          baseUrl: "https://proxy.example.com",
          requestDefaults: {
            context1m: true,
            redactThinking: true,
            summarizeThinking: true,
          },
        },
      },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
    } as unknown as ChatCoreArgs);

    assert.equal(result.success, true);
    await result.response.json();

    const detail = await waitFor(getLatestCallLog);
    assert.ok(detail, "expected a call log to be persisted");
    assert.ok(detail.pipelinePayloads, "expected pipeline payloads");

    const providerRequest = detail.pipelinePayloads.providerRequest;
    assert.ok(providerRequest, "providerRequest must be present on CC-compatible success");
    assert.equal(providerRequest.headers["cf-ray"], undefined);
    assert.equal(providerRequest.headers.server, undefined);
    assert.equal(providerRequest.headers.Accept, "text/event-stream");
    assert.match(providerRequest.headers["anthropic-beta"], new RegExp(CONTEXT_1M_BETA_HEADER));
    assert.match(
      providerRequest.headers["anthropic-beta"],
      new RegExp(CLAUDE_CODE_COMPATIBLE_REDACT_THINKING_BETA)
    );
    assert.equal(providerRequest.body.thinking.display, "summarized");
  });

  // #3229: Antigravity's 400s are the diagnostic blind spot this projection exists to fill —
  // but Google's error envelope is arbitrary and may echo request content, so the call log must
  // receive the bounded classification INSTEAD of the response, not alongside it. The failure
  // this locks: reqLogger.logProviderResponse() populating providerResponse with the upstream
  // status text, response headers, and body before persistAttemptLogs() runs, which would make
  // any "safe wrapper" passed later silently lose to the raw one already in the pipeline.
  test("antigravity failure logs only the bounded validation diagnostic, never the upstream body", async () => {
    const {
      seedAntigravityIdeVersionCache,
      seedAntigravityCliVersionCache,
      clearAntigravityVersionCaches,
    } = await import("../../../open-sse/services/antigravityVersion.ts");
    seedAntigravityIdeVersionCache("2026.04.17-test");
    seedAntigravityCliVersionCache("2026.04.17-test");

    const body = {
      model: "gemini-2.5-flash",
      stream: false,
      messages: [{ role: "user", content: "hunting-prompt-secret" }],
    };

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message:
              "Invalid JSON payload received. functionDeclarations[0].parameters: unknown name additionalProperties near prompt-secret",
            details: [{ toolArguments: "tool-secret", authorization: "Bearer credential-secret" }],
          },
        }),
        {
          status: 400,
          statusText: "Bad Request account-project-secret",
          headers: {
            "Content-Type": "application/json",
            "x-goog-project-id": "project-secret",
          },
        }
      );

    try {
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider: "antigravity", model: "gemini-2.5-flash", extendedContext: false },
        credentials: { accessToken: "token", projectId: "project-1" },
        log: noopLog(),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
      } as unknown as ChatCoreArgs);

      assert.equal(result.success, false);
      assert.equal(result.status, 400);
      // The client keeps the generic envelope: no upstream_details, no provider prose.
      assert.equal(result.body?.upstream_details, undefined);
      assert.doesNotMatch(
        JSON.stringify(result.body ?? {}),
        /prompt-secret|tool-secret|credential-secret|project-secret|additionalProperties/
      );

      await waitForAsyncSideEffects();

      const detail = await waitFor(getLatestCallLog);
      assert.ok(detail, "expected a call log to be persisted");
      assert.ok(detail.pipelinePayloads, "expected pipeline payloads");

      const providerResponse = detail.pipelinePayloads.providerResponse;
      assert.ok(providerResponse, "providerResponse must carry the diagnostic");
      assert.deepEqual(Object.keys(providerResponse).sort(), ["diagnostic", "timestamp"]);
      assert.deepEqual(providerResponse.diagnostic, {
        antigravityValidation: {
          httpStatus: 400,
          providerCode: 400,
          providerStatus: "INVALID_ARGUMENT",
          validationCategory: "tool_schema",
          validationField: "tools",
          schemaKeyword: "additionalProperties",
        },
      });
      assert.doesNotMatch(
        JSON.stringify(providerResponse),
        /prompt-secret|tool-secret|credential-secret|project-secret|Bad Request|x-goog/
      );
    } finally {
      clearAntigravityVersionCaches();
    }
  });
});

describe("execute-chat-resource-pressure-breaker", () => {
  /**
   * Resource-pressure isolation: executeChatWithBreaker must shed BEFORE the
   * provider breaker path and must not call handleChatCore on pressure 503.
   * Direct handleChatCore retains default guard protection.
   */
  const MiB = 1024 ** 2;

  async function resetStorage() {
    resetAllCircuitBreakers();
    await core.resetDbInstance();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    // Restore a non-shedding resource pressure runtime between tests.
    reloadResourcePressureRuntime({
      heapThresholdMb: 10_000,
      immediateHeapUsedMb: () => 1,
      sample: async () => ({
        observedAtMs: Date.now(),
        v8: { heapUsedBytes: MiB, heapLimitBytes: 10_000 * MiB },
        process: {
          rssBytes: MiB,
          externalBytes: 0,
          arrayBuffersBytes: 0,
          availableBytes: null,
          constrainedBytes: null,
        },
        cgroup: {
          currentBytes: null,
          maxBytes: null,
          highBytes: null,
          fileBytes: null,
          events: null,
        },
        psi: null,
      }),
    });
  }

  beforeEach(async () => {
    await resetStorage();
  });

  after(async () => {
    await resetStorage();
  });

  test("executeChatWithBreaker returns typed pressure 503 before normal, bypass, and shadow breaker paths", async () => {
    reloadResourcePressureRuntime({
      heapThresholdMb: 100,
      immediateHeapUsedMb: () => 999,
      sample: async () => {
        throw new Error("sampler must not run on request path");
      },
    });

    // Sanity: process singleton sheds.
    const direct = checkResourcePressureGuard();
    assert.ok(direct);
    assert.equal(direct!.status, 503);

    const breaker = getCircuitBreaker("openai-pressure-iso");
    const before = breaker.getStatus();
    const beforeSuccessCount = breaker.successCount;
    assert.equal(before.state, STATE.CLOSED);
    assert.equal(before.failureCount, 0);

    // If handleChatCore were entered it would attempt real provider work / DB.
    // Use credentials that would fail loudly if chatCore ran deep.
    const credentials = {
      connectionId: "conn_pressure_iso",
      apiKey: "sk-pressure-iso",
      providerSpecificData: {},
    };

    let canExecuteCalls = 0;
    const originalCanExecute = breaker.canExecute.bind(breaker);
    breaker.canExecute = () => {
      canExecuteCalls += 1;
      return originalCanExecute();
    };

    const baseExecution = {
      bypassCircuitBreaker: false,
      breaker,
      body: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "x" }] },
      provider: "openai",
      model: "gpt-4o-mini",
      refreshedCredentials: credentials,
      proxyInfo: null,
      log: console,
      clientRawRequest: { endpoint: "/v1/chat/completions", headers: {}, body: {} },
      credentials,
      apiKeyInfo: null,
      userAgent: "",
      comboName: null,
      comboStrategy: null,
      isCombo: false,
      extendedContext: false,
      comboStepId: null,
      comboExecutionKey: null,
    };
    const run = (
      overrides: {
        bypassCircuitBreaker?: boolean;
        trafficType?: "production" | "shadow";
      } = {}
    ) => executeChatWithBreaker({ ...baseExecution, ...overrides });

    const executions = await Promise.all([
      run(),
      run({ bypassCircuitBreaker: true }),
      run({ trafficType: "shadow" }),
    ]);
    const pressureResponses: Response[] = [];
    for (const execution of executions) {
      assert.equal(execution.tlsFingerprintUsed, false);
      if (!("localResourcePressureResult" in execution)) {
        assert.fail("provider execution result escaped the local pressure guard");
      }
      assert.equal(execution.localResourcePressureResult.response.status, 503);
      pressureResponses.push(execution.localResourcePressureResult.response);
    }
    const payload = await pressureResponses[0].json();
    assert.equal(payload.error.code, "resource_pressure");
    assert.match(payload.error.message, /resource pressure/i);

    const after = breaker.getStatus();
    assert.equal(canExecuteCalls, 0);
    assert.equal(after.state, STATE.CLOSED);
    assert.equal(after.failureCount, before.failureCount);
    assert.equal(breaker.successCount, beforeSuccessCount);
  });

  test("direct handleChatCore default still applies resource pressure guard", async () => {
    reloadResourcePressureRuntime({
      heapThresholdMb: 100,
      immediateHeapUsedMb: () => 500,
      sample: async () => ({
        observedAtMs: Date.now(),
        v8: { heapUsedBytes: 500 * MiB, heapLimitBytes: 1000 * MiB },
        process: {
          rssBytes: 200 * MiB,
          externalBytes: 0,
          arrayBuffersBytes: 0,
          availableBytes: null,
          constrainedBytes: null,
        },
        cgroup: {
          currentBytes: null,
          maxBytes: null,
          highBytes: null,
          fileBytes: null,
          events: null,
        },
        psi: null,
      }),
    });

    const result = await (
      handleChatCore as unknown as (opts: Record<string, unknown>) => Promise<{
        success?: boolean;
        status?: number;
        error?: string;
        response?: Response;
      }>
    )({
      body: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
      modelInfo: { provider: "openai", model: "gpt-4o-mini" },
      credentials: { connectionId: "c1", apiKey: "sk-x", providerSpecificData: {} },
      log: console,
      clientRawRequest: { endpoint: "/v1/chat/completions", headers: new Map() },
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.ok(result.response);
    const payload = await result.response.json();
    assert.equal(payload.error.code, "resource_pressure");
  });

  test("handleChatCore skipResourcePressureGuard bypasses the inside-core fuse", async () => {
    reloadResourcePressureRuntime({
      heapThresholdMb: 100,
      immediateHeapUsedMb: () => 500,
      sample: async () => ({
        observedAtMs: Date.now(),
        v8: { heapUsedBytes: 500 * MiB, heapLimitBytes: 1000 * MiB },
        process: {
          rssBytes: 200 * MiB,
          externalBytes: 0,
          arrayBuffersBytes: 0,
          availableBytes: null,
          constrainedBytes: null,
        },
        cgroup: {
          currentBytes: null,
          maxBytes: null,
          highBytes: null,
          fileBytes: null,
          events: null,
        },
        psi: null,
      }),
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: { message: "upstream" } }), { status: 502 });
    };

    try {
      // With skip=true the pressure fuse is not applied; chatCore proceeds and hits fetch.
      const result = await (
        handleChatCore as unknown as (opts: Record<string, unknown>) => Promise<{
          success?: boolean;
          status?: number;
          error?: string;
          response?: Response;
        }>
      )({
        body: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
        modelInfo: { provider: "openai", model: "gpt-4o-mini" },
        credentials: { connectionId: "c1", apiKey: "sk-x", providerSpecificData: {} },
        log: console,
        clientRawRequest: { endpoint: "/v1/chat/completions", headers: new Map() },
        skipResourcePressureGuard: true,
      });

      assert.ok(fetchCalls > 0, "skip must let chatCore reach provider work");
      // Must NOT be the resource_pressure 503 from the fuse.
      if (result?.response) {
        try {
          const payload = await result.response.clone().json();
          assert.notEqual(payload?.error?.code, "resource_pressure");
        } catch {
          // non-JSON is fine — means we left the pressure fuse path
        }
      } else if (result?.status === 503) {
        assert.notEqual(result?.error, "resource_pressure");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("request-dedup-tenant-isolation", () => {
  // GHSA-6c7w-56xp-wpc6 follow-up. The dedup layer shares ONE upstream call — and
  // therefore one response object — between every concurrent caller landing on the
  // same hash. The hash canonicalized model + prompt + sampling params and nothing
  // about WHO was asking, so two distinct OmniRoute API keys issuing the same
  // request joined the same in-flight promise: the response was produced with the
  // initiator's provider connection, under the initiator's per-key policy, and
  // handed to a different authenticated principal.
  //
  // #10438 fixed the *prompt* half of this class (translated bodies hashing the
  // prompt as `null`). This is the *identity* half.

  const body = {
    messages: [{ role: "user", content: "Summarize the incident report." }],
    temperature: 0,
    model: "codex/gpt-5.6-terra",
    stream: false,
  };

  test("trusted effort contexts split plain, low and high requests", () => {
    const hashes = [null, "low", "high"].map((resolvedThinkingEffort) =>
      computeRequestHash(body, "tenant", {
        originModel: "original",
        resolvedThinkingEffort,
      })
    );
    assert.equal(new Set(hashes).size, 3);
  });

  test("trusted hash context has fixed keys and null defaults", () => {
    assert.equal(
      computeRequestHash(body, "tenant", {}),
      computeRequestHash(body, "tenant", {
        defaultThinkingEffort: null,
        resolvedThinkingEffort: null,
        originModel: null,
      })
    );
    assert.equal(
      computeRequestHash(body, "tenant", {
        originModel: "original",
        resolvedThinkingEffort: "high",
      }),
      computeRequestHash(body, "tenant", {
        resolvedThinkingEffort: "high",
        originModel: "original",
        defaultThinkingEffort: undefined,
      })
    );
    for (const key of ["originModel", "resolvedThinkingEffort", "defaultThinkingEffort"] as const) {
      assert.notEqual(
        computeRequestHash(body, "tenant", {}),
        computeRequestHash(body, "tenant", { [key]: "different" })
      );
    }
    assert.notEqual(computeRequestHash(body, "tenant", {}), computeRequestHash(body, "other", {}));
    assert.notEqual(computeRequestHash(body, "tenant"), computeRequestHash(body, "tenant", {}));
  });

  test("legacy digest projection is unchanged without trusted context", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          model: body.model,
          messages: body.messages,
          system: null,
          temperature: 0,
          tools: null,
          tool_choice: null,
          max_tokens: null,
          response_format: null,
          top_p: null,
          frequency_penalty: null,
          presence_penalty: null,
        })
      )
      .digest("hex")
      .slice(0, 16);
    assert.equal(computeRequestHash(body), expected);
    assert.equal(computeRequestHash(body, "tenant"), `tenant.${expected}`);
    assert.equal(
      computeRequestHash({ ...body, trustedContext: { resolvedThinkingEffort: "high" } }, "tenant"),
      `tenant.${expected}`
    );
  });

  for (const field of ["reasoning_effort", "reasoning", "thinking", "output_config"]) {
    test(`explicit hash intent preserves ${field} presence and complete values`, () => {
      const values = [undefined, null, false, {}, "none", "high", { effort: "high" }];
      const hashes = values.map((value) =>
        computeRequestHash({ ...body, [field]: value }, "tenant", {})
      );
      assert.equal(new Set(hashes).size, values.length);
      assert.equal(hashes[0], computeRequestHash(body, "tenant", {}));
      for (const value of values) {
        const request = { ...body, [field]: value };
        assert.equal(
          computeRequestHash(request, "tenant", {}),
          computeRequestHash(structuredClone(request), "tenant", {})
        );
        assert.notEqual(
          computeRequestHash(request, "tenant", {}),
          computeRequestHash(request, "other", {})
        );
        assert.equal(computeRequestHash(request, "tenant"), computeRequestHash(body, "tenant"));
      }
    });
  }

  for (const [field, first, second] of [
    ["reasoning", { effort: "high", summary: "auto" }, { effort: "high", summary: "detailed" }],
    [
      "thinking",
      { type: "enabled", budget_tokens: 1024 },
      { type: "enabled", budget_tokens: 2048 },
    ],
    ["output_config", { effort: "high" }, { effort: "max" }],
    [
      "output_config",
      { effort: "high", format: { type: "text" } },
      { effort: "high", format: { type: "json" } },
    ],
  ] as const) {
    test(`explicit hash intent preserves nested ${field} knobs ${JSON.stringify(second)}`, () => {
      assert.notEqual(
        computeRequestHash({ ...body, [field]: first }, "tenant", {}),
        computeRequestHash({ ...body, [field]: second }, "tenant", {})
      );
    });
  }

  test("explicit hash intent uses fixed outer keys and ordinary nested JSON order", () => {
    const a = { ...body, reasoning: { effort: "high", summary: "auto" }, thinking: false };
    const b = { thinking: false, reasoning: { effort: "high", summary: "auto" }, ...body };
    assert.equal(computeRequestHash(a, "tenant", {}), computeRequestHash(b, "tenant", {}));
    assert.notEqual(
      computeRequestHash(a, "tenant", {}),
      computeRequestHash({ ...a, reasoning: { summary: "auto", effort: "high" } }, "tenant", {})
    );
    assert.notEqual(
      computeRequestHash({ ...body, reasoning: { knobs: [1, 2] } }, "tenant", {}),
      computeRequestHash({ ...body, reasoning: { knobs: [2, 1] } }, "tenant", {})
    );
  });

  test("explicit hash intent cannot spoof origin metadata and retains suffix separation", () => {
    const request = { ...body, reasoning_effort: "high" };
    const trusted = { originModel: "original", resolvedThinkingEffort: "low" };
    assert.equal(
      computeRequestHash(request, "tenant", trusted),
      computeRequestHash(
        {
          ...request,
          trustedContext: { resolvedThinkingEffort: "high" },
          requestIntent: { reasoning_effort: "none" },
          originModel: "spoofed",
          resolvedThinkingEffort: "high",
        },
        "tenant",
        trusted
      )
    );
    assert.notEqual(
      computeRequestHash(request, "tenant", trusted),
      computeRequestHash(request, "tenant", { ...trusted, resolvedThinkingEffort: "high" })
    );
  });

  test("the same request from two different API keys does NOT share a dedup hash", () => {
    const hashKey1 = computeRequestHash(body, "apikey-1");
    const hashKey2 = computeRequestHash(body, "apikey-2");
    assert.notEqual(
      hashKey1,
      hashKey2,
      "an identical request from a different API key must not join the first key's in-flight call"
    );
  });

  test("the same request from the same API key still dedups", () => {
    assert.equal(computeRequestHash(body, "apikey-1"), computeRequestHash(body, "apikey-1"));
  });

  test("concurrent identical requests on two keys each get their own response", async () => {
    clearInflight();
    const hash1 = computeRequestHash(body, "apikey-1");
    const hash2 = computeRequestHash(body, "apikey-2");

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const first = deduplicate(hash1, async () => {
      await gate;
      return "RESPONSE_FOR_KEY_1";
    });
    const second = deduplicate(hash2, async () => {
      await gate;
      return "RESPONSE_FOR_KEY_2";
    });
    released();

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.result, "RESPONSE_FOR_KEY_1");
    assert.equal(b.result, "RESPONSE_FOR_KEY_2");
    assert.equal(b.wasDeduplicated, false, "key 2 must not have joined key 1's in-flight call");
  });

  test("an unkeyed (anonymous) caller keeps the un-namespaced hash", () => {
    // Keyless local-first deployments have no tenant boundary to preserve, so the
    // behaviour there is unchanged — and must stay stable, or every such install
    // silently loses dedup.
    const anonymous = computeRequestHash(body);
    assert.equal(computeRequestHash(body, undefined), anonymous);
    assert.equal(computeRequestHash(body, null as unknown as undefined), anonymous);
    assert.notEqual(computeRequestHash(body, "apikey-1"), anonymous);
  });

  test("the tenant namespace cannot be forged by a colliding request body", () => {
    // The namespace is a plaintext prefix, so it must not be possible to move
    // between namespaces by crafting a body — the separator has to survive.
    const h1 = computeRequestHash(body, "a");
    const h2 = computeRequestHash(body, "a.b");
    assert.notEqual(h1, h2);
    assert.ok(h1.startsWith("a."), "namespace must prefix the digest");
  });

  test("chatCore passes the caller's API key id into the dedup hash", async () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url)),
      "utf8"
    );
    assert.ok(
      /computeRequestHash\(\s*dedupRequestBody\s*,\s*apiKeyInfo\?\.id/.test(source),
      "the dedup hash must be namespaced by the calling API key (GHSA-6c7w-56xp-wpc6)"
    );
  });
});

describe("idempotency-window-setting", () => {
  /**
   * Regression: the `idempotencyWindowMs` setting (Settings → Cache) must reach the
   * idempotency store. It was persisted and echoed back by /api/cache, but the only save
   * site never passed it, so the store always used the 5s default.
   */
  const layer = idempotencyLayer;

  // The first test needs the setting unset; the later ones persist it.
  before(async () => {
    await resetTestDb();
  });

  after(async () => {
    layer.clearIdempotency();
    await resetTestDb();
  });

  test("window falls back to 5000ms when the setting is unset", async () => {
    assert.equal(await layer.getIdempotencyWindowMs(), 5000);
  });

  test("window follows idempotencyWindowMs once configured", async () => {
    await settingsDb.updateSettings({ idempotencyWindowMs: 60_000 });
    assert.equal(await layer.getIdempotencyWindowMs(), 60_000);
    assert.equal((await layer.getIdempotencyStats()).windowMs, 60_000);
  });

  test("an invalid configured window falls back to the default", async () => {
    await settingsDb.updateSettings({ idempotencyWindowMs: -1 });
    assert.equal(await layer.getIdempotencyWindowMs(), 5000);
  });

  test("a saved entry honors the passed window and expires after it", async () => {
    layer.clearIdempotency();
    layer.saveIdempotency("k-short", { ok: true }, 200, 20);
    layer.saveIdempotency("k-long", { ok: true }, 200, 60_000);
    assert.ok(layer.checkIdempotency("k-short"));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(layer.checkIdempotency("k-short"), null);
    assert.ok(layer.checkIdempotency("k-long"));
    layer.clearIdempotency();
  });

  test("saveIdempotencyWithConfiguredWindow stores with the configured window", async () => {
    layer.clearIdempotency();
    await settingsDb.updateSettings({ idempotencyWindowMs: 20 });
    await layer.saveIdempotencyWithConfiguredWindow("k-cfg", { ok: true }, 200);
    assert.ok(layer.checkIdempotency("k-cfg"));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(layer.checkIdempotency("k-cfg"), null);

    await settingsDb.updateSettings({ idempotencyWindowMs: 60_000 });
    await layer.saveIdempotencyWithConfiguredWindow("k-cfg-long", { ok: true }, 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(layer.checkIdempotency("k-cfg-long"));
    layer.clearIdempotency();
  });

  test("saveIdempotencyWithConfiguredWindow ignores a missing key", async () => {
    layer.clearIdempotency();
    await layer.saveIdempotencyWithConfiguredWindow(null, { ok: true }, 200);
    assert.equal((await layer.getIdempotencyStats()).activeKeys, 0);
  });

  test("chatCore saves idempotency through the configured-window helper", () => {
    // The non-streaming save moved into runNonStreamingResponse. chatCore must hand it
    // the configured-window helper, and that helper must be awaited at the save site.
    const chatCore = fs.readFileSync(path.join(REPO_ROOT, "open-sse/handlers/chatCore.ts"), "utf8");
    const nonStreaming = fs.readFileSync(
      path.join(REPO_ROOT, "open-sse/handlers/chatCore/nonStreamingResponse.ts"),
      "utf8"
    );
    assert.match(chatCore, /saveIdempotency:\s*saveIdempotencyWithConfiguredWindow/);
    assert.doesNotMatch(chatCore, /[^\w]saveIdempotency\(/);
    assert.match(nonStreaming, /await saveIdempotency\(idempotencyKey, translatedResponse, 200\)/);
  });
});

describe("proxy-bypass-scope-guard-3226", () => {
  /**
   * Scope guard for the deliberate NVIDIA validation proxy bypass (#3226).
   *
   * Context: NVIDIA's API-key validation endpoint stalls when routed through the
   * global proxy/TLS-patched fetch (undici dispatcher → 504). As a documented
   * exception, `directHttpsRequest()` in `src/lib/providers/validation.ts` calls
   * `safeOutboundFetch({ bypassProxyPatch: true })`, which resolves the native
   * fetch reference via `getOriginalFetch()` and bypasses the patch for that one
   * validation call only.
   *
   * This test asserts that the bypass is CONFINED to the validation path and has
   * NOT silently spread to the chat hot path (chatHelpers / chatCore).
   *
   * See also: tests/unit/nvidia-validation-bypass-proxy-3226.test.ts (mechanism seam tests).
   */

  test("bypassProxyPatch is present in the NVIDIA validation path (#3226 documented exception)", () => {
    // After the validation.ts godfile split (#4921–#4930), bypassProxyPatch moved to the
    // extracted validation/headers.ts. Assert the bypass lives in the validation LAYER
    // (validation.ts + its extracted modules), not that it stayed in one file.
    const validationLayer =
      fs.readFileSync("src/lib/providers/validation.ts", "utf8") +
      fs.readFileSync("src/lib/providers/validation/headers.ts", "utf8");
    assert.ok(
      validationLayer.includes("bypassProxyPatch"),
      "expected bypassProxyPatch in the validation layer (validation/headers.ts) — the documented NVIDIA exception"
    );
    assert.ok(
      validationLayer.includes("directHttpsRequest"),
      "expected directHttpsRequest helper in the validation layer"
    );
  });

  test("bypassProxyPatch is absent from the chat hot path (scope guard — #3226)", () => {
    // The chat hot path must never bypass the proxy patch.
    // If either of these assertions starts failing, a code change has silently
    // extended the NVIDIA-only exception to the chat/usage egress path.
    const chatHelpers = fs.readFileSync("src/sse/handlers/chatHelpers.ts", "utf8");
    // Anchor: without it, extracting the egress code into another module would make the
    // negative guard below pass against a file that no longer contains the hot path.
    assert.match(chatHelpers, /export async function executeChatWithBreaker\(/);
    assert.ok(
      !chatHelpers.includes("bypassProxyPatch"),
      "chatHelpers.ts must not bypass the proxy patch — only NVIDIA validation may do this (#3226)"
    );

    const chatCore = fs.readFileSync("open-sse/handlers/chatCore.ts", "utf8");
    // Anchor: chatCore.ts is actively being split, so pin the entry point the route
    // imports — the negative guard is worthless if this read silently misses the file.
    assert.match(chatCore, /export async function handleChatCore\(/);
    assert.ok(
      !chatCore.includes("bypassProxyPatch"),
      "chatCore.ts must not bypass the proxy patch — only NVIDIA validation may do this (#3226)"
    );
  });
});

describe("pre-dispatch-error-route-meta", () => {
  const originalFetch = globalThis.fetch;
  const MODEL = "gemini-2.5-flash";

  function noopLog() {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    geminiTracker.resetCounters();
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("the Gemini TPM pre-dispatch 429 carries the resolved provider and model headers", async () => {
    const tpm = geminiTracker.getModelTpm(MODEL);
    assert.ok(tpm > 0, `${MODEL} must have a TPM limit for this guard to fire`);
    geminiTracker.incrementTokenUsage(MODEL, tpm + 1);
    let dispatched = false;
    globalThis.fetch = async () => {
      dispatched = true;
      return new Response("{}", { status: 200 });
    };
    const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };

    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "gemini", model: MODEL, extendedContext: false },
      credentials: { apiKey: "test-gemini-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ "content-type": "application/json" }),
      },
      userAgent: "test",
    });

    assert.equal(dispatched, false, "the guard must reject before any upstream call");
    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.equal(result.errorCode, "GEMINI_TPM_EXHAUSTED");
    assert.equal(result.response.status, 429);
    assert.equal(result.response.headers.get("X-OmniRoute-Provider"), "gemini");
    assert.equal(result.response.headers.get("X-OmniRoute-Model"), MODEL);
    assert.match(result.response.headers.get("Content-Type"), /application\/json/);
    const payload = await result.response.json();
    assert.equal(payload.error.code, "GEMINI_TPM_EXHAUSTED");
    assert.match(payload.error.message, /Gemini TPM rate limit reached/);
  });

  test("createErrorResult without route metadata keeps only its JSON content type", () => {
    const result = createErrorResult(429, "Token limit exceeded", null, "TOKEN_LIMIT_EXCEEDED");
    assert.deepEqual([...result.response.headers.keys()], ["content-type"]);
    assert.equal(result.errorCode, "TOKEN_LIMIT_EXCEEDED");
  });

  test("both pre-dispatch rejections, and no other error, attach the route metadata", () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "open-sse/handlers/chatCore.ts"), "utf8");
    for (const code of ["TOKEN_LIMIT_EXCEEDED", "GEMINI_TPM_EXHAUSTED"]) {
      const site = new RegExp(
        `"${code}"\\n\\s+\\);\\n\\s+return \\{ \\.\\.\\.rejected, response: attachRouteMeta\\(rejected\\.response, \\{ provider, model \\}\\) \\};`
      );
      assert.match(source, site, `${code} must return through attachRouteMeta`);
    }
    assert.equal(source.match(/attachRouteMeta\(/g)?.length, 2, "only the two guards opt in");
  });
});

describe("upstream-status-restatement", () => {
  /**
   * Gateways like agentrouter.org misstate TEMPORARY quota exhaustion as 403/400
   * (Chinese body "用户额度不足"), which Claude Code treats as permanent and dies.
   * applyStatusRestatement() rewrites such statuses to 429 (+ synthetic
   * Retry-After) in ONE place, before fallback classification and before the
   * status ever reaches the client. Registry-driven: future gateways with the
   * same defect register one rule array — no pipeline changes.
   */

  test("R1: agentrouter 403 + 用户额度不足 → 429 with synthetic Retry-After", () => {
    const out = applyStatusRestatement({
      provider: "agentrouter",
      status: 403,
      message: '{"error":{"message":"用户额度不足","type":"insufficient_user_quota"}}',
      retryAfterMs: null,
    });
    assert.equal(out.status, 429);
    assert.equal(out.fromStatus, 403);
    assert.equal(out.ruleId, "agentrouter-quota-misstatus");
    assert.equal(out.retryAfterMs, 60_000);
  });

  test("R2: agentrouter 403 + 无权访问模型 (no model access) is NOT restated", () => {
    const out = applyStatusRestatement({
      provider: "agentrouter",
      status: 403,
      message: "无权访问模型 claude-sonnet-4",
      retryAfterMs: null,
    });
    assert.equal(out.status, 403);
    assert.equal(out.ruleId, null);
  });

  test("R3: quota marker in body (not message) still restates", () => {
    const out = applyStatusRestatement({
      provider: "agentrouter",
      status: 403,
      message: "Forbidden",
      body: { error: { message: "用户额度不足，请充值" } },
      retryAfterMs: null,
    });
    assert.equal(out.status, 429);
  });

  test("R4: upstream-provided retryAfterMs wins over the synthetic default", () => {
    const out = applyStatusRestatement({
      provider: "agentrouter",
      status: 403,
      message: "用户额度不足",
      retryAfterMs: 5_000,
    });
    assert.equal(out.status, 429);
    assert.equal(out.retryAfterMs, 5_000);
  });

  test("R5: agentrouter 400 with quota marker also restates (gateway variant)", () => {
    const out = applyStatusRestatement({
      provider: "agentrouter",
      status: 400,
      message: "额度不足",
      retryAfterMs: null,
    });
    assert.equal(out.status, 429);
  });

  test("R6: agentrouter 403 without quota markers is untouched (real auth error)", () => {
    const out = applyStatusRestatement({
      provider: "agentrouter",
      status: 403,
      message: "Invalid API key",
      retryAfterMs: null,
    });
    assert.equal(out.status, 403);
    assert.equal(out.ruleId, null);
  });

  test("R7: other providers never match agentrouter rules (registry-scoped)", () => {
    const out = applyStatusRestatement({
      provider: "openai",
      status: 403,
      message: "用户额度不足",
      retryAfterMs: null,
    });
    assert.equal(out.status, 403);
  });

  test("R8: statuses a rule does not list pass through (already-correct 429)", () => {
    const out = applyStatusRestatement({
      provider: "agentrouter",
      status: 429,
      message: "用户额度不足",
      retryAfterMs: 1_000,
    });
    assert.equal(out.status, 429);
    assert.equal(out.ruleId, null);
    assert.equal(out.retryAfterMs, 1_000);
  });

  test("R9: registry exposes agentrouter so future gateways copy the one-line recipe", () => {
    const rules = statusRestatementRegistry.get("agentrouter");
    assert.ok(rules && rules.length > 0);
  });

  test("R10: chatCore wires applyStatusRestatement into the providerFailure block", async () => {
    // chatCore is a god-file that cannot be imported standalone in unit tests
    // (side-effectful DB/env wiring), so the wiring contract is asserted at the
    // source level: the hook must exist, run against the parsed error, and
    // reassign both statusCode and retryAfterMs BEFORE classification.
    // The classification helper stays in the barrel; the providerFailure block
    // moved into the streaming leg with the decomposition.
    const src = await readFile(
      new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url),
      "utf8"
    );
    const legSrc = await readFile(
      new URL("../../../open-sse/handlers/chatCore/streamingResponse.ts", import.meta.url),
      "utf8"
    );
    assert.match(
      legSrc,
      /applyStatusRestatement\(/,
      "streaming leg must call applyStatusRestatement"
    );

    const helperIndex = src.indexOf("const applyProviderFailureClassification = async (");
    const helperEnd = src.indexOf("const streamingOutcome = await runStreamingResponse(");
    assert.ok(
      helperIndex > -1 && helperEnd > helperIndex,
      "classification helper exists before streaming dispatch"
    );
    const classifyCalls = src.match(/classifyProviderError\(/g) ?? [];
    assert.equal(
      classifyCalls.length,
      1,
      "chatCore classifies provider errors in exactly one place"
    );
    const classifyIndex = src.indexOf("classifyProviderError(statusCode");
    assert.ok(
      classifyIndex > helperIndex && classifyIndex < helperEnd,
      "classifyProviderError must live inside applyProviderFailureClassification"
    );

    const blockIndex = legSrc.indexOf("providerFailure: if (!providerResponse.ok)");
    assert.ok(blockIndex > -1, "providerFailure block exists in streamingResponse.ts");
    // Cross-file form of the original `classifyIndex < blockIndex` ordering: the classification
    // helper (holding the single classifyProviderError call) must be defined before the dispatch
    // that hands it to the leaf containing the providerFailure block, and the dispatch must
    // actually pass it in.
    const dispatchIndex = src.indexOf("await runStreamingResponse({");
    assert.ok(dispatchIndex > -1, "streaming dispatch exists in chatCore.ts");
    assert.ok(
      classifyIndex < dispatchIndex,
      "classifyProviderError must be classified-before the block: helper precedes the streaming dispatch"
    );
    assert.match(
      src.slice(dispatchIndex, src.indexOf("});", dispatchIndex)),
      /\bapplyProviderFailureClassification,/,
      "streaming dispatch must pass applyProviderFailureClassification into the leaf"
    );
    assert.equal(
      legSrc.indexOf("classifyProviderError("),
      -1,
      "streaming leg does not classify directly; it delegates to applyProviderFailureClassification"
    );

    const block = legSrc.slice(blockIndex);
    const hookIndex = block.indexOf("applyStatusRestatement(");
    const statusReassign = block.indexOf("statusCode = restatement.status;");
    const retryReassign = block.indexOf("retryAfterMs = restatement.retryAfterMs;");
    const classifyCallIndex = block.indexOf("await applyProviderFailureClassification(");
    assert.ok(
      hookIndex > -1 &&
        statusReassign > hookIndex &&
        retryReassign > hookIndex &&
        classifyCallIndex > statusReassign &&
        classifyCallIndex > retryReassign,
      "restatement must reassign statusCode and retryAfterMs BEFORE the providerFailure block classifies"
    );
  });

  test("R11: the shared provider execution pipeline restates before building the error result", async () => {
    const src = await readFile(
      new URL("../../../open-sse/handlers/chatCore/providerExecutionPipeline.ts", import.meta.url),
      "utf8"
    );
    const outcomeIndex = src.indexOf("async function toOutcome(");
    assert.ok(outcomeIndex > -1, "toOutcome exists");
    const body = src.slice(outcomeIndex);
    const hookIndex = body.indexOf("applyStatusRestatement(");
    const resultIndex = body.search(/createErrorResult\(\s*restatement\.status,/);
    assert.ok(
      hookIndex > -1 && resultIndex > hookIndex,
      "the non-streaming leg must surface the restated status to classification and the client"
    );
    assert.match(
      body,
      /createErrorResult\(\s*restatement\.status,\s*message,\s*restatement\.retryAfterMs/
    );
  });
});

describe("stream-readiness-fallback", () => {
  // A stalled upstream body must not fail the request without a second
  // attempt through the same routing path: the executor loop already ended once
  // headers arrived, so the readiness gate is the only place left to retry.
  // Opt-in via STREAM_READINESS_STALL_RETRY (default off). The short readiness
  // budget (STREAM_READINESS_TIMEOUT_MS/STREAM_READINESS_MAX_TIMEOUT_MS) is set at
  // the top of this file because constants.ts reads it at module load.
  const FLAG = "STREAM_READINESS_STALL_RETRY";
  const originalFlag = process.env[FLAG];

  const originalFetch = globalThis.fetch;

  const contentChunk = (content: string) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fallback",
      object: "chat.completion.chunk",
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { role: "assistant", content } }],
    })}\n\n`;

  function goodStreamResponse(): Response {
    return new Response(contentChunk("hello") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  function closedStreamResponse(): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }

  function noopLog() {
    const warn: string[] = [];
    return {
      debug() {},
      info() {},
      error() {},
      warn: (tag: string, msg: string) => warn.push(`${tag} ${msg}`),
      warnLines: warn,
    };
  }

  function chatArgs(body: Record<string, unknown>, log: ReturnType<typeof noopLog>) {
    return {
      body: structuredClone(body),
      modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
      credentials: { apiKey: "sk-test-fallback", providerSpecificData: {} },
      log,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream" }),
      },
      userAgent: "unit-test",
    } as unknown as Parameters<typeof handleChatCore>[0];
  }

  const requestBody = {
    model: "openai/gpt-4o-mini",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  };

  before(() => {
    process.env[FLAG] = "true";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  test("a body that closes before any event retries once and serves the second body", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? closedStreamResponse() : goodStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const result = (await handleChatCore(chatArgs(requestBody, log))) as {
      success: boolean;
      response?: Response;
    };

    try {
      assert.equal(calls, 2, "expected one upstream request plus one fallback request");
      assert.equal(result.success, true);
      const text = await result.response!.text();
      assert.match(text, /hello/);
      assert.ok(
        log.warnLines.some((line) => line.includes("retrying once")),
        `expected a fallback warn line, got: ${log.warnLines.join(" | ")}`
      );
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });

  test("two stalled bodies report the second failure with its own code", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return closedStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const result = (await handleChatCore(chatArgs(requestBody, log))) as {
      success: boolean;
      status?: number;
      errorType?: string;
      errorCode?: string;
      response?: Response;
    };

    try {
      assert.equal(calls, 2, "expected exactly two upstream requests, never a loop");
      assert.equal(result.success, false);
      assert.equal(result.status, 502);
      assert.equal(result.errorType, "stream_early_eof");
      assert.equal(result.errorCode, "STREAM_EARLY_EOF");
      assert.ok(
        log.warnLines.some((line) => line.includes("retrying once")),
        `expected a fallback warn line, got: ${log.warnLines.join(" | ")}`
      );
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });

  test("a client that goes away during the first wait gets no second request", async () => {
    let calls = 0;
    let releaseFirst: ((value: Response) => void) | null = null;
    const firstGate = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const aborter = new AbortController();
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return firstGate;
      return goodStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const pending = handleChatCore({
      ...chatArgs(requestBody, log),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(requestBody),
        headers: new Headers({ accept: "text/event-stream" }),
        signal: aborter.signal,
      },
    }) as Promise<{ success: boolean; status?: number; response?: Response }>;
    await new Promise((resolve) => setTimeout(resolve, 50));
    aborter.abort();
    releaseFirst!(closedStreamResponse());

    const result = await pending;
    try {
      assert.equal(calls, 1, "no fallback request after the client went away");
      assert.equal(result.success, false);
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });

  test("with the flag off, a stalled first body issues no second request", async () => {
    const prior = process.env[FLAG];
    delete process.env[FLAG];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return closedStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const result = (await handleChatCore(chatArgs(requestBody, log))) as {
      success: boolean;
      status?: number;
      response?: Response;
    };

    try {
      assert.equal(calls, 1, "flag off: no fallback request after a stalled first body");
      assert.equal(result.success, false);
      assert.equal(result.status, 502);
    } finally {
      await result.response?.body?.cancel().catch(() => {});
      if (prior === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prior;
    }
  });

  test("a healthy first body issues no fallback request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return goodStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const result = (await handleChatCore(chatArgs(requestBody, log))) as {
      success: boolean;
      response?: Response;
    };

    try {
      assert.equal(calls, 1, "no fallback request when the first body is healthy");
      assert.equal(result.success, true);
      // Drain rather than cancel: cancelling mid-flight leaves the pipeline
      // feeding this body still in progress, and it then settles AFTER the test
      // has ended — which node:test reports as "generated asynchronous activity
      // after the test ended" and fails the whole file. The sibling fallback test
      // below already drains for the same reason.
      await result.response?.text();
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });

  test("a stalled first body never marks the account unavailable", async () => {
    let calls = 0;
    const seen: Array<{ fn: string }> = [];
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? closedStreamResponse() : goodStreamResponse();
    }) as typeof fetch;
    const log = noopLog();
    const onStreamFailure = () => {
      seen.push({ fn: "onStreamFailure" });
    };

    const result = (await handleChatCore({
      ...chatArgs(requestBody, log),
      onStreamFailure,
    })) as { success: boolean; response?: Response };

    try {
      assert.equal(result.success, true);
      assert.deepEqual(seen, [], "the stalled body must not penalize the account");
      // Drain for the same reason as above — see the comment in the healthy-body test.
      await result.response?.text();
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });

  test("a stalled first body leaves no reader behind after the fallback succeeds", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? closedStreamResponse() : goodStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const result = (await handleChatCore(chatArgs(requestBody, log))) as {
      success: boolean;
      response?: Response;
    };

    try {
      // The first body is cancelled before the second dispatch (no double-held
      // slot); the served body drains fully, proving the served stream owns the
      // only live reader.
      assert.equal(calls, 2, "expected one upstream request plus one fallback request");
      assert.equal(result.success, true);
      const text = await result.response!.text();
      assert.match(text, /hello/);
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });

  function silentStreamResponse(): Response {
    // Headers arrive, then the body stays open without a single byte: the
    // readiness gate must hit its own timeout (short test budget injected via
    // STREAM_READINESS_TIMEOUT_MS/STREAM_READINESS_MAX_TIMEOUT_MS above; the
    // 80s/180s production defaults are untouched) instead of hanging.
    return new Response(
      new ReadableStream<Uint8Array>({
        start() {},
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }

  test("a silent body hitting the readiness timeout retries once and serves the second body", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? silentStreamResponse() : goodStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const result = (await handleChatCore(chatArgs(requestBody, log))) as {
      success: boolean;
      errorType?: string;
      errorCode?: string;
      response?: Response;
    };

    try {
      // Observable at this level: exactly one fallback dispatch, then success.
      // (The per-account identity only exists inside provider-specific
      // executors; the default executor serves every dispatch from the same
      // request credentials, so account rotation itself is covered by the
      // executor-level rotation tests, not by fetch-call counting here.)
      assert.equal(calls, 2, "expected one upstream request plus one fallback request");
      assert.equal(result.success, true);
      const text = await result.response!.text();
      assert.match(text, /hello/);
      assert.ok(
        log.warnLines.some((line) => line.includes("retrying once")),
        `expected a fallback warn line, got: ${log.warnLines.join(" | ")}`
      );
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });

  test("a single-account request retries at most once and never loops", async () => {
    // With the request-scoped fetch mock there is a single credential by
    // construction: the only observable rotation signal at this level is the
    // dispatch count. Assert the bound (exactly 2), not the identity.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return closedStreamResponse();
    }) as typeof fetch;
    const log = noopLog();

    const result = (await handleChatCore(chatArgs(requestBody, log))) as {
      success: boolean;
      status?: number;
      response?: Response;
    };

    try {
      assert.equal(calls, 2, "expected exactly two upstream requests, never a loop");
      assert.equal(result.success, false);
      assert.equal(result.status, 502);
    } finally {
      await result.response?.body?.cancel().catch(() => {});
    }
  });
});
