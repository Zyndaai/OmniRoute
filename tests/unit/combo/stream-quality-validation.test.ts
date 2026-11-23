// Streaming quality validation, stream-readiness and first-output gating around combo.ts:
// validateResponseQuality peeks, zombie-stream fallback, cut-stream failover and the
// per-target first-output budget. Merged from ten files so combo.ts loads once; each original
// file is one `describe` below, named after the file it came from.
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComboLogger } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-stream-quality-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-stream-quality-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const { buildTargetTimeoutRunner, resolveFirstOutputWaitMs } =
  await import("../../../open-sse/services/combo/targetTimeoutRunner.ts");
const { DECLARED_FIRST_OUTPUT_WAIT_CAP_MS, resolveComboSetupConfig } =
  await import("../../../open-sse/services/comboConfig.ts");
const { awaitFirstOutput, SseOutputScanner } =
  await import("../../../open-sse/services/combo/firstOutputStream.ts");
const { OPENAI_RESPONSES_IN_PROGRESS_FRAME } =
  await import("../../../open-sse/utils/sseHeartbeat.ts");
const { handleComboChat, validateResponseQuality, resolveDeclaredTargetBudgetMs } =
  await import("../../../open-sse/services/combo.ts");
const { GLM_TIMEOUT_MS } = await import("../../../open-sse/config/glmProvider.ts");
const { codexProvider } =
  await import("../../../open-sse/config/providers/registry/codex/index.ts");
const { ensureStreamReadiness } = await import("../../../open-sse/utils/streamReadiness.ts");
const { resetAllCircuitBreakers, getCircuitBreaker } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const { parseNonStreamingResponseBody } =
  await import("../../../open-sse/handlers/chatCore/nonStreamingResponseParse.ts");
const { inheritEmptyTurnPolicy } = await import("../../../open-sse/utils/emptyTurnPolicy.ts");
const { inheritResponsePolicies } =
  await import("../../../src/sse/handlers/chat/responsePolicies.ts");
const { parseSSEToOpenAIResponse, parseSSEToClaudeResponse, parseSSEToResponsesOutput } =
  await import("../../../open-sse/handlers/sseParser.ts");
const { parseSSEToGeminiResponse } =
  await import("../../../open-sse/handlers/sseParser/geminiResponse.ts");
const truncation = await import("../../../open-sse/handlers/sseParser/truncation.ts");
const { getAllModelLockouts, clearAllModelLockouts } =
  await import("../../../open-sse/services/accountFallback.ts");
const { isKnownNonClaudeStreamPayload } = await import("../../../open-sse/utils/streamHelpers.ts");
const { newStreamCtx, processFrame, ctxProducedSignal, isCursorEmptyTurn } =
  await import("../../../open-sse/executors/cursor");
const { extractEmbeddedCursorToolResults } =
  await import("../../../open-sse/executors/cursor/embeddedToolResults.ts");

after(() => {
  clearAllModelLockouts();
  try {
    core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

describe("combo-target-stream-first-output", () => {
  const noopLog: ComboLogger = { warn() {}, info() {}, error() {}, debug() {} };

  const enc = new TextEncoder();

  function frame(delta: Record<string, unknown>) {
    return `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`;
  }

  /**
   * SSE body that emits the given frames, then either closes or stalls forever. `cancelled` flips
   * when the target is torn down, either through the target's abort signal or a cancel.
   */
  function sseBody(
    frames: (string | Uint8Array)[],
    opts: { stall?: boolean; cancelled?: () => void; signal?: AbortSignal | null } = {}
  ) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(typeof f === "string" ? enc.encode(f) : f);
        if (!opts.stall) controller.close();
        opts.signal?.addEventListener(
          "abort",
          () => {
            opts.cancelled?.();
            controller.error(new Error("aborted"));
          },
          { once: true }
        );
      },
      cancel() {
        opts.cancelled?.();
      },
    });
  }

  function sseResponse(body: ReadableStream<Uint8Array>, status = 200) {
    return new Response(body, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("a streaming target that never produces output is abandoned within the per-target budget", async () => {
    let cancelled = false;
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () =>
        sseResponse(
          sseBody([": keepalive\n\n"], { stall: true, cancelled: () => (cancelled = true) })
        ),
      comboTargetTimeoutMs: 80,
      log: noopLog,
    });

    const started = Date.now();
    const res = await runner({}, "stalled-model");

    assert.equal(res.status, 504, "a silent stream must fail over, not hold the combo");
    const body = await res.json();
    assert.equal(body?.error?.code, "combo_target_timeout");
    assert.match(res.headers.get("content-type") ?? "", /json/);
    assert.ok(Date.now() - started < 2000, "failover must land near the budget");
    assert.equal(cancelled, true, "the stalled upstream stream must be released");
  });

  test("the gateway's own Responses heartbeat is not output", async () => {
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () =>
        sseResponse(sseBody([OPENAI_RESPONSES_IN_PROGRESS_FRAME], { stall: true })),
      comboTargetTimeoutMs: 120,
      log: noopLog,
    });

    const res = await runner({}, "responses-model");
    assert.equal(res.status, 504, "a keepalive frame says nothing about the answer");
  });

  test("an event: progress tick is not output", async () => {
    const progress = 'event: progress\ndata: {"tokens_generated":0,"elapsed_ms":2000}\n\n';
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([progress], { stall: true })),
      comboTargetTimeoutMs: 120,
      log: noopLog,
    });

    const res = await runner({}, "progress-model");
    assert.equal(res.status, 504);
  });

  test("a streaming target that emits output right away is passed through byte for byte", async () => {
    const frames = [
      frame({ role: "assistant" }),
      frame({ content: "hello" }),
      frame({ content: " world" }),
      "data: [DONE]\n\n",
    ];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames)),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "fast-model");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), frames.join(""));
  });

  test("keepalive comments ahead of the first token are replayed, not swallowed", async () => {
    const frames = [": keepalive\n\n", frame({ content: "hi" }), "data: [DONE]\n\n"];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames)),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "slow-first-token");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), frames.join(""));
  });

  test("a tool call without any text still counts as the target producing output", async () => {
    const frames = [
      frame({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "run", arguments: "" } },
        ],
      }),
      frame({ tool_calls: [{ index: 0, function: { arguments: '{"command":"echo hi"}' } }] }),
      "data: [DONE]\n\n",
    ];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames)),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "tool-model");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), frames.join(""));
  });

  test("a refusal delta counts as output, matching the shared predicate", async () => {
    const frames = [frame({ refusal: "I cannot help with that" })];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames, { stall: true })),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "refusal-model");
    assert.equal(res.status, 200, "a refusal is the model answering, not silence");
  });

  test("a Responses-protocol reasoning delta counts as output", async () => {
    const frames = ['data: {"type":"response.reasoning_text.delta","delta":"thinking"}\n\n'];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames, { stall: true })),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "codex-model");
    assert.equal(res.status, 200);
  });

  test("a Messages-protocol content block delta counts as output", async () => {
    const frames = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    ];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames, { stall: true })),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "claude-model");
    assert.equal(res.status, 200);
  });

  function delayedSseBody(first: string, later: string, delayMs = 30) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(first));
        timer = setTimeout(() => {
          controller.enqueue(enc.encode(later));
          controller.close();
        }, delayMs);
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    });
  }

  test("a Claude redacted thinking block start passes through byte-for-byte", async () => {
    const redactedStart =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n';
    const later = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    const expected = redactedStart + later;
    const response = sseResponse(delayedSseBody(redactedStart, later));
    const started = Date.now();
    const result = await awaitFirstOutput(response, 900);

    assert.equal(result.kind, "reasoning");
    assert.ok(Date.now() - started < 500, "the upstream Claude thinking frame must end the wait");
    assert.equal(
      await (result as { response: Response }).response.text(),
      expected,
      "the original stream remains byte-identical"
    );
  });

  test("an empty Claude thinking_delta alone waits for the first-output budget", async () => {
    const emptyThinking =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}\n\n';
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([emptyThinking], { stall: true })),
      comboTargetTimeoutMs: 280,
      log: noopLog,
    });

    const started = Date.now();
    const result = await runner({}, "claude-empty-thinking-delta");
    assert.equal(result.status, 504);
    assert.ok(Date.now() - started >= 220, "an empty thinking delta is not upstream progress");
  });

  test("a non-empty Claude thinking_delta passes through with later bytes intact", async () => {
    const thinkingDelta =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me reason"}}\n\n';
    const later = 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    const expected = thinkingDelta + later;
    const response = sseResponse(delayedSseBody(thinkingDelta, later));
    const started = Date.now();
    const result = await awaitFirstOutput(response, 900);

    assert.equal(
      result.kind,
      "output",
      "the shared output predicate treats visible thinking text as output"
    );
    assert.ok(Date.now() - started < 500, "non-empty Claude thinking ends the wait");
    assert.equal(
      await (result as { response: Response }).response.text(),
      expected,
      "the original stream remains byte-identical"
    );
  });

  test("an OpenAI role chunk with empty reasoning waits for the first-output budget", async () => {
    const roleOnly =
      'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}\n\n';
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([roleOnly], { stall: true })),
      comboTargetTimeoutMs: 280,
      log: noopLog,
    });

    const started = Date.now();
    const result = await runner({}, "openai-empty-reasoning-role");
    assert.equal(result.status, 504);
    assert.ok(Date.now() - started >= 220, "an empty reasoning field is not progress");
  });

  test("a Responses reasoning item after response.created waits for the first-output budget", async () => {
    const created =
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n';
    const reasoningItem =
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"reasoning_1","type":"reasoning","summary":[]}}\n\n';
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () =>
        sseResponse(sseBody([created, reasoningItem], { stall: true })),
      comboTargetTimeoutMs: 280,
      log: noopLog,
    });

    const started = Date.now();
    const result = await runner({}, "responses-reasoning-item");
    assert.equal(result.status, 504);
    assert.ok(Date.now() - started >= 220, "Responses reasoning items are outside the Claude rule");
  });

  test("thinking start followed by text in one chunk is classified as output", async () => {
    const thinkingStart =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n';
    const textDelta =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"answer"}}\n\n';
    const expected = thinkingStart + textDelta;
    const response = sseResponse(sseBody([expected]));
    const result = await awaitFirstOutput(response, 900);

    assert.equal(result.kind, "output");
    assert.equal(
      await (result as { response: Response }).response.text(),
      expected,
      "output bytes are passed through unchanged"
    );
  });

  test("an upstream empty thinking block start passes before the first-output budget", async () => {
    const thinkingStart =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n';
    const response = sseResponse(sseBody([thinkingStart], { stall: true }));
    const logs: string[] = [];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => response,
      comboTargetTimeoutMs: 900,
      log: { ...noopLog, info: (_tag, message) => logs.push(message) },
    });

    const started = Date.now();
    const result = await runner({}, "claude-opus-thinking");

    assert.equal(result, response, "reasoning activity hands the original response through");
    assert.ok(Date.now() - started < 500, "reasoning must pass before the 900ms budget");
    assert.deepEqual(logs, [
      "first-output gate: upstream thinking from claude-opus-thinking (thinking), ending the first-output wait",
    ]);
    await result.body?.cancel();
  });

  test("a non-empty signature_delta alone proves upstream reasoning activity", async () => {
    const signature =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-signature"}}\n\n';
    const response = sseResponse(sseBody([signature], { stall: true }));
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => response,
      comboTargetTimeoutMs: 900,
      log: noopLog,
    });

    const started = Date.now();
    const result = await runner({}, "claude-signature-only");

    assert.equal(result, response);
    assert.ok(Date.now() - started < 500, "signature activity must pass before the budget");
    await result.body?.cancel();
  });

  test("an empty signature bootstrap does not pass the first-output gate", async () => {
    const emptySignature =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":""}}\n\n';
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([emptySignature], { stall: true })),
      comboTargetTimeoutMs: 120,
      log: noopLog,
    });

    const result = await runner({}, "claude-empty-signature-bootstrap");
    assert.equal(result.status, 504);
    assert.equal((await result.json())?.error?.code, "combo_target_timeout");
  });

  test("heartbeat-only frames do not end the guard", async () => {
    const frames = ['data: {"type":"ping"}\n\n', 'data: {"choices":[{"index":0,"delta":{}}]}\n\n'];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames, { stall: true })),
      comboTargetTimeoutMs: 120,
      log: noopLog,
    });

    const res = await runner({}, "heartbeat-model");
    assert.equal(res.status, 504, "a stream that only sends heartbeats is still silent");
  });

  test("a message_start-only stream is a heartbeat, not output", async () => {
    const frames = ['data: {"type":"message_start","message":{"id":"m1"}}\n\n'];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames, { stall: true })),
      comboTargetTimeoutMs: 120,
      log: noopLog,
    });

    const res = await runner({}, "messages-model");
    assert.equal(res.status, 504, "message_start says nothing about the answer yet");
  });

  test("a body that closes before any output is left to the empty-response path", async () => {
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([])),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "empty-model");
    assert.equal(res.status, 200, "an empty stream is not a per-target timeout");
  });

  test("an answer that arrives without a trailing blank line is not thrown away", async () => {
    const unTerminated = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n';
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([unTerminated])),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "unterminated-model");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), unTerminated);
  });

  test("an event split across several data lines is still recognised as output", async () => {
    const frames = ['data: {"type":"response.output_text.delta",\ndata: "delta":"hi"}\n\n'];
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody(frames, { stall: true })),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "multi-line-model");
    assert.equal(res.status, 200);
  });

  test("the scanner joins the data lines of one event before deciding", async () => {
    const scanner = new SseOutputScanner();
    assert.equal(scanner.push('data: {"type":"response.output_text.delta",\n'), false);
    assert.equal(scanner.push('data: "delta":"hi"}\n\n'), true);
  });

  test("bare CR line endings are read as line breaks", async () => {
    const scanner = new SseOutputScanner();
    assert.equal(scanner.push('data: {"choices":[{"delta":{"content":"hi"}}]}\r'), false);
    assert.equal(scanner.push("\r"), true);
  });

  test("a CRLF split across chunks is one line break, not two", async () => {
    const scanner = new SseOutputScanner();
    assert.equal(scanner.push('data: {"choices":[{"delta":{"content":"hi"}}]}\r'), false);
    assert.equal(scanner.push("\n\r\n"), true);
  });

  test("an unterminated flood releases the gate instead of buffering forever", async () => {
    const scanner = new SseOutputScanner();
    assert.equal(scanner.push("x".repeat(70 * 1024)), false);
    assert.equal(scanner.overflowedWithoutOutput(), true);
  });

  test("an upstream error event ends the gate as a verdict, not as a stall", async () => {
    const scanner = new SseOutputScanner();
    const failed = JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: { code: "no_capacity", message: "peak capacity" } },
    });
    assert.equal(scanner.push(`event: response.failed\ndata: ${failed}\n\n`), true);

    const bare = new SseOutputScanner();
    assert.equal(bare.push('event: error\ndata: {"message":"boom"}\n\n'), true);

    const ping = new SseOutputScanner();
    assert.equal(ping.push("event: ping\ndata: {}\n\n"), false, "a ping is still not a verdict");
  });

  test("a stream that reports failure up front and stays open is handed back at once", async () => {
    const failed = JSON.stringify({
      type: "response.failed",
      response: { status: "failed", error: { code: "no_capacity", message: "peak capacity" } },
    });
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () =>
        sseResponse(sseBody([`event: response.failed\ndata: ${failed}\n\n`], { stall: true })),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const started = Date.now();
    const res = await runner({}, "failing-open-model");
    assert.equal(res.status, 200, "returned for the quality check to classify, not as a 504");
    assert.ok(Date.now() - started < 1000, "must not wait out the 5s target budget");
    await res.body?.cancel();
  });

  test("a non-2xx streaming response keeps its status", async () => {
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([], { stall: true }), 429),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "rate-limited-model");
    assert.equal(res.status, 429, "a rate limit keeps its meaning instead of becoming a 504");
  });

  test("the gate budget is what the dispatch left over", async () => {
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return sseResponse(sseBody([], { stall: true }));
      },
      comboTargetTimeoutMs: 1000,
      log: noopLog,
    });

    const started = Date.now();
    const res = await runner({}, "slow-dispatch-model");
    const elapsed = Date.now() - started;

    assert.equal(res.status, 504);
    // 600ms of dispatch plus the ~400ms left over; a second full 1000ms budget would overshoot.
    assert.ok(elapsed < 1300, `expected the leftover budget to bound the wait, took ${elapsed}ms`);
    assert.ok(
      elapsed > 800,
      `expected the wait to actually use the leftover budget, took ${elapsed}ms`
    );
  });

  test("a parent hedge abort during the first-output wait is not a timeout", async () => {
    const parent = new AbortController();
    let cancelled = false;
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async (_b, _m, target) =>
        sseResponse(
          sseBody([], {
            stall: true,
            cancelled: () => (cancelled = true),
            signal: target?.modelAbortSignal ?? null,
          })
        ),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const started = Date.now();
    const pending = runner({}, "hedged-model", { modelAbortSignal: parent.signal });
    setTimeout(() => parent.abort(), 60);
    const res = await pending;

    assert.notEqual(res.status, 504, "losing a hedge race must not be charged as a timeout");
    assert.equal(cancelled, true, "the hedge cancel must reach the target body");
    assert.ok(Date.now() - started < 2000, "the cancel must not wait for the full budget");
  });

  test("the gate gives up as soon as its signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = awaitFirstOutput(
      sseResponse(sseBody([], { stall: true })),
      5000,
      controller.signal
    );
    setTimeout(() => controller.abort(), 40);
    const result = await pending;

    assert.equal(result.kind, "stalled");
    assert.equal(result.kind === "stalled" ? result.reason : "", "cancelled");
    assert.ok(Date.now() - started < 2000, "the abort must not wait for the full budget");
  });

  test("a non-streaming response is untouched", async () => {
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const res = await runner({}, "json-model");
    assert.equal(res.status, 200);
    assert.equal((await res.json())?.choices?.[0]?.message?.content, "ok");
  });

  // ── Body integrity: the gate must hand back an untouched body unless it is failing the target ──

  function sseFramesResponse(frames: string[]) {
    return sseResponse(sseBody(frames));
  }

  const CLAUDE_EMPTY_TURN = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","content":[]}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const OPENAI_ROLE_ONLY_TURN = [frame({ role: "assistant" }), "data: [DONE]\n\n"];
  const RESPONSES_EMPTY_COMPLETED = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
  ];

  for (const [label, frames, trusted] of [
    ["a trusted empty Claude turn", CLAUDE_EMPTY_TURN, true],
    ["a trusted role-only OpenAI turn", OPENAI_ROLE_ONLY_TURN, true],
    ["an untrusted empty Responses completion", RESPONSES_EMPTY_COMPLETED, false],
  ] as const) {
    test(`${label} keeps its body and its quality verdict through the gate`, async () => {
      const direct = await validateResponseQuality(
        sseFramesResponse([...frames]),
        true,
        noopLog,
        null,
        null,
        trusted
      );
      assert.equal(direct.valid, true, "precondition: valid without the gate");

      const runner = buildTargetTimeoutRunner({
        handleSingleModel: async () => sseFramesResponse([...frames]),
        comboTargetTimeoutMs: 5000,
        log: noopLog,
      });
      const res = await runner({}, "empty-turn-model");

      assert.equal(res.status, 200);
      assert.equal(res.bodyUsed, false, "an empty stream is not the gate's to consume");
      // Same order as executeTargetAttempt: clone for the quality check, keep the original.
      const qualityClone = res.clone();
      const viaGate = await validateResponseQuality(
        qualityClone,
        true,
        noopLog,
        null,
        null,
        trusted
      );
      assert.equal(viaGate.valid, direct.valid, "the gate must not change the quality verdict");
      assert.equal(await res.text(), frames.join(""), "the client still gets every byte");
    });
  }

  test("a hedge cancel hands the body back unread and lets the target signal release upstream", async () => {
    const parent = new AbortController();
    let upstreamAborted = false;
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async (_b, _m, target) => {
        target?.modelAbortSignal?.addEventListener("abort", () => (upstreamAborted = true), {
          once: true,
        });
        return sseResponse(sseBody([], { stall: true }));
      },
      comboTargetTimeoutMs: 5000,
      log: noopLog,
    });

    const pending = runner({}, "hedged-model", { modelAbortSignal: parent.signal });
    setTimeout(() => parent.abort(), 40);
    const res = await pending;

    assert.equal(res.status, 200);
    assert.equal(res.bodyUsed, false, "the gate must not cancel a body it is not failing");
    assert.equal(upstreamAborted, true, "the target's abort signal carries the release");
    await res.body?.cancel();
  });

  test("a budget stall still releases the original body", async () => {
    let cancelled = false;
    const result = await awaitFirstOutput(
      sseResponse(sseBody([], { stall: true, cancelled: () => (cancelled = true) })),
      50
    );
    assert.equal(result.kind === "stalled" ? result.reason : "", "budget");
    // Cancelling one tee branch only reaches the source once both are cancelled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, true);
  });

  // ── Declared target budgets only ever lengthen the first-output wait ──

  test("a declared target budget lengthens the first-output wait past the dispatch budget", async () => {
    let declaredFor: unknown;
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([], { stall: true })),
      comboTargetTimeoutMs: 300,
      resolveDeclaredTargetBudgetMs: (target) => {
        declaredFor = target;
        return 900;
      },
      log: noopLog,
    });

    const target = { modelAbortSignal: new AbortController().signal };
    const started = Date.now();
    const res = await runner({}, "slow-reasoning-model", target);
    const elapsed = Date.now() - started;

    assert.equal(res.status, 504);
    assert.equal(declaredFor, target);
    assert.ok(elapsed >= 800, `expected the declared 900ms to bound the wait, took ${elapsed}ms`);
  });

  test("a declared target budget shorter than the dispatch budget does not tighten the wait", async () => {
    const runner = buildTargetTimeoutRunner({
      handleSingleModel: async () => sseResponse(sseBody([], { stall: true })),
      comboTargetTimeoutMs: 600,
      resolveDeclaredTargetBudgetMs: () => 50,
      log: noopLog,
    });

    const started = Date.now();
    const res = await runner({}, "short-declared-model");
    const elapsed = Date.now() - started;

    assert.equal(res.status, 504);
    assert.ok(
      elapsed >= 500,
      `a 50ms declared budget must not cut a 600ms wait, took ${elapsed}ms`
    );
  });

  test("declared target budgets resolve model, then provider, and defer to an explicit combo budget", async () => {
    const codexModel = codexProvider.models.find((model) => typeof model.timeoutMs === "number");
    assert.ok(codexModel, "precondition: the registry declares a per-model codex budget");
    const target = (provider: string, model: string) => ({
      kind: "model" as const,
      stepId: "s",
      executionKey: "k",
      modelStr: `${provider}/${model}`,
      provider,
      providerId: null,
      connectionId: null,
      weight: 1,
      label: null,
    });

    assert.equal(
      await resolveDeclaredTargetBudgetMs({}, target("codex", codexModel.id)),
      codexModel.timeoutMs
    );
    assert.equal(await resolveDeclaredTargetBudgetMs({}, target("glm", "glm-4.6")), GLM_TIMEOUT_MS);
    assert.equal(await resolveDeclaredTargetBudgetMs({}, target("openai", "gpt-4o")), undefined);
    assert.equal(
      await resolveDeclaredTargetBudgetMs({ targetTimeoutMs: 30_000 }, target("glm", "glm-4.6")),
      undefined,
      "an explicit per-combo targetTimeoutMs stays authoritative"
    );
  });

  test("a declared budget stretches the first-output wait by at most 180 seconds", () => {
    assert.equal(DECLARED_FIRST_OUTPUT_WAIT_CAP_MS, 180_000);
    assert.equal(resolveFirstOutputWaitMs(120_000, GLM_TIMEOUT_MS), 180_000, "GLM's 50 minutes");
    assert.equal(resolveFirstOutputWaitMs(120_000, 1_200_000), 180_000, "Codex xhigh's 20 minutes");
    assert.equal(
      resolveFirstOutputWaitMs(120_000, 150_000),
      150_000,
      "under the cap it applies as is"
    );
    assert.equal(
      resolveFirstOutputWaitMs(120_000, 60_000),
      120_000,
      "never shorter than the floor"
    );
    assert.equal(resolveFirstOutputWaitMs(120_000, undefined), 120_000);
    assert.equal(resolveFirstOutputWaitMs(120_000, Number.NaN), 120_000);
    assert.equal(
      resolveFirstOutputWaitMs(300_000, GLM_TIMEOUT_MS),
      300_000,
      "the cap never lowers a floor that is already longer"
    );
  });

  test("a global comboDefaults targetTimeoutMs counts as explicit; a provider override does not reach the combo setup", async () => {
    const glmTarget = {
      kind: "model" as const,
      stepId: "s",
      executionKey: "k",
      modelStr: "glm/glm-4.6",
      provider: "glm",
      providerId: null,
      connectionId: null,
      weight: 1,
      label: null,
    };
    const combo = { config: {} };
    assert.equal(
      await resolveDeclaredTargetBudgetMs(
        resolveComboSetupConfig(combo, { comboDefaults: { targetTimeoutMs: 30_000 } }),
        glmTarget
      ),
      undefined,
      "an operator's global default is as authoritative as the combo's own value"
    );
    assert.equal(
      await resolveDeclaredTargetBudgetMs(
        resolveComboSetupConfig(combo, { providerOverrides: { glm: { targetTimeoutMs: 30_000 } } }),
        glmTarget
      ),
      GLM_TIMEOUT_MS,
      "the combo setup resolves the cascade without a provider, so providerOverrides are not merged"
    );
  });
});

describe("combo-stream-readiness-fallback", () => {
  // Test isolation: the combo-dispatch cases below deliberately fail `glm` (zombie
  // streams / 504s) several times in a row, which legitimately trips the per-provider
  // circuit breaker. That OPEN state is a module-level singleton, so without a reset it
  // leaks into the next test — combo.ts then SKIPS `glm/*` targets entirely (combo.ts
  // "Skipping … circuit breaker OPEN"), making e.g. "does not retry stream readiness
  // timeouts on the same model" never attempt glm/zombie. Reset before each test so every
  // scenario starts from a clean breaker slate (the breaker behavior itself is correct).
  beforeEach(() => {
    resetAllCircuitBreakers();
  });

  const textEncoder = new TextEncoder();

  function createLog() {
    const entries: any[] = [];
    return {
      info: (tag: any, msg: any) => entries.push({ level: "info", tag, msg }),
      warn: (tag: any, msg: any) => entries.push({ level: "warn", tag, msg }),
      error: (tag: any, msg: any) => entries.push({ level: "error", tag, msg }),
      debug: (tag: any, msg: any) => entries.push({ level: "debug", tag, msg }),
      entries,
    };
  }

  function okStreamResponse(content: string): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          textEncoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: { role: "assistant", content } }],
            })}\n\n`
          )
        );
        controller.enqueue(
          textEncoder.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
            })}\n\n`
          )
        );
        controller.enqueue(textEncoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  function zombieStreamResponse(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode(": keepalive\n\n"));
        controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "ping" })}\n\n`));
        // Keep the stream open without useful content, matching HTTP 200 zombie streams.
      },
      cancel() {},
    });

    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  async function applyStreamReadiness(response: Response): Promise<Response> {
    const result = await ensureStreamReadiness(response, {
      timeoutMs: 10,
      provider: "glm",
      model: "zombie-model",
      log: createLog(),
    });
    return result.response;
  }

  function errorResponse(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { message, type: "upstream_error" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function readWithTimeout(response: Response, timeoutMs = 100): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        response.text(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timed out reading response after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  test("streaming quality peek releases OpenAI-compatible reasoning-only SSE immediately", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const firstChunk = `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: { role: "assistant", content: "", reasoning_content: "thinking" },
          finish_reason: null,
        },
      ],
    })}\n\n`;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(textEncoder.encode(firstChunk));
      },
    });

    const result = await Promise.race([
      validateResponseQuality(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
        true,
        createLog()
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    assert.notEqual(result, "timeout", "quality peek should not wait for the full OpenAI stream");
    assert.equal(result.valid, true);
    assert.ok(result.clonedResponse, "quality peek should replay the already-read prefix");

    streamController?.enqueue(textEncoder.encode("data: [DONE]\n\n"));
    streamController?.close();

    const text = await readWithTimeout(result.clonedResponse);
    assert.match(text, /reasoning_content/);
    assert.match(text, /\[DONE\]/);
  });

  test("streaming quality peek waits past OpenAI-compatible empty header chunks", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const emptyHeaderChunk = `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    })}\n\n`;

    const reasoningChunk = `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: { content: "", reasoning_content: "thinking" },
          finish_reason: null,
        },
      ],
    })}\n\n`;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(textEncoder.encode(emptyHeaderChunk));
      },
    });

    const qualityPromise = validateResponseQuality(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      true,
      createLog()
    );

    const earlyResult = await Promise.race([
      qualityPromise.then(() => "released"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);

    assert.equal(earlyResult, "pending", "empty OpenAI-compatible wrapper should not release");

    streamController?.enqueue(textEncoder.encode(reasoningChunk));

    const result = await Promise.race([
      qualityPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.notEqual(result, "timeout", "quality peek should release when reasoning starts");
    assert.equal(result.valid, true);
    assert.ok(result.clonedResponse, "quality peek should replay both buffered chunks");

    streamController?.enqueue(textEncoder.encode("data: [DONE]\n\n"));
    streamController?.close();

    const text = await readWithTimeout(result.clonedResponse);
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /reasoning_content/);
    assert.match(text, /\[DONE\]/);
  });

  test("streaming quality peek waits past OpenAI-compatible finish-only chunks", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const finishOnlyChunk = `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\n`;

    const contentChunk = `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: "answer" }, finish_reason: null }],
    })}\n\n`;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(textEncoder.encode(finishOnlyChunk));
      },
    });

    const qualityPromise = validateResponseQuality(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      true,
      createLog()
    );

    const earlyResult = await Promise.race([
      qualityPromise.then(() => "released"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);

    assert.equal(earlyResult, "pending", "finish-only OpenAI chunk should not release");

    streamController?.enqueue(textEncoder.encode(contentChunk));

    const result = await Promise.race([
      qualityPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.notEqual(result, "timeout", "quality peek should release when content starts");
    assert.equal(result.valid, true);
    assert.ok(
      result.clonedResponse,
      "quality peek should replay buffered finish and content chunks"
    );

    streamController?.enqueue(textEncoder.encode("data: [DONE]\n\n"));
    streamController?.close();

    const text = await readWithTimeout(result.clonedResponse);
    assert.match(text, /finish_reason/);
    assert.match(text, /"content":"answer"/);
  });

  test("streaming quality peek waits past Responses lifecycle-only events", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const lifecycleEvent = [
      "event: response.created",
      `data: ${JSON.stringify({ response: { id: "resp_test" } })}`,
      "",
      "",
    ].join("\n");

    const textDeltaEvent = [
      "event: response.output_text.delta",
      `data: ${JSON.stringify({ delta: "visible" })}`,
      "",
      "",
    ].join("\n");

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(textEncoder.encode(lifecycleEvent));
      },
    });

    const qualityPromise = validateResponseQuality(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      true,
      createLog()
    );

    const earlyResult = await Promise.race([
      qualityPromise.then(() => "released"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);

    assert.equal(earlyResult, "pending", "response.created should not release quality peek");

    streamController?.enqueue(textEncoder.encode(textDeltaEvent));

    const result = await Promise.race([
      qualityPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.notEqual(result, "timeout", "quality peek should release on Responses text delta");
    assert.equal(result.valid, true);
    assert.ok(result.clonedResponse);

    streamController?.close();
    const text = await readWithTimeout(result.clonedResponse);
    assert.match(text, /response.created/);
    assert.match(text, /response.output_text.delta/);
  });

  test("streaming quality peek waits past Gemini finish-only candidates", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const finishOnlyChunk = `data: ${JSON.stringify({
      candidates: [{ finishReason: "STOP", content: { parts: [] } }],
    })}\n\n`;

    const textChunk = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: "gemini text" }] } }],
    })}\n\n`;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(textEncoder.encode(finishOnlyChunk));
      },
    });

    const qualityPromise = validateResponseQuality(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      true,
      createLog()
    );

    const earlyResult = await Promise.race([
      qualityPromise.then(() => "released"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);

    assert.equal(earlyResult, "pending", "finish-only Gemini candidate should not release");

    streamController?.enqueue(textEncoder.encode(textChunk));

    const result = await Promise.race([
      qualityPromise,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.notEqual(result, "timeout", "quality peek should release on Gemini text parts");
    assert.equal(result.valid, true);
    assert.ok(result.clonedResponse);

    streamController?.close();
    const text = await readWithTimeout(result.clonedResponse);
    assert.match(text, /gemini text/);
  });

  test("streaming quality peek parses legal multi-line SSE data before releasing", async () => {
    const payload = JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { reasoning_content: "split thinking" }, finish_reason: null }],
    });
    const splitAt = payload.indexOf('"choices"') - 1;
    assert.ok(splitAt > 0);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          textEncoder.encode(
            `data: ${payload.slice(0, splitAt)}\ndata: ${payload.slice(splitAt)}\n\n`
          )
        );
      },
    });

    const result = await Promise.race([
      validateResponseQuality(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
        true,
        createLog()
      ),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    assert.notEqual(result, "timeout", "quality peek should release on multi-line SSE reasoning");
    assert.equal(result.valid, true);
    assert.ok(result.clonedResponse);
  });

  test("streaming quality peek still rejects complete Claude lifecycle without content blocks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          textEncoder.encode(
            [
              `event: message_start`,
              `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1" } })}`,
              "",
              `event: message_delta`,
              `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "content_filter" } })}`,
              "",
              `event: message_stop`,
              `data: ${JSON.stringify({ type: "message_stop" })}`,
              "",
              "",
            ].join("\n")
          )
        );
        controller.close();
      },
    });

    const result = await validateResponseQuality(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      true,
      createLog()
    );

    assert.equal(result.valid, false);
    assert.equal(result.reason, "streaming empty content block");
  });

  test("combo falls back when first model returns HTTP 200 zombie SSE stream", async () => {
    const calls: string[] = [];
    const log = createLog();

    const result = await handleComboChat({
      body: {
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      combo: {
        name: "stream-readiness-504-fallback",
        strategy: "priority",
        models: [
          { model: "glm/zombie-model", weight: 0 },
          { model: "openai/gpt-5.4-mini", weight: 0 },
        ],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: any, modelStr: string) => {
        calls.push(modelStr);
        if (modelStr === "glm/zombie-model") {
          return applyStreamReadiness(zombieStreamResponse());
        }
        return okStreamResponse("fallback success");
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null as any,
    });

    assert.equal(result.ok, true, "combo should succeed via fallback after 504");
    assert.deepEqual(calls, ["glm/zombie-model", "openai/gpt-5.4-mini"]);
    assert.ok(
      log.entries.some(
        (e) => e.level === "warn" && e.tag === "COMBO" && String(e.msg).includes("glm/zombie-model")
      ),
      "combo should log warning for the failed model"
    );
  });

  test("combo fails when all models return 504", async () => {
    const calls: string[] = [];
    const log = createLog();

    const result = await handleComboChat({
      body: {
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      combo: {
        name: "all-504-test",
        strategy: "priority",
        models: [
          { model: "glm/zombie-a", weight: 0 },
          { model: "openai/gpt-5.4-mini", weight: 0 },
        ],
        config: { maxRetries: 0, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: any, modelStr: string) => {
        calls.push(modelStr);
        return applyStreamReadiness(zombieStreamResponse());
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null as any,
    });

    assert.ok(!result.ok, "combo should fail when all models return 504");
    assert.equal(result.status, 504);
    assert.deepEqual(calls, ["glm/zombie-a", "openai/gpt-5.4-mini"]);
  });

  test("combo retries 504 on same model before falling through (transient retry)", async () => {
    const calls: string[] = [];
    const log = createLog();

    const result = await handleComboChat({
      body: {
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      combo: {
        name: "retry-504-test",
        strategy: "priority",
        models: [
          { model: "glm/zombie", weight: 0 },
          { model: "openai/gpt-5.4-mini", weight: 0 },
        ],
        config: { maxRetries: 1, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: any, modelStr: string) => {
        calls.push(modelStr);
        if (modelStr === "glm/zombie") {
          return errorResponse(504, "Stream produced no useful content within 60000ms");
        }
        return okStreamResponse("fallback after retries");
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null as any,
    });

    assert.equal(result.ok, true, "combo should succeed via fallback after retries");
    const zombieCalls = calls.filter((c) => c === "glm/zombie");
    assert.equal(zombieCalls.length, 2, "combo should retry zombie once before falling through");
    assert.ok(calls.includes("openai/gpt-5.4-mini"), "combo should reach fallback model");
  });

  test("combo does not retry stream readiness timeouts on the same model", async () => {
    const calls: string[] = [];
    const log = createLog();

    const result = await handleComboChat({
      body: {
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      combo: {
        name: "no-retry-readiness-timeout-test",
        strategy: "priority",
        models: [
          { model: "glm/zombie", weight: 0 },
          { model: "openai/gpt-5.4-mini", weight: 0 },
        ],
        config: { maxRetries: 1, retryDelayMs: 0 },
      },
      handleSingleModel: async (_body: any, modelStr: string) => {
        calls.push(modelStr);
        if (modelStr === "glm/zombie") {
          return applyStreamReadiness(zombieStreamResponse());
        }
        return okStreamResponse("fallback without same-model retry");
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null as any,
    });

    assert.equal(result.ok, true, "combo should succeed via fallback");
    assert.deepEqual(calls, ["glm/zombie", "openai/gpt-5.4-mini"]);
  });
});

describe("combo-streaming-empty-completion-with-finish-reason-10404", () => {
  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  function sseStream(body: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  function makeEmptyButTerminatedOpenAiStream(): Response {
    const chunks = [
      JSON.stringify({
        id: "chatcmpl-10404",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "chatcmpl-10404",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 56447, completion_tokens: 0, total_tokens: 56447 },
      }),
    ];
    const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sseStream(body), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  function makeToolCallsOnlyOpenAiStream(): Response {
    const chunks = [
      JSON.stringify({
        id: "chatcmpl-10404-tool",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        id: "chatcmpl-10404-tool",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      JSON.stringify({
        id: "chatcmpl-10404-tool",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
      }),
    ];
    const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sseStream(body), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("#10404: OpenAI-shape stream that reaches finish_reason:stop with zero content/tool_calls/reasoning should fail over, not pass as valid", async () => {
    const res = makeEmptyButTerminatedOpenAiStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      false,
      "expected failover (valid:false) for a terminated-but-empty streaming completion"
    );
  });

  test("#10404 no-regression: OpenAI-shape stream carrying only tool_calls deltas + finish_reason:tool_calls must still pass as valid", async () => {
    const res = makeToolCallsOnlyOpenAiStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, true, "tool_calls-only streams must not be treated as empty");
  });
});

describe("combo-streaming-openai-no-finish-reason-7285", () => {
  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  function sseStream(body: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  // OpenAI-shape stream: single role-only delta chunk, then the connection
  // closes. No finish_reason anywhere, no `data: [DONE]` sentinel.
  function makeTruncatedOpenAiStream(): Response {
    const body = `data: ${JSON.stringify({
      id: "chatcmpl-test-truncated",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`;
    return new Response(sseStream(body), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  // Healthy OpenAI-shape stream: content delta + a chunk carrying
  // finish_reason: "stop" — must keep passing through (#3399/#3685 contract).
  function makeHealthyOpenAiStream(): Response {
    const chunks = [
      JSON.stringify({
        id: "chatcmpl-test-healthy",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null },
        ],
      }),
      JSON.stringify({
        id: "chatcmpl-test-healthy",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    ];
    const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sseStream(body), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("#7285 RED: OpenAI-shape stream with role-only delta and NO finish_reason should fail over but currently passes as valid", async () => {
    const res = makeTruncatedOpenAiStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, false, "expected failover (valid:false)");
  });

  test("#7285 control: a healthy OpenAI stream ending with finish_reason still passes through (#3399/#3685 no-regression)", async () => {
    const res = makeHealthyOpenAiStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, true, "expected valid:true for a properly terminated stream");
  });
});

describe("issue-13620-combo-reasoning-only-sse-burst", () => {
  /**
   * Issue #13620 — combo quality-gate bounded peek buffers bare `delta.reasoning`
   * SSE chunks (Ollama Cloud shape) because `hasOpenAICompatibleStreamValue()`
   * (open-sse/utils/streamHelpers.ts) only recognizes `content`,
   * `reasoning_content`, `reasoning_text`, and `tool_calls` — not bare
   * `reasoning`. As a result the peek loop never exits on a reasoning-only
   * chunk and keeps buffering every reasoning delta until the first real
   * `content` delta arrives (client sees dead silence, then a single burst),
   * and a stream that finishes with reasoning-only content is rejected as an
   * "empty completion" (secondary 502 failure mode).
   */
  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  test("#13620 root cause: isKnownNonClaudeStreamPayload must recognize bare delta.reasoning (Ollama Cloud shape)", () => {
    const parsed = {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "", reasoning: "We" },
          finish_reason: null,
        },
      ],
    };
    const recognized = isKnownNonClaudeStreamPayload(parsed);
    assert.equal(
      recognized,
      true,
      "bare delta.reasoning must be recognized as stream content so the combo peek stops buffering immediately, " +
        "matching hasValuableContent()/hasAnyReasoningSignal() which already treat it as real signal"
    );
  });

  // Emits ONE physical Uint8Array chunk per SSE frame (mirrors real network
  // framing, unlike a single enqueue() of the whole body) and counts how many
  // chunks the underlying stream has handed out by the time the caller stops
  // reading — this is what actually distinguishes "peek recognizes the first
  // reasoning delta and stops buffering there" from "peek keeps consuming
  // (buffering) every reasoning chunk until the content chunk arrives".
  function makeReasoningOnlyThenContentStream(): {
    response: Response;
    chunksPulled: { count: number };
  } {
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: "We" } }] },
      { choices: [{ index: 0, delta: { content: "", reasoning: " need" } }] },
      { choices: [{ index: 0, delta: { content: "", reasoning: " to think." } }] },
      { choices: [{ index: 0, delta: { content: "Hello" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ].map((c) => encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    frames.push(encoder.encode("data: [DONE]\n\n"));

    const chunksPulled = { count: 0 };
    let idx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(frames[idx++]);
        chunksPulled.count = idx;
      },
    });
    return {
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      chunksPulled,
    };
  }

  test("#13620 behavioral: peek must stop buffering at the first reasoning delta, not wait for content", async () => {
    const { response, chunksPulled } = makeReasoningOnlyThenContentStream();
    const out = await validateResponseQuality(response, true, silentLog);
    assert.equal(out.valid, true, `expected valid, got reason: ${out.reason}`);
    assert.ok(out.clonedResponse, "expected a clonedResponse to replay/forward the stream");

    // Frame indices: 0-2 = reasoning-only deltas, 3 = content, 4 = finish_reason, 5 = [DONE].
    // Correct: the peek recognizes frame 0 immediately via a single reader.read() call.
    // The WHATWG ReadableStream spec itself speculatively pulls one extra chunk into its
    // internal queue right after that read() resolves (default highWaterMark backpressure
    // refill) — so up to 2 physical chunks may be pulled even when the peek loop performs
    // exactly one logical read. That prefetch is unavoidable engine behavior, not something
    // validateResponseQuality controls, so the threshold below allows for it.
    // Bug: the peek loop itself keeps calling reader.read() through frames 0-2 (each
    // triggering its own follow-up prefetch), only stopping at frame 3 -> 4-5 chunks pulled.
    assert.ok(
      chunksPulled.count <= 2,
      "expected the peek to stop after at most 1 logical read (<=2 chunks pulled, accounting for " +
        `ReadableStream's own one-chunk-ahead prefetch); actual: ${chunksPulled.count} chunks were ` +
        "pulled before the peek recognized any content — this is the reasoning-prefix burst-buffering bug"
    );
  });

  function makeReasoningOnlyTerminatedStream(): Response {
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", reasoning: "Deep" } }] },
      { choices: [{ index: 0, delta: { reasoning: " thinking..." } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
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

  test("#13620 secondary failure mode: reasoning-only stream that terminates cleanly must not be rejected as an empty completion", async () => {
    const res = makeReasoningOnlyTerminatedStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      true,
      `expected valid (reasoning-only is real output, mirrors the non-streaming validator's ` +
        `reasoning_content ?? reasoning acceptance) — got reason: ${out.reason}`
    );
  });
});

describe("combo-streaming-empty-content-failover", () => {
  /**
   * Issue #3685 — streaming combos must fail over to the next target when the
   * upstream Claude stream emits a complete lifecycle (message_start →
   * message_delta with stop_reason → message_stop) but ZERO content_block_*
   * events (e.g. content_filter). Previously `validateResponseQuality` returned
   * `{ valid: true }` for ALL streaming responses, so the combo loop never saw
   * the empty response as a failure and never advanced to the next target.
   */
  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  /** Build a ReadableStream from an array of SSE-formatted strings (single chunk). */
  function claudeSseStream(events: string[]): ReadableStream<Uint8Array> {
    const body = events.join("\n") + "\n";
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  /**
   * Build a ReadableStream that emits each SSE event as a SEPARATE chunk,
   * simulating a real incremental network delivery.
   */
  function claudeSseStreamMultiChunk(events: string[]): ReadableStream<Uint8Array> {
    const chunks = events.map((e) => encoder.encode(e + "\n"));
    let idx = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < chunks.length) {
          controller.enqueue(chunks[idx++]);
        } else {
          controller.close();
        }
      },
    });
  }

  /** Build a mock Claude 200 streaming response with no content blocks (content_filter case). */
  function makeEmptyClaudeStream(): Response {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test_empty",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "content_filter", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ];

    return new Response(claudeSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  /** Build a mock Claude 200 streaming response WITH a content block (normal case). */
  function makeNonEmptyClaudeStream(): Response {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test_content",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello, world!" },
      })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 5 },
      })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ];

    return new Response(claudeSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  test("#3685 empty Claude stream (content_filter, no content blocks) is marked invalid", async () => {
    const res = makeEmptyClaudeStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      false,
      `expected invalid for empty content-filtered stream, got valid=true (reason: ${out.reason})`
    );
    assert.match(out.reason ?? "", /empty/i, `reason should mention 'empty', got: "${out.reason}"`);
  });

  test("#3685 non-empty Claude stream (has content blocks) remains valid", async () => {
    const res = makeNonEmptyClaudeStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      true,
      `expected valid for non-empty stream, got invalid: ${out.reason}`
    );
    // The clonedResponse must be present so the combo loop can pipe the stream body
    assert.ok(out.clonedResponse, "clonedResponse must be returned for valid streaming response");
    assert.ok(out.clonedResponse!.body, "clonedResponse must have a body stream");
  });

  test("#3685 non-SSE streaming response (e.g. plain JSON 200) still passes through as valid", async () => {
    // A streaming=true call that returns plain JSON is not our target — preserve existing behavior.
    const res = new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, true, "non-SSE streaming response should still be valid");
  });

  test("#3685 empty Claude stream without message_start lifecycle → valid (incomplete lifecycle, not content_filter)", async () => {
    // A stream that only has partial events (e.g. disconnected before message_start)
    // should not trigger the failover since the lifecycle isn't complete — this is
    // handled by other mechanisms (stream readiness timeout).
    const partialEvents = [`event: ping\ndata: ${JSON.stringify({ type: "ping" })}`, ""];
    const res = new Response(claudeSseStream(partialEvents), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, true, "incomplete lifecycle (no message_start) should pass through");
  });

  test("#3685 streaming is preserved for non-empty response: clonedResponse body yields full original SSE byte sequence in order", async () => {
    // Use a multi-chunk stream to simulate real incremental delivery.
    // The content_block_start arrives in its own chunk so the peek loop can
    // detect it mid-stream and stop buffering — the rest should forward via
    // the original reader.
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_multipart",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      })}`,
      "",
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ", world!" },
      })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 7 },
      })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ];

    // Build the original byte sequence for comparison.
    const originalBody = events.map((e) => e + "\n").join("");
    const originalBytes = encoder.encode(originalBody);

    const res = new Response(claudeSseStreamMultiChunk(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const out = await validateResponseQuality(res, true, silentLog);

    assert.equal(out.valid, true, "non-empty multi-chunk stream must be valid");
    assert.ok(out.clonedResponse, "clonedResponse must be present");
    assert.ok(out.clonedResponse!.body, "clonedResponse must have a readable body");

    // Drain the clonedResponse body and reconstruct the full byte sequence.
    const reader = out.clonedResponse!.body!.getReader();
    const receivedChunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedChunks.push(value);
    }
    const totalLength = receivedChunks.reduce((sum, c) => sum + c.length, 0);
    const reconstructed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of receivedChunks) {
      reconstructed.set(chunk, offset);
      offset += chunk.length;
    }

    // The reconstructed bytes must exactly match the original SSE byte sequence —
    // no data is lost, duplicated, or reordered by the bounded-peek mechanism.
    assert.deepEqual(
      reconstructed,
      originalBytes,
      "clonedResponse body must reproduce the FULL original SSE byte sequence (buffered prefix + piped remainder = original)"
    );

    // Verify the response carries SSE content blocks in the decoded text,
    // confirming real content was streamed through.
    const decoded = new TextDecoder().decode(reconstructed);
    assert.ok(
      decoded.includes("content_block_start"),
      "decoded body must contain content_block_start"
    );
    assert.ok(decoded.includes("Hello"), "decoded body must contain the actual text content");
    assert.ok(decoded.includes(", world!"), "decoded body must contain the full text delta");
  });

  /** Full Claude lifecycle with ZERO content blocks and a given stop_reason. */
  function makeEmptyLifecycleStream(stopReason: string | null): Response {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test_empty_turn",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ];

    return new Response(claudeSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  /** Full lifecycle with one text block that never carries a delta (#1382 shape). */
  function makeEmptyTextBlockStream(): Response {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test_empty_block",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ];

    return new Response(claudeSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("trusted first-party Claude end_turn with zero content blocks is valid (#15488 combo path)", async () => {
    const res = makeEmptyLifecycleStream("end_turn");
    const out = await validateResponseQuality(res, true, silentLog, null, null, true);
    assert.equal(out.valid, true, `expected valid for empty end_turn stream, got: ${out.reason}`);
    assert.ok(out.clonedResponse, "clonedResponse must be returned for the trusted empty stream");
    const text = await out.clonedResponse!.text();
    assert.ok(text.includes("message_stop"), "clonedResponse must replay the full SSE bytes");
  });

  test("trusted first-party Claude stop_sequence with zero content blocks is valid", async () => {
    const res = makeEmptyLifecycleStream("stop_sequence");
    const out = await validateResponseQuality(res, true, silentLog, null, null, true);
    assert.equal(
      out.valid,
      true,
      `expected valid for empty stop_sequence stream, got: ${out.reason}`
    );
  });

  test("trusted provider content_filter stop stays invalid", async () => {
    const res = makeEmptyLifecycleStream("content_filter");
    const out = await validateResponseQuality(res, true, silentLog, null, null, true);
    assert.equal(
      out.valid,
      false,
      "content_filter must still trigger failover for trusted provider"
    );
  });

  test("untrusted by default: end_turn with zero content blocks stays invalid", async () => {
    const res = makeEmptyLifecycleStream("end_turn");
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      false,
      "without an explicit trusted connection the guard must not be relaxed"
    );
  });

  test("explicitly untrusted connection end_turn with zero content blocks stays invalid", async () => {
    const res = makeEmptyLifecycleStream("end_turn");
    const out = await validateResponseQuality(res, true, silentLog, null, null, false);
    assert.equal(out.valid, false, "third-party Claude-compatible gateways keep the guard");
  });

  test("trusted provider empty text block pair (#1382 shape) stays invalid", async () => {
    const res = makeEmptyTextBlockStream();
    const out = await validateResponseQuality(res, true, silentLog, null, null, true);
    assert.equal(out.valid, false, "an opened-and-closed empty block is not a normal empty answer");
  });

  test("trusted provider lifecycle without message_stop stays invalid", async () => {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test_no_stop",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      })}`,
      "",
    ];
    const res = new Response(claudeSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog, null, null, true);
    assert.equal(
      out.valid,
      false,
      "incomplete lifecycle (no message_stop) must not be treated as a normal empty answer"
    );
  });

  test("#5976 truly EMPTY streaming body (zero bytes) → invalid for combo failover", async () => {
    // A 200 SSE response whose body closes without emitting a single byte
    // (e.g. Gemini returning HTTP 200 with an empty body) cannot carry content —
    // fail over to the sibling model. Streams with ANY SSE activity (an explicit
    // [DONE], ping/metadata events) keep the pass-through contract (#3399/#3685).
    const emptyBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const res = new Response(emptyBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, false, "zero-byte streaming body must trigger failover");
    assert.equal(out.reason, "streaming no recognized content");
  });
});

describe("cursor-empty-turn-failover-v9", () => {
  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  function sseStream(body: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  // ─── wire-format helpers (mirror the encoder's primitives) ──────────────────

  function v(n: number): Buffer {
    const out: number[] = [];
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
    return Buffer.from(out);
  }
  function tag(field: number, wireType: number): Buffer {
    return v((field << 3) | wireType);
  }
  function lenPrefixed(field: number, payload: Buffer): Buffer {
    return Buffer.concat([tag(field, 2), v(payload.length), payload]);
  }
  // ASM { interaction_update (1): { turn_ended (14): {} } }
  function buildTurnEndedPayload(): Buffer {
    const iu = lenPrefixed(14, Buffer.alloc(0));
    return lenPrefixed(1, iu);
  }
  // ASM { interaction_update (1): { text_delta (1): { text (1): str } } }
  function buildTextDeltaPayload(text: string): Buffer {
    const tdu = lenPrefixed(1, Buffer.from(text, "utf8"));
    const iu = lenPrefixed(1, tdu);
    return lenPrefixed(1, iu);
  }
  // ASM { interaction_update (1): { token_delta (8): { count (1): n } } }
  function buildTokenDeltaPayload(tokens: number): Buffer {
    const tokDelta = Buffer.concat([tag(1, 0), v(tokens)]);
    const iu = lenPrefixed(8, tokDelta);
    return lenPrefixed(1, iu);
  }

  // ─── the exact fabricated-empty shape the executor emits today ──────────────
  // This is byte-for-byte what finalizeSseStream produces for a turn that
  // decoded zero frames of signal: a synthetic role chunk, finish_reason:"stop",
  // then [DONE]. Pre-v9 this shape passed the combo peek as {valid:true} and
  // the client received a clean 200 with zero content.

  // Retained as documentation of the exact wire shape this regression covers; the
  // chain tests below build the stream inline. Underscore-prefixed to satisfy the
  // repo's no-unused-vars convention (unused in the upstream commit too).
  function _makeFabricatedEmptyCursorResponse(): Response {
    const chunks = [
      JSON.stringify({
        id: "chatcmpl-cursor-fabricated-empty",
        object: "chat.completion.chunk",
        model: "cursor/cursor-grok-4.6-high",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "chatcmpl-cursor-fabricated-empty",
        object: "chat.completion.chunk",
        model: "cursor/cursor-grok-4.6-high",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    ];
    const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sseStream(body), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("v9 RED: ctx with turn_ended but zero signal reports no produced signal", () => {
    // A turn that ONLY saw turn_ended — the live grok-4.6 masked-empty case.
    const ctx = newStreamCtx("cursor/cursor-grok-4.6-high", () => {});
    processFrame(buildTurnEndedPayload(), ctx, new Set());
    assert.equal(ctx.endReason, "turn_ended");
    assert.equal(ctxProducedSignal(ctx), false, "turn_ended alone is not usable signal");
  });

  test("v9 control: ctx with text signal reports produced signal", () => {
    const ctx = newStreamCtx("cursor/cursor-grok-4.6-high", () => {});
    processFrame(buildTextDeltaPayload("answer"), ctx, new Set());
    processFrame(buildTurnEndedPayload(), ctx, new Set());
    assert.equal(ctxProducedSignal(ctx), true);
  });

  test("v9 control: ctx with only tokenDelta reports produced signal", () => {
    const ctx = newStreamCtx("cursor/cursor-grok-4.6-high", () => {});
    processFrame(buildTokenDeltaPayload(7), ctx, new Set());
    processFrame(buildTurnEndedPayload(), ctx, new Set());
    assert.equal(ctxProducedSignal(ctx), true);
  });

  test("v9 chain: fabricated-empty cursor stream now fails combo validation (regression: used to pass)", async () => {
    // The peek can no longer be relied on to distinguish — the executor now
    // errors the stream instead of fabricating this shape, so the peek sees a
    // stream error with no content and applies the v8 dead-before-token gate.
    // This test documents the chain: the peek's catch treats a stream error
    // before any content/terminator as invalid. Simulate the post-v9 executor
    // output directly: an erroring stream.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("cursor-agent completed turn with no usable content"));
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, false, "executor-erroring empty stream must fail over");
    assert.match(out.reason ?? "", /no usable content|aborted before content/);
  });

  test("v9: a tool call with blank arguments is an empty turn", () => {
    const ctx = newStreamCtx("cursor/cursor-grok-4.6-high", () => {});
    ctx.toolCalls.push({ id: "call_blank", name: "shell", argumentsJson: "  " });
    ctx.endReason = "tool_calls";
    assert.equal(ctxProducedSignal(ctx), false);
    assert.equal(isCursorEmptyTurn(ctx), true);
  });

  test("v9: a tool call with arguments is usable signal", () => {
    const ctx = newStreamCtx("cursor/cursor-grok-4.6-high", () => {});
    ctx.toolCalls.push({ id: "call_ok", name: "shell", argumentsJson: "{}" });
    ctx.endReason = "tool_calls";
    assert.equal(ctxProducedSignal(ctx), true);
    assert.equal(isCursorEmptyTurn(ctx), false);
  });

  test("v9: embedded tool_result XML is extracted and role:tool is left to the resume loop", () => {
    const found = extractEmbeddedCursorToolResults([
      {
        role: "tool",
        content:
          "<tool_result>\n<tool_call_id>skip-role-tool</tool_call_id>\n<result>nope</result>\n</tool_result>",
      },
      {
        role: "user",
        content:
          "see <tool_result>\n<tool_name>shell</tool_name>\n<tool_call_id>call_abc</tool_call_id>\n<result>a &amp; b</result>\n</tool_result>",
      },
    ]);
    assert.deepEqual(found, [{ toolCallId: "call_abc", result: "a & b" }]);
  });

  test("v9 chain: a generic pre-content read error still passes validation", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("network reset"));
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, true);
  });

  test("v9 chain: healthy cursor stream with real content still passes validation", async () => {
    const chunks = [
      JSON.stringify({
        id: "chatcmpl-cursor-healthy",
        object: "chat.completion.chunk",
        model: "cursor/cursor-grok-4.6-high",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Working on it" }, finish_reason: null },
        ],
      }),
      JSON.stringify({
        id: "chatcmpl-cursor-healthy",
        object: "chat.completion.chunk",
        model: "cursor/cursor-grok-4.6-high",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    ];
    const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
    const res = new Response(sseStream(body), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, true);
  });
});

describe("quality-validation-benign-error", () => {
  /**
   * TDD regression guard — quality validation false-positive on benign `error`
   * fields in streaming SSE chunks.
   *
   * `isStreamingUpstreamError` treats ANY non-null `error` field as an upstream
   * failure: `parsed.error != null` is true for `{}`, `""`, `false`, and `0`.
   * When a client like opencode issues a tool-call turn, the upstream SSE opens
   * with role-only frames (no recognized content) and a later chunk that carries
   * real tool_calls content PLUS a benign empty `error` field (a field some
   * backends emit on every chunk). The error gate runs BEFORE the content
   * recognizers, so that single frame short-circuits to "error" → 502
   * "streaming upstream error" — while the same combo via kilocode (different
   * wire format) never emits the empty `error` field and works fine.
   */
  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  function openAiSseStream(events: string[]): ReadableStream<Uint8Array> {
    const body = events.join("\n") + "\n";
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  /**
   * OpenAI-compatible tool-call stream that ALSO carries a benign empty `error`
   * field on the tool_calls chunk. Some backends emit `"error": {}` or
   * `"error": ""` alongside every chunk; that is not a real upstream failure.
   * The frame must be treated as CONTENT (valid), not ERROR.
   */
  function makeToolCallStreamWithBenignError(): Response {
    const events = [
      // role-only first chunk — no recognized content, widens the peek window
      `data: ${JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 123,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}`,
      "",
      // tool_calls delta + benign empty `error` field (the bug trigger)
      `data: ${JSON.stringify({
        id: "chatcmpl_2",
        object: "chat.completion.chunk",
        created: 123,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        error: {},
      })}`,
      "",
      `data: [DONE]`,
      "",
    ];
    return new Response(openAiSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("OpenAI stream with tool_calls + benign empty error:{} field is VALID (not 502)", async () => {
    const res = makeToolCallStreamWithBenignError();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      true,
      `expected valid for tool_calls chunk with benign error:{}, got valid=false (reason: ${out.reason})`
    );
    assert.ok(out.clonedResponse, "clonedResponse must be present for valid streaming response");
  });

  test("OpenAI stream with tool_calls + benign empty error:'' field is VALID", async () => {
    const events = [
      `data: ${JSON.stringify({
        id: "chatcmpl_3",
        object: "chat.completion.chunk",
        created: 123,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl_4",
        object: "chat.completion.chunk",
        created: 123,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_2",
                  type: "function",
                  function: { name: "Read", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        error: "",
      })}`,
      "",
      `data: [DONE]`,
      "",
    ];
    const res = new Response(openAiSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      true,
      `expected valid for tool_calls chunk with benign error:"", got valid=false (reason: ${out.reason})`
    );
  });

  test("Stream with a REAL non-empty error object is still flagged as invalid", async () => {
    const events = [
      `data: ${JSON.stringify({
        id: "chatcmpl_5",
        object: "chat.completion.chunk",
        created: 123,
        model: "gpt-4o",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl_6",
        object: "chat.completion.chunk",
        created: 123,
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        error: { message: "upstream quota exceeded", code: "rate_limit_exceeded" },
      })}`,
      "",
      `data: [DONE]`,
      "",
    ];
    const res = new Response(openAiSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      false,
      `expected invalid for real error object, got valid=true (reason: ${out.reason})`
    );
    assert.match(
      out.reason ?? "",
      /streaming upstream error/,
      "reason should mention the upstream error"
    );
  });
});

describe("streaming-empty-content-block-1382", () => {
  /**
   * Issue #1382 (upstream decolua/9router) — a streaming Claude response that
   * opens a `content_block_start` (type "text", initial text "") and then
   * immediately `content_block_stop`s WITHOUT ever emitting a
   * `content_block_delta` carrying real text/tool_use content must be treated
   * as an empty/malformed response, not a valid completion.
   *
   * Before this fix, `validateResponseQuality`'s bounded SSE peek stopped
   * buffering (and reported `valid: true`) as soon as ANY content_block_*
   * event was observed — including a content_block_start whose block never
   * carries usable text. Tool-heavy requests against backends that mishandle
   * tool definitions (reported: DeepSeek, GLM via claude→openai translation)
   * can emit exactly this shape: a lifecycle that "completes" successfully at
   * the transport layer while the client receives no usable content. The
   * combo loop never saw this as a failure, so no failover to the next model
   * in the combo ever happened.
   */
  const encoder = new TextEncoder();
  const silentLog = { warn: () => {} };

  function claudeSseStream(events: string[]): ReadableStream<Uint8Array> {
    const body = events.join("\n") + "\n";
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
  }

  /**
   * Build a mock Claude 200 streaming response with a content_block_start/stop
   * pair carrying EMPTY text and no tool_use block — the shape reported in
   * #1382 for tool-heavy claude→openai requests against DeepSeek/GLM.
   */
  function makeEmptyTextBlockStream(): Response {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test_1382",
          type: "message",
          role: "assistant",
          model: "deepseek-v4-pro-max",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 19882, output_tokens: 0 },
        },
      })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 25 },
      })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ];

    return new Response(claudeSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("#1382 streaming Claude response with empty content_block (no text, no tool_use) is marked invalid", async () => {
    const res = makeEmptyTextBlockStream();
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(
      out.valid,
      false,
      `expected invalid for empty content_block stream, got valid=true (reason: ${out.reason})`
    );
    assert.match(out.reason ?? "", /empty/i, `reason should mention 'empty', got: "${out.reason}"`);
  });

  test("#1382 streaming Claude response with a real tool_use content_block_start remains valid", async () => {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_test_1382_tool",
          type: "message",
          role: "assistant",
          model: "deepseek-v4-pro-max",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      })}`,
      "",
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      })}`,
      "",
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}`,
      "",
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 12 },
      })}`,
      "",
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ];
    const res = new Response(claudeSseStream(events), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const out = await validateResponseQuality(res, true, silentLog);
    assert.equal(out.valid, true, `expected valid for tool_use stream, got invalid: ${out.reason}`);
    assert.ok(out.clonedResponse, "clonedResponse must be present for valid streaming response");
  });
});

describe("combo-retry-cut-stream", () => {
  /**
   * #18460 follow-up — a non-streaming combo attempt whose upstream stream was cut before
   * its terminal signal must fail over to the next target.
   *
   * #18460 reports a cut buffered stream as `finish_reason: "length"` with the partial
   * content. The combo quality check accepts a non-empty `length` body, so a combo returned
   * the partial answer of its first target instead of trying the next one. A cut is not a
   * model-side `length` (`max_tokens`): it is an attempt that failed in transit.
   *
   * Contract now:
   * - the buffered-SSE parsers tag their cut verdict on the parsed body (internal WeakSet,
   *   never serialized), `parseNonStreamingResponseBody` carries it onto the upstream
   *   Response, and `inheritEmptyTurnPolicy` carries it onto the wrapper chatCore returns;
   * - a non-streaming combo attempt with that tag is a retryable target failure: the combo
   *   tries the next target, and only when every target is cut returns the last partial
   *   result (`length`), as before;
   * - a genuine upstream `length` (`finish_reason: "length"`, `stop_reason: "max_tokens"`,
   *   `response.incomplete`, Gemini `MAX_TOKENS`) is never tagged and is returned as-is;
   * - the cut attempt trips neither the provider circuit breaker nor a model lockout.
   */

  /** The Response-level marker module (new in this fix); `{}` while it does not exist. */
  async function loadPolicy(): Promise<{
    isTruncatedStreamResponse?: (response: Response) => boolean;
  }> {
    try {
      return await import("../../../open-sse/utils/truncatedStreamPolicy.ts");
    } catch {
      return {};
    }
  }

  const isTruncatedStreamBody = (body: unknown): boolean => {
    const fn = (truncation as { isTruncatedStreamBody?: (b: unknown) => boolean })
      .isTruncatedStreamBody;
    assert.equal(typeof fn, "function", "truncation.ts must export isTruncatedStreamBody");
    return fn!(body);
  };

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  beforeEach(() => clearAllModelLockouts());

  // ── Fixtures ────────────────────────────────────────────────────────────────────
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const named = (event: string, value: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    data({ id: "c", model: "m", choices: [{ index: 0, delta, finish_reason: finishReason }] });

  const openAiCut = (text: string) => chunk({ role: "assistant", content: text });
  const openAiGenuineLength = (text: string) =>
    openAiCut(text) + chunk({}, "length") + "data: [DONE]\n\n";

  const CLAUDE_HEAD =
    named("message_start", {
      type: "message_start",
      message: { id: "msg", model: "claude-sonnet-4-6", role: "assistant", usage: {} },
    }) +
    named("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    named("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    });
  const RESPONSES_HEAD =
    data({
      type: "response.created",
      response: { id: "resp", model: "gpt-5.3-codex", status: "in_progress", output: [] },
    }) +
    data({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    });
  const GEMINI_HEAD = data({
    response: { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
  });

  /**
   * What chatCore hands the combo for a buffered (stream:false) upstream: the SSE body is
   * parsed by `parseNonStreamingResponseBody`, and the client JSON is wrapped with
   * `inheritEmptyTurnPolicy(providerResponse, …)` (nonStreamingResponse.ts).
   */
  async function chatCoreNonStreamingResult(sse: string): Promise<Response> {
    const upstream = new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const parsed = await parseNonStreamingResponseBody({
      providerResponse: upstream,
      upstreamStream: false,
      providerHeaders: null,
      finalBody: null,
      targetFormat: "openai",
      model: "m",
    });
    assert.equal(parsed.kind, "ok");
    if (parsed.kind !== "ok") throw new Error("unreachable");
    return inheritEmptyTurnPolicy(
      upstream,
      new Response(JSON.stringify(parsed.responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
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
            message: { role: "assistant", content: "full answer" },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const combo = (models: string[]) => ({
    name: "combo-cut-stream",
    strategy: "priority",
    models: models.map((model) => ({ model })),
  });

  async function runCombo(
    models: string[],
    respond: (modelStr: string, call: number) => Promise<Response> | Response,
    stream = false
  ) {
    const called: string[] = [];
    const result = await handleComboChat({
      body: { model: "combo-cut-stream", stream, messages: [{ role: "user", content: "hi" }] },
      combo: combo(models),
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        called.push(modelStr);
        return respond(modelStr, called.length);
      },
      log,
      settings: {},
      allCombos: [],
    });
    return { result, called };
  }

  type ChatJson = { choices: Array<{ message: { content: string }; finish_reason: string }> };

  // ── Parser verdict tag: cut vs genuine length ───────────────────────────────────
  test("parsers tag a cut stream, never a genuine upstream length", () => {
    assert.equal(isTruncatedStreamBody(parseSSEToOpenAIResponse(openAiCut("partial"), "m")), true);
    assert.equal(
      isTruncatedStreamBody(parseSSEToOpenAIResponse(openAiGenuineLength("partial"), "m")),
      false
    );

    assert.equal(isTruncatedStreamBody(parseSSEToClaudeResponse(CLAUDE_HEAD, "m")), true);
    const claudeMaxTokens =
      CLAUDE_HEAD +
      named("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 1 },
      }) +
      named("message_stop", { type: "message_stop" });
    assert.equal(isTruncatedStreamBody(parseSSEToClaudeResponse(claudeMaxTokens, "m")), false);

    assert.equal(isTruncatedStreamBody(parseSSEToResponsesOutput(RESPONSES_HEAD, "m")), true);
    const responsesIncomplete =
      RESPONSES_HEAD +
      data({
        type: "response.incomplete",
        response: {
          id: "resp",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
      });
    assert.equal(isTruncatedStreamBody(parseSSEToResponsesOutput(responsesIncomplete, "m")), false);

    assert.equal(isTruncatedStreamBody(parseSSEToGeminiResponse(GEMINI_HEAD, "m")), true);
    const geminiMaxTokens =
      GEMINI_HEAD + data({ response: { candidates: [{ finishReason: "MAX_TOKENS" }] } });
    assert.equal(isTruncatedStreamBody(parseSSEToGeminiResponse(geminiMaxTokens, "m")), false);
  });

  test("the cut verdict rides the Response chain and never reaches the client body", async () => {
    const { isTruncatedStreamResponse } = await loadPolicy();
    assert.equal(typeof isTruncatedStreamResponse, "function");

    const cut = await chatCoreNonStreamingResult(openAiCut("partial"));
    assert.equal(isTruncatedStreamResponse!(cut), true);
    // chat.ts wrappers (withSelectedConnectionHeader fallback) copy it too.
    assert.equal(
      isTruncatedStreamResponse!(inheritResponsePolicies(cut, new Response("{}"))),
      true
    );
    const json = (await cut.clone().json()) as ChatJson & Record<string, unknown>;
    assert.deepEqual(Object.keys(json).sort(), ["choices", "created", "id", "model", "object"]);

    const genuine = await chatCoreNonStreamingResult(openAiGenuineLength("partial"));
    assert.equal(isTruncatedStreamResponse!(genuine), false);
  });

  // ── Combo behaviour ─────────────────────────────────────────────────────────────
  test("combo: a target whose stream was cut fails over to the next target", async () => {
    const { result, called } = await runCombo(
      ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-6"],
      async (modelStr, call) =>
        call === 1 ? chatCoreNonStreamingResult(openAiCut("partial")) : healthy200(modelStr)
    );
    assert.deepEqual(called, ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-6"]);
    assert.equal(result.status, 200);
    const json = (await result.json()) as ChatJson;
    assert.equal(json.choices[0].message.content, "full answer");
    assert.equal(json.choices[0].finish_reason, "stop");
  });

  test("combo: a genuine upstream length is a success and is not retried", async () => {
    const { result, called } = await runCombo(
      ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-6"],
      async (modelStr, call) =>
        call === 1
          ? chatCoreNonStreamingResult(openAiGenuineLength("budget hit"))
          : healthy200(modelStr)
    );
    assert.deepEqual(called, ["openai/gpt-4o-mini"]);
    const json = (await result.json()) as ChatJson;
    assert.equal(json.choices[0].message.content, "budget hit");
    assert.equal(json.choices[0].finish_reason, "length");
  });

  test("combo: when every target is cut, the last partial result is returned with length", async () => {
    const { result, called } = await runCombo(
      ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-6"],
      async (_modelStr, call) => chatCoreNonStreamingResult(openAiCut(`partial ${call}`))
    );
    assert.equal(called.length, 2);
    assert.equal(result.status, 200);
    const json = (await result.json()) as ChatJson;
    assert.equal(json.choices[0].message.content, "partial 2");
    assert.equal(json.choices[0].finish_reason, "length");
  });

  test("combo: a cut target followed by a failing target still returns the partial result", async () => {
    const { result, called } = await runCombo(
      ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4-6"],
      async (_modelStr, call) =>
        call === 1
          ? chatCoreNonStreamingResult(openAiCut("partial"))
          : new Response(JSON.stringify({ error: { message: "upstream down" } }), {
              status: 503,
              headers: { "Content-Type": "application/json" },
            })
    );
    // The 503 target may be retried by the combo's own retry policy; the cut one is not.
    assert.equal(called[0], "openai/gpt-4o-mini");
    assert.ok(called.length >= 2);
    assert.ok(called.slice(1).every((model) => model === "anthropic/claude-sonnet-4-6"));
    assert.equal(result.status, 200);
    const json = (await result.json()) as ChatJson;
    assert.equal(json.choices[0].message.content, "partial");
    assert.equal(json.choices[0].finish_reason, "length");
  });

  test("combo: a cut attempt trips neither the provider breaker nor a model lockout", async () => {
    const provider = "cutstreamprov";
    const before = getCircuitBreaker(provider).getStatus();
    await runCombo(
      [`${provider}/model-a`, "anthropic/claude-sonnet-4-6"],
      async (modelStr, call) =>
        call === 1 ? chatCoreNonStreamingResult(openAiCut("partial")) : healthy200(modelStr)
    );
    const after = getCircuitBreaker(provider).getStatus();
    assert.equal(after.state, "CLOSED");
    assert.equal(after.failureCount, before.failureCount);
    assert.equal(
      getAllModelLockouts().some((entry) => JSON.stringify(entry).includes("model-a")),
      false
    );
  });
});
