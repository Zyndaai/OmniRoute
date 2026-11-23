// Fallback, model lockouts, circuit-open waits, compat fallback, attempt budgets and timer
// cleanup of handleComboChat. Merged from eleven files so the combo.ts module graph loads once;
// each original file is one `describe` below, named after the file it came from.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-fallback-locks-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-fallback-locks-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const combo = await import("../../../open-sse/services/combo.ts");
const {
  handleComboChat,
  clampComboDepth,
  validateComboDAG,
  clampGlobalAttempts,
  MAX_GLOBAL_ATTEMPTS,
  MAX_GLOBAL_ATTEMPTS_HARD_CAP,
  poolMedianP95Ms,
  bootstrapMs,
  bootstrapSourceFromTable,
  shouldWarnBootstrap,
  resetBootstrapCounters,
  formatBootstrapWarning,
  maybeWarnBootstrapDominant,
  bootstrapSourceCounts,
} = combo;
const { getDefaultComboConfig, resolveComboConfig } =
  await import("../../../open-sse/services/comboConfig.ts");
const { buildDefaultNesting } = await import("../../../open-sse/services/combo/dispatchPrelude.ts");
const { comboRuntimeConfigSchema } =
  await import("../../../src/shared/validation/schemas/combo.ts");
const { applyReasoningInputPolicy } =
  await import("../../../open-sse/services/reasoningInputPolicy.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../../src/lib/modelsDevSync.ts");
const { resetAllComboMetrics } = await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers, getCircuitBreaker } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const {
  recordModelLockoutFailure,
  clearAllModelLockouts,
  getModelLockoutInfo,
  isModelLocked,
  parseRetryFromErrorText,
} = await import("../../../open-sse/services/accountFallback.ts");
const { recordProviderCooldown, clearCooldownState } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../../open-sse/services/rateLimitSemaphore.ts");
const { _resetAllDecks } = await import("../../../src/shared/utils/shuffleDeck.ts");
const { clearSessions } = await import("../../../open-sse/services/sessionManager.ts");

// Each source file used to start in a fresh process; every describe starts from a clean DB and
// clean in-memory combo state.
async function resetSharedState() {
  await resetTestDb();
  await clearModelsDevCapabilities();
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  clearCooldownState();
  resetAllSemaphores();
  _resetAllDecks();
  clearSessions();
}

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-antigravity-missing-project-reset-8486", () => {
  before(resetSharedState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function makeCombo(models: string[]) {
    return {
      name: "test-combo-8486",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  async function runScenario(models: string[]) {
    const longRetryAfterMs = (21 * 3600 + 47 * 60 + 32) * 1000;
    const longRetryAfterIso = new Date(Date.now() + longRetryAfterMs).toISOString();

    const missingProjectBody = {
      error: {
        message:
          "Missing Google projectId for Antigravity account. Auto-discovery via loadCodeAssist " +
          "found no Cloud Code project. Please reconnect OAuth in Providers → Antigravity (and " +
          "ensure the Google account has completed Gemini Code Assist onboarding).",
        type: "oauth_missing_project_id",
        code: "missing_project_id",
      },
    };

    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      if (modelStr.includes("account-a")) {
        return new Response(
          JSON.stringify({
            error: { message: "Your quota will reset after 21h47m32s." },
            retryAfter: longRetryAfterIso,
          }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify(missingProjectBody), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(models),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    return { result, modelsCalled };
  }

  // #10314/#10501 superseded the original "one target's message wins, silently
  // drops the sibling's reason" contract these two tests pinned: combo terminal
  // aggregation now DELIBERATELY lists every distinct per-target reason (#10314)
  // and normalizes a heterogeneous failure mix to a 5xx-class status instead of a
  // bare `lastStatus` (#10501 — see comboErrorAggregation.ts::resolveComboTerminalStatus).
  // The underlying #8486 concern — a config-class error getting the WRONG target's
  // long retry-after window stitched onto it — is still the thing under test, just
  // verified against the new contract: the response's `Retry-After` HEADER (the
  // actual out-of-band decoration #8486 was about) must never carry the unrelated
  // 21h47m window, in EITHER attempt order, regardless of which reasons appear in
  // the (now intentionally multi-reason) message body.
  test("#8486 Part B: heterogeneous rate_limit+config-class antigravity failure never attaches the unrelated 21h47m retryAfter as a response header", async () => {
    const { result, modelsCalled } = await runScenario([
      "antigravity/account-a-model",
      "antigravity/account-b-model",
    ]);

    assert.ok(
      modelsCalled.some((m) => m.includes("account-a")) &&
        modelsCalled.some((m) => m.includes("account-b")),
      `expected both targets to be tried, got: ${JSON.stringify(modelsCalled)}`
    );

    // #10501: neither target's failure alone proves the CLIENT's request was
    // invalid (one is a rate limit, the other a config/auth problem) — the
    // heterogeneous mix must normalize to a 5xx infra/provider status.
    assert.equal(result.status, 502);
    assert.equal(
      result.headers.get("Retry-After"),
      null,
      "the config-class 422 (no retryAfter of its own) must never end up decorated " +
        "with account-a's unrelated 21h47m retry-after header"
    );

    // #10314: both distinct reasons are now surfaced (never silently dropped).
    const text = await result.clone().text();
    assert.match(text, /reset after 21h47m32s/i);
    assert.match(text, /missing google projectid/i);
  });

  test("#8486 Part B (reverse order): same result independent of which target failed first — both reasons present, no bogus Retry-After header", async () => {
    const { result, modelsCalled } = await runScenario([
      "antigravity/account-b-model",
      "antigravity/account-a-model",
    ]);

    assert.ok(
      modelsCalled.some((m) => m.includes("account-a")) &&
        modelsCalled.some((m) => m.includes("account-b")),
      `expected both targets to be tried, got: ${JSON.stringify(modelsCalled)}`
    );

    assert.equal(result.status, 502, "attempt order must not change the terminal status");
    assert.equal(result.headers.get("Retry-After"), null);

    const text = await result.clone().text();
    assert.match(text, /reset after 21h47m32s/i);
    assert.match(text, /missing google projectid/i);
  });
});

describe("combo-priority-all-circuit-open", () => {
  // A priority combo whose every target sits behind an OPEN circuit breaker used to answer the
  // generic `ALL_TARGETS_SKIPPED` 503: no provider in the message, no Retry-After, and a
  // recovery hint telling the operator to check quota and top up the account. The breaker is a
  // local resilience timer, not an upstream quota signal, so the response now names it:
  // `all_targets_cooling_down`, each target as `provider/model: circuit_open (Ns)`, Retry-After
  // from the earliest probe, and the `wait` recovery action. A pool with any target NOT behind
  // an open breaker keeps the generic response.
  //
  // Harness mirrors tests/unit/combo/rr-stickiness-strategies.test.ts (describe
  // combo-weighted-all-targets-cooling-down).

  // Longer than the combo cooldown-wait ceiling, so the loop answers instead of
  // sleeping until the breaker half-opens.
  const RESET_TIMEOUT_MS = 600_000;

  const log = { info() {}, warn() {}, error() {}, debug() {} };

  async function openBreaker(provider: string) {
    const breaker = getCircuitBreaker(provider, {
      failureThreshold: 1,
      resetTimeout: RESET_TIMEOUT_MS,
    });
    await breaker
      .execute(async () => {
        throw new Error("simulated failure");
      })
      .catch(() => {});
    assert.equal(breaker.getStatus().state, "OPEN");
  }

  async function run(calls: string[]) {
    return handleComboChat({
      body: {},
      combo: {
        name: "priority-circuit",
        strategy: "priority",
        models: ["openai/a", "claude/b"],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
        calls.push(modelStr);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
    });
  }

  beforeEach(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    clearAllModelLockouts();
  });

  after(() => {
    resetAllCircuitBreakers();
    clearAllModelLockouts();
  });

  test("every breaker OPEN → 503 names the breaker, the providers and the next probe", async () => {
    await openBreaker("openai");
    await openBreaker("claude");
    const calls: string[] = [];

    const res = await run(calls);
    assert.equal(res.status, 503);
    assert.deepEqual(calls, [], "no upstream call is made while every breaker is open");

    const retryAfter = Number(res.headers.get("Retry-After"));
    assert.ok(
      retryAfter > 0 && retryAfter <= RESET_TIMEOUT_MS / 1000,
      `Retry-After follows the earliest probe, got ${res.headers.get("Retry-After")}`
    );
    assert.equal(res.headers.get("x-omniroute-combo-terminal-reason"), "all_targets_cooling_down");
    assert.equal(res.headers.get("x-omniroute-recovery-action"), "wait");

    const body = (await res.json()) as {
      error: { code?: string; message: string };
      diagnostics: { excluded: Array<{ provider: string; model?: string; reason: string }> };
    };
    assert.equal(body.error.code, "all_targets_cooling_down");
    assert.match(body.error.message, /openai\/a: circuit_open \(\d+s\)/);
    assert.match(body.error.message, /claude\/b: circuit_open \(\d+s\)/);
    assert.doesNotMatch(body.error.message, /quota/i);
    assert.deepEqual(
      body.diagnostics.excluded.map((e) => `${e.provider}/${e.model}:${e.reason}`).sort(),
      ["claude/b:circuit_open", "openai/a:circuit_open"]
    );
  });

  test("a pool not entirely behind open breakers keeps the generic ALL_TARGETS_SKIPPED", async () => {
    await openBreaker("openai");
    recordModelLockoutFailure("claude", "", "b", "unknown", 502, RESET_TIMEOUT_MS, null, {
      maxCooldownMs: RESET_TIMEOUT_MS,
    });
    const calls: string[] = [];

    const res = await run(calls);
    assert.equal(res.status, 503);
    assert.deepEqual(calls, []);
    const body = (await res.json()) as { error: { code?: string } };
    assert.equal(body.error.code, "ALL_TARGETS_SKIPPED");
  });
});

describe("combo-priority-compat-fallback", () => {
  // Priority combos route through the universal dispatch loop, where the
  // #6238 last-resort compat fallback was missing: a request whose
  // compatibility-KEPT targets all got skipped before a single real attempt
  // (availability / cooldown / breaker gates) crystallized 503 without ever
  // reconsidering a compatibility-REJECTED-but-healthy target. Only the
  // round-robin path had the fallback tier.
  //
  // The compat pre-filter (filterTargetsByRequestCompatibility) drops
  // request-incompatible targets BEFORE availability is known, so the rejected
  // set is computed at resolution time and threaded into the dispatch loop;
  // with zero recorded attempts the loop probes it before the terminal 503.
  before(resetSharedState);

  function createLog() {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  function okResponse(model: string) {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `served by ${model}` } }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }

  function capabilityEntry(limitContext: unknown, overrides: Record<string, unknown> = {}) {
    return {
      tool_call: true,
      reasoning: false,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: false,
      limit_context: limitContext,
      limit_input: limitContext,
      limit_output: 4096,
      interleaved_field: null,
      ...overrides,
    };
  }

  // pr-a is tool-INCAPABLE, so a tools-requiring request makes the compat
  // pre-filter reject it. pr-b is tool-capable and survives the filter, which
  // lets the harness steer it either runtime-unavailable (skipped, zero
  // recorded attempts) or attempted-but-failing (recorded attempts > 0).
  const TOOL_BODY = {
    messages: [{ role: "user", content: "Use a tool to look something up" }],
    tools: [{ type: "function", function: { name: "lookup_weather" } }],
  };

  function runCombo(overrides: {
    keepUnavailability: boolean;
    keepOutcome: "ok" | "fail" | "abort";
    rejectedOutcome: "ok" | "fail";
    settings?: Record<string, unknown> | null;
    models?: Array<string | Record<string, unknown>>;
  }) {
    const attempted: string[] = [];
    return handleComboChat({
      body: TOOL_BODY,
      combo: {
        name: "priority-compat-fallback",
        strategy: "priority",
        models: overrides.models ?? [
          {
            kind: "model",
            provider: "openai",
            model: "pr-a",
            connectionId: "conn-a",
            id: "step-a",
          },
          "openai/pr-b",
        ],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async (_body, modelStr) => {
        attempted.push(modelStr);
        if (modelStr === "openai/pr-b" && overrides.keepOutcome === "abort") {
          // An opaque network failure records the attempt without a status,
          // so the loop reaches the zero-status terminal with a recorded
          // attempt — the case the fallback guard must skip.
          return Response.error();
        }
        const failed =
          (modelStr === "openai/pr-a" && overrides.rejectedOutcome === "fail") ||
          (modelStr === "openai/pr-b" && overrides.keepOutcome === "fail");
        if (failed) {
          return new Response(
            JSON.stringify({ error: { message: "upstream rejected the request" } }),
            { status: 500, headers: { "content-type": "application/json" } }
          );
        }
        return okResponse(modelStr);
      },
      isModelAvailable: async (modelStr) =>
        modelStr === "openai/pr-a" || !overrides.keepUnavailability,
      log: createLog(),
      settings: overrides.settings ?? null,
      relayOptions: null,
      allCombos: null,
    }).then((response) => ({ response, attempted }));
  }

  beforeEach(async () => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    clearCooldownState();
    await clearModelsDevCapabilities();
    await saveModelsDevCapabilities({
      openai: {
        "pr-a": capabilityEntry(128000, { tool_call: false }),
        "pr-b": capabilityEntry(128000),
      },
    });
  });

  after(async () => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    clearCooldownState();
    await clearModelsDevCapabilities();
  });

  test("priority serves the request from a compat-rejected healthy target when every kept target was skipped", async () => {
    // The compat-kept pr-b is runtime-unavailable (skipped before dispatch,
    // zero recorded attempts); the compat-rejected pr-a is healthy.
    const { response, attempted } = await runCombo({
      keepUnavailability: true,
      keepOutcome: "ok",
      rejectedOutcome: "ok",
    });

    assert.equal(
      response.status,
      200,
      "expected 200 from the compat-rejected target, not the skipped 503"
    );
    assert.deepEqual(attempted, ["openai/pr-a"], "only the healthy compat-rejected target is used");
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(payload.choices[0].message.content, "served by openai/pr-a");
  });

  test("priority keeps the 503 error surface when the compat-rejected target also fails", async () => {
    const { response, attempted } = await runCombo({
      keepUnavailability: true,
      keepOutcome: "ok",
      rejectedOutcome: "fail",
    });

    assert.deepEqual(attempted, ["openai/pr-a"], "the rejected target was probed as last resort");
    assert.equal(response.status, 503, "a failed fallback keeps the original terminal status");
    const body = (await response.json()) as { error?: { message?: string } };
    assert.ok(
      body.error,
      "the terminal error surface is unchanged when the fallback tier yields no success"
    );
  });

  test("priority does not probe the compat-rejected tier once a kept target was attempted", async () => {
    // pr-b is available: the loop dispatches to it and records the failed
    // attempt (a network failure leaves the status unset, so the terminal
    // still reaches the no-status block). The recordedAttempts === 0 guard
    // must keep the fallback tier dormant: without it the healthy pr-a would
    // serve a request that already had a recorded attempt.
    const { response, attempted } = await runCombo({
      keepUnavailability: false,
      keepOutcome: "abort",
      rejectedOutcome: "ok",
    });

    assert.equal(
      response.status,
      503,
      `expected the terminal 503 to surface, got ${response.status}`
    );
    const body = (await response.json()) as { error: { code?: string } };
    assert.equal(body.error.code, "ALL_ACCOUNTS_INACTIVE");
    assert.deepEqual(
      attempted,
      ["openai/pr-b"],
      "a recorded attempt forbids the last-resort probe of the rejected target"
    );
  });

  test("priority skips a compat-rejected target whose connection is in global cooldown", async () => {
    // pr-a (rejected, connection conn-a) is in the provider-cooldown tracker;
    // the kept pr-b has no connection and is only runtime-unavailable. The
    // fallback tier must honor the same cooldown gate the round-robin mirror
    // passes (isProviderInCooldown in the fallback context) and leave pr-a
    // alone — dispatching it would 200 a provider the operator has cooled.
    recordProviderCooldown("openai", "conn-a");
    const { response, attempted } = await runCombo({
      keepUnavailability: true,
      keepOutcome: "ok",
      rejectedOutcome: "ok",
      settings: { resilienceSettings: { providerCooldown: { enabled: true } } },
    });

    assert.equal(
      response.status,
      503,
      "a cooled-down compat-rejected target must not serve the request"
    );
    assert.deepEqual(
      attempted,
      [],
      "the compat-rejected target in global cooldown is skipped by the fallback tier"
    );
  });
});

describe("combo-lone-target-model-lock", () => {
  // A combo's only target must not be parked for an hour by a model-scoped 400. With no sibling
  // target, the lock saves nothing and blocks the model even after the upstream starts serving
  // it again. With siblings, the lock stays.
  before(resetSharedState);
  beforeEach(() => {
    clearAllModelLockouts();
  });

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };
  const NOT_SUPPORTED = "The requested model is not supported.";

  function run(models: string[], handleSingleModel: (body: unknown, modelStr: string) => Response) {
    return handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "lone-lock",
        strategy: "priority",
        models: models.map((m) => ({ model: m })),
      },
      handleSingleModel: async (body: unknown, modelStr: string) =>
        handleSingleModel(body, modelStr),
      log,
      settings: {},
      allCombos: [],
    });
  }

  const reject400 = () =>
    Response.json(
      { error: { message: NOT_SUPPORTED, type: "invalid_request_error" } },
      { status: 400 }
    );
  const ok = () =>
    Response.json({
      id: "ok",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });

  test("the only target of a combo is not locked after a model-scoped 400", async () => {
    let upstreamServes = false;
    const calls: string[] = [];
    const handler = (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      return upstreamServes ? ok() : reject400();
    };

    const first = await run(["github/claude-fable-5"], handler);
    assert.equal(first.status, 400);
    assert.equal(isModelLocked("github", "", "claude-fable-5"), false);

    upstreamServes = true;
    const second = await run(["github/claude-fable-5"], handler);
    assert.equal(second.status, 200, "the next request must reach the upstream again");
    assert.equal(calls.length, 2);
  });

  test("a target with a sibling is still locked after a model-scoped 400", async () => {
    const response = await run(
      ["github/claude-fable-5", "claude/claude-fable-5"],
      (_b, modelStr) => (modelStr === "github/claude-fable-5" ? reject400() : ok())
    );
    assert.equal(response.status, 200);
    assert.equal(isModelLocked("github", "", "claude-fable-5"), true);
  });
});

describe("combo-model-lock-pre-dispatch-wait-16319", () => {
  // #16319 — a combo whose every target is skipped before dispatch by a SHORT, transient model
  // lockout answered a bare 503 ALL_TARGETS_SKIPPED in ~100ms: the zero-attempt branch only
  // consulted the circuit-open wait, and the general cooldown wait is gated on
  // state.earliestRetryAfter, which nothing populates when no attempt was dispatched. The
  // zero-attempt branch now also consults resolveComboCooldownWaitDecision (lock-remaining
  // driven; quota, auth and not-found locks excluded) and re-dispatches; when no wait is
  // allowed, the terminal response upgrades to 429 with the earliest transient lock expiry
  // instead of a hint-less 503.
  //
  // Harness mirrors the combo-priority-all-circuit-open describe in this file.
  const log = { info() {}, warn() {}, error() {}, debug() {} };

  function run(
    comboOverrides: Record<string, unknown>,
    settings: Record<string, unknown> | null,
    isModelAvailable: () => Promise<boolean> = async () => true
  ) {
    const calls: string[] = [];
    const promise = handleComboChat({
      body: {},
      combo: {
        name: "glm-flash",
        strategy: "priority",
        models: ["zai/glm-5.3-flash"],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
        ...comboOverrides,
      },
      handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
        calls.push(modelStr);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      isModelAvailable,
      log,
      settings,
      allCombos: null,
    });
    return { promise, calls };
  }

  before(resetSharedState);
  beforeEach(() => {
    resetAllComboMetrics();
    clearAllModelLockouts();
  });

  after(() => {
    clearAllModelLockouts();
  });

  test("a short transient model lock is waited out and the combo re-dispatches (#16319)", async () => {
    // The reported shape: the previous request just finished, the next one lands
    // 0.5s later with the model lock still ~8s from expiry. A SHORT lock (1.2s)
    // must be waited out inside comboCooldownWait, not crystallized as a 503.
    recordModelLockoutFailure("zai", "", "glm-5.3-flash", "rate_limit", 429, 0, null, {
      exactCooldownMs: 1200,
    });
    const started = Date.now();
    const { promise, calls } = run({}, null);
    const res = await promise;
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["zai/glm-5.3-flash"], "the target must be retried after the wait");
    assert.ok(elapsed >= 1100, `expected to wait out the ~1.2s lock, took ${elapsed}ms`);
  });

  test("an unpinned target is not skipped while another connection is free (#16551)", async () => {
    recordModelLockoutFailure("zai", "connection-1", "glm-5.3-flash", "rate_limit", 429, 0, null, {
      exactCooldownMs: 1200,
    });
    assert.equal(isModelLocked("zai", "", "glm-5.3-flash"), false);
    assert.equal(getModelLockoutInfo("zai", "connection-2", "glm-5.3-flash"), null);

    const started = Date.now();
    const { promise, calls } = run({}, null);
    const res = await promise;
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["zai/glm-5.3-flash"], "the pre-dispatch gate must not skip");
    assert.ok(elapsed < 1000, `a free connection must not be waited out, took ${elapsed}ms`);
  });

  test("every locked connection waits on the earliest transient expiry (#16551)", async () => {
    recordModelLockoutFailure(
      "zai",
      "connection-quota",
      "glm-5.3-flash",
      "quota_exhausted",
      429,
      0,
      null,
      {
        exactCooldownMs: 400,
      }
    );
    recordModelLockoutFailure("zai", "connection-1", "glm-5.3-flash", "rate_limit", 429, 0, null, {
      exactCooldownMs: 4000,
    });
    recordModelLockoutFailure("zai", "connection-2", "glm-5.3-flash", "rate_limit", 429, 0, null, {
      exactCooldownMs: 1200,
    });

    const started = Date.now();
    const { promise, calls } = run(
      {},
      {
        resilienceSettings: {
          comboCooldownWait: { enabled: true, maxWaitMs: 2000, maxAttempts: 1, budgetMs: 300_000 },
        },
      },
      async () => false
    );
    const res = await promise;
    const elapsed = Date.now() - started;

    assert.equal(calls.length, 0, "a fully locked pool must not dispatch");
    assert.ok(elapsed >= 1100, `expected the earliest ~1.2s transient lock, took ${elapsed}ms`);
    assert.ok(elapsed < 2500, `must not wait out the later 4s lock, took ${elapsed}ms`);
    assert.equal(res.status, 429);
  });

  test("a quota model lock is never waited out and advertises no model-lock retry-after", async () => {
    // quota_exhausted locks run to midnight — the cooldown-wait helper excludes
    // them, and the terminal response must not stitch their expiry onto a 429.
    recordModelLockoutFailure("zai", "", "glm-5.3-flash", "quota_exhausted", 429, 0, null, {
      exactCooldownMs: 60_000,
    });
    const started = Date.now();
    const { promise, calls } = run({}, null);
    const res = await promise;
    const elapsed = Date.now() - started;

    assert.equal(res.status, 503);
    assert.deepEqual(calls, [], "no upstream call is made for a quota-locked target");
    assert.ok(elapsed < 1000, `quota lock must not be waited out, took ${elapsed}ms`);
    const body = (await res.json()) as { error?: { code?: string; retry_after?: number } };
    assert.equal(body.error?.code, "ALL_TARGETS_SKIPPED");
    assert.ok(!body.error?.retry_after, "a quota lock must not produce a retry hint");
  });

  test("when no wait is allowed the skipped response upgrades to 429 with the transient lock expiry", async () => {
    recordModelLockoutFailure("zai", "", "glm-5.3-flash", "rate_limit", 429, 0, null, {
      exactCooldownMs: 1200,
    });
    // Lock (1.2s) exceeds the configured wait ceiling (0.4s) → no wait, but the
    // client still learns when to come back instead of reading an outage.
    const started = Date.now();
    const { promise, calls } = run(
      {},
      {
        resilienceSettings: {
          comboCooldownWait: { enabled: true, maxWaitMs: 400, maxAttempts: 5, budgetMs: 300_000 },
        },
      }
    );
    const res = await promise;
    const elapsed = Date.now() - started;

    assert.equal(res.status, 429);
    assert.deepEqual(calls, []);
    assert.ok(elapsed < 1000, `the response must not wait out the lock, took ${elapsed}ms`);
    const body = (await res.json()) as {
      error?: { code?: string; type?: string; retry_after?: number; reset_at?: string };
    };
    assert.equal(body.error?.code, "ALL_TARGETS_SKIPPED");
    assert.equal(body.error?.type, "rate_limit_error");
    const retrySeconds = body.error?.retry_after ?? 0;
    assert.ok(retrySeconds >= 1, `expected a retry_after hint, got ${retrySeconds}`);
    assert.ok(retrySeconds <= 3, `retry_after should reflect the ~1.2s lock, got ${retrySeconds}s`);
    const resetAtMs = body.error?.reset_at ? Date.parse(body.error.reset_at) : NaN;
    assert.ok(
      Number.isFinite(resetAtMs) && resetAtMs - started > 600 && resetAtMs - started < 5000,
      `reset_at should reflect the ~1.2s lock, got ${new Date(resetAtMs).toISOString()}`
    );
  });
});

describe("combo-lockout-quota-reset-6863", () => {
  // #6863: combo path model lockout must prefer a parsed reset over the base
  // cooldown ladder while still respecting the operator's max for body prose.
  before(resetSharedState);

  const UPSTREAM_429_MESSAGE =
    "429: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 92h27m28s.";

  function createLog() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  beforeEach(() => {
    clearAllModelLockouts();
  });

  after(() => {
    clearAllModelLockouts();
  });

  test("combo 429 body reset beats base cooldown but is capped by maxCooldownMs (#6863)", async () => {
    const provider = "antigravity"; // OAuth category → quota signals preserved on 429
    const model = "claude-sonnet-4.6";

    const settings = {
      modelLockout: {
        enabled: true,
        errorCodes: [429],
        baseCooldownMs: 3000,
        maxCooldownMs: 1_800_000,
        maxBackoffSteps: 10,
        useExponentialBackoff: true,
      },
    };

    await handleComboChat({
      body: {},
      combo: {
        name: "quota-reset-combo",
        strategy: "priority",
        models: [`${provider}/${model}`],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () =>
        new Response(JSON.stringify({ error: { message: UPSTREAM_429_MESSAGE } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      isModelAvailable: async () => true,
      log: createLog(),
      settings,
      allCombos: null,
    });

    const parsedResetMs = parseRetryFromErrorText(UPSTREAM_429_MESSAGE);
    assert.ok(
      parsedResetMs && parsedResetMs > 90 * 3600 * 1000,
      `sanity: reset text must parse to ~92.5h, got ${parsedResetMs}`
    );

    const info = getModelLockoutInfo(provider, "", model);
    assert.ok(info, "combo 429 must record a model lockout");
    // Preserve #6863 (do not fall back to ~seconds), but prose is not an
    // authoritative reset and must not bypass the operator's 30m maximum.
    assert.ok(
      info!.remainingMs > settings.modelLockout.maxCooldownMs - 5_000 &&
        info!.remainingMs <= settings.modelLockout.maxCooldownMs,
      `body reset must clamp to maxCooldownMs (${settings.modelLockout.maxCooldownMs}ms); got ${info!.remainingMs}ms`
    );
  });

  test("combo 429 lockout prefers a SHORT parsed reset over the subscription fallback cooldown", async () => {
    // Review follow-up on #6863: the subscription-quota branch returns
    // cooldownMs = 1h fallback when useUpstreamRetryHints is off (OAuth default),
    // while quotaResetHintMs carries the real parsed reset. A max() of the two
    // would over-lock (1h) — the lockout must follow the parsed value (~45m),
    // matching the single-model path in src/sse/services/auth.ts.
    //
    // Native `claude` is deliberately NOT used here: since #13888 an explicit Claude
    // quota 429 without fresh per-model quota evidence is CONNECTION-scoped (the
    // connection is exhausted, no model lockout — covered by
    // tests/unit/services/claude-scoped-quota-auth.test.ts). Codex is another OAuth provider
    // whose subscription "usage limit reached" 429 still takes this branch.
    const provider = "codex"; // OAuth category → subscription-quota branch applies
    const model = "gpt-5.3-codex";
    const shortResetMessage = "429: Usage limit reached. Your usage limit resets in 45m0s.";

    const settings = {
      modelLockout: {
        enabled: true,
        errorCodes: [429],
        baseCooldownMs: 3000,
        maxCooldownMs: 7_200_000,
        maxBackoffSteps: 10,
        useExponentialBackoff: true,
      },
    };

    await handleComboChat({
      body: {},
      combo: {
        name: "short-reset-combo",
        strategy: "priority",
        models: [`${provider}/${model}`],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () =>
        new Response(JSON.stringify({ error: { message: shortResetMessage } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      isModelAvailable: async () => true,
      log: createLog(),
      settings,
      allCombos: null,
    });

    const parsedResetMs = parseRetryFromErrorText(shortResetMessage);
    assert.equal(parsedResetMs, 45 * 60 * 1000, "sanity: reset text must parse to 45m");

    const info = getModelLockoutInfo(provider, "", model);
    assert.ok(info, "combo 429 must record a model lockout");
    // Must be the parsed 45m — NOT the 1h subscription fallback (over-lock).
    assert.ok(
      info!.remainingMs > parsedResetMs! - 5_000 && info!.remainingMs <= parsedResetMs!,
      `lockout must follow the parsed 45m reset, not the 1h fallback; got ${info!.remainingMs}ms (~${Math.round(info!.remainingMs / 1000)}s)`
    );
  });
});

describe("combo-loop-safety-timer-cleanup", () => {
  before(resetSharedState);

  const SAFETY_TIMEOUT_MS = 31_337;

  function makeLog() {
    const warnings: string[] = [];
    return {
      info() {},
      warn(_tag: string, message: string) {
        warnings.push(message);
      },
      error() {},
      debug() {},
      warnings,
    };
  }

  async function withControlledSafetyTimer(
    run: (clock: {
      fireSafetyTimers(): void;
      activeCount(): number;
      clearedCount(): number;
      createdCount(): number;
    }) => Promise<void>
  ): Promise<void> {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const safetyTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
    let safetyTimersCreated = 0;
    let safetyTimersCleared = 0;

    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === SAFETY_TIMEOUT_MS) {
        const safetyHandle = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
        safetyTimers.set(safetyHandle, () => callback(...args));
        safetyTimersCreated += 1;
        return safetyHandle;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      if (safetyTimers.delete(handle)) {
        safetyTimersCleared += 1;
        return;
      }
      originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      await run({
        fireSafetyTimers() {
          const pending = [...safetyTimers.entries()];
          safetyTimers.clear();
          for (const [, callback] of pending) callback();
        },
        activeCount() {
          return safetyTimers.size;
        },
        clearedCount() {
          return safetyTimersCleared;
        },
        createdCount() {
          return safetyTimersCreated;
        },
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  }

  test("terminal upstream exhaustion clears the combo loop safety timer before returning", async () => {
    await withControlledSafetyTimer(async (clock) => {
      const log = makeLog();
      let dispatches = 0;

      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "stop" }] },
        combo: {
          name: "timer-cleanup-terminal-exhaustion",
          strategy: "priority",
          models: [{ model: "synthetic/model" }],
          config: { targetTimeoutMs: 0, comboTimeoutMs: SAFETY_TIMEOUT_MS, maxRetries: 0 },
        },
        handleSingleModel: async () => {
          dispatches += 1;
          return new Response(
            JSON.stringify({ error: { message: "synthetic upstream unavailable" } }),
            { status: 502, headers: { "content-type": "application/json" } }
          );
        },
        log,
        settings: {},
        allCombos: [],
      });

      assert.equal(response.status, 502);
      assert.equal(dispatches, 1);

      clock.fireSafetyTimers();
      assert.equal(
        log.warnings.filter((message) => /loop safety timeout/i.test(message)).length,
        0,
        "a cleared timer must not log after the request already returned"
      );
      assert.equal(clock.createdCount(), 1);
      assert.equal(clock.clearedCount(), 1, "terminal return must clear its safety timer");
      assert.equal(clock.activeCount(), 0);
    });
  });

  test("completed sets clear every safety timer across retries and terminal exits", async (t) => {
    const scenarios = [
      { name: "success", failedSets: 0, maxSetRetries: 0, expectedStatus: 200 },
      { name: "retry-success", failedSets: 1, maxSetRetries: 1, expectedStatus: 200 },
      { name: "two-retries-success", failedSets: 2, maxSetRetries: 2, expectedStatus: 200 },
      { name: "retry-exhaustion", failedSets: 2, maxSetRetries: 1, expectedStatus: 502 },
      { name: "terminal-499", failedSets: 0, maxSetRetries: 0, expectedStatus: 499 },
      { name: "retry-499", failedSets: 1, maxSetRetries: 1, expectedStatus: 499 },
      { name: "retry-fatal-400", failedSets: 1, maxSetRetries: 1, expectedStatus: 400 },
      { name: "throw", failedSets: 0, maxSetRetries: 0, expectedStatus: 502 },
      { name: "retry-throw", failedSets: 1, maxSetRetries: 1, expectedStatus: 502 },
    ];

    for (const scenario of scenarios) {
      await t.test(scenario.name, () =>
        withControlledSafetyTimer(async (clock) => {
          const log = makeLog();
          let dispatches = 0;
          const response = await handleComboChat({
            body: { messages: [{ role: "user", content: scenario.name }] },
            combo: {
              name: `timer-cleanup-${scenario.name}`,
              strategy: "priority",
              models: [{ model: `synthetic-${scenario.name}/model` }],
              config: {
                targetTimeoutMs: 0,
                comboTimeoutMs: SAFETY_TIMEOUT_MS,
                maxRetries: 0,
                maxSetRetries: scenario.maxSetRetries,
                setRetryDelayMs: 0,
              },
            },
            handleSingleModel: async () => {
              dispatches += 1;
              if (dispatches <= scenario.failedSets) {
                return new Response(
                  JSON.stringify({ error: { message: "upstream unavailable" } }),
                  {
                    status: 502,
                    headers: { "content-type": "application/json" },
                  }
                );
              }
              if (scenario.name.endsWith("throw")) throw new Error("synthetic dispatch exception");
              return new Response(
                JSON.stringify(
                  scenario.expectedStatus === 200
                    ? { choices: [{ message: { content: "ok" } }] }
                    : { error: { message: "invalid message format" } }
                ),
                {
                  status: scenario.expectedStatus,
                  headers: { "content-type": "application/json" },
                }
              );
            },
            log,
            settings: {},
            allCombos: [],
          });

          assert.equal(response.status, scenario.expectedStatus, scenario.name);
          const expectedSets = scenario.maxSetRetries + 1;
          assert.equal(dispatches, expectedSets, scenario.name);
          assert.equal(clock.createdCount(), expectedSets, scenario.name);
          assert.equal(clock.clearedCount(), expectedSets, scenario.name);
          assert.equal(clock.activeCount(), 0, scenario.name);
          clock.fireSafetyTimers();
          assert.equal(
            log.warnings.filter((message) => /loop safety timeout/i.test(message)).length,
            0,
            scenario.name
          );
        })
      );
    }
  });

  test(
    "a hung retry set retains only its own safety timer and aborts with 504",
    { timeout: 5000 },
    async () => {
      await withControlledSafetyTimer(async (clock) => {
        const log = makeLog();
        let dispatches = 0;
        let activeSignal: AbortSignal | undefined;
        let retryStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          retryStarted = resolve;
        });
        const pending = handleComboChat({
          body: { messages: [{ role: "user", content: "hang on retry" }] },
          combo: {
            name: "timer-cleanup-hung-retry",
            strategy: "priority",
            models: [{ model: "synthetic-hung-retry/model" }],
            config: {
              targetTimeoutMs: 0,
              comboTimeoutMs: SAFETY_TIMEOUT_MS,
              maxRetries: 0,
              maxSetRetries: 1,
              setRetryDelayMs: 0,
            },
          },
          handleSingleModel: async (_body, _model, target) => {
            dispatches += 1;
            if (dispatches === 1) return new Response("upstream unavailable", { status: 502 });
            activeSignal = target?.modelAbortSignal;
            retryStarted();
            return new Promise<Response>((resolve) => {
              activeSignal?.addEventListener(
                "abort",
                () => {
                  resolve(new Response("aborted", { status: 499 }));
                },
                { once: true }
              );
            });
          },
          log,
          settings: {},
          allCombos: [],
        });

        await started;
        const activeWhileRunning = clock.activeCount();
        const clearedWhileRunning = clock.clearedCount();
        clock.fireSafetyTimers();
        const response = await pending;

        assert.equal(clock.createdCount(), 2);
        assert.equal(clearedWhileRunning, 1, "the failed set must already be released");
        assert.equal(activeWhileRunning, 1, "only the currently running set retains a timer");
        assert.equal(response.status, 504);
        assert.equal(activeSignal?.aborted, true, "the safety timeout must abort the hung target");
        assert.equal(clock.activeCount(), 0);
        assert.equal(
          log.warnings.filter((message) => /loop safety timeout.*reached/i.test(message)).length,
          1
        );
      });
    }
  );

  test(
    "set retry delay has no stale timer and cancellation returns 499",
    { timeout: 5000 },
    async () => {
      await withControlledSafetyTimer(async (clock) => {
        const log = makeLog();
        const controller = new AbortController();
        let delayStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          delayStarted = resolve;
        });
        let dispatches = 0;
        const pending = handleComboChat({
          body: { messages: [{ role: "user", content: "cancel retry" }] },
          combo: {
            name: "timer-cleanup-cancel-retry",
            strategy: "priority",
            models: [{ model: "synthetic-cancel-retry/model" }],
            config: {
              targetTimeoutMs: 0,
              comboTimeoutMs: SAFETY_TIMEOUT_MS,
              maxRetries: 0,
              maxSetRetries: 1,
              setRetryDelayMs: 60_000,
            },
          },
          handleSingleModel: async () => {
            dispatches += 1;
            return new Response("upstream unavailable", { status: 502 });
          },
          signal: controller.signal,
          log: {
            ...log,
            info(_tag: string, message: string) {
              if (message.includes("retrying set")) delayStarted();
            },
          },
          settings: {},
          allCombos: [],
        });

        await started;
        const activeDuringDelay = clock.activeCount();
        clock.fireSafetyTimers();
        controller.abort();
        const response = await pending;

        assert.equal(
          activeDuringDelay,
          0,
          "a completed set must release its timer before the retry delay"
        );
        assert.equal(response.status, 499);
        assert.equal(dispatches, 1);
        assert.equal(clock.createdCount(), 1);
        assert.equal(clock.clearedCount(), 1);
        assert.equal(clock.activeCount(), 0);
        assert.equal(
          log.warnings.filter((message) => /loop safety timeout.*reached/i.test(message)).length,
          0
        );
      });
    }
  );
});

describe("combo-max-depth-config", () => {
  // Regression: `config.maxComboDepth` (DEFAULT_COMBO_CONFIG) had ZERO readers — nesting depth
  // was always the hardcoded `MAX_COMBO_DEPTH = 3`, so the operator knob did nothing. This wires
  // a clamped, per-resolution `maxDepth` through the combo depth functions (default preserved,
  // hard-capped for safety).

  // 5-combo chain L0→L1→L2→L3→L4→model — L4 sits at recursion depth 4.
  function buildDeepChain() {
    return [
      { name: "L0", models: ["L1"] },
      { name: "L1", models: ["L2"] },
      { name: "L2", models: ["L3"] },
      { name: "L3", models: ["L4"] },
      { name: "L4", models: ["openai/gpt-4"] },
    ];
  }

  test("clampComboDepth — clamps to [1, hard cap]; invalid → default 3", () => {
    assert.equal(clampComboDepth(1), 1);
    assert.equal(clampComboDepth(2), 2);
    assert.equal(clampComboDepth(5), 5);
    assert.equal(clampComboDepth(100), 10, "hard cap at 10");
    assert.equal(clampComboDepth(0), 3, "0 invalid → default 3");
    assert.equal(clampComboDepth(-4), 3, "negative → default 3");
    assert.equal(clampComboDepth(undefined), 3, "undefined → default 3");
    assert.equal(clampComboDepth("abc"), 3, "non-numeric → default 3");
    assert.equal(clampComboDepth(2.9), 2, "floors to 2");
  });

  test("validateComboDAG — default depth (3) still throws on a 4-deep chain", () => {
    assert.throws(() => validateComboDAG("L0", buildDeepChain()), /nesting depth/);
  });

  test("validateComboDAG — honors a HIGHER configured maxDepth (was hardcoded 3)", () => {
    // maxDepth 5 → the 4-deep chain validates without throwing.
    assert.doesNotThrow(() => validateComboDAG("L0", buildDeepChain(), new Set(), 0, 5));
  });

  test("validateComboDAG — honors a LOWER configured maxDepth", () => {
    const shallow = [
      { name: "A", models: ["B"] },
      { name: "B", models: ["C"] },
      { name: "C", models: ["openai/gpt-4"] },
    ];
    // A→B→C (C at depth 2): default (3) allows it…
    assert.doesNotThrow(() => validateComboDAG("A", shallow));
    // …but maxDepth 1 rejects it.
    assert.throws(() => validateComboDAG("A", shallow, new Set(), 0, 1), /nesting depth/);
  });
});

describe("combo-max-global-attempts-config", () => {
  // Issue #11134: the shared per-request combo attempt budget was the hardcoded
  // `MAX_GLOBAL_ATTEMPTS = 30` in comboPredicates.ts, with no env/config override (confirmed by
  // the repo owner on the issue). Operators running large combos (or wanting to fail fast on a
  // dead pool) could neither raise nor lower it.
  //
  // This mirrors the established `clampComboDepth` pattern exactly: an operator knob
  // (`config.maxGlobalAttempts`) that can raise the default (30) or lower it, but never above
  // `MAX_GLOBAL_ATTEMPTS_HARD_CAP` — an unbounded attempt budget is the same runaway-request DoS
  // risk that motivated MAX_COMBO_DEPTH_HARD_CAP.
  test("clampGlobalAttempts — clamps to [1, hard cap]; invalid → default 30", () => {
    assert.equal(MAX_GLOBAL_ATTEMPTS, 30, "default budget unchanged");
    assert.equal(MAX_GLOBAL_ATTEMPTS_HARD_CAP, 200, "absolute safety ceiling");

    // Honors a LOWER configured budget (fail fast on a dead pool — the #11134 symptom).
    assert.equal(clampGlobalAttempts(1), 1);
    assert.equal(clampGlobalAttempts(5), 5);
    // Honors a HIGHER configured budget (large combos legitimately need more).
    assert.equal(clampGlobalAttempts(120), 120);
    // …but never past the hard cap.
    assert.equal(clampGlobalAttempts(10_000), 200, "hard cap at 200");
    // Invalid values fall back to the default, never disabling the budget.
    assert.equal(clampGlobalAttempts(0), 30, "0 invalid → default 30");
    assert.equal(clampGlobalAttempts(-4), 30, "negative → default 30");
    assert.equal(clampGlobalAttempts(undefined), 30, "undefined → default 30");
    assert.equal(clampGlobalAttempts("abc"), 30, "non-numeric → default 30");
    assert.equal(clampGlobalAttempts(Number.NaN), 30, "NaN → default 30");
    assert.equal(clampGlobalAttempts(Infinity), 30, "Infinity → default 30 (never unbounded)");
    assert.equal(clampGlobalAttempts(4.9), 4, "floors to 4");
  });

  test("DEFAULT_COMBO_CONFIG — exposes maxGlobalAttempts so the cascade can override it", () => {
    assert.equal(
      getDefaultComboConfig().maxGlobalAttempts,
      30,
      "default present in config surface"
    );

    // Per-combo config wins over the global default (standard cascade).
    const resolved = resolveComboConfig({ config: { maxGlobalAttempts: 7 } }, {});
    assert.equal(resolved.maxGlobalAttempts, 7);

    // settings.comboDefaults layer also applies.
    const fromGlobal = resolveComboConfig({}, { comboDefaults: { maxGlobalAttempts: 50 } });
    assert.equal(fromGlobal.maxGlobalAttempts, 50);
  });

  test("dispatchPrelude — configured budget reaches nesting.attemptBudget.limit", () => {
    // buildDefaultNesting only reads maxComboDepth/maxGlobalAttempts off config;
    // the full resolved-config type is irrelevant to this assertion.
    const build = (cfg: Record<string, unknown>) =>
      (
        buildDefaultNesting as (
          n: null,
          name: string,
          c: unknown
        ) => { attemptBudget: { limit: number } }
      )(null, "c", cfg);

    // Unset → historical default of 30.
    assert.equal(build({}).attemptBudget.limit, 30);
    // Configured lower → honored (fail fast).
    assert.equal(build({ maxGlobalAttempts: 6 }).attemptBudget.limit, 6);
    // Configured higher → honored.
    assert.equal(build({ maxGlobalAttempts: 90 }).attemptBudget.limit, 90);
    // Absurd → hard-capped, never unbounded.
    assert.equal(build({ maxGlobalAttempts: 1e9 }).attemptBudget.limit, 200);
  });

  test("combo schema — accepts maxGlobalAttempts within the hard cap, rejects beyond", () => {
    const schema = comboRuntimeConfigSchema;
    assert.equal(schema.parse({ maxGlobalAttempts: 45 }).maxGlobalAttempts, 45);
    assert.equal(schema.safeParse({ maxGlobalAttempts: 201 }).success, false, "beyond hard cap");
    assert.equal(schema.safeParse({ maxGlobalAttempts: 0 }).success, false, "0 rejected");
  });
});

describe("combo-attempt-body-isolation-7847", () => {
  // Target isolation for the combo attempt body (#7847).
  //
  // combo.ts deep-clones the request body per target (`attemptBody = structuredClone(body)`) so
  // one target's mutations cannot reach the next. On a 3.05 MiB agent request that costs 9.53 MiB
  // at only 3 targets — 3x the wire size — and it scales with the target count.
  //
  // A shallow per-target copy would give the same isolation for ~nothing, because every known
  // in-place mutation on this path is a TOP-LEVEL SCALAR:
  //   combo.ts     bodyRecord.max_tokens = ...   (reasoning buffer)
  //   chatCore.ts  body.model = ...              (Background Task Redirection T41)
  //
  // These tests lock the isolation invariant itself, so the clone strategy can be changed
  // underneath them without anyone having to trust a grep for mutation sites.
  function createLog() {
    const entries: unknown[] = [];
    const push = (level: string) => (tag: unknown, msg: unknown) =>
      entries.push({ level, tag, msg });
    return {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      debug: push("debug"),
      entries,
    };
  }

  const okResponse = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const errResponse = (status: number) =>
    new Response(JSON.stringify({ error: { message: `Error ${status}` } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  /** A body with nested structure, so a shallow copy is visibly different from a deep clone. */
  function agentBody() {
    return {
      model: "openai/gpt-4o-mini",
      max_tokens: 100,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
      tools: [{ type: "function", function: { name: "t", parameters: { type: "object" } } }],
    };
  }

  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
      Object.getOwnPropertyNames(value).forEach((k) => deepFreeze((value as never)[k]));
      Object.freeze(value);
    }
    return value;
  }

  const MODELS = ["openai/gpt-4o-mini", "claude/sonnet", "gemini/flash"];

  function comboOf(strategy: string, name: string) {
    return {
      name,
      strategy,
      models: MODELS,
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    };
  }

  before(resetSharedState);
  beforeEach(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
    _resetAllDecks();
    clearSessions();
  });

  // ── The invariant: one target's writes must never reach the next ──
  // The stub reproduces chatCore.ts's `body.model = model` (Background Task Redirection),
  // which is the real downstream mutation this isolation exists to contain.
  for (const strategy of ["priority", "fill-first", "round-robin"]) {
    test(`${strategy}: a target's in-place write must not leak into the next target`, async () => {
      const seen: { model: string; maxTokens: number }[] = [];

      await handleComboChat({
        body: agentBody(),
        combo: comboOf(strategy, `cow-isolation-${strategy}`),
        handleSingleModel: async (received: Record<string, unknown>, modelStr: string) => {
          seen.push({
            model: received.model as string,
            maxTokens: received.max_tokens as number,
          });
          // Simulate chatCore.ts:693 (`body.model = model`) and the reasoning buffer write.
          received.model = `mutated-by-${modelStr}`;
          received.max_tokens = 999;
          return seen.length < MODELS.length ? errResponse(503) : okResponse();
        },
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        allCombos: null,
      });

      assert.ok(seen.length >= 2, `expected at least 2 targets to run, got ${seen.length}`);
      for (const [i, s] of seen.entries()) {
        assert.equal(
          s.model,
          "openai/gpt-4o-mini",
          `target ${i} received model "${s.model}" — a previous target's write leaked through`
        );
        assert.equal(
          s.maxTokens,
          100,
          `target ${i} received max_tokens ${s.maxTokens} — a previous target's write leaked through`
        );
      }
    });
  }

  // ── The caller's body is an input, not scratch space ──
  test("the caller's body object is never mutated by the combo loop", async () => {
    const body = agentBody();
    const before = JSON.stringify(body);

    await handleComboChat({
      body,
      combo: comboOf("priority", "cow-caller-body"),
      handleSingleModel: async (received: Record<string, unknown>) => {
        received.model = "mutated";
        received.max_tokens = 1;
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(JSON.stringify(body), before, "handleComboChat must treat `body` as read-only");
  });

  test("incompatible reasoning skips a target without mutating the fallback attempt", async () => {
    const body = {
      model: "deepseek/deepseek-v4-pro",
      input: [
        {
          id: "rs_plaintext",
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "inspect first" }],
        },
        {
          id: "fc_shared",
          type: "function_call",
          call_id: "call_1",
          name: "search",
          arguments: "{}",
        },
      ],
    };
    let attempts = 0;

    const response = await handleComboChat({
      body,
      combo: comboOf("priority", "reasoning-policy-isolation"),
      handleSingleModel: async (received: Record<string, unknown>) => {
        attempts++;
        const input = received.input as Array<Record<string, unknown>>;
        if (attempts === 1) {
          const policy = applyReasoningInputPolicy(received, "responses", {
            provider: "openai",
            onIncompatibleReasoning: "drop",
          });
          assert.equal(policy.incompatibleReasoning, false);
          assert.equal(
            (received.input as Array<Record<string, unknown>>).some(
              (item) => item.type === "reasoning"
            ),
            false
          );
          return new Response(
            JSON.stringify({
              error: {
                message: "Reasoning continuation is not compatible with the selected target",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }

        assert.equal(
          input[1].id,
          "fc_shared",
          "the first target's nested input rewrite leaked into the fallback"
        );
        const policy = applyReasoningInputPolicy(received, "responses", {
          provider: "deepseek",
        });
        assert.equal(policy.incompatibleReasoning, false);
        assert.equal(
          (received.input as Array<Record<string, unknown>>)[0].type,
          "reasoning",
          "the compatible fallback lost the plaintext reasoning item"
        );
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(response.status, 200);
    assert.ok(attempts >= 2);
    assert.equal(
      (body.input[1] as Record<string, unknown>).id,
      "fc_shared",
      "the caller's nested input was mutated"
    );
  });

  // ── The copy must stay shallow — that is the whole point ──
  test("the per-target copy shares the nested payload instead of deep-cloning it", async () => {
    const body = agentBody();
    const received: Record<string, unknown>[] = [];

    await handleComboChat({
      body,
      combo: comboOf("priority", "cow-shallow"),
      handleSingleModel: async (b: Record<string, unknown>) => {
        received.push(b);
        return received.length < 2 ? errResponse(503) : okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.ok(received.length >= 2, "need at least two targets to compare");
    for (const [i, b] of received.entries()) {
      assert.notEqual(
        b,
        body,
        `target ${i} received the caller's object — isolation requires a copy`
      );
    }
    assert.notEqual(received[0], received[1], "each target needs its own top-level object");

    // The memory property (#7847): `messages` is the expensive part of an agent request, and
    // duplicating it per target is what cost 9.53 MiB at 3 targets. Every target must therefore
    // point at the SAME array. (handleComboChat rebuilds the messages container once during
    // setup, before the per-target loop, so this is not necessarily the caller's own array —
    // what matters is that it is not rebuilt per target.)
    assert.equal(
      received[0].messages,
      received[1].messages,
      "targets got different messages arrays — the per-target copy must stay shallow (#7847)"
    );
    assert.equal(received[0].tools, body.tools, "tools must be shared, not copied");

    // And nothing deep-clones: the message objects themselves are still the caller's.
    const first = (body.messages as unknown[])[0];
    assert.equal(
      (received[0].messages as unknown[])[0],
      first,
      "message objects were cloned — nothing on this path mutates them, so they must be shared"
    );
  });

  // ── Freeze probe: nothing on the combo-owned path may write in place ──
  // Scope note: handleSingleModel is stubbed, so this covers combo.ts's own handling of the body
  // (compression, handoff injection, the reasoning-buffer write) — NOT chatCore or the executors.
  // The isolation tests above are what cover a mutating downstream.
  test("freeze probe: combo's own body handling performs no in-place writes", async () => {
    const frozen = deepFreeze(agentBody());
    let threw: unknown = null;

    try {
      await handleComboChat({
        body: frozen,
        combo: comboOf("priority", "cow-freeze-probe"),
        handleSingleModel: async () => okResponse(),
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        allCombos: null,
      });
    } catch (err) {
      threw = err;
    }

    assert.equal(
      threw,
      null,
      `combo wrote to a frozen body: ${threw instanceof Error ? threw.message : String(threw)}`
    );
  });
});

describe("combo-bootstrap-latency", () => {
  // Median helper lives in combo.ts; imported directly (exported non-default).
  test("median ignores corrupt entries", () => {
    const m = poolMedianP95Ms({
      "a/x": { p95LatencyMs: 1000 },
      "b/y": { p95LatencyMs: NaN },
      "c/z": { p95LatencyMs: -5 },
      "d/w": { p95LatencyMs: 3000 },
    } as never);
    assert.equal(m, 1000);
  });

  test("empty stats yield undefined (caller falls back to 1500, no cold-start alarm)", () => {
    assert.equal(poolMedianP95Ms({}), undefined);
  });

  test("counters start at zero", () => {
    resetBootstrapCounters();
    assert.equal(bootstrapSourceCounts.table, 0);
    assert.equal(bootstrapSourceCounts["pool-median"], 0);
    assert.equal(bootstrapSourceCounts.constant, 0);
  });

  test("table hit bumps the table counter; misses bump pool-median or constant", () => {
    resetBootstrapCounters();
    assert.equal(bootstrapMs("gpt-4o-mini", 9999), 2764); // table hit
    assert.equal(bootstrapSourceCounts.table, 1);
    assert.equal(bootstrapSourceCounts["pool-median"], 0);
    assert.equal(bootstrapSourceCounts.constant, 0);
    assert.equal(bootstrapMs("some-new-model-xyz", 1234), 1234); // miss -> median
    assert.equal(bootstrapSourceCounts["pool-median"], 1);
    assert.equal(bootstrapMs("another-new-model", undefined), 1500); // miss, no median
    assert.equal(bootstrapSourceCounts.constant, 1);
    resetBootstrapCounters();
  });

  test("bootstrap source traces table, pool median, and constant fallbacks", () => {
    // Same four provenance cases as the former model-based wrapper test,
    // expressed through the authority with the values the shared table yields:
    // gpt-4o-mini hits the table (2764), unknown models miss it (undefined).
    assert.equal(bootstrapSourceFromTable(2764, 9999), "table"); // gpt-4o-mini
    assert.equal(bootstrapSourceFromTable(undefined, 1234), "pool-median"); // some-new-model-xyz
    assert.equal(bootstrapSourceFromTable(undefined, undefined), "constant"); // another-new-model, no median
    assert.equal(bootstrapSourceFromTable(undefined, undefined), "constant"); // empty model, no median
  });

  test("warn gate is pure: cold start and low ratio stay silent, dominant warns once", () => {
    assert.equal(shouldWarnBootstrap(10, 10, false, 9999, 0), false); // cold start
    assert.equal(shouldWarnBootstrap(2, 10, true, 9999, 0), false); // ratio <= 0.3
    assert.equal(shouldWarnBootstrap(5, 10, true, 9999, 0), false); // throttled 1h
    assert.equal(shouldWarnBootstrap(5, 10, true, 3600_001, 0), true); // window elapsed
    assert.equal(shouldWarnBootstrap(5, 10, true, 9999, 9000), false); // throttled 1h
  });

  test("warning carries a per-source breakdown, never a single last-call source", () => {
    resetBootstrapCounters();
    bootstrapMs("some-new-model-xyz", 1234); // pool-median estimate
    bootstrapMs("another-new-model", undefined); // constant estimate
    bootstrapMs("gpt-4o-mini", 9999); // table hit last: must not claim "source: table"
    const { table, "pool-median": pm, constant } = bootstrapSourceCounts;
    const hits = pm + constant;
    const total = table + pm + constant;
    assert.equal(shouldWarnBootstrap(hits, total, true, 3600_001, 0), true);
    const warning = formatBootstrapWarning();
    assert.ok(warning.includes(`pool-median: ${pm}`));
    assert.ok(warning.includes(`constant: ${constant}`));
    assert.ok(!warning.includes("source: table"));
    assert.ok(warning.includes("—"));
    resetBootstrapCounters();
  });

  test("warning path emits the breakdown through the throttled warn helper", () => {
    resetBootstrapCounters();
    bootstrapMs("some-new-model-xyz", 1234);
    bootstrapMs("another-new-model", undefined);
    bootstrapMs("gpt-4o-mini", 9999); // table hit last
    const lines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      maybeWarnBootstrapDominant(true);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes("pool-median: 1"));
      assert.ok(lines[0].includes("constant: 1"));
      assert.ok(!lines[0].includes("source: table"));
      maybeWarnBootstrapDominant(true); // throttled within the hour
      assert.equal(lines.length, 1);
    } finally {
      console.warn = originalWarn;
      resetBootstrapCounters();
    }
  });
});
