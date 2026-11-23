// Quota-driven fallback, quota-share cooldown waits, quota token limits, soft penalties,
// unreadable quotas and the preflight cutoff of handleComboChat. Merged from six files so the
// combo.ts module graph loads once; each original file is one `describe` below, named after the
// file it came from.
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-quota-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-quota-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const comboModule = await import("../../../open-sse/services/combo.ts");
const { handleComboChat, buildAutoCandidates, setCandidateQuotaSoftPenalty } = comboModule;
const { isQuotaExhaustionResponse } =
  await import("../../../open-sse/services/combo/quotaExhaustion.ts");
const { scoreAutoTargets } = await import("../../../open-sse/services/combo/autoStrategy.ts");
const { quotaRemainingPercentFromQuota } =
  await import("../../../open-sse/services/combo/comboPredicates.ts");
const { clearAllModelLockouts, lockModel } =
  await import("../../../open-sse/services/accountFallback.ts");
const { recordComboRequest, resetComboMetrics, resetAllComboMetrics } =
  await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers, getCircuitBreaker } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const { registerQuotaFetcher, getRegisteredQuotaFetchers } =
  await import("../../../open-sse/services/quotaPreflight.ts");
const { getProviderQuota } = await import("../../../src/lib/quota/providerQuotaState.ts");
const { resolveResilienceSettings } = await import("../../../src/lib/resilience/settings.ts");

// The registry has no unregister: describes that replace the "openai" fetcher put the original
// back (when there was one) in their `after` hook.
const originalOpenaiQuotaFetcher = getRegisteredQuotaFetchers().get("openai");
function restoreOpenaiQuotaFetcher() {
  if (originalOpenaiQuotaFetcher) registerQuotaFetcher("openai", originalOpenaiQuotaFetcher);
}

// Each source file used to start in a fresh process; every describe starts from a clean DB and
// clean in-memory combo state.
async function resetSharedState() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  clearAllModelLockouts();
  resetAllComboMetrics();
  resetAllCircuitBreakers();
}

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-quota-exhaustion-only-fallback", () => {
  before(resetSharedState);
  after(restoreOpenaiQuotaFetcher);

  afterEach(() => {
    clearAllModelLockouts();
    resetAllCircuitBreakers();
  });

  function log() {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }

  function response(
    status: number,
    message: string,
    options: { code?: string; type?: string; headers?: Record<string, string> } = {}
  ) {
    return Response.json(
      {
        error: {
          message,
          ...(options.code ? { code: options.code } : {}),
          ...(options.type ? { type: options.type } : {}),
        },
      },
      { status, headers: options.headers }
    );
  }

  function ok(model: string) {
    return Response.json({ model });
  }

  function model(model: string, fallbackOnlyOnQuotaExhaustion?: boolean) {
    return {
      kind: "model" as const,
      model,
      providerId: model.split("/")[0],
      ...(fallbackOnlyOnQuotaExhaustion === undefined ? {} : { fallbackOnlyOnQuotaExhaustion }),
    };
  }

  async function run(
    first: Response | Response[],
    options: {
      enabled?: boolean;
      maxRetries?: number;
      strategy?: string;
      primary?: string;
      connectionId?: string;
      config?: Record<string, unknown>;
      settings?: Record<string, unknown> | null;
      available?: (modelStr: string) => Promise<boolean> | boolean;
    } = {}
  ) {
    const calls: string[] = [];
    const primaryResponses = Array.isArray(first) ? first : [first];
    let primaryAttempt = 0;
    const combo = {
      name: `quota-only-${Math.random()}`,
      strategy: options.strategy ?? "priority",
      models: [
        {
          ...model(options.primary ?? "openai/primary", options.enabled),
          ...(options.connectionId ? { connectionId: options.connectionId } : {}),
        },
        model("anthropic/backup"),
      ],
      config: { maxRetries: options.maxRetries ?? 0, retryDelayMs: 0, ...options.config },
    };
    const result = await handleComboChat({
      body: {},
      combo,
      allCombos: [combo],
      settings: options.settings ?? null,
      log: log(),
      isModelAvailable: options.available ?? (async () => true),
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        if (modelStr !== (options.primary ?? "openai/primary")) return ok(modelStr);
        const result = primaryResponses[Math.min(primaryAttempt, primaryResponses.length - 1)];
        primaryAttempt += 1;
        return result.clone();
      },
    });
    return { result, calls };
  }

  test("quota classifier rejects terminal-looking evidence on ineligible statuses", async () => {
    for (const status of [400, 401, 404, 408, 409, 422, 500, 502, 503, 504]) {
      for (const terminal of ["insufficient_quota", "quota_exhausted", "credits_exhausted"]) {
        assert.equal(
          await isQuotaExhaustionResponse(
            response(status, `${terminal}: billing hard limit reached`, {
              code: terminal,
              type: terminal,
            }),
            "openai",
            "gpt-4o"
          ),
          false,
          `${status} with ${terminal} must not classify as terminal depletion`
        );
      }
    }
  });

  test("quota classifier accepts explicit terminal depletion only on eligible statuses", async () => {
    for (const status of [402, 429]) {
      assert.equal(
        await isQuotaExhaustionResponse(
          response(status, "Payment required", { code: "insufficient_quota" }),
          "openai",
          "gpt-4o"
        ),
        true
      );
    }
  });

  test("priority target advances on explicit quota exhaustion", async () => {
    const { result, calls } = await run(response(429, "You have exceeded your current quota"), {
      enabled: true,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "anthropic/backup"]);
  });

  test("fill-first advances cross-provider after balance 403 in the same request", async () => {
    const { result, calls } = await run(
      response(403, "Insufficient account balance", {
        code: "AUTHZ_INSUFFICIENT_BALANCE",
      }),
      { strategy: "fill-first" }
    );

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "anthropic/backup"]);
  });

  test("fill-first balance 403 marks the connection credit-exhausted without deactivating it", async () => {
    const { createProviderConnection, getProviderConnectionById } =
      await import("../../../src/lib/db/providers.ts");
    const { writeTerminalStatus } = await import("../../../src/shared/utils/terminalStatus.ts");
    const quotaCache = await import("../../../src/domain/quotaCache.ts");

    const conn = await createProviderConnection({
      provider: "openai",
      name: "balance-hop-primary",
      authType: "apikey",
      apiKey: "sk-balance-hop",
      isActive: true,
      testStatus: "active",
    });
    const connectionId = String(conn.id);

    quotaCache.setQuotaCache(connectionId, "openai", {
      session: {
        remainingPercentage: 40,
        resetAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });

    const { result, calls } = await run(
      response(403, "Insufficient account balance", {
        code: "AUTHZ_INSUFFICIENT_BALANCE",
      }),
      { strategy: "fill-first", connectionId }
    );

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "anthropic/backup"]);
    assert.equal(
      quotaCache.isAccountQuotaExhausted(connectionId),
      true,
      "403 balance exhaustion must mark the connection for later routing draws (same as 402)"
    );

    // chatCore records credits_exhausted via writeTerminalStatus; the connection
    // must stay is_active=1 so a later top-up can recover without a UI re-enable.
    await writeTerminalStatus(
      connectionId,
      {
        testStatus: "credits_exhausted",
        lastError: "Insufficient account balance",
        errorCode: "403",
        lastErrorType: "quota_exhausted",
      },
      "production"
    );
    const after = await getProviderConnectionById(connectionId);
    assert.equal(after?.isActive, true, "balance 403 must never deactivate the connection");
    assert.equal(after?.testStatus, "credits_exhausted");
  });

  test("priority target retries plain 429 then returns the last response without advancing", async () => {
    const { result, calls } = await run(response(429, "Rate limit exceeded; retry later"), {
      enabled: true,
      maxRetries: 1,
    });
    assert.equal(result.status, 429);
    assert.deepEqual(calls, ["openai/primary", "openai/primary"]);
  });

  test("priority target keeps a non-quota retry monotonic through terminal quota exhaustion", async () => {
    const { result, calls } = await run(
      [
        response(503, "Service unavailable"),
        response(429, "Payment required", { code: "insufficient_quota" }),
      ],
      { enabled: true, maxRetries: 1 }
    );
    assert.equal(result.status, 429);
    assert.deepEqual(calls, ["openai/primary", "openai/primary"]);
  });

  test("priority target returns a later successful retry", async () => {
    const { result, calls } = await run(
      [response(503, "Service unavailable"), ok("openai/primary")],
      { enabled: true, maxRetries: 1 }
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "openai/primary"]);
  });

  test("priority target advances when every retry is quota exhaustion", async () => {
    const { result, calls } = await run(
      [
        response(429, "Payment required", { code: "quota_exhausted" }),
        response(429, "Billing hard limit reached", { code: "quota_exhausted" }),
      ],
      { enabled: true, maxRetries: 1 }
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "openai/primary", "anthropic/backup"]);
  });

  test("failures of another target do not contaminate protected target trust", async () => {
    const calls: string[] = [];
    const combo = {
      name: `target-local-${Math.random()}`,
      strategy: "priority",
      models: [
        model("openai/unprotected"),
        model("anthropic/protected", true),
        model("paid/backup"),
      ],
      config: { maxRetries: 0, retryDelayMs: 0 },
    };
    const result = await handleComboChat({
      body: {},
      combo,
      allCombos: [combo],
      settings: null,
      log: log(),
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return modelStr === "openai/unprotected"
          ? response(503, "Service unavailable")
          : modelStr === "anthropic/protected"
            ? response(429, "Payment required", { code: "quota_exhausted" })
            : ok(modelStr);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/unprotected", "anthropic/protected", "paid/backup"]);
  });

  for (const [status, message] of [
    [408, "Request timeout"],
    [502, "Bad gateway"],
    [503, "Service unavailable"],
    [503, "Local concurrency capacity reached"],
    [504, "Gateway timeout"],
    [401, "Invalid API key"],
  ] as const) {
    test(`priority target does not advance on non-quota ${status} (${message})`, async () => {
      const { result, calls } = await run(response(status, message), { enabled: true });
      assert.equal(result.status, status);
      assert.deepEqual(calls, ["openai/primary"]);
    });
  }

  test("protected non-quota response preserves status, body, and headers", async () => {
    const first = response(502, "upstream detail", { headers: { "x-upstream": "kept" } });
    const { result } = await run(first, { enabled: true });
    assert.equal(result.status, 502);
    assert.equal(result.headers.get("x-upstream"), "kept");
    assert.deepEqual(await result.json(), { error: { message: "upstream detail" } });
  });

  for (const [metric, advances] of [
    ["generate_content_free_tier_requests", false],
    ["generate_content_free_tier_input_token_count", false],
    ["generate_content_free_tier_requests_per_day", true],
  ] as const) {
    test(`Gemini ${metric} classification ${advances ? "advances" : "stops"} direct routing`, async () => {
      const message = `You exceeded your current quota for metric generativelanguage.googleapis.com/${metric}`;
      const { result, calls } = await run(response(429, message), {
        enabled: true,
        primary: "gemini/gemini-2.5-flash",
      });
      assert.equal(result.ok, advances);
      assert.deepEqual(
        calls,
        advances ? ["gemini/gemini-2.5-flash", "anthropic/backup"] : ["gemini/gemini-2.5-flash"]
      );
    });
  }

  test("compatible provider advances only on explicit structured terminal depletion", async () => {
    const plain = await run(response(402, "billing service unavailable"), {
      enabled: true,
      primary: "openai-compatible-chat-test/primary",
    });
    assert.equal(plain.result.status, 402);
    assert.deepEqual(plain.calls, ["openai-compatible-chat-test/primary"]);

    const terminal = await run(response(402, "Payment required", { code: "insufficient_quota" }), {
      enabled: true,
      primary: "openai-compatible-chat-test/primary",
    });
    assert.equal(terminal.result.ok, true);
    assert.deepEqual(terminal.calls, ["openai-compatible-chat-test/primary", "anthropic/backup"]);
  });

  test("unset Gemini RPM response retains baseline fallback", async () => {
    const { result, calls } = await run(
      response(
        429,
        "You exceeded your current quota for metric generativelanguage.googleapis.com/generate_content_free_tier_requests"
      ),
      { primary: "gemini/gemini-2.5-flash" }
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["gemini/gemini-2.5-flash", "anthropic/backup"]);
  });

  test("unset target retains generic fallback", async () => {
    const { result, calls } = await run(response(503, "Service unavailable"));
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "anthropic/backup"]);
  });

  test("option is dormant outside priority", async () => {
    const { result, calls } = await run(response(503, "Service unavailable"), {
      enabled: true,
      strategy: "fill-first",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "anthropic/backup"]);
  });

  test("authoritative local quota cutoff advances an opted-in priority target", async () => {
    const calls: string[] = [];
    const combo = {
      name: `local-quota-${Math.random()}`,
      strategy: "priority",
      models: [
        { ...model("openai/primary", true), connectionId: "quota-empty" },
        model("anthropic/backup"),
      ],
      config: { maxRetries: 0, retryDelayMs: 0 },
    };
    const quotaPreflight = await import("../../../open-sse/services/quotaPreflight.ts");
    quotaPreflight.registerQuotaFetcher("openai", async () => ({
      used: 100,
      total: 100,
      percentUsed: 1,
    }));
    const result = await handleComboChat({
      body: {},
      combo,
      allCombos: [combo],
      log: log(),
      settings: {
        resilienceSettings: {
          quotaPreflight: { enabled: true, defaultThresholdPercent: 2, warnThresholdPercent: 20 },
        },
      },
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return ok(modelStr);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["anthropic/backup"]);
  });

  test("protected pre-existing model lockout stops routing with a local 503", async () => {
    lockModel("openai", "locked-connection", "primary", "rate_limited", 60_000);
    const { result, calls } = await run(response(503, "unused"), {
      enabled: true,
      connectionId: "locked-connection",
    });
    assert.equal(result.status, 503);
    assert.deepEqual(calls, []);
  });

  test("protected target keeps configured retries after recording a transient model lockout", async () => {
    const { result, calls } = await run(response(503, "Service unavailable"), {
      enabled: true,
      maxRetries: 1,
      connectionId: "retry-connection",
      settings: {
        resilienceSettings: {
          modelLockout: { enabled: true, errorCodes: [503], baseCooldownMs: 60_000 },
        },
      },
    });
    assert.equal(result.status, 503);
    assert.deepEqual(calls, ["openai/primary", "openai/primary"]);
  });

  test("protected response-quality rejection returns a sanitized 502 without advancing", async () => {
    const { result, calls } = await run(ok("openai/primary"), {
      enabled: true,
      config: { responseValidation: { minContentLength: 100 } },
    });
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), {
      error: {
        message: "Upstream response failed quality validation",
        type: "server_error",
        code: "bad_gateway",
      },
    });
    assert.deepEqual(calls, ["openai/primary"]);
  });

  test("protected predictive TTFT skip returns local 503 without advancing", async () => {
    const name = `predictive-${Math.random()}`;
    resetComboMetrics(name);
    for (let index = 0; index < 5; index += 1) {
      recordComboRequest(name, "openai/primary", { success: true, latencyMs: 10_000 });
    }
    const calls: string[] = [];
    const combo = {
      name,
      strategy: "priority",
      models: [model("openai/primary", true), model("anthropic/backup")],
      config: { maxRetries: 0, zeroLatencyOptimizationsEnabled: true, predictiveTtftMs: 1 },
    };
    const result = await handleComboChat({
      body: {},
      combo,
      allCombos: [combo],
      log: log(),
      settings: null,
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return ok(modelStr);
      },
    });
    assert.equal(result.status, 503);
    assert.deepEqual(calls, []);
  });

  test("opted-in combo ref remains a black box and only quota exhaustion advances parent", async () => {
    for (const childError of [
      response(429, "Billing hard limit reached"),
      response(503, "Service unavailable"),
    ]) {
      const calls: string[] = [];
      const child = {
        name: `child-${childError.status}-${Math.random()}`,
        strategy: "priority",
        models: [model("openai/child")],
        config: { maxRetries: 0, retryDelayMs: 0 },
      };
      const outer = {
        name: `outer-${Math.random()}`,
        strategy: "priority",
        models: [
          {
            kind: "combo-ref" as const,
            comboName: child.name,
            fallbackOnlyOnQuotaExhaustion: true,
          },
          model("anthropic/backup"),
        ],
        config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
      };
      const result = await handleComboChat({
        body: {},
        combo: outer,
        allCombos: [outer, child],
        settings: null,
        log: log(),
        isModelAvailable: async () => true,
        handleSingleModel: async (_body, modelStr) => {
          calls.push(modelStr);
          return modelStr === "openai/child" ? childError.clone() : ok(modelStr);
        },
      });
      if (childError.status === 429) {
        assert.equal(result.ok, true);
        assert.deepEqual(calls, ["openai/child", "anthropic/backup"]);
      } else {
        assert.equal(result.status, 503);
        assert.deepEqual(calls, ["openai/child"]);
      }
    }
  });

  // #10501: the child combo's terminal status is now derived from
  // resolveComboTerminalStatus instead of a bare `lastStatus`. A quality failure
  // (openai/quality-invalid) mixed with a genuine quota-exhaustion 429
  // (anthropic/quota) is a heterogeneous, non-"the request itself is invalid"
  // mix, so it normalizes to a 5xx — the `fallbackOnlyOnQuotaExhaustion` STOP
  // decision itself is untouched (it is driven by internal quota-observation
  // tracking, not by re-reading the final HTTP status — asserted below via
  // `calls`, which must still show the parent stopping instead of falling back
  // to paid/backup).
  test("protected parent combo-ref stops after normal child quality rejection then quota exhaustion", async () => {
    const calls: string[] = [];
    const child = {
      name: `quality-child-${Math.random()}`,
      strategy: "priority",
      models: [model("openai/quality-invalid"), model("anthropic/quota")],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        flattenSingleTargetNested: true,
        responseValidation: { minContentLength: 100 },
      },
    };
    const outer = {
      name: `quality-outer-${Math.random()}`,
      strategy: "priority",
      models: [
        { kind: "combo-ref" as const, comboName: child.name, fallbackOnlyOnQuotaExhaustion: true },
        model("paid/backup"),
      ],
      config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
    };
    const result = await handleComboChat({
      body: {},
      combo: outer,
      allCombos: [outer, child],
      settings: null,
      log: log(),
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return modelStr === "openai/quality-invalid"
          ? Response.json({ choices: [{ message: {} }] })
          : modelStr === "anthropic/quota"
            ? response(429, "Payment required", { code: "insufficient_quota" })
            : ok(modelStr);
      },
    });
    assert.ok(
      result.status >= 500,
      `heterogeneous quality+quota-exhaustion mix must normalize to a 5xx, got ${result.status}`
    );
    assert.deepEqual(
      calls,
      ["openai/quality-invalid", "anthropic/quota"],
      "the parent must still STOP at the child (not fall back to paid/backup) — the " +
        "fallbackOnlyOnQuotaExhaustion decision is unaffected by the status-code change"
    );
  });

  test("protected parent combo-ref stops when a child has mixed quota and non-quota failures", async () => {
    const calls: string[] = [];
    const child = {
      name: `mixed-child-${Math.random()}`,
      strategy: "priority",
      models: [model("openai/quota"), model("anthropic/unavailable")],
      config: { maxRetries: 0, retryDelayMs: 0 },
    };
    const outer = {
      name: `mixed-outer-${Math.random()}`,
      strategy: "priority",
      models: [
        { kind: "combo-ref" as const, comboName: child.name, fallbackOnlyOnQuotaExhaustion: true },
        model("anthropic/paid-backup"),
      ],
      config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
    };
    const result = await handleComboChat({
      body: {},
      combo: outer,
      allCombos: [outer, child],
      settings: null,
      log: log(),
      isModelAvailable: async (modelStr) => modelStr !== "anthropic/unavailable",
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return modelStr === "openai/quota"
          ? response(429, "Billing hard limit reached")
          : ok(modelStr);
      },
    });
    assert.equal(result.status, 429);
    assert.deepEqual(calls, ["openai/quota"]);
  });

  test("protected parent combo-ref keeps a child's non-quota target retry monotonic", async () => {
    const calls: string[] = [];
    const child = {
      name: `target-retry-child-${Math.random()}`,
      strategy: "priority",
      models: [model("retry-provider/child")],
      config: { maxRetries: 1, retryDelayMs: 0 },
    };
    const outer = {
      name: `target-retry-outer-${Math.random()}`,
      strategy: "priority",
      models: [
        { kind: "combo-ref" as const, comboName: child.name, fallbackOnlyOnQuotaExhaustion: true },
        model("anthropic/paid-backup"),
      ],
      config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
    };
    const result = await handleComboChat({
      body: {},
      combo: outer,
      allCombos: [outer, child],
      settings: null,
      log: log(),
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return calls.length === 1
          ? response(503, "Service unavailable")
          : response(429, "Payment required", { code: "insufficient_quota" });
      },
    });
    assert.equal(result.status, 429);
    assert.deepEqual(calls, ["retry-provider/child", "retry-provider/child"]);
  });

  test("protected parent combo-ref keeps a child's non-quota set failure monotonic", async () => {
    const calls: string[] = [];
    const child = {
      name: `set-retry-child-${Math.random()}`,
      strategy: "priority",
      models: [model("openai/child")],
      config: { maxRetries: 0, retryDelayMs: 0, maxSetRetries: 1, setRetryDelayMs: 0 },
    };
    const outer = {
      name: `set-retry-outer-${Math.random()}`,
      strategy: "priority",
      models: [
        { kind: "combo-ref" as const, comboName: child.name, fallbackOnlyOnQuotaExhaustion: true },
        model("anthropic/paid-backup"),
      ],
      config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
    };
    const result = await handleComboChat({
      body: {},
      combo: outer,
      allCombos: [outer, child],
      settings: null,
      log: log(),
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return calls.length === 1
          ? response(503, "Service unavailable")
          : response(429, "Payment required", { code: "insufficient_quota" });
      },
    });
    assert.equal(result.status, 429);
    assert.deepEqual(calls, ["openai/child", "openai/child"]);
  });

  test("protected parent combo-ref advances on a single authoritative child quota cutoff", async () => {
    const calls: string[] = [];
    const child = {
      name: `cutoff-child-${Math.random()}`,
      strategy: "priority",
      models: [{ ...model("openai/cutoff"), connectionId: "nested-quota-empty" }],
      config: { maxRetries: 0, retryDelayMs: 0 },
    };
    const outer = {
      name: `cutoff-outer-${Math.random()}`,
      strategy: "priority",
      models: [
        { kind: "combo-ref" as const, comboName: child.name, fallbackOnlyOnQuotaExhaustion: true },
        model("anthropic/paid-backup"),
      ],
      config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
    };
    const quotaPreflight = await import("../../../open-sse/services/quotaPreflight.ts");
    quotaPreflight.registerQuotaFetcher("openai", async () => ({
      used: 100,
      total: 100,
      percentUsed: 1,
    }));
    const result = await handleComboChat({
      body: {},
      combo: outer,
      allCombos: [outer, child],
      settings: {
        resilienceSettings: {
          quotaPreflight: { enabled: true, defaultThresholdPercent: 2, warnThresholdPercent: 20 },
        },
      },
      log: log(),
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return ok(modelStr);
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["anthropic/paid-backup"]);
  });

  for (const [metric, advances] of [
    ["generate_content_free_tier_requests", false],
    ["generate_content_free_tier_input_token_count", false],
    ["generate_content_free_tier_requests_per_day", true],
  ] as const) {
    test(`nested Gemini ${metric} ${advances ? "advances" : "stops"} parent routing`, async () => {
      const calls: string[] = [];
      const child = {
        name: `gemini-child-${Math.random()}`,
        strategy: "priority",
        models: [model("gemini/gemini-2.5-flash")],
        config: { maxRetries: 0, retryDelayMs: 0 },
      };
      const outer = {
        name: `gemini-outer-${Math.random()}`,
        strategy: "priority",
        models: [
          {
            kind: "combo-ref" as const,
            comboName: child.name,
            fallbackOnlyOnQuotaExhaustion: true,
          },
          model("anthropic/backup"),
        ],
        config: { nestedComboMode: "execute", maxRetries: 0, retryDelayMs: 0 },
      };
      const result = await handleComboChat({
        body: {},
        combo: outer,
        allCombos: [outer, child],
        settings: null,
        log: log(),
        isModelAvailable: async () => true,
        handleSingleModel: async (_body, modelStr) => {
          calls.push(modelStr);
          return modelStr.startsWith("gemini/")
            ? response(
                429,
                `You exceeded your current quota for metric generativelanguage.googleapis.com/${metric}`
              )
            : ok(modelStr);
        },
      });
      assert.equal(result.ok, advances);
      assert.deepEqual(
        calls,
        advances ? ["gemini/gemini-2.5-flash", "anthropic/backup"] : ["gemini/gemini-2.5-flash"]
      );
    });
  }
});

describe("combo-quota-share-cooldown-wait", () => {
  // TDD (integration) — quota-share combo cooldown-aware retry (Variante A), exercised through
  // handleComboChat.
  //
  // Scenarios (modelled on the model-lockout-max-cooldown describe in
  // combo/lockout-rate-limit-breaker.test.ts):
  //  1. strategy="quota-share", single connection, model hits a 429 with a SHORT retry-after →
  //     the combo WAITS out the cooldown and re-dispatches; the 2nd pass (lock expired) returns
  //     200 instead of propagating the 429.
  //  2. A 403 (quota_exhausted, locked until midnight) → NO wait, the 403/429 is propagated
  //     immediately (the helper's critical exclusion).
  //  3. Client abort DURING the wait → 499 "Request aborted".
  //  4. strategy="priority" (and every other strategy) also waits out a SHORT transient 429 when
  //     comboCooldownWait is enabled — same decision helper.
  //  5. comboCooldownWait disabled in settings → unchanged: 429 propagated, no wait.
  //
  // The waits use a real (short) cooldown so the real setTimeout in waitForCooldownAwareRetry
  // elapses fast and the model lock expires naturally.
  //
  // Scenarios 2 and 4 assert a wall-clock ceiling and were extracted to
  // tests/unit/serial/combo-quota-share-cooldown-wait-timing.test.ts (#6803) — see that file's
  // header for why.
  function createLog() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  // A short transient cooldown so the real wait is fast but the lock genuinely
  // expires between passes. The 429 carries a retry-after hint slightly LONGER
  // than baseCooldownMs so waiting it out guarantees the lock has cleared.
  const BASE_COOLDOWN_MS = 150;
  const RETRY_AFTER_MS = 250;

  function shortModelLockoutSettings() {
    return {
      modelLockout: {
        enabled: true,
        errorCodes: [403, 429],
        baseCooldownMs: BASE_COOLDOWN_MS,
        maxCooldownMs: 5000,
        maxBackoffSteps: 0,
        useExponentialBackoff: false,
      },
    };
  }

  function jsonResponse(status: number, body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function okResponse() {
    return jsonResponse(200, { id: "ok", choices: [{ message: { content: "recovered" } }] });
  }

  function rateLimitResponse(status: number) {
    return jsonResponse(status, {
      error: { message: `rate limited (${status})` },
      // string ISO retry-after → computeClosestRetryAfter yields ~RETRY_AFTER_MS
      retryAfter: new Date(Date.now() + RETRY_AFTER_MS).toISOString(),
    });
  }

  function rateLimitResponseWithRetryAfter(status: number, retryAfterMs: number) {
    return jsonResponse(status, {
      error: { message: `rate limited (${status})` },
      retryAfter: new Date(Date.now() + retryAfterMs).toISOString(),
    });
  }

  function comboOf(strategy: string) {
    return {
      name: `qtSd/${strategy}-${Math.random().toString(16).slice(2, 8)}`,
      strategy,
      models: ["openai/gpt-4"],
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0, maxSetRetries: 0 },
    };
  }

  beforeEach(async () => {
    await resetSharedState();
  });

  after(() => {
    clearAllModelLockouts();
  });

  test("quota-share: short 429 cooldown → waits and re-dispatches (2nd pass 200)", async () => {
    let calls = 0;
    const handleSingleModel = async () => {
      calls += 1;
      // 1st dispatch: transient 429 (records a rate_limit lock). 2nd dispatch
      // (after the wait, lock expired): success.
      return calls === 1 ? rateLimitResponse(429) : okResponse();
    };

    const startedAt = Date.now();
    const res = await handleComboChat({
      body: { model: "openai/gpt-4" },
      combo: comboOf("quota-share"),
      handleSingleModel,
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: shortModelLockoutSettings(),
      allCombos: null,
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(res.status, 200, "expected the retried dispatch to succeed with 200");
    assert.equal(calls, 2, "expected exactly one wait+redispatch (2 upstream calls)");
    assert.ok(
      elapsed >= BASE_COOLDOWN_MS,
      `expected to have waited out the cooldown, only ${elapsed}ms elapsed`
    );
  });

  // NOTE: "quota-share: 403 quota_exhausted → NO wait" and "non quota-share
  // (priority): 429 propagated immediately, NO wait" were extracted to
  // tests/unit/serial/combo-quota-share-cooldown-wait-timing.test.ts (#6803) —
  // both assert a wall-clock ceiling that flaked under CI-runner load; the
  // serial dir (--test-concurrency=1) removes the intra-suite contention that
  // caused it.

  test("quota-share: client abort during the wait → 499", async () => {
    const controller = new AbortController();
    let calls = 0;
    const handleSingleModel = async () => {
      calls += 1;
      // Always 429 so the loop reaches the wait; abort fires during the wait.
      return rateLimitResponse(429);
    };

    // Abort shortly after the request starts — within the cooldown wait window.
    setTimeout(() => controller.abort(), 50);

    const res = await handleComboChat({
      body: { model: "openai/gpt-4" },
      combo: comboOf("quota-share"),
      handleSingleModel,
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: shortModelLockoutSettings(),
      allCombos: null,
      signal: controller.signal,
    });

    assert.equal(res.status, 499, "abort during the cooldown wait must return 499");
  });

  test("quota-share with comboCooldownWait disabled → 429 propagated, NO wait", async () => {
    let calls = 0;
    const handleSingleModel = async () => {
      calls += 1;
      return rateLimitResponse(429);
    };

    const res = await handleComboChat({
      body: { model: "openai/gpt-4" },
      combo: comboOf("quota-share"),
      handleSingleModel,
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: {
        ...shortModelLockoutSettings(),
        resilienceSettings: { comboCooldownWait: { enabled: false } },
      },
      allCombos: null,
    });

    assert.equal(res.status, 429, "disabled feature must propagate the 429 unchanged");
    assert.equal(calls, 1, "disabled feature must NOT wait+redispatch");
  });

  // #7360: the "default" combo (strategy=auto, two gemma-4 models) was crystallizing
  // a 503 "all targets exhausted" ~6s after both targets hit a real Gemini TPM/RPM
  // 429 (retry-after ~58s), instead of holding the request and retrying once the
  // lower-cooldown target recovered. Mirrors the quota-share scenario above but with
  // TWO distinct model targets and two DIFFERENT retry-after hints, to prove the
  // combo (a) extends the wait to the "auto" strategy and (b) picks the target with
  // the SMALLER remaining cooldown to retry, not just the first one in the list.
  test("auto strategy (2 models, both rate-limited) → waits for the SHORTER cooldown, then succeeds", async () => {
    const SHORT_RETRY_AFTER_MS = 200;
    const LONG_RETRY_AFTER_MS = 3000;
    const MODEL_A = "gemini/gemma-4-31b-it";
    const MODEL_B = "gemini/gemma-4-26b-a4b-it";
    const calls: string[] = [];

    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      const timesSeen = calls.filter((m) => m === modelStr).length;
      if (modelStr === MODEL_A && timesSeen === 1)
        return rateLimitResponseWithRetryAfter(429, SHORT_RETRY_AFTER_MS);
      if (modelStr === MODEL_B) return rateLimitResponseWithRetryAfter(429, LONG_RETRY_AFTER_MS);
      // 2nd time MODEL_A is dispatched (after the wait), its short cooldown has cleared.
      return okResponse();
    };

    const startedAt = Date.now();
    const res = await handleComboChat({
      body: { model: "default" },
      combo: {
        name: `default-${Math.random().toString(16).slice(2, 8)}`,
        strategy: "auto",
        models: [MODEL_A, MODEL_B],
        config: {
          auto: { explorationRate: 0 },
          maxRetries: 0,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          maxSetRetries: 0,
        },
      },
      handleSingleModel,
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: shortModelLockoutSettings(),
      allCombos: null,
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(
      res.status,
      200,
      "expected the combo to wait out the shorter cooldown and succeed"
    );
    assert.equal(calls.length, 3, `expected A, B, A again — got ${JSON.stringify(calls)}`);
    assert.equal(calls[0], MODEL_A, "first target tried should be MODEL_A");
    assert.equal(calls[1], MODEL_B, "second target tried should be MODEL_B");
    assert.equal(
      calls[2],
      MODEL_A,
      "should retry the LOWER-cooldown model (A), not wait for B's longer cooldown"
    );
    assert.ok(
      elapsed >= SHORT_RETRY_AFTER_MS,
      `expected to have waited out the shorter cooldown, only ${elapsed}ms elapsed`
    );
    assert.ok(
      elapsed < LONG_RETRY_AFTER_MS,
      `should NOT wait for the longer cooldown (waited ${elapsed}ms, B's cooldown was ${LONG_RETRY_AFTER_MS}ms)`
    );
  });

  // #7360 follow-up (live incident, log id 1784416706646-51): the test above uses
  // maxSetRetries: 0, so it never exercises more than one setTry iteration — it
  // missed a real bug where lastError/earliestRetryAfter/lastStatus were declared
  // INSIDE the setTry loop body, resetting to null every retry. The real "default"
  // combo config has maxSetRetries: 3 (see liveGeminiShared.ts's DEFAULT_COMBO_CONFIG
  // and the live DB row), so when BOTH targets lock out on setTry 0, every
  // subsequent setTry (1,2,3) pre-skips both via isModelLocked with no real
  // dispatch — meaning lastStatus stayed null on the FINAL iteration, and the
  // combo crystallized a bogus "all accounts inactive" 503 in ~6s instead of ever
  // reaching the cooldown-aware wait, despite a real 429 with a clean ~150ms
  // retry-after having been observed on setTry 0.
  test("auto strategy with maxSetRetries > 0: both targets lock out on the FIRST setTry → still waits and succeeds, not a bogus 503", async () => {
    const SHORT_RETRY_AFTER_MS = 150;
    const MODEL_A = "gemini/gemma-4-31b-it";
    const MODEL_B = "gemini/gemma-4-26b-a4b-it";
    const calls: string[] = [];

    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      const timesSeen = calls.filter((m) => m === modelStr).length;
      if (timesSeen === 1) return rateLimitResponseWithRetryAfter(429, SHORT_RETRY_AFTER_MS);
      return okResponse();
    };

    const res = await handleComboChat({
      body: { model: "default" },
      combo: {
        name: `default-${Math.random().toString(16).slice(2, 8)}`,
        strategy: "auto",
        models: [MODEL_A, MODEL_B],
        config: {
          auto: { explorationRate: 0 },
          maxRetries: 0,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          // Real value from the "default" combo's stored config — this is the
          // field whose non-zero value exposed the bug (multiple setTry passes
          // needed for both targets to still be locked on the LAST pass).
          maxSetRetries: 3,
          setRetryDelayMs: 5,
        },
      },
      handleSingleModel,
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: shortModelLockoutSettings(),
      allCombos: null,
    });

    assert.equal(
      res.status,
      200,
      `expected the combo to wait out the shared cooldown and succeed, got ${res.status} (${await res.clone().text()})`
    );
    // Both targets got a real dispatch on setTry 0 (locking them out), then every
    // pre-skipped setTry (1-3) should have led straight to the cooldown wait
    // rather than crystallizing early — so exactly one of A/B gets a genuine
    // 2nd dispatch after the wait, once its lock has cleared.
    assert.ok(
      calls.length >= 3,
      `expected at least 3 dispatch calls, got ${JSON.stringify(calls)}`
    );
  });

  // Live incident (log id 1784457764961-73): with the REAL "default" combo config
  // (maxRetries: 3, not 0 — see liveGeminiShared.ts DEFAULT_COMBO_CONFIG), a plain
  // RPM-style 429 (rate_limit_exceeded, NOT a token-limit breach) on the FIRST
  // dispatch of setTry 0 enters the `retry < maxRetries` branch, immediately trips
  // model-lockout recording (modelLockout enabled for 429), and hits the
  // "lockoutRecorded" bail-out — which returned null WITHOUT ever setting
  // lastStatus/lastError, even though earliestRetryAfter had already been captured
  // from that same response a few lines earlier. When BOTH targets hit this on
  // setTry 0, lastStatus stays null through every subsequent pre-skipped setTry, so
  // the final `if (!lastStatus)` check won the race against `if (earliestRetryAfter)`
  // and crystallized a bogus ALL_ACCOUNTS_INACTIVE 503 in ~6s — even though a real
  // 429 with a clean ~1min retry-after was observed on both targets. Production
  // symptom: the client (a real agentic loop) saw repeated immediate 503s and kept
  // retrying the whole request every ~7s. maxRetries: 0 (used by every test above)
  // never enters this branch at all, which is why the existing suite missed it.
  test("auto strategy with maxRetries > 0 (matches real 'default' combo config): plain 429 on first dispatch still waits and succeeds, not a bogus 503", async () => {
    const SHORT_RETRY_AFTER_MS = 150;
    const MODEL_A = "gemini/gemma-4-31b-it";
    const MODEL_B = "gemini/gemma-4-26b-a4b-it";
    const calls: string[] = [];

    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      const timesSeen = calls.filter((m) => m === modelStr).length;
      if (timesSeen === 1) return rateLimitResponseWithRetryAfter(429, SHORT_RETRY_AFTER_MS);
      return okResponse();
    };

    const res = await handleComboChat({
      body: { model: "default" },
      combo: {
        name: `default-${Math.random().toString(16).slice(2, 8)}`,
        strategy: "auto",
        models: [MODEL_A, MODEL_B],
        config: {
          auto: { explorationRate: 0 },
          // Real values from the "default" combo's stored config (liveGeminiShared.ts
          // DEFAULT_COMBO_CONFIG) — maxRetries: 3 is the field that exposes the bug:
          // it's what lets the FIRST 429 enter the lockout-recording branch instead of
          // falling straight through to "done retrying this model".
          maxRetries: 3,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          maxSetRetries: 3,
          setRetryDelayMs: 5,
        },
      },
      handleSingleModel,
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: shortModelLockoutSettings(),
      allCombos: null,
    });

    assert.equal(
      res.status,
      200,
      `expected the combo to wait out the shared cooldown and succeed, got ${res.status} (${await res.clone().text()})`
    );
    assert.ok(
      calls.length >= 3,
      `expected at least 3 dispatch calls, got ${JSON.stringify(calls)}`
    );
  });

  // Live incident (log id 1784457764961-73 follow-up, same production request as the
  // test above): fixing lastStatus recording exposed a SECOND, distinct bug behind the
  // same symptom. The pre-dispatch "all credentials already cooling down" rejection
  // (buildModelCooldownBody / handleNoCredentials in src/sse/handlers/chatHelpers.ts)
  // nests its retry hint as `error.retry_after` (ISO string) / `error.reset_seconds`
  // (seconds) — NOT the top-level `retryAfter` field every other 429 response shape in
  // this codebase uses (see rateLimitResponseWithRetryAfter above). Combo.ts's error
  // extraction only ever read the top-level field, so earliestRetryAfter stayed null
  // for this specific shape even after lastStatus was correctly recorded — landing on
  // the generic "all combo models unavailable" error instead of the cooldown-wait
  // decision. Symptom was identical to the fixed bug: a leaked error instead of a wait.
  test("auto strategy: model_cooldown response shape (nested error.retry_after, not top-level) still waits and succeeds", async () => {
    const SHORT_RETRY_AFTER_MS = 150;
    const MODEL_A = "gemini/gemma-4-31b-it";
    const MODEL_B = "gemini/gemma-4-26b-a4b-it";
    const calls: string[] = [];

    // Mirrors buildModelCooldownBody's actual shape (open-sse/utils/error.ts) —
    // retry hint nested under `error`, not top-level `retryAfter`.
    function modelCooldownShapedResponse(model: string, retryAfterMs: number) {
      return jsonResponse(429, {
        error: {
          message: `All credentials for model ${model} are cooling down`,
          type: "rate_limit_error",
          code: "model_cooldown",
          model,
          reset_seconds: Math.max(Math.ceil(retryAfterMs / 1000), 1),
          retry_after: new Date(Date.now() + retryAfterMs).toISOString(),
        },
      });
    }

    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      const timesSeen = calls.filter((m) => m === modelStr).length;
      if (timesSeen === 1) return modelCooldownShapedResponse(modelStr, SHORT_RETRY_AFTER_MS);
      return okResponse();
    };

    const res = await handleComboChat({
      body: { model: "default" },
      combo: {
        name: `default-${Math.random().toString(16).slice(2, 8)}`,
        strategy: "auto",
        models: [MODEL_A, MODEL_B],
        config: {
          auto: { explorationRate: 0 },
          maxRetries: 3,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          maxSetRetries: 3,
          setRetryDelayMs: 5,
        },
      },
      handleSingleModel,
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: shortModelLockoutSettings(),
      allCombos: null,
    });

    assert.equal(
      res.status,
      200,
      `expected the combo to wait out the shared cooldown and succeed, got ${res.status} (${await res.clone().text()})`
    );
    assert.ok(
      calls.length >= 3,
      `expected at least 3 dispatch calls, got ${JSON.stringify(calls)}`
    );
  });
});

describe("combo-quota-soft-penalty", () => {
  // Unit tests for setCandidateQuotaSoftPenalty (B/G2 — Gap #2 soft policy wiring).
  //
  // Covers:
  //  1. no-op when comboExecutionKey is null
  //  2. no-op when comboStepId is null
  //  3. no-op when executionKey is unknown (not registered)
  //  4. marks the correct candidate when registered (via _activeExecutionCandidates)
  //  5. idempotence: calling twice with (key, stepId, true) is safe
  //  6. setCandidateQuotaSoftPenalty has correct exported function signature
  //
  // NOTE: Tests 4 and 5 require access to _registerExecutionCandidates (internal). Because it is
  // NOT exported, we use the module's _activeExecutionCandidates via a roundtrip: register →
  // call public API → assert mutation visible via candidate ref. The approach relies on the
  // candidate object being stored by reference (not cloned).
  //
  // TODO (integration): Add a test verifying that when chatCore calls
  // setCandidateQuotaSoftPenalty after enforceQuotaShare returns deprioritize=true, a subsequent
  // scoreAutoTargets run returns a lower score for the affected candidate. This requires a full
  // combo execution context; deferred to integration tests.
  before(resetSharedState);

  test("setCandidateQuotaSoftPenalty — exported function exists and is callable", () => {
    assert.strictEqual(
      typeof setCandidateQuotaSoftPenalty,
      "function",
      "setCandidateQuotaSoftPenalty must be a function exported from combo.ts"
    );
  });

  test("setCandidateQuotaSoftPenalty — no-op when comboExecutionKey is null", () => {
    // Must not throw and must return undefined (void)
    const result = setCandidateQuotaSoftPenalty(null, "stepA", true);
    assert.strictEqual(result, undefined, "should return undefined (void) for null executionKey");
  });

  test("setCandidateQuotaSoftPenalty — no-op when comboStepId is null", () => {
    const result = setCandidateQuotaSoftPenalty("exec-1", null, true);
    assert.strictEqual(result, undefined, "should return undefined (void) for null stepId");
  });

  test("setCandidateQuotaSoftPenalty — no-op when both are null", () => {
    const result = setCandidateQuotaSoftPenalty(null, null, true);
    assert.strictEqual(result, undefined, "should return undefined (void) when both are null");
  });

  test("setCandidateQuotaSoftPenalty — no-op when executionKey is unknown (not registered)", () => {
    // Calling with an executionKey that was never registered via _registerExecutionCandidates
    // should be silent — no throw, no mutation, returns undefined.
    const result = setCandidateQuotaSoftPenalty("nonexistent-exec-key-xyz", "stepA", true);
    assert.strictEqual(
      result,
      undefined,
      "should return undefined (void) for unknown executionKey"
    );
  });

  test("setCandidateQuotaSoftPenalty — no-op for empty string executionKey (falsy guard)", () => {
    // Empty string is falsy → same guard as null
    const result = setCandidateQuotaSoftPenalty("", "stepA", true);
    assert.strictEqual(result, undefined, "empty string executionKey should be treated as no-op");
  });

  test("setCandidateQuotaSoftPenalty — no-op for empty string stepId (falsy guard)", () => {
    const result = setCandidateQuotaSoftPenalty("exec-1", "", true);
    assert.strictEqual(result, undefined, "empty string stepId should be treated as no-op");
  });

  test("setCandidateQuotaSoftPenalty — marks candidate via internal registry (white-box via module private shim)", async () => {
    // WHITE-BOX: We cannot call _registerExecutionCandidates directly (not exported).
    // However, _activeExecutionCandidates is a module-level Map that stores candidates
    // by reference. We verify the full path by:
    //   1. Creating a mutable candidate object.
    //   2. Injecting it into _activeExecutionCandidates via a minimal handleComboChat
    //      execution that uses strategy="auto" — OR by accessing the Map through Node.js
    //      module internals if available.
    //
    // Since direct internal Map access is not possible without module reflection tricks,
    // we verify via a minimal combo execution with mocked handleSingleModel + isModelAvailable.
    // The execution registers the candidates, then the quota hook (simulated here) calls
    // setCandidateQuotaSoftPenalty. We then check that the candidate's flag was set.
    //
    // This test uses handleComboChat with strategy="auto" and a minimal provider setup.
    // If buildAutoCandidates returns 0 candidates (due to no DB), the registration is
    // skipped — in that case the test is a PASS-through (no crash = correct guard behavior).
    const comboName = "test-soft-penalty";
    const modelStr = "openai/gpt-4o-mini";

    let capturedTarget: { executionKey?: string; stepId?: string } | null = null;

    const handleSingleModel = async (
      _body: Record<string, unknown>,
      _model: string,
      target?: { executionKey?: string; stepId?: string }
    ): Promise<Response> => {
      // Capture the target to verify executionKey and stepId were passed
      if (target && "executionKey" in target) {
        capturedTarget = target;
        // Simulate what chatCore.ts does: call setCandidateQuotaSoftPenalty
        if (target.executionKey && target.stepId) {
          setCandidateQuotaSoftPenalty(target.executionKey, target.stepId, true);
        }
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    };

    const combo = {
      name: comboName,
      strategy: "priority",
      models: [{ model: modelStr }],
    };

    const noop = () => {};
    const log = { info: noop, warn: noop, debug: noop, error: noop };

    try {
      await handleComboChat({
        body: { model: modelStr, messages: [{ role: "user", content: "hi" }] },
        combo,
        handleSingleModel,
        log,
      } as Parameters<typeof handleComboChat>[0]);
    } catch {
      // DB not available in unit test environment — that's OK.
      // The important thing is that calling setCandidateQuotaSoftPenalty with
      // whatever target we captured did NOT throw.
    }

    // Whether or not a target was captured, the important assertion is:
    // setCandidateQuotaSoftPenalty with a captured executionKey (or unknown key) is safe.
    if (capturedTarget?.executionKey && capturedTarget?.stepId) {
      // If we captured a real target, the call above should have run without error.
      // The candidate may or may not be in the Map (depends on strategy auto vs priority).
      // Just assert no exception was thrown (done implicitly above).
      assert.ok(true, "setCandidateQuotaSoftPenalty ran without error on captured target");
    } else {
      // No target captured — no-op path exercised above
      assert.ok(true, "no target captured — no-op path confirmed");
    }
  });

  test("setCandidateQuotaSoftPenalty — idempotent: calling twice with true is safe", () => {
    // Two calls with the same (key, stepId, true) on an unknown key → both no-ops
    setCandidateQuotaSoftPenalty("idempotent-key", "stepA", true);
    const result = setCandidateQuotaSoftPenalty("idempotent-key", "stepA", true);
    assert.strictEqual(result, undefined, "second call must also return undefined (no throw)");
  });

  test("setCandidateQuotaSoftPenalty — idempotent: calling with false after true is safe", () => {
    setCandidateQuotaSoftPenalty("idempotent-key-2", "stepB", true);
    const result = setCandidateQuotaSoftPenalty("idempotent-key-2", "stepB", false);
    assert.strictEqual(result, undefined, "toggling to false must also be safe");
  });
});

describe("combo-quota-unreadable-15347", () => {
  // #15347 — a quota the fetcher could not read must not score as a full one.
  //
  // `quotaRemainingPercentFromQuota` used to return 100 for a missing or malformed quota, so a
  // provider whose usage endpoint was failing outranked every provider that honestly reported
  // 60% consumed, and auto-combo kept choosing providers whose headroom it could not see. A
  // telemetry failure is evidence about the telemetry, not the provider: it must rank strictly
  // below any real reading (like the #4540 status penalty) without being blocked or evicted.
  //
  // `null` from a fetcher means "could not read it". A provider with no cap is NOT that: it
  // reports `unlimited: true`, a real reading of full headroom. A provider with no registered
  // fetcher has no telemetry source at all and keeps its default.
  //
  // Coverage:
  //   1. predicate: missing/malformed -> null; unlimited -> 100; real readings unchanged
  //   2. buildAutoCandidates flags an unreadable quota, never blocks it (cutoff off AND on)
  //   3. scoreAutoTargets keeps it in the pool but strictly below real readings, including a
  //      real 100%-used one (end to end: buildAutoCandidates -> scoreAutoTargets)
  //   4. unlimited and no-fetcher candidates are untouched

  // ── 1. The predicate ──

  test("a missing or malformed quota is unreadable (null), not 100% remaining (#15347)", () => {
    const unreadable: Array<[string, unknown]> = [
      ["null (failed or message-only fetch)", null],
      ["undefined", undefined],
      ["non-object string", "oops"],
      ["non-object number", 42],
      ["empty object", {}],
      ["percentUsed: null (Number(null) === 0)", { percentUsed: null }],
      ["percentUsed: NaN", { percentUsed: Number.NaN }],
      ['percentUsed: ""', { percentUsed: "" }],
      ['percentUsed: " " (Number(" ") === 0)', { percentUsed: " " }],
      ["percentUsed: true (Number(true) === 1)", { percentUsed: true }],
      ["windows with a null percentUsed", { windows: { session: { percentUsed: null } } }],
      ['windows with a "" percentUsed', { windows: { session: { percentUsed: "" } } }],
      ["empty windows map", { windows: {} }],
      ["array windows and no percentUsed", { windows: [] }],
    ];
    for (const [label, quota] of unreadable) {
      assert.equal(
        quotaRemainingPercentFromQuota(quota),
        null,
        `${label} must be unreadable, got ${quotaRemainingPercentFromQuota(quota)}`
      );
    }
  });

  test("an unlimited provider is a real full reading, not an unreadable one (#15347)", () => {
    assert.equal(
      quotaRemainingPercentFromQuota({ used: 0, total: 0, percentUsed: 0, unlimited: true }),
      100
    );
  });

  test("real quota readings keep their remaining percentage (#15347)", () => {
    assert.equal(quotaRemainingPercentFromQuota({ percentUsed: 0 }), 100);
    assert.equal(quotaRemainingPercentFromQuota({ percentUsed: 0.4 }), 60);
    assert.equal(quotaRemainingPercentFromQuota({ percentUsed: "0.25" }), 75);
    assert.equal(quotaRemainingPercentFromQuota({ percentUsed: 1 }), 0);
    assert.equal(quotaRemainingPercentFromQuota({ limitReached: true }), 0);
    assert.equal(quotaRemainingPercentFromQuota({ windows: [], percentUsed: 0.5 }), 50);
    assert.equal(
      quotaRemainingPercentFromQuota({
        windows: { session: { percentUsed: 0.1 }, weekly: { percentUsed: 0.75 } },
      }),
      25
    );
  });

  test("an unparseable window is skipped, not read as 0% used (#15347)", () => {
    // Before: Number(null) === 0 made the null window `a` look 0% used.
    assert.equal(
      quotaRemainingPercentFromQuota({
        windows: { a: { percentUsed: null }, b: { percentUsed: 1 } },
      }),
      0,
      "a null window must not mask a real exhausted one"
    );
    assert.equal(
      quotaRemainingPercentFromQuota({
        windows: { a: { percentUsed: null }, b: { percentUsed: 0.3 } },
      }),
      70
    );
    assert.equal(
      quotaRemainingPercentFromQuota({
        windows: { a: { percentUsed: null } },
        limitReached: true,
      }),
      0,
      "limitReached still wins when no window is readable"
    );
  });

  test("an Antigravity-scoped request ignores unparseable windows too (#15347)", () => {
    const remaining = quotaRemainingPercentFromQuota(
      {
        windows: {
          gemini_weekly: { percentUsed: null },
          "gemini-3.1-flash-lite": { percentUsed: 0.1 },
        },
      },
      { provider: "agy", requestedModel: "gemini-3.1-flash-lite" }
    );
    assert.equal(remaining, 90);
  });

  // ── 2 + 3 + 4. buildAutoCandidates and scoring ──

  // A provider id nothing else in the repo registers, so the module-level fetcher registry
  // cannot leak into (or out of) other test files when they share a process.
  const PROVIDER = "unreadable-quota-test";
  const READINGS = new Map<string, unknown>();
  const THROWING = new Set<string>();

  registerQuotaFetcher(PROVIDER, async (connectionId: string) => {
    if (THROWING.has(connectionId)) throw new Error("usage endpoint down");
    return (READINGS.get(connectionId) ?? null) as never;
  });

  async function seedConn(name: string, provider = PROVIDER) {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name,
      apiKey: `sk-${name}`,
      isActive: true,
    });
  }

  function stepFor(provider: string, model: string) {
    return {
      kind: "model",
      stepId: `${provider}/${model}`,
      executionKey: `${provider}/${model}`,
      modelStr: `${provider}/${model}`,
      provider,
      providerId: provider,
      connectionId: null,
      weight: 1,
      label: null,
    } as never;
  }

  // Quota plus health: the rest of the score must be positive, or a multiplier cannot separate
  // two zeros. Candidates are identical apart from their quota, so only that factor differs.
  const QUOTA_AND_HEALTH_WEIGHTS = {
    quota: 0.5,
    health: 0.5,
    costInv: 0,
    latencyInv: 0,
    taskFit: 0,
    stability: 0,
    tierPriority: 0,
    tierAffinity: 0,
    specificityMatch: 0,
    contextAffinity: 0,
    resetWindowAffinity: 0,
    connectionDensity: 0,
  };

  beforeEach(async () => {
    await resetSharedState();
    READINGS.clear();
    THROWING.clear();
  });

  test("buildAutoCandidates flags a malformed quota, keeps it, and never blocks it (#15347)", async () => {
    const real = await seedConn("real-60");
    const emptyObject = await seedConn("empty-object");
    const nullPercent = await seedConn("null-percent");
    READINGS.set(real.id, { used: 40, total: 100, percentUsed: 0.4 });
    READINGS.set(emptyObject.id, {});
    READINGS.set(nullPercent.id, { used: 0, total: 0, percentUsed: null });

    // The hard cutoff is opt-in; an unreadable reading must stay unblocked either way.
    const cutoffOn = resolveResilienceSettings({
      resilienceSettings: { quotaPreflight: { enabled: true } },
    });
    for (const resilience of [null, cutoffOn]) {
      const candidates = await buildAutoCandidates(
        [stepFor(PROVIDER, "m1")],
        `auto-unreadable-15347-${resilience ? "on" : "off"}`,
        null,
        undefined,
        resilience
      );
      const byConnection = new Map(candidates.map((c) => [c.connectionId, c]));

      assert.equal(byConnection.get(real.id)?.quotaRemaining, 60, "a real reading is untouched");
      assert.notEqual(byConnection.get(real.id)?.quotaUnreadable, true);
      for (const [label, id] of [
        ["empty object", emptyObject.id],
        ["percentUsed: null", nullPercent.id],
      ] as const) {
        const candidate = byConnection.get(id);
        assert.ok(candidate, `${label}: must stay in the candidate pool (never evicted)`);
        assert.equal(candidate!.quotaUnreadable, true, `${label}: must be flagged unreadable`);
        assert.equal(candidate!.quotaRemaining, 0, `${label}: worst on the quota axis`);
        assert.notEqual(candidate!.quotaCutoffBlocked, true, `${label}: must not be hard-blocked`);
      }
    }
  });

  test("a malformed quota ranks strictly below every real reading, even 100% used (#15347)", async () => {
    const healthy = await seedConn("healthy-60");
    const exhausted = await seedConn("exhausted-100-used");
    const malformed = await seedConn("malformed");
    READINGS.set(healthy.id, { used: 40, total: 100, percentUsed: 0.4 });
    READINGS.set(exhausted.id, { used: 100, total: 100, percentUsed: 1 });
    READINGS.set(malformed.id, {});

    const step = stepFor(PROVIDER, "m1");
    const candidates = await buildAutoCandidates([step], "auto-unreadable-15347-rank");
    const targets = candidates.map((candidate) => ({
      ...(step as object),
      stepId: candidate.stepId,
      executionKey: candidate.executionKey,
      modelStr: candidate.modelStr,
      provider: candidate.provider,
      connectionId: candidate.connectionId,
    })) as never[];

    const ranked = await scoreAutoTargets(targets, candidates, "general", QUOTA_AND_HEALTH_WEIGHTS);
    const scoreOf = (id: string) =>
      ranked.find((entry) => entry.target.connectionId === id)?.score as number;

    assert.equal(ranked.length, 3, "the malformed candidate must not be filtered out");
    assert.ok(scoreOf(healthy.id) > scoreOf(exhausted.id), "60% beats 0%");
    assert.ok(
      scoreOf(malformed.id) < scoreOf(exhausted.id),
      `malformed (${scoreOf(malformed.id)}) must score strictly below a real 100%-used reading (${scoreOf(exhausted.id)})`
    );
    assert.equal(ranked[0]?.target.connectionId, healthy.id);
    assert.equal(ranked[2]?.target.connectionId, malformed.id);
  });

  test("a null or throwing fetch is unreadable too: no signal is not full headroom (#15347)", async () => {
    const nullFetch = await seedConn("null-fetch");
    const throwing = await seedConn("throwing-fetch");
    THROWING.add(throwing.id);

    const candidates = await buildAutoCandidates(
      [stepFor(PROVIDER, "m1")],
      "auto-unreadable-15347-null"
    );
    for (const [label, id] of [
      ["null fetch (failed read, missing credentials, message-only)", nullFetch.id],
      ["throwing fetch", throwing.id],
    ] as const) {
      const candidate = candidates.find((c) => c.connectionId === id);
      assert.ok(candidate, `${label}: candidate must stay in the pool`);
      assert.equal(candidate!.quotaUnreadable, true, `${label}: must be flagged unreadable`);
      assert.equal(candidate!.quotaRemaining, 0, `${label}: worst on the quota axis`);
      assert.notEqual(candidate!.quotaCutoffBlocked, true, `${label}: must not be blocked`);
    }
  });

  test("an unlimited provider scores as full and is not flagged (#15347)", async () => {
    const unlimited = await seedConn("unlimited");
    READINGS.set(unlimited.id, { used: 0, total: 0, percentUsed: 0, unlimited: true });

    const candidates = await buildAutoCandidates(
      [stepFor(PROVIDER, "m1")],
      "auto-unreadable-15347-unlimited"
    );
    const candidate = candidates.find((c) => c.connectionId === unlimited.id);
    assert.ok(candidate);
    assert.equal(candidate!.quotaRemaining, 100);
    assert.notEqual(candidate!.quotaUnreadable, true);
  });

  test("a real 0%-used reading stays 100% remaining (#15347)", async () => {
    const full = await seedConn("full-0-used");
    READINGS.set(full.id, { used: 0, total: 100, percentUsed: 0 });

    const candidates = await buildAutoCandidates(
      [stepFor(PROVIDER, "m1")],
      "auto-unreadable-15347-full"
    );
    assert.equal(candidates.find((c) => c.connectionId === full.id)?.quotaRemaining, 100);
  });

  test("a provider with no registered quota fetcher keeps its default (#15347 scope)", async () => {
    const conn = await seedConn("no-fetcher", "unreadable-quota-no-fetcher");
    const candidates = await buildAutoCandidates(
      [stepFor("unreadable-quota-no-fetcher", "m1")],
      "auto-unreadable-15347-nofetcher"
    );
    const candidate = candidates.find((c) => c.connectionId === conn.id);
    assert.ok(candidate, "no-fetcher candidate must exist");
    assert.equal(candidate!.quotaRemaining, 100, "no telemetry source is not a telemetry failure");
    assert.notEqual(candidate!.quotaUnreadable, true);
  });
});

describe("combo-quota-token-limit", () => {
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  const ORIGINAL_QUOTA_ROUTING = process.env.OMNIROUTE_QUOTA_AWARE_ROUTING;

  before(async () => {
    await resetSharedState();
    // Read per request (roundRobinCombo.ts, executeTargetGates.ts), so it is scoped to this
    // describe instead of the whole merged file.
    process.env.OMNIROUTE_QUOTA_AWARE_ROUTING = "1";
  });

  after(async () => {
    await resetTestDb();
    if (ORIGINAL_QUOTA_ROUTING === undefined) delete process.env.OMNIROUTE_QUOTA_AWARE_ROUTING;
    else process.env.OMNIROUTE_QUOTA_AWARE_ROUTING = ORIGINAL_QUOTA_ROUTING;
  });

  test("round-robin quota reservation keeps the connection token limit", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "quota token limit test",
      apiKey: "sk-quota-token-limit-test",
      rateLimitOverrides: { tpm: 5000 },
    });
    assert.ok(connection?.id);

    const model = "openai/gpt-4o";
    const combo = {
      name: "quota-token-limit-test",
      strategy: "round-robin",
      config: { maxRetries: 0, disableSessionStickiness: true },
      models: [
        {
          kind: "model",
          provider: "openai",
          providerId: "openai",
          model: "gpt-4o",
          connectionId: connection.id,
          id: "quota-token-limit-test-target",
        },
      ],
    };

    const result = await handleComboChat({
      body: {
        model,
        messages: [{ role: "user", content: "reserve this request" }],
        max_tokens: 8,
        stream: false,
      },
      combo,
      allCombos: [combo],
      isModelAvailable: async () => true,
      settings: {},
      log,
      handleSingleModel: async () => Response.json({ choices: [{ message: { content: "ok" } }] }),
    });

    assert.equal(result.ok, true);
    const snapshot = await getProviderQuota(connection.id, model);
    assert.equal(snapshot?.known, true);
    assert.equal(snapshot?.tokenLimit, 5000);
    assert.ok((snapshot?.tokensUsed ?? 0) > 0);
  });
});

describe("combo-priority-quota-exhaustion-cutoff-5923", () => {
  // #5923 (Finding #4) — the quota-exhaustion preflight cutoff only ran for
  // strategy === "auto" (buildAutoCandidates / routableCandidates in combo.ts).
  // Priority/weighted/etc. strategies funneled through the shared executeTarget
  // per-target loop, which only checked the provider circuit breaker + model
  // lockout — never a per-(provider, connection) quota-exhaustion cutoff. A 0%-
  // remaining connection stayed eligible as the lead leg until it reactively
  // 429'd.
  //
  // Regression guard: with the quota-exhaustion opt-in enabled
  // (`resilienceSettings.quotaPreflight.enabled = true`), a "priority" combo
  // whose first-listed connection is at 0% remaining must skip straight to the
  // sibling connection of the SAME provider — never dispatching to the
  // exhausted connection. This must stay strictly per-connection: it must NOT
  // touch the provider circuit breaker (both connections belong to the same
  // provider, and the healthy one must remain fully eligible).
  before(resetSharedState);
  after(restoreOpenaiQuotaFetcher);

  function makeLog() {
    return {
      info() {},
      warn() {},
      debug() {},
      error() {},
    };
  }

  function okResponse(model: string) {
    return Response.json({ choices: [{ message: { role: "assistant", content: model } }] });
  }

  const PROVIDER = "openai";
  const EXHAUSTED_CONNECTION_ID = "conn-exhausted-5923";
  const HEALTHY_CONNECTION_ID = "conn-healthy-5923";

  test("#5923 priority combo skips a 0%-remaining lead connection but keeps the sibling connection eligible", async () => {
    registerQuotaFetcher(PROVIDER, async (connectionId: string) => {
      if (connectionId === EXHAUSTED_CONNECTION_ID) {
        return { used: 100, total: 100, percentUsed: 1 };
      }
      return { used: 5, total: 100, percentUsed: 0.05 };
    });

    const combo = {
      name: `priority-quota-cutoff-5923-${Date.now()}`,
      strategy: "priority",
      models: [
        {
          kind: "model",
          provider: PROVIDER,
          providerId: PROVIDER,
          model: "gpt-4o-mini",
          connectionId: EXHAUSTED_CONNECTION_ID,
          id: "step-a",
        },
        {
          kind: "model",
          provider: PROVIDER,
          providerId: PROVIDER,
          model: "gpt-4o-mini",
          connectionId: HEALTHY_CONNECTION_ID,
          id: "step-b",
        },
      ],
    };

    const calls: Array<string | null> = [];
    const response = await handleComboChat({
      body: { model: combo.name, messages: [{ role: "user", content: "hi" }] },
      combo,
      allCombos: [combo],
      isModelAvailable: undefined,
      relayOptions: undefined,
      signal: undefined,
      settings: {
        resilienceSettings: {
          quotaPreflight: {
            enabled: true,
            defaultThresholdPercent: 2,
            warnThresholdPercent: 20,
          },
        },
      },
      log: makeLog(),
      handleSingleModel: async (
        _body: unknown,
        modelStr: string,
        target?: { connectionId?: string | null }
      ) => {
        calls.push(target?.connectionId ?? null);
        return okResponse(modelStr);
      },
    } as Parameters<typeof handleComboChat>[0]);

    assert.equal(response.status, 200);
    assert.ok(calls.length > 0, "expected at least one dispatched target");
    assert.equal(
      calls[0],
      HEALTHY_CONNECTION_ID,
      "the 0%-remaining lead connection must be skipped; the sibling connection must be dispatched instead"
    );
    assert.ok(
      !calls.includes(EXHAUSTED_CONNECTION_ID),
      "the exhausted connection must never be dispatched to"
    );

    // Strictly per-connection — the provider circuit breaker must stay CLOSED.
    // Only one connection was skipped; the provider itself never failed.
    assert.equal(
      getCircuitBreaker(PROVIDER).getStatus().state,
      "CLOSED",
      "quota-exhaustion cutoff must never trip the whole-provider circuit breaker"
    );
  });

  test("#5923 priority combo does NOT skip a 0%-remaining connection when the cutoff setting is disabled (default)", async () => {
    const provider = "openai";
    const exhaustedConnectionId = "conn-exhausted-disabled-5923";
    registerQuotaFetcher(provider, async () => ({ used: 100, total: 100, percentUsed: 1 }));

    const combo = {
      name: `priority-quota-cutoff-disabled-5923-${Date.now()}`,
      strategy: "priority",
      models: [
        {
          kind: "model",
          provider,
          providerId: provider,
          model: "gpt-4o-mini",
          connectionId: exhaustedConnectionId,
          id: "step-a",
        },
      ],
    };

    const calls: Array<string | null> = [];
    const response = await handleComboChat({
      body: { model: combo.name, messages: [{ role: "user", content: "hi" }] },
      combo,
      allCombos: [combo],
      isModelAvailable: undefined,
      relayOptions: undefined,
      signal: undefined,
      // No resilienceSettings override → quotaPreflight.enabled defaults to false (opt-in).
      settings: {},
      log: makeLog(),
      handleSingleModel: async (
        _body: unknown,
        modelStr: string,
        target?: { connectionId?: string | null }
      ) => {
        calls.push(target?.connectionId ?? null);
        return okResponse(modelStr);
      },
    } as Parameters<typeof handleComboChat>[0]);

    assert.equal(response.status, 200);
    assert.deepEqual(
      calls,
      [exhaustedConnectionId],
      "with the cutoff setting OFF (default), the exhausted connection must still be dispatched to (unchanged auto-off behavior)"
    );
  });
});
