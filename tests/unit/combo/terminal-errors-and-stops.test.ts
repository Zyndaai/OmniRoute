// Terminal errors and stop conditions of handleComboChat: body-specific and model-scoped 400s,
// terminal error codes, connection-cooldown 402 handling, protected-stop diagnostics, resource
// 404 health and error-body logging. Merged from eight files so the combo.ts module graph loads
// once; each original file is one `describe` below, named after the file it came from.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelAvailabilityResult } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-terminal-errors-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-terminal-errors-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { handleComboChat, isModelScoped400 } = await import("../../../open-sse/services/combo.ts");
const { OPENAI_RESPONSES_ERROR_FRAME, withEarlyStreamKeepalive } =
  await import("../../../open-sse/utils/earlyStreamKeepalive.ts");
const { getComboTrace, resetComboTraceStore } =
  await import("../../../open-sse/services/combo/decisionTrace.ts");
const { resetAllComboMetrics } = await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearAllModelLockouts, getModelLockoutInfo } =
  await import("../../../open-sse/services/accountFallback.ts");
const { clearCooldownState, isProviderInCooldown } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../../open-sse/services/rateLimitSemaphore.ts");

// Each source file used to start in a fresh process; every describe starts from a clean DB and
// clean in-memory combo state.
async function resetSharedState() {
  await resetTestDb();
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  clearCooldownState();
  resetAllSemaphores();
  resetComboTraceStore();
}

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-body-specific-400-stop-4279", () => {
  // #4279 — A combo whose targets all reject the request body with the SAME genuinely
  // body-specific 400 (malformed/invalid payload, context overflow, bad-request) must STOP at the
  // first such 400 instead of marching through every target with an identical,
  // guaranteed-to-fail request.
  //
  // The #2101 guard in combo.ts logs "skipping fallback to other targets to prevent infinite
  // loop" / "stopping combo", but it executed a bare `break`, which only exits the inner retry
  // loop — `executeTarget` then returns `null`, and the outer target loop treats `null` as "this
  // target produced nothing" and advances to the next model. So a 143-model combo tried all 143
  // targets (the report's symptom), wasting work + per-attempt processing.
  //
  // The guard must surface the 400 via the `{ ok, response }` contract (mirroring the 499
  // client-disconnect path) so the outer loop resolves the combo and stops.
  //
  // NOTE (#5249 reconciliation): a *model-specific* 400 ("model X is not supported with this
  // account") is NO LONGER body-specific for STOP purposes — #5249 deliberately made those
  // advance to the next combo target, since a different model in the combo may well be
  // supported. This test therefore exercises a genuinely body-specific malformed 400 ("invalid
  // message format"), which is the case that still recurs identically on every target and must
  // STOP. The advance-on-model-400 behavior is covered by combo-strategies.test.ts.
  before(resetSharedState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  // "invalid message format" matches MALFORMED_REQUEST_PATTERNS in accountFallback.ts
  // → reason MODEL_CAPACITY (shouldFallback), and the errorText carries the
  // "invalid"/"malformed" substrings combo.ts requires → the #2101 body-specific
  // stop guard fires. This is request-shape-specific, so it would fail identically
  // on every combo target.
  function bodySpecific400() {
    return new Response(
      JSON.stringify({
        detail: "Invalid message format: the request body is malformed.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  function makeCombo(models: string[]) {
    return {
      name: "test-combo-4279",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  test("#4279 combo stops at the first body-specific 400 instead of trying every target", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return bodySpecific400();
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["codex/gpt-5.2", "codex/gpt-5.3-codex", "codex/gpt-5.6-sol"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // The guard must short-circuit after the FIRST target — never reach #2 or #3.
    assert.equal(
      modelsCalled.length,
      1,
      `body-specific 400 must stop the combo at target 1, but it tried: ${modelsCalled.join(", ")}`
    );
    assert.equal(result.status, 400, "the combo must surface the body-specific 400 to the client");
  });
});

describe("combo-model-scoped-400-advance", () => {
  // Combo must ADVANCE on model-scoped 400s even when the error text also contains #2101 stop
  // substrings ("invalid", "bad request").
  //
  // User intent: keep models in the combo whether or not every provider supports them. If github
  // rejects `claude-fable-5` with "not supported", try the next target (claude / antigravity / …)
  // instead of hard-stopping the combo.
  //
  // Regression shapes covered:
  //  - "requested model is not supported" (baseline #5249)
  //  - "invalid_request_error: model X is not supported" (wrapper + model)
  //  - "Bad Request: The model is not supported" (status text wrapper)
  //  - "model X does not support Responses API" (API capability rejection)
  //
  // Genuinely body-specific 400s ("invalid message format") must still stop — covered by the
  // combo-body-specific-400-stop-4279 describe in this file.
  before(resetSharedState);

  // Reused "github/claude-fable-5" across sub-tests below now persists a
  // cross-request model lockout on a 400 "model not supported" (matches
  // production combo.ts behavior). Reset it between tests so each sub-test
  // still exercises a fresh dispatch instead of being skipped by a lockout
  // left over from a previous sub-test in this describe.
  beforeEach(() => {
    clearAllModelLockouts();
  });

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function makeCombo(models: string[]) {
    return {
      name: "test-combo-model-400",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  function okResponse(modelStr: string) {
    return Response.json({
      id: "ok",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: `ok from ${modelStr}` } }],
    });
  }

  test("isModelScoped400 recognizes model-not-supported shapes (incl. invalid/Bad Request wrappers)", () => {
    assert.equal(isModelScoped400("requested model is not supported"), true);
    assert.equal(isModelScoped400("model claude-fable-5 is not supported"), true);
    assert.equal(isModelScoped400("invalid_request_error: model is not supported"), true);
    assert.equal(isModelScoped400("Bad Request: The model is not supported"), true);
    assert.equal(isModelScoped400("model claude-fable-5 does not support Responses API."), true);
    assert.equal(isModelScoped400("unsupported_api_for_model"), true);
    assert.equal(
      isModelScoped400("The model `x` does not exist or you do not have access to it."),
      true
    );
    // Genuinely body-specific — must NOT be treated as model-scoped
    assert.equal(isModelScoped400("Invalid message format: the request body is malformed."), false);
    assert.equal(isModelScoped400("malformed JSON in request body"), false);
    assert.equal(isModelScoped400("Invalid field: foo is not a recognized field"), false);
  });

  async function assertAdvancesOn(errorMessage: string, label: string) {
    const modelsCalled: string[] = [];
    const response = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["github/claude-fable-5", "claude/claude-fable-5"]),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        modelsCalled.push(modelStr);
        if (modelStr === "github/claude-fable-5") {
          return Response.json(
            { error: { message: errorMessage, type: "invalid_request_error" } },
            { status: 400 }
          );
        }
        return okResponse(modelStr);
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(
      response.status,
      200,
      `${label}: combo should advance to second model and return 200 (got ${response.status})`
    );
    assert.deepEqual(
      modelsCalled,
      ["github/claude-fable-5", "claude/claude-fable-5"],
      `${label}: must try both targets; tried: ${modelsCalled.join(", ")}`
    );
  }

  test("combo advances when first target returns plain 'model is not supported'", async () => {
    await assertAdvancesOn("requested model is not supported", "plain");
  });

  test("combo advances when first target wraps model rejection in invalid_request_error", async () => {
    await assertAdvancesOn(
      "invalid_request_error: model claude-fable-5 is not supported",
      "invalid_request_error wrapper"
    );
  });

  test("combo advances when first target returns Bad Request + model not supported", async () => {
    await assertAdvancesOn("Bad Request: The model is not supported", "Bad Request wrapper");
  });

  test("combo advances when first target rejects model for Responses API", async () => {
    await assertAdvancesOn(
      "model claude-fable-5 does not support Responses API.",
      "Responses API capability"
    );
  });

  test("combo still STOPS on genuinely body-specific invalid message format", async () => {
    const modelsCalled: string[] = [];
    const response = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["a/model-1", "b/model-2", "c/model-3"]),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        modelsCalled.push(modelStr);
        return Response.json(
          { detail: "Invalid message format: the request body is malformed." },
          { status: 400 }
        );
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(
      modelsCalled.length,
      1,
      `body-specific 400 must stop at target 1; tried: ${modelsCalled.join(", ")}`
    );
    assert.equal(response.status, 400, "body-specific 400 must surface to the client");
  });
});

describe("combo-error-code-terminal", () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };
  const replayMessage = "The encrypted content could not be verified.";
  let comboIndex = 0;

  beforeEach(resetSharedState);

  after(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    clearAllModelLockouts();
    resetAllSemaphores();
  });

  function failure(code?: string, message = replayMessage, status = 400) {
    return new Response(JSON.stringify({ error: { message, code } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function runCombo(strategy: string, responses: Response[]) {
    let attempts = 0;
    const name = `terminal-code-${strategy}-${comboIndex++}`;
    return handleComboChat({
      body: { model: "test-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      combo: {
        name,
        strategy,
        models: responses.map((_, index) => `${index === 0 ? "codex" : "openai"}/${name}-${index}`),
        config: { maxRetries: 0 },
      },
      handleSingleModel: async () => {
        assert.ok(attempts < responses.length, "must not retry a request-scoped failure");
        return responses[attempts++];
      },
      isModelAvailable: async () => true,
      log,
      settings: {},
      allCombos: [],
    });
  }

  for (const strategy of ["priority", "round-robin"]) {
    test(`${strategy}: terminal reasoning replay code reaches the Responses SSE error frame`, async () => {
      let resolveResponse!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      const stream = await withEarlyStreamKeepalive(pending, {
        thresholdMs: 1,
        intervalMs: 10,
        errorFrame: OPENAI_RESPONSES_ERROR_FRAME,
      });
      resolveResponse(await runCombo(strategy, [failure("invalid_encrypted_content")]));
      assert.equal(stream.status, 200);
      const frames = [...(await stream.text()).matchAll(/^data: (.+)$/gm)];
      const frame = JSON.parse(frames.at(-1)![1]);
      assert.equal(frame.type, "error");
      assert.equal(frame.code, "invalid_encrypted_content");
      assert.match(frame.message, /encrypted content could not be verified/);
      if (strategy === "priority") assert.equal(frame.diagnostics.attempted, 1);
    });

    test(`${strategy}: aggregation preserves the final target's code after fallback`, async () => {
      const response = await runCombo(strategy, [
        failure("bad_request", "Other request rejection"),
        failure("invalid_encrypted_content"),
      ]);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, "invalid_encrypted_content");
      assert.match(body.error.message, /Other request rejection/);
      assert.match(body.error.message, /encrypted content could not be verified/);
    });

    test(`${strategy}: a final uncoded error does not inherit an earlier target's code`, async () => {
      const response = await runCombo(strategy, [failure("invalid_encrypted_content"), failure()]);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "bad_request");
    });

    test(`${strategy}: unrecognized upstream codes still pass through public sanitization`, async () => {
      const response = await runCombo(strategy, [failure("private_account_identifier")]);
      assert.equal((await response.json()).error.code, "bad_request");
    });

    test(`${strategy}: mixed auth and model failures keep the aggregate gateway verdict`, async () => {
      const response = await runCombo(strategy, [
        failure("invalid_api_key", "Invalid API key", 401),
        failure("invalid_encrypted_content"),
      ]);
      assert.equal(response.status, 502);
      assert.notEqual((await response.json()).error.code, "invalid_encrypted_content");
    });
  }

  test("priority: a body-specific terminal error keeps its code when fallback stops early", async () => {
    const response = await runCombo("priority", [
      failure("invalid_encrypted_content", "Invalid JSON: encrypted content could not be parsed"),
    ]);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_encrypted_content");
  });
});

describe("combo-connection-cooldown-terminal-16718", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };

  beforeEach(resetSharedState);
  after(() => {
    clearAllModelLockouts();
  });

  async function run(models: string[], availability: ModelAvailabilityResult, failureStatus = 402) {
    const dispatched: string[] = [];
    const response = await handleComboChat({
      body: {},
      combo: {
        name: "connection-cooldown-16718",
        strategy: "priority",
        models,
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      isModelAvailable: async (model) => (model.startsWith("anthropic/") ? availability : true),
      handleSingleModel: async (_body, model) => {
        dispatched.push(model);
        return model.startsWith("anthropic/")
          ? Response.json({ choices: [{ message: { content: "recovered" } }] })
          : Response.json({ error: { message: "Payment required" } }, { status: failureStatus });
      },
      log,
      settings: {
        resilienceSettings: {
          comboCooldownWait: {
            enabled: false,
            maxWaitMs: 90_000,
            maxAttempts: 1,
            budgetMs: 90_000,
          },
        },
      },
      allCombos: null,
    });
    return { response, dispatched };
  }

  for (const models of [
    ["openai/gpt-4o", "anthropic/claude-sonnet-4"],
    ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
  ]) {
    test(`a temporary peer makes 402 retryable in order ${models.join(", ")}`, async () => {
      const { response, dispatched } = await run(models, {
        available: false,
        reason: "connection_cooldown",
        retryAfterMs: 30_000,
      });
      assert.equal(response.status, 429);
      const retryAfter = Number(response.headers.get("retry-after"));
      assert.ok(
        retryAfter > 0 && retryAfter <= 30,
        `expected a bounded Retry-After: ${retryAfter}`
      );
      assert.deepEqual(dispatched, ["openai/gpt-4o"]);
    });
  }

  test("an unavailable peer without a cooldown does not change payment failure", async () => {
    const { response } = await run(["openai/gpt-4o", "anthropic/claude-sonnet-4"], false);
    assert.equal(response.status, 402);
    assert.equal(response.headers.get("retry-after"), null);
  });

  test("a ready peer still serves the request", async () => {
    const { response } = await run(["openai/gpt-4o", "anthropic/claude-sonnet-4"], true);
    assert.equal(response.status, 200);
  });

  test("a request error is not converted into a payment cooldown retry", async () => {
    const { response } = await run(
      ["openai/gpt-4o", "anthropic/claude-sonnet-4"],
      { available: false, reason: "connection_cooldown", retryAfterMs: 30_000 },
      400
    );
    assert.equal(response.status, 400);
  });
});

describe("combo-pinned-cooldown-terminal-16718", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const NOW = Date.parse("2030-01-01T00:00:00Z");

  before(resetSharedState);
  beforeEach((context) => {
    context.mock.timers.enable({ apis: ["Date"], now: NOW });
    clearAllModelLockouts();
    resetAllComboMetrics();
  });
  after(() => {
    clearAllModelLockouts();
  });

  async function run(
    options: {
      pinnedFirst?: boolean;
      status?: string;
      active?: boolean;
      until?: string | null;
      peerStatus?: number;
    } = {}
  ) {
    const connection = await createProviderConnection({
      provider: "anthropic",
      authType: "apikey",
      name: "pinned-cooldown-fixture",
      apiKey: "fixture-not-a-real-key",
      isActive: options.active ?? true,
      testStatus: options.status ?? "unavailable",
      lastErrorAt: new Date(NOW).toISOString(),
      rateLimitedUntil:
        options.until === undefined ? new Date(NOW + 5000).toISOString() : options.until,
    });
    invalidateDbCache("connections");
    const pinned = {
      kind: "model" as const,
      model: "anthropic/claude-sonnet-4",
      connectionId: connection.id,
    };
    const peer = "openai/gpt-4o";
    const dispatched: string[] = [];
    const messages: string[] = [];
    const response = await handleComboChat({
      body: {},
      combo: {
        name: "pinned-connection-cooldown-16718",
        strategy: "priority",
        models: options.pinnedFirst ? [pinned, peer] : [peer, pinned],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      isModelAvailable: async () => true,
      handleSingleModel: async (_body, model) => {
        dispatched.push(model);
        if (model.startsWith("anthropic/") || options.peerStatus === 200) {
          return Response.json({ choices: [{ message: { content: "success" } }] });
        }
        return Response.json(
          { error: { message: "Payment required" } },
          { status: options.peerStatus ?? 402 }
        );
      },
      log: {
        ...log,
        info: (...args: unknown[]) => {
          messages.push(args.join(" "));
        },
      },
      settings: {
        resilienceSettings: {
          comboCooldownWait: {
            enabled: false,
            maxWaitMs: 90_000,
            maxAttempts: 1,
            budgetMs: 90_000,
          },
        },
      },
      allCombos: null,
    });
    return { response, dispatched, messages };
  }

  for (const pinnedFirst of [false, true]) {
    test(`a pinned temporary peer makes 402 retryable, pinnedFirst=${pinnedFirst}`, async () => {
      const { response, dispatched, messages } = await run({ pinnedFirst });
      assert.deepEqual(dispatched, ["openai/gpt-4o"]);
      assert.ok(
        messages.some((message) => message.includes("has persisted cooldown until")),
        "must exercise the persisted gate"
      );
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "5");
    });
  }

  for (const status of ["banned", "expired", "credits_exhausted", "deactivated"]) {
    test(`a terminal ${status} row with a future timestamp never supplies a retry hint`, async () => {
      const { response, dispatched } = await run({ status });
      assert.equal(response.status, 402);
      assert.equal(response.headers.get("retry-after"), null);
      assert.deepEqual(dispatched, ["openai/gpt-4o"]);
    });
  }

  test("an inactive row with a future cooldown never supplies a retry hint or dispatches", async () => {
    const { response, dispatched } = await run({ active: false });
    assert.equal(response.status, 402);
    assert.equal(response.headers.get("retry-after"), null);
    assert.deepEqual(dispatched, ["openai/gpt-4o"]);
  });

  for (const until of [null, "invalid-timestamp", new Date(NOW - 1000).toISOString()]) {
    test(`a recent unavailable label without a future deadline does not invent a retry: ${until}`, async () => {
      const { response } = await run({ until });
      assert.equal(response.status, 402);
      assert.equal(response.headers.get("retry-after"), null);
    });
  }

  test("an elapsed cooldown on an active pinned connection succeeds", async () => {
    const { response, dispatched } = await run({
      status: "active",
      until: new Date(NOW - 1000).toISOString(),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(dispatched, ["openai/gpt-4o", "anthropic/claude-sonnet-4"]);
  });

  test("a request error stays 400 even with a pinned cooldown", async () => {
    const { response } = await run({ pinnedFirst: true, peerStatus: 400 });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("retry-after"), null);
  });

  test("a healthy peer still succeeds while the pinned connection cools down", async () => {
    const { response, dispatched } = await run({ pinnedFirst: true, peerStatus: 200 });
    assert.equal(response.status, 200);
    assert.deepEqual(dispatched, ["openai/gpt-4o"]);
  });
});

describe("combo-protected-stop-diagnostics", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    resetComboTraceStore();
  });
  after(() => {
    resetAllCircuitBreakers();
  });

  async function run(primaryFails: boolean) {
    const calls: string[] = [];
    const response = await handleComboChat({
      body: {},
      combo: {
        name: "synthetic-protected-fallback",
        strategy: "priority",
        models: [
          { model: "openai/primary" },
          { model: "claude/reserve", fallbackOnlyOnQuotaExhaustion: true },
        ],
        config: { maxRetries: 0, maxSetRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      isModelAvailable: (model) => model === "openai/primary",
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return new Response(
          JSON.stringify(
            primaryFails
              ? { error: { message: "Upstream response failed", type: "server_error" } }
              : { choices: [{ message: { content: "ok" } }] }
          ),
          {
            status: primaryFails ? 502 : 200,
            headers: { "content-type": "application/json" },
          }
        );
      },
      log: { info() {}, warn() {}, debug() {}, error() {} },
      settings: null,
      allCombos: null,
    });
    return {
      response,
      calls,
      trace: getComboTrace(response.headers.get("x-omniroute-combo-trace")!),
    };
  }

  test("protected fallback refusal must not record a successful terminal trace", async () => {
    const { response, calls, trace } = await run(true);
    assert.equal(response.status, 503);
    assert.deepEqual(calls, ["openai/primary"]);
    assert.equal(trace?.terminal?.status, response.status);
  });

  test("protected fallback refusal preserves evidence of the earlier upstream failure", async () => {
    const { response } = await run(true);
    const body = await response.json();
    assert.equal(response.status, 503, "keep the protected-stop policy status");
    assert.match(body.error.message, /claude\/reserve.*unavailable/);
    assert.match(body.error.message, /openai\/primary.*502/);
    assert.equal(body.diagnostics.attempted, 1);
    assert.equal(body.diagnostics.terminalReason, "protected_priority_stop");
  });

  test("healthy primary still returns its original response and a successful trace", async () => {
    const { response, calls, trace } = await run(false);
    assert.equal(response.status, 200);
    assert.equal(trace?.terminal?.status, 200);
    assert.deepEqual(calls, ["openai/primary"]);
    assert.equal((await response.json()).choices[0].message.content, "ok");
  });
});

describe("combo-resource-404-health", () => {
  const settings = {
    modelLockout: {
      enabled: true,
      errorCodes: [404],
      baseCooldownMs: 120_000,
      maxCooldownMs: 1_800_000,
      maxBackoffSteps: 10,
      useExponentialBackoff: true,
    },
    providerCooldown: {
      enabled: true,
      minRetryCooldownMs: 1_000,
      maxRetryCooldownMs: 60_000,
    },
  };

  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  beforeEach(() => {
    clearAllModelLockouts();
    clearCooldownState();
  });

  after(() => {
    clearAllModelLockouts();
    clearCooldownState();
  });

  test("combo resource 404 never records model lockout or provider cooldown", async () => {
    const provider = "openai";
    const models = ["gpt-5", "gpt-4o"];

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "read the attached file" }] },
      combo: {
        name: "resource-404-health",
        strategy: "priority",
        models: models.map((model) => `${provider}/${model}`),
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      handleSingleModel: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "[404]: Files [file-be30851bd1614656872e725e] were not found",
              type: "invalid_request_error",
              code: "model_not_found",
            },
          }),
          { status: 404, headers: { "content-type": "application/json" } }
        ),
      isModelAvailable: async () => true,
      log,
      settings,
      allCombos: null,
    });

    assert.equal(result.status, 404);
    for (const model of models) {
      assert.equal(
        getModelLockoutInfo(provider, "", model),
        null,
        `${model} must remain available after a request-resource 404`
      );
    }
    assert.equal(isProviderInCooldown(provider, undefined, settings), false);
  });
});

describe("combo-10597-error-body-logging", () => {
  // #10597 — When a combo target fails with a non-2xx status, the per-target "Model X failed,
  // trying next" COMBO log line only carries `{ status }` — the upstream error BODY (e.g.
  // Anthropic's "prompt is too long" or a tool_use/tool_result pairing 400) is captured in
  // `errorText` but never logged, so operators cannot distinguish failure causes from server
  // logs without reproducing the request.
  before(resetSharedState);

  const DISTINCTIVE_ERROR_TEXT =
    "messages.450: `tool_use` ids were found without `tool_result` blocks immediately after";

  type WarnCall = { tag: string; msg: string; meta: unknown };
  const warnCalls: WarnCall[] = [];
  const log = {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (tag: string, msg: string, meta?: unknown) => {
      warnCalls.push({ tag, msg, meta });
    },
  };

  function failing400() {
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: DISTINCTIVE_ERROR_TEXT },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  function healthy200(model: string) {
    return new Response(
      JSON.stringify({
        id: "ok",
        object: "chat.completion",
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from " + model },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  function makeCombo(models: string[]) {
    return {
      name: "test-combo-10597",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  test("#10597 COMBO failure log must surface the upstream error body, not just the status code", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      if (modelsCalled.length === 1) return failing400();
      return healthy200(modelStr);
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["claude/claude-opus-4-8", "openai/gpt-4o-mini"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(result.status, 200);
    assert.equal(modelsCalled.length, 2);

    const failureLog = warnCalls.find(
      (c) =>
        typeof c.msg === "string" &&
        c.msg.includes("claude/claude-opus-4-8") &&
        c.msg.includes("failed")
    );
    assert.ok(failureLog, "expected a COMBO warn log for the failing leg");

    const serialized = JSON.stringify(failureLog);
    assert.ok(
      serialized.includes("tool_use") || serialized.includes(DISTINCTIVE_ERROR_TEXT),
      `expected the upstream error body to appear in the COMBO failure log, but got: ${serialized}`
    );
  });
});
