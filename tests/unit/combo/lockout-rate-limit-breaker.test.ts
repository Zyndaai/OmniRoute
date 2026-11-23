// Model lockout, rate-limit classification, Retry-After provenance, provider-breaker and
// terminal-status tests around handleComboChat. Merged from twelve files so combo.ts loads
// once; each original file is one `describe` below, named after the file it came from.
import { after, afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComboLogger } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-lockout-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-combo-lockout-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const FLAG = "RETRY_AFTER_PROVENANCE_ENABLED";
delete process.env[FLAG];

const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const comboModule = await import("../../../open-sse/services/combo.ts");
const { handleComboChat, resolveTargetTimeoutMsForTarget } = comboModule;
const accountFallback = await import("../../../open-sse/services/accountFallback.ts");
const { resolveLockoutScope, parseModelLockKey } =
  await import("../../../open-sse/services/accountFallback/exactModelLock.ts");
const predicates = await import("../../../open-sse/services/combo/comboPredicates.ts");
const rateLimitErrors = await import("../../../open-sse/services/rateLimitManager/errors.ts");
const providerCooldown = await import("../../../open-sse/services/providerCooldownTracker.ts");
const rateLimitSemaphore = await import("../../../open-sse/services/rateLimitSemaphore.ts");
const { createStreamingErrorResult } =
  await import("../../../open-sse/handlers/chatCore/streamErrorResult.ts");
const { shouldTripProviderBreakerForResult } =
  await import("../../../src/sse/handlers/chatPredicates.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const errorUtils = await import("../../../open-sse/utils/error.ts");
const { executeTargetAttempt } =
  await import("../../../open-sse/services/combo/executeTargetAttempt.ts");
const rrState = await import("../../../open-sse/services/combo/rrState.ts");
const circuitBreaker = await import("../../../src/shared/utils/circuitBreaker.ts");
const { getExecutorTimeoutMs, resolveConnectionTimeoutMs, executeWithUpstreamStartTimeout } =
  await import("../../../open-sse/handlers/chatCore/upstreamTimeouts.ts");

after(() => {
  delete process.env[FLAG];
  accountFallback.clearAllModelLockouts();
  circuitBreaker.resetAllCircuitBreakers();
  try {
    core.resetDbInstance();
  } catch {
    /* ignore */
  }
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("model-lockout-5xx-exact-scope", () => {
  /**
   * Model lockout scope by status: a 5xx (transport failure, upstream server error,
   * or OmniRoute's own synthesized 502 from quality validation) locks the exact
   * provider/connection/model tuple, never the quota family — a single bad stream
   * on one codex model must not remove every `gpt-5*` model of the connection from
   * routing. Quota / entitlement statuses (429/403/402) keep the family scope.
   *
   * Harness mirrors the model-lockout-max-cooldown describe (real handleComboChat with a
   * mocked handleSingleModel).
   */
  const {
    recordModelLockoutFailure,
    isModelLocked,
    getModelLockoutInfo,
    getAllModelLockouts,
    clearModelLock,
    decayModelFailureCount,
    clearAllModelLockouts,
  } = accountFallback;

  const CONN = "conn-codex-1";
  const LUNA = "gpt-5.6-luna";
  const SOL = "gpt-5.6-sol";
  const TERRA = "gpt-5.6-terra";

  beforeEach(() => clearAllModelLockouts());
  after(() => clearAllModelLockouts());

  test("resolveLockoutScope: quota statuses → family, everything else → exact, explicit wins", () => {
    for (const status of [429, 403, 402, 404]) {
      assert.equal(resolveLockoutScope(status), "quota_family", `status ${status}`);
    }
    for (const status of [500, 502, 503, 504, 520, 400]) {
      assert.equal(resolveLockoutScope(status), "exact", `status ${status}`);
    }
    assert.equal(resolveLockoutScope(502, "quota_family"), "quota_family");
    assert.equal(resolveLockoutScope(429, "exact"), "exact");
  });

  test("codex 502 on one model locks only that model — sibling gpt-5* models stay routable", () => {
    const lock = recordModelLockoutFailure(
      "codex",
      CONN,
      LUNA,
      "quality_failure",
      502,
      120_000,
      null,
      { maxCooldownMs: 1_800_000 }
    );
    assert.ok(lock.cooldownMs > 0);
    assert.equal(isModelLocked("codex", CONN, LUNA), true, "the failing model is locked");
    assert.equal(isModelLocked("codex", CONN, SOL), false, "sibling scope member stays routable");
    assert.equal(isModelLocked("codex", CONN, TERRA), false);
    assert.equal(isModelLocked("cx", CONN, SOL), false, "alias spelling agrees");
  });

  test("codex 429 on one model still locks the whole quota scope (unchanged)", () => {
    recordModelLockoutFailure("codex", CONN, LUNA, "rate_limit", 429, 120_000, null, {
      maxCooldownMs: 1_800_000,
    });
    assert.equal(isModelLocked("codex", CONN, LUNA), true);
    assert.equal(isModelLocked("codex", CONN, SOL), true, "429 is a scope-wide quota signal");
    assert.equal(isModelLocked("codex", CONN, TERRA), true);
  });

  test("explicit scope option overrides the status default", () => {
    recordModelLockoutFailure("codex", CONN, LUNA, "unknown", 502, 120_000, null, {
      maxCooldownMs: 1_800_000,
      scope: "quota_family",
    });
    assert.equal(isModelLocked("codex", CONN, SOL), true, "caller asked for the family");
  });

  test("exact 5xx lock keeps escalating per failure and decays on success", () => {
    const originalNow = Date.now;
    try {
      let fakeNow = Date.now();
      Date.now = () => fakeNow;
      const first = recordModelLockoutFailure("codex", CONN, LUNA, "unknown", 502, 1000, null, {
        maxCooldownMs: 60_000,
      });
      fakeNow += 1100;
      const second = recordModelLockoutFailure("codex", CONN, LUNA, "unknown", 502, 1000, null, {
        maxCooldownMs: 60_000,
      });
      assert.equal(first.failureCount, 1);
      assert.equal(second.failureCount, 2);
      assert.equal(second.cooldownMs, 2000, "exponential backoff applies to the exact key too");
      assert.equal(getModelLockoutInfo("codex", CONN, LUNA)?.failureCount, 2);

      const decayed = decayModelFailureCount("codex", CONN, LUNA);
      assert.deepEqual(decayed, { cleared: false, newFailureCount: 1 });
      const cleared = decayModelFailureCount("codex", CONN, LUNA);
      assert.deepEqual(cleared, { cleared: true, newFailureCount: 0 });
      assert.deepEqual(decayModelFailureCount("codex", CONN, LUNA), {
        cleared: false,
        newFailureCount: 0,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test("dashboard listing shows the bare model for an exact lock and can clear it by that name", () => {
    recordModelLockoutFailure("codex", CONN, LUNA, "unknown", 503, 120_000, null, {
      maxCooldownMs: 1_800_000,
    });
    const listed = getAllModelLockouts().filter((l) => l.connectionId === CONN);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].provider, "codex");
    assert.equal(listed[0].model, LUNA, "no `exact:` marker leaks into the listing");
    assert.equal(clearModelLock("codex", CONN, listed[0].model), true);
    assert.equal(isModelLocked("codex", CONN, LUNA), false);
    assert.deepEqual(parseModelLockKey("codex:c1:exact:gpt-5.6-luna"), {
      provider: "codex",
      connectionId: "c1",
      model: "gpt-5.6-luna",
      scope: "exact",
    });
    assert.deepEqual(parseModelLockKey("codex:c1:codex"), {
      provider: "codex",
      connectionId: "c1",
      model: "codex",
      scope: "quota_family",
    });
  });

  test("handleComboChat: a 502 on one codex model leaves a sibling combo on the same scope dispatchable", async () => {
    const settings = {
      modelLockout: {
        enabled: true,
        errorCodes: [502],
        baseCooldownMs: 120_000,
        maxCooldownMs: 1_800_000,
        maxBackoffSteps: 10,
        useExponentialBackoff: true,
      },
    };
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const run = (model: string, status: number) =>
      handleComboChat({
        body: {},
        combo: {
          name: `scope-${model}`,
          strategy: "priority",
          models: [`codex/${model}`],
          config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
        },
        handleSingleModel: async () =>
          new Response(
            JSON.stringify(status === 200 ? { ok: true } : { error: { message: "x" } }),
            {
              status,
              headers: { "content-type": "application/json" },
            }
          ),
        isModelAvailable: async () => true,
        log: log as unknown as ComboLogger,
        settings,
        allCombos: null,
      });

    const failed = await run(LUNA, 502);
    assert.notEqual(failed.status, 200);
    assert.equal(isModelLocked("codex", "", LUNA), true, "the failing model is locked");
    assert.equal(isModelLocked("codex", "", SOL), false, "sibling is not");

    const ok = await run(SOL, 200);
    assert.equal(ok.status, 200, "the sibling model still dispatches");
  });
});

describe("model-lockout-max-cooldown", () => {
  const { recordModelLockoutFailure, getModelLockoutInfo, clearAllModelLockouts } = accountFallback;

  function createLog() {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  function errorResponse(status: number, message: string = `Error ${status}`) {
    return new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function seedConnection(provider: string, overrides: any = {}): Promise<any> {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: overrides.apiKey || `sk-test-${Math.random().toString(16).slice(2, 8)}`,
      isActive: true,
      testStatus: "active",
      rateLimitedUntil: null,
      backoffLevel: overrides.backoffLevel || 0,
      providerSpecificData: overrides.providerSpecificData || {},
    });
  }

  async function resetStorage() {
    await resetTestDb();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  beforeEach(async () => {
    clearAllModelLockouts();
    await resetStorage();
  });

  after(() => {
    clearAllModelLockouts();
  });

  test("recordModelLockoutFailure honors maxCooldownMs option parameter", () => {
    const provider = "openai";
    const connectionId = "conn-s1";
    const model = "gpt-4";

    const first = recordModelLockoutFailure(
      provider,
      connectionId,
      model,
      "rate_limited",
      429,
      500,
      null,
      {
        maxCooldownMs: 1500,
      }
    );
    assert.equal(first.cooldownMs, 500);

    const originalNow = Date.now;
    try {
      let fakeNow = Date.now();
      Date.now = () => fakeNow;

      fakeNow += 600;
      const second = recordModelLockoutFailure(
        provider,
        connectionId,
        model,
        "rate_limited",
        429,
        500,
        null,
        {
          maxCooldownMs: 1500,
        }
      );
      assert.equal(second.cooldownMs, 1000);

      fakeNow += 1100;
      const third = recordModelLockoutFailure(
        provider,
        connectionId,
        model,
        "rate_limited",
        429,
        500,
        null,
        {
          maxCooldownMs: 1500,
        }
      );
      assert.equal(third.cooldownMs, 1500);
    } finally {
      Date.now = originalNow;
    }
  });

  test("handleComboChat quality failure model lockout honors maxCooldownMs settings", async () => {
    const provider = "openai";
    const model = "gpt-4";

    const customSettings = {
      modelLockout: {
        enabled: true,
        errorCodes: [502],
        baseCooldownMs: 3000,
        maxCooldownMs: 5000,
        maxBackoffSteps: 10,
        useExponentialBackoff: true,
      },
    };

    const logs = createLog();
    const executeComboWithFailure = async () => {
      return handleComboChat({
        body: {},
        combo: {
          name: "test-combo",
          strategy: "priority",
          models: [`${provider}/${model}`],
          config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
        },
        handleSingleModel: async () => {
          return errorResponse(502);
        },
        isModelAvailable: async () => true,
        log: logs as any,
        settings: customSettings,
        allCombos: null,
      });
    };

    const originalNow = Date.now;
    try {
      let fakeNow = Date.now();
      Date.now = () => fakeNow;

      await executeComboWithFailure();
      let info = getModelLockoutInfo(provider, "", model);
      assert.ok(info && info.remainingMs <= 3000);

      fakeNow += 3100;
      await executeComboWithFailure();
      info = getModelLockoutInfo(provider, "", model);
      assert.ok(info);
      assert.ok(
        info!.remainingMs <= 5000,
        `Expected remainingMs to be capped at 5000, but got ${info!.remainingMs}`
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("markAccountUnavailable local 404 lockout honors maxCooldownMs settings", async () => {
    const provider = "openai";
    const model = "local-gpt-4";
    const connection = (await seedConnection(provider, {
      providerSpecificData: { baseUrl: "http://127.0.0.1:8080/v1" },
    })) as any;

    await settingsDb.updateSettings({
      modelLockout: {
        enabled: true,
        errorCodes: [404],
        baseCooldownMs: 3000,
        maxCooldownMs: 5000,
        maxBackoffSteps: 10,
        useExponentialBackoff: true,
      },
    });

    const originalNow = Date.now;
    try {
      let fakeNow = Date.now();
      Date.now = () => fakeNow;

      await auth.markAccountUnavailable(connection.id as string, 404, "not found", provider, model);
      let info = getModelLockoutInfo(provider, connection.id as string, model);
      assert.ok(info && info.remainingMs <= 3000);

      fakeNow += 3100;
      await providersDb.updateProviderConnection(connection.id as string, {
        rateLimitedUntil: null,
      });
      await auth.markAccountUnavailable(connection.id as string, 404, "not found", provider, model);
      info = getModelLockoutInfo(provider, connection.id as string, model);
      assert.ok(info);
      assert.ok(
        info!.remainingMs <= 5000,
        `Expected remainingMs to be capped at 5000, but got ${info!.remainingMs}`
      );
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("rate-limit-local-capacity-classification", () => {
  const { isLocalQueueCapacityErrorBody, isRequestScopedUpstreamFailure, shouldSkipConnDisable } =
    predicates;

  function localQueueResponse() {
    return new Response(
      JSON.stringify({
        error: {
          message: "Local rate-limit queue wait exceeded",
          code: "RATE_LIMIT_QUEUE_TIMEOUT",
          type: "local_queue_capacity",
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } }
    );
  }

  function createLog() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  test("local queue capacity is request-scoped and never disables a healthy connection", () => {
    assert.equal(
      isRequestScopedUpstreamFailure({
        code: "RATE_LIMIT_QUEUE_TIMEOUT",
        type: "local_queue_capacity",
      }),
      true
    );
    assert.equal(
      shouldSkipConnDisable(
        {
          status: 429,
          errorCode: "RATE_LIMIT_QUEUE_TIMEOUT",
          errorType: "local_queue_capacity",
        },
        false,
        false,
        "nvidia"
      ),
      true
    );
    assert.equal(
      isLocalQueueCapacityErrorBody({
        error: { code: "RATE_LIMIT_QUEUE_TIMEOUT", type: "local_queue_capacity" },
      }),
      true
    );
  });

  test("combo returns a local queue capacity response without retrying or rotating targets", async () => {
    let calls = 0;
    const response = await handleComboChat({
      body: { model: "openai/gpt-4" },
      combo: {
        name: `local-queue-capacity-${Math.random().toString(16).slice(2)}`,
        strategy: "priority",
        models: ["openai/gpt-4", "openai/gpt-4o-mini"],
        config: { maxRetries: 2, maxSetRetries: 1, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () => {
        calls += 1;
        return localQueueResponse();
      },
      isModelAvailable: async () => true,
      log: createLog() as never,
      settings: {},
      allCombos: null,
    });

    assert.equal(response.status, 429);
    assert.equal(calls, 1, "a local queue limit must not amplify into retries or fallback calls");
    const body = await response.json();
    assert.equal(body.error.code, "RATE_LIMIT_QUEUE_TIMEOUT");
    assert.equal(body.error.type, "local_queue_capacity");
  });
});

describe("rate-limit-local-error-classification", () => {
  const {
    isComboRequestScopedFailure,
    isRequestScopedUpstreamFailure,
    shouldRecordProviderBreakerFailure,
    shouldSkipConnDisable,
  } = predicates;
  const {
    LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
    RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
    RATE_LIMIT_QUEUE_WEDGED_CODE,
    getTrustedLocalRateLimitError,
    getTrustedLocalRateLimitResponse,
    inheritTrustedLocalRateLimitResponse,
    markLocalRateLimitError,
    markTrustedLocalRateLimitResponse,
  } = rateLimitErrors;

  const LOCAL_ERROR_MESSAGE = "OmniRoute repaired a local limiter queue";

  function createLocalLimiterSseResponse(
    connectionId: string,
    code = RATE_LIMIT_QUEUE_WEDGED_CODE
  ) {
    const error = markLocalRateLimitError(new Error(LOCAL_ERROR_MESSAGE), code);
    const { response } = createStreamingErrorResult(
      getTrustedLocalRateLimitError(error)?.status ?? 503,
      LOCAL_ERROR_MESSAGE,
      code,
      "rate_limit_queue_wedged"
    );
    response.headers.set("X-OmniRoute-Selected-Connection-Id", connectionId);
    return markTrustedLocalRateLimitResponse(response, error);
  }

  function createUpstreamCollisionResponse(connectionId: string) {
    return new Response(
      JSON.stringify({
        error: {
          message: "Provider emitted a colliding code",
          code: RATE_LIMIT_QUEUE_WEDGED_CODE,
          type: "rate_limit_queue_wedged",
        },
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "X-OmniRoute-Selected-Connection-Id": connectionId,
        },
      }
    );
  }

  function createSuccessResponse(connectionId: string) {
    return new Response(JSON.stringify({ choices: [{ message: { content: "fallback ok" } }] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "X-OmniRoute-Selected-Connection-Id": connectionId,
      },
    });
  }

  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const settings = {
    modelLockout: {
      enabled: true,
      errorCodes: [503],
      baseCooldownMs: 3_000,
      maxCooldownMs: 5_000,
      maxBackoffSteps: 10,
      useExponentialBackoff: true,
    },
  };

  async function resetLocalState() {
    accountFallback.clearAllModelLockouts();
    accountFallback.clearProviderFailure("openai");
    providerCooldown.clearCooldownState();
    rateLimitSemaphore.resetAll();
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  beforeEach(resetLocalState);
  afterEach(resetLocalState);

  test("execution-timeout classification requires trusted provenance; queue codes classify by string (#9164/#9342)", () => {
    const executionError = markLocalRateLimitError(
      new Error("local execution expiration"),
      RATE_LIMIT_EXECUTION_TIMEOUT_CODE
    );
    const localResponse = markTrustedLocalRateLimitResponse(
      new Response("local", { status: 504 }),
      executionError
    );
    const collisionResponse = createUpstreamCollisionResponse("collision-conn");

    assert.deepEqual(getTrustedLocalRateLimitError(executionError), {
      code: RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
      status: 504,
    });
    assert.equal(getTrustedLocalRateLimitResponse(localResponse)?.status, 504);
    const wrappedResponse = inheritTrustedLocalRateLimitResponse(
      localResponse,
      new Response("wrapped local", { status: 504 })
    );
    assert.equal(getTrustedLocalRateLimitResponse(wrappedResponse)?.status, 504);
    assert.equal(
      isRequestScopedUpstreamFailure({ code: RATE_LIMIT_EXECUTION_TIMEOUT_CODE }),
      false,
      "an upstream-controlled code string must not establish local provenance"
    );
    assert.equal(
      isComboRequestScopedFailure(localResponse, "local execution expiration", {
        code: RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
      }),
      true
    );
    // #9164 (3898305df0) deliberately widened the contract: the rate_limit_queue_*
    // code strings are OmniRoute-owned backpressure codes and classify as
    // request-scoped even without WeakMap provenance (an upstream collision is
    // accepted as fail-safe: worst case a colliding provider 503 skips health
    // penalties, it never amplifies into fallback storms).
    assert.equal(
      isComboRequestScopedFailure(collisionResponse, "provider collision", {
        code: RATE_LIMIT_QUEUE_WEDGED_CODE,
      }),
      true
    );
    assert.equal(
      shouldTripProviderBreakerForResult(
        {
          status: 504,
          response: localResponse,
          errorCode: RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
        },
        false,
        false
      ),
      false
    );
    assert.equal(
      shouldTripProviderBreakerForResult(
        {
          status: 503,
          response: collisionResponse,
          errorCode: RATE_LIMIT_QUEUE_WEDGED_CODE,
        },
        false,
        false
      ),
      false,
      "#9342 (47c819df66): RATE_LIMIT_QUEUE_* codes are OmniRoute backpressure and never trip the provider breaker, provenance or not"
    );
    assert.equal(
      shouldSkipConnDisable(
        {
          status: 504,
          response: localResponse,
          errorCode: RATE_LIMIT_EXECUTION_TIMEOUT_CODE,
        },
        false,
        false,
        "openai"
      ),
      true
    );
    assert.equal(
      shouldSkipConnDisable(
        {
          status: 503,
          response: collisionResponse,
          errorCode: RATE_LIMIT_QUEUE_WEDGED_CODE,
        },
        false,
        false,
        "openai"
      ),
      true,
      "#9164: the queue-code string alone marks the failure request-scoped, so the connection is not disabled"
    );
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 504,
        sameProviderNext: false,
        skipProviderBreaker: false,
        requestScopedFailure: true,
        error: executionError,
        isProxyUnreachable: false,
      }),
      false
    );
  });

  test("legacy queue-timeout code classifies as request-scoped with or without provenance (#9164)", () => {
    const untrusted = new Response("legacy collision", { status: 503 });
    const legacyError = markLocalRateLimitError(
      new Error("legacy local timeout"),
      LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE
    );
    const trusted = markTrustedLocalRateLimitResponse(
      new Response("legacy local timeout", { status: 503 }),
      legacyError
    );

    // #9164 added rate_limit_queue_timeout to REQUEST_SCOPED_UPSTREAM_ERROR_CODES,
    // so the code string is sufficient — trusted provenance is no longer required
    // for this classification (it still works, next assertion).
    assert.equal(
      isComboRequestScopedFailure(untrusted, "legacy collision", {
        code: LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
      }),
      true
    );
    assert.equal(
      isComboRequestScopedFailure(trusted, "legacy local timeout", {
        code: LEGACY_RATE_LIMIT_QUEUE_TIMEOUT_CODE,
      }),
      true
    );
  });

  for (const strategy of ["priority", "round-robin"] as const) {
    test(`${strategy} fallback preserves all health state for a trusted local SSE failure`, async () => {
      const connection = await providersDb.createProviderConnection({
        provider: "openai",
        authType: "apikey",
        name: `local-wedge-${strategy}`,
        apiKey: `sk-local-wedge-${strategy}`,
        isActive: true,
        testStatus: "active",
        rateLimitedUntil: null,
        backoffLevel: 0,
        providerSpecificData: {},
      });
      const models = [
        {
          kind: "model",
          model: "openai/gpt-local-first",
          connectionId: connection.id,
        },
        {
          kind: "model",
          model: "openai/gpt-local-second",
          connectionId: connection.id,
        },
      ];
      const calls: string[] = [];

      const result = await handleComboChat({
        body: {},
        combo: {
          name: `local-wedge-${strategy}-combo`,
          strategy,
          models,
          config: {
            maxRetries: 1,
            retryDelayMs: 0,
            fallbackDelayMs: 0,
            maxConcurrency: 1,
          },
        },
        handleSingleModel: async (_body, modelStr) => {
          calls.push(modelStr);
          return calls.length === 1
            ? createLocalLimiterSseResponse(connection.id)
            : createSuccessResponse(connection.id);
        },
        isModelAvailable: async () => true,
        log,
        settings,
        allCombos: null,
      });

      assert.equal(result.status, 200, `attempted targets: ${calls.join(", ")}`);
      assert.deepEqual(calls, ["openai/gpt-local-first", "openai/gpt-local-second"]);
      assert.equal(
        accountFallback.isModelLocked("openai", connection.id, "gpt-local-first"),
        false
      );
      assert.equal(
        accountFallback.getProviderBreakerState("openai")?.failureCount ?? 0,
        0,
        "local failure must not increment the provider breaker"
      );
      assert.equal(
        providerCooldown.isProviderInCooldown("openai", connection.id),
        false,
        "local failure must not enter provider cooldown"
      );
      const semaphoreStates = Object.values(rateLimitSemaphore.getStats());
      assert.equal(
        semaphoreStates.some((state) => state.rateLimitedUntil !== null),
        false,
        "local failure must not cool a round-robin semaphore"
      );
      const storedConnection = await providersDb.getProviderConnectionById(connection.id);
      assert.equal(storedConnection?.testStatus, "active");
      assert.equal(storedConnection?.rateLimitedUntil ?? null, null);
    });
  }

  test("an upstream body colliding with local queue codes is treated as local backpressure (#9164)", async () => {
    const connection = await providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "upstream-local-code-collision",
      apiKey: "sk-upstream-local-code-collision",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });

    const result = await handleComboChat({
      body: {},
      combo: {
        name: "upstream-local-code-collision-combo",
        strategy: "priority",
        models: [
          {
            kind: "model",
            model: "openai/gpt-collision",
            connectionId: connection.id,
          },
        ],
        config: { maxRetries: 1, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () => createUpstreamCollisionResponse(connection.id),
      isModelAvailable: async () => true,
      log,
      settings,
      allCombos: null,
    });

    assert.equal(result.status, 503);
    // #9164 (3898305df0): isLocalQueueCapacityErrorBody matches the queue-code
    // string in the body, so the combo returns the 503 without upstream fallback
    // and without counting it toward provider health — the collision is accepted
    // as fail-safe (no breaker/cooldown penalties, but also no retry amplification).
    assert.equal(
      accountFallback.getProviderBreakerState("openai")?.failureCount ?? 0,
      0,
      "a queue-code collision body is classified local backpressure and skips breaker accounting"
    );
    const storedConnection = await providersDb.getProviderConnectionById(connection.id);
    assert.equal(storedConnection?.testStatus, "active", "the connection must not be disabled");
  });
});

describe("rate-limit-queue-timeout-lockout", () => {
  function createLog() {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  async function seedConnection(provider: string, overrides: any = {}): Promise<any> {
    return providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: overrides.name || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: overrides.apiKey || `sk-test-${Math.random().toString(16).slice(2, 8)}`,
      isActive: true,
      testStatus: "active",
      rateLimitedUntil: null,
      backoffLevel: overrides.backoffLevel || 0,
      providerSpecificData: overrides.providerSpecificData || {},
    });
  }

  function errorResponseWithoutConnectionId(status: number) {
    return new Response(JSON.stringify({ error: { message: "Local queue timeout" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function errorResponseWithConnectionId(status: number, connectionId: string) {
    return new Response(JSON.stringify({ error: { message: "Local queue timeout" } }), {
      status,
      headers: {
        "content-type": "application/json",
        "X-OmniRoute-Selected-Connection-Id": connectionId,
      },
    });
  }

  beforeEach(() => accountFallback.clearAllModelLockouts());
  afterEach(() => {
    accountFallback.clearAllModelLockouts();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  test("RATE_LIMIT_QUEUE_TIMEOUT lockout behaves correctly depending on connection ID header", async () => {
    const { isModelLocked, clearAllModelLockouts } = accountFallback;
    const provider = "openai";
    const model = "gpt-4";

    // Seed the connection first!
    const connection = await seedConnection(provider);
    const connectionId = connection.id;

    const customSettings = {
      modelLockout: {
        enabled: true,
        errorCodes: [502, 520],
        baseCooldownMs: 3000,
        maxCooldownMs: 5000,
        maxBackoffSteps: 10,
        useExponentialBackoff: true,
      },
    };

    const logs = createLog();

    // Scenario 1: Response lacks connection ID header (Current buggy behavior)
    await handleComboChat({
      body: {},
      combo: {
        name: "test-combo",
        strategy: "priority",
        models: [`${provider}/${model}`],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () => {
        return errorResponseWithoutConnectionId(502);
      },
      isModelAvailable: async () => true,
      log: logs as any,
      settings: customSettings,
      allCombos: null,
    });

    // Verify that the model is NOT locked for the actual connection connectionId
    const lockedForConnBuggy = isModelLocked(provider, connectionId, model);
    assert.equal(
      lockedForConnBuggy,
      false,
      "Model should not be locked for actual connection when header is missing"
    );

    // Verify that it got locked under the empty string connectionId ""
    const lockedForEmptyBuggy = isModelLocked(provider, "", model);
    assert.equal(
      lockedForEmptyBuggy,
      true,
      "Model is incorrectly locked under empty string connectionId when header is missing"
    );

    clearAllModelLockouts();

    await handleComboChat({
      body: {},
      combo: {
        name: "test-combo",
        strategy: "priority",
        models: [`${provider}/${model}`],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () => {
        return errorResponseWithConnectionId(502, connectionId);
      },
      isModelAvailable: async () => true,
      log: logs as any,
      settings: customSettings,
      allCombos: null,
    });

    // Verify that the model IS locked for the actual connection
    const lockedForConnFixed = isModelLocked(provider, connectionId, model);
    assert.equal(lockedForConnFixed, true, "Model should be locked for the correct connection ID");
  });
});

describe("vertex-shared-capacity-429-combo-lockout", () => {
  const { clearAllModelLockouts, isModelLocked } = accountFallback;

  // Vertex answers a bare RESOURCE_EXHAUSTED "try again later" 429 when the whole region is busy.
  // It says nothing about this account, so the combo must not lock the model for it (the account
  // path in auth.ts already skips the lockout for the same body).
  const SHARED =
    '{"error":{"code":429,"message":"Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.","status":"RESOURCE_EXHAUSTED"}}';
  const QUOTA =
    '{"error":{"code":429,"message":"Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model.","status":"RESOURCE_EXHAUSTED"}}';
  const WITH_RETRY_INFO =
    '{"error":{"code":429,"message":"Resource exhausted. Please try again later.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}';
  // handleChat does not hand the combo the upstream body. It returns the client-safe error JSON built
  // by createErrorResult: the message is kept, `status` and `details` are gone, and a parsed retry
  // hint rides the Retry-After header. Build the responses the same way, so these tests follow the
  // production response path.
  const { createErrorResult } = errorUtils;
  const clientSafe = (upstream: string, retryAfterMs: number | null = null) => {
    const { response } = createErrorResult(429, JSON.parse(upstream).error.message, retryAfterMs);
    return { body: response.text(), retryAfter: response.headers.get("retry-after") };
  };
  const MODEL = "gemini-2.5-pro";
  const SETTINGS = {
    modelLockout: {
      enabled: true,
      errorCodes: [429, 503],
      baseCooldownMs: 3000,
      maxCooldownMs: 5000,
      maxBackoffSteps: 10,
      useExponentialBackoff: true,
    },
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} };

  beforeEach(() => clearAllModelLockouts());
  after(() => clearAllModelLockouts());

  async function runCombo(
    provider: string,
    status: number,
    body: string | Promise<string>,
    maxRetries = 0,
    extraHeaders: Record<string, string> = {}
  ) {
    const text = await body;
    const connection = await providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: `sk-test-${Math.random().toString(16).slice(2, 8)}`,
      isActive: true,
      testStatus: "active",
    });
    const connectionId = connection.id as string;
    await handleComboChat({
      body: {},
      combo: {
        name: "vertex-shared-429",
        strategy: "priority",
        models: [`${provider}/${MODEL}`],
        // These tests assert whether the 429 records a model lockout. The cooldown-aware
        // re-dispatch (default on, covered by combo-cooldown-retry.test.ts) would otherwise wait
        // out the 30 s Retry-After hint five times in real time (~150 s per hinted test).
        config: {
          maxRetries,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          comboCooldownWaitEnabled: false,
        },
      },
      handleSingleModel: async () =>
        new Response(text, {
          status,
          headers: {
            ...extraHeaders,
            "content-type": "application/json",
            "X-OmniRoute-Selected-Connection-Id": connectionId,
          },
        }),
      isModelAvailable: async () => true,
      log,
      settings: SETTINGS,
      allCombos: null,
    });
    return isModelLocked(provider, connectionId, MODEL);
  }

  for (const provider of ["vertex", "vertex-partner"]) {
    test(`${provider}: a shared-capacity 429 does not lock the model in the combo`, async () => {
      assert.equal(await runCombo(provider, 429, SHARED), false);
    });

    test(`${provider}: a quota 429 still locks the model in the combo`, async () => {
      assert.equal(await runCombo(provider, 429, QUOTA), true);
    });

    test(`${provider}: a 429 with retry details still locks the model in the combo`, async () => {
      assert.equal(await runCombo(provider, 429, WITH_RETRY_INFO), true);
    });
  }

  test("vertex: with retries enabled a shared-capacity 429 still leaves the model unlocked", async () => {
    assert.equal(await runCombo("vertex", 429, SHARED, 1), false);
  });

  test("vertex: with retries enabled a quota 429 still locks the model", async () => {
    assert.equal(await runCombo("vertex", 429, QUOTA, 1), true);
  });

  test("the same body on another provider still locks the model in the combo", async () => {
    assert.equal(await runCombo("gemini", 429, SHARED), true);
  });

  test("a 503 with the same body on vertex still locks the model in the combo", async () => {
    assert.equal(await runCombo("vertex", 503, SHARED), true);
  });

  for (const provider of ["vertex", "vertex-partner"]) {
    test(`${provider}: the client-safe shared-capacity 429 that handleChat returns does not lock the model`, async () => {
      assert.equal(await runCombo(provider, 429, clientSafe(SHARED).body), false);
    });

    test(`${provider}: the client-safe quota 429 that handleChat returns still locks the model`, async () => {
      assert.equal(await runCombo(provider, 429, clientSafe(QUOTA).body), true);
    });

    test(`${provider}: a client-safe 429 that carries a retry hint still locks the model`, async () => {
      // WITH_RETRY_INFO has details, so the pipeline sets Retry-After on the rebuilt response.
      const hinted = clientSafe(WITH_RETRY_INFO, 30_000);
      assert.equal(hinted.retryAfter, "30");
      assert.equal(
        await runCombo(provider, 429, hinted.body, 0, { "retry-after": hinted.retryAfter ?? "" }),
        true
      );
    });
  }

  test("the client-safe shared-capacity body on another provider still locks the model", async () => {
    assert.equal(await runCombo("gemini", 429, clientSafe(SHARED).body), true);
  });
});

describe("retry-after-provenance", () => {
  /**
   * #13672 — Retry-After provenance on aggregated unavailable responses, opt-in via
   * RETRY_AFTER_PROVENANCE_ENABLED (default off).
   *
   * Flag off: unavailableResponse keeps the legacy header contract (always present,
   * clamped to >= 1s) and now adds structured retry fields only for a concrete future
   * signal; combo drain paths read those fields without enabling prose parsing.
   * Flag on: no concrete future retry time → no Retry-After header (never a synthetic 1s,
   * never "1" for an elapsed date); body carries error.retry_after_provenance; combo drain
   * paths also read prose hints from JSON and plain-text bodies.
   */
  const { unavailableResponse, parseProseRetryDelayMs, readProseRetryAfter } = errorUtils;

  function withFlag<T>(on: boolean, fn: () => T): T {
    if (on) process.env[FLAG] = "true";
    else delete process.env[FLAG];
    return fn();
  }

  afterEach(() => {
    delete process.env[FLAG];
  });

  const HOUR = 3_600_000;
  type Input = string | number | Date | null | undefined;
  const NO_SIGNAL: Array<[string, Input]> = [
    ["null", null],
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -3],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["numeric string", "5"],
    ["empty string", ""],
    ["garbage string", "abc"],
    ["past ISO", new Date(Date.now() - HOUR).toISOString()],
    ["past Date", new Date(Date.now() - HOUR)],
    ["past epoch ms", Date.now() - HOUR],
  ];
  const SIGNAL: Array<[string, Input]> = [
    ["seconds", 2],
    ["future ISO", new Date(Date.now() + HOUR).toISOString()],
    ["future Date", new Date(Date.now() + HOUR)],
    ["future epoch ms", Date.now() + HOUR],
  ];

  async function readBody(res: Response) {
    return (await res.json()) as { error: Record<string, unknown> };
  }

  test("flag off: unavailableResponse keeps the legacy header and adds real reset timing", async () => {
    for (const [label, input] of [...NO_SIGNAL, ...SIGNAL]) {
      const res = withFlag(false, () => unavailableResponse(429, "drained", input));
      const header = res.headers.get("Retry-After");
      assert.ok(header !== null && Number(header) >= 1, `legacy header for ${label}: ${header}`);
      const body = await readBody(res);
      assert.equal(body.error.message, "drained", label);
      if (SIGNAL.some(([signalLabel]) => signalLabel === label)) {
        assert.equal(body.error.retry_after, Number(header), label);
        assert.equal(typeof body.error.reset_at, "string", label);
      } else {
        assert.equal("retry_after" in body.error, false, label);
        assert.equal("reset_at" in body.error, false, label);
      }
    }
    const nullRes = withFlag(false, () => unavailableResponse(503, "busy", null));
    assert.equal(nullRes.headers.get("Retry-After"), "1");
    const pastRes = withFlag(false, () =>
      unavailableResponse(429, "drained", new Date(Date.now() - HOUR).toISOString())
    );
    assert.equal(pastRes.headers.get("Retry-After"), "1");
    await nullRes.body?.cancel();
    await pastRes.body?.cancel();
  });

  test("flag on: no concrete future retry time omits Retry-After and says none", async () => {
    for (const [label, input] of NO_SIGNAL) {
      const res = withFlag(true, () => unavailableResponse(429, "drained", input));
      assert.equal(res.headers.get("Retry-After"), null, `no header for ${label}`);
      const body = await readBody(res);
      assert.equal(body.error.retry_after_provenance, "none", label);
      assert.equal(body.error.message, "drained");
    }
  });

  test("flag on: a concrete future retry time keeps the legacy header value and says signal", async () => {
    for (const [label, input] of SIGNAL) {
      const legacy = withFlag(false, () => unavailableResponse(429, "drained", input));
      const res = withFlag(true, () => unavailableResponse(429, "drained", input));
      const header = res.headers.get("Retry-After");
      assert.ok(header !== null, `header for ${label}`);
      assert.ok(
        Math.abs(Number(header) - Number(legacy.headers.get("Retry-After"))) <= 1,
        `${label}: ${header} vs legacy ${legacy.headers.get("Retry-After")}`
      );
      assert.equal((await readBody(res)).error.retry_after_provenance, "signal", label);
      await legacy.body?.cancel();
    }
  });

  test("parseProseRetryDelayMs reads Antigravity and generic prose, caps at 24h", () => {
    assert.equal(
      parseProseRetryDelayMs("Your quota will reset after 2h7m23s."),
      (2 * 3600 + 7 * 60 + 23) * 1000
    );
    assert.equal(parseProseRetryDelayMs("Rate limited. Please retry after 30 seconds"), 30_000);
    assert.equal(parseProseRetryDelayMs("quota will reset after 90h"), 24 * HOUR);
    assert.equal(parseProseRetryDelayMs("<html><body>502 Bad Gateway</body></html>"), null);
    assert.equal(parseProseRetryDelayMs(""), null);
    assert.equal(parseProseRetryDelayMs(undefined), null);
  });

  test("readProseRetryAfter is inert with the flag off", () => {
    assert.equal(
      withFlag(false, () => readProseRetryAfter("retry after 30s")),
      null
    );
    const iso = withFlag(true, () => readProseRetryAfter("retry after 30s"));
    assert.ok(iso && Math.abs(Date.parse(iso) - (Date.now() + 30_000)) < 5_000);
  });

  type Logged = { level: string; args: unknown[] };

  function attemptFixture(response: () => Response) {
    const logs: Logged[] = [];
    const push =
      (level: string) =>
      (...args: unknown[]) =>
        logs.push({ level, args });
    const target = {
      kind: "model",
      stepId: "s1",
      executionKey: "ek-13672",
      modelStr: "openai/gpt-4o",
      provider: "openai",
      providerId: null,
      connectionId: "c-13672",
      weight: 1,
      label: null,
    };
    const deps = {
      strategy: "priority",
      combo: { name: "t13672", models: [] },
      config: {},
      log: { info: push("info"), warn: push("warn"), debug: push("debug"), error: push("error") },
      settings: null,
      resilienceSettings: { providerCooldown: { enabled: false } },
      sticky: { targets: [], messageHash: null, stuck: false },
      effectiveSessionId: null,
      preScreenMap: new Map(),
      quotaCutoffResetWindowConfig: {},
      maxRetries: 0,
      traceInvocationId: "inv-13672",
      clientRequestedStream: false,
      handleSingleModelWithTimeout: async () => response(),
      body: { messages: [{ role: "user", content: "hi" }] },
      startTime: Date.now(),
      releaseStickyPinOnFailure() {},
      clearStaleLKGP() {},
    };
    const state = {
      orderedTargets: [target],
      fallbackCount: 0,
      recordedAttempts: 0,
      comboErrors: [],
      lastError: null,
      lastStatus: null,
      earliestRetryAfter: null as string | null,
      comboExpired: false,
      exhaustedProviders: new Set(),
      exhaustedConnections: new Set(),
      transientRateLimitedProviders: new Set(),
      abortControllers: new Map([[0, new AbortController()]]),
      dispatchedTargets: new Set(),
      targetFailureTrust: new Map(),
      comboAttemptOrder: [],
      skippedForCircuitOpen: false,
      earliestCircuitOpenRetryMs: 0,
      globalAttempts: 0,
      observedFailure: false,
      allObservedFailuresQuota: true,
      observeFailure() {},
    };
    const run = () =>
      executeTargetAttempt({
        index: 0,
        state,
        deps,
        targetForAttempt: target,
        profile: {},
        protectedPriorityTarget: false,
      } as unknown as Parameters<typeof executeTargetAttempt>[0]);
    return { state, logs, run };
  }

  const hintLogs = (logs: Logged[], level: string) =>
    logs.filter((l) => l.level === level && /Retry hint unreadable/.test(String(l.args[1])));

  const antigravityJson = () =>
    new Response(
      JSON.stringify({
        error: {
          message: "You have exhausted your capacity. Your quota will reset after 2h7m23s.",
        },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  const plainText429 = () =>
    new Response("Too many requests. Please retry after 30s", { status: 429 });

  test("drain path: JSON prose hint feeds earliestRetryAfter only with the flag on", async () => {
    const off = attemptFixture(antigravityJson);
    await withFlag(false, off.run);
    assert.equal(off.state.earliestRetryAfter, null, "flag off: legacy ignores prose");

    const on = attemptFixture(antigravityJson);
    await withFlag(true, on.run);
    const expected = Date.now() + (2 * 3600 + 7 * 60 + 23) * 1000;
    assert.ok(on.state.earliestRetryAfter, "flag on: prose hint recorded");
    assert.ok(Math.abs(Date.parse(on.state.earliestRetryAfter) - expected) < 10_000);
  });

  test("drain path: a plain-text (non-JSON) prose hint is read with the flag on", async () => {
    const off = attemptFixture(plainText429);
    await withFlag(false, off.run);
    assert.equal(off.state.earliestRetryAfter, null);

    const on = attemptFixture(plainText429);
    await withFlag(true, on.run);
    assert.ok(on.state.earliestRetryAfter, "plain-text hint recorded");
    assert.ok(Math.abs(Date.parse(on.state.earliestRetryAfter) - (Date.now() + 30_000)) < 10_000);
  });

  test("drain path: an HTML 502 page logs at debug, never warn", async () => {
    const html = attemptFixture(
      () => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502 })
    );
    await withFlag(true, html.run);
    assert.equal(hintLogs(html.logs, "warn").length, 0, "no warn for an ordinary non-JSON body");
    assert.equal(hintLogs(html.logs, "debug").length, 1);
    assert.equal(html.state.earliestRetryAfter, null);
  });

  test("drain path: a failed clone still warns", async () => {
    const bad = new Response("plain 429", { status: 429 });
    Object.defineProperty(bad, "clone", {
      value() {
        throw new Error("clone boom");
      },
    });
    const fx = attemptFixture(() => bad);
    await fx.run();
    assert.equal(hintLogs(fx.logs, "warn").length, 1);
  });

  test("priority combo falls back when an upstream Retry-After exceeds the date range", async () => {
    const calls: string[] = [];
    const models = ["openai/overflow-retry-header", "claude/healthy-fallback"];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      combo: {
        name: "retry-after-overflow",
        strategy: "priority",
        models,
        config: {
          maxRetries: 0,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
          disableSessionStickiness: true,
        },
      },
      allCombos: null,
      settings: null,
      isModelAvailable: async () => true,
      log: { info() {}, warn() {}, debug() {}, error() {} },
      handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
        calls.push(modelStr);
        if (modelStr === models[0]) {
          return new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "9999999999999" },
          });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "fallback ok" } }] }),
          {
            headers: { "Content-Type": "application/json" },
          }
        );
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, models);
    assert.equal((await response.json()).choices[0].message.content, "fallback ok");
  });

  test("round-robin drain path: plain-text hint reaches the final Retry-After only with the flag on", async () => {
    const combo = {
      name: "rr13672",
      strategy: "round-robin",
      config: { maxRetries: 0, disableSessionStickiness: true },
      models: [{ kind: "model", provider: "openai", providerId: "openai", model: "m", id: "rr-0" }],
    };
    const dispatch = async () => {
      rrState.rrCounters.clear();
      rrState.rrStickyTargets.clear();
      return (await handleComboChat({
        body: { model: combo.name, messages: [{ role: "user", content: "hi" }], stream: false },
        combo,
        allCombos: [combo],
        isModelAvailable: async () => true,
        relayOptions: undefined,
        signal: undefined,
        settings: {},
        log: { info() {}, warn() {}, debug() {}, error() {} },
        handleSingleModel: async () => plainText429(),
      })) as Response;
    };

    delete process.env[FLAG];
    const off = await dispatch();
    assert.equal(off.headers.get("Retry-After"), null, "flag off: no hint read, legacy JSON error");
    assert.equal((await readBody(off)).error.retry_after_provenance, undefined);

    process.env[FLAG] = "true";
    const on = await dispatch();
    const header = Number(on.headers.get("Retry-After"));
    assert.ok(header >= 25 && header <= 30, `Retry-After from the plain-text hint, got ${header}`);
    assert.equal((await readBody(on)).error.retry_after_provenance, "signal");
  });
});

describe("skip-provider-breaker-consumer-2743", () => {
  /**
   * #2743 — gap d (deferred test debt): CONSUMER-side coverage for `skipProviderBreaker`.
   *
   * The PRODUCER is already covered (tests/unit/services/account-fallback-service.test.ts, the
   * "G-02" block): `checkFallbackError` returns `skipProviderBreaker: true` for a 503 +
   * `X-Omni-Fallback-Hint: connection_cooldown` (an embedded-service supervisor outage,
   * NOT an upstream AI-provider failure).
   *
   * What was UNVERIFIED is the CONSUMER gate in `open-sse/services/combo.ts` (~line 4350):
   * the decision that, when `skipProviderBreaker` is set, the whole-provider circuit
   * breaker must NOT be tripped (`recordProviderFailure` is skipped) — it is a
   * connection-level cooldown, not a provider-level failure. The producer test's final
   * "breaker stays CLOSED" assertion is trivially true there because nothing ever calls
   * `recordProviderFailure`, so it does not prove the consumer gate works.
   *
   * This test drives the consumer end of the flow:
   *   1. the pure decision predicate (`shouldRecordProviderBreakerFailure`), and
   *   2. its real effect — wiring the producer result THROUGH the predicate into
   *      `recordProviderFailure` against a real circuit breaker, asserting the breaker
   *      stays CLOSED for the skip-hint path and OPENS for the negative-control path.
   */
  const { shouldRecordProviderBreakerFailure } = comboModule;
  const {
    checkFallbackError,
    recordProviderFailure,
    isProviderInCooldown,
    getProviderBreakerState,
    clearProviderFailure,
  } = accountFallback;
  const { resetAllCircuitBreakers } = circuitBreaker;

  // Profile override that makes the provider breaker open on the FIRST recorded
  // failure, so the negative control is deterministic regardless of env-tuned
  // default thresholds (apikey defaults to 12).
  const OPEN_ON_FIRST = { failureThreshold: 1, resetTimeoutMs: 60_000 } as const;

  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  after(() => {
    resetAllCircuitBreakers();
  });

  // ─── 1. Pure decision predicate ──────────────────────────────────────────────
  // Mirrors the four-way gate in combo.ts: only a provider-level failure code, on a
  // target NOT followed by a same-provider target, that is NOT a stream-readiness
  // failure and NOT flagged skipProviderBreaker, records a provider-breaker failure.

  test("predicate: plain 503 (no skip hint) DOES record a provider-breaker failure", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 503,
        sameProviderNext: false,
        skipProviderBreaker: false,
      }),
      true
    );
  });

  test("predicate: skipProviderBreaker:true suppresses the provider-breaker failure", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 503,
        sameProviderNext: false,
        skipProviderBreaker: true,
      }),
      false
    );
  });

  test("predicate: skipProviderBreaker undefined behaves like false (records)", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 503,
        sameProviderNext: false,
        // skipProviderBreaker omitted on purpose
      }),
      true
    );
  });

  test("predicate: stream-readiness failure never records (even on a 5xx)", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: true,
        status: 503,
        sameProviderNext: false,
        skipProviderBreaker: false,
      }),
      false
    );
  });

  test("predicate: same-provider-next suppresses (a different model may still succeed)", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 503,
        sameProviderNext: true,
        skipProviderBreaker: false,
      }),
      false
    );
  });

  test("predicate: a non-provider-failure code (e.g. 404) never records", () => {
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status: 404,
        sameProviderNext: false,
        skipProviderBreaker: false,
      }),
      false
    );
  });

  // ─── 2. End-to-end consumer effect (producer → predicate → breaker) ───────────
  // Replays the exact combo.ts consumer wiring against a REAL circuit breaker.

  /**
   * Mirror of the combo.ts consumer site: feed a real `checkFallbackError` result
   * through the extracted predicate and into `recordProviderFailure` exactly as the
   * combo router does. Returns whether the breaker failure was recorded.
   */
  function runConsumerGate(opts: {
    provider: string;
    status: number;
    errorText: string;
    headers: Headers | Record<string, string> | null;
    sameProviderNext?: boolean;
    isStreamReadinessFailure?: boolean;
  }): boolean {
    const fallbackResult = checkFallbackError(
      opts.status,
      opts.errorText,
      0,
      null,
      opts.provider,
      opts.headers ?? null
    );
    const shouldRecord = shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: opts.isStreamReadinessFailure ?? false,
      status: opts.status,
      sameProviderNext: opts.sameProviderNext ?? false,
      skipProviderBreaker: fallbackResult.skipProviderBreaker,
    });
    if (shouldRecord) {
      // Force the breaker to open on the first failure so the assertion is deterministic.
      recordProviderFailure(opts.provider, undefined, null, OPEN_ON_FIRST);
    }
    return shouldRecord;
  }

  test("consumer (positive skip): 503 + connection_cooldown hint → breaker stays CLOSED", () => {
    const provider = "test-9router-skip-2743";
    // Sanity: clean start.
    assert.equal(isProviderInCooldown(provider), false);

    const recorded = runConsumerGate({
      provider,
      status: 503,
      errorText: "9router is not running (state: stopped)",
      headers: new Headers({ "X-Omni-Fallback-Hint": "connection_cooldown" }),
    });

    // The producer set skipProviderBreaker:true, so the consumer must NOT record a failure.
    assert.equal(recorded, false, "recordProviderFailure must be skipped for the cooldown hint");
    assert.equal(
      isProviderInCooldown(provider),
      false,
      "provider circuit breaker must remain CLOSED for a supervisor cooldown signal"
    );
    const state = getProviderBreakerState(provider);
    assert.equal(state?.failureCount ?? 0, 0, "breaker failure count must not be incremented");
  });

  test("consumer (positive skip): five consecutive cooldown-hint 503s keep the breaker CLOSED", () => {
    const provider = "test-9router-skip-loop-2743";
    for (let i = 0; i < 5; i++) {
      const recorded = runConsumerGate({
        provider,
        status: 503,
        errorText: "9router is not running (state: stopped)",
        headers: new Headers({ "X-Omni-Fallback-Hint": "connection_cooldown" }),
      });
      assert.equal(recorded, false, `call ${i + 1} must skip recordProviderFailure`);
    }
    assert.equal(
      isProviderInCooldown(provider),
      false,
      "repeated supervisor cooldown signals must never trip the whole-provider breaker"
    );
  });

  test("consumer (negative control): plain 503 WITHOUT the hint trips the breaker", () => {
    const provider = "test-openai-noskip-2743";
    assert.equal(isProviderInCooldown(provider), false);

    const recorded = runConsumerGate({
      provider,
      status: 503,
      errorText: "service unavailable",
      headers: null,
    });

    // No skip flag → the consumer records the failure → breaker opens (threshold = 1).
    assert.equal(recorded, true, "a real upstream 503 must record a provider-breaker failure");
    assert.equal(
      isProviderInCooldown(provider),
      true,
      "provider circuit breaker must OPEN for a real upstream outage"
    );
    const state = getProviderBreakerState(provider);
    assert.ok((state?.failureCount ?? 0) >= 1, "breaker failure count must be incremented");

    clearProviderFailure(provider);
  });

  test("consumer (negative control): same-provider-next still suppresses recording", () => {
    // A real upstream 503 (no skip hint) but the next combo target is the same provider:
    // the gate must NOT trip the breaker so a different model can still be tried.
    const provider = "test-openai-sameprovider-2743";
    const recorded = runConsumerGate({
      provider,
      status: 503,
      errorText: "service unavailable",
      headers: null,
      sameProviderNext: true,
    });
    assert.equal(recorded, false, "same-provider-next must suppress the provider-breaker failure");
    assert.equal(
      isProviderInCooldown(provider),
      false,
      "breaker must stay CLOSED for same-provider-next"
    );
  });
});

describe("t23-t24-fallback-resilience", () => {
  const { checkFallbackError } = accountFallback;
  const { resetAllCircuitBreakers } = circuitBreaker;

  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  function createLog() {
    const entries = [];
    return {
      info: (tag: string, msg: string) => entries.push({ level: "info", tag, msg }),
      warn: (tag: string, msg: string) => entries.push({ level: "warn", tag, msg }),
      error: (tag: string, msg: string) => entries.push({ level: "error", tag, msg }),
      debug: (tag: string, msg: string) => entries.push({ level: "debug", tag, msg }),
      entries,
    };
  }

  function createStatusSequenceHandler(sequence) {
    let idx = 0;
    return async () => {
      const step = sequence[idx++] || { status: 200 };
      if (step.status === 200) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          error: { message: step.message || `Error ${step.status}` },
        }),
        {
          status: step.status,
          headers: step.headers || { "content-type": "application/json" },
        }
      );
    };
  }

  test("T23: 429 with long Retry-After uses real reset cooldown instead of short exponential backoff", () => {
    const headers = new Headers({ "retry-after": "3600" });
    const result = checkFallbackError(429, "Rate limit exceeded", 2, null, "groq", headers);

    assert.equal(result.shouldFallback, true);
    assert.equal(result.reason, "rate_limit_exceeded");
    assert.equal(result.newBackoffLevel, 0);
    assert.ok(result.cooldownMs > 3_590_000);
  });

  test("T24: combo awaits short 503 cooldown before falling through to next model", async () => {
    const log = createLog();

    const result = await handleComboChat({
      body: {},
      combo: {
        name: "t24-short-cooldown",
        strategy: "priority",
        // Cross-provider targets: a 503 marks the failing provider's remaining same-provider
        // targets for skip (#1731v2), so the fallthrough target must be a DIFFERENT provider
        // for this cooldown-wait test to exercise the fall-through-to-next-model path.
        models: [
          { model: "groq/model-a", weight: 0 },
          { model: "openai/model-b", weight: 0 },
        ],
        config: { fallbackDelayMs: 2000, maxRetries: 1 },
      },
      // Two transient failures on first model, then success on fallback model.
      handleSingleModel: createStatusSequenceHandler([
        { status: 503 },
        { status: 503 },
        { status: 200 },
      ]),
      isModelAvailable: () => true,
      log,
      settings: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    // checkFallbackError returns COOLDOWN_MS.transient (5000ms) for a plain 503.
    // fallbackDelayMs=2000, cooldownMs=5000 ≤ MAX_FALLBACK_WAIT_MS(5000) → fallbackWaitMs=2000ms.
    // The combo MUST emit a debug log before waiting, proving the wait behavior is wired.
    const waitLog = log.entries.find(
      (e) => e.msg.includes("Waiting") && e.msg.includes("fallback")
    );
    assert.ok(waitLog, "combo must emit a debug wait-before-fallback log for short 503 cooldowns");
  });

  test("T24: combo skips wait when 503 cooldown is long (>5s)", async () => {
    const log = createLog();

    const result = await handleComboChat({
      body: {},
      combo: {
        name: "t24-long-cooldown",
        strategy: "priority",
        // Cross-provider targets (see t24-short-cooldown): the fall-through target must be a
        // different provider so the #1731v2 same-provider skip doesn't short-circuit it.
        models: [
          { model: "groq/model-a", weight: 0 },
          { model: "openai/model-b", weight: 0 },
        ],
        config: { fallbackDelayMs: 2000, maxRetries: 1 },
      },
      handleSingleModel: createStatusSequenceHandler([
        {
          status: 503,
          message: "rate limit exceeded",
          headers: { "content-type": "application/json", "retry-after": "120" },
        },
        {
          status: 503,
          message: "rate limit exceeded",
          headers: { "content-type": "application/json", "retry-after": "120" },
        },
        { status: 200 },
      ]),
      isModelAvailable: () => true,
      log,
      settings: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    const waitLog = log.entries.find(
      (e) => e.msg.includes("Waiting") && e.msg.includes("fallback")
    );
    assert.equal(waitLog, undefined);
  });

  test("T24: all inactive accounts return 503 service_unavailable (not 406)", async () => {
    const result = await handleComboChat({
      body: {},
      combo: {
        name: "t24-all-inactive",
        strategy: "priority",
        models: [
          { model: "groq/model-a", weight: 0 },
          { model: "groq/model-b", weight: 0 },
        ],
      },
      handleSingleModel: async () => {
        throw new Error("handleSingleModel should not be called when all models are unavailable");
      },
      isModelAvailable: () => false,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(result.status, 503);
    const body = (await result.json()) as any;
    assert.equal(body.error?.code, "ALL_TARGETS_SKIPPED");
  });

  test("combo falls through 400s and reaches the next model", async () => {
    const calls = [];
    const sequence = [
      { status: 429, message: "No capacity available for model gemini-3.1-pro-preview" },
      { status: 400, message: "bad request" },
      { status: 200 },
    ];

    const result = await handleComboChat({
      body: {},
      combo: {
        name: "t24-provider-scoped-400",
        strategy: "priority",
        models: [
          { model: "free/gemini-3.1-pro-preview", weight: 0 },
          { model: "aio/gemini-3.1-pro-preview-thinking-high", weight: 0 },
          { model: "openrouter/google/gemini-3.1-pro-preview", weight: 0 },
        ],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        const step = sequence[calls.length - 1] || { status: 200 };
        if (step.status === 200) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { message: step.message } }), {
          status: step.status,
          headers: { "content-type": "application/json" },
        });
      },
      isModelAvailable: () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      "free/gemini-3.1-pro-preview",
      "aio/gemini-3.1-pro-preview-thinking-high",
      "openrouter/google/gemini-3.1-pro-preview",
    ]);
  });
});

describe("repro-9630-combo-false-503", () => {
  const { getCircuitBreaker, STATE, resetAllCircuitBreakers } = circuitBreaker;

  function okResponse() {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(() => resetAllCircuitBreakers());
  after(() => resetAllCircuitBreakers());

  test("#9630: combo returns 503 when circuit breaker is OPEN but other healthy targets exist", async () => {
    const cb = getCircuitBreaker("openai");
    cb.state = STATE.OPEN;
    cb.resetTimeout = 60000;
    cb.failureCount = 5;
    cb.failureThreshold = 3;
    cb.lastFailureTime = Date.now();

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "repro-9630",
        strategy: "priority",
        models: ["openai/gpt-4", "anthropic/claude-opus-5"],
      },
      handleSingleModel: async (_body, modelStr) => {
        assert.equal(
          modelStr,
          "anthropic/claude-opus-5",
          "should skip openai breaker and try anthropic"
        );
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      settings: null,
      relayOptions: null,
      allCombos: null,
    });

    assert.ok(result.ok, "should succeed via anthropic fallback when openai breaker is open");
  });

  test("#9630: combo returns truthful error, not false ALL_ACCOUNTS_INACTIVE, when ALL targets are breaker-open", async () => {
    const cb = getCircuitBreaker("openai");
    cb.state = STATE.OPEN;
    cb.resetTimeout = 60000;
    cb.failureCount = 5;
    cb.failureThreshold = 3;
    cb.lastFailureTime = Date.now();

    const cb2 = getCircuitBreaker("anthropic");
    cb2.state = STATE.OPEN;
    cb2.resetTimeout = 60000;
    cb2.failureCount = 5;
    cb2.failureThreshold = 3;
    cb2.lastFailureTime = Date.now();

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "repro-9630-all-breaker",
        strategy: "priority",
        models: ["openai/gpt-4", "anthropic/claude-opus-5"],
      },
      handleSingleModel: async () => {
        throw new Error("should not be called");
      },
      isModelAvailable: async () => true,
      log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      settings: {
        resilienceSettings: {
          comboCooldownWait: { enabled: false },
        },
      },
      relayOptions: null,
      allCombos: null,
    });

    assert.equal(result.status, 503);
    const body = await result.json();
    // The diagnostic should NOT claim ALL_ACCOUNTS_INACTIVE when no real dispatch was attempted
    assert.notEqual(
      body.error?.code,
      "ALL_ACCOUNTS_INACTIVE",
      "should not claim ALL_ACCOUNTS_INACTIVE when all targets were gated by pre-dispatch checks"
    );
  });
});

describe("upstream-timeout-connection-tier", () => {
  const GLOBAL = 600_000;

  function fakeExecutor(timeoutMs?: number) {
    return { getTimeoutMs: () => timeoutMs ?? GLOBAL };
  }

  test("resolveConnectionTimeoutMs: returns floored integer for valid values", () => {
    assert.equal(resolveConnectionTimeoutMs({ timeoutMs: 1_800_000.9 }), 1_800_000);
    assert.equal(resolveConnectionTimeoutMs({ timeoutMs: 1 }), 1);
  });

  test("resolveConnectionTimeoutMs: undefined for absent/invalid values", () => {
    assert.equal(resolveConnectionTimeoutMs(undefined), undefined);
    assert.equal(resolveConnectionTimeoutMs(null), undefined);
    assert.equal(resolveConnectionTimeoutMs({}), undefined);
    assert.equal(resolveConnectionTimeoutMs({ timeoutMs: 0 }), undefined);
    assert.equal(resolveConnectionTimeoutMs({ timeoutMs: -5 }), undefined);
    assert.equal(resolveConnectionTimeoutMs({ timeoutMs: "60000" }), undefined);
    assert.equal(resolveConnectionTimeoutMs({ timeoutMs: 86_400_001 }), undefined);
  });

  test("getExecutorTimeoutMs: connection tier preempts model, provider and global", () => {
    const executor = fakeExecutor(30_000);
    // model override present (registry) + provider override + connection:
    // connection wins
    assert.equal(getExecutorTimeoutMs(executor, "openai", "gpt-5", 1_800_000), 1_800_000);
  });

  test("getExecutorTimeoutMs: invalid connection timeout falls through to model/provider/global", () => {
    const executor = fakeExecutor(30_000);
    assert.equal(getExecutorTimeoutMs(executor, "openai", "gpt-5", 0), 30_000);
    assert.equal(getExecutorTimeoutMs(executor, "openai", "gpt-5", undefined), 30_000);
    assert.equal(getExecutorTimeoutMs(fakeExecutor(), undefined, undefined, undefined), GLOBAL);
  });

  test("executeWithUpstreamStartTimeout: connection timeout aborts before the global", async () => {
    let signalAbortedAt = Number.POSITIVE_INFINITY;
    const started = Date.now();
    const result = await executeWithUpstreamStartTimeout({
      executor: fakeExecutor(600_000),
      provider: "openai",
      model: "gpt-5",
      connectionTimeoutMs: 50,
      signal: new AbortController().signal,
      log: null,
      execute: (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            signalAbortedAt = Date.now() - started;
            resolve("aborted");
          });
        }),
    });
    assert.equal(result, "aborted");
    assert.ok(signalAbortedAt < 1_000, `aborted at ${signalAbortedAt}ms, expected < 1000ms`);
  });
  test("connection timeout extraction matches execCreds.providerSpecificData shape", () => {
    const execCreds = { providerSpecificData: { timeoutMs: 1_800_000, someOtherKey: 1 } };
    assert.equal(resolveConnectionTimeoutMs(execCreds?.providerSpecificData), 1_800_000);
    assert.equal(
      resolveConnectionTimeoutMs({ providerSpecificData: undefined }?.providerSpecificData),
      undefined
    );
  });

  const timeoutTarget = (connectionId: string | null) => ({
    kind: "model",
    stepId: "s",
    executionKey: "k",
    modelStr: "m",
    provider: "p",
    providerId: null,
    connectionId,
    weight: 1,
    label: null,
  });

  test("resolveTargetTimeoutMsForTarget: undefined without connectionId", async () => {
    const result = await resolveTargetTimeoutMsForTarget(
      null,
      "fallback",
      { enabled: false, budgetMs: 0 },
      timeoutTarget(null)
    );
    assert.equal(result, undefined);
  });

  test("resolveTargetTimeoutMsForTarget: unknown connection -> undefined", async () => {
    const result = await resolveTargetTimeoutMsForTarget(
      null,
      "fallback",
      { enabled: false, budgetMs: 0 },
      timeoutTarget("conn-does-not-exist")
    );
    assert.equal(result, undefined);
  });

  test("resolveTargetTimeoutMsForTarget: connection without timeoutMs -> undefined", async () => {
    const result = await resolveTargetTimeoutMsForTarget(
      null,
      "fallback",
      { enabled: false, budgetMs: 0 },
      timeoutTarget("conn-no-timeout")
    );
    assert.equal(result, undefined);
  });
});

describe("combo-terminal-status-policy-10501", () => {
  /**
   * #10314 / #10501 — integration-level regression for the combo terminal-error
   * aggregation + status policy. Drives the REAL `handleComboChat` wiring (via
   * an injected `handleSingleModel`, the same seam `combo-body-specific-400-
   * stop-4279.test.ts` uses) end-to-end, asserting the actual HTTP `Response`
   * the client receives — not just the pure `comboErrorAggregation.ts` helpers
   * in isolation (those are covered by `combo-error-aggregation.test.ts`).
   *
   * Scenario: a priority combo where target #1 returns a 200 that FAILS
   * response-quality validation (empty body — see validateQuality.ts) and
   * target #2 returns a real 401 (auth). Before #10314/#10501 this surfaced a
   * bare 401 ("last writer wins") and dropped the quality reason entirely; now
   * it must list BOTH reasons and surface a 5xx-class infra status instead of
   * the sibling's 401 (resolveComboTerminalStatus — the request itself was
   * never proven invalid on every target).
   */
  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function makeCombo(models: string[]) {
    return {
      name: "test-combo-10501",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  // Empty body + application/json content-type trips validateResponseQuality's
  // "empty response body" case for a non-streaming response.
  function qualityFailingResponse() {
    return new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
  }

  function authFailureResponse() {
    return new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  function successResponse() {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  test("#10314/#10501: quality failure on target 1 + auth 401 on target 2 → 5xx terminal status, BOTH reasons listed", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      if (modelStr.includes("model-a")) return qualityFailingResponse();
      return authFailureResponse();
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }], stream: false },
      combo: makeCombo(["openai/model-a", "openai/model-b"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.deepEqual(modelsCalled, ["openai/model-a", "openai/model-b"]);

    // #10501: a heterogeneous quality+auth mix must NOT surface the sibling's
    // bare 401 (the old `lastStatus` behavior) — it is an infra/provider-class
    // outcome (neither target proved the CLIENT's request itself was invalid).
    assert.ok(
      result.status >= 500,
      `expected a 5xx terminal status for a heterogeneous quality+auth mix, got ${result.status}`
    );
    assert.notEqual(
      result.status,
      401,
      "must not regress to surfacing the sibling target's bare 401"
    );

    const body = (await result.json()) as { error?: { message?: string } };
    const message = body.error?.message ?? "";
    // #10314: both distinct reasons must be listed — neither silently dropped.
    assert.match(message, /quality/i, "quality-validation reason must be present in the message");
    assert.match(message, /invalid_api_key|auth/i, "auth reason must be present in the message");
  });

  test("#10314: success on target 2 after a quality failure on target 1 returns the real success response", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      if (modelStr.includes("model-a")) return qualityFailingResponse();
      return successResponse();
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }], stream: false },
      combo: makeCombo(["openai/model-a", "openai/model-b"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.deepEqual(
      modelsCalled,
      ["openai/model-a", "openai/model-b"],
      "must fail over from the quality-rejected target 1 to target 2"
    );
    assert.equal(result.status, 200, "combo must return the successful target's response");
    const body = (await result.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    assert.equal(body.choices?.[0]?.message?.content, "hi there");
  });
});
