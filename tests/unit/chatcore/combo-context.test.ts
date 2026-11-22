// Combo context-limit, context-override and compression tests that drive handleChatCore (or the
// combo/contextManager seams around it). Merged from eight files so the chatCore module graph
// loads once; each original file is one `describe` below, named after the file it came from.
// compression-probe runs last because it persists compression settings (reset in its `after`).
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chatcore-combo-context-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
// model-lifecycle-integration: API keys are hashed with this secret.
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "model-lifecycle-test-secret";

const { resetTestDb } = await import("../../helpers/postgres.ts");
const { goldenSnapshot } = await import("../../helpers/goldenSnapshot.ts");
const core = await import("../../../src/lib/db/core.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const contextOverrides = await import("../../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { updateCompressionSettings } = await import("../../../src/lib/db/compression.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../../src/lib/modelsDevSync.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const providerModelsRoute = await import("../../../src/app/api/providers/[id]/models/route.ts");
const {
  handleChatCore,
  buildStreamingResponseHeaders,
  extractSystemRoleMessages,
  isClaudeCodeSemanticPassthroughRequest,
  isTokenExpiringSoon,
  redactPassthroughThinkingSignatures,
  shouldUseNativeCodexPassthrough,
  stripStaleForwardingHeaders,
} = await import("../../../open-sse/handlers/chatCore.ts");
const {
  handleComboChat,
  clampComboDepth,
  getConnectionStatusQuotaCutoffReason,
  isContextOverflow400,
  isModelScoped400,
  isParamValidation400,
  isRequestScopedUpstreamFailure,
  shouldRecordProviderBreakerFailure,
  shouldSkipConnDisable,
  shouldSkipForPredictedTtft,
} = await import("../../../open-sse/services/combo.ts");
const { resetEstimatorCalibrationForTests } =
  await import("../../../open-sse/services/estimatorCalibration.ts");
const { parseModel } = await import("../../../open-sse/services/model.ts");
const { getTokenLimit, getComboTargetTokenLimit } =
  await import("../../../open-sse/services/contextManager.ts");

after(async () => {
  core.resetDbInstance();
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("chatcore-combo-context-limit-8378", () => {
  // Regression for #8378: handleChatCore resolves a combo-specific context limit
  // (resolveComboContextLimit(), which can differ from the plain
  // getTokenLimit(provider, model) lookup when the target's own limit isn't
  // "specific" and a sibling combo target has a smaller known window) but that
  // value was declared *inside* the proactive-compression `if` block and never
  // survived to the final enforceOutputTokenBudget() call further down in
  // handleChatCore — so the combo override was silently discarded and the
  // naive per-target lookup won instead. output-token-budget.test.ts only
  // exercises enforceOutputTokenBudget() directly and can never catch this
  // class of bug because it never calls handleChatCore().

  // Sibling target's provider name is unusual enough it can never collide with a
  // real provider registered in open-sse/config/providerRegistry.ts, and the env
  // override key is derived from it: CONTEXT_LENGTH_<PROVIDER-UPPERCASED>.
  const MAIN_PROVIDER = "combo8378-mainprov";
  const MAIN_MODEL = "combo8378-mainmodel";
  const SIBLING_PROVIDER = "combo8378-sibprov";
  const SIBLING_MODEL = "combo8378-sibmodel";
  const SIBLING_LIMIT_ENV = "CONTEXT_LENGTH_COMBO8378_SIBPROV";
  const SIBLING_LIMIT = 5000;
  const COMBO_NAME = "combo8378-test-combo";

  const originalFetch = globalThis.fetch;
  const originalSiblingEnv = process.env[SIBLING_LIMIT_ENV];

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  before(async () => {
    await resetStorage();
    // Forces getTokenLimit(SIBLING_PROVIDER, ...) to a small, distinctive value
    // via the env-override branch (highest priority in resolveTokenLimit()), so
    // resolveComboContextLimit()'s combo-min fallback has a real, known-smaller
    // value to fall back to for the (unregistered) MAIN_PROVIDER target.
    process.env[SIBLING_LIMIT_ENV] = String(SIBLING_LIMIT);

    await combosDb.createCombo({
      name: COMBO_NAME,
      models: [`${MAIN_PROVIDER}/${MAIN_MODEL}`, `${SIBLING_PROVIDER}/${SIBLING_MODEL}`],
    });

    // Defensive: nothing in the expected (fixed) code path should ever reach
    // the network for this test — the request is rejected locally for
    // exceeding the combo-resolved context window — but stub fetch anyway so a
    // regression that silently lets the request through can't make a real
    // outbound call.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalSiblingEnv === undefined) {
      delete process.env[SIBLING_LIMIT_ENV];
    } else {
      process.env[SIBLING_LIMIT_ENV] = originalSiblingEnv;
    }
    await resetTestDb();
  });

  test("#8378: enforceOutputTokenBudget honors the combo-resolved context limit, not the plain per-target lookup", async () => {
    // ~5,600 estimated tokens (estimateTokens ~= chars/4): comfortably above the
    // combo-resolved limit (5,000, source="combo-min") but far below the naive
    // getTokenLimit(MAIN_PROVIDER, MAIN_MODEL) fallback (128,000, the generic
    // DEFAULT_LIMITS.default an unregistered provider/model resolves to). Only
    // the combo-resolved limit rejects this request.
    const longContent = "x".repeat(22_500);

    const result = await handleChatCore({
      body: {
        model: MAIN_MODEL,
        messages: [{ role: "user", content: longContent }],
        stream: false,
      },
      modelInfo: {
        provider: MAIN_PROVIDER,
        model: MAIN_MODEL,
        extendedContext: false,
      },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: {
          baseUrl: "https://combo8378.example.test",
        },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {
          model: MAIN_MODEL,
          messages: [{ role: "user", content: longContent }],
          stream: false,
        },
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      isCombo: true,
      comboName: COMBO_NAME,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    });

    assert.equal(
      result.success,
      false,
      "expected the request to be rejected against the combo-resolved 5,000-token limit"
    );
    const failure = result as { success: false; error: string; rawMessage?: string };
    const message = failure.rawMessage ?? failure.error;
    assert.match(
      message,
      /limit 5000\b/,
      `expected the rejection to cite the combo-resolved limit (5000); got: ${message}`
    );
    assert.doesNotMatch(
      message,
      /limit 128000\b/,
      "the naive per-target getTokenLimit() fallback (128000) must not win over the combo override"
    );
  });
});

describe("chatcore-combo-sibling-specific-14931", () => {
  // Regression for #14931 (limit side): an UNCATALOGED combo member must not
  // clamp the whole combo's runtime context limit to the generic 128000
  // catch-all. chatCore builds comboTargetLimits via getComboTargetTokenLimit(),
  // which now returns undefined for targets whose window resolves only from the
  // non-specific default (the sibling-side counterpart of #10734's
  // getSourcedTokenLimit rule). The executing member itself being uncataloged
  // therefore inherits min(known sibling windows) — here 1,000,000 — instead of
  // the baseless 128000 that false-killed ~50k-real-token Codex requests.
  //
  // Two cases against the same combo [unknown member, 1M env-declared sibling]:
  //   A) ~150k estimated tokens: OLD code 400s at 128000; NEW code passes the
  //      guard and succeeds against the stubbed upstream.
  //   B) ~1.1M estimated tokens: still rejected, citing the inherited 1,000,000
  //      (the guard keeps its teeth — inheritance is a better estimate, not the
  //      removal of the check).

  // Provider/model names chosen to match no registry entry and no name-family
  // heuristic in resolveTokenLimit(), so the unknown member resolves ONLY to the
  // generic 128000 (specific=false).
  const UNKNOWN_PROVIDER = "c14931-unkprov";
  const UNKNOWN_MODEL = "c14931-unkmodel";
  // Known sibling: env override is the highest-priority specific source.
  const KNOWN_PROVIDER = "c14931-knownprov";
  const KNOWN_MODEL = "c14931-knownmodel";
  const KNOWN_LIMIT_ENV = "CONTEXT_LENGTH_C14931_KNOWNPROV";
  const KNOWN_LIMIT = 1_000_000;
  const COMBO_NAME = "c14931-test-combo";

  const originalFetch = globalThis.fetch;
  const originalKnownEnv = process.env[KNOWN_LIMIT_ENV];

  async function resetStorage() {
    await resetTestDb();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  function buildRequest(content: string) {
    return {
      body: {
        model: UNKNOWN_MODEL,
        messages: [{ role: "user", content }],
        stream: false,
      },
      modelInfo: {
        provider: UNKNOWN_PROVIDER,
        model: UNKNOWN_MODEL,
        extendedContext: false,
      },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: { baseUrl: "https://c14931.example.test" },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {
          model: UNKNOWN_MODEL,
          messages: [{ role: "user", content }],
          stream: false,
        },
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      isCombo: true,
      comboName: COMBO_NAME,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    };
  }

  before(async () => {
    await resetStorage();
    process.env[KNOWN_LIMIT_ENV] = String(KNOWN_LIMIT);
    await combosDb.createCombo({
      name: COMBO_NAME,
      models: [`${UNKNOWN_PROVIDER}/${UNKNOWN_MODEL}`, `${KNOWN_PROVIDER}/${KNOWN_MODEL}`],
    });
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "stub ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKnownEnv === undefined) {
      delete process.env[KNOWN_LIMIT_ENV];
    } else {
      process.env[KNOWN_LIMIT_ENV] = originalKnownEnv;
    }
    await resetTestDb();
  });

  test("#14931 A: uncataloged executing member no longer clamped to generic 128000 by itself", async () => {
    // 600k chars → ~150k estimated tokens: above the old 128000 combo-min, far
    // below the inherited 1,000,000. Old code: 400 "limit 128000". New code: the
    // guard passes — the stubbed upstream answers, and even if the leg later
    // fails for unrelated executor reasons, the failure must NOT be a
    // context-length rejection.
    const content = "x".repeat(600_000);
    const result = await handleChatCore(buildRequest(content));
    if (result.success) {
      assert.ok(true, "guard passed and the stubbed upstream answered");
      return;
    }
    const failure = result as { success: false; error: string; rawMessage?: string };
    const message = failure.rawMessage ?? failure.error;
    assert.doesNotMatch(
      message,
      /context_length_exceeded|exceeds (maximum input tokens|context window)/i,
      `the request must not be rejected by the context guard; got: ${message}`
    );
    assert.doesNotMatch(message, /limit 128000\b/, `got: ${message}`);
  });

  test("#14931 B: oversized request still rejected against the inherited sibling limit", async () => {
    // 4.6M chars → ~1.15M estimated tokens: above even the inherited window.
    const content = "x".repeat(4_600_000);
    const result = await handleChatCore(buildRequest(content));
    assert.equal(result.success, false, "expected the oversized request to be rejected");
    const failure = result as { success: false; error: string; rawMessage?: string };
    const message = failure.rawMessage ?? failure.error;
    assert.match(
      message,
      /limit 1000000\b/,
      `expected the rejection to cite the inherited 1,000,000 limit; got: ${message}`
    );
    assert.doesNotMatch(
      message,
      /limit 128000\b/,
      "the generic 128000 must not be the cited limit once a known sibling exists"
    );
  });
});

describe("chatcore-combo-context-override-rescue", () => {
  // Black-box regression for the Feature-5004 combo context-override rescue at the
  // handleChatCore final input gate.
  //
  // The combo compatibility filter (open-sse/services/combo/contextOverrideGate.ts)
  // deliberately lets a raw, exact `model_context_overrides` entry supersede a smaller
  // catalog/client input hint so a capable fallback target is not wrongly dropped for a
  // large prompt. But handleChatCore then enforced the canonical `maxInputTokens` again
  // at the final hard boundary — so a target the filter just rescued was rejected before
  // the upstream fetch (#5004 combo rescue defeated at the gate).
  //
  // Fix: the final gate resolves the input cap through `resolveInputTokenCapForGate`,
  // which mirrors the filter's semantics — an exact context override supersedes the
  // smaller catalog input hint for combo requests, while an explicit `max_input_tokens`
  // capability override is ALWAYS enforced (combo and direct alike). No inheritance is
  // generalized.
  //
  // GitHub's Claude alias canonicalizes before capability lookup, so a prompt sized
  // between the catalog input hint and an exact raw-alias context override exercises
  // the rescue the filter performs. These tests drive the public handleChatCore with a
  // temp DB and an upstream fetch stub and assert on the
  // dispatch signal (did the upstream fetch fire, and was the rejection the 400
  // input-cap error) — the precise contract of the gate.

  const PROVIDER = "github";
  const MODEL = "claude-opus-4.5";
  const CONTEXT_OVERRIDE = 1_000_000;
  // ~3.7M chars ≈ 925k estimated tokens — above the catalog input hint, below the override.
  const BIG_PROMPT = "x".repeat(3_700_000);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

  function buildRequest(isCombo: boolean, content: string) {
    const body = {
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 10,
      stream: false,
    };
    return {
      body,
      modelInfo: { provider: PROVIDER, model: MODEL, extendedContext: false },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: { baseUrl: "https://combo-ctx-rescue.example.test" },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      isCombo,
      log: silentLog,
    };
  }

  before(async () => {
    await resetTestDb();
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-combo-ctx",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await resetTestDb();
  });

  beforeEach(async () => {
    fetchCalls = 0;
    // Isolate each scenario: clear any overrides a prior test wrote so ordering does
    // not couple the assertions.
    await contextOverrides.removeModelContextOverride(PROVIDER, MODEL);
    await capabilityOverrides.removeModelCapabilityOverride(
      `${PROVIDER}/${MODEL}`,
      "max_input_tokens"
    );
  });

  test("raw-alias combo request rescued by an exact context override dispatches", async () => {
    assert.equal(
      await contextOverrides.setModelContextOverride(PROVIDER, MODEL, CONTEXT_OVERRIDE),
      true
    );
    // The prompt exceeds the catalog input hint but fits the context override. A combo
    // request must NOT be rejected at the gate — the upstream fetch must fire.
    const result = await handleChatCore(buildRequest(true, BIG_PROMPT));
    assert.ok(fetchCalls > 0, "rescued combo target must reach the upstream fetch");
    assert.notEqual(
      result.status,
      400,
      "rescued combo target must not be rejected with the input-cap 400"
    );
  });

  test("an exact raw-alias max_input_tokens override is enforced even in a combo", async () => {
    // An explicit max_input_tokens capability override must NEVER be bypassed by a
    // context override — combo included.
    assert.equal(
      await contextOverrides.setModelContextOverride(PROVIDER, MODEL, CONTEXT_OVERRIDE),
      true
    );
    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        `${PROVIDER}/${MODEL}`,
        "max_input_tokens",
        1000
      ),
      true
    );
    const result = await handleChatCore(buildRequest(true, BIG_PROMPT));
    assert.equal(result.status, 400);
    assert.equal(
      fetchCalls,
      0,
      "explicit max_input override must reject with zero fetch even in combo"
    );
    assert.match(JSON.stringify(result), /maximum input tokens/i);
  });
});

describe("chatcore-estimator-calibration-14931", () => {
  // #14931 — end-to-end calibration wiring through handleChatCore. The stubbed
  // upstream reports prompt_tokens = 1/4 of the chars/4 estimate for this
  // provider's tokenizer. Three passing requests teach the bucket that ratio;
  // the fourth request — raw estimate ABOVE the context limit — must then pass
  // the guard (calibrated estimate below it), while the same request with
  // calibration disabled must be rejected. This is the exact false-kill shape
  // from the incident, inverted into a regression test.

  const PROVIDER = "cal14931-prov";
  const MODEL = "cal14931-model";
  const LIMIT_ENV = "CONTEXT_LENGTH_CAL14931_PROV";
  // 20,000-token window: passes a 12,000 raw estimate, rejects a 25,000 one.
  const LIMIT = 20_000;
  // 48,000 chars → 12,000 estimated; 100,000 chars → 25,000 estimated.
  const PASSING_CHARS = 48_000;
  const OVERSIZE_CHARS = 100_000;
  // The stub prices 48,000 chars at 3,000 tokens → learned ratio 0.25.
  const REPORTED_PROMPT_TOKENS = 3_000;

  const originalFetch = globalThis.fetch;
  const originalLimitEnv = process.env[LIMIT_ENV];
  const originalCalibrationEnv = process.env.OMNIROUTE_ESTIMATOR_CALIBRATION;

  async function resetStorage() {
    await resetTestDb();
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  function buildRequest(content: string) {
    return {
      body: {
        model: MODEL,
        messages: [{ role: "user", content }],
        stream: false,
      },
      modelInfo: {
        provider: PROVIDER,
        model: MODEL,
        extendedContext: false,
      },
      credentials: {
        apiKey: "sk-test",
        providerSpecificData: { baseUrl: "https://cal14931.example.test" },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: {
          model: MODEL,
          messages: [{ role: "user", content }],
          stream: false,
        },
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    };
  }

  before(async () => {
    await resetStorage();
    process.env[LIMIT_ENV] = String(LIMIT);
    delete process.env.OMNIROUTE_ESTIMATOR_CALIBRATION;
    resetEstimatorCalibrationForTests();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "stub ok" } }],
          usage: { prompt_tokens: REPORTED_PROMPT_TOKENS, completion_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalLimitEnv === undefined) {
      delete process.env[LIMIT_ENV];
    } else {
      process.env[LIMIT_ENV] = originalLimitEnv;
    }
    if (originalCalibrationEnv !== undefined) {
      process.env.OMNIROUTE_ESTIMATOR_CALIBRATION = originalCalibrationEnv;
    }
    resetEstimatorCalibrationForTests();
  });

  test("#14931: three provider reports recalibrate the guard for the same shape", async () => {
    // Phase 1 — warm-up: three requests that already fit report a 4x-smaller
    // actual prompt_tokens, teaching the (provider, model, no-tools) bucket.
    for (let i = 0; i < 3; i++) {
      const result = await handleChatCore(buildRequest("x".repeat(PASSING_CHARS)));
      assert.equal(result.success, true, `warm-up request ${i + 1} should succeed`);
    }

    // Phase 2 — the previously-fatal shape: raw estimate 25,000 > limit 20,000,
    // calibrated ≈ 6,250 → the guard must let it through to the stubbed upstream.
    const calibrated = await handleChatCore(buildRequest("x".repeat(OVERSIZE_CHARS)));
    assert.equal(
      calibrated.success,
      true,
      "after calibration the oversized-raw-estimate request must pass the guard"
    );

    // Phase 3 — counterfactual: same request with calibration disabled is still
    // rejected, proving the pass came from the learned factor (not a wider limit).
    resetEstimatorCalibrationForTests();
    process.env.OMNIROUTE_ESTIMATOR_CALIBRATION = "off";
    try {
      const uncalibrated = await handleChatCore(buildRequest("x".repeat(OVERSIZE_CHARS)));
      assert.equal(uncalibrated.success, false, "uncalibrated estimate must still be rejected");
      const failure = uncalibrated as { success: false; error: string; rawMessage?: string };
      const message = failure.rawMessage ?? failure.error;
      assert.match(
        message,
        /limit 20000\b/,
        `expected a context-window rejection; got: ${message}`
      );
    } finally {
      delete process.env.OMNIROUTE_ESTIMATOR_CALIBRATION;
    }
  });
});

describe("model-lifecycle-integration", () => {
  const originalFetch = globalThis.fetch;

  async function resetStorage() {
    globalThis.fetch = originalFetch;
    await resetTestDb();
    core.resetDbInstance();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  }

  async function seedOpenAiConnection() {
    return providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: `openai-${Math.random().toString(16).slice(2, 8)}`,
      apiKey: "sk-openai",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  beforeEach(async () => {
    await resetStorage();
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    apiKeysDb.resetApiKeyState();
    await resetTestDb();
  });

  test("chatCore rejects a shutdown OpenAI model before an upstream request", async () => {
    const originalFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response("unexpected", { status: 200 });
    };

    try {
      const body = {
        model: "gpt-5.2-codex",
        messages: [{ role: "user", content: "hello" }],
      };
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: {
          provider: "openai",
          model: "gpt-5.2-codex",
          extendedContext: false,
        },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "model-lifecycle-test",
      });

      assert.equal(result.success, false);
      assert.equal(result.status, 410);
      assert.equal(result.errorCode, "model_shutdown");
      assert.equal(upstreamCalls, 0);

      const responseBody = await result.response.json();
      assert.equal(responseBody.error.code, "model_shutdown");
      assert.match(responseBody.error.message, /openai\/gpt-5\.2-codex/);
      assert.match(responseBody.error.message, /openai\/gpt-5\.6-sol/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unified catalog suppresses stale OpenAI chat rows but retains typed media", async () => {
    const connection = await seedOpenAiConnection();
    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connection.id, [
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", source: "imported" },
      { id: "gpt-image-2", name: "GPT Image 2", source: "imported" },
      { id: "sora-2-pro", name: "Sora 2 Pro", source: "imported" },
    ]);
    await modelsDb.replaceCustomModels("openai", [
      { id: "sora-2", name: "Sora 2", source: "imported" },
    ]);

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string; type?: string }> };
    const ids = new Set(body.data.map((item) => item.id));

    assert.equal(response.status, 200);
    assert.equal(ids.has("openai/gpt-5.2-codex"), false);
    assert.equal(ids.has("openai/sora-2"), false);
    assert.equal(ids.has("openai/sora-2-pro"), false);
    // Since #11919 (fixes #11829) an authoritative live catalog REPLACES the static
    // registry: a static-only row like gpt-5.6-sol that the synced catalog does not
    // list is suppressed instead of leaking into /v1/models. The lifecycle contract
    // this file guards (#8627: stale chat rows suppressed, typed media retained)
    // is unchanged — only the "static rows survive a sync" expectation moved.
    assert.equal(ids.has("openai/gpt-5.6-sol"), false);
    assert.equal(body.data.find((item) => item.id === "openai/gpt-image-2")?.type, "image");
  });

  test("chat-only provider catalog excludes OpenAI lifecycle and media models", async () => {
    const connection = await seedOpenAiConnection();
    await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connection.id, [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", source: "imported" },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", source: "imported" },
      { id: "gpt-5.3-chat-latest", name: "GPT-5.3 Chat", source: "imported" },
      { id: "gpt-image-2", name: "GPT Image 2", source: "imported" },
      { id: "sora-2-pro", name: "Sora 2 Pro", source: "imported" },
    ]);

    const response = await providerModelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models?chatOnly=true`),
      { params: { id: connection.id } }
    );
    const body = (await response.json()) as { models: Array<{ id: string }> };

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.models.map((model) => model.id),
      ["gpt-5.6-sol"]
    );
  });
});

describe("combo-target-token-limit-8716", () => {
  /**
   * #8716 — combo compression-limit resolution must not crash when a target's
   * modelStr lacks a provider/ prefix (parseModel returns provider: null).
   *
   * Root cause: chatCore mapped targets via getTokenLimit(parsed.provider, …)
   * and getEnvOverride() does provider.toUpperCase() unconditionally.
   * ResolvedComboTarget already carries provider independently of modelStr.
   */

  test("#8716 getTokenLimit(null provider) rejects via toUpperCase (documents crash)", async () => {
    await assert.rejects(
      () => getTokenLimit(null as unknown as string, "gpt-4o"),
      (err: unknown) => err instanceof TypeError && String(err.message).includes("toUpperCase")
    );
  });

  test("#8716 parseModel without provider prefix yields null provider", () => {
    const parsed = parseModel("gpt-4o");
    assert.equal(parsed.provider, null);
    assert.equal(parsed.model, "gpt-4o");
  });

  test("#8716 getComboTargetTokenLimit falls back to target.provider (no throw)", async () => {
    assert.equal(typeof getComboTargetTokenLimit, "function");

    const parsed = parseModel("gpt-4o");
    assert.equal(parsed.provider, null);

    const limit = await getComboTargetTokenLimit({
      modelStr: "gpt-4o",
      provider: "openai",
    });
    assert.ok(Number.isFinite(limit) && limit > 0);

    // Same inputs via pre-parsed fields (matches chatCore call shape).
    const limit2 = await getComboTargetTokenLimit({
      parsedProvider: parsed.provider,
      parsedModel: parsed.model,
      targetProvider: "openai",
    });
    assert.equal(limit2, limit);
  });

  test("#8716 getComboTargetTokenLimit prefers parseModel provider when present", async () => {
    const withPrefix = await getComboTargetTokenLimit({
      modelStr: "anthropic/claude-sonnet-4-6",
      provider: "openai",
    });
    const fromParsedOnly = await getComboTargetTokenLimit({
      parsedProvider: "anthropic",
      parsedModel: "claude-sonnet-4-6",
      targetProvider: "openai",
    });
    assert.equal(withPrefix, fromParsedOnly);
  });

  test("#8716/#14931 getComboTargetTokenLimit returns undefined when only the generic default resolves", async () => {
    // Both providers missing → "unknown" provider + uncataloged model resolves
    // solely to the non-specific 128000 catch-all. #14931: that guess must NOT
    // enter the runtime combo Math.min(); the resolver falls back to it on its
    // own only when every member is unknown.
    const limit = await getComboTargetTokenLimit({
      parsedProvider: null,
      parsedModel: "some-model",
      targetProvider: null,
    });
    assert.equal(limit, undefined);
  });

  test("#14931 specific sources still resolve (name heuristic is a known source)", async () => {
    // Step 4 of resolveTokenLimit (model-name heuristic) runs regardless of
    // provider known-ness: an uncataloged "gpt*" variant on an unknown provider
    // still resolves specific, while a non-matching name stays unknown.
    const heuristic = await getComboTargetTokenLimit({
      parsedProvider: "totally-unknown-provider",
      parsedModel: "gpt-4o-unknown-variant",
      targetProvider: null,
    });
    assert.ok(Number.isFinite(heuristic) && (heuristic as number) > 0);

    // The #14931 incident shape: uncataloged model behind a custom
    // OpenAI-compatible connection has no catalog row, no registry entry and a
    // name that matches no heuristic → unknown, must not fake 128000.
    const unknownProvider = await getComboTargetTokenLimit({
      parsedProvider: "openai-compatible-chat-d9363e0c",
      parsedModel: "qwen3.8-27b",
      targetProvider: null,
    });
    assert.equal(unknownProvider, undefined);
  });

  test("#8716 chatCore combo-limit map uses getComboTargetTokenLimit (source guard)", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const src = fs.readFileSync(path.join(root, "open-sse/handlers/chatCore.ts"), "utf8");
    assert.match(
      src,
      /getComboTargetTokenLimit\s*\(/,
      "chatCore must resolve combo target limits via getComboTargetTokenLimit"
    );
    assert.doesNotMatch(
      src,
      /comboTargetLimits\s*=\s*targets\.map\(\s*\([^)]*\)\s*=>\s*\{\s*const parsed = parseModel\(t\.modelStr\);\s*return getTokenLimit\(parsed\.provider/,
      "chatCore must not pass parseModel().provider directly into getTokenLimit"
    );
  });
});

describe("g13-combo-chatcore-golden", () => {
  const GOLDEN_NAME = "g13/combo-chatcore-public-seams";
  const GOLDEN_FILE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    `../../snapshots/${GOLDEN_NAME}.json`
  );
  const SEED = 0x50_13_c0_de;

  type ContextOverflowPredicate = typeof isContextOverflow400;

  type GoldenOverrides = {
    isContextOverflow400?: ContextOverflowPredicate;
  };

  function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };
  }

  function sampleSeeded<T>(values: readonly T[], count: number, salt: number): T[] {
    const random = seededRandom(SEED ^ salt);
    const shuffled = [...values];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  function cartesian<T extends Record<string, readonly unknown[]>>(
    dimensions: T
  ): Array<{ [K in keyof T]: T[K][number] }> {
    let rows: Array<Record<string, unknown>> = [{}];
    for (const [key, values] of Object.entries(dimensions)) {
      rows = rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
    }
    return rows as Array<{ [K in keyof T]: T[K][number] }>;
  }

  function snapshotCombo(overrides: GoldenOverrides): Record<string, unknown> {
    const contextOverflow = overrides.isContextOverflow400 ?? isContextOverflow400;
    const clampInputs = [
      undefined,
      null,
      "",
      "nope",
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      -4,
      0,
      0.9,
      1,
      1.9,
      3,
      9.9,
      10,
      11,
      999,
    ];
    const ttftMatrix = cartesian({
      requests: [0, 4, 5, 6, 20],
      avgLatencyMs: [0, 999, 1000, 1001, 5000],
      predictiveTtftMs: [-1, 0, 1000, 3000],
    });
    const breakerMatrix = [
      {
        status: 500,
        isStreamReadinessFailure: false,
        sameProviderNext: false,
        skipProviderBreaker: false,
        requestScopedFailure: false,
        isProxyUnreachable: false,
        error: "upstream failed",
      },
      ...cartesian({
        status: [400, 408, 429, 500, 502, 503, 504],
        isStreamReadinessFailure: [false, true],
        sameProviderNext: [false, true],
        skipProviderBreaker: [false, true],
        requestScopedFailure: [false, true],
        isProxyUnreachable: [false, true],
        error: ["upstream failed", "Client disconnected: aborted"],
      }),
    ];
    const requestScopeMatrix = cartesian({
      code: [null, "context_length_exceeded", "upstream_empty_response", "other"],
      type: [null, "context_length_exceeded", "server_error"],
    });
    const connDisableMatrix = cartesian({
      status: [401, 408, 499, 502],
      errorCode: [null, "client_disconnected", "plugin_block", "context_length_exceeded"],
      is401: [false, true],
      hasExtraKeys: [false, true],
      provider: ["openai", "codex"],
    });
    const messages = [
      "",
      "invalid message format",
      "maximum context length exceeded",
      "your input exceeds the context window",
      "max_tokens must be between 1 and 4096",
      "parameter is illegal",
      "model is not supported",
      "unsupported_api_for_model",
      "this model does not support the Responses API",
      "plain upstream failure",
    ];
    const connectionStates: Array<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { testStatus: "banned" },
      { testStatus: " CREDITS_EXHAUSTED " },
      { testStatus: "unavailable", rateLimitedUntil: "2999-01-01T00:00:00.000Z" },
      { testStatus: "unavailable", rateLimitedUntil: "2000-01-01T00:00:00.000Z" },
      { testStatus: "healthy", rateLimitedUntil: "2999-01-01T00:00:00.000Z" },
    ];

    return {
      clampDepth: sampleSeeded(clampInputs, 12, 0x01).map((input) => ({
        input: String(input),
        output: clampComboDepth(input),
      })),
      predictiveTtft: sampleSeeded(ttftMatrix, 24, 0x02).map((input) => ({
        input,
        output: shouldSkipForPredictedTtft(
          { requests: input.requests, avgLatencyMs: input.avgLatencyMs },
          input.predictiveTtftMs
        ),
      })),
      providerBreaker: sampleSeeded(breakerMatrix, 40, 0x03).map((input) => ({
        input,
        output: shouldRecordProviderBreakerFailure(input),
      })),
      requestScoped: sampleSeeded(requestScopeMatrix, 10, 0x04).map((input) => ({
        input,
        output: isRequestScopedUpstreamFailure(input),
      })),
      connectionDisable: sampleSeeded(connDisableMatrix, 24, 0x05).map((input) => ({
        input,
        output: shouldSkipConnDisable(
          {
            status: input.status,
            errorCode: input.errorCode,
          },
          input.is401,
          input.hasExtraKeys,
          input.provider
        ),
      })),
      badRequestClassifiers: sampleSeeded(messages, messages.length, 0x06).map((input) => ({
        input,
        output: {
          contextOverflow: contextOverflow(input),
          parameterValidation: isParamValidation400(input),
          modelScoped: isModelScoped400(input),
        },
      })),
      connectionStatusCutoff: sampleSeeded(connectionStates, connectionStates.length, 0x07).map(
        (input) => ({ input, output: getConnectionStatusQuotaCutoffReason(input) ?? null })
      ),
    };
  }

  function normalizeStreamingHeaders(headers: Record<string, string>): Record<string, string> {
    return {
      ...headers,
      "X-OmniRoute-Version": "<APP_VERSION>",
    };
  }

  function snapshotChatCore(): Record<string, unknown> {
    const systemPayloads: Array<Record<string, unknown>> = [
      { messages: [{ role: "user", content: "hello" }] },
      {
        messages: [
          { role: "system", content: "policy" },
          { role: "user", content: "go" },
        ],
      },
      {
        system: "existing",
        messages: [
          { role: "developer", content: "new" },
          { role: "assistant", content: "ok" },
        ],
      },
      {
        system: [{ type: "text", text: "existing-block" }],
        messages: [
          {
            role: "SYSTEM",
            content: [
              { type: "text", text: "lifted" },
              { type: "image", source: "ignored" },
            ],
          },
        ],
      },
      {
        messages: [
          { role: "developer", content: "" },
          { role: "user", content: "kept" },
        ],
      },
      { model: "claude", messages: null },
    ];
    const nativeCodexMatrix = cartesian({
      provider: ["codex", "openai", null],
      sourceFormat: ["openai-responses", "openai-chat", null],
      endpointPath: ["/v1/responses", "/v1/responses/", "/v1/chat/completions", "responses"],
    });
    const semanticMatrix = cartesian({
      provider: ["claude", "openai", "anthropic-compatible-acme"],
      sourceFormat: ["claude", "openai-chat"],
      targetFormat: ["claude", "openai-chat"],
      signal: ["userAgent", "appHeader", "sessionHeader", "none"],
    });
    const signatureInputs = [
      null,
      "plain",
      [{ role: "assistant", content: [{ type: "thinking", signature: "sig", text: "x" }] }],
      { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] }] },
    ];
    const streamingHeaderCases = [
      new Headers({
        "content-type": "application/json",
        "x-request-id": "req-1",
        "retry-after": "15",
        "x-ratelimit-remaining": "7",
        "x-upstream-debug": "safe",
        "x-omniroute-internal": "drop",
        "x-middleware-rewrite": "/internal",
      }),
      new Headers({
        connection: "x-hop",
        "x-hop": "drop",
        "request-id": "req-2",
        "set-cookie": "secret=yes",
        "x-provider": "kept",
      }),
    ];

    return {
      systemRoleExtraction: sampleSeeded(systemPayloads, systemPayloads.length, 0x11).map(
        (input) => {
          const payload = structuredClone(input);
          extractSystemRoleMessages(payload);
          return { input, output: payload };
        }
      ),
      nativeCodexPassthrough: sampleSeeded(nativeCodexMatrix, 18, 0x12).map((input) => ({
        input,
        output: shouldUseNativeCodexPassthrough(input),
      })),
      semanticClaudePassthrough: sampleSeeded(semanticMatrix, 24, 0x13).map((input) => {
        const headers = new Headers();
        let userAgent: string | null = null;
        if (input.signal === "userAgent") userAgent = "claude-code/2.0";
        if (input.signal === "appHeader") headers.set("x-app", "cli");
        if (input.signal === "sessionHeader") headers.set("x-claude-code-session-id", "session-1");
        return {
          input,
          output: isClaudeCodeSemanticPassthroughRequest({
            provider: input.provider,
            sourceFormat: input.sourceFormat,
            targetFormat: input.targetFormat,
            headers,
            userAgent,
          }),
        };
      }),
      thinkingSignaturePassthrough: sampleSeeded(signatureInputs, signatureInputs.length, 0x14).map(
        (input) => ({
          input,
          output: redactPassthroughThinkingSignatures(
            structuredClone(input),
            "replacement-signature"
          ),
        })
      ),
      streamingHeaders: streamingHeaderCases.map((headers, index) => ({
        input: index,
        output: normalizeStreamingHeaders(
          buildStreamingResponseHeaders(
            headers,
            {
              provider: "test-provider",
              model: "test-model",
              requestId: `request-${index}`,
            },
            null
          )
        ),
      })),
      staleForwardingHeaders: [
        {
          "content-encoding": "gzip",
          "content-length": "10",
          "transfer-encoding": "chunked",
          "x-request-id": "req-3",
        },
        {
          "Content-Length": "20",
          "x-provider": "kept",
        },
      ].map((entries) => {
        const headers = new Headers(entries);
        stripStaleForwardingHeaders(headers);
        return { input: entries, output: Object.fromEntries(headers.entries()) };
      }),
      tokenExpiry: sampleSeeded(
        cartesian({
          expiresAt: [null, "2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z", "invalid"],
          bufferMs: [0, 300_000, 86_400_000],
        }),
        10,
        0x15
      ).map((input) => ({ input, output: isTokenExpiringSoon(input.expiresAt, input.bufferMs) })),
    };
  }

  function buildG13GoldenSnapshot(overrides: GoldenOverrides = {}): Record<string, unknown> {
    return {
      seed: `0x${SEED.toString(16)}`,
      combo: snapshotCombo(overrides),
      chatCore: snapshotChatCore(),
    };
  }

  test("G13 golden locks sampled combo.ts and chatCore.ts public behavior", () => {
    assert.ok(
      process.env.UPDATE_GOLDEN === "1" || fs.existsSync(GOLDEN_FILE),
      `committed golden is missing: ${GOLDEN_FILE}`
    );
    goldenSnapshot(GOLDEN_NAME, buildG13GoldenSnapshot());
  });

  test("G13 seeded public-seam sampling is deterministic", () => {
    assert.deepEqual(buildG13GoldenSnapshot(), buildG13GoldenSnapshot());
  });

  test("G13 golden detects a public behavior mutation", () => {
    const baseline = buildG13GoldenSnapshot();
    const mutated = buildG13GoldenSnapshot({
      isContextOverflow400: (input) => !isContextOverflow400(input),
    });
    assert.notDeepEqual(mutated, baseline, "mutation must alter the sampled behavior set");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "g13-golden-"));
    const previousUpdateGolden = process.env.UPDATE_GOLDEN;
    try {
      process.env.UPDATE_GOLDEN = "1";
      goldenSnapshot(GOLDEN_NAME, baseline, tmpDir);
      delete process.env.UPDATE_GOLDEN;

      assert.doesNotThrow(() => goldenSnapshot(GOLDEN_NAME, baseline, tmpDir));
      assert.throws(
        () => goldenSnapshot(GOLDEN_NAME, mutated, tmpDir),
        /golden mismatch for "g13\/combo-chatcore-public-seams"/
      );
    } finally {
      if (previousUpdateGolden === undefined) delete process.env.UPDATE_GOLDEN;
      else process.env.UPDATE_GOLDEN = previousUpdateGolden;
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("combo-context-overflow-compression-probe", () => {
  /**
   * #10225 — combo known-context-overflow must NOT hard-reject a compressible
   * request before OmniRoute's compression pipeline can run.
   *
   * Root cause: getKnownContextOverflow() estimates the RAW body (ceil(serializedChars/4)
   * over the whole Responses input[]) during combo target resolution, before any
   * compression. When every known target limit is below that raw estimate, both call
   * sites (round-robin + target-resolution) convert it into an immediate local 400
   * `context_length_exceeded` with attempted:0 — so chatCore's proactive compression
   * (which can shrink 294133→111529, 62% in the reporter's case) never runs. The only
   * existing bypass (clientManagedResponsesContext) is gated to VERIFIED native Codex
   * clients, so a generic Responses client (e.g. OpenCode) pointed at a codex model
   * still hits the hard gate.
   *
   * Fix: thread a request-scoped `deferContextOverflowWhenCompressible` flag (set when
   * the global compression switch is ON and not API-key opted-out). When set AND at
   * least one target can run compression, getKnownContextOverflow returns null so the
   * request reaches chatCore, whose post-compression enforceOutputTokenBudget becomes
   * the final context gate — a local 400 only if the compressed body still cannot fit.
   */

  before(async () => {
    await resetTestDb();
  });

  // The #10503 tests below persist compression settings (enabled, autoTriggerTokens: 1).
  // resetTestDb drops the rows, but getCompressionSettings() keeps a 5s in-process cache,
  // so this describe stays last in the file.
  after(async () => {
    clearModelsDevCapabilities();
    await resetTestDb();
  });

  beforeEach(() => {
    clearModelsDevCapabilities();
  });

  function capabilityEntry(limitContext: number | null) {
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
    };
  }

  // A generic Responses-API body whose estimate lands near `tokens` tokens (4 chars/token).
  // Uses `input:` (not `messages:`) to mirror the OpenCode/Codex Responses surface.
  function bigResponsesBody(tokens: number) {
    return { input: [["user", "x".repeat(tokens * 4)]] };
  }

  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

  test("#10225 combo does not early-400 a compressible over-limit request when deferral is on", async () => {
    await saveModelsDevCapabilities({ codex: { "gpt-5.6-terra": capabilityEntry(272_000) } });
    let dispatches = 0;

    const response = await handleComboChat({
      body: bigResponsesBody(275_000),
      combo: {
        name: "codex-compress-overflow",
        strategy: "priority",
        models: ["codex/gpt-5.6-terra"],
      },
      deferContextOverflowWhenCompressible: true,
      clientManagedResponsesContext: false,
      isModelAvailable: async () => true,
      handleSingleModel: async () => {
        dispatches += 1;
        return new Response("ok", { status: 200 });
      },
      log: noopLog,
    });

    assert.notEqual(response.status, 400, "compression-enabled request must reach chatCore");
    assert.equal(dispatches, 1, "must dispatch so chatCore compaction runs first");
  });

  test("#10225 combo keeps the fast 400 when compression is disabled", async () => {
    await saveModelsDevCapabilities({ codex: { "gpt-5.6-terra": capabilityEntry(272_000) } });
    let dispatches = 0;

    const response = await handleComboChat({
      body: bigResponsesBody(275_000),
      combo: {
        name: "codex-compress-disabled",
        strategy: "priority",
        models: ["codex/gpt-5.6-terra"],
      },
      deferContextOverflowWhenCompressible: false,
      clientManagedResponsesContext: false,
      isModelAvailable: async () => true,
      handleSingleModel: async () => {
        dispatches += 1;
        return new Response("ok", { status: 200 });
      },
      log: noopLog,
    });

    // #10162: approximate token estimates are advisory. Combo must not
    // hard-400 locally just because chars/4 exceeds a catalog window.
    assert.notEqual(response.status, 400, "advisory estimates must not hard-400 (#10162)");
    assert.equal(dispatches, 1, "request must reach handleSingleModel when estimates are advisory");
  });

  // #10501-sweep #10503 — the deferral above is NOT target-aware by default: it only
  // checks operator-named compression exclusions, never whether chatCore will actually
  // attempt compression for the resolved target. chatCore's *reactive* compaction and
  // last-resort gates still bypass native Codex passthrough targets
  // (open-sse/handlers/chatCore.ts `!nativeCodexPassthrough` checks) — deferring the
  // preflight there means an oversized request sails past BOTH gates uncompressed. These
  // tests pin the fix: a native-codex-passthrough target must never count toward "can
  // compress", so the hard preflight stays active and no upstream dispatch happens.
  // NOTE: prompt (proactive) compression DOES run for native passthrough since the
  // codex analytics fix (see chatCore.ts `compressionExcluded`); only the reactive /
  // combo-deferral bypasses remain. That split is intentional prompt-only scope.
  // NOTE on `clientManagedResponsesContext: false` below: these tests deliberately do
  // NOT set it, to isolate the fix from the PRE-EXISTING, unrelated early-return a few
  // lines above in knownContextOverflow.ts ("Native Codex Responses clients compact
  // their own item history") — that block ALSO returns null for an all-codex pool, but
  // only when `clientManagedResponsesContext === true` (a VERIFIED native client). The
  // bug this fix targets is broader: chatCore's `shouldUseNativeCodexPassthrough` short-
  // circuits to true for `provider === "codex"` regardless of verification (see
  // passthroughHelpers.ts), so an UNVERIFIED request that nonetheless targets a `codex`
  // combo member over `/v1/responses` in openai-responses format still hits chatCore's
  // reactive compression bypass — exactly the gap `sourceFormat`/`endpointPath` (not the looser
  // `clientManagedResponsesContext` flag) now closes.
  test("#10503 handleComboChat: native-codex-passthrough pool fails FAST locally, zero upstream dispatches", async () => {
    await saveModelsDevCapabilities({ codex: { "gpt-5.6-terra": capabilityEntry(272_000) } });
    let dispatches = 0;

    const response = await handleComboChat({
      body: bigResponsesBody(275_000),
      combo: {
        name: "codex-native-passthrough-overflow",
        strategy: "priority",
        models: ["codex/gpt-5.6-terra"],
      },
      deferContextOverflowWhenCompressible: true,
      sourceFormat: "openai-responses",
      endpointPath: "/v1/responses",
      isModelAvailable: async () => true,
      handleSingleModel: async () => {
        dispatches += 1;
        return new Response("ok", { status: 200 });
      },
      log: noopLog,
    });

    // #10162: combo no longer hard-400s on approximate overflow for native Codex
    // passthrough either. Fail-fast after compression (if any) lives in chatCore.
    assert.notEqual(
      response.status,
      400,
      "advisory estimates must not hard-400 native Codex pools"
    );
    assert.equal(dispatches, 1, "request must reach handleSingleModel");
  });

  // #10503 item 2 — drive the REAL chatCore compression pipeline end-to-end (not just the
  // pure getKnownContextOverflow helper): a genuinely compressible multi-turn request must
  // have chatCore's proactive/last-resort compression actually run and dispatch the
  // COMPRESSED body upstream; a request that is STILL too large after compression must be
  // rejected locally with zero upstream dispatch (fail-fast, matching the codex-passthrough
  // case above in outcome, but via the "compression tried and wasn't enough" path instead
  // of "compression was never eligible").
  //
  // Uses an unregistered synthetic provider + CONTEXT_LENGTH_<PROVIDER> env override
  // (same technique as the "chatcore-combo-context-limit-8378" describe in
  // tests/unit/chatcore/combo-context.test.ts) so the
  // context limit is small and deterministic without depending on any real catalog entry.
  // Compression targets conversation HISTORY (older turns), not the current terminal
  // message — this is why the fixtures below build many small history turns plus one
  // short final turn (compressible case) vs one large, irreducible final turn
  // (still-too-large case).
  const CHATCORE_PROBE_PROVIDER = "combo10503probe";
  const CHATCORE_PROBE_MODEL = "combo10503probemodel";
  const CHATCORE_LIMIT_ENV = "CONTEXT_LENGTH_COMBO10503PROBE";

  function buildHistoryBody(turns: number, finalMessageChars: number) {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "You are a helpful assistant." },
    ];
    for (let i = 0; i < turns; i++) {
      messages.push({
        role: "user",
        content: `Message number ${i}: Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mno pqr stu.`,
      });
      messages.push({
        role: "assistant",
        content: `Reply number ${i}: verbose filler answer with extra padding text for realism.`,
      });
    }
    messages.push({ role: "user", content: "FINAL: " + "z".repeat(finalMessageChars) });
    return { model: CHATCORE_PROBE_MODEL, messages, stream: false };
  }

  async function invokeChatCoreCapturingUpstream(body: Record<string, unknown>) {
    const originalFetch = globalThis.fetch;
    let dispatched = false;
    let sentBodyJson: string | null = null;
    globalThis.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
      // Stacked compression reports each engine step to the dashboard live feed through a
      // loopback `/__omniroute_event` POST (#14529 made header-less requests stacked). That is
      // internal telemetry, not upstream dispatch — only a provider request counts here.
      if (String(url instanceof Request ? url.url : url).includes("/__omniroute_event")) {
        return new Response(null, { status: 204 });
      }
      dispatched = true;
      sentBodyJson = init.body ? String(init.body) : null;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-10503",
          object: "chat.completion",
          model: CHATCORE_PROBE_MODEL,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    try {
      const result = await handleChatCore({
        body,
        modelInfo: {
          provider: CHATCORE_PROBE_PROVIDER,
          model: CHATCORE_PROBE_MODEL,
          extendedContext: false,
        },
        credentials: { apiKey: "sk-test", providerSpecificData: {} },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body,
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
      } as never);
      return { result, dispatched, sentBodyJson };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("#10503 real chatCore path: a compressible request dispatches the COMPRESSED (not raw) body upstream", async () => {
    const originalEnv = process.env[CHATCORE_LIMIT_ENV];
    process.env[CHATCORE_LIMIT_ENV] = "500";
    await updateCompressionSettings({
      enabled: true,
      defaultMode: "standard",
      autoTriggerTokens: 1,
      autoTriggerMode: "standard",
      engines: { rtk: { enabled: true }, caveman: { enabled: true } },
    } as never);
    try {
      const body = buildHistoryBody(150, 50);
      const rawLen = JSON.stringify(body.messages).length;

      const { dispatched, sentBodyJson } = await invokeChatCoreCapturingUpstream(body);

      assert.ok(
        dispatched,
        "compression must let a genuinely compressible request reach chatCore's dispatch"
      );
      assert.ok(sentBodyJson, "the dispatched request must carry a body");
      assert.ok(
        sentBodyJson!.length < rawLen * 0.5,
        `expected the DISPATCHED body (${sentBodyJson!.length} chars) to be substantially ` +
          `smaller than the raw request (${rawLen} chars) — proves compression actually ran ` +
          `and its output (not the raw body) is what reached upstream`
      );
    } finally {
      if (originalEnv === undefined) delete process.env[CHATCORE_LIMIT_ENV];
      else process.env[CHATCORE_LIMIT_ENV] = originalEnv;
    }
  });

  test("#10503 real chatCore path: STILL too large after compression → local rejection, ZERO upstream dispatch", async () => {
    const originalEnv = process.env[CHATCORE_LIMIT_ENV];
    process.env[CHATCORE_LIMIT_ENV] = "50";
    await updateCompressionSettings({
      enabled: true,
      defaultMode: "standard",
      autoTriggerTokens: 1,
      autoTriggerMode: "standard",
      engines: { rtk: { enabled: true }, caveman: { enabled: true } },
    } as never);
    try {
      // The final turn alone (1000 chars, irreducible — compression trims HISTORY, not
      // the current terminal message) already exceeds the 50-token limit, so no amount
      // of history compaction can make this fit.
      const body = buildHistoryBody(150, 1000);

      const { result, dispatched } = await invokeChatCoreCapturingUpstream(body);

      assert.equal(
        dispatched,
        false,
        "fail-fast: a request that cannot fit even after compression must never reach fetch()"
      );
      assert.equal((result as { success: boolean }).success, false);
      const failure = result as { success: false; error?: string; rawMessage?: string };
      const message = failure.rawMessage ?? failure.error ?? "";
      assert.match(message, /exceeds/i);
    } finally {
      if (originalEnv === undefined) delete process.env[CHATCORE_LIMIT_ENV];
      else process.env[CHATCORE_LIMIT_ENV] = originalEnv;
    }
  });
});
