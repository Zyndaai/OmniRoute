// Response validation and passthrough handling around handleComboChat: Responses-API SSE failure
// fallback, Claude passthrough/refusal/tool-casing guards, client-abort propagation, the quality
// validator (reasoning, tiny budget, peek cap), responseValidation failover and empty-content
// failover. Merged from ten files so the combo.ts module graph loads once; each original file is
// one `describe` below, named after the file it came from.
import { after, beforeEach, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-combo-response-validation-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-response-validation-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const { handleComboChat, validateResponseQuality } =
  await import("../../../open-sse/services/combo.ts");
const { clearNativeCodexTurnPinsForTests, pinNativeCodexTurn } =
  await import("../../../open-sse/services/combo/nativeCodexTurnPin.ts");
const { clearAllModelLockouts, getModelLockoutInfo } =
  await import("../../../open-sse/services/accountFallback.ts");
const { applyComboTargetExhaustion } =
  await import("../../../open-sse/services/combo/targetExhaustion.ts");
const { stripClaudeRejectedTopLevelFields, unpairedClaudeClientFields } =
  await import("../../../open-sse/handlers/chatCore/passthroughHelpers.ts");
const { isSyntheticEmptyStreamFailure } =
  await import("../../../src/sse/services/syntheticEmptyStream.ts");
const { createSSEStream, createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } =
  await import("../../../open-sse/utils/stream.ts");
const { createDisconnectAwareStream, createStreamController, pipeWithDisconnect } =
  await import("../../../open-sse/utils/streamHandler.ts");
const { shouldAbortEmptyClaudeStream } =
  await import("../../../open-sse/utils/streamClaudeEmptyBody.ts");
const { isEmptyContentResponse } = await import("../../../open-sse/services/errorClassifier.ts");
const { detectMalformedNonStream } = await import("../../../open-sse/utils/diagnostics.ts");
const { FORMATS } = await import("../../../open-sse/translator/formats.ts");
const { executeWithUpstreamStartTimeout } =
  await import("../../../open-sse/handlers/chatCore/upstreamTimeouts.ts");
const { runNonStreamingProviderLeg } =
  await import("../../../open-sse/handlers/chatCore/nonStreamingProviderLeg.ts");
const { baseInput } = await import("../_helpers/nonStreamingProviderLegFixtures.ts");

after(async () => {
  clearAllModelLockouts();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-responses-sse-failure-fallback", () => {
  const encoder = new TextEncoder();

  beforeEach(() => clearAllModelLockouts());
  after(() => clearAllModelLockouts());

  function sseResponse(body: string): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  }

  function silentLog() {
    return { info() {}, warn() {}, error() {}, debug() {} };
  }

  function failedResponsesSse(): string {
    return [
      "event: response.failed",
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "no_capacity", type: "server_error", message: "peak capacity" },
        },
      })}`,
      "",
      "",
    ].join("\n");
  }

  function invalidRequestSse(): string {
    return [
      "event: response.failed",
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            code: "invalid_request_error",
            type: "invalid_request_error",
            message: "request is invalid token=secret-value at /srv/private/config.json",
            status_code: 400,
          },
        },
      })}`,
      "",
      "",
    ].join("\n");
  }

  test("streaming quality rejects a pre-content response.failed event", async () => {
    const result = await validateResponseQuality(
      sseResponse(failedResponsesSse()),
      true,
      silentLog()
    );

    assert.equal(result.valid, false);
    assert.match(result.reason ?? "", /^streaming upstream error/);
    assert.equal(result.upstreamFailure?.status, 502);
    assert.equal(result.upstreamFailure?.retryable, true);
  });

  test("streaming quality rejects a pre-content top-level error envelope", async () => {
    const body = [
      "event: error",
      `data: ${JSON.stringify({
        error: { type: "server_error", message: "temporarily unavailable" },
      })}`,
      "",
      "",
    ].join("\n");

    const result = await validateResponseQuality(sseResponse(body), true, silentLog());

    assert.equal(result.valid, false);
    assert.match(result.reason ?? "", /^streaming upstream error/);
    assert.equal(result.upstreamFailure?.status, 502);
    assert.equal(result.upstreamFailure?.retryable, true);
  });

  test("streaming quality preserves request-scoped upstream failure metadata", async () => {
    const result = await validateResponseQuality(
      sseResponse(invalidRequestSse()),
      true,
      silentLog()
    );

    assert.equal(result.valid, false);
    assert.deepEqual(result.upstreamFailure, {
      status: 400,
      type: "invalid_request_error",
      code: "invalid_request_error",
      message: "request is invalid token=[REDACTED] at <path>",
      requestScoped: true,
      retryable: false,
    });
  });

  test("context input errors map to HTTP 400 without an explicit status", async () => {
    for (const code of ["context_length_exceeded", "context_window_exceeded"]) {
      const body = [
        "event: response.failed",
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: { code, type: code, message: "request exceeds the model context" },
          },
        })}`,
        "",
        "",
      ].join("\n");

      const result = await validateResponseQuality(sseResponse(body), true, silentLog());
      assert.equal(result.upstreamFailure?.status, 400);
      assert.equal(result.upstreamFailure?.requestScoped, true);
      assert.equal(result.upstreamFailure?.retryable, false);
    }
  });

  test("context input error type without code stays request-scoped", async () => {
    for (const type of ["context_length_exceeded", "context_window_exceeded"]) {
      const body = [
        "event: response.failed",
        `data: ${JSON.stringify({
          type: "response.failed",
          response: {
            status: "failed",
            error: { type, message: "request exceeds the model context" },
          },
        })}`,
        "",
        "",
      ].join("\n");

      const result = await validateResponseQuality(sseResponse(body), true, silentLog());
      assert.equal(result.upstreamFailure?.status, 400);
      assert.equal(result.upstreamFailure?.type, type);
      assert.equal(result.upstreamFailure?.requestScoped, true);
      assert.equal(result.upstreamFailure?.retryable, false);
    }
  });

  test("invalid_request_error code maps to HTTP 400 without a type field", async () => {
    const body = [
      "event: response.failed",
      `data: ${JSON.stringify({
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "invalid_request_error", message: "request is invalid" },
        },
      })}`,
      "",
      "",
    ].join("\n");

    const result = await validateResponseQuality(sseResponse(body), true, silentLog());
    assert.equal(result.upstreamFailure?.status, 400);
    assert.equal(result.upstreamFailure?.requestScoped, true);
  });

  test("request-scoped streaming refusal falls back without retrying or locking the model", async () => {
    const calls: string[] = [];
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fallback ok" })}`,
      "",
      "",
    ].join("\n");

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "request-scoped-stream-fallback",
        strategy: "priority",
        models: [
          { model: "codex/gpt-6-astra-high", connectionId: "conn-astra", weight: 0 },
          { model: "codex/gpt-5.6-sol", connectionId: "conn-sol", weight: 0 },
        ],
        config: { maxRetries: 1, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return model.endsWith("/gpt-6-astra-high")
          ? sseResponse(invalidRequestSse())
          : sseResponse(healthy);
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: {
        modelLockout: {
          enabled: true,
          errorCodes: [400, 502],
          baseCooldownMs: 120_000,
          maxCooldownMs: 1_800_000,
          maxBackoffSteps: 10,
          useExponentialBackoff: true,
        },
      },
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["codex/gpt-6-astra-high", "codex/gpt-5.6-sol"]);
    assert.equal(getModelLockoutInfo("codex", "conn-astra", "gpt-6-astra-high"), null);
  });

  test("single-target request-scoped streaming refusal preserves HTTP 400", async () => {
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "request-scoped-stream-terminal",
        strategy: "priority",
        models: [{ model: "codex/gpt-6-astra-high", connectionId: "conn-astra", weight: 0 }],
        config: { maxRetries: 1, maxSetRetries: 1, retryDelayMs: 0, setRetryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return sseResponse(invalidRequestSse());
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.status, 400);
    assert.deepEqual(calls, ["codex/gpt-6-astra-high"]);
  });

  test("request-scoped refusal is not replayed against the same model on another account", async () => {
    const calls: string[] = [];
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fallback ok" })}`,
      "",
      "",
    ].join("\n");

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "request-scoped-same-model-skip",
        strategy: "priority",
        models: [
          { model: "codex/gpt-6-astra-high", connectionId: "conn-astra-1", weight: 0 },
          { model: "codex/gpt-6-astra-high", connectionId: "conn-astra-2", weight: 0 },
          { model: "codex/gpt-5.6-sol", connectionId: "conn-sol", weight: 0 },
        ],
        config: { maxRetries: 0, maxSetRetries: 1, retryDelayMs: 0, setRetryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string, target) => {
        const connectionId = (target as { connectionId?: string } | undefined)?.connectionId;
        calls.push(`${model}@${connectionId ?? "none"}`);
        return model.endsWith("/gpt-6-astra-high")
          ? sseResponse(invalidRequestSse())
          : sseResponse(healthy);
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["codex/gpt-6-astra-high@conn-astra-1", "codex/gpt-5.6-sol@conn-sol"]);
  });

  test("combo advances to the next target after a pre-content Responses SSE failure", async () => {
    const calls: string[] = [];
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fallback ok" })}`,
      "",
      "",
    ].join("\n");

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "responses-sse-failure-fallback",
        strategy: "priority",
        models: [
          { model: "openai/primary", weight: 0 },
          { model: "openai/secondary", weight: 0 },
        ],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return model.endsWith("/primary")
          ? sseResponse(failedResponsesSse())
          : sseResponse(healthy);
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "openai/secondary"]);
    assert.match(await result.text(), /fallback ok/);
  });

  test("round-robin retries a transient streaming failure on the same target", async () => {
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "round-robin-transient-stream-retry",
        strategy: "round-robin",
        models: [{ model: "codex/gpt-6-astra-high", connectionId: "conn-astra", weight: 0 }],
        config: { maxRetries: 1, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return sseResponse(failedResponsesSse());
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.status, 502);
    assert.deepEqual(calls, ["codex/gpt-6-astra-high", "codex/gpt-6-astra-high"]);
  });

  test("round-robin does not retry a request-scoped streaming refusal", async () => {
    const calls: string[] = [];
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fallback ok" })}`,
      "",
      "",
    ].join("\n");
    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "round-robin-request-scoped-fallback",
        strategy: "round-robin",
        models: [
          { model: "codex/gpt-6-astra-high", connectionId: "conn-astra", weight: 0 },
          { model: "codex/gpt-5.6-sol", connectionId: "conn-sol", weight: 0 },
        ],
        config: { maxRetries: 1, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return model.endsWith("/gpt-6-astra-high")
          ? sseResponse(invalidRequestSse())
          : sseResponse(healthy);
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["codex/gpt-6-astra-high", "codex/gpt-5.6-sol"]);
  });

  test("round-robin skips the same model on another account after a request-scoped refusal", async () => {
    const calls: string[] = [];
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fallback ok" })}`,
      "",
      "",
    ].join("\n");

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "round-robin-same-model-skip",
        strategy: "round-robin",
        models: [
          { model: "codex/gpt-6-astra-high", connectionId: "conn-astra-1", weight: 0 },
          { model: "codex/gpt-6-astra-high", connectionId: "conn-astra-2", weight: 0 },
          { model: "codex/gpt-5.6-sol", connectionId: "conn-sol", weight: 0 },
        ],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string, target) => {
        const connectionId = (target as { connectionId?: string } | undefined)?.connectionId;
        calls.push(`${model}@${connectionId ?? "none"}`);
        return model.endsWith("/gpt-6-astra-high")
          ? sseResponse(invalidRequestSse())
          : sseResponse(healthy);
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.equal(
      calls.filter((call) => call.startsWith("codex/gpt-6-astra-high")).length,
      1,
      `the refused model must be dispatched once, saw: ${calls.join(", ")}`
    );
    assert.ok(
      calls.some((call) => call.endsWith("@conn-sol")),
      `the different model must still be attempted, saw: ${calls.join(", ")}`
    );
  });

  test("transient streaming failure still records a configured model lockout", async () => {
    const model = "gpt-6-astra-high";
    const connectionId = "conn-transient";
    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "transient-stream-lockout",
        strategy: "priority",
        models: [{ model: `codex/${model}`, connectionId, weight: 0 }],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async () => sseResponse(failedResponsesSse()),
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: {
        modelLockout: {
          enabled: true,
          errorCodes: [502],
          baseCooldownMs: 120_000,
          maxCooldownMs: 1_800_000,
          maxBackoffSteps: 10,
          useExponentialBackoff: true,
        },
      },
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.status, 502);
    assert.notEqual(getModelLockoutInfo("codex", connectionId, model), null);
  });

  test("protected pre-content streaming quality rejection retries the same target once without advancing", async () => {
    const calls: string[] = [];
    const failed = failedResponsesSse();
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "retry ok" })}`,
      "",
      "",
    ].join("\n");
    const combo = {
      name: "protected-stream-quality-retry",
      strategy: "priority",
      models: [
        {
          model: "openai/primary",
          weight: 0,
          fallbackOnlyOnQuotaExhaustion: true,
        },
        { model: "anthropic/backup", weight: 0 },
      ],
      config: { maxRetries: 1, retryDelayMs: 0 },
    };

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo,
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return calls.length === 1 ? sseResponse(failed) : sseResponse(healthy);
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: [combo],
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["openai/primary", "openai/primary"]);
    assert.match(await result.text(), /retry ok/);
  });

  test("native pinned pre-content stream failure still retries the same target safely", async () => {
    clearNativeCodexTurnPinsForTests();
    const body = {
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "t1", turn_id: "turn1" }),
      },
    };
    const combo = {
      name: "native-pinned-stream-quality-retry",
      strategy: "priority",
      models: [
        {
          model: "codex/gpt-5.6-sol",
          connectionId: "conn-1",
          fallbackOnlyOnQuotaExhaustion: true,
          weight: 0,
        },
      ],
      config: { maxRetries: 1, retryDelayMs: 0 },
    };
    pinNativeCodexTurn({
      body,
      comboName: combo.name,
      target: {
        kind: "model",
        stepId: "codex-step",
        executionKey: "codex-step",
        modelStr: "codex/gpt-5.6-sol",
        provider: "codex",
        providerId: null,
        connectionId: "conn-1",
        weight: 0,
        label: null,
      },
      connectionId: "conn-1",
    });

    const calls: string[] = [];
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "retry ok" })}`,
      "",
      "",
    ].join("\n");
    const result = await handleComboChat({
      body,
      combo,
      clientManagedResponsesContext: true,
      handleSingleModel: async (_body: unknown, model: string) => {
        calls.push(model);
        return calls.length === 1 ? sseResponse(failedResponsesSse()) : sseResponse(healthy);
      },
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: [combo],
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["codex/gpt-5.6-sol", "codex/gpt-5.6-sol"]);
    assert.match(await result.text(), /retry ok/);
    clearNativeCodexTurnPinsForTests();
  });

  test("combo cancels a discarded upstream stream after a pre-content Responses SSE failure", async () => {
    let resolvePrimaryCancelled: (() => void) | undefined;
    const primaryCancelled = new Promise<void>((resolve) => {
      resolvePrimaryCancelled = resolve;
    });
    const primary = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(failedResponsesSse()));
        },
        cancel() {
          resolvePrimaryCancelled?.();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
    const healthy = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "fallback ok" })}`,
      "",
      "",
    ].join("\n");

    const result = await handleComboChat({
      body: { stream: true, messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: "responses-sse-failure-cancellation",
        strategy: "priority",
        models: [
          { model: "openai/primary", weight: 0 },
          { model: "openai/secondary", weight: 0 },
        ],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: unknown, model: string) =>
        model.endsWith("/primary") ? primary : sseResponse(healthy),
      isModelAvailable: async () => true,
      log: silentLog(),
      settings: null,
      allCombos: null,
      relayOptions: null as never,
    });

    assert.equal(result.ok, true);
    assert.match(await result.text(), /fallback ok/);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        primaryCancelled,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("discarded primary stream was not cancelled")),
            250
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });

  test("streaming quality still replays normal Responses lifecycle and content", async () => {
    const body = [
      "event: response.created",
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}`,
      "",
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}`,
      "",
      "",
    ].join("\n");

    const result = await validateResponseQuality(sseResponse(body), true, silentLog());

    assert.equal(result.valid, true);
    assert.ok(result.clonedResponse);
    assert.equal(await result.clonedResponse.text(), body);
  });
});

describe("claude-passthrough-empty-response", () => {
  // Regression guards for the 2026-09-21 client incident: claude-opus-5 failing ~58% of native
  // Claude Code passthrough requests, surfacing to clients as 429 "all targets were skipped by
  // pre-dispatch filters".
  //
  // Three independent defects, one per describe block below.
  describe("Claude passthrough keeps safeguards only next to its paired beta", () => {
    // Live 400 (2026-09-21): `safeguards: Extra inputs are not permitted`. Anthropic
    // rejects the WHOLE request when the auto mode `safeguards` field arrives without
    // the `dangerous-tool-use-2026-09-03` beta. Stripping it unconditionally fixed
    // the 400 but made every gateway session ineligible for server-side auto mode
    // (https://code.claude.com/docs/en/auto-mode-classifier-billing).
    const cases: Array<[string, string | null, readonly string[]]> = [
      ["no anthropic-beta header", null, ["safeguards"]],
      [
        "beta header without the paired beta",
        "claude-code-20250219,oauth-2025-04-20",
        ["safeguards"],
      ],
      [
        "paired beta negotiated",
        "claude-code-20250219,afk-mode-2026-01-31,dangerous-tool-use-2026-09-03",
        [],
      ],
      ["paired beta with odd spacing and casing", " Dangerous-Tool-Use-2026-09-03 ", []],
    ];

    for (const [scenario, clientBeta, expected] of cases) {
      it(`${scenario} strips ${JSON.stringify(expected)}`, () => {
        assert.deepEqual(unpairedClaudeClientFields(clientBeta), expected);
      });
    }
  });

  describe("stripClaudeRejectedTopLevelFields on the native claude passthrough", () => {
    const AUTO_MODE_BETA = "claude-code-20250219,dangerous-tool-use-2026-09-03";

    function claudeCodeBody(): Record<string, unknown> {
      return {
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.7,
        top_p: 0.9,
        safeguards: [{ type: "dangerous_tool_use", classifier_context: "ctx" }],
      };
    }

    const headerShapes: Array<[string, Headers | Record<string, unknown>]> = [
      ["a fetch Headers instance", new Headers({ "anthropic-beta": AUTO_MODE_BETA })],
      ["a plain header record", { "Anthropic-Beta": AUTO_MODE_BETA }],
    ];

    for (const [shape, headers] of headerShapes) {
      it(`keeps safeguards when ${shape} carries the paired beta`, () => {
        const body = claudeCodeBody();

        stripClaudeRejectedTopLevelFields(body, headers);

        assert.deepEqual(body.safeguards, claudeCodeBody().safeguards);
      });
    }

    it("strips safeguards and top_p but keeps the real payload without the paired beta", () => {
      const body = claudeCodeBody();

      stripClaudeRejectedTopLevelFields(body, { "anthropic-beta": "claude-code-20250219" });

      assert.equal(body.safeguards, undefined);
      assert.equal(body.top_p, undefined);
      assert.equal(body.temperature, 0.7);
      assert.deepEqual(body.messages, claudeCodeBody().messages);
    });
  });

  describe("synthetic empty-stream 502 must not trigger a per-model lockout", () => {
    // OmniRoute synthesizes this 502 itself (stream.ts emitClaudeEmptyStreamErrorAndAbort,
    // code "empty_response"). Treating it as an upstream per-model server error
    // locked claude-opus-5 for 60s on HEALTHY accounts; with the remaining accounts
    // rate-limited that emptied the whole combo.
    it("recognises the synthesized empty-response 502", () => {
      assert.equal(
        isSyntheticEmptyStreamFailure(502, "Claude returned an empty response (no content block)"),
        true
      );
    });

    it("does not match a genuine upstream 502", () => {
      assert.equal(isSyntheticEmptyStreamFailure(502, "Bad gateway"), false);
      assert.equal(isSyntheticEmptyStreamFailure(502, ""), false);
      assert.equal(isSyntheticEmptyStreamFailure(502, null), false);
    });

    it("does not match other statuses even with the same text", () => {
      // 503/504 keep the existing model-lockout path (#6216) — only the
      // self-generated 502 is exempt.
      assert.equal(
        isSyntheticEmptyStreamFailure(503, "Claude returned an empty response (no content block)"),
        false
      );
      assert.equal(
        isSyntheticEmptyStreamFailure(429, "Claude returned an empty response (no content block)"),
        false
      );
    });
  });

  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  function claudeSseResponse(events: string[]): Response {
    const body = events.join("\n") + "\n";
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }

  describe("upstream streaming error text is surfaced, not masked", () => {
    // Previously every in-stream failure collapsed to the bare string "streaming
    // upstream error", and the client only ever saw "Claude returned an empty
    // response (no content block)". That masking hid two real Anthropic
    // rejections for days.
    it("carries the upstream error type and message into the failure reason", async () => {
      const res = claudeSseResponse([
        `event: error`,
        `data: ${JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "messages.1.content.1: `tool_addition` blocks require anthropic-beta",
          },
        })}`,
        "",
      ]);

      const out = await validateResponseQuality(res, true, silentLog);
      assert.equal(out.valid, false, "an upstream error event must fail quality validation");
      assert.match(
        String(out.reason),
        /invalid_request_error/,
        `reason must name the upstream error type, got: ${out.reason}`
      );
      assert.match(String(out.reason), /tool_addition/, `reason must carry the upstream message`);
    });

    it("still reports a bare reason when the payload carries no detail", async () => {
      const res = claudeSseResponse([
        `event: error`,
        `data: ${JSON.stringify({ type: "error" })}`,
        "",
      ]);
      const out = await validateResponseQuality(res, true, silentLog);
      assert.equal(out.valid, false);
      assert.match(String(out.reason), /streaming upstream error/);
    });
  });
});

describe("claude-refusal-passthrough", () => {
  // A Claude `stop_reason: "refusal"` turn carries no content block by design: the model declined
  // under the provider's usage policy. It is the Claude twin of the OpenAI `content_filter`
  // finish, so the empty-content guards must pass it through instead of rewriting it into a
  // retried 502 "empty content" that hides the refusal (and its `stop_details`) from the client.
  const enc = new TextEncoder();
  const stopDetails = { type: "refusal", category: "cyber", explanation: "blocked" };
  const refusalFrames = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_refusal",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_sequence: null, stop_details: stopDetails },
      usage: { output_tokens: 0 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];

  function source(frames: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const frame of frames) c.enqueue(enc.encode(frame));
        c.close();
      },
    });
  }

  test("non-streaming: an empty Claude refusal is not an empty-content failure", () => {
    assert.equal(
      isEmptyContentResponse({ type: "message", content: [], stop_reason: "refusal" }),
      false
    );
  });

  test("non-streaming: an empty Claude refusal is not a malformed 200", () => {
    assert.equal(
      detectMalformedNonStream({
        type: "message",
        content: [],
        stop_reason: "refusal",
        stop_details: stopDetails,
      }),
      null
    );
  });

  test("flush guard: a finished empty refusal stream is not aborted", () => {
    const lifecycle = {
      hasError: false,
      hasContentBlock: false,
      hasMessageStart: true,
      hasMessageDelta: true,
      hasMessageStop: true,
      stopReason: "refusal",
    };
    assert.equal(shouldAbortEmptyClaudeStream(lifecycle, true), false);
  });

  test("passthrough stream forwards the refusal instead of an empty-response error", async () => {
    const text = await new Response(
      source(refusalFrames).pipeThrough(
        createSSEStream({
          mode: "passthrough",
          sourceFormat: FORMATS.CLAUDE,
          provider: "anthropic",
          model: "claude-opus-5-5",
          body: { messages: [{ role: "user", content: "hello" }] },
        } as Parameters<typeof createSSEStream>[0])
      )
    ).text();
    assert.match(text, /"stop_reason":"refusal"/);
    assert.match(text, /"category":"cyber"/);
    assert.doesNotMatch(text, /event: error/);
  });

  test("client stream guard does not rewrite an empty refusal", async () => {
    const sc = createStreamController({
      provider: "anthropic",
      model: "claude-opus-5-5",
      clientResponseFormat: FORMATS.CLAUDE,
    });
    const reader = createDisconnectAwareStream(
      {
        readable: source(refusalFrames),
        writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
      } as Parameters<typeof createDisconnectAwareStream>[0],
      sc
    ).getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /"stop_reason":"refusal"/);
    assert.doesNotMatch(text, /empty content|event: error/i);
  });

  test("combo quality check accepts an empty refusal as a final answer", async () => {
    const response = new Response(source(refusalFrames), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const result = await validateResponseQuality(response, true, { warn: () => {} });
    assert.equal(result.valid, true, "reason" in result ? String(result.reason) : undefined);
  });
});

describe("client-abort-propagates-upstream", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(cond: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(10);
    return cond();
  }

  // Fake upstream: sends SSE headers + a first chunk, then keeps "decoding" until
  // the socket closes. Records whether the request was aborted after headers.
  function startFakeUpstream() {
    const state = { closedEarly: false, reqs: 0 };
    const server = http.createServer((_req, res) => {
      state.reqs++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      const t = setInterval(
        () => res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'),
        20
      );
      res.on("close", () => {
        clearInterval(t);
        if (!res.writableEnded) state.closedEarly = true;
      });
    });
    return new Promise<{ url: string; state: typeof state; close: () => Promise<void> }>(
      (resolve) =>
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve({
            url: `http://127.0.0.1:${port}/`,
            state,
            close: () =>
              new Promise<void>((r) => {
                server.closeAllConnections();
                server.close(() => r());
              }),
          });
        })
    );
  }

  test("start-timeout wrapper: client abort after headers still aborts the upstream fetch", async () => {
    const up = await startFakeUpstream();
    try {
      const client = new AbortController();
      const res = await executeWithUpstreamStartTimeout({
        executor: {},
        provider: "test",
        model: "m",
        connectionTimeoutMs: 5000,
        signal: client.signal,
        execute: (signal) => fetch(up.url, { signal }),
      });
      const reader = res.body!.getReader();
      await reader.read(); // headers + first chunk received: the race has settled
      assert.equal(up.state.closedEarly, false);

      client.abort("client_gone");

      assert.equal(await waitFor(() => up.state.closedEarly), true, "upstream saw the abort");
      await assert.rejects(async () => {
        for (;;) if ((await reader.read()).done) break;
      });
    } finally {
      await up.close();
    }
  });

  test("start-timeout wrapper: non-aborted stream is unchanged and completes", async () => {
    const chunks = ["a", "b", "c"];
    const client = new AbortController();
    const res = await executeWithUpstreamStartTimeout({
      executor: {},
      provider: "test",
      model: "m",
      connectionTimeoutMs: 5000,
      signal: client.signal,
      execute: async () => new Response(chunks.join("")),
    });
    assert.equal(await res.text(), "abc");
  });

  test("start-timeout wrapper: failed attempt does not keep the client-abort link", async () => {
    const client = new AbortController();
    let inner: AbortSignal | null = null;
    await assert.rejects(
      executeWithUpstreamStartTimeout({
        executor: {},
        provider: "test",
        model: "m",
        connectionTimeoutMs: 5000,
        signal: client.signal,
        execute: async (s) => {
          inner = s;
          throw new Error("boom");
        },
      }),
      /boom/
    );
    client.abort();
    assert.equal(inner!.aborted, false);
  });

  test("pipeWithDisconnect: client disconnect cancels the upstream body", async () => {
    let upstreamCancelled: unknown = null;
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await sleep(10);
        c.enqueue(new TextEncoder().encode(`data: ${i++}\n\n`));
      },
      cancel(reason) {
        upstreamCancelled = reason ?? "cancelled";
      },
    });
    const clientAbort = new AbortController();
    const sc = createStreamController({
      provider: "test",
      model: "m",
      clientAbortSignal: clientAbort.signal,
    });
    const out = pipeWithDisconnect(
      new Response(body),
      new TransformStream<Uint8Array, Uint8Array>(),
      sc
    );
    const reader = out.getReader();
    await reader.read();
    clientAbort.abort();
    // Pull-side path: handleDisconnect flips isConnected, next pull must cancel upstream.
    await Promise.race([reader.read().catch(() => {}), sleep(500)]);
    assert.equal(await waitFor(() => upstreamCancelled !== null), true);
  });

  test("pipeWithDisconnect: a normal stream is forwarded intact and not cancelled", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        c.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const sc = createStreamController({ provider: "test", model: "m" });
    const out = pipeWithDisconnect(
      new Response(body),
      new TransformStream<Uint8Array, Uint8Array>(),
      sc
    );
    const text = await new Response(out).text();
    assert.match(text, /hi/);
    assert.match(text, /\[DONE\]/);
    assert.equal(cancelled, false);
  });

  const silentLog = { warn() {} };

  test("validateResponseQuality: peek exits promptly on client abort", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {}); // upstream still prefilling: never yields
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const ac = new AbortController();
    const p = validateResponseQuality(res, true, silentLog, undefined, ac.signal);
    await sleep(30);
    const t0 = Date.now();
    ac.abort();
    const out = await Promise.race([p, sleep(1000).then(() => "hung")]);
    assert.notEqual(out, "hung");
    assert.ok(Date.now() - t0 < 500);
    assert.equal(await waitFor(() => cancelled), true);
  });

  test("validateResponseQuality: already-aborted signal returns without reading", async () => {
    const res = new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
      headers: { "content-type": "text/event-stream" },
    });
    const ac = new AbortController();
    ac.abort();
    const out = await Promise.race([
      validateResponseQuality(res, true, silentLog, undefined, ac.signal),
      sleep(1000).then(() => "hung"),
    ]);
    assert.notEqual(out, "hung");
  });

  test("validateResponseQuality: non-aborted stream with signal behaves as before", async () => {
    const enc = new TextEncoder();
    const res = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const out = await validateResponseQuality(
      res,
      true,
      silentLog,
      undefined,
      new AbortController().signal
    );
    assert.equal(out.valid, true);
    assert.ok(out.clonedResponse);
    assert.match(await out.clonedResponse!.text(), /\[DONE\]/);
  });
});

describe("claude-tool-casing-integration-17118", () => {
  const encoder = new TextEncoder();
  const tools = (name: string) => [{ name, input_schema: { type: "object", properties: {} } }];
  const client = () => ({
    model: "synthetic",
    tools: tools("read"),
    messages: [{ role: "user", content: "read a file" }],
  });
  const payload = (name: string) => ({
    id: "chatcmpl_fixture",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const names = (body: Record<string, unknown>) =>
    (body.content as Record<string, unknown>[])
      .filter((b) => b.type === "tool_use")
      .map((b) => b.name);

  async function jsonLeg(
    sourceBody: Record<string, unknown>,
    format = "openai",
    echoed = "Read",
    ledger: Map<string, string> | null = null
  ) {
    const responseBody =
      format === "gemini"
        ? {
            candidates: [
              {
                content: { role: "model", parts: [{ functionCall: { name: echoed, args: {} } }] },
                finishReason: "STOP",
              },
            ],
          }
        : format === "openai-responses"
          ? {
              id: "resp_fixture",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: echoed,
                  arguments: "{}",
                  status: "completed",
                },
              ],
            }
          : payload(echoed);
    return runNonStreamingProviderLeg(
      baseInput({
        sourceBody,
        sourceFormat: "claude",
        targetFormat: format,
        clientResponseFormat: "claude",
        provider: format === "gemini" ? "gemini" : format === "openai-responses" ? "xai" : "openai",
        translatedBody: { tools: tools("Read"), messages: [] },
        toolNameMap: ledger,
        executeProviderRequest: async () => ({
          response: Response.json(responseBody),
          url: "https://synthetic.invalid",
          headers: {},
          transformedBody: { tools: tools("Read") },
        }),
      })
    );
  }

  async function wire(transform: TransformStream, events: unknown[]) {
    const source = new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    const text = await new Response(source.pipeThrough(transform)).text();
    return [...text.matchAll(/^data: (.+)$/gm)]
      .filter((m) => m[1] !== "[DONE]")
      .map((m) => JSON.parse(m[1]));
  }
  const sseNames = (events: Record<string, unknown>[]) =>
    events
      .filter((e) => e.type === "content_block_start")
      .map((e) => e.content_block as Record<string, unknown>)
      .filter((b) => b.type === "tool_use")
      .map((b) => b.name);
  const claudeEvents = (name: string) => [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "synthetic",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name, input: {} },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];

  for (const format of ["openai", "gemini", "openai-responses"]) {
    test(`${format} JSON provider leg uses source tools, not rewritten provider tools`, async () => {
      const source = client();
      const before = structuredClone(source);
      const result = await jsonLeg(source, format);
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") return;
      assert.deepEqual(names(result.response), ["read"]);
      assert.deepEqual(source, before);
    });
  }

  test("JSON provider leg retains a real alias ledger over rewritten provider declarations", async () => {
    const result = await jsonLeg(
      { ...client(), tools: tools("mcp__docs__read") },
      "openai",
      "mcp_docs_read",
      new Map([["mcp_docs_read", "mcp__docs__read"]])
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") assert.deepEqual(names(result.response), ["mcp__docs__read"]);
  });

  for (const format of ["openai", "gemini"]) {
    test(`${format} SSE factory carries clientTools through real byte translation`, async () => {
      const transform = createSSETransformStreamWithLogger(
        format,
        "claude",
        format,
        null,
        null,
        "synthetic",
        null,
        { tools: tools("Read") },
        null,
        null,
        null,
        false,
        false,
        false,
        new Set(),
        null,
        tools("read")
      );
      const events =
        format === "openai"
          ? [
              {
                id: "chatcmpl_fixture",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          type: "function",
                          function: { name: "Read", arguments: "{}" },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            ]
          : [
              {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [{ functionCall: { name: "Read", args: {} } }],
                    },
                    finishReason: "STOP",
                  },
                ],
              },
            ];
      assert.deepEqual(sseNames(await wire(transform, events)), ["read"]);
    });
  }

  for (const explicit of [false, true]) {
    test(`Claude passthrough honors ${explicit ? "separate client tools over provider body" : "request body's tools array"}`, async () => {
      const transform = createSSEStream({
        mode: "passthrough",
        provider: "claude",
        clientResponseFormat: "claude",
        body: { tools: tools(explicit ? "Read" : "read") },
        ...(explicit ? { clientTools: tools("read") } : {}),
      });
      assert.deepEqual(sseNames(await wire(transform, claudeEvents("Read"))), ["read"]);
    });
  }

  test("actual combo fallback preserves source tools into JSON provider-leg translation", async () => {
    const source = client();
    const dispatched: string[] = [];
    const response = await handleComboChat({
      body: source,
      combo: {
        name: "casing-17118",
        strategy: "priority",
        models: ["claude/first", "openai/second"],
        config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
      },
      isModelAvailable: async () => true,
      handleSingleModel: async (body, model) => {
        dispatched.push(model);
        if (model === "claude/first")
          return Response.json({ error: { message: "synthetic rate limit" } }, { status: 429 });
        assert.deepEqual(body.tools, tools("read"));
        const result = await jsonLeg(body);
        assert.equal(result.kind, "ok");
        return Response.json(result.kind === "ok" ? result.response : {});
      },
      settings: {
        resilienceSettings: {
          comboCooldownWait: { enabled: false, maxWaitMs: 1, maxAttempts: 1, budgetMs: 1 },
        },
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      allCombos: null,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(dispatched, ["claude/first", "openai/second"]);
    assert.deepEqual(names(await response.json()), ["read"]);
    assert.deepEqual(source.tools, tools("read"));
  });

  for (const declared of [tools("read"), []]) {
    test(`passthrough convenience wrapper preserves explicit ${declared.length ? "client tools" : "empty declarations"}`, async () => {
      const transform = createPassthroughStreamWithLogger(
        "claude",
        null,
        null,
        "synthetic",
        null,
        { tools: tools("read") },
        null,
        null,
        null,
        "claude",
        null,
        declared
      );
      assert.deepEqual(sseNames(await wire(transform, claudeEvents("Read"))), [
        declared.length ? "read" : "Read",
      ]);
    });
  }
});

describe("combo-quality-validator-reasoning", () => {
  // Issue #2341 — `validateResponseQuality` must treat a response carrying `reasoning_content`
  // (Kimi-K2.5-TEE, GLM-5-TEE, etc.) as valid even when `content` is null. The previous
  // implementation only inspected `content` and `tool_calls`, so reasoning models triggered a
  // false-positive "empty content" 502 and an unnecessary combo fallback.
  function makeResponse(body: unknown, contentType = "application/json"): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": contentType },
    });
  }

  const silentLog = { warn: () => {} };

  test("#2341 reasoning_content with null content is treated as valid", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: " The user simply said 'Say OK'. OK. ",
          },
        },
      ],
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, `expected valid, got reason: ${out.reason}`);
  });

  test("#2341 legacy `reasoning` field is also recognized", async () => {
    // Some upstream variants use `reasoning` (no `_content` suffix).
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning: "Step-by-step deduction body here.",
          },
        },
      ],
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, `expected valid, got reason: ${out.reason}`);
  });

  test("#2341 empty reasoning_content + empty content + no tool_calls still rejected", async () => {
    // Regression guard: the new branch must not weaken the empty-response check.
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "   ",
          },
        },
      ],
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, false);
    assert.match(out.reason ?? "", /empty content/i);
  });

  test("#2341 normal content-only response remains valid (backward compat)", async () => {
    const res = makeResponse({
      choices: [{ message: { content: "Hello world." } }],
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true);
  });

  test("#2341 tool_calls-only response remains valid (backward compat)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
        },
      ],
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true);
  });

  test("#2341 reasoning_content as non-string is ignored (defensive)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: { unexpected: "object" },
          },
        },
      ],
    });
    const out = await validateResponseQuality(res, false, silentLog);
    // Non-string reasoning_content shouldn't count as content; still rejected.
    assert.equal(out.valid, false);
  });

  test("#3587 reasoning consumed 90%+ of tokens → invalid (token exhaustion)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "Deep reasoning about the problem...",
          },
        },
      ],
      usage: {
        completion_tokens: 4096,
        reasoning_tokens: 3800,
      },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, false, "should be invalid: reasoning exhausted tokens");
    assert.match(out.reason ?? "", /reasoning consumed/i);
  });

  test("#3587 reasoning consumed < 90% of tokens → valid (normal reasoning)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "Some reasoning",
          },
        },
      ],
      usage: {
        completion_tokens: 4096,
        reasoning_tokens: 500,
      },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, "should be valid: reasoning has room");
  });

  test("#3587 reasoning with no usage data → valid (can't determine)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "Some reasoning",
          },
        },
      ],
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, "should be valid: no usage to check");
  });

  test("#3587 content present + reasoning + tokens exhausted → valid (has content)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: "Final answer here",
            reasoning_content: "Deep reasoning",
          },
        },
      ],
      usage: {
        completion_tokens: 4096,
        reasoning_tokens: 3800,
      },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, "should be valid: content is present");
  });

  test("#3587 reasoning via completion_tokens_details.reasoning_tokens → invalid", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "Step-by-step analysis...",
          },
        },
      ],
      usage: {
        completion_tokens: 10000,
        completion_tokens_details: { reasoning_tokens: 9500 },
      },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, false, "should be invalid: reasoning exhausted via details");
    assert.match(out.reason ?? "", /reasoning consumed/i);
  });

  test("client-audit-2026-09-01: finish_reason:length + reasoning <90% of tokens → invalid (direct truncation signal beats the ratio heuristic)", async () => {
    // Reproduces a live CT124 response: nvidia/nemotron truncated by max_tokens
    // with content:null, finish_reason:"length", and reasoning at only 63% of
    // completion_tokens (645/1024) — below the old 90% threshold, so it used to
    // pass the validator as "valid" even though the caller got nothing usable.
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning: "Step-by-step analysis that never reached a final answer...",
          },
          finish_reason: "length",
        },
      ],
      usage: {
        completion_tokens: 1024,
        completion_tokens_details: { reasoning_tokens: 645 },
      },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, false, "should be invalid: finish_reason:length with empty content");
    assert.match(out.reason ?? "", /truncated at token limit/i);
  });

  test("client-audit-2026-09-01: finish_reason:max_tokens (Anthropic-shape naming) + empty content → invalid", async () => {
    const res = makeResponse({
      choices: [
        {
          message: { content: null, reasoning_content: "Partial reasoning trace" },
          finish_reason: "max_tokens",
        },
      ],
      usage: { completion_tokens: 512, reasoning_tokens: 100 },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(
      out.valid,
      false,
      "should be invalid: max_tokens finish_reason with empty content"
    );
  });

  test("client-audit-2026-09-01: no finish_reason + reasoning <90% of tokens → still valid (regression guard, #3587 behavior preserved)", async () => {
    // Same low ratio as the case above, but no finish_reason reported at all —
    // the direct-truncation-signal branch must not fire, only the ratio heuristic.
    const res = makeResponse({
      choices: [{ message: { content: null, reasoning_content: "Some reasoning" } }],
      usage: { completion_tokens: 1024, reasoning_tokens: 645 },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, "should stay valid: no finish_reason signal, ratio under 90%");
  });

  test("finish_reason:stop + reasoning over 90% is a clean stop, not exhaustion", async () => {
    const res = makeResponse({
      choices: [
        {
          message: { content: null, reasoning_content: "Deep reasoning" },
          finish_reason: "stop",
        },
      ],
      usage: { completion_tokens: 4096, reasoning_tokens: 3800 },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, "finish_reason:stop means the model ended on its own");
  });

  test("no finish_reason + reasoning over 90% stays invalid (fallback heuristic)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: { content: null, reasoning_content: "Deep reasoning" },
        },
      ],
      usage: { completion_tokens: 4096, reasoning_tokens: 3800 },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, false, "no finish_reason still falls back to the 90% check");
    assert.match(out.reason ?? "", /reasoning consumed/i);
  });

  test("#3587 edge: completion_tokens=0 → safe (no division by zero)", async () => {
    const res = makeResponse({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "Tiny reasoning",
          },
        },
      ],
      usage: {
        completion_tokens: 0,
        reasoning_tokens: 0,
      },
    });
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, "should be valid: can't divide by zero");
  });
});

describe("combo-quality-tiny-budget-probe", () => {
  const silentLog = { warn: () => {} };
  function makeTinyProbeResponse(): Response {
    // Mirrors the issue's reported shape verbatim: "reasoning consumed 10/10 tokens — no content output"
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: null, reasoning_content: "Ok" }, finish_reason: "length" }],
        usage: { completion_tokens: 10, reasoning_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  test("#12659 EXPECTED: combo validator exempts a tiny-budget reasoning probe (finish_reason:length, tiny completion_tokens) instead of a genuine quality failure", async () => {
    const res = makeTinyProbeResponse();
    const out = await validateResponseQuality(res, false, silentLog);
    assert.equal(out.valid, true, `reproduces #12659: ... (reason: ${out.reason})`);
  });
});

describe("combo-response-validation-failover", () => {
  // Feature 4985 — a combo with a configured `responseValidation` predicate must fail over when a
  // leg returns a 200 OK whose body fails the predicate, exactly like an HTTP error. Mirrors the
  // #5085 empty-content failover harness (2 legs, different providers).
  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function content200(model: string, text: string) {
    return new Response(
      JSON.stringify({
        id: "ok",
        object: "chat.completion",
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  function makeCombo(models: string[], responseValidation: Record<string, unknown>) {
    return {
      name: "test-combo-4985",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
      config: { responseValidation },
    };
  }

  test("4985 fails over when leg 1's 200 body trips a forbidden substring", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      if (modelsCalled.length === 1) return content200(modelStr, "Sorry, I cannot help with that.");
      return content200(modelStr, "Here is the answer you asked for.");
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["nvidia/minimaxai/minimax-m3", "openai/gpt-4o-mini"], {
        forbiddenSubstrings: ["I cannot help"],
      }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(
      modelsCalled.length,
      2,
      `predicate failure on leg 1 must advance to leg 2, tried: ${modelsCalled.join(", ")}`
    );
    assert.equal(result.status, 200, "the combo must surface the healthy second leg's 200");
    const body = JSON.parse(await result.text());
    assert.match(
      String(body?.choices?.[0]?.message?.content ?? ""),
      /answer you asked for/,
      "surfaced content must come from the leg that passed the predicate"
    );
  });

  test("4985 does NOT fail over when the configured predicate passes", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      return content200(modelStr, "A perfectly good answer.");
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["nvidia/minimaxai/minimax-m3", "openai/gpt-4o-mini"], {
        forbiddenSubstrings: ["I cannot help"],
        minContentLength: 5,
      }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(
      modelsCalled.length,
      1,
      "a passing predicate must not trigger a needless failover"
    );
    assert.equal(result.status, 200);
  });
});

describe("combo-empty-content-failover-5085", () => {
  // #5085 — A multi-leg combo whose first leg returns a 502 "Provider returned empty content"
  // must FAIL OVER to the next leg within the same request, not surface the 502 to the caller. An
  // empty completion is a fake-success failure (HTTP 200 with no content → rewritten to 502 in
  // chatCore), and for a combo whose whole purpose is resilience it should behave like any other
  // transient leg failure and advance.
  //
  // Reproduction: a `priority` combo with two legs on DIFFERENT providers. Leg 1 returns the
  // empty-content 502 (exactly the body buildErrorBody produces in chatCore's
  // isEmptyContentResponse branch); leg 2 returns a healthy 200. The combo must try leg 2 and
  // surface its 200 — never return the leg-1 502.
  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  // Mirrors chatCore's empty-content branch: buildErrorBody(502, "Provider returned empty content").
  function emptyContent502() {
    return new Response(
      JSON.stringify({
        error: { message: "Provider returned empty content", type: "bad_gateway" },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
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
      name: "test-combo-5085",
      strategy: "priority",
      models: models.map((m) => ({ model: m })),
    };
  }

  test("#5085 combo fails over to the next leg when leg 1 returns empty-content 502", async () => {
    const modelsCalled: string[] = [];
    const handleSingleModel = async (_body: unknown, modelStr: string) => {
      modelsCalled.push(modelStr);
      // First leg (different provider) returns the empty-content 502; second leg is healthy.
      if (modelsCalled.length === 1) return emptyContent502();
      return healthy200(modelStr);
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo(["nvidia/minimaxai/minimax-m3", "openai/gpt-4o-mini"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(
      modelsCalled.length,
      2,
      `empty-content 502 on leg 1 must advance to leg 2, but tried: ${modelsCalled.join(", ")}`
    );
    assert.equal(
      result.status,
      200,
      "the combo must surface the healthy second leg's 200, not the leg-1 empty-content 502"
    );
  });

  // ── Precise unit test of the exhaustion classifier ──
  // The integration test above already passes because the empty-content leg and
  // the healthy leg are on different providers. The real defect is provider-level:
  // an empty-content 502 is currently classified as a CONNECTION-level failure
  // (502 ∈ CONNECTION_LEVEL_ERROR_STATUSES), which marks the whole provider/
  // connection exhausted and skips every REMAINING SAME-PROVIDER leg (#1731v2).
  // An empty completion arrived on a HEALTHY connection (HTTP 200, no content) and
  // must not be treated as a bad connection.
  function makeTarget(provider: string, modelStr: string, connectionId: string | null = null) {
    return {
      kind: "model" as const,
      stepId: "s",
      executionKey: "e",
      modelStr,
      provider,
      providerId: provider,
      connectionId,
      weight: 1,
      label: null,
    };
  }

  function freshSets() {
    return {
      exhaustedProviders: new Set<string>(),
      exhaustedConnections: new Set<string>(),
      transientRateLimitedProviders: new Set<string>(),
    };
  }

  test("#5085 empty-content 502 must NOT mark the provider/connection exhausted (model-level, not connection-level)", () => {
    const sets = freshSets();
    const { providerExhausted: providerExhausted } = applyComboTargetExhaustion(
      makeTarget("nvidia", "nvidia/minimaxai/minimax-m3"),
      {
        result: { status: 502, headers: new Headers() },
        fallbackResult: { reason: "server_error" },
        errorText: "Provider returned empty content",
        rawModel: "minimaxai/minimax-m3",
        isTokenLimitBreach: false,
        allAccountsRateLimited: false,
        sets,
        log,
        tag: "COMBO",
        exhaustedLogLevel: "info",
      }
    );

    assert.equal(providerExhausted, false, "empty-content is not a quota exhaustion");
    assert.equal(
      sets.exhaustedProviders.has("nvidia"),
      false,
      "empty-content 502 must NOT mark the whole provider exhausted — remaining same-provider legs must still be tried"
    );
  });

  test("#8397 empty-response 502 (no usable choices/output) must NOT mark provider/connection exhausted", () => {
    const sets = freshSets();
    const { providerExhausted: providerExhausted } = applyComboTargetExhaustion(
      makeTarget("nvidia", "nvidia/minimaxai/minimax-m3"),
      {
        result: { status: 502, headers: new Headers() },
        fallbackResult: { reason: "server_error" },
        errorText: "upstream returned an empty response without usable output",
        rawModel: "minimaxai/minimax-m3",
        isTokenLimitBreach: false,
        allAccountsRateLimited: false,
        sets,
        log,
        tag: "COMBO",
        exhaustedLogLevel: "info",
      }
    );

    assert.equal(providerExhausted, false, "empty-response is not a quota exhaustion");
    assert.equal(
      sets.exhaustedProviders.has("nvidia"),
      false,
      "empty-response 502 must NOT mark the whole provider exhausted"
    );
    assert.equal(
      sets.exhaustedConnections.size,
      0,
      "empty-response 502 must NOT mark any connection exhausted"
    );
  });

  test("#5085 a real connection-level 502 (gateway error) STILL marks the provider exhausted", () => {
    const sets = freshSets();
    applyComboTargetExhaustion(makeTarget("nvidia", "nvidia/minimaxai/minimax-m3"), {
      result: { status: 502, headers: new Headers() },
      fallbackResult: { reason: "server_error" },
      errorText: "Bad gateway: upstream connection reset",
      rawModel: "minimaxai/minimax-m3",
      isTokenLimitBreach: false,
      allAccountsRateLimited: false,
      sets,
      log,
      tag: "COMBO",
      exhaustedLogLevel: "info",
    });

    assert.equal(
      sets.exhaustedProviders.has("nvidia"),
      true,
      "a genuine gateway 502 must still mark the provider connection-exhausted (#1731v2 preserved)"
    );
  });
});

describe("combo-peek-byte-cap-11804", () => {
  // #11804 / #7849: the combo SSE peek must not retain an entire long stream while it waits for a
  // content verdict.
  test("#11804 peek stops retaining after 1 MiB and leaves the rest unread", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(256 * 1024);
    chunk.fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        // Never ends. A correct peek returns before this producer is exhausted.
        controller.enqueue(chunk);
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(response, true, { warn: () => undefined });
    assert.equal(out.valid, true);
    assert.ok(out.clonedResponse, "expected a replay of the peeked prefix");
    assert.ok(pulls <= 6, `peek kept reading, pulls=${pulls}`);
  });
});
