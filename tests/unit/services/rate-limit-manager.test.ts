import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rate-limit-manager-"));
process.env.DATA_DIR = TEST_DATA_DIR;

// Dynamic imports are required because DATA_DIR must be set before DB modules evaluate.
const core = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const resilienceSettings = await import("../../../src/lib/resilience/settings.ts");
const rateLimitManager = await import("../../../open-sse/services/rateLimitManager.ts");
const accountFallback = await import("../../../open-sse/services/accountFallback.ts");
const { createKeyedLimiter } = await import("../../../open-sse/services/rateLimiter/index.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

// These integration-style tests exercise real limiter timers.
function wait(ms) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  message: string
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(message);
    await wait(5);
  }
}

async function flushBackgroundWork() {
  await wait(50);
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.afterEach(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
  await flushBackgroundWork();
});

test.after(async () => {
  await rateLimitManager.__resetRateLimitManagerForTests();
  await flushBackgroundWork();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("rate limit manager bypasses disabled connections and exposes inactive status", async () => {
  const result = await rateLimitManager.withRateLimit("openai", "disabled-conn", null, async () => {
    return "bypassed";
  });

  assert.equal(result, "bypassed");
  assert.deepEqual(rateLimitManager.getRateLimitStatus("openai", "disabled-conn"), {
    enabled: false,
    active: false,
    queued: 0,
    running: 0,
  });
  assert.deepEqual(rateLimitManager.getAllRateLimitStatus(), {});
});

test("application errors resembling limiter failures remain untouched", async () => {
  rateLimitManager.enableRateLimitProtection("lookalike-error-conn");
  for (const message of [
    "This job timed out after 240000 ms.",
    "rate-limit-watchdog-wedge-reset",
  ]) {
    const applicationError = new Error(message);
    await assert.rejects(
      rateLimitManager.withRateLimit("openai", "lookalike-error-conn", "gpt-4o", async () => {
        throw applicationError;
      }),
      (error) => error === applicationError
    );
  }
});

test("withRateLimit forwards AbortController DOMException without mutating it", async () => {
  const connectionId = "conn-abort-domexception";
  const controller = new AbortController();
  rateLimitManager.enableRateLimitProtection(connectionId);

  const pending = rateLimitManager.withRateLimit(
    "github-models",
    connectionId,
    "microsoft/phi-4-reasoning",
    async () => {
      await wait(50);
      return "late";
    },
    controller.signal
  );

  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("withRateLimit never starts the work of a caller that aborted before dispatch", async () => {
  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
  });
  const limiters: ReturnType<typeof createKeyedLimiter>[] = [];
  rateLimitManager.__setLimiterFactoryForTests(({ id, ...settings }) => {
    const limiter = createKeyedLimiter(id, settings);
    limiters.push(limiter);
    return limiter;
  });
  const connectionId = "conn-abort-before-dispatch";
  rateLimitManager.enableRateLimitProtection(connectionId);
  const controller = new AbortController();
  let calls = 0;
  const pending = rateLimitManager.withRateLimit(
    "openai",
    connectionId,
    "gpt-4o",
    async () => {
      calls++;
      return "must-not-run";
    },
    controller.signal
  );
  // withRateLimit is suspended before limiter.schedule() when the abort lands.
  controller.abort();

  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(limiters.length, 1, "the aborted caller's job never reached a limiter");
  await waitForCondition(() => {
    const counts = limiters[0].counts();
    return counts.QUEUED + counts.RUNNING + counts.EXECUTING === 0;
  }, "the aborted caller's job never left the limiter");
  assert.equal(calls, 0, "work must not start for a caller that already received AbortError");
});

test("rate limit manager handles soft over-limit warnings and normal header learning", async () => {
  rateLimitManager.enableRateLimitProtection("conn-over-limit");
  rateLimitManager.updateFromHeaders(
    "openai",
    "conn-over-limit",
    { "x-ratelimit-over-limit": "yes" },
    200
  );

  const softStatus = rateLimitManager.getRateLimitStatus("openai", "conn-over-limit");
  assert.equal(softStatus.enabled, true);
  assert.equal(softStatus.active, true);

  rateLimitManager.enableRateLimitProtection("conn-low-remaining");
  rateLimitManager.updateFromHeaders(
    "openai",
    "conn-low-remaining",
    {
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "5",
      "x-ratelimit-reset-requests": "30s",
    },
    200
  );
  await rateLimitManager.__flushLearnedLimitsForTests();

  const learnedLimits = rateLimitManager.getLearnedLimits();
  const learnedEntry = learnedLimits["openai:conn-low-remaining"];
  assert.equal(learnedEntry.provider, "openai");
  assert.equal(learnedEntry.connectionId, "conn-low-remaining");
  assert.equal(learnedEntry.limit, 100);
  assert.equal(learnedEntry.remaining, 5);
  assert.ok(learnedEntry.minTime > 0);

  rateLimitManager.enableRateLimitProtection("conn-high-remaining");
  rateLimitManager.updateFromHeaders(
    "claude",
    "conn-high-remaining",
    {
      get(name) {
        const map = {
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "70",
          "anthropic-ratelimit-requests-reset": new Date(Date.now() + 30_000).toISOString(),
        };
        return map[name] ?? null;
      },
    },
    200
  );
  await rateLimitManager.__flushLearnedLimitsForTests();

  const allStatuses = rateLimitManager.getAllRateLimitStatus();
  assert.ok(allStatuses["openai:conn-over-limit"]);
  assert.ok(allStatuses["openai:conn-low-remaining"]);
  assert.ok(allStatuses["claude:conn-high-remaining"]);
});

test("rate limit manager handles 429 limiter teardown and disable cleanup", async () => {
  rateLimitManager.enableRateLimitProtection("conn-429");
  rateLimitManager.updateFromHeaders("openai", "conn-429", { "retry-after": "1s" }, 429, "gpt-4o");
  await wait(25);

  assert.equal(rateLimitManager.getRateLimitStatus("openai", "conn-429").active, false);

  rateLimitManager.enableRateLimitProtection("conn-disable");
  rateLimitManager.updateFromHeaders(
    "gemini",
    "conn-disable",
    {
      "x-ratelimit-limit-requests": "60",
      "x-ratelimit-remaining-requests": "4",
      "x-ratelimit-reset-requests": "10s",
    },
    200,
    "gemini-2.5-flash"
  );
  await rateLimitManager.__flushLearnedLimitsForTests();
  assert.ok(rateLimitManager.getAllRateLimitStatus()["gemini:conn-disable:gemini-2.5-flash"]);

  rateLimitManager.disableRateLimitProtection("conn-disable");
  assert.equal(rateLimitManager.isRateLimitEnabled("conn-disable"), false);
  assert.equal(rateLimitManager.getRateLimitStatus("gemini", "conn-disable").active, false);
});

test("rate limit manager uses model-scoped limiter keys for GitHub Copilot (#1624)", async () => {
  rateLimitManager.enableRateLimitProtection("conn-github");
  rateLimitManager.updateFromHeaders(
    "github",
    "conn-github",
    {
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "3",
      "x-ratelimit-reset-requests": "15s",
    },
    200,
    "gpt-5.1-codex-max"
  );
  await rateLimitManager.__flushLearnedLimitsForTests();

  // GitHub should use model-scoped key: github:conn-github:gpt-5.1-codex-max
  const allStatuses = rateLimitManager.getAllRateLimitStatus();
  assert.ok(
    allStatuses["github:conn-github:gpt-5.1-codex-max"],
    "GitHub limiter key should be model-scoped (github:conn:model)"
  );
  // Verify the limiter state is model-scoped via test helper
  const limiterState = await rateLimitManager.__getLimiterStateForTests(
    "github",
    "conn-github",
    "gpt-5.1-codex-max"
  );
  assert.equal(limiterState?.key, "github:conn-github:gpt-5.1-codex-max");
});

test("rate limit manager parses retry hints from response bodies and locks models", async () => {
  rateLimitManager.enableRateLimitProtection("conn-body");
  rateLimitManager.updateFromResponseBody(
    "openai",
    "conn-body",
    {
      error: {
        details: [{ retryDelay: "2s" }],
        message: "Please retry later",
      },
    },
    429,
    "gpt-4o"
  );

  assert.equal(accountFallback.getModelLockoutInfo("openai", "conn-body", "gpt-4o"), null);
  const limiterState = await rateLimitManager.__getLimiterStateForTests(
    "openai",
    "conn-body",
    "gpt-4o"
  );
  assert.equal(limiterState?.key, "openai:conn-body");
  assert.equal(rateLimitManager.getRateLimitStatus("openai", "conn-body").active, true);

  rateLimitManager.updateFromResponseBody(
    "openai",
    "conn-body",
    JSON.stringify({ error: { type: "rate_limit_error" } }),
    429,
    null
  );
  assert.equal(rateLimitManager.getRateLimitStatus("openai", "conn-body").active, true);
});

test("RATE_LIMIT_AUTO_ENABLE env var overrides dashboard auto-enable setting", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Env Override",
    apiKey: "sk-env",
    isActive: true,
  });

  // Dashboard says auto-enable on, but env says off → off wins
  const original = process.env.RATE_LIMIT_AUTO_ENABLE;
  process.env.RATE_LIMIT_AUTO_ENABLE = "false";
  try {
    await rateLimitManager.initializeRateLimits();
    assert.equal(rateLimitManager.isRateLimitEnabled(conn.id), false);
  } finally {
    if (original === undefined) delete process.env.RATE_LIMIT_AUTO_ENABLE;
    else process.env.RATE_LIMIT_AUTO_ENABLE = original;
  }

  // Reset and verify the opposite: env=true forces on even when dashboard would be off
  await rateLimitManager.__resetRateLimitManagerForTests();
  process.env.RATE_LIMIT_AUTO_ENABLE = "true";
  try {
    await rateLimitManager.applyRequestQueueSettings({
      ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
      autoEnableApiKeyProviders: false,
    });
    assert.equal(rateLimitManager.isRateLimitEnabled(conn.id), true);
  } finally {
    if (original === undefined) delete process.env.RATE_LIMIT_AUTO_ENABLE;
    else process.env.RATE_LIMIT_AUTO_ENABLE = original;
  }
});

test("rate limit manager recomputes auto-enabled API key connections when queue settings change", async () => {
  const autoConnection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Auto OpenAI",
    apiKey: "sk-auto",
    isActive: true,
  });
  const explicitConnection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Explicit OpenAI",
    apiKey: "sk-explicit",
    isActive: true,
    rateLimitProtection: true,
  });

  await rateLimitManager.initializeRateLimits();

  assert.equal(rateLimitManager.isRateLimitEnabled(autoConnection.id), true);
  assert.equal(rateLimitManager.isRateLimitEnabled(explicitConnection.id), true);
  assert.ok(rateLimitManager.getAllRateLimitStatus()[`openai:${autoConnection.id}`]);

  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: false,
  });

  assert.equal(rateLimitManager.isRateLimitEnabled(autoConnection.id), false);
  assert.equal(rateLimitManager.isRateLimitEnabled(explicitConnection.id), true);
  assert.equal(rateLimitManager.getAllRateLimitStatus()[`openai:${autoConnection.id}`], undefined);

  await rateLimitManager.applyRequestQueueSettings({
    ...resilienceSettings.DEFAULT_RESILIENCE_SETTINGS.requestQueue,
    autoEnableApiKeyProviders: true,
  });

  assert.equal(rateLimitManager.isRateLimitEnabled(autoConnection.id), true);
  assert.equal(rateLimitManager.isRateLimitEnabled(explicitConnection.id), true);
  assert.ok(rateLimitManager.getAllRateLimitStatus()[`openai:${autoConnection.id}`]);
});

test("withRateLimit rejects cleanly when the caller aborts with the default DOMException reason", async () => {
  // `AbortController.abort()` called with no argument (e.g. modelTestRunner's
  // timeout path) produces a native DOMException as `signal.reason`, whose
  // `name` is a read-only getter. withRateLimit's abort handling used to
  // mutate `reason.name = "AbortError"` in place, which throws
  // `TypeError: Cannot set property name of [object DOMException] which has
  // only a getter` instead of rejecting with a clean AbortError — surfacing
  // as an unhandled rejection rather than the intended timeout/slow result.
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "abort-reason-regression",
    apiKey: "sk-abort-reason-regression",
    isActive: true,
  });
  rateLimitManager.enableRateLimitProtection(String(connection.id));
  const controller = new AbortController();
  const pending = rateLimitManager.withRateLimit(
    "openai",
    String(connection.id),
    "gpt-4o",
    () => {
      const { promise, reject } = Promise.withResolvers<never>();
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
      return promise;
    },
    controller.signal
  );

  controller.abort(); // no reason argument -> default DOMException

  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AbortError");
    return true;
  });
});
