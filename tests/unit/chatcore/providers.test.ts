// @ts-nocheck
// Merged chatCore tests for provider-specific behaviour (AgentRouter, Antigravity, Cursor, Kimi,
// OpenCode, Volcengine, Muse, Video Bridge). Each source file keeps its own describe() (named after
// the original file) so its helpers and hooks stay scoped to it. All describes share one process,
// one DATA_DIR and one Postgres database, so every describe that touches the DB starts from a
// fresh one (`before(freshDb)`) unless it already resets per test.
import { describe, test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Load-time env, set once before any app module loads.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-providers-"));
const TEST_DATA_DIR = path.join(TEST_ROOT, "data");
const TEST_PLUGINS_DIR = path.join(TEST_ROOT, "plugins");
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  OMNIROUTE_PLUGINS_DIR: process.env.OMNIROUTE_PLUGINS_DIR,
  API_KEY_SECRET: process.env.API_KEY_SECRET,
  DISABLE_SQLITE_AUTO_BACKUP: process.env.DISABLE_SQLITE_AUTO_BACKUP,
  APP_LOG_LEVEL: process.env.APP_LOG_LEVEL,
};
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.mkdirSync(TEST_PLUGINS_DIR, { recursive: true });
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_PLUGINS_DIR = TEST_PLUGINS_DIR;
process.env.API_KEY_SECRET = "video-provider-error-test-key";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_LEVEL = "error";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { createProviderConnection } = providersDb;
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const {
  museSessionScope,
  claimMuseSession,
  bindMuseGeneration,
  recordMuseOutput,
  usesMuseOAuthOwnership,
  museClaimCandidates,
} = await import("../../../src/sse/services/museSessionOwnership.ts");
const { extractReasoningIntent } = await import("../../../src/lib/reasoningRouting/policy.ts");
const { clearCache } = await import("../../../src/lib/semanticCache.ts");
const { clearIdempotency } = await import("../../../src/lib/idempotencyLayer.ts");
const { getCallLogById, getCallLogs, waitForCallLogSaves, closeCallLogSaves } =
  await import("../../../src/lib/usage/callLogs.ts");
const { closeSharedLoggerResource } = await import("../../../src/shared/utils/loggerResource.ts");
const { logClientRawRequestRedacted } =
  await import("../../../src/lib/guardrails/videoBridgeSnapshotRedaction.ts");
const accountFallback = await import("../../../open-sse/services/accountFallback.ts");
const {
  clearAllModelLockouts,
  getModelLockoutInfo,
  recordModelLockoutFailure,
  recordCoreOwnedAntigravityQuotaState,
  getProviderProfile,
  shouldDeferAntigravityQuotaStateToCaller,
  lockModel,
} = accountFallback;
const { applyComboTargetExhaustion } =
  await import("../../../open-sse/services/combo/targetExhaustion.ts");
const { classifyProviderError } = await import("../../../open-sse/services/errorClassifier.ts");
const { classify429, decide429, FULL_QUOTA_COOLDOWN_MS } =
  await import("../../../open-sse/services/antigravity429Engine.ts");
const { clearInflight } = await import("../../../open-sse/services/requestDedup.ts");
const { resetAll: resetAccountSemaphores } =
  await import("../../../open-sse/services/accountSemaphore.ts");
const { resetPayloadRulesConfigForTests } =
  await import("../../../open-sse/services/payloadRules.ts");
const { markConnectionQuotaExhausted, resolveAntigravityBodyRetryHint } =
  await import("../../../open-sse/executors/antigravity.ts");
const { CursorExecutor } = await import("../../../open-sse/executors/cursor.ts");
const { isAntigravityLiteralTierModelId, isAntigravityClaudeTierFamilyBase } =
  await import("../../../open-sse/utils/antigravityLiteralModelIds.ts");
const { shouldExposeClaudeEffortVariants } =
  await import("../../../open-sse/utils/claudeEffortVariants.ts");
const { splitKimiCodingEffortVariant } =
  await import("../../../open-sse/utils/kimiCodingEffortVariant.ts");
const { recordEarlyKeepaliveBytes, takeEarlyKeepaliveBytes } =
  await import("../../../open-sse/utils/earlyKeepaliveByteBuffer.ts");
const { FORMATS } = await import("../../../open-sse/translator/formats.ts");
const { applyClaudeEffortVariant } =
  await import("../../../open-sse/handlers/chatCore/claudeEffortVariant.ts");
const { recordAntigravityVerificationUrl, clearAntigravityVerificationUrl } =
  await import("../../../open-sse/handlers/chatCore/antigravityVerificationState.ts");
const { handleProjectRouteFailure } =
  await import("../../../open-sse/handlers/chatCore/projectRouteFailure.ts");
const { persistAttemptLogs } =
  await import("../../../open-sse/handlers/chatCore/attemptLogging.ts");
const { handleChatCore, clearUpstreamProxyConfigCache } =
  await import("../../../open-sse/handlers/chatCore.ts");

/** Each original file started on its own freshly cloned database; give each describe the same. */
async function freshDb() {
  await resetTestDb();
}

after(async () => {
  // Process-wide teardown from the cursor and video-bridge files: closing the call-log writer
  // or the shared logger is irreversible, so it runs once, after every describe.
  await waitForCallLogSaves(5000);
  await closeCallLogSaves();
  await closeSharedLoggerResource();
  await core.resetDbInstance();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("antigravity-429-quota-cooldown (#3707)", () => {
  /**
   * TDD regression tests for #3707:
   * 1. `decide429("quota_exhausted")` → `full_quota_exhausted` verdict (engine contract)
   * 2. `markConnectionQuotaExhausted` persists the 24h cooldown in the DB so that
   *    cross-request and post-restart routing skips exhausted connections.
   *
   * Bug: before the fix the executor never called `setConnectionRateLimitUntil`,
   * so `isConnectionRateLimited` always returned false for AG connections that
   * had their daily quota exhausted — learned state was lost on restart.
   */

  before(freshDb);

  after(async () => {
    clearAllModelLockouts();
    await core.resetDbInstance();
  });

  // ── Engine contract (regression guard) ───────────────────────────────────────

  test("decide429: quota_exhausted category → full_quota_exhausted kind with 24h cooldown", () => {
    const decision = decide429("quota_exhausted", null);
    assert.equal(decision.kind, "full_quota_exhausted");
    assert.equal(decision.retryAfterMs, FULL_QUOTA_COOLDOWN_MS);
    assert.equal(FULL_QUOTA_COOLDOWN_MS, 24 * 60 * 60 * 1000, "cooldown must be 24h");
  });

  test("decide429: quota_exhausted with explicit retryAfterMs preserves the provided value", () => {
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const decision = decide429("quota_exhausted", twoDaysMs);
    assert.equal(decision.kind, "full_quota_exhausted");
    assert.equal(decision.retryAfterMs, twoDaysMs);
  });

  test("classify429: AG 'Individual quota reached' message → quota_exhausted", () => {
    const msg =
      "Individual quota reached. Contact your administrator to enable overages. Resets in 14h22m.";
    assert.equal(classify429(msg), "quota_exhausted");
  });

  test("classify429: AG G1 Credits Exhausted message → quota_exhausted", () => {
    assert.equal(classify429("insufficient_g1_credits_balance"), "quota_exhausted");
  });

  test("classify429: standard Gemini rate limit 'resource has been exhausted' -> rate_limited or unknown, not quota_exhausted", () => {
    const msg =
      "RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. queries per minute limit was reached).";
    const result = classify429(msg);
    assert.notEqual(
      result,
      "quota_exhausted",
      "RESOURCE_EXHAUSTED rate limit should not be classified as quota_exhausted"
    );
  });

  test("classify429: exhausted capacity with reset after 0s is rate_limited", () => {
    const message =
      "You have exhausted your capacity on this model. Your quota will reset after 0s.";
    const category = classify429(message);
    assert.equal(category, "rate_limited");

    const decision = decide429(category, 2_000);
    assert.equal(decision.kind, "soft_retry");
    assert.equal(decision.retryAfterMs, 2_000);
  });

  // ── DB persistence (the missing wire — Bug #2) ───────────────────────────────

  test("markConnectionQuotaExhausted persists 24h cooldown; isConnectionRateLimited returns true", async () => {
    const conn = await providersDb.createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      name: "AG Test Quota",
    });
    const connId = (conn as any).id;

    assert.equal(
      await providersDb.isConnectionRateLimited(connId),
      false,
      "should start as not rate-limited"
    );

    await markConnectionQuotaExhausted(connId, FULL_QUOTA_COOLDOWN_MS);

    assert.equal(
      await providersDb.isConnectionRateLimited(connId),
      true,
      "should be rate-limited after marking quota exhausted"
    );
  });

  test("markConnectionQuotaExhausted: expired cooldown does not block the connection", async () => {
    const conn = await providersDb.createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      name: "AG Test Expired",
    });
    const connId = (conn as any).id;

    // Set cooldown in the past — simulates expired cooldown
    await providersDb.setConnectionRateLimitUntil(connId, Date.now() - 1);
    assert.equal(
      await providersDb.isConnectionRateLimited(connId),
      false,
      "expired cooldown should not block"
    );
  });

  test("direct Antigravity body prose preserves non-authoritative provenance", () => {
    const body = JSON.stringify({
      error: { message: "Individual quota reached. Resets in 131h." },
    });

    assert.deepEqual(
      resolveAntigravityBodyRetryHint(body, "Individual quota reached. Resets in 131h."),
      { retryMs: 131 * 60 * 60_000, source: "body" }
    );
  });

  test("direct Antigravity structured reset remains authoritative", () => {
    const body = JSON.stringify({
      error: {
        message: "Individual quota reached.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2h" }],
      },
    });

    assert.deepEqual(resolveAntigravityBodyRetryHint(body, "Individual quota reached."), {
      retryMs: 2 * 60 * 60_000,
      source: "google_rpc_retry_info",
    });
  });

  test("direct Antigravity has one downstream model-lock owner and clamps body prose", () => {
    const chatCoreSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../open-sse/handlers/chatCore.ts"),
      "utf8"
    );
    const eprSource = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../open-sse/handlers/chatCore/executeProviderRequest.ts"
      ),
      "utf8"
    );
    assert.match(
      chatCoreSource,
      /accountSemaphoreKey && !deferAntigravityQuotaStateToCaller/,
      "chatCore must not apply a prose-derived Antigravity semaphore TTL"
    );
    assert.match(
      eprSource,
      /Dropped generic quota cache after 429/,
      "non-Codex 429 must leave a QUOTA debug breadcrumb"
    );
    assert.match(
      chatCoreSource,
      /if \(deferAntigravityQuotaStateToCaller\)[\s\S]{0,2000}else if \(kimiRateLimitResetAt\)/
    );
    assert.doesNotMatch(chatCoreSource, /lockExactModel/);

    clearAllModelLockouts();
    const maxCooldownMs = 30 * 60_000;
    recordModelLockoutFailure(
      "antigravity",
      "direct-connection",
      "direct-model",
      "quota_exhausted",
      429,
      3_000,
      null,
      {
        exactCooldownMs: 131 * 60 * 60_000,
        maxCooldownMs,
        scope: "exact",
        exactCooldownIsUpstreamReset: false,
      }
    );
    const info = getModelLockoutInfo("antigravity", "direct-connection", "direct-model");
    assert.ok(info);
    assert.equal(info.failureCount, 1);
    assert.ok(info.remainingMs > maxCooldownMs - 5_000 && info.remainingMs <= maxCooldownMs);
  });

  test("Antigravity quota state is deferred only when a caller owner exists", () => {
    assert.equal(shouldDeferAntigravityQuotaStateToCaller("antigravity", true), true);
    assert.equal(shouldDeferAntigravityQuotaStateToCaller("agy", true), true);
    assert.equal(shouldDeferAntigravityQuotaStateToCaller("antigravity", false), false);
    assert.equal(shouldDeferAntigravityQuotaStateToCaller("agy", false), false);
    assert.equal(shouldDeferAntigravityQuotaStateToCaller("gemini", true), false);
  });

  test("core-owned Antigravity quota state applies the same provenance-aware cap", async () => {
    clearAllModelLockouts();
    const maxCooldownMs = 30 * 60_000;
    const profile = { ...getProviderProfile("antigravity"), maxCooldownMs };
    const bodyResult = await recordCoreOwnedAntigravityQuotaState({
      provider: "agy",
      connectionId: "responses-body",
      model: "direct-model",
      status: 429,
      errorText: "Individual quota reached. Resets in 131h.",
      headers: null,
      profileOverride: profile,
    });
    assert.equal(bodyResult.failureCount, 1);
    assert.ok(
      bodyResult.cooldownMs > maxCooldownMs - 5_000 && bodyResult.cooldownMs <= maxCooldownMs
    );

    const headerResult = await recordCoreOwnedAntigravityQuotaState({
      provider: "antigravity",
      connectionId: "responses-header",
      model: "direct-model",
      status: 429,
      errorText: "Individual quota reached.",
      headers: new Headers({ "Retry-After": "7200" }),
      profileOverride: profile,
    });
    assert.equal(headerResult.failureCount, 1);
    assert.ok(headerResult.cooldownMs > 2 * 60 * 60_000 - 5_000);
  });
});

describe("antigravity-claude-5-tier-ids", () => {
  // Antigravity serves Claude 5.x with one upstream model id PER TIER
  // (`claude-opus-5-5-low|medium|high`, same for Sonnet 5.5) — there is no bare
  // `claude-opus-5-5` on the Cloud Code backend. applyClaudeEffortVariant used to strip
  // the tier (`claude-opus-5-5-high` → `claude-opus-5-5` + reasoning_effort=high) because
  // the base prefix-matches the `claude-opus-5` spec, so every Claude 5.5 request reached
  // Antigravity with a non-existent id and failed (429 "Resource has been exhausted" on
  // every account). Locks:
  //   1. isAntigravityLiteralTierModelId recognizes only Antigravity surfaces + tiered
  //      Claude 5.x ids;
  //   2. applyClaudeEffortVariant keeps those ids literal (no body mutation);
  //   3. end-to-end through handleChatCore the upstream request carries the tiered id.
  const TIERED_IDS = [
    "claude-opus-5-5-low",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-high",
    "claude-sonnet-5-5-low",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-high",
  ];

  test("isAntigravityLiteralTierModelId: Antigravity surfaces + tiered Claude 5.x only", () => {
    for (const provider of ["antigravity", "ag", "agy", "antigravity/claude-opus-5-5-high"]) {
      for (const model of TIERED_IDS) {
        assert.equal(
          isAntigravityLiteralTierModelId(provider, model),
          true,
          `${provider} ${model}`
        );
        assert.equal(
          isAntigravityLiteralTierModelId(provider, `antigravity/${model}`),
          true,
          `${provider} antigravity/${model}`
        );
      }
    }
    // Not tiered upstream, or not a tier suffix Antigravity serves.
    for (const model of [
      "claude-opus-5-5",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-high",
      "claude-opus-5-5-xhigh",
      "gemini-3.8-flash-high",
      "",
    ]) {
      assert.equal(isAntigravityLiteralTierModelId("antigravity", model), false, model);
    }
    // Same ids on other providers are client-side effort variants.
    for (const provider of ["claude", "cc", "vertex", "cursor", "", null, undefined]) {
      assert.equal(
        isAntigravityLiteralTierModelId(
          provider as string | null | undefined,
          "claude-opus-5-5-high"
        ),
        false,
        String(provider)
      );
    }
  });

  for (const provider of ["antigravity", "agy"]) {
    for (const sourceFormat of [FORMATS.OPENAI, FORMATS.CLAUDE]) {
      test(`${provider}/${sourceFormat}: applyClaudeEffortVariant keeps tiered Claude 5.x ids literal`, () => {
        for (const model of TIERED_IDS) {
          const body = { model, messages: [] };
          const result = applyClaudeEffortVariant({
            provider,
            effectiveModel: model,
            body,
            sourceFormat,
          });
          assert.deepEqual(result, { effectiveModel: model, log: null });
          assert.deepEqual(body, { model, messages: [] }, "body must not gain reasoning_effort");
        }
      });
    }
  }

  test("other providers still strip the Claude 5.5 effort suffix", () => {
    const body: Record<string, unknown> = { model: "claude-opus-5-5-high", messages: [] };
    const result = applyClaudeEffortVariant({
      provider: "claude",
      effectiveModel: "claude-opus-5-5-high",
      body,
      sourceFormat: FORMATS.OPENAI,
    });
    assert.equal(result.effectiveModel, "claude-opus-5-5");
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.reasoning_effort, "high");
  });

  test("catalog never synthesizes effort variants on an Antigravity Claude 5.x base id", () => {
    for (const prefix of ["antigravity", "ag", "agy"]) {
      for (const base of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
        const id = `${prefix}/${base}`;
        assert.equal(isAntigravityClaudeTierFamilyBase(id), true, id);
        assert.equal(shouldExposeClaudeEffortVariants({ id, owned_by: prefix }), false, id);
      }
    }
    // Tier ids, bare ids, older generations and other providers are not matched.
    for (const id of [
      "antigravity/claude-opus-5-5-high",
      "antigravity/claude-sonnet-4-6",
      "antigravity/gemini-3.8-flash",
      "claude-opus-5-5",
      "claude/claude-opus-5-5",
    ]) {
      assert.equal(isAntigravityClaudeTierFamilyBase(id), false, id);
    }
    // Direct Claude keeps its synthesized variants.
    assert.equal(
      shouldExposeClaudeEffortVariants({ id: "claude/claude-opus-5-5", owned_by: "claude" }),
      true
    );
  });

  // ── End to end: handleChatCore → antigravity executor → upstream fetch ──────────

  const originalFetch = globalThis.fetch;
  const upstreamModels: string[] = [];

  function sseResponse(): Response {
    const chunk = {
      response: {
        candidates: [
          { content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
        modelVersion: "claude",
      },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  before(freshDb);

  before(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.includes(":streamGenerateContent") || url.includes(":generateContent")) {
        const raw = typeof init?.body === "string" ? init.body : "";
        try {
          upstreamModels.push(String(JSON.parse(raw).model));
        } catch {
          upstreamModels.push("<unparsed>");
        }
        return sseResponse();
      }
      // Version feeds, discovery, telemetry: answer harmlessly.
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    core.resetDbInstance();
  });

  for (const model of ["claude-opus-5-5-high", "claude-sonnet-5-5-medium"]) {
    test(`handleChatCore dispatches antigravity/${model} upstream verbatim`, async () => {
      upstreamModels.length = 0;
      const body = {
        model: `antigravity/${model}`,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        stream: false,
      };
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider: "antigravity", model, extendedContext: false },
        credentials: {
          accessToken: "ya29.test-token",
          projectId: "test-project",
          providerSpecificData: { projectId: "test-project" },
        },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
        log: { debug() {}, info() {}, warn() {}, error() {} },
      } as never);
      assert.ok(
        upstreamModels.length > 0,
        `no upstream call captured (result: ${JSON.stringify(result).slice(0, 300)})`
      );
      assert.deepEqual([...new Set(upstreamModels)], [model]);
    });
  }
});

describe("antigravity-verification-url-persist", () => {
  // A `403 VALIDATION_REQUIRED` on an Antigravity connection must persist the
  // Google verification link on the connection (so the dashboard can show a
  // Verify button) without banning it, and a later success must clear the link.
  const URL_A = "https://accounts.google.com/signin/continue?sarp=1&id=ag-1";
  const VALIDATION_BODY = {
    error: {
      code: 403,
      message: "Verify your account to continue.",
      status: "PERMISSION_DENIED",
      details: [{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: URL_A } }],
    },
  };

  before(freshDb);

  after(() => {
    core.resetDbInstance();
  });

  async function makeConn(provider = "antigravity") {
    core.resetDbInstance();
    const conn = (await providersDb.createProviderConnection({
      provider,
      authType: "oauth",
      accessToken: "token",
      email: `${provider}@example.com`,
      isActive: true,
      testStatus: "active",
      providerSpecificData: { projectId: "proj-1" },
    })) as { id: string };
    return conn.id;
  }

  async function readPsd(id: string) {
    const row = (await providersDb.getProviderConnectionById(id)) as {
      testStatus?: string;
      isActive?: boolean;
      providerSpecificData?: Record<string, unknown>;
    };
    return row;
  }

  test("records the verification link for antigravity without touching other psd keys", async () => {
    const id = await makeConn();
    const url = await recordAntigravityVerificationUrl({
      provider: "antigravity",
      connectionId: id,
      upstreamErrorBody: VALIDATION_BODY,
      message: "Verify your account to continue.",
    });
    assert.equal(url, URL_A);

    const row = await readPsd(id);
    assert.equal(row.providerSpecificData?.verificationUrl, URL_A);
    assert.equal(typeof row.providerSpecificData?.verificationAt, "string");
    assert.equal(row.providerSpecificData?.projectId, "proj-1");
    assert.notEqual(row.testStatus, "banned");
    assert.notEqual(row.isActive, false);
  });

  test("ignores other providers and bodies without a valid Google link", async () => {
    const id = await makeConn("gemini-cli");
    assert.equal(
      await recordAntigravityVerificationUrl({
        provider: "gemini-cli",
        connectionId: id,
        upstreamErrorBody: VALIDATION_BODY,
        message: "",
      }),
      null
    );
    assert.equal((await readPsd(id)).providerSpecificData?.verificationUrl, undefined);

    const agId = await makeConn();
    assert.equal(
      await recordAntigravityVerificationUrl({
        provider: "antigravity",
        connectionId: agId,
        upstreamErrorBody: { error: { message: "Verify your account at https://evil.com/x" } },
        message: "Verify your account at https://evil.com/x",
      }),
      null
    );
    assert.equal((await readPsd(agId)).providerSpecificData?.verificationUrl, undefined);
  });

  test("falls back to the message text when the body has no structured link", async () => {
    const id = await makeConn();
    const url = await recordAntigravityVerificationUrl({
      provider: "antigravity",
      connectionId: id,
      upstreamErrorBody: null,
      message: `Verify your account to continue: ${URL_A}`,
    });
    assert.equal(url, URL_A);
  });

  test("a later success clears the link and keeps the rest of providerSpecificData", async () => {
    const id = await makeConn();
    await recordAntigravityVerificationUrl({
      provider: "antigravity",
      connectionId: id,
      upstreamErrorBody: VALIDATION_BODY,
      message: "",
    });
    const before = await readPsd(id);

    assert.equal(
      await clearAntigravityVerificationUrl("antigravity", id, before.providerSpecificData),
      true
    );
    const after = await readPsd(id);
    assert.equal(after.providerSpecificData?.verificationUrl, undefined);
    assert.equal(after.providerSpecificData?.verificationAt, undefined);
    assert.equal(after.providerSpecificData?.projectId, "proj-1");

    // No stored link -> no write.
    assert.equal(
      await clearAntigravityVerificationUrl("antigravity", id, after.providerSpecificData),
      false
    );
    assert.equal(
      await clearAntigravityVerificationUrl("gemini-cli", id, { verificationUrl: URL_A }),
      false
    );
  });

  test("PROJECT_ROUTE_ERROR leaf records the link and the error, never bans", async () => {
    const id = await makeConn();
    await handleProjectRouteFailure({
      provider: "antigravity",
      connectionId: id,
      statusCode: 403,
      persistentMessage: "Verify your account to continue.",
      message: "Verify your account to continue.",
      upstreamErrorBody: VALIDATION_BODY,
      targetModel: "gemini-3-pro",
    });

    const row = (await readPsd(id)) as Awaited<ReturnType<typeof readPsd>> & {
      lastErrorType?: string;
      errorCode?: number | string;
    };
    assert.equal(row.providerSpecificData?.verificationUrl, URL_A);
    assert.equal(row.lastErrorType, "project_route_error");
    assert.equal(Number(row.errorCode), 403);
    assert.notEqual(row.testStatus, "banned");
    assert.notEqual(row.isActive, false);
  });

  test("wiring: chatCore records on PROJECT_ROUTE_ERROR, chat success path clears", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const chatCore = fs.readFileSync(path.join(root, "open-sse/handlers/chatCore.ts"), "utf8");
    const branchStart = chatCore.indexOf("errorType === PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR");
    assert.ok(branchStart > 0, "PROJECT_ROUTE_ERROR branch not found in chatCore.ts");
    const branchEnd = chatCore.indexOf("} else if (", branchStart);
    // chatCore delegates the branch to the leaf and must hand it the upstream body.
    assert.match(
      chatCore.slice(branchStart, branchEnd),
      /handleProjectRouteFailure\(\{[\s\S]*upstreamErrorBody/
    );
    const leaf = fs.readFileSync(
      path.join(root, "open-sse/handlers/chatCore/projectRouteFailure.ts"),
      "utf8"
    );
    assert.match(leaf, /recordAntigravityVerificationUrl\(\{[\s\S]*upstreamErrorBody/);

    const helpers = fs.readFileSync(path.join(root, "src/sse/handlers/chatHelpers.ts"), "utf8");
    const successStart = helpers.indexOf("onRequestSuccess: async () => {");
    assert.ok(successStart > 0, "onRequestSuccess not found in chatHelpers.ts");
    const successEnd = helpers.indexOf("onStreamFailure:", successStart);
    assert.match(
      helpers.slice(successStart, successEnd),
      /clearAntigravityVerificationUrl\(\s*provider,\s*credentials\.connectionId,\s*credentials\.providerSpecificData/
    );
  });
});

describe("agentrouter-lock-scope-10334 (#10334)", () => {
  // #10334 — agentrouter EXCLUSIVE: markAccountUnavailable must honor the
  // provider rule's declared lock scope instead of always deriving it from
  // hasPerModelQuota(). agentrouter is a passthroughModels provider, so a
  // naive account-wide quota exhaustion ("额度不足") would otherwise be treated
  // as a per-model 429 and lock only ONE model, leaving combo routing to burn
  // one upstream call per remaining model of the same exhausted account. This
  // suite pins the connection-scoped cooldown behavior AND its invariants:
  // never a terminal status, must also win when the caller is combo (isCombo),
  // must not lock the model, and must be EXCLUSIVE to agentrouter — every other
  // passthroughModels/compatible provider keeps today's per-model lockout.
  const QUOTA_EXHAUSTED_429 = '{"error":{"message":"账户额度不足，请充值后重试"}}';
  const MODEL_ACCESS_DENIED_403 = '{"error":{"message":"无权访问模型 claude-opus-5"}}';

  async function resetStorage() {
    await core.resetDbInstance();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  async function seedConnection(
    provider: string,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const conn = await providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      apiKey: `${provider}-key`,
      isActive: true,
      testStatus: "active",
      ...overrides,
    });
    return (conn as Record<string, unknown>).id as string;
  }

  after(() => {
    core.resetDbInstance();
  });

  test("agentrouter 429 account quota exhausted -> connection cooldown, never terminal", async () => {
    await resetStorage();
    const connId = await seedConnection("agentrouter");

    const result = await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "agentrouter",
      "claude-opus-5"
    );

    assert.equal(result.shouldFallback, true);
    assert.ok(result.cooldownMs > 0, "connection cooldown must be positive");

    const after = await providersDb.getProviderConnectionById(connId);
    assert.equal(after.testStatus, "unavailable");
    assert.notEqual(after.testStatus, "credits_exhausted");
    assert.ok(after.rateLimitedUntil, "connection must carry a rateLimitedUntil");
    assert.ok(
      new Date(String(after.rateLimitedUntil)).getTime() > Date.now(),
      "rateLimitedUntil must be in the future"
    );
  });

  test("agentrouter 429 quota exhausted with isCombo: true still cools the connection (not a model lock)", async () => {
    await resetStorage();
    const connId = await seedConnection("agentrouter");

    const result = await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "agentrouter",
      "claude-opus-5",
      null,
      { isCombo: true, persistUnavailableState: false }
    );

    assert.equal(result.shouldFallback, true);
    assert.ok(result.cooldownMs > 0);

    const after = await providersDb.getProviderConnectionById(connId);
    assert.equal(after.testStatus, "unavailable");
    assert.notEqual(after.testStatus, "credits_exhausted");
    assert.ok(after.rateLimitedUntil, "connection must be cooled down even for combo callers");
  });

  test("agentrouter quota cooldown does NOT lock the model", async () => {
    await resetStorage();
    const connId = await seedConnection("agentrouter");

    await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "agentrouter",
      "claude-opus-5"
    );

    const lockout = accountFallback.getModelLockoutInfo("agentrouter", connId, "claude-opus-5");
    assert.equal(lockout, null, "connection-scoped quota must not also record a model lockout");
  });

  test("agentrouter 403 model-access-denied -> model lockout, connection stays active", async () => {
    await resetStorage();
    const connId = await seedConnection("agentrouter");

    const result = await auth.markAccountUnavailable(
      connId,
      403,
      MODEL_ACCESS_DENIED_403,
      "agentrouter",
      "claude-opus-5"
    );

    assert.equal(result.shouldFallback, true);

    const after = await providersDb.getProviderConnectionById(connId);
    assert.equal(after.testStatus, "active");
    assert.ok(
      !after.rateLimitedUntil,
      "connection must not be rate-limited by a model-scoped rule"
    );

    // #3027's existing per-model-quota-provider branch handles this 403 (it is
    // unmodified by #10334 except that it now reads the rule's declared
    // cooldown via fallbackResult.baseCooldownMs) — the recorded reason stays
    // the pre-existing hardcoded "forbidden", not the rule's "auth_error".
    const lockout = accountFallback.getModelLockoutInfo("agentrouter", connId, "claude-opus-5");
    assert.equal(lockout?.reason, "forbidden");
    // The 6h base cooldown declared by the "agentrouter-model-access-denied"
    // rule (open-sse/config/providerErrorRules.ts) must flow through as
    // fallbackResult.baseCooldownMs instead of the generic
    // COOLDOWN_MS.serviceUnavailable (2s) default — it then gets clamped down
    // to the model-lockout maxCooldownMs setting (default 1_800_000ms / 30min)
    // by recordModelLockoutFailure, same as every other model lockout. What
    // this pins is that the rule's cooldown was consulted at all: a plain 2s
    // default would be immediately visible as a tiny remainingMs, not ~max.
    assert.ok(
      lockout && lockout.remainingMs > 1_700_000,
      `expected the rule cooldown to be clamped to ~maxCooldownMs (1_800_000ms), got ${lockout?.remainingMs}ms`
    );
  });

  test("exclusivity: ollama-cloud with an equivalent account-wide-looking 429 keeps today's per-model lockout, no connection cooldown", async () => {
    await resetStorage();
    const connId = await seedConnection("ollama-cloud");

    const result = await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "ollama-cloud",
      "claude-opus-5"
    );

    assert.equal(result.shouldFallback, true);

    const after = await providersDb.getProviderConnectionById(connId);
    // ollama-cloud is NOT in the honorsRuleLockScope allowlist: today's
    // per-model-quota behavior for a 429 must be unchanged — connection stays
    // active, no rateLimitedUntil.
    assert.equal(after.testStatus, "active");
    assert.ok(
      !after.rateLimitedUntil,
      "non-agentrouter providers must not gain connection cooldown"
    );

    // Positive assertion, not just the negative: the model lockout must have
    // actually been recorded. Without this, a future refactor that stops
    // locking anything for these providers would pass this test silently.
    const lockout = accountFallback.getModelLockoutInfo("ollama-cloud", connId, "claude-opus-5");
    assert.ok(lockout, "expected the pre-existing per-model lockout to be recorded");
  });

  test("exclusivity: vertex with an equivalent account-wide-looking 429 keeps today's per-model lockout, no connection cooldown", async () => {
    await resetStorage();
    const connId = await seedConnection("vertex");

    const result = await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "vertex",
      "claude-opus-5"
    );

    assert.equal(result.shouldFallback, true);

    const after = await providersDb.getProviderConnectionById(connId);
    assert.equal(after.testStatus, "active");
    assert.ok(
      !after.rateLimitedUntil,
      "non-agentrouter providers must not gain connection cooldown"
    );

    // Positive assertion, not just the negative — see the ollama-cloud case above.
    const lockout = accountFallback.getModelLockoutInfo("vertex", connId, "claude-opus-5");
    assert.ok(lockout, "expected the pre-existing per-model lockout to be recorded");
  });

  // ─── Fix round 1 (#10334 review) ───────────────────────────────────────────

  // Important finding: the "never terminal" invariant is not structurally
  // guaranteed by `ruleScope === "connection"` alone — it depends on the
  // provider rule table only ever pairing scope "connection" with a genuinely
  // transient reason. isAgentrouterConnectionQuotaScope() is the actual guard;
  // pin its predicate directly with synthetic fallbackResult shapes, since no
  // rule in the current table produces a permanent/credits-exhausted result
  // with scope "connection" (exercising it end-to-end would require editing
  // the production rule table just for a test).
  test("isAgentrouterConnectionQuotaScope: rejects a permanent rule result even with scope connection", () => {
    const permanentConnectionScopeResult = {
      ruleScope: "connection" as const,
      reason: "auth_error",
      permanent: true,
    };
    assert.equal(
      auth.isAgentrouterConnectionQuotaScope("agentrouter", permanentConnectionScopeResult),
      false,
      "a future permanent-state rule with scope connection must NOT take the transient-cooldown branch"
    );
  });

  test("isAgentrouterConnectionQuotaScope: rejects a credits-exhausted rule result even with scope connection", () => {
    const creditsExhaustedConnectionScopeResult = {
      ruleScope: "connection" as const,
      reason: "quota_exhausted",
      creditsExhausted: true,
    };
    assert.equal(
      auth.isAgentrouterConnectionQuotaScope("agentrouter", creditsExhaustedConnectionScopeResult),
      false,
      "a future credits-exhausted rule with scope connection must NOT take the transient-cooldown branch"
    );
  });

  test("isAgentrouterConnectionQuotaScope: accepts the real quota-exhausted/connection shape", () => {
    const quotaConnectionScopeResult = {
      ruleScope: "connection" as const,
      reason: "quota_exhausted",
    };
    assert.equal(
      auth.isAgentrouterConnectionQuotaScope("agentrouter", quotaConnectionScopeResult),
      true,
      "today's only connection-scope rule result (quota_exhausted, no permanent/creditsExhausted) must pass"
    );
  });

  test("isAgentrouterConnectionQuotaScope: rejects non-agentrouter providers regardless of shape", () => {
    const quotaConnectionScopeResult = {
      ruleScope: "connection" as const,
      reason: "quota_exhausted",
    };
    assert.equal(
      auth.isAgentrouterConnectionQuotaScope("ollama-cloud", quotaConnectionScopeResult),
      false,
      "honorsRuleLockScope must still gate every provider outside the agentrouter allowlist"
    );
  });

  // Minor finding: guard the branch's POSITION in markAccountUnavailable. If a
  // future refactor moved the branch above the terminal-status guard (~line
  // 2023) or the anti-thundering-herd guard (~line 2038), a credits_exhausted
  // connection would be silently overwritten, or a live cooldown would be
  // shortened — and the 6 tests above would stay green because none of them
  // seed a connection with pre-existing terminal/cooldown state.
  test("position guard: a connection already credits_exhausted stays terminal through an agentrouter quota 429", async () => {
    await resetStorage();
    const connId = await seedConnection("agentrouter", { testStatus: "credits_exhausted" });

    const result = await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "agentrouter",
      "claude-opus-5"
    );

    assert.equal(result.shouldFallback, true);
    assert.equal(result.cooldownMs, 0, "terminal-status short-circuit returns cooldownMs 0");

    const after = await providersDb.getProviderConnectionById(connId);
    assert.equal(
      after.testStatus,
      "credits_exhausted",
      "the connection-scope branch must never overwrite a pre-existing terminal status"
    );
  });

  test("position guard: an existing live cooldown is not shortened by the connection-scope branch", async () => {
    await resetStorage();
    const futureCooldown = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const connId = await seedConnection("agentrouter", {
      testStatus: "unavailable",
      rateLimitedUntil: futureCooldown,
    });

    const result = await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "agentrouter",
      "claude-opus-5"
    );

    assert.equal(result.shouldFallback, true);

    const after = await providersDb.getProviderConnectionById(connId);
    assert.equal(
      after.rateLimitedUntil,
      futureCooldown,
      "the anti-thundering-herd guard must win: an existing live cooldown must not be reset/shortened"
    );
  });

  // Minor finding: disableCooling=true skips the connection-scope branch (the
  // `!disableCooling` condition), so the #10334 bug survives for connections
  // with that opt-out — they fall into the ~30min per-model lockout instead of
  // the shorter connection cooldown. Documented in the block comment above the
  // branch; pin the behavior so a future change to the guard is deliberate.
  test("disableCooling=true skips the connection-scope branch and falls back to per-model lockout", async () => {
    await resetStorage();
    const connId = await seedConnection("agentrouter", {
      providerSpecificData: { disableCooling: true },
    });

    const result = await auth.markAccountUnavailable(
      connId,
      429,
      QUOTA_EXHAUSTED_429,
      "agentrouter",
      "claude-opus-5"
    );

    assert.equal(result.shouldFallback, true);

    const after = await providersDb.getProviderConnectionById(connId);
    // Connection is NOT cooled down — disableCooling's documented CONNECTION-
    // level opt-out (#2997) is honored.
    assert.equal(after.testStatus, "active");
    assert.ok(!after.rateLimitedUntil, "disableCooling must keep the connection selectable");

    // But the model IS locked out instead (the #10334 bug's exact symptom for
    // disableCooling connections — a deliberate, documented trade-off).
    const lockout = accountFallback.getModelLockoutInfo("agentrouter", connId, "claude-opus-5");
    assert.ok(
      lockout,
      "expected a per-model lockout when disableCooling bypasses the connection branch"
    );
  });

  // ─── Task 3 (#10334): combo skips the exhausted agentrouter connection
  // WITHIN THE SAME REQUEST ──────────────────────────────────────────────────
  // The tests above pin markAccountUnavailable's PERSISTED connection cooldown
  // — that only protects the NEXT request. applyComboTargetExhaustion (the
  // #1731/#1731v2 shared classifier both combo dispatchers call after every
  // target's upstream error — open-sse/services/combo/targetExhaustion.ts) is
  // what decides whether remaining targets of the CURRENT request are skipped.
  // Without a matching gate there, a combo with 5 legs on the same exhausted
  // agentrouter account would still burn all 5 upstream calls before the
  // persisted cooldown from the tests above ever kicks in.

  function comboSets() {
    return {
      exhaustedProviders: new Set<string>(),
      exhaustedConnections: new Set<string>(),
      transientRateLimitedProviders: new Set<string>(),
    };
  }

  function comboTarget(overrides: Record<string, unknown> = {}) {
    return {
      kind: "model",
      executionKey: "ek",
      modelStr: "agentrouter/claude-opus-5",
      provider: "agentrouter",
      providerId: null,
      connectionId: "conn-agentrouter-1",
      ...overrides,
    } as Parameters<typeof applyComboTargetExhaustion>[0];
  }

  const comboLog = { info() {}, warn() {}, error() {}, debug() {} };

  const comboBaseOpts = {
    errorText: QUOTA_EXHAUSTED_429,
    rawModel: "claude-opus-5",
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    requestScopedFailure: false,
    log: comboLog,
    tag: "COMBO",
    exhaustedLogLevel: "info" as const,
  };

  // The real shape checkFallbackError surfaces for agentrouter's restated 429
  // (open-sse/config/providerErrorRules.ts's "agentrouter-user-quota-exhausted"
  // rule: reason "quota_exhausted", scope "connection") — same shape pinned by
  // isAgentrouterConnectionQuotaScope's own tests above.
  const CONNECTION_SCOPE_FALLBACK_RESULT = {
    ruleScope: "connection" as const,
    reason: "quota_exhausted",
  };

  test("combo in-request skip: agentrouter connection-scope quota marks exhaustedConnections (#10334)", () => {
    const sets = comboSets();
    const { providerExhausted: exhausted } = applyComboTargetExhaustion(comboTarget(), {
      ...comboBaseOpts,
      result: { status: 429 },
      fallbackResult: CONNECTION_SCOPE_FALLBACK_RESULT,
      sets,
    });
    assert.equal(
      exhausted,
      true,
      "combo must treat this like an exhausted target — no same-target retry"
    );
    assert.ok(
      sets.exhaustedConnections.has("agentrouter:conn-agentrouter-1"),
      "the exhausted account's connection must be marked so remaining same-connection targets are skipped this request"
    );
    assert.equal(
      sets.exhaustedProviders.size,
      0,
      "must NOT exhaust the whole provider — sibling agentrouter connections keep their own quota"
    );
    // Important finding (review round 1): unlike markConnectionLevelExhaustion's
    // path, this branch must NEVER populate transientRateLimitedProviders. That
    // set drives combo.ts's `allowRateLimitedConnection` force-allow
    // (open-sse/services/combo.ts:1005-1013 and :2734-2738), which bypasses the
    // `rateLimitedUntil` filter in credential selection (src/sse/services/auth.ts:1238)
    // for the provider's remaining legs this request. Marking it here would
    // silently re-open the very connection Task 2's markAccountUnavailable (and
    // this branch) just cooled down.
    assert.equal(
      sets.transientRateLimitedProviders.size,
      0,
      "must NOT mark transientRateLimitedProviders — that would force-allow reusing the connection this branch just exhausted"
    );
  });

  test("combo in-request skip: no connectionId falls back to whole-provider exhaustion", () => {
    const sets = comboSets();
    const { providerExhausted: exhausted } = applyComboTargetExhaustion(
      comboTarget({ connectionId: null }),
      {
        ...comboBaseOpts,
        result: { status: 429 },
        fallbackResult: CONNECTION_SCOPE_FALLBACK_RESULT,
        sets,
      }
    );
    assert.equal(exhausted, true);
    assert.ok(
      sets.exhaustedProviders.has("agentrouter"),
      "no connectionId to scope to — must fall back to whole-provider, mirroring markAuthLevelExhaustion"
    );
    assert.equal(sets.exhaustedConnections.size, 0);
  });

  test("exclusivity: an equivalent connection-scope-shaped result for ollama-cloud marks nothing (#10334 is agentrouter-only)", () => {
    const sets = comboSets();
    // Synthetic: production never actually produces ruleScope for a
    // non-allowlisted provider (honorsRuleLockScope gates it upstream inside
    // checkFallbackError) — feeding it here directly proves
    // applyComboTargetExhaustion ALSO re-checks the provider via
    // isAgentrouterConnectionQuotaScope rather than trusting whatever shape
    // it is handed.
    const { providerExhausted: exhausted } = applyComboTargetExhaustion(
      comboTarget({ provider: "ollama-cloud", connectionId: "conn-ollama-1" }),
      {
        ...comboBaseOpts,
        result: { status: 429 },
        fallbackResult: CONNECTION_SCOPE_FALLBACK_RESULT,
        sets,
      }
    );
    assert.equal(
      exhausted,
      false,
      "ollama-cloud must fall through to today's per-model-quota behavior unchanged"
    );
    assert.equal(sets.exhaustedConnections.size, 0);
    assert.equal(sets.exhaustedProviders.size, 0);
  });

  test("exclusivity: vertex with the same synthetic connection-scope result marks nothing", () => {
    const sets = comboSets();
    const { providerExhausted: exhausted } = applyComboTargetExhaustion(
      comboTarget({ provider: "vertex", connectionId: "conn-vertex-1" }),
      {
        ...comboBaseOpts,
        result: { status: 429 },
        fallbackResult: CONNECTION_SCOPE_FALLBACK_RESULT,
        sets,
      }
    );
    assert.equal(exhausted, false);
    assert.equal(sets.exhaustedConnections.size, 0);
    assert.equal(sets.exhaustedProviders.size, 0);
  });

  test("guard: a permanent agentrouter fallbackResult with scope connection does NOT mark the connection exhausted here either", () => {
    const sets = comboSets();
    const { providerExhausted: exhausted } = applyComboTargetExhaustion(comboTarget(), {
      ...comboBaseOpts,
      result: { status: 429 },
      fallbackResult: { ruleScope: "connection" as const, reason: "auth_error", permanent: true },
      sets,
    });
    assert.equal(exhausted, false);
    assert.equal(sets.exhaustedConnections.has("agentrouter:conn-agentrouter-1"), false);
    assert.equal(sets.exhaustedProviders.size, 0);
  });

  test("guard: a credits-exhausted agentrouter fallbackResult with scope connection does NOT mark the connection exhausted here either", () => {
    const sets = comboSets();
    const { providerExhausted: exhausted } = applyComboTargetExhaustion(comboTarget(), {
      ...comboBaseOpts,
      result: { status: 429 },
      fallbackResult: {
        ruleScope: "connection" as const,
        reason: "quota_exhausted",
        creditsExhausted: true,
      },
      sets,
    });
    assert.equal(exhausted, false);
    assert.equal(sets.exhaustedConnections.has("agentrouter:conn-agentrouter-1"), false);
    assert.equal(sets.exhaustedProviders.size, 0);
  });

  // Minor finding (review round 1): the connection-scope branch is NOT
  // 429-only. The "额度不足" rule (buildAgentrouterRules, providerErrorRules.ts)
  // matches statuses {400, 403, 429}, and Task 1's FORBIDDEN pre-check
  // (accountFallback.ts ~1729-1751, gated on honorsRuleLockScope) surfaces
  // `ruleScope: "connection"` for a RAW 403 carrying that body too — before the
  // generic apikey FORBIDDEN early-return, and before markAuthLevelExhaustion
  // below ever sees it. Pin that a raw 403 with this shape takes the SAME
  // connection-scope branch (not markAuthLevelExhaustion) and lands in the SAME
  // set with the SAME key — the two paths are set-equivalent for agentrouter on
  // this status, so this is not a behavior change, just documenting which
  // branch actually runs.
  //
  // Fix round 2 finding: the Set-content assertions alone (exhausted===true,
  // the connection key present, the other two sets empty) do NOT discriminate
  // which branch ran — markAuthLevelExhaustion (the 401/403 branch below)
  // produces the byte-identical Set effects for a 403 with a connectionId (same
  // key, same untouched sibling sets, same `true` return), so deleting the new
  // branch entirely would leave this test green. Use a log spy — the one real
  // observable difference between the two paths — to prove the NEW branch
  // actually fired: its message is tagged `#10334` / "account quota exhausted"
  // (markAgentrouterConnectionQuotaExhaustion), never `#8133` / "auth failure"
  // (markAuthLevelExhaustion).
  function makeLogSpy() {
    const calls: { level: string; tag: string; message: string }[] = [];
    const record = (level: string) => (tag: string, message: string) => {
      calls.push({ level, tag, message });
    };
    return {
      calls,
      log: {
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
        debug: record("debug"),
      },
    };
  }

  test("combo in-request skip: a RAW 403 with connection-scope quota also takes this branch (not markAuthLevelExhaustion)", () => {
    const sets = comboSets();
    const spy = makeLogSpy();
    const { providerExhausted: exhausted } = applyComboTargetExhaustion(comboTarget(), {
      ...comboBaseOpts,
      result: { status: 403 },
      fallbackResult: CONNECTION_SCOPE_FALLBACK_RESULT,
      sets,
      log: spy.log,
    });
    assert.equal(exhausted, true);
    assert.ok(
      sets.exhaustedConnections.has("agentrouter:conn-agentrouter-1"),
      "a raw 403 carrying ruleScope=connection must exhaust the connection just like the restated-429 case"
    );
    assert.equal(sets.exhaustedProviders.size, 0);
    assert.equal(
      sets.transientRateLimitedProviders.size,
      0,
      "same suppression as the 429 case — must not force-allow reusing this connection"
    );
    // The discriminant: prove the NEW (#10334) branch emitted the log, not
    // markAuthLevelExhaustion's (#8133) — the Set assertions above cannot tell
    // the two apart on their own.
    assert.equal(spy.calls.length, 1, "exactly one log call expected for this failure");
    assert.match(
      spy.calls[0].message,
      /#10334/,
      "must be markAgentrouterConnectionQuotaExhaustion's log line, not markAuthLevelExhaustion's"
    );
    assert.ok(
      /account quota exhausted/.test(spy.calls[0].message),
      "must carry the new branch's wording, not markAuthLevelExhaustion's 'auth failure'"
    );
    assert.doesNotMatch(
      spy.calls[0].message,
      /#8133/,
      "must NOT be markAuthLevelExhaustion's log line"
    );
  });

  // ─── Invariant sentinel ─────────────────────────────────────────────────
  // classifyProviderError (open-sse/services/errorClassifier.ts) must NEVER
  // classify agentrouter's restated 429 body ("用户额度不足") as quota_exhausted.
  // If it ever does, open-sse/handlers/chatCore.ts's providerFailure handling
  // (~line 3835-3856) can reach the terminal `else` branch
  // (`testStatus: "credits_exhausted"`) for agentrouter whenever
  // lockModelIfPerModelQuota does not itself claim the failure — turning a
  // transient, self-recovering account-quota window into a connection that
  // requires a manual operator reset. agentrouter is an apikey-category
  // provider (not oauth), so shouldPreserveQuotaSignalsFor429 in
  // errorClassifier.ts returns false for it and the 429 branch falls through
  // to RATE_LIMITED instead — pin that this stays true.
  test("sentinel: classifyProviderError never returns quota_exhausted for agentrouter's restated 429 body", () => {
    const classification = classifyProviderError(429, "用户额度不足", "agentrouter");
    assert.notEqual(
      classification,
      "quota_exhausted",
      "a quota_exhausted classification here would route agentrouter's transient account quota into chatCore's terminal credits_exhausted branch (~chatCore.ts:3849)"
    );
  });
});

describe("agentrouter-chatcore-protocols", () => {
  const originalFetch = globalThis.fetch;

  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  function createSseResponse(events: string[]) {
    return new Response(`${events.join("\n\n")}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  async function flushAsyncSideEffects() {
    // setImmediate rounds drain the event loop more reliably than setTimeout under CI load.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  before(freshDb);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await flushAsyncSideEffects();
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await core.resetDbInstance();
  });

  test("AgentRouter Responses requests automatically use the native Responses protocol", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;

    globalThis.fetch = async (url, init = {}) => {
      const body = JSON.parse(String(init.body || "{}"));
      captured = {
        url: String(url),
        headers: new Headers(init.headers),
        body,
      };

      if (!("input" in body)) {
        return new Response(JSON.stringify({ error: { message: "input is required" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          id: "resp_agentrouter",
          object: "response",
          status: "completed",
          model: "gpt-5.6-sol",
          output: [
            {
              id: "msg_agentrouter",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const body = {
      model: "agentrouter/gpt-5.6-sol",
      input: "Reply with exactly OK",
      max_output_tokens: 16,
      stream: false,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: {
        provider: "agentrouter",
        model: "gpt-5.6-sol",
        extendedContext: false,
      },
      credentials: {
        apiKey: "test-agentrouter-key",
        providerSpecificData: {},
      },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json", originator: "codex_cli_rs" }),
      },
      userAgent: "codex_cli_rs/0.153.4",
    });

    assert.ok(captured);
    assert.equal(
      captured.url,
      "https://agentrouter.org/v1/responses",
      JSON.stringify(captured.body, null, 2)
    );
    assert.ok("input" in captured.body, JSON.stringify(captured.body, null, 2));
    assert.equal(result.success, true);
    assert.equal(captured.headers.get("authorization"), "Bearer test-agentrouter-key");
    assert.equal(captured.headers.get("originator"), "codex_cli_rs");
    assert.equal("system" in captured.body, false);
    assert.equal("thinking" in captured.body, false);
    assert.equal("output_config" in captured.body, false);
  });

  test("AgentRouter OpenAI Chat requests automatically use the native Chat protocol", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      };
      return new Response(
        JSON.stringify({
          id: "chatcmpl_agentrouter",
          object: "chat.completion",
          model: "gpt-5.6-sol",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const body = {
      model: "agentrouter/gpt-5.6-sol",
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      max_completion_tokens: 16,
      stream: false,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "agentrouter", model: "gpt-5.6-sol", extendedContext: false },
      credentials: {
        apiKey: "test-agentrouter-key",
        providerSpecificData: {},
      },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "codex_cli_rs/0.153.4",
    });

    assert.equal(result.success, true);
    assert.ok(captured);
    assert.equal(captured.url, "https://agentrouter.org/v1/chat/completions");
    assert.equal(captured.headers.get("authorization"), "Bearer test-agentrouter-key");
    assert.equal(captured.headers.get("originator"), "codex_cli_rs");
    assert.deepEqual(captured.body.messages, body.messages);
    assert.equal(captured.body.max_completion_tokens, 16);
    assert.equal("system" in captured.body, false);
    assert.equal("thinking" in captured.body, false);
    assert.equal("output_config" in captured.body, false);
  });

  test("AgentRouter Anthropic requests automatically use the native Messages protocol", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      };
      return new Response(
        [
          "event: message_start",
          'data: {"type":"message_start","message":{"id":"msg_agentrouter","type":"message","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":4,"output_tokens":0}}}',
          "",
          "event: content_block_delta",
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
          "",
          "event: message_delta",
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          "",
          "event: message_stop",
          'data: {"type":"message_stop"}',
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    };

    const body = {
      model: "agentrouter/claude-opus-4-8",
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      max_tokens: 16,
      stream: false,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "agentrouter", model: "claude-opus-4-8", extendedContext: false },
      credentials: { apiKey: "test-agentrouter-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "claude-cli/2.1.19",
    });

    assert.equal(result.success, true);
    assert.ok(captured);
    assert.equal(captured.url, "https://agentrouter.org/v1/messages?beta=true");
    assert.equal(captured.headers.get("x-api-key"), "test-agentrouter-key");
    assert.equal(captured.headers.get("authorization"), null);
    assert.ok(Array.isArray(captured.body.messages));
    assert.equal(captured.body.messages[0].role, "user");
    assert.equal(captured.body.thinking.type, "adaptive");
    assert.equal(captured.body.output_config.effort, "xhigh");
  });

  test("AgentRouter Responses streaming stays native without a connection protocol override", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      };
      return createSseResponse([
        "event: response.created\ndata: " +
          JSON.stringify({
            type: "response.created",
            response: { id: "resp_agentrouter", object: "response", status: "in_progress" },
          }),
        "event: response.output_text.delta\ndata: " +
          JSON.stringify({
            type: "response.output_text.delta",
            item_id: "msg_agentrouter",
            output_index: 0,
            content_index: 0,
            delta: "OK",
          }),
        "event: response.completed\ndata: " +
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_agentrouter",
              object: "response",
              status: "completed",
              model: "gpt-5.6-sol",
              output: [],
              usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
            },
          }),
      ]);
    };

    const body = {
      model: "agentrouter/gpt-5.6-sol",
      input: "Reply with exactly OK",
      max_output_tokens: 16,
      stream: true,
      store: false,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "agentrouter", model: "gpt-5.6-sol", extendedContext: false },
      credentials: { apiKey: "test-agentrouter-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream", originator: "codex_cli_rs" }),
      },
      userAgent: "codex_cli_rs/0.153.4",
    });

    assert.equal(result.success, true);
    assert.ok(captured);
    assert.equal(captured.url, "https://agentrouter.org/v1/responses");
    assert.equal(captured.headers.get("authorization"), "Bearer test-agentrouter-key");
    assert.deepEqual(captured.body.input, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: body.input }],
      },
    ]);
    assert.equal(captured.body.stream, true);
    assert.equal(captured.body.store, false);
    assert.equal("system" in captured.body, false);
    assert.equal("thinking" in captured.body, false);
    const text = await result.response.text();
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /response\.completed/);
    assert.match(text, /"total_tokens":5/);
  });

  test("AgentRouter OpenAI Chat streaming stays native without a connection protocol override", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      };
      return createSseResponse([
        "data: " +
          JSON.stringify({
            id: "chatcmpl_agentrouter",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.6-sol",
            choices: [
              { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
            ],
          }),
        "data: " +
          JSON.stringify({
            id: "chatcmpl_agentrouter",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.6-sol",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        "data: " +
          JSON.stringify({
            id: "chatcmpl_agentrouter",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-5.6-sol",
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
          }),
        "data: [DONE]",
      ]);
    };

    const body = {
      model: "agentrouter/gpt-5.6-sol",
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      max_completion_tokens: 16,
      stream: true,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "agentrouter", model: "gpt-5.6-sol", extendedContext: false },
      credentials: { apiKey: "test-agentrouter-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream" }),
      },
      userAgent: "codex_cli_rs/0.153.4",
    });

    assert.equal(result.success, true);
    assert.ok(captured);
    assert.equal(captured.url, "https://agentrouter.org/v1/chat/completions");
    assert.equal(captured.headers.get("authorization"), "Bearer test-agentrouter-key");
    assert.equal(captured.body.stream, true);
    assert.deepEqual(captured.body.messages, body.messages);
    const text = await result.response.text();
    assert.match(text, /"content":"OK"/);
    assert.match(text, /\[DONE\]/);
  });

  test("AgentRouter Anthropic streaming stays native without a connection protocol override", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;

    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || "{}")),
      };
      return createSseResponse([
        "event: message_start\ndata: " +
          JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_agentrouter",
              type: "message",
              role: "assistant",
              model: "claude-opus-4-8",
              usage: { input_tokens: 4, output_tokens: 0 },
            },
          }),
        "event: content_block_delta\ndata: " +
          JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "OK" },
          }),
        "event: message_delta\ndata: " +
          JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          }),
        'event: message_stop\ndata: {"type":"message_stop"}',
      ]);
    };

    const body = {
      model: "agentrouter/claude-opus-4-8",
      messages: [{ role: "user", content: "Reply with exactly OK" }],
      max_tokens: 16,
      stream: true,
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "agentrouter", model: "claude-opus-4-8", extendedContext: false },
      credentials: { apiKey: "test-agentrouter-key", providerSpecificData: {} },
      log: noopLog(),
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream" }),
      },
      userAgent: "claude-cli/2.1.19",
    });

    assert.equal(result.success, true);
    assert.ok(captured);
    assert.equal(captured.url, "https://agentrouter.org/v1/messages?beta=true");
    assert.equal(captured.headers.get("x-api-key"), "test-agentrouter-key");
    assert.equal(captured.body.stream, true);
    const text = await result.response.text();
    assert.match(text, /content_block_delta/);
    assert.match(text, /message_stop/);
  });
});

describe("kimi-effort-suffix-split", () => {
  type Json = Record<string, unknown>;
  const originalFetch = globalThis.fetch;

  before(freshDb);

  after(async () => {
    globalThis.fetch = originalFetch;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    core.resetDbInstance();
  });

  async function dispatchKimi(
    model: string,
    extraBody: Json = {},
    provider = "kimi-coding"
  ): Promise<{ url: string; body: Json }> {
    const captured: Array<{ url: string; body: Json }> = [];
    globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
      captured.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
      return new Response(
        JSON.stringify({
          id: "msg_kimi",
          type: "message",
          role: "assistant",
          model: "k3",
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const body = {
      model,
      stream: false,
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
      ...extraBody,
    };
    try {
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider, model, extendedContext: false },
        credentials: { apiKey: "test-kimi-key", providerSpecificData: {} },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ "content-type": "application/json" }),
        },
      } as never);
      await (result as { response?: Response }).response?.body?.cancel?.().catch(() => {});
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(captured.length, 1, "exactly one upstream call");
    return captured[0];
  }

  // ── Dispatch: the upstream receives the bare wire id + the effort (the 401 fix) ──────────

  test("kimi-coding dispatches kimi-k3-high as k3 with effort high", async () => {
    const { url, body } = await dispatchKimi("kimi-k3-high");
    assert.match(url, /api\.kimi\.com\/coding\/v1\/messages/);
    assert.equal(body.model, "k3");
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.equal((body.thinking as Json | undefined)?.type, "enabled");
  });

  test("a registry base with a suffix keeps its own id (kimi-for-coding-low)", async () => {
    const { body } = await dispatchKimi("kimi-for-coding-low");
    assert.equal(body.model, "kimi-for-coding");
    assert.deepEqual(body.output_config, { effort: "low" });
  });

  test("an explicit client effort wins over the suffix", async () => {
    const { body } = await dispatchKimi("kimi-k3-high", { reasoning_effort: "low" });
    assert.equal(body.model, "k3");
    assert.deepEqual(body.output_config, { effort: "low" });
  });

  test("kimi-coding-apikey gets the same strip", async () => {
    const { body } = await dispatchKimi("kimi-k3-max", {}, "kimi-coding-apikey");
    assert.equal(body.model, "k3");
    assert.deepEqual(body.output_config, { effort: "max" });
  });

  test("registry ids pass through untouched", async () => {
    for (const id of ["k3", "kimi-for-coding-highspeed"]) {
      const { body } = await dispatchKimi(id);
      assert.equal(body.model, id);
    }
  });

  // ── Splitter scope ──────────────────────────────────────────────────────────────────────

  test("the splitter never touches another provider's genuine suffixed ids", () => {
    // Cursor registers kimi-k3-high / kimi-k3-low as real upstream ids.
    for (const provider of ["cursor", "cu", "moonshot", "opencode", null, undefined]) {
      assert.equal(splitKimiCodingEffortVariant(provider, "kimi-k3-high"), null, String(provider));
    }
    // Unknown bases and non-Kimi tiers are not inferred from spelling.
    assert.equal(splitKimiCodingEffortVariant("kimi-coding", "kimi-k9-high"), null);
    assert.equal(splitKimiCodingEffortVariant("kimi-coding", "kimi-k3-xhigh"), null);
    assert.equal(splitKimiCodingEffortVariant("kimi-coding", "kimi-k3-ultra"), null);
    assert.deepEqual(splitKimiCodingEffortVariant("kimi-coding", "kmc/kimi-k3-high"), {
      wireModel: "k3",
      effort: "high",
    });
  });

  // ── Reasoning-rule intent mirrors the dispatch split, only for Kimi Coding prefixes ─────

  test("kimi-coding / kmc prefixed ids split into the base model + request effort", () => {
    const intent = extractReasoningIntent("kimi-coding/kimi-k3-high", {});
    assert.equal(intent.model, "kimi-coding/kimi-k3");
    assert.equal(intent.effort, "high");

    const kmc = extractReasoningIntent("kmc/kimi-k3-high", {});
    assert.equal(kmc.model, "kmc/kimi-k3");
    assert.equal(kmc.effort, "high");
  });

  test("bare or foreign-prefixed suffixed ids are not split (Cursor's kimi-k3-high)", () => {
    for (const id of ["kimi-k3-high", "k3-high", "cursor/kimi-k3-high", "cu/kimi-k3-low"]) {
      const intent = extractReasoningIntent(id, {});
      assert.equal(intent.model, id);
      assert.equal(intent.effort, null);
    }
  });

  test("real kimi wire ids pass through unsplit", () => {
    for (const id of [
      "kimi-coding/k3",
      "kimi-coding/kimi-for-coding",
      "kimi-coding/kimi-for-coding-highspeed",
      "kimi-coding/kimi-k3-xhigh",
    ]) {
      const intent = extractReasoningIntent(id, {});
      assert.equal(intent.model, id);
      assert.equal(intent.effort, null);
    }
  });

  test("explicit request effort still wins over the suffix", () => {
    const intent = extractReasoningIntent("kimi-coding/kimi-k3-high", {
      reasoning_effort: "low",
    });
    assert.equal(intent.model, "kimi-coding/kimi-k3");
    assert.equal(intent.effort, "low");
  });
});

describe("opencode-mimo-v2.5-free-chatcore-forward-17788 (#17788)", () => {
  const originalFetch = globalThis.fetch;

  before(freshDb);

  after(() => {
    globalThis.fetch = originalFetch;
    core.resetDbInstance();
  });

  /**
   * #17472 / #17788: OpenCode Zen answers the retired `mimo-v2.5-free` id with
   * `410 ... Use mimo-v2.6-flash-free instead.` A client pinned to the old id must
   * reach the upstream under the replacement id through the real chatCore path.
   */
  for (const provider of ["opencode-zen", "opencode"]) {
    test(`chatCore forwards a ${provider} request pinned to mimo-v2.5-free as mimo-v2.6-flash-free`, async () => {
      const sentModels: unknown[] = [];
      globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        sentModels.push(parsed.model);
        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: parsed.model,
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      try {
        const body = {
          model: "mimo-v2.5-free",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        };
        const result = await handleChatCore({
          body: structuredClone(body),
          modelInfo: { provider, model: "mimo-v2.5-free", extendedContext: false },
          credentials: { apiKey: "sk-test", providerSpecificData: {} },
          log: { debug() {}, info() {}, warn() {}, error() {} },
          clientRawRequest: {
            endpoint: "/v1/chat/completions",
            body: structuredClone(body),
            headers: new Headers({ accept: "application/json" }),
          },
          userAgent: "mimo-forward-17788-test",
        });

        assert.equal(result.success, true, "request must not be rejected as a retired model");
        assert.deepEqual(sentModels, ["mimo-v2.6-flash-free"]);
        await result.response?.body?.cancel?.().catch(() => {});
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

describe("repro-6912-volcengine-max-completion-tokens (#6912)", () => {
  // Regression test for #6912: OmniRoute never renamed a client-sent
  // `max_completion_tokens` back to `max_tokens` for providers/models whose
  // registry entry only documents the legacy field (Volcengine Ark / DeepSeek).
  // chatCore.ts already renamed the OTHER direction (max_tokens ->
  // max_completion_tokens for o1/o3/o4/gpt-5.4/5.5, #1961) but had no symmetric
  // case, so `max_completion_tokens` was forwarded byte-for-byte to Volcengine,
  // which silently ignores the unrecognized field and returns an unbounded
  // completion.
  const originalFetch = globalThis.fetch;

  function noopLog() {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
  }

  function toPlainHeaders(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, value == null ? "" : String(value)])
    );
  }

  function buildOpenAIResponse(text = "ok") {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-json",
        object: "chat.completion",
        model: "DeepSeek-V4-Flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  async function invokeChatCore({ body, provider, model, endpoint = "/v1/chat/completions" }) {
    const calls: Array<{ url: string; headers: Record<string, string>; parsedBody: unknown }> = [];

    globalThis.fetch = async (url, init = {}) => {
      const headers = toPlainHeaders(init.headers);
      const captured = {
        url: String(url),
        method: init.method || "GET",
        headers,
        body: init.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(captured);
      return buildOpenAIResponse();
    };

    try {
      const requestBody = structuredClone(body);
      const result = await handleChatCore({
        body: requestBody,
        modelInfo: { provider, model, extendedContext: false },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: noopLog(),
        clientRawRequest: {
          endpoint,
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        connectionId: null,
        apiKeyInfo: null,
        userAgent: "unit-test",
        isCombo: false,
        comboStrategy: null,
        onCredentialsRefreshed: null,
        onRequestSuccess: null,
      } as unknown as Parameters<typeof handleChatCore>[0]);

      return { result, calls, call: calls.at(-1) };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  async function resetStorage() {
    clearUpstreamProxyConfigCache();
    resetPayloadRulesConfigForTests();
    clearCache();
    clearIdempotency();
    clearInflight();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
  }

  before(freshDb);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resetAccountSemaphores();
    await resetStorage();
  });

  after(async () => {
    await core.resetDbInstance();
  });

  test("#6912: chatCore renames max_completion_tokens to max_tokens for volcengine/DeepSeek-V4-Flash", async () => {
    const { call } = await invokeChatCore({
      provider: "volcengine",
      model: "DeepSeek-V4-Flash",
      body: {
        model: "DeepSeek-V4-Flash",
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 30,
        stream: false,
      },
    });

    assert.equal(
      call.body.max_tokens,
      30,
      "expected max_completion_tokens to be normalized to max_tokens for volcengine"
    );
    assert.equal(call.body.max_completion_tokens, undefined);
  });

  test("#6912: chatCore does not clobber an already-present max_tokens", async () => {
    const { call } = await invokeChatCore({
      provider: "volcengine",
      model: "DeepSeek-V4-Flash",
      body: {
        model: "DeepSeek-V4-Flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 500,
        max_completion_tokens: 30,
        stream: false,
      },
    });

    assert.equal(
      call.body.max_tokens,
      500,
      "existing max_tokens must win over max_completion_tokens"
    );
    assert.equal(call.body.max_completion_tokens, undefined);
  });

  test("#6912: chatCore keeps the pre-existing max_tokens->max_completion_tokens direction for o3 (#1961)", async () => {
    const { call } = await invokeChatCore({
      provider: "openai",
      model: "o3",
      body: {
        model: "o3",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 99999,
        stream: false,
      },
    });

    // Existing provider-side token-limit clamping (unrelated to #6912) caps the
    // renamed value; this test only asserts the rename direction is preserved.
    assert.equal(call.body.max_tokens, undefined);
    assert.equal(call.body.max_completion_tokens, 16384);
  });
});

describe("muse-session-ownership", () => {
  const candidates = [{ id: "account-a" }, { id: "account-b" }];

  async function clearOwnership(): Promise<void> {
    await getTestBackend().execute("DELETE FROM muse_session_ownership");
  }

  before(freshDb);

  after(() => core.resetDbInstance());

  test("fresh sessions alternate while tool continuations preserve exact encrypted output and owner", async () => {
    await clearOwnership();
    const scope = museSessionScope({ prompt_cache_key: "session-a" }, undefined, "client");
    const other = museSessionScope({ prompt_cache_key: "session-b" }, undefined, "client");
    assert.equal(
      (await claimMuseSession(scope, { input: "read fixture" }, candidates)).connectionId,
      "account-a"
    );
    assert.equal(
      (await claimMuseSession(other, { input: "read fixture" }, candidates)).connectionId,
      "account-b"
    );
    const generation = await bindMuseGeneration(
      scope,
      "account-a",
      "private-test-key-a",
      "identity-a"
    );
    const output = [
      { type: "reasoning", encrypted_content: "opaque-test-a", summary: [] },
      { type: "function_call", call_id: "call-a", name: "read", arguments: "{}" },
    ];
    const wire =
      `data: ${JSON.stringify({ type: "response.output_item.done", item: output[0] })}\r\n\r\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n` +
      "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(wire);
    const source = new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    });
    assert.equal(
      await recordMuseOutput(
        new Response(source, { headers: { "content-type": "text/event-stream" } }),
        scope,
        generation
      ).text(),
      wire
    );
    const input = [
      ...output,
      { type: "function_call_output", call_id: "call-a", output: "fixture result" },
    ];
    const before = structuredClone(input);
    assert.equal((await claimMuseSession(scope, { input }, candidates)).connectionId, "account-a");
    assert.deepEqual(input, before);
    await assert.rejects(claimMuseSession(other, { input }, candidates), /not issued/);
    await assert.rejects(claimMuseSession(scope, { input }, [candidates[1]]), /unavailable/);
    await assert.rejects(claimMuseSession(scope, { input }, candidates, "account-b"), /differs/);
    await assert.rejects(
      bindMuseGeneration(scope, "account-a", "replacement-key", "identity-a"),
      /generation changed/
    );
    await assert.rejects(
      bindMuseGeneration(scope, "account-a", "private-test-key-a", "identity-b"),
      /owner changed/
    );
    assert.equal(
      await bindMuseGeneration(scope, "account-a", "private-test-key-a", "identity-a"),
      generation
    );
    await assert.rejects(
      claimMuseSession(
        scope,
        { input: [{ type: "function_call_output", call_id: "foreign-call", output: "foreign" }] },
        candidates
      ),
      /not issued/
    );
  });

  test("reminted same-account key is adopted when no replayable history was recorded", async () => {
    const scope = museSessionScope({ prompt_cache_key: "remint-session" }, undefined, "client");
    const owner = await claimMuseSession(scope, { input: "fresh" }, candidates);
    const first = await bindMuseGeneration(
      scope,
      owner.connectionId,
      "minted-key-1",
      "stable-identity"
    );
    const second = await bindMuseGeneration(
      scope,
      owner.connectionId,
      "minted-key-2",
      "stable-identity"
    );
    assert.notEqual(first, second);
    assert.equal(
      await bindMuseGeneration(scope, owner.connectionId, "minted-key-2", "stable-identity"),
      second
    );
  });

  test("unknown replay, missing identity and another API client cannot adopt encrypted reasoning", async () => {
    assert.throws(
      () => museSessionScope({ input: "same prompt" }, undefined, "client"),
      /explicit session/
    );
    const scope = museSessionScope({ prompt_cache_key: "unknown-session" }, undefined, "client");
    for (const input of [
      [{ type: "reasoning", encrypted_content: "foreign" }],
      [{ type: "function_call_output", call_id: "old", output: "old result" }],
    ]) {
      await assert.rejects(claimMuseSession(scope, { input }, candidates), /no recorded owner/);
    }
    await assert.rejects(
      claimMuseSession(scope, { previous_response_id: "old" }, candidates),
      /no recorded owner/
    );
    assert.notEqual(
      museSessionScope({ prompt_cache_key: "session-a" }, undefined, "client"),
      museSessionScope({ prompt_cache_key: "session-a" }, undefined, "different-client")
    );
    assert.equal(
      museSessionScope({ input: "x" }, new Headers({ "x-session-id": "hdr-session" }), "client"),
      museSessionScope({ input: "x" }, { "x-session-id": "hdr-session" }, "client")
    );
  });

  test("JSON output records ownership, and upstream errors retain their original body/status", async () => {
    const scope = museSessionScope({ prompt_cache_key: "json-session" }, undefined, "client");
    const owner = await claimMuseSession(scope, { input: "fresh" }, candidates);
    const generation = await bindMuseGeneration(
      scope,
      owner.connectionId,
      "json-key",
      "json-identity"
    );
    const output = [{ type: "reasoning", encrypted_content: "json-opaque" }];
    const wire = JSON.stringify({ output });
    assert.equal(await recordMuseOutput(new Response(wire), scope, generation).text(), wire);
    assert.equal(
      (await claimMuseSession(scope, { input: output }, candidates)).connectionId,
      owner.connectionId
    );
    const failure = new Response("caller mismatch", { status: 400 });
    assert.equal(recordMuseOutput(failure, scope, generation), failure);
    assert.equal(await failure.text(), "caller mismatch");
  });

  test("chat tool history cannot acquire a fresh owner and emitted calls remain usable", async () => {
    const scope = museSessionScope({ session_id: "chat-tools" }, undefined, "client");
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          { id: "chat-call", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "chat-call", content: "result" },
    ];
    await assert.rejects(claimMuseSession(scope, { messages }, candidates), /no recorded owner/);
    const owner = await claimMuseSession(
      scope,
      { messages: [{ role: "user", content: "hi" }] },
      candidates
    );
    const generation = await bindMuseGeneration(
      scope,
      owner.connectionId,
      "chat-key",
      "chat-account"
    );
    const wire = JSON.stringify({ choices: [{ message: messages[0] }] });
    assert.equal(await recordMuseOutput(new Response(wire), scope, generation).text(), wire);
    assert.equal(
      (await claimMuseSession(scope, { messages }, candidates)).connectionId,
      owner.connectionId
    );
    const foreign = museSessionScope({ session_id: "foreign-chat" }, undefined, "client");
    await claimMuseSession(foreign, { input: "fresh" }, candidates);
    await assert.rejects(claimMuseSession(foreign, { messages }, candidates), /not issued/);
  });

  test("exhausted account is skipped for new sessions and unserved pins move to a healthy account", async () => {
    await clearOwnership();
    const healthy = [{ id: "account-a" }, { id: "account-b" }];
    const exhausted = [{ id: "account-a", unavailable: true }, { id: "account-b" }];
    const unserved = museSessionScope({ session_id: "unserved" }, undefined, "client");
    assert.equal(
      (await claimMuseSession(unserved, { input: "fresh" }, healthy)).connectionId,
      "account-a"
    );
    for (const session of ["fresh-1", "fresh-2", "fresh-3"]) {
      const scope = museSessionScope({ session_id: session }, undefined, "client");
      assert.equal(
        (await claimMuseSession(scope, { input: "fresh" }, exhausted)).connectionId,
        "account-b"
      );
    }
    assert.equal(
      (await claimMuseSession(unserved, { input: "retry" }, exhausted)).connectionId,
      "account-b"
    );
    assert.equal(
      (await claimMuseSession(unserved, { input: "retry" }, healthy)).connectionId,
      "account-b"
    );

    const served = museSessionScope({ session_id: "served" }, undefined, "client");
    const flipped = [{ id: "account-a" }, { id: "account-b", unavailable: true }];
    assert.equal(
      (await claimMuseSession(served, { input: "fresh" }, flipped)).connectionId,
      "account-a"
    );
    const generation = await bindMuseGeneration(
      served,
      "account-a",
      "served-key",
      "served-identity"
    );
    await recordMuseOutput(
      new Response(JSON.stringify({ output: [{ type: "message", id: "msg-served" }] })),
      served,
      generation
    ).text();
    await assert.rejects(
      claimMuseSession(served, { input: "continue" }, exhausted),
      (error: { status?: number; message?: string }) =>
        error.status === 503 && /cross-account continuation is forbidden/.test(error.message || "")
    );
    assert.equal(
      (await claimMuseSession(served, { input: "continue" }, flipped)).connectionId,
      "account-a"
    );
  });

  test("a Muse 429 model lockout makes new and unserved sessions claim the healthy account", async () => {
    await clearOwnership();
    clearAllModelLockouts();
    const connections = [
      { id: "account-a", authType: "oauth", rateLimitedUntil: null, testStatus: "active" },
      { id: "account-b", authType: "oauth", rateLimitedUntil: null, testStatus: "active" },
    ];
    const model = "muse-spark-1.3";
    const unserved = museSessionScope({ session_id: "lock-unserved" }, undefined, "client");
    const before = museClaimCandidates(connections, model);
    assert.equal(
      (await claimMuseSession(unserved, { input: "fresh" }, before)).connectionId,
      "account-a"
    );

    // Account A's upstream 429 records only a per-model lockout; rateLimitedUntil and
    // testStatus stay untouched, as observed live.
    lockModel("muse-code", "account-a", model, "rate_limit_exceeded", 120_000);
    const locked = museClaimCandidates(connections, model);
    assert.deepEqual(
      locked.map((candidate) => candidate.unavailable),
      [true, false]
    );
    for (const session of ["lock-fresh-1", "lock-fresh-2"]) {
      const scope = museSessionScope({ session_id: session }, undefined, "client");
      assert.equal(
        (await claimMuseSession(scope, { input: "fresh" }, locked)).connectionId,
        "account-b"
      );
    }
    assert.equal(
      (await claimMuseSession(unserved, { input: "retry" }, locked)).connectionId,
      "account-b"
    );
    assert.equal(
      museClaimCandidates(connections, model, null, true).every((c) => !c.unavailable),
      true
    );
    clearAllModelLockouts();
  });

  test("API-key Muse connections bypass OAuth ownership unless OAuth is selected", () => {
    const keys = [{ id: "key", authType: "apikey" }];
    assert.equal(usesMuseOAuthOwnership(keys), false);
    const mixed = [...keys, { id: "oauth", authType: "oauth" }];
    assert.equal(usesMuseOAuthOwnership(mixed, "key"), false);
    assert.equal(usesMuseOAuthOwnership(mixed, "oauth"), true);
    assert.equal(usesMuseOAuthOwnership(mixed), true);
  });

  test("chatCore fences reminted continuation before dispatch and records fresh serving generation", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const continuation of [true, false]) {
        const scope = museSessionScope(
          { session_id: `execution-${continuation}` },
          undefined,
          "client"
        );
        const owner = await claimMuseSession(scope, { input: "fresh" }, candidates);
        let generation = await bindMuseGeneration(
          scope,
          owner.connectionId,
          "execution-key-1",
          "identity"
        );
        if (continuation)
          await recordMuseOutput(
            new Response(
              JSON.stringify({
                output: [{ type: "reasoning", encrypted_content: "execution-opaque" }],
              })
            ),
            scope,
            generation
          ).text();
        const inferenceCalls: string[] = [];
        globalThis.fetch = async (url, init) => {
          if (String(url).endsWith("/muse-code/key"))
            return Response.json({ api_key: "execution-key-2" });
          const token = new Headers(init?.headers).get("authorization") || "";
          inferenceCalls.push(token);
          if (token.includes("execution-key-1"))
            return Response.json({ error: { message: "expired" } }, { status: 401 });
          return Response.json({
            id: "response-execution",
            object: "response",
            output: [
              { type: "reasoning", encrypted_content: "served-key-2" },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        };
        const result = await handleChatCore({
          body: {
            model: "muse-code/muse-spark",
            input: continuation
              ? [
                  { type: "reasoning", encrypted_content: "execution-opaque" },
                  { role: "user", content: "continue" },
                ]
              : "fresh",
            stream: false,
          },
          modelInfo: { provider: "muse-code", model: "muse-spark" },
          credentials: {
            accessToken: "execution-key-1",
            refreshToken: "dca:test",
            connectionId: owner.connectionId,
            providerSpecificData: {},
          },
          clientRawRequest: { endpoint: "/v1/responses", headers: { accept: "application/json" } },
          cachedSettings: {},
          skipResourcePressureGuard: true,
          beforeUpstreamAttempt: async (credentials) => {
            generation = await bindMuseGeneration(
              scope,
              owner.connectionId,
              credentials.accessToken,
              "identity"
            );
          },
          log: { debug() {}, info() {}, warn() {}, error() {} },
        });
        if (continuation) {
          assert.equal(result.success, false);
          assert.equal(result.status, 409);
          assert.equal(inferenceCalls.length, 1);
        } else {
          assert.equal(result.success, true);
          assert.equal(inferenceCalls.length, 2);
          assert.equal(
            generation,
            await bindMuseGeneration(scope, owner.connectionId, "execution-key-2", "identity")
          );
          await recordMuseOutput(result.response, scope, generation).text();
          assert.equal(
            (
              await claimMuseSession(
                scope,
                { input: [{ type: "reasoning", encrypted_content: "served-key-2" }] },
                candidates
              )
            ).connectionId,
            owner.connectionId
          );
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("video-bridge-log-redaction (#12150)", () => {
  // P1b of #12150 (Video Bridge transcript retention) — surface 1 (call-log sink).
  // Exercises the real persistAttemptLogs serialization (same harness pattern as
  // tests/unit/chatcore-attempt-logging.test.ts): a real temp DB, a poll for the
  // async saveCallLog write, and assertions on the persisted requestBody.
  //
  // Proves: when PersistAttemptLogsContext carries a videoBridgeLogRedaction map
  // (P1a's per-part structured-redaction shadow), the PERSISTED requestBody has
  // the transcript text swapped for the placeholder — while a control call
  // WITHOUT the map (the byte-identical non-video path) keeps the original text,
  // and the caller's own `body` object is never mutated in the process (the
  // model already received the untouched original earlier in the request
  // lifecycle; this call must not reach back and change it).
  //
  // #12150 fix round 1 (adversarial review, CRITICAL): also proves the
  // content-address fix for the positional-drift bug — real request-mutation
  // stages (injectSystemPrompt's "no existing system message" branch,
  // context-relay handoff injection, reasoning-rule body rewrites) can
  // prepend/splice messages between the guardrail's preCall and this log
  // write, making a stale (messageIndex, partIndex) point at the wrong message
  // or an out-of-bounds slot. applyVideoBridgeLogRedaction must locate the
  // video part by matching `fullText` against part text, not by position.
  const SECRET = "secret words";
  const FULL_TEXT = `[Video 1]: A person talks. transcript[00:00-00:02]: ${SECRET}`;
  const PLACEHOLDER_TEXT =
    "[Video 1]: A person talks. transcript[00:00-00:02]: [redacted-video-transcript]";

  function videoBody() {
    return {
      model: "openai/gpt-x",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "look at this video" },
            {
              type: "text",
              text: FULL_TEXT,
            },
          ],
        },
      ],
    };
  }

  function baseCtx(overrides: Record<string, unknown> = {}) {
    // #13481/#13546: the call log row is keyed on traceId. It defaults to
    // pendingRequestId so these tests keep polling by the id they pass in.
    const pendingRequestId = (overrides.pendingRequestId as string) ?? "REPLACE";
    return {
      traceId: overrides.traceId ?? pendingRequestId,
      provider: "openai",
      connectionId: "conn-1",
      model: "gpt-x",
      skillRequestId: "skill-1",
      detailedLoggingEnabled: false,
      reqLogger: null,
      pendingRequestId: "REPLACE",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      requestedModel: "gpt-x-requested",
      credentials: { connectionId: "cred-conn" },
      startTime: Date.now(),
      body: videoBody(),
      sourceFormat: "openai",
      targetFormat: "openai",
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
      tokensCompressed: 0,
      apiKeyInfo: { id: "key-1", name: "Key One" },
      noLogEnabled: false,
      ...overrides,
    } as Parameters<typeof persistAttemptLogs>[1];
  }

  // The attempt log is persisted asynchronously, so the row is polled rather than
  // read once. The budget is a wall-clock deadline instead of a fixed try count:
  // at 120 tries x 20ms the ceiling was 2.4s, and on a loaded runner the SQLite
  // write routinely takes longer than that — the poll returned null and the
  // assertions failed as "expected: true, actual: false", which reads like a
  // redaction defect rather than a starved runner. 30s is far past any healthy
  // write while still bounded, and a fast machine still returns on the first pass.
  const POLL_DEADLINE_MS = 30_000;

  async function pollForCallLog(traceId: string, deadlineMs = POLL_DEADLINE_MS) {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const rows = await getCallLogs({ correlationId: traceId, limit: 5 });
      if (rows[0]?.id && rows[0].detailState === "ready") {
        const row = await getCallLogById(rows[0].id);
        if (row) return row as Record<string, unknown>;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function persistedPartText(requestBody: unknown): string {
    const record = requestBody as {
      messages?: Array<{ content?: Array<{ text?: string }> }>;
    };
    return record?.messages?.[1]?.content?.[1]?.text ?? "";
  }

  before(freshDb);

  before(async () => {
    await core.ensureDbInitialized();
  });

  after(async () => {
    await core.resetDbInstance();
  });

  test("persisted requestBody carries the placeholder and never the raw transcript when a redaction map is present", async () => {
    const id = "video-redacted-1";
    persistAttemptLogs(
      { status: 200, tokens: { input: 1, output: 2 } },
      baseCtx({
        pendingRequestId: id,
        videoBridgeLogRedaction: [
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 1,
            fullText: FULL_TEXT,
            redactedText: PLACEHOLDER_TEXT,
          },
        ],
      })
    );
    const row = await pollForCallLog(id);
    assert.ok(row, "call log row should be persisted");
    const persistedText = persistedPartText(row.requestBody);
    assert.equal(persistedText, PLACEHOLDER_TEXT);
    assert.ok(!persistedText.includes(SECRET), "persisted log must not contain the raw transcript");
    assert.equal(
      JSON.stringify(row.requestBody).includes(SECRET),
      false,
      "raw transcript must not appear anywhere in the persisted requestBody"
    );
  });

  test("#12150 P2 surface 2: persistAttemptLogs marks the call_logs row video_content_removed=1 when ctx.videoContentRemoved is true", async () => {
    // The continuation fail-closed (resolvePreviousResponseState) depends on this
    // marker being written for any request whose stored client snapshot had its
    // video transcript redacted. This proves the ctx.videoContentRemoved signal
    // reaches the persisted row; the row is the exact thing the continuation store
    // reads back.
    const id = "video-marker-1";
    persistAttemptLogs(
      { status: 200, tokens: { input: 1, output: 2 } },
      baseCtx({ pendingRequestId: id, videoContentRemoved: true })
    );
    const row = await pollForCallLog(id);
    assert.ok(row, "call log row should be persisted");
    const marker = await getTestBackend().queryOne<{ video_content_removed: boolean }>(
      "SELECT video_content_removed FROM call_logs WHERE id = $1",
      [row.id]
    );
    assert.equal(marker?.video_content_removed, true);
  });

  test("#12150 P2 surface 2: the marker defaults to 0 for an ordinary (non-video) request", async () => {
    const id = "video-marker-control-1";
    persistAttemptLogs(
      { status: 200, tokens: { input: 1, output: 2 } },
      baseCtx({ pendingRequestId: id })
    );
    const row = await pollForCallLog(id);
    assert.ok(row);
    const marker = await getTestBackend().queryOne<{ video_content_removed: boolean }>(
      "SELECT video_content_removed FROM call_logs WHERE id = $1",
      [row.id]
    );
    assert.equal(marker?.video_content_removed, false);
  });

  test("control: without a redaction map the persisted requestBody keeps the original text (model path untouched)", async () => {
    const id = "video-control-1";
    persistAttemptLogs(
      { status: 200, tokens: { input: 1, output: 2 } },
      baseCtx({ pendingRequestId: id })
    );
    const row = await pollForCallLog(id);
    assert.ok(row);
    const persistedText = persistedPartText(row.requestBody);
    assert.ok(
      persistedText.includes(SECRET),
      "control call (no redaction map) must keep the raw transcript text"
    );
  });

  test("observed requests never retain an echoed transcript in the response or detailed pipeline artifact", async () => {
    const id = "video-response-retention-1";
    const responseBody = { choices: [{ message: { content: SECRET } }] };
    const detailedPayloads = {
      providerResponse: responseBody,
      streamChunks: { client: [SECRET], provider: [SECRET] },
    };
    persistAttemptLogs(
      {
        status: 200,
        responseBody,
        providerRequest: { messages: [{ role: "user", content: FULL_TEXT }] },
        providerResponse: responseBody,
        clientResponse: responseBody,
      },
      baseCtx({
        pendingRequestId: id,
        detailedLoggingEnabled: true,
        reqLogger: { getPipelinePayloads: () => detailedPayloads },
        videoContentRemoved: true,
        videoBridgeLogRedaction: [
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 1,
            fullText: FULL_TEXT,
            redactedText: PLACEHOLDER_TEXT,
          },
        ],
      })
    );

    const row = await pollForCallLog(id);
    assert.ok(row);
    assert.equal(JSON.stringify(row).includes(SECRET), false);
    assert.equal(JSON.stringify(row).includes(FULL_TEXT), false);
    assert.equal(JSON.stringify(responseBody).includes(SECRET), true, "client response stays live");
  });

  test("non-video requests retain their response body as before", async () => {
    const id = "video-response-retention-control-1";
    persistAttemptLogs(
      { status: 200, responseBody: { choices: [{ message: { content: SECRET } }] } },
      baseCtx({ pendingRequestId: id })
    );
    const row = await pollForCallLog(id);
    assert.ok(row);
    assert.equal(JSON.stringify(row.responseBody).includes(SECRET), true);
  });

  test("observed video attempts discard early keepalive bytes instead of retaining them in memory", async () => {
    const id = "video-early-keepalive-retention-1";
    const correlationId = "video-early-keepalive-retention-corr-1";
    recordEarlyKeepaliveBytes(correlationId, SECRET);

    persistAttemptLogs(
      { status: 200 },
      baseCtx({
        pendingRequestId: id,
        correlationId,
        detailedLoggingEnabled: true,
        videoContentRemoved: true,
        videoBridgeLogRedaction: [
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 1,
            fullText: FULL_TEXT,
            redactedText: PLACEHOLDER_TEXT,
          },
        ],
      })
    );

    assert.deepEqual(takeEarlyKeepaliveBytes(correlationId), []);
    const row = await pollForCallLog(correlationId);
    assert.ok(row);
    assert.equal(JSON.stringify(row).includes(SECRET), false);
  });

  test("observed video logs omit the request when the per-part redaction shadow cannot be applied", async () => {
    const id = "video-missing-shadow-1";
    persistAttemptLogs(
      { status: 200 },
      baseCtx({ pendingRequestId: id, videoContentRemoved: true })
    );

    const row = await pollForCallLog(id);
    assert.ok(row);
    assert.equal(JSON.stringify(row.requestBody).includes(SECRET), false);
    assert.equal(
      (row.requestBody as Record<string, unknown>)._omniroute_omitted,
      "video-transcript"
    );
  });

  test("observed video logs omit the whole request when only some shadow entries match", async () => {
    const id = "video-partial-shadow-1";
    const secondSecret = "second private transcript";
    const secondFullText = `[Video 2]: transcript[00:02-00:04]: ${secondSecret}`;
    const body = videoBody();
    const content = body.messages[1].content;
    assert.ok(Array.isArray(content));
    content.push({ type: "text", text: `${secondFullText} modified after preCall` });

    persistAttemptLogs(
      { status: 200 },
      baseCtx({
        pendingRequestId: id,
        body,
        videoContentRemoved: true,
        videoBridgeLogRedaction: [
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 1,
            fullText: FULL_TEXT,
            redactedText: PLACEHOLDER_TEXT,
          },
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 2,
            fullText: secondFullText,
            redactedText: "[redacted-video-transcript]",
          },
        ],
      })
    );

    const row = await pollForCallLog(id);
    assert.ok(row);
    assert.equal(
      (row.requestBody as Record<string, unknown>)._omniroute_omitted,
      "video-transcript"
    );
    assert.equal(JSON.stringify(row.requestBody).includes(secondSecret), false);
    assert.equal(
      JSON.stringify(body).includes(secondSecret),
      true,
      "live model request is unchanged"
    );
  });

  test("observed video logs keep a redacted request when every video shadow matches", async () => {
    const id = "video-complete-shadow-1";
    const secondSecret = "another private transcript";
    const secondFullText = `[Video 2]: transcript[00:02-00:04]: ${secondSecret}`;
    const body = videoBody();
    const content = body.messages[1].content;
    assert.ok(Array.isArray(content));
    content.push({ type: "text", text: secondFullText });

    persistAttemptLogs(
      { status: 200 },
      baseCtx({
        pendingRequestId: id,
        body,
        videoContentRemoved: true,
        videoBridgeLogRedaction: [
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 1,
            fullText: FULL_TEXT,
            redactedText: PLACEHOLDER_TEXT,
          },
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 2,
            fullText: secondFullText,
            redactedText: "[redacted-video-transcript]",
          },
        ],
      })
    );

    const row = await pollForCallLog(id);
    assert.ok(row);
    assert.equal((row.requestBody as Record<string, unknown>)._omniroute_omitted, undefined);
    assert.equal(persistedPartText(row.requestBody), PLACEHOLDER_TEXT);
    assert.equal(JSON.stringify(row.requestBody).includes(secondSecret), false);
    assert.equal(
      JSON.stringify(body).includes(secondSecret),
      true,
      "live model request is unchanged"
    );
  });

  test("the caller's body object is never mutated by the redaction", async () => {
    const id = "video-nomutate-1";
    const body = videoBody();
    const snapshotBefore = JSON.parse(JSON.stringify(body));
    persistAttemptLogs(
      { status: 200 },
      baseCtx({
        pendingRequestId: id,
        body,
        videoBridgeLogRedaction: [
          {
            container: "messages",
            messageIndex: 1,
            partIndex: 1,
            fullText: FULL_TEXT,
            redactedText: PLACEHOLDER_TEXT,
          },
        ],
      })
    );
    await pollForCallLog(id);
    assert.deepEqual(
      body,
      snapshotBefore,
      "ctx.body must be byte-identical after persistAttemptLogs runs"
    );
  });

  test("Scenario A (adversarial review): a message prepended AFTER the guardrail built the redaction map does not leak the transcript, and the prepended message is untouched", async () => {
    const id = "video-scenario-a-1";

    // The body exactly as the video-bridge guardrail saw it when it computed
    // the redaction map: a single user message, no system message yet — this
    // is precisely the shape that makes injectSystemPrompt's "no existing
    // system message" branch (open-sse/services/systemPrompt.ts) fire.
    const userMessageWithVideo = {
      role: "user",
      content: [
        { type: "text", text: "look at this video" },
        { type: "text", text: FULL_TEXT },
      ],
    };
    // The map the guardrail built, correct AT THAT MOMENT: the video part was
    // messages[0].content[1].
    const redactionMap = [
      {
        container: "messages" as const,
        messageIndex: 0,
        partIndex: 1,
        fullText: FULL_TEXT,
        redactedText: PLACEHOLDER_TEXT,
      },
    ];

    // Real production shape: AFTER the guardrail ran, injectSystemPrompt found
    // no existing system/developer message and unshifted a brand-new one —
    // `result.messages = [{ role: "system", content: combined }, ...result.messages]`
    // — shifting the video message from index 0 to index 1. The map above is
    // now stale by the time persistAttemptLogs serializes the log: a purely
    // positional lookup at (messageIndex: 0, partIndex: 1) would land on this
    // new system message instead.
    const bodyAfterSystemPromptInjection = {
      messages: [{ role: "system", content: "You are a helpful assistant." }, userMessageWithVideo],
    };

    persistAttemptLogs(
      { status: 200 },
      baseCtx({
        pendingRequestId: id,
        body: bodyAfterSystemPromptInjection,
        videoBridgeLogRedaction: redactionMap,
      })
    );

    const row = await pollForCallLog(id);
    assert.ok(row, "call log row should be persisted");
    const persisted = row.requestBody as {
      messages: Array<{ role: string; content: unknown }>;
    };

    // (A) the leak: the video part, now shifted to index 1, must still be
    // found and redacted by content, not silently skipped.
    const shiftedContent = persisted.messages[1].content as Array<{ text: string }>;
    assert.equal(
      shiftedContent[1].text,
      PLACEHOLDER_TEXT,
      "the shifted video part must still be redacted despite the stale positional map"
    );
    assert.ok(
      !shiftedContent[1].text.includes(SECRET),
      "the shifted video part must not leak the raw transcript"
    );
    assert.equal(JSON.stringify(persisted).includes(SECRET), false);

    // (B) the corruption: the newly prepended system message — which a
    // positional lookup at the stale index would have landed on — must be
    // completely untouched.
    assert.equal(
      persisted.messages[0].content,
      "You are a helpful assistant.",
      "the prepended system message must be untouched"
    );
  });

  // #12150 P2 surface 1 (the dominant transcript-retention leak): the RAW client-request
  // snapshot passed to reqLogger.logClientRawRequest (open-sse/handlers/chatCore.ts's
  // "0. Log client raw request" step) is a DIFFERENT sink from persistAttemptLogs above —
  // it is captured before the guardrail chain even runs, so it carries the client's raw
  // `transcript`/`audioTranscript` FIELDS on a structured video part, not a flattened
  // description string. Importing the real chatCore.ts here would pull the full
  // request-pipeline dependency graph (executors, providers, combo routing, DB-backed
  // settings, ...) into the test just to reach one guarded call a few hundred lines into
  // a 5900+ line handler, for no additional proof beyond what's below — so this calls the
  // REAL exported `logClientRawRequestRedacted` (the exact function chatCore.ts's call site
  // invokes, post file-size-refactor) against a fake logClientRawRequest. The pure redaction
  // helper itself has its own thorough suite in
  // tests/unit/guardrails/videoBridgeSnapshotRedaction.test.ts.
  function fakeReqLogger() {
    const calls: unknown[] = [];
    return {
      calls,
      logClientRawRequest(_endpoint: unknown, body: unknown, _headers?: unknown) {
        calls.push(body);
      },
    };
  }

  test("surface 2 (raw snapshot): the fake logClientRawRequest receives a redacted snapshot only when videoBridgeObserved is true", () => {
    const rawBody = {
      model: "openai/gpt-x",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this video" },
            {
              type: "input_video",
              video_url: "https://example.com/clip.mp4",
              transcript: { cues: [{ text: SECRET, startSeconds: 0, endSeconds: 2 }] },
            },
          ],
        },
      ],
    };
    const clientRawRequest = { endpoint: "/v1/chat/completions", body: rawBody, headers: {} };

    const observedLogger = fakeReqLogger();
    logClientRawRequestRedacted(observedLogger, clientRawRequest, true);
    const observedSnapshot = observedLogger.calls[0];
    assert.ok(
      !JSON.stringify(observedSnapshot).includes(SECRET),
      "an observed request must not log the raw transcript"
    );
    assert.notEqual(
      observedSnapshot,
      rawBody,
      "the observed path must log a redacted CLONE, not the original reference"
    );
    assert.ok(
      JSON.stringify(rawBody).includes(SECRET),
      "clientRawRequest.body itself must stay untouched for every other consumer (translation/dispatch)"
    );

    const nonObservedLogger = fakeReqLogger();
    logClientRawRequestRedacted(nonObservedLogger, clientRawRequest, false);
    assert.equal(
      nonObservedLogger.calls[0],
      rawBody,
      "the non-observed path must log the exact same object reference — byte-identical, no clone"
    );

    const skippedLogger = fakeReqLogger();
    logClientRawRequestRedacted(skippedLogger, null, true);
    assert.equal(
      skippedLogger.calls.length,
      0,
      "a missing clientRawRequest must not call logClientRawRequest at all (mirrors the old if-guard)"
    );
  });
});

describe("video-bridge-provider-failure-diagnostics", () => {
  const CANARY = "VIDEO_CUE_PRIVATE_SENTINEL_7D2";
  const upstreamMessage = `Authentication failed; cue ${CANARY}`;

  async function invokeFailure(observed: boolean) {
    const connection = await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: observed ? "video error" : "ordinary error",
      apiKey: "video-provider-error-key",
      isActive: true,
      testStatus: "active",
    });
    const body = {
      model: "openai/gpt-4o-mini",
      stream: false,
      messages: [{ role: "user", content: `[Video 1] transcript: ${CANARY}` }],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: upstreamMessage } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });

    try {
      const response = await handleChatCore({
        body,
        modelInfo: { provider: "openai", model: "gpt-4o-mini", extendedContext: false },
        credentials: { apiKey: "video-provider-error-key", providerSpecificData: {} },
        log: null,
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: new Headers({ accept: "application/json" }),
        },
        connectionId: connection.id,
        videoBridgeLog: observed ? { observed: true, redaction: [] } : undefined,
        skipResourcePressureGuard: true,
      });
      assert.ok(response.response instanceof Response, "chatCore returns a client Response");
      const clientBody = await response.response.text();
      const stored = await providersDb.getProviderConnectionById(connection.id);
      return {
        status: response.status,
        clientBody,
        lastError: stored?.lastError ?? "",
        lastErrorType: stored?.lastErrorType ?? "",
        testStatus: stored?.testStatus ?? "",
      };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  before(freshDb);

  after(async () => {
    await waitForCallLogSaves(5000);
    core.resetDbInstance();
  });

  test("observed video provider failures omit echoed cues from retained connection errors", async () => {
    await core.ensureDbInitialized();
    const ordinary = await invokeFailure(false);
    const observed = await invokeFailure(true);

    assert.equal(ordinary.status, 401);
    assert.equal(observed.status, ordinary.status);
    assert.equal(
      observed.clientBody,
      ordinary.clientBody,
      "client-visible failure stays unchanged"
    );
    assert.equal(observed.lastErrorType, ordinary.lastErrorType, "failure class stays unchanged");
    assert.equal(observed.testStatus, ordinary.testStatus, "connection state stays unchanged");
    assert.match(ordinary.lastError, /VIDEO_CUE_PRIVATE_SENTINEL_7D2/);
    assert.doesNotMatch(observed.lastError, /VIDEO_CUE_PRIVATE_SENTINEL_7D2/);
  });
});

describe("cursor-claude-search-stream", () => {
  const name = "omniroute_web_search";
  const finalText = "Guido van Rossum. https://www.python.org/";
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const originalServerOwnedToolLoop = process.env.SERVER_OWNED_TOOL_LOOP_ENABLED;

  before(freshDb);

  before(() => {
    // Load-time env of the original file; the flag is resolved per request.
    process.env.SERVER_OWNED_TOOL_LOOP_ENABLED = "true";
  });

  after(() => {
    if (originalServerOwnedToolLoop === undefined)
      delete process.env.SERVER_OWNED_TOOL_LOOP_ENABLED;
    else process.env.SERVER_OWNED_TOOL_LOOP_ENABLED = originalServerOwnedToolLoop;
    core.resetDbInstance();
  });

  test("Claude streaming search executes both Cursor legs and returns a final Messages stream", async (t) => {
    await createProviderConnection({
      provider: "brave-search",
      authType: "apikey",
      name: "test search",
      apiKey: "test-key",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
    const calls: Record<string, unknown>[] = [];
    let searches = 0;
    t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
      assert.match(String(url), /api\.search\.brave\.com/);
      searches++;
      return Response.json({
        web: {
          results: [
            {
              title: "Python history",
              url: "https://www.python.org/",
              description: "Created by Guido van Rossum.",
            },
          ],
        },
      });
    });
    t.mock.method(
      CursorExecutor.prototype,
      "execute",
      async ({ body, stream }: { body: Record<string, unknown>; stream: boolean }) => {
        assert.equal(
          stream,
          false,
          "server-owned search must run before replaying the client stream"
        );
        calls.push(structuredClone(body));
        const first = calls.length === 1;
        assert.ok(calls.length <= 2, "the search must finish without a repeated forced call");
        const response = Response.json({
          id: "chatcmpl-cursor-search-test",
          object: "chat.completion",
          model: "claude-opus-5-thinking-1m",
          choices: [
            {
              index: 0,
              finish_reason: first ? "tool_calls" : "stop",
              message: first
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_search",
                        type: "function",
                        function: { name, arguments: '{"query":"who created Python"}' },
                      },
                    ],
                  }
                : { role: "assistant", content: finalText },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
        return { response, url: "https://cursor.example.test", headers: {}, transformedBody: body };
      }
    );
    const body = {
      model: "cursor/claude-opus-5-thinking-1m",
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "user", content: "Search who created Python, then answer with a source." },
      ],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "tool", name: "web_search" },
      output_config: { effort: "high" },
    };
    const result = await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "cursor", model: "claude-opus-5-thinking-1m" },
      credentials: { accessToken: "test-token", providerSpecificData: {} },
      log,
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: structuredClone(body),
        headers: new Headers({ accept: "text/event-stream" }),
      },
      userAgent: "unit-test",
    });
    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.equal(searches, 1);
    assert.deepEqual(calls[0].tool_choice, { type: "function", function: { name } });
    assert.equal(calls[0].reasoning_effort, "high");
    assert.equal(calls[1].reasoning_effort, "high");
    assert.match(JSON.stringify(calls[1].messages), /Created by Guido van Rossum/);
    assert.equal(result.response.headers.get("content-type"), "text/event-stream");
    const sse = await result.response.text();
    assert.match(sse, /event: message_start/);
    assert.match(sse, /Guido van Rossum/);
    assert.match(sse, /"stop_reason":"end_turn"/);
    assert.match(sse, /event: message_stop/);
    assert.doesNotMatch(sse, /"name":"omniroute_web_search"/);
  });
});
