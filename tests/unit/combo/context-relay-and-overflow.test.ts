// Context relay and context-overflow handling of handleComboChat: relay handoffs and pins,
// the #15289 attempt-budget overflow cause, Claude-wire terminal wording and the #8375
// input-bound short-circuit. Merged from six files so the combo.ts module graph loads once; each
// original file is one `describe` below, named after the file it came from.
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedComboUnit } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-context-relay-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-context-relay-test-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const core = await import("../../../src/lib/db/core.ts");
const handoffDb = await import("../../../src/lib/db/contextHandoffs.ts");
const { scopeHandoffSessionId } =
  await import("../../../open-sse/services/combo/handoffSessionScope.ts");
const { isContextOverflowDominant, buildContextBudgetResponse, CONTEXT_OVERFLOW_BUDGET_MESSAGE } =
  await import("../../../open-sse/services/combo/budgetExhaustion.ts");
const { executeRuntimeUnitCombo } =
  await import("../../../open-sse/services/combo/runtimeUnits.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const { registerCodexConnection } = await import("../../../open-sse/services/codexQuotaFetcher.ts");
const { clearSessions, touchSession } =
  await import("../../../open-sse/services/sessionManager.ts");
const { resetAllComboMetrics } = await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearAllModelLockouts } = await import("../../../open-sse/services/accountFallback.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../../open-sse/services/rateLimitSemaphore.ts");
const { _resetAllDecks } = await import("../../../src/shared/utils/shuffleDeck.ts");

const originalFetch = globalThis.fetch;

// Each source file used to start in a fresh process; every describe starts from clean combo
// metrics, circuit breakers, lockouts, semaphores, decks and sessions.
function resetInMemoryState() {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  resetAllSemaphores();
  _resetAllDecks();
  clearSessions();
}

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-context-relay", () => {
  function createLog() {
    const entries = [];
    return {
      info: (tag, msg) => entries.push({ level: "info", tag, msg }),
      warn: (tag, msg) => entries.push({ level: "warn", tag, msg }),
      error: (tag, msg) => entries.push({ level: "error", tag, msg }),
      entries,
    };
  }

  function okResponse(body = { choices: [{ message: { content: "ok" } }] }) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function providerBreakerOpenResponse() {
    return new Response(
      JSON.stringify({
        error: {
          message: "Provider circuit breaker is open",
          code: "provider_circuit_open",
        },
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "x-omniroute-provider-breaker": "open",
        },
      }
    );
  }

  function buildQuotaResponse(usedPercent, resetAfterSeconds = 3600) {
    return new Response(
      JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: usedPercent,
            reset_after_seconds: resetAfterSeconds,
          },
          secondary_window: {
            used_percent: 0,
            reset_after_seconds: 86400,
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  async function waitFor(fn, timeoutMs = 1500) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = await fn();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  beforeEach(async () => {
    resetInMemoryState();
    globalThis.fetch = originalFetch;
    await resetStorage();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    clearSessions();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  after(async () => {
    resetInMemoryState();
    globalThis.fetch = originalFetch;
    await resetStorage();
  });

  test("handleComboChat context-relay routes to the first available model", async () => {
    const calls = [];

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Hello" }],
      },
      combo: {
        name: "relay-first",
        strategy: "context-relay",
        models: ["openai/gpt-4o-mini", "claude/sonnet"],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/gpt-4o-mini"]);
  });

  test("handleComboChat context-relay skips unavailable models and falls through to the next one", async () => {
    const calls = [];

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Fallback" }],
      },
      combo: {
        name: "relay-skip-unavailable",
        strategy: "context-relay",
        models: ["codex/gpt-5.6-sol", "openai/gpt-4o-mini"],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async (modelStr) => modelStr !== "codex/gpt-5.6-sol",
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: {
        sessionId: "sess-skip",
        config: { handoffProviders: ["codex"] },
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/gpt-4o-mini"]);
  });

  test("handleComboChat context-relay treats provider circuit breaker responses as ordinary target failures", async () => {
    const combo = {
      name: "relay-breaker",
      strategy: "context-relay",
      models: ["codex/gpt-5.6-sol", "openai/gpt-4o-mini"],
      config: { maxRetries: 0 },
    };
    const calls = [];

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Breaker" }],
      },
      combo,
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        if (modelStr === "codex/gpt-5.6-sol") {
          return providerBreakerOpenResponse();
        }
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["codex/gpt-5.6-sol", "openai/gpt-4o-mini"]);
  });

  test("handleComboChat context-relay persists a handoff when codex quota reaches the warning threshold", async () => {
    const sessionId = "sess-generate";
    // Rows are stored under the caller-scoped id; this call has no API key.
    const storedSessionId = scopeHandoffSessionId(sessionId, null)!;
    const connectionId = "conn-generate";
    touchSession(sessionId, connectionId);
    registerCodexConnection(connectionId, {
      accessToken: "token-generate",
      workspaceId: "ws-generate",
    });

    let usageCalls = 0;
    let summaryCalls = 0;

    globalThis.fetch = async (url) => {
      if (String(url).includes("/backend-api/wham/usage")) {
        usageCalls += 1;
        return buildQuotaResponse(87);
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    };

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Keep context alive" }],
      },
      combo: {
        name: "relay-generate",
        strategy: "context-relay",
        models: ["codex/gpt-5.6-sol"],
        config: { maxRetries: 0, handoffThreshold: 0.85, handoffProviders: ["codex"] },
      },
      handleSingleModel: async (body) => {
        if (body._omnirouteInternalRequest === "context-handoff") {
          summaryCalls += 1;
          return okResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Generated from combo-level test",
                    keyDecisions: ["generate at 85%"],
                    taskProgress: "ready",
                    activeEntities: ["combo.ts"],
                  }),
                },
              },
            ],
          });
        }

        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: {
        sessionId,
        config: {
          handoffThreshold: 0.85,
          handoffProviders: ["codex"],
        },
      },
    });

    const saved = await waitFor(() => handoffDb.getHandoff(storedSessionId, "relay-generate"));

    assert.equal(result.ok, true);
    assert.equal(usageCalls, 1);
    assert.equal(summaryCalls, 1);
    assert.ok(saved);
    assert.equal(saved.summary, "Generated from combo-level test");
    assert.equal(saved.fromAccount, connectionId);
  });

  test("handleComboChat context-relay respects handoffProviders and skips generation when codex is disabled", async () => {
    const sessionId = "sess-disabled-provider";
    const connectionId = "conn-disabled-provider";
    touchSession(sessionId, connectionId);
    registerCodexConnection(connectionId, {
      accessToken: "token-disabled-provider",
      workspaceId: "ws-disabled-provider",
    });

    let usageCalls = 0;
    let summaryCalls = 0;

    globalThis.fetch = async (url) => {
      if (String(url).includes("/backend-api/wham/usage")) {
        usageCalls += 1;
        return buildQuotaResponse(90);
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    };

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Do not generate" }],
      },
      combo: {
        name: "relay-disabled-provider",
        strategy: "context-relay",
        models: ["codex/gpt-5.6-sol"],
        config: { maxRetries: 0, handoffProviders: ["openai"] },
      },
      handleSingleModel: async (body) => {
        if (body._omnirouteInternalRequest === "context-handoff") {
          summaryCalls += 1;
        }
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: {
        sessionId,
        config: {
          handoffProviders: ["openai"],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(result.ok, true);
    assert.equal(usageCalls, 0);
    assert.equal(summaryCalls, 0);
    assert.equal(
      await handoffDb.getHandoff(
        scopeHandoffSessionId(sessionId, null)!,
        "relay-disabled-provider"
      ),
      null
    );
  });

  test("handleComboChat context-relay treats explicit empty handoffProviders as disabled", async () => {
    const sessionId = "sess-empty-providers";
    const connectionId = "conn-empty-providers";
    touchSession(sessionId, connectionId);
    registerCodexConnection(connectionId, {
      accessToken: "token-empty-providers",
      workspaceId: "ws-empty-providers",
    });

    let usageCalls = 0;

    globalThis.fetch = async (url) => {
      if (String(url).includes("/backend-api/wham/usage")) {
        usageCalls += 1;
        return buildQuotaResponse(91);
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    };

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Disabled by empty list" }],
      },
      combo: {
        name: "relay-empty-providers",
        strategy: "context-relay",
        models: ["codex/gpt-5.6-sol"],
        config: { maxRetries: 0, handoffProviders: [] },
      },
      handleSingleModel: async () => okResponse(),
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: {
        sessionId,
        config: {
          handoffProviders: [],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(result.ok, true);
    assert.equal(usageCalls, 0);
    assert.equal(
      await handoffDb.getHandoff(scopeHandoffSessionId(sessionId, null)!, "relay-empty-providers"),
      null
    );
  });

  test("getLastSessionModel returns the most recently recorded model for a session", async () => {
    // One upserted row per (combo, session): a second record replaces the first, so there is
    // no tie to break. The newest write wins.
    const sessionId = "sess-model-history-tie";
    const comboName = "relay-model-history-tie";

    await handoffDb.recordSessionModelUsage(sessionId, comboName, "openai/old", "openai");
    await handoffDb.recordSessionModelUsage(sessionId, comboName, "anthropic/new", "anthropic");

    assert.equal(await handoffDb.getLastSessionModel(sessionId, comboName), "anthropic/new");
  });

  test("handleComboChat universal handoff skips same-request fallback targets entirely", async () => {
    // #12227 follow-up: a same-request fallback target (i > 0) serves the SAME
    // client request the failed primary target would have served -- the client
    // never saw the earlier target fail, so there's no genuine "handoff" to
    // explain. Injecting one there replaces real conversation content with a
    // context-free note; weaker fallback models have been observed fabricating
    // content instead of just answering the actual request when handed that
    // note. The fallback target must receive the original request untouched.
    const sessionId = "sess-universal-no-mutate";
    const comboName = "universal-no-mutate";
    const storedSessionId = scopeHandoffSessionId(sessionId, null)!;

    await handoffDb.recordSessionModelUsage(
      storedSessionId,
      comboName,
      "openai/previous",
      "openai"
    );
    await handoffDb.upsertHandoff({
      sessionId: storedSessionId,
      comboName,
      fromAccount: "universal:openai/previous",
      summary: "Previous model summary",
      keyDecisions: ["keep context"],
      taskProgress: "fallback pending",
      activeEntities: ["combo.ts"],
      messageCount: 1,
      model: "openai/previous",
      lastModel: "openai/previous",
      warningThresholdPct: 0,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const calls = [];

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Continue" }],
      },
      combo: {
        name: comboName,
        strategy: "priority",
        models: ["openai/failed", "anthropic/fallback"],
        config: { maxRetries: 0 },
        universalHandoff: { enabled: true },
      },
      handleSingleModel: async (body, modelStr) => {
        calls.push({ modelStr, body });
        if (modelStr === "openai/failed") {
          return new Response(JSON.stringify({ error: { message: "fail" } }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: { sessionId },
    });

    assert.equal(result.ok, true);

    const fallbackBody = calls.find((call) => call.modelStr === "anthropic/fallback")?.body;
    const handoffMessages = (fallbackBody.messages || []).filter(
      (message) =>
        typeof message?.content === "string" && message.content.includes("<context_handoff>")
    );

    assert.equal(handoffMessages.length, 0);
    assert.deepEqual(fallbackBody.messages, [{ role: "user", content: "Continue" }]);
  });

  test("handleComboChat universal handoff detects model switch before recording current model", async () => {
    const sessionId = "sess-universal-switch";
    const comboName = "universal-switch";
    const storedSessionId = scopeHandoffSessionId(sessionId, null)!;

    await handoffDb.recordSessionModelUsage(
      storedSessionId,
      comboName,
      "openai/previous",
      "openai"
    );
    await getTestBackend().execute(
      `UPDATE session_model_pins SET used_at = $1 WHERE session_id = $2 AND combo_name = $3`,
      ["2000-01-01T00:00:00Z", storedSessionId, comboName]
    );

    let summaryCalls = 0;

    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Continue on a new model" }],
      },
      combo: {
        name: comboName,
        strategy: "priority",
        models: ["anthropic/current"],
        config: { maxRetries: 0 },
        universalHandoff: { enabled: true },
      },
      handleSingleModel: async (body) => {
        if (body._omnirouteInternalRequest === "universal-handoff") {
          summaryCalls += 1;
          return okResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Generated universal handoff",
                    keyDecisions: ["read previous before recording current"],
                    taskProgress: "switch detected",
                    activeEntities: ["open-sse/services/combo.ts"],
                  }),
                },
              },
            ],
          });
        }

        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: { sessionId },
    });

    const saved = await waitFor(() => handoffDb.getHandoff(storedSessionId, comboName));

    assert.equal(result.ok, true);
    assert.equal(summaryCalls, 1);
    assert.ok(saved);
    assert.equal(saved.lastModel, "openai/previous");
  });

  // ── Rule #18 gate — PR #3399: server-side context cache pinning ─────────────
  // Proves that when context_cache_protection=true and session_model_history has
  // a prior model, handleComboChat overrides body.model with the pinned model
  // (no client-side <omniModel> tag injection required).

  test("context_cache_protection: pins body.model to last session model when history exists", async () => {
    const sessionId = "sess-cache-pin-active";
    const comboName = "cache-pin-combo";
    const storedSessionId = scopeHandoffSessionId(sessionId, null)!;

    // Pre-record a prior model usage for this session/combo
    await handoffDb.recordSessionModelUsage(
      storedSessionId,
      comboName,
      "anthropic/claude-3-5-sonnet",
      "anthropic"
    );

    // Ensure anthropic provider has an active connection so the pin isn't
    // dropped by isPinnedModelDurablyUnhealthy (no connections = durably down).
    await providersDb.createProviderConnection({
      provider: "anthropic",
      authType: "apikey",
      name: "test-anthropic",
      apiKey: "sk-test-anthropic",
      isActive: true,
    });

    const capturedModels: string[] = [];

    const result = await handleComboChat({
      body: {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "Continue the task" }],
      },
      combo: {
        name: comboName,
        strategy: "priority",
        models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
        config: { maxRetries: 0 },
        context_cache_protection: true,
      },
      handleSingleModel: async (body, modelStr) => {
        capturedModels.push(modelStr);
        capturedModels.push(body?.model as string);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: { sessionId },
    });

    assert.equal(result.ok, true);
    // The first model tried must be the pinned one, not the combo's first model
    assert.equal(capturedModels[0], "anthropic/claude-3-5-sonnet", "modelStr must be pinned model");
    // body.model must also reflect the pinned model
    assert.equal(
      capturedModels[1],
      "anthropic/claude-3-5-sonnet",
      "body.model must be pinned model"
    );
  });

  test("context_cache_protection: does NOT pin when no session history exists (first request)", async () => {
    const sessionId = "sess-cache-pin-first";
    const comboName = "cache-pin-first-combo";
    // No prior recordSessionModelUsage call — fresh session

    const capturedModels: string[] = [];

    const result = await handleComboChat({
      body: {
        model: "openai/gpt-4o",
        messages: [{ role: "user", content: "First message" }],
      },
      combo: {
        name: comboName,
        strategy: "priority",
        models: ["openai/gpt-4o"],
        config: { maxRetries: 0 },
        context_cache_protection: true,
      },
      handleSingleModel: async (_body, modelStr) => {
        capturedModels.push(modelStr);
        return okResponse();
      },
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
      relayOptions: { sessionId },
    });

    assert.equal(result.ok, true);
    // No pinning on first request — should use the combo's first model
    assert.equal(
      capturedModels[0],
      "openai/gpt-4o",
      "first request must use combo model (no pinning)"
    );
  });

  // ── clearSessionModelHistoryForCombo ────────────────────────────────────────
  // Proves that clearing pins for a combo name removes stale session history,
  // so that after a combo edit the next request does NOT use the old pinned model.

  test("clearSessionModelHistoryForCombo removes all pins for a combo", async () => {
    const comboName = "test-clear-pins";

    // Seed history for two different sessions on the same combo
    await handoffDb.recordSessionModelUsage("sess-A", comboName, "openai/gpt-4o", "openai");
    await handoffDb.recordSessionModelUsage(
      "sess-B",
      comboName,
      "anthropic/claude-3-5-sonnet",
      "anthropic"
    );

    // Sanity: pins exist
    assert.equal(await handoffDb.getLastSessionModel("sess-A", comboName), "openai/gpt-4o");
    assert.equal(
      await handoffDb.getLastSessionModel("sess-B", comboName),
      "anthropic/claude-3-5-sonnet"
    );

    // Clear pins for this combo
    const cleared = await handoffDb.clearSessionModelHistoryForCombo(comboName);
    assert.ok(cleared >= 2, `should have cleared at least 2 entries, got ${cleared}`);

    // Pins are gone
    assert.equal(await handoffDb.getLastSessionModel("sess-A", comboName), null);
    assert.equal(await handoffDb.getLastSessionModel("sess-B", comboName), null);
  });

  test("clearSessionModelHistoryForCombo does not affect other combos", async () => {
    const comboA = "combo-keep";
    const comboB = "combo-clear";

    await handoffDb.recordSessionModelUsage("sess-1", comboA, "openai/gpt-4o", "openai");
    await handoffDb.recordSessionModelUsage(
      "sess-1",
      comboB,
      "anthropic/claude-3-5-sonnet",
      "anthropic"
    );

    // Clear only comboB
    await handoffDb.clearSessionModelHistoryForCombo(comboB);

    // comboA is untouched
    assert.equal(await handoffDb.getLastSessionModel("sess-1", comboA), "openai/gpt-4o");
    // comboB is cleared
    assert.equal(await handoffDb.getLastSessionModel("sess-1", comboB), null);
  });
});

describe("combo-context-overflow-budget-15289", () => {
  before(resetInMemoryState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function ctxOverflow(model: string) {
    return new Response(
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: `Input exceeds the context window for ${model}: estimated 137000 input tokens, limit 128000.`,
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  test("#15289 heterogeneous pool all rejecting oversized input surfaces context error, not opaque retry-limit", async () => {
    const models = Array.from({ length: 40 }, (_, i) => `prov${i}/model-${i}`);
    const called: string[] = [];
    const result = await handleComboChat({
      body: { model: "x", messages: [{ role: "user", content: "hi" }] },
      combo: { name: "c15289", strategy: "priority", models: models.map((m) => ({ model: m })) },
      handleSingleModel: async (_b: unknown, m: string) => {
        called.push(m);
        return ctxOverflow(m);
      },
      log,
      settings: {},
      allCombos: [],
    });
    const body = await result.clone().json();
    assert.equal(result.status, 400);
    assert.equal(body.error.code, "context_length_exceeded");
    assert.notEqual(body.error.message, "Maximum combo retry limit reached");
    assert.match(body.error.message, /context window/);
    assert.ok(body.diagnostics, "diagnostics trace is still attached");
  });

  test("#15289 isContextOverflowDominant requires overflow to dominate", () => {
    const ov = { status: 400, error: "Input exceeds the context window" };
    const other = { status: 503, error: "upstream down" };
    assert.equal(
      isContextOverflowDominant("Input exceeds the context window", [ov, ov, other]),
      true
    );
    assert.equal(
      isContextOverflowDominant("Input exceeds the context window", [ov, other, other]),
      false
    );
    assert.equal(isContextOverflowDominant("upstream down", [ov, ov]), false);
    assert.equal(isContextOverflowDominant("", []), false);
  });
});

describe("combo-remaining-overflow-budget-15289", () => {
  before(resetInMemoryState);

  const log = { info() {}, warn() {}, error() {}, debug() {} };

  function failure(overflow: boolean): Response {
    return new Response(
      JSON.stringify({
        error: {
          message: overflow ? "Input exceeds the context window" : "upstream unavailable",
          code: overflow ? "context_length_exceeded" : "service_unavailable",
        },
      }),
      { status: overflow ? 400 : 503, headers: { "content-type": "application/json" } }
    );
  }

  for (const strategy of ["round-robin", "nested"] as const) {
    for (const failures of [
      [true, true, true],
      [false, false, true],
      [true, true, false],
    ]) {
      test(`#15289 ${strategy} budget preserves dominant context cause: ${failures}`, async () => {
        const models = [
          "openai/budget-a",
          "anthropic/budget-b",
          "gemini/budget-c",
          "codex/budget-d",
        ];
        let called = 0;
        const handleSingleModel = async () => failure(failures[called++]);
        const config = {
          maxRetries: 0,
          maxGlobalAttempts: 3,
          retryDelayMs: 0,
          fallbackDelayMs: 0,
        };
        const response =
          strategy === "round-robin"
            ? await handleComboChat({
                body: { messages: [{ role: "user", content: "hi" }] },
                combo: { name: `rr-15289-${failures}`, strategy, models, config },
                handleSingleModel,
                isModelAvailable: async () => true,
                log,
                settings: {},
                allCombos: [],
              })
            : (
                await executeRuntimeUnitCombo({
                  body: { messages: [{ role: "user", content: "hi" }] },
                  combo: { name: "nested-15289", strategy: "pipeline" },
                  strategy: "pipeline",
                  units: models.map((modelStr, i): ResolvedComboUnit => ({
                    kind: "model",
                    modelStr,
                    provider: modelStr.split("/")[0],
                    stepId: `s${i}`,
                    executionKey: `s${i}`,
                    providerId: null,
                    connectionId: null,
                    weight: 1,
                    label: null,
                  })),
                  handleSingleModel,
                  log,
                  config,
                  allCombos: [],
                  baseOptions: {},
                  nesting: {
                    depth: 0,
                    maxDepth: 5,
                    visitedComboNames: [],
                    rootComboName: "nested-15289",
                    attemptBudget: { count: 0, limit: 3 },
                  },
                  runCombo: async () => failure(true),
                })
              ).response;
        const body = await response.json();
        assert.equal(called, 3, "the global dispatch budget is unchanged");
        const dominant = failures[2] && failures.filter(Boolean).length >= 2;
        assert.equal(response.status, dominant ? 400 : 503);
        assert.equal(body.error.code, dominant ? "context_length_exceeded" : "service_unavailable");
        assert.match(body.error.message, dominant ? /context window/ : /Maximum combo retry limit/);
        assert.equal(body.diagnostics.terminalReason, "max_attempts_exceeded");
        assert.equal(body.diagnostics.attemptOrder.length, 3);
        assert.equal(body.diagnostics.poolSize, 4);
      });
    }
  }
});

describe("combo-claude-overflow-terminal-message", () => {
  // When a combo spends its attempt budget on context-window rejections, the terminal 400 says
  // so. If the last rejection already carried Anthropic's compactable wording with both counts
  // (the final token-budget gate writes it on the Claude wire), the terminal 400 must keep that
  // wording so Claude Code compacts instead of stopping. Other overflow text keeps the generic
  // message.
  before(resetInMemoryState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };
  const DIAG = {
    poolSize: 2,
    attempted: 2,
    excluded: [],
    attemptOrder: [],
    terminalReason: "max_attempts_exceeded",
  };
  const CLAUDE_PHRASE = "prompt is too long: 210724 tokens > 200000 maximum";

  test("the terminal 400 keeps the compactable phrase from the last rejection", async () => {
    const entry = { status: 400, error: CLAUDE_PHRASE };
    const response = buildContextBudgetResponse(CLAUDE_PHRASE, [entry, entry], DIAG);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.message, CLAUDE_PHRASE);
    assert.equal(body.error.code, "context_length_exceeded");
    assert.ok(body.diagnostics, "diagnostics stay attached");
  });

  test("the phrase is found inside a raw JSON error body", async () => {
    const raw = JSON.stringify({
      error: { message: CLAUDE_PHRASE, code: "context_length_exceeded" },
    });
    const response = buildContextBudgetResponse(raw, [{ status: 400, error: raw }], DIAG);
    const body = await response.json();

    assert.equal(body.error.message, CLAUDE_PHRASE);
  });

  test("overflow text without both counts keeps the generic terminal message", async () => {
    const text = "Input exceeds the context window for prov/model";
    const response = buildContextBudgetResponse(text, [{ status: 400, error: text }], DIAG);
    const body = await response.json();

    assert.equal(body.error.message, CONTEXT_OVERFLOW_BUDGET_MESSAGE);
  });

  test("a spent combo budget on Claude-wire rejections ends with the compactable phrase", async () => {
    const models = Array.from({ length: 40 }, (_, i) => `prov${i}/model-${i}`);
    let calls = 0;
    const result = await handleComboChat({
      body: { model: "x", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "c-claude-overflow",
        strategy: "priority",
        models: models.map((m) => ({ model: m })),
      },
      // Each target states its own window, so the rejections differ and the combo keeps going
      // until the shared attempt budget is spent.
      handleSingleModel: async () => {
        calls += 1;
        const message = `prompt is too long: 210724 tokens > ${100_000 + calls} maximum`;
        return new Response(
          JSON.stringify({ error: { code: "context_length_exceeded", message } }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      },
      log,
      settings: {},
      allCombos: [],
    });
    const body = await result.clone().json();

    assert.equal(result.status, 400);
    assert.equal(body.error.code, "context_length_exceeded");
    assert.match(body.error.message, /^prompt is too long: 210724 tokens > \d+ maximum$/);
    assert.ok(body.diagnostics, "diagnostics stay attached");
  });
});

describe("combo-input-bound-failure-8375", () => {
  // #8375 — A combo whose first target returns `context_length_exceeded` for an oversized input
  // must propagate the 400 immediately instead of re-dispatching the identical oversized request
  // against other accounts of the same model.
  //
  // Without this fix:
  // - The 400 `context_length_exceeded` is request-scoped and deterministic for the same input —
  //   every account of the same model will reject it identically.
  // - `isRequestScopedUpstreamFailure()` correctly classifies it, but the combo loop never acts
  //   on that classification to short-circuit.
  // - The combo retries MAX_GLOBAL_ATTEMPTS=30 times, burning all attempts, and returns a
  //   misleading 503 "Maximum combo retry limit reached".
  //
  // Fix: new `isInputBoundRequestFailure()` predicate that detects input-bound deterministic
  // errors. When it fires, the combo returns `{ ok: false, response }` from `executeTarget`,
  // which the outer loop treats as fatal — stopping the combo and propagating the original 400.
  before(resetInMemoryState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function contextLengthExceededResponse() {
    return new Response(
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message:
            "Input exceeds the context window for nvidia/z-ai/glm-5.2: estimated 159324 input tokens, limit 128000.",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  function makeCombo(models: string[]) {
    return {
      name: "test-combo-8375",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  test("#8375 combo stops at the first context_length_exceeded instead of re-dispatching", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return contextLengthExceededResponse();
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["nvidia/z-ai/glm-5.2", "nvidia/z-ai/glm-5.2", "nvidia/z-ai/glm-5.2"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // The guard must short-circuit after the FIRST target — never reach #2 or #3.
    assert.equal(
      modelsCalled.length,
      1,
      `input-bound 400 must stop the combo at target 1, but it tried: ${modelsCalled.join(", ")}`
    );
    assert.equal(
      result.status,
      400,
      "the combo must surface the original 400 to the client, not a 503"
    );
  });
});

describe("combo-input-bound-heterogeneous-8375", () => {
  // #8375 (regression) — the input-bound short-circuit added for the homogeneous same-model pool
  // case must NOT fire across a heterogeneous combo whose remaining targets are different models
  // with (potentially) larger context windows.
  //
  // Without this scoping:
  // - `isInputBoundFailure` in open-sse/services/combo.ts fires unconditionally on the first
  //   `context_length_exceeded`/`context_window_exceeded`, even when a later target in the combo
  //   is a different model that could still succeed.
  // - This regresses the intentional heterogeneous-combo behavior protected by
  //   `isContextOverflow400` (#6637): a small-context model failing must not abort the whole
  //   combo when a larger-context model is still queued.
  //
  // Fix: the short-circuit only fires when every remaining target shares the same `modelStr` as
  // the one that just failed (a true homogeneous remainder) — see `remainderIsHomogeneous` in
  // combo.ts.
  before(resetInMemoryState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function contextLengthExceededResponse() {
    return new Response(
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message: "Input exceeds the context window: estimated 159324 input tokens, limit 128000.",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  function healthyResponse() {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  test("#8375 heterogeneous combo: small-ctx model fails, larger-ctx model must still be tried", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      if (modelStr === "providerA/model-small-ctx") return contextLengthExceededResponse();
      return healthyResponse();
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "test-combo-hetero-8375",
        strategy: "priority",
        models: [{ model: "providerA/model-small-ctx" }, { model: "providerB/model-huge-ctx" }],
      },
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(
      modelsCalled.length,
      2,
      `expected the combo to still try the larger-context target 2, but tried: ${modelsCalled.join(", ")}`
    );
    assert.equal(result.status, 200);
  });

  test("#8375 homogeneous remainder still short-circuits (no regression on the original fix)", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return contextLengthExceededResponse();
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "test-combo-homogeneous-8375",
        strategy: "priority",
        models: [
          { model: "nvidia/z-ai/glm-5.2" },
          { model: "nvidia/z-ai/glm-5.2" },
          { model: "nvidia/z-ai/glm-5.2" },
        ],
      },
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(
      modelsCalled.length,
      1,
      `input-bound 400 on a homogeneous remainder must still stop at target 1, but tried: ${modelsCalled.join(", ")}`
    );
    assert.equal(result.status, 400);
  });
});
