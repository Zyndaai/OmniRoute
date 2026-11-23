// Round-robin, session-stickiness and cooling-pool tests around handleComboChat: RR pointer
// and fallback advance, #3825/#7270 session pins, strict-random fallback spread, live-event
// publishing, local provider refusals and the weighted all-targets-cooling-down 503. Merged
// from eleven files so combo.ts loads once; each original file is one `describe` below, named
// after the file it came from.
import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IsModelAvailable } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-rr-stickiness-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../../src/lib/modelsDevSync.ts");
const { getComboMetrics, resetAllComboMetrics } =
  await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers, getCircuitBreaker } =
  await import("../../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../../open-sse/services/rateLimitSemaphore.ts");
const rrState = await import("../../../open-sse/services/combo/rrState.ts");
const { weightedStickyTargets, rrCounters, rrStickyTargets } = rrState;
const stick = await import("../../../open-sse/services/combo/sessionStickiness.ts");
const { clearSessions } = await import("../../../open-sse/services/sessionManager.ts");
const { _resetAllDecks } = await import("../../../src/shared/utils/shuffleDeck.ts");
const eventBus = await import("../../../src/lib/events/eventBus.ts");
const { recordModelLockoutFailure, clearAllModelLockouts } =
  await import("../../../open-sse/services/accountFallback.ts");

after(() => {
  try {
    core.resetDbInstance();
  } catch {
    /* ignore */
  }
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-round-robin-streaming-lock-3811", () => {
  /**
   * Issue #3811 — a round-robin combo serving a STREAMING response returned a 500
   * (`TypeError: Invalid state: The ReadableStream is locked`, ERR_INVALID_STATE).
   *
   * validateResponseQuality() peeks streaming bodies via `response.body.getReader()`
   * to detect empty/content-filtered streams. That call LOCKS `result.body` and hands
   * back an unlocked replay stream in `quality.clonedResponse`. The priority strategy
   * returns `quality.clonedResponse ?? result`, but the round-robin success path
   * returned the original (now-locked) `result`, so Next.js could not pipe the body and
   * surfaced a 500 even though the upstream call succeeded.
   *
   * Regression guard: a round-robin combo whose target returns a streaming response with
   * content must return a response whose body is READABLE (not locked) and reproduces the
   * streamed content.
   */
  const encoder = new TextEncoder();

  function createLog() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  /** Claude 200 streaming response WITH a content block, one chunk per SSE event. */
  function makeClaudeContentStream(): Response {
    const events = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_rr_3811",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello round-robin" },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const chunks = events.map((e) => encoder.encode(e));
    let idx = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (idx < chunks.length) controller.enqueue(chunks[idx++]);
        else controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("#3811 round-robin streaming response returns an unlocked, replayable body", async () => {
    const result = await handleComboChat({
      body: { stream: true },
      combo: {
        name: "rr-streaming-lock-3811",
        strategy: "round-robin",
        models: ["model-a"],
        config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
      },
      handleSingleModel: async () => makeClaudeContentStream(),
      isModelAvailable: async () => true,
      log: createLog(),
      settings: null,
      allCombos: null,
    });

    assert.equal(result.ok, true);
    assert.ok(result.body, "combo response must expose a body stream");
    // Without the fix the round-robin path returns the original `result` whose body was
    // locked by validateResponseQuality's getReader() peek.
    assert.equal(
      result.body!.locked,
      false,
      "round-robin streaming body must not be locked (must return quality.clonedResponse)"
    );

    // Draining the body must succeed (a locked body throws here) and replay the content.
    const text = await result.text();
    assert.match(text, /hello round-robin/, "replayed stream must contain the upstream content");
  });
});

describe("combo-roundrobin-compat-fallback-6238", () => {
  // Regression guard for #6238: a round-robin combo returned
  // `503 all upstream accounts are unavailable` immediately when every
  // compatibility-KEPT target was runtime-unavailable, without ever
  // reconsidering a compatibility-REJECTED-but-healthy target. The compat
  // pre-filter (filterTargetsByRequestCompatibility) drops request-incompatible
  // targets BEFORE availability is known, and its `compatible.length === 0`
  // safety net only fires when ALL targets are filtered — not when the kept
  // targets later all turn out unavailable. The fix makes the rejected targets a
  // genuine last-resort fallback tier.
  function createLog() {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  function okResponse(body: unknown = { choices: [{ message: { content: "ok" } }] }) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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

  beforeEach(async () => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
    await clearModelsDevCapabilities();
  });

  after(async () => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
    await clearModelsDevCapabilities();
    await settingsDb.clearAllLKGP();
    await resetTestDb();
  });

  test(
    "round-robin falls back to a compat-rejected healthy target instead of 503 " +
      "when every compat-kept target is unavailable (#6238)",
    async () => {
      // rr-a is tool-INCAPABLE → the tools-requiring request makes the compat
      // pre-filter reject it. rr-b/rr-c are tool-capable → kept, but both are
      // runtime-unavailable. Only the rejected rr-a is actually healthy.
      await saveModelsDevCapabilities({
        openai: {
          "rr-a": capabilityEntry(128000, { tool_call: false }),
          "rr-b": capabilityEntry(128000),
          "rr-c": capabilityEntry(128000),
        },
      });

      const attempted: string[] = [];
      const availabilityChecks: string[] = [];

      const result = await handleComboChat({
        body: {
          messages: [{ role: "user", content: "Use a tool to look something up" }],
          tools: [{ type: "function", function: { name: "lookup_weather" } }],
        },
        combo: {
          name: "rr-compat-fallback-6238",
          strategy: "round-robin",
          models: ["openai/rr-a", "openai/rr-b", "openai/rr-c"],
          config: { maxRetries: 0, concurrencyPerModel: 1, queueTimeoutMs: 1000 },
        },
        handleSingleModel: async (_body, modelStr) => {
          attempted.push(modelStr);
          return okResponse({ choices: [{ message: { content: `served by ${modelStr}` } }] });
        },
        // Only the compat-rejected rr-a is healthy; the compat-kept rr-b/rr-c
        // are all runtime-unavailable.
        isModelAvailable: async (modelStr) => {
          availabilityChecks.push(modelStr);
          return modelStr === "openai/rr-a";
        },
        log: createLog(),
        settings: null,
        relayOptions: null,
        allCombos: null,
      });

      // Before the fix this returned 503 ALL_ACCOUNTS_INACTIVE without ever
      // attempting rr-a. After the fix the compat-rejected-but-healthy rr-a
      // serves the request.
      assert.equal(result.status, 200, "expected a 200 from the compat-rejected fallback, not 503");
      assert.equal(result.ok, true);
      assert.deepEqual(
        attempted,
        ["openai/rr-a"],
        "only the healthy compat-rejected target is used"
      );

      const payload = await result.json();
      assert.equal(payload.choices[0].message.content, "served by openai/rr-a");
      // Sanity: the compat-kept rr-b/rr-c were probed for availability first.
      assert.ok(
        availabilityChecks.includes("openai/rr-b") || availabilityChecks.includes("openai/rr-c"),
        "compat-kept targets should be probed before the last-resort fallback"
      );
    }
  );
});

describe("combo-rr-diagnostics-11462", () => {
  function createLog() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }
  function failResponse() {
    return new Response(JSON.stringify({ error: { message: "upstream 500" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
  });
  after(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
  });

  test(
    "#11462: round-robin combo's 'Maximum combo retry limit reached' 503 must carry " +
      "the combo diagnostics trace (poolSize/attemptOrder/excluded/terminalReason)",
    async () => {
      const result = await handleComboChat({
        body: { messages: [{ role: "user", content: "hi" }] },
        combo: {
          name: "rr-probe-11462",
          strategy: "round-robin",
          models: ["openai/rr-a", "anthropic/rr-b"],
          config: {
            maxRetries: 0,
            maxGlobalAttempts: 1,
            concurrencyPerModel: 1,
            queueTimeoutMs: 1000,
          },
        },
        handleSingleModel: async () => failResponse(),
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        relayOptions: null,
        allCombos: null,
      });

      assert.equal(result.status, 503);
      const body = await result.json();
      assert.equal(body.error.message, "Maximum combo retry limit reached");
      assert.ok(body.diagnostics, "round-robin 503 should carry a diagnostics field");
      assert.ok(typeof body.diagnostics.poolSize === "number");
      assert.ok(Array.isArray(body.diagnostics.attemptOrder));
      assert.ok(typeof body.diagnostics.terminalReason === "string");
    }
  );
});

describe("combo-rr-fallback-advance-948", () => {
  /**
   * Regression for upstream 9router#948 — round-robin combo pointer must advance
   * past the model that ACTUALLY served, not the eagerly-scheduled start index.
   *
   * With `stickyLimit: 1` ("true round-robin, one request per model"), when the
   * scheduled model fails and a *different* model serves via fallback, the counter
   * was advanced by +1 from the scheduled start index (eagerly, before the loop),
   * so the next request started at — and reused — the fallback-served model. This
   * silently degraded round-robin into hot-spotting on whichever model was healthy.
   *
   * This drives the REAL handleComboChat with session-stickiness disabled (to
   * isolate the pure rotation pointer) and asserts two consecutive requests do NOT
   * serve the same connection when the scheduled target keeps failing.
   */
  function makeLog() {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }

  // Flat round-robin combo. conn-A always fails (fallback-eligible 429); B and C succeed.
  function rrCombo(name: string) {
    return {
      name,
      strategy: "round-robin",
      // disableSessionStickiness isolates the round-robin pointer from the #3825
      // per-conversation pin; stickyLimit defaults to 1 (true round-robin).
      config: { maxRetries: 0, disableSessionStickiness: true },
      models: [
        {
          kind: "model",
          provider: "codex",
          providerId: "codex",
          model: "m-a",
          connectionId: "conn-A",
          id: `${name}-0`,
        },
        {
          kind: "model",
          provider: "codex",
          providerId: "codex",
          model: "m-b",
          connectionId: "conn-B",
          id: `${name}-1`,
        },
        {
          kind: "model",
          provider: "glm-cn",
          providerId: "glm-cn",
          model: "m-c",
          connectionId: "conn-C",
          id: `${name}-2`,
        },
      ],
    };
  }

  async function dispatchServedConnection(combo: Record<string, unknown>): Promise<string> {
    let served = "?";
    await handleComboChat({
      body: { model: combo.name, messages: [{ role: "user", content: "hi" }], stream: false },
      combo,
      allCombos: [combo],
      isModelAvailable: async () => true,
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (
        _b: unknown,
        modelStr: string,
        target?: { connectionId?: string | null }
      ) => {
        const conn = target?.connectionId ?? "?";
        // conn-A always fails with a fallback-eligible status so rotation must fall through.
        if (conn === "conn-A") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
          });
        }
        served = conn;
        return Response.json({ choices: [{ message: { role: "assistant", content: modelStr } }] });
      },
    });
    return served;
  }

  beforeEach(() => {
    rrState.rrCounters.clear();
    rrState.rrStickyTargets.clear();
  });

  test("#948: two consecutive requests do not reuse the fallback-served model", async () => {
    const combo = rrCombo("rr948");
    const first = await dispatchServedConnection(combo);
    const second = await dispatchServedConnection(combo);

    assert.notEqual(first, "?", "first request must be served by a healthy model");
    assert.notEqual(second, "?", "second request must be served by a healthy model");
    assert.notEqual(
      first,
      second,
      `round-robin must advance past the served model — got ${first} twice (hot-spotting)`
    );
  });
});

describe("combo-rr-session-stickiness-3825", () => {
  /**
   * Regression for #3825 — round-robin session stickiness.
   *
   * sessionStickiness.ts (v3.8.36) keeps a sessionless multi-turn conversation pinned to the
   * same connection so the upstream prompt-cache stays warm. The weighted/priority dispatch
   * honors it (via applySessionStickiness at combo.ts:~1587), but handleRoundRobinCombo
   * returned earlier (combo.ts:~1004) and never engaged it — so ROUND-ROBIN combos rotated on
   * every turn for clients that send no session id (Codex CLI, Claude Code, most
   * OpenAI-compatible tools), busting the cache → cold high-reasoning starts, intermittent
   * 504s and throughput collapse under concurrency (#3825).
   *
   * This drives the REAL handleComboChat with a flat round-robin combo and asserts:
   *  - a single sessionless conversation re-pins to its turn-1 connection (FAILS before the fix:
   *    the combo rotates A → B → C …);
   *  - DISTINCT conversations still spread across connections on their first turn (round-robin
   *    distribution is preserved — only intra-conversation rotation is removed).
   */
  function makeLog() {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }

  function rrCombo(name: string) {
    return {
      name,
      strategy: "round-robin",
      config: { maxRetries: 0 },
      models: [
        {
          kind: "model",
          provider: "codex",
          providerId: "codex",
          model: "m-a",
          connectionId: "conn-A",
          id: `${name}-0`,
        },
        {
          kind: "model",
          provider: "codex",
          providerId: "codex",
          model: "m-b",
          connectionId: "conn-B",
          id: `${name}-1`,
        },
        {
          kind: "model",
          provider: "glm-cn",
          providerId: "glm-cn",
          model: "m-c",
          connectionId: "conn-C",
          id: `${name}-2`,
        },
      ],
    };
  }

  async function dispatchConnection(
    combo: Record<string, unknown>,
    firstMessage: string
  ): Promise<string> {
    let conn = "?";
    await handleComboChat({
      body: {
        model: combo.name,
        messages: [{ role: "user", content: firstMessage }],
        stream: false,
      },
      combo,
      allCombos: [combo],
      isModelAvailable: async () => true,
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (
        _b: unknown,
        modelStr: string,
        target?: { connectionId?: string | null }
      ) => {
        conn = target?.connectionId ?? "?";
        return Response.json({ choices: [{ message: { role: "assistant", content: modelStr } }] });
      },
    });
    return conn;
  }

  beforeEach(() => {
    stick.clearAllStickyBindings();
    // Fail-open saturation (unknown → full headroom) so we exercise the stickiness MECHANISM,
    // not the headroom gate.
    stick.__setStickinessHeadroomFetcherForTests(async () => undefined);
  });

  after(() => {
    stick.__setStickinessHeadroomFetcherForTests(null);
  });

  test("round-robin: a sessionless conversation re-pins to its turn-1 connection across turns (#3825)", async () => {
    const combo = rrCombo("rr-stick");
    const conns: string[] = [];
    for (let turn = 0; turn < 5; turn++) {
      conns.push(await dispatchConnection(combo, "Refactor the streaming handler for combos."));
    }
    // Turns 2..5 must all reuse turn 1's connection (sticky). Before the fix RR rotates
    // (conn-A → conn-B → conn-C → conn-A → …) so this set would have size 3.
    assert.equal(
      new Set(conns.slice(1)).size,
      1,
      `turns 2..5 must stick to one connection, got: ${conns.join(", ")}`
    );
    assert.equal(conns[1], conns[0], "turn 2 must reuse turn 1's connection");
  });

  test("round-robin: DISTINCT conversations still spread across connections on turn 1 (#3825 spreading guard)", async () => {
    const combo = rrCombo("rr-spread");
    const hist: Record<string, number> = {};
    for (let i = 0; i < 6; i++) {
      const conn = await dispatchConnection(
        combo,
        `conversation number ${i} — distinct first message`
      );
      hist[conn] = (hist[conn] || 0) + 1;
    }
    // Round-robin distribution must be preserved across conversations: more than one
    // connection used (the pin must NOT collapse all conversations onto one connection).
    assert.ok(
      Object.keys(hist).length > 1,
      `distinct conversations must spread across connections, got: ${JSON.stringify(hist)}`
    );
  });
});

describe("combo-sessionless-pin-3825", () => {
  // Regression for #3825: PR #3399 disabled the <omniModel>-tag history pinning and
  // replaced it with a server-side session pin in combo.ts that is gated on
  // `relayOptions?.sessionId`. Most OpenAI-compatible clients send no session id, so
  // the read/write never fired → combos lost model stickiness → every turn re-ran the
  // strategy (round-robin rotated) → upstream prompt-cache misses, cold high-reasoning
  // starts, intermittent 504s. The fix derives a stable per-conversation key from the
  // request body when no session id is present, so a combo re-pins to the same model
  // across turns of the same conversation — but ONLY when context_cache_protection is on.
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

  function okResponse(body: any = { choices: [{ message: { content: "ok" } }] }) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function waitForBackgroundWork() {
    return new Promise((resolve) => setTimeout(resolve, 25));
  }

  // A stable conversation body — the first user message is identical across turns so
  // extractSessionAffinityKey() fingerprints the same conversation each time.
  function conversationBody() {
    return {
      messages: [{ role: "user", content: "Refactor the streaming handler for combos." }],
    };
  }

  async function cleanupTestDataDir() {
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        core.resetDbInstance();
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return;
      } catch (error: any) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (lastError) throw lastError;
  }

  beforeEach(async () => {
    clearSessions();
    await cleanupTestDataDir();
    await resetTestDb();
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  after(async () => {
    clearSessions();
    // The shared data dir is removed once by the file-level `after`; later describes need it.
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  test("context_cache_protection ON + NO sessionId: combo re-pins to the same model across turns (#3825)", async () => {
    const calls: string[] = [];
    // Priority strategy: turn 1 deterministically tries model-a first, but model-a returns
    // an empty (quality-failed) response so the combo falls through to model-b and records
    // model-b as the session model (this exercises the real main-loop write site).
    const combo = {
      name: "sticky-priority",
      strategy: "priority",
      context_cache_protection: true,
      models: ["model-a", "model-b"],
      config: { maxRetries: 0 },
    };

    const handleSingleModel = async (_body: any, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "model-a") {
        return okResponse({ choices: [{ message: { content: "" } }] }); // empty → fall through
      }
      return okResponse({ choices: [{ message: { content: "fallback ok" } }] });
    };

    // Two sequential turns of the SAME conversation, NO relayOptions.sessionId.
    for (let turn = 0; turn < 2; turn += 1) {
      const result = await handleComboChat({
        body: conversationBody(),
        combo,
        handleSingleModel: handleSingleModel as any,
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        relayOptions: null as any,
        allCombos: null,
      });
      assert.equal(result.ok, true);
      // Let the best-effort session-model write settle before the next turn reads it.
      await waitForBackgroundWork();
    }

    // Turn 1 records model-b (the model that actually succeeded). With the fix, turn 2 reads
    // that pin via the derived sessionless key and dispatches model-b DIRECTLY, skipping
    // model-a entirely → calls === [a, b, b]. Without the fix the derived key is never used,
    // so turn 2 re-runs priority from the top → calls === [a, b, a, b].
    assert.deepEqual(
      calls,
      ["model-a", "model-b", "model-b"],
      "turn 2 must re-pin to model-b (turn 1's selected model) and skip model-a"
    );
  });

  test("context_cache_protection OFF + NO sessionId: no pin, strategy re-runs each turn, no <omniModel> tag (#3825 scope guard)", async () => {
    const calls: string[] = [];
    const forwardedContents: string[] = [];
    // Identical priority+failover setup as the positive case, but with the toggle OFF.
    const combo = {
      name: "unprotected-priority",
      strategy: "priority",
      // context_cache_protection intentionally omitted (falsy) — #3399 behavior preserved.
      models: ["model-a", "model-b"],
      config: { maxRetries: 0 },
    };

    const handleSingleModel = async (forwardedBody: any, modelStr: string) => {
      calls.push(modelStr);
      const msgs = Array.isArray(forwardedBody?.messages) ? forwardedBody.messages : [];
      for (const m of msgs) {
        if (typeof m?.content === "string") forwardedContents.push(m.content);
      }
      if (modelStr === "model-a") {
        return okResponse({ choices: [{ message: { content: "" } }] });
      }
      return okResponse({ choices: [{ message: { content: "fallback ok" } }] });
    };

    for (let turn = 0; turn < 2; turn += 1) {
      const result = await handleComboChat({
        body: conversationBody(),
        combo,
        handleSingleModel: handleSingleModel as any,
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        relayOptions: null as any,
        allCombos: null,
      });
      assert.equal(result.ok, true);
      await waitForBackgroundWork();
    }

    // Toggle OFF → no pin is recorded or read → turn 2 re-runs priority from the top,
    // re-trying model-a before falling through to model-b → [a, b, a, b].
    assert.deepEqual(
      calls,
      ["model-a", "model-b", "model-a", "model-b"],
      "with protection OFF the combo must re-run strategy each turn (no sessionless pin)"
    );
    assert.ok(
      forwardedContents.every((c) => !c.includes("<omniModel>")),
      "no <omniModel> tag may be injected into the forwarded body (#454/#3399)"
    );
  });
});

describe("combo-stickiness-responses-input-7270", () => {
  /**
   * Regression for #7270 — combo session stickiness is a silent no-op on the OpenAI
   * Responses API (`/v1/responses`).
   *
   * The stickiness key was derived exclusively from `body.messages`, but Responses-API
   * requests carry their turns in `.input` and never populate `.messages`. So
   * deriveMessageHash(body.messages) resolved to null, stickiness failed open, and a
   * single conversation was re-ordered every turn as if stickiness were disabled —
   * regardless of strategy or the toggle.
   *
   * This drives the REAL handleComboChat with a round-robin combo and an `.input`-shaped
   * body and asserts:
   *  - a single sessionless Responses-API conversation re-pins to its turn-1 connection
   *    (FAILS before the fix: the combo rotates A → B → C …);
   *  - distinct conversations still spread across connections (spreading preserved);
   *  - the new normalizeStickinessMessages() helper covers both wire shapes.
   */
  function makeLog() {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }

  function rrCombo(name: string) {
    return {
      name,
      strategy: "round-robin",
      config: { maxRetries: 0 },
      models: [
        {
          kind: "model",
          provider: "codex",
          providerId: "codex",
          model: "m-a",
          connectionId: "conn-A",
          id: `${name}-0`,
        },
        {
          kind: "model",
          provider: "codex",
          providerId: "codex",
          model: "m-b",
          connectionId: "conn-B",
          id: `${name}-1`,
        },
        {
          kind: "model",
          provider: "glm-cn",
          providerId: "glm-cn",
          model: "m-c",
          connectionId: "conn-C",
          id: `${name}-2`,
        },
      ],
    };
  }

  // Responses-API shape: turns live in `.input` (array of message items with
  // input_text content parts), and `.messages` is absent.
  function responsesBody(combo: Record<string, unknown>, firstMessage: string) {
    return {
      model: combo.name,
      input: [{ role: "user", content: [{ type: "input_text", text: firstMessage }] }],
      stream: false,
    };
  }

  async function dispatchConnection(
    combo: Record<string, unknown>,
    body: Record<string, unknown>
  ): Promise<string> {
    let conn = "?";
    await handleComboChat({
      body,
      combo,
      allCombos: [combo],
      isModelAvailable: async () => true,
      relayOptions: undefined,
      signal: undefined,
      settings: {},
      log: makeLog(),
      handleSingleModel: async (
        _b: unknown,
        modelStr: string,
        target?: { connectionId?: string | null }
      ) => {
        conn = target?.connectionId ?? "?";
        return Response.json({ choices: [{ message: { role: "assistant", content: modelStr } }] });
      },
    });
    return conn;
  }

  beforeEach(() => {
    stick.clearAllStickyBindings();
    // Fail-open saturation (unknown → full headroom) so we exercise the stickiness
    // MECHANISM, not the headroom gate.
    stick.__setStickinessHeadroomFetcherForTests(async () => undefined);
  });

  after(() => {
    stick.__setStickinessHeadroomFetcherForTests(null);
  });

  test("normalizeStickinessMessages: covers .messages, .input array and .input string", () => {
    const fromMessages = stick.normalizeStickinessMessages({
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(fromMessages, [{ role: "user", content: "hi" }]);

    const fromInputArray = stick.normalizeStickinessMessages({
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    assert.ok(Array.isArray(fromInputArray) && fromInputArray.length === 1);

    const fromInputString = stick.normalizeStickinessMessages({ input: "plain string turn" });
    assert.deepEqual(fromInputString, [{ role: "user", content: "plain string turn" }]);

    // .messages wins over .input when both present (Chat Completions precedence).
    const both = stick.normalizeStickinessMessages({
      messages: [{ role: "user", content: "from messages" }],
      input: "from input",
    });
    assert.deepEqual(both, [{ role: "user", content: "from messages" }]);

    assert.equal(stick.normalizeStickinessMessages({}), null);
    assert.equal(stick.normalizeStickinessMessages(null), null);
  });

  test("normalizeStickinessMessages: .input array of PLAIN STRINGS maps to user messages (#7270 bare-string-array gap)", () => {
    // The Responses API also allows `.input` to be an array of bare strings (each string
    // is shorthand for an `input_text` user message) — the exact shape
    // `responsesInputNormalization.ts`'s `normalizeCodexResponsesInputItem` already
    // special-cases (`typeof itemValue === "string"`). Before this fix, the
    // Array.isArray(input) branch cast the array straight through unmapped, so
    // deriveMessageHash's `messages.find(m => m?.role === "user")` never matched a bare
    // string and the key stayed null (fail-open), same bug as #7270 for this narrower shape.
    const fromPlainStringArray = stick.normalizeStickinessMessages({
      input: ["First turn of the conversation, plain string item"],
    });
    assert.deepEqual(fromPlainStringArray, [
      { role: "user", content: "First turn of the conversation, plain string item" },
    ]);

    const key = stick.deriveMessageHash(fromPlainStringArray);
    assert.ok(key !== null, "a bare-string .input array item must still yield a stickiness key");
    assert.match(key!, /^[a-f0-9]{16}$/);

    // Mixed arrays (bare string turn followed by a structured item) must only map the
    // bare-string entries, leaving object items untouched.
    const mixed = stick.normalizeStickinessMessages({
      input: ["plain turn", { role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    assert.deepEqual(mixed?.[0], { role: "user", content: "plain turn" });
    assert.deepEqual(mixed?.[1], { role: "user", content: [{ type: "input_text", text: "hi" }] });
  });

  test("an .input-shaped Responses body yields a stable, non-null stickiness key", () => {
    const body = responsesBody(rrCombo("k"), "First turn of the conversation");
    // Old behavior: deriveMessageHash(body.messages) is null (bug).
    assert.equal(
      stick.deriveMessageHash(body.messages as never),
      null,
      "body.messages is absent on the Responses API — the old key source is null"
    );
    // New behavior: the normalized view produces a stable key.
    const key1 = stick.deriveMessageHash(stick.normalizeStickinessMessages(body));
    const key2 = stick.deriveMessageHash(stick.normalizeStickinessMessages(body));
    assert.ok(key1 !== null, "normalized Responses body must yield a key");
    assert.match(key1!, /^[a-f0-9]{16}$/);
    assert.equal(key1, key2, "stable across calls");
  });

  test("round-robin: a sessionless Responses-API conversation re-pins across turns (#7270)", async () => {
    const combo = rrCombo("rr-resp-stick");
    const conns: string[] = [];
    for (let turn = 0; turn < 5; turn++) {
      conns.push(
        await dispatchConnection(combo, responsesBody(combo, "Refactor the streaming handler."))
      );
    }
    // Turns 2..5 must all reuse turn 1's connection. Before the fix the RR combo rotates
    // (conn-A → conn-B → conn-C → …) because the .input key resolved to null → set size 3.
    assert.equal(
      new Set(conns.slice(1)).size,
      1,
      `turns 2..5 must stick to one connection, got: ${conns.join(", ")}`
    );
    assert.equal(conns[1], conns[0], "turn 2 must reuse turn 1's connection");
  });

  // Responses-API shape variant: `.input` is an array of PLAIN STRING items (each string
  // is shorthand for a user message), not an array of message objects. Before this fix,
  // normalizeStickinessMessages cast the array straight through unmapped, so
  // deriveMessageHash never found a `role === "user"` entry and stickiness stayed
  // fail-open for this narrower wire shape too.
  function responsesBodyPlainStringArray(combo: Record<string, unknown>, firstMessage: string) {
    return {
      model: combo.name,
      input: [firstMessage],
      stream: false,
    };
  }

  test("round-robin: a sessionless Responses-API conversation with .input as a plain-string array re-pins across turns (#7270 bare-string-array gap)", async () => {
    const combo = rrCombo("rr-resp-stick-strarr");
    const conns: string[] = [];
    for (let turn = 0; turn < 5; turn++) {
      conns.push(
        await dispatchConnection(
          combo,
          responsesBodyPlainStringArray(
            combo,
            "Refactor the streaming handler (string-array input)."
          )
        )
      );
    }
    // Turns 2..5 must all reuse turn 1's connection. Before the fix, the bare-string
    // .input array items yield a null key → the RR combo rotates (conn-A → conn-B → conn-C).
    assert.equal(
      new Set(conns.slice(1)).size,
      1,
      `turns 2..5 must stick to one connection, got: ${conns.join(", ")}`
    );
    assert.equal(conns[1], conns[0], "turn 2 must reuse turn 1's connection");
  });

  test("round-robin: distinct Responses-API conversations still spread (#7270 spreading guard)", async () => {
    const combo = rrCombo("rr-resp-spread");
    const hist: Record<string, number> = {};
    for (let i = 0; i < 6; i++) {
      const conn = await dispatchConnection(
        combo,
        responsesBody(combo, `conversation number ${i} — distinct first turn`)
      );
      hist[conn] = (hist[conn] || 0) + 1;
    }
    assert.ok(
      Object.keys(hist).length > 1,
      `distinct conversations must spread across connections, got: ${JSON.stringify(hist)}`
    );
  });
});

describe("combo-strict-random-distribution-3959", () => {
  /**
   * TDD regression for #3959: strict-random combo "routes to a model that never
   * succeeds" and concentrates traffic on a few models.
   *
   * Root cause: the strict-random branch shuffled only slot 0 (the deck pick) and
   * left the fallback remainder (`rest`) in FIXED priority order. So whenever the
   * deck-selected target failed, the dispatch chain always fell through to the same
   * top-priority model next — a persistently-failing model was retried on
   * essentially every request, and the fallback load never spread across peers.
   * (`random` does not have this defect because it shuffles the whole list.)
   *
   * Fix: shuffle `rest` too, so the fallback chain is randomized like `random`.
   */
  function createLog() {
    return {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  function okResponse() {
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function errorResponse(status: number) {
    return new Response(JSON.stringify({ error: { message: `Error ${status}` } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  beforeEach(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
    _resetAllDecks();
  });

  test("#3959 strict-random spreads the fallback across healthy peers, not a fixed model", async () => {
    const FAILING = "openai/gpt-4o-mini";
    const HEALTHY = ["claude/sonnet", "gemini/gemini-2.5-flash", "groq/llama-3.3-70b"];
    const models = [FAILING, ...HEALTHY];

    const combo = {
      name: "strict-random-fallback-spread-3959",
      strategy: "strict-random",
      models,
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    };

    // Collect the immediate fallback target chosen whenever the deck picked the
    // always-failing model first.
    const fallbackAfterFailure = new Set<string>();
    let failingWasPickedFirst = 0;

    for (let i = 0; i < 80; i += 1) {
      const calls: string[] = [];
      const result = await handleComboChat({
        body: {},
        combo,
        handleSingleModel: async (_body: unknown, modelStr: string) => {
          calls.push(modelStr);
          return modelStr === FAILING ? errorResponse(500) : okResponse();
        },
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        allCombos: null,
      });

      assert.equal(result.ok, true, "a healthy peer must always serve the request");
      if (calls[0] === FAILING) {
        failingWasPickedFirst += 1;
        assert.ok(calls[1], "must fall through to a peer after the failing deck pick");
        fallbackAfterFailure.add(calls[1]);
      }
    }

    assert.ok(
      failingWasPickedFirst >= 5,
      `deck should pick the failing model first several times (saw ${failingWasPickedFirst})`
    );
    // Pre-fix: `rest` is fixed priority order, so the fallback after the failing
    // pick is ALWAYS the same single model → set size 1 (RED).
    // Post-fix: `rest` is shuffled → the fallback spreads across the healthy peers.
    assert.ok(
      fallbackAfterFailure.size >= 2,
      `fallback after a failing deck pick must spread across peers, got only ${[
        ...fallbackAfterFailure,
      ].join(", ")}`
    );
  });

  test("#3959 strict-random still reaches the one healthy target when others fail", async () => {
    const models = ["openai/a", "claude/b", "gemini/c", "groq/d"];
    const HEALTHY = "gemini/c";
    const combo = {
      name: "strict-random-single-healthy-3959",
      strategy: "strict-random",
      models,
      config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
    };

    for (let i = 0; i < 12; i += 1) {
      const calls: string[] = [];
      const result = await handleComboChat({
        body: {},
        combo,
        handleSingleModel: async (_body: unknown, modelStr: string) => {
          calls.push(modelStr);
          return modelStr === HEALTHY ? okResponse() : errorResponse(503);
        },
        isModelAvailable: async () => true,
        log: createLog(),
        settings: null,
        allCombos: null,
      });
      assert.equal(result.ok, true);
      assert.equal(calls[calls.length - 1], HEALTHY, "must fall through until the healthy target");
    }
  });
});

describe("issue-13089-roundrobin-live-ws-events", () => {
  /**
   * Repro for #13089 — Combo Studio Live dashboard shows empty backlog despite
   * successful (or failed) chat completions routed through a round-robin combo.
   *
   * Round-robin bypasses `handleComboChat` -> `executeTargetAttempt` (the path that
   * publishes `combo.target.attempt` / `combo.target.succeeded` / `combo.target.failed`
   * on the dashboard EventBus) and dispatches through its own loop in
   * `open-sse/services/combo/roundRobinCombo.ts`, which never emitted those events.
   */
  function makeLog() {
    return { info() {}, warn() {}, debug() {}, error() {} };
  }

  function rrCombo(name: string, maxRetries = 0) {
    return {
      name,
      strategy: "round-robin",
      config: { maxRetries, disableSessionStickiness: true },
      models: [
        {
          kind: "model",
          provider: "codex",
          providerId: "codex",
          model: "m-a",
          connectionId: "conn-A",
          id: `${name}-0`,
        },
      ],
    };
  }

  beforeEach(() => {
    rrState.rrCounters.clear();
    rrState.rrStickyTargets.clear();
  });

  test("#13089: a successful round-robin combo completion publishes combo.target.succeeded on the dashboard EventBus", async () => {
    const combo = rrCombo("rr13089-success");

    const seen: Array<{ event: string; payload: unknown }> = [];
    const unsubscribeAttempt = eventBus.on("combo.target.attempt", (payload) => {
      seen.push({ event: "combo.target.attempt", payload });
    });
    const unsubscribeSucceeded = eventBus.on("combo.target.succeeded", (payload) => {
      seen.push({ event: "combo.target.succeeded", payload });
    });

    try {
      const response = await handleComboChat({
        body: { model: combo.name, messages: [{ role: "user", content: "hi" }], stream: false },
        combo,
        allCombos: [combo],
        isModelAvailable: async () => true,
        relayOptions: undefined,
        signal: undefined,
        settings: {},
        log: makeLog(),
        handleSingleModel: async (_b, modelStr, _target) => {
          return Response.json({
            choices: [{ message: { role: "assistant", content: modelStr } }],
          });
        },
      });

      assert.equal(response.status, 200, "the combo-routed completion itself must succeed");
      assert.ok(
        seen.some((e) => e.event === "combo.target.attempt"),
        `expected a "combo.target.attempt" EventBus event, but none was published (saw: ${JSON.stringify(seen)}).`
      );
      assert.ok(
        seen.some((e) => e.event === "combo.target.succeeded"),
        `expected a "combo.target.succeeded" EventBus event after a successful round-robin ` +
          `combo completion, but none was published (saw: ${JSON.stringify(seen)}). This is why ` +
          `Combo Studio -> Live never shows round-robin combo executions (#13089).`
      );
    } finally {
      unsubscribeAttempt();
      unsubscribeSucceeded();
    }
  });

  test("#13089: a failing round-robin combo target publishes combo.target.failed on the dashboard EventBus", async () => {
    const combo = rrCombo("rr13089-failure");

    const seen: Array<{ event: string; payload: unknown }> = [];
    const unsubscribeFailed = eventBus.on("combo.target.failed", (payload) => {
      seen.push({ event: "combo.target.failed", payload });
    });

    try {
      const response = await handleComboChat({
        body: { model: combo.name, messages: [{ role: "user", content: "hi" }], stream: false },
        combo,
        allCombos: [combo],
        isModelAvailable: async () => true,
        relayOptions: undefined,
        signal: undefined,
        settings: {},
        log: makeLog(),
        handleSingleModel: async () => {
          return Response.json({ error: { message: "rate limited" } }, { status: 429 });
        },
      });

      assert.equal(response.status, 429, "the exhausted combo must surface the upstream failure");
      assert.ok(
        seen.some((e) => e.event === "combo.target.failed"),
        `expected a "combo.target.failed" EventBus event after an exhausted round-robin ` +
          `combo target, but none was published (saw: ${JSON.stringify(seen)}).`
      );
    } finally {
      unsubscribeFailed();
    }
  });
});

describe("combo-weighted-all-targets-cooling-down", () => {
  /**
   * Weighted combos filter targets before dispatch (model lockout, circuit breaker,
   * provider cooldown, availability probe). When that leaves nothing, the response
   * used to be the host's 404 `no_executable_targets` — "switch combo / reconnect
   * providers" — for a pool that is configured, connected and merely cooling down;
   * Claude Code renders a 404 as "this model may not exist". A pool emptied by
   * resilience timers now answers 503 + Retry-After with every excluded target in
   * the diagnostics. A pool with nothing to run keeps its 404.
   *
   * Harness mirrors tests/unit/combo/strategy-fallbacks.test.ts.
   */
  type LogEntry = { level: string; tag: unknown; msg: unknown };
  function createLog() {
    const entries: LogEntry[] = [];
    const push = (level: string) => (tag: unknown, msg: unknown) => {
      entries.push({ level, tag, msg });
    };
    return {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
      debug: push("debug"),
      entries,
    };
  }

  function okResponse() {
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const COMBO = {
    name: "weighted-cooling",
    strategy: "weighted",
    models: [
      { model: "openai/a", weight: 50 },
      { model: "claude/b", weight: 50 },
    ],
    config: { maxRetries: 0, retryDelayMs: 0, fallbackDelayMs: 0 },
  };

  function lockModel(provider: string, model: string, cooldownMs: number) {
    recordModelLockoutFailure(provider, "", model, "unknown", 502, cooldownMs, null, {
      maxCooldownMs: cooldownMs,
    });
  }

  async function openBreaker(provider: string) {
    const breaker = getCircuitBreaker(provider, { failureThreshold: 1, resetTimeout: 30_000 });
    await breaker
      .execute(async () => {
        throw new Error("simulated failure");
      })
      .catch(() => {});
    assert.equal(breaker.getStatus().state, "OPEN");
  }

  async function run(opts: {
    isModelAvailable?: IsModelAvailable;
    settings?: Record<string, unknown> | null;
    log?: ReturnType<typeof createLog>;
    calls?: string[];
  }) {
    return handleComboChat({
      body: {},
      combo: COMBO,
      handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
        opts.calls?.push(modelStr);
        return okResponse();
      },
      isModelAvailable: opts.isModelAvailable ?? (async () => true),
      log: opts.log ?? createLog(),
      settings: opts.settings ?? null,
      allCombos: null,
    });
  }

  beforeEach(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    clearAllModelLockouts();
    weightedStickyTargets.clear();
  });

  after(() => {
    resetAllCircuitBreakers();
    clearAllModelLockouts();
  });

  test("every target model-locked → 503 + Retry-After with the excluded targets, nothing dispatched", async () => {
    lockModel("openai", "a", 60_000);
    lockModel("claude", "b", 120_000);
    const calls: string[] = [];
    const log = createLog();

    const res = await run({ calls, log });
    assert.equal(res.status, 503);
    assert.deepEqual(calls, [], "no upstream call is made for a cooling pool");

    const retryAfter = Number(res.headers.get("Retry-After"));
    assert.ok(
      retryAfter >= 1 && retryAfter <= 60,
      `Retry-After follows the earliest lapse, got ${retryAfter}`
    );
    assert.equal(res.headers.get("x-omniroute-combo-terminal-reason"), "all_targets_cooling_down");
    assert.equal(res.headers.get("x-omniroute-recovery-action"), "wait");
    assert.equal(res.headers.get("x-omniroute-retry-after-seconds"), String(retryAfter));

    const body = (await res.json()) as {
      error: { code?: string; message: string };
      diagnostics: {
        poolSize: number;
        attempted: number;
        excluded: Array<{ provider: string; model?: string; reason: string }>;
        terminalReason: string;
      };
      recovery_hint: { action: string; retry_after_seconds?: number };
    };
    assert.equal(body.error.code, "all_targets_cooling_down");
    assert.match(body.error.message, /cooling down/);
    assert.equal(body.diagnostics.terminalReason, "all_targets_cooling_down");
    assert.equal(body.diagnostics.poolSize, 2);
    assert.equal(body.diagnostics.attempted, 0);
    assert.deepEqual(
      body.diagnostics.excluded.map((e) => `${e.provider}/${e.model}:${e.reason}`).sort(),
      ["claude/b:model_lockout", "openai/a:model_lockout"]
    );
    assert.equal(body.recovery_hint.action, "wait");
    assert.equal(body.recovery_hint.retry_after_seconds, retryAfter);

    const warned = log.entries.find(
      (e) => e.level === "warn" && String(e.msg).includes("every target excluded before dispatch")
    );
    assert.ok(warned, "the silent drop is now logged with the reasons");
    assert.match(String(warned?.msg), /openai\/a: model_lockout \(\d+s\)/);
  });

  test("lockout + open circuit breaker are both reported as cooling down", async () => {
    lockModel("openai", "a", 60_000);
    await openBreaker("claude");
    const res = await run({});
    assert.equal(res.status, 503);
    const body = (await res.json()) as {
      diagnostics: { excluded: Array<{ provider: string; reason: string }> };
    };
    assert.deepEqual(body.diagnostics.excluded.map((e) => `${e.provider}:${e.reason}`).sort(), [
      "claude:circuit_open",
      "openai:model_lockout",
    ]);
  });

  test("one target cooling down, the other healthy → dispatches to the healthy one", async () => {
    lockModel("openai", "a", 60_000);
    const calls: string[] = [];
    const res = await run({ calls });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["claude/b"]);
  });

  test("pool emptied only by the availability probe keeps the 404 (nothing is cooling down)", async () => {
    const calls: string[] = [];
    const res = await run({ calls, isModelAvailable: async () => false });
    assert.equal(res.status, 404, "no resilience timer involved — the pool has nothing to run");
    assert.deepEqual(calls, []);
    const body = (await res.json()) as { diagnostics?: { terminalReason?: string } };
    assert.equal(body.diagnostics?.terminalReason, "no_executable_targets");
  });

  test("a cooling target plus an unavailable one is still 503 — the unavailable one is listed too", async () => {
    lockModel("openai", "a", 60_000);
    const res = await run({ isModelAvailable: async (modelStr) => modelStr !== "claude/b" });
    assert.equal(res.status, 503);
    const body = (await res.json()) as {
      diagnostics: { excluded: Array<{ provider: string; reason: string }> };
    };
    assert.deepEqual(body.diagnostics.excluded.map((e) => `${e.provider}:${e.reason}`).sort(), [
      "claude:unavailable",
      "openai:model_lockout",
    ]);
  });

  test("account cooldown from the availability probe returns 503 with retry timing, not 404", async () => {
    const calls: string[] = [];
    const res = await run({
      calls,
      isModelAvailable: async () => ({
        available: false,
        reason: "connection_cooldown",
        retryAfterMs: 5000,
      }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "5");
    assert.deepEqual(calls, []);
    const body = await res.json();
    assert.equal(body.error.code, "all_targets_cooling_down");
    assert.ok(body.diagnostics.excluded.every((entry) => entry.reason === "connection_cooldown"));
    assert.equal(getCircuitBreaker("openai").getStatus().failureCount, 0);
    assert.equal(getCircuitBreaker("claude").getStatus().failureCount, 0);
  });

  test("account cooldown mixed with missing credentials remains retryable", async () => {
    const res = await run({
      isModelAvailable: (model) =>
        model === "claude/b"
          ? false
          : {
              available: false,
              reason: "connection_cooldown",
              retryAfterMs: 1200,
            },
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "2");
    const body = await res.json();
    assert.deepEqual(body.diagnostics.excluded.map((entry) => entry.reason).sort(), [
      "connection_cooldown",
      "unavailable",
    ]);
  });

  test("account cooldown still allows a healthy sibling without changing breaker state", async () => {
    const calls: string[] = [];
    const res = await run({
      calls,
      isModelAvailable: (model) =>
        model === "claude/b"
          ? true
          : {
              available: false,
              reason: "connection_cooldown",
              retryAfterMs: 5000,
            },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["claude/b"]);
  });
});

describe("provider-breaker-combo-local-refusal", () => {
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  function localRefusal(): Response {
    return new Response(
      JSON.stringify({ error: { code: "provider_circuit_open", message: "Circuit open" } }),
      {
        status: 503,
        headers: { "content-type": "application/json", "x-omniroute-provider-breaker": "open" },
      }
    );
  }

  beforeEach(() => {
    resetAllCircuitBreakers();
    resetAllComboMetrics();
    rrCounters.clear();
    rrStickyTargets.clear();
  });

  for (const strategy of ["priority", "round-robin"] as const) {
    test(`${strategy}: local provider refusal advances without retry or provider failure`, async () => {
      const name = `local-breaker-${strategy}`;
      const calls: string[] = [];
      const result = await handleComboChat({
        body: {},
        combo: {
          name,
          strategy,
          models: ["openai/model-a", "anthropic/model-b"],
          config: { maxRetries: 2, retryDelayMs: 1, disableSessionStickiness: true },
        },
        handleSingleModel: async (_body: unknown, modelStr: string) => {
          calls.push(modelStr);
          return modelStr === "openai/model-a"
            ? localRefusal()
            : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        relayOptions: null,
        allCombos: null,
      });
      assert.equal(result.status, 200);
      assert.deepEqual(calls, ["openai/model-a", "anthropic/model-b"]);
      assert.equal(getCircuitBreaker("openai").failureCount, 0);
      assert.equal(getComboMetrics(name).byModel["openai/model-a"].requests, 1);
    });
  }

  test("priority still records a genuine upstream 503 against its provider", async () => {
    const calls: string[] = [];
    const result = await handleComboChat({
      body: {},
      combo: {
        name: "upstream-breaker-503",
        strategy: "priority",
        models: ["openai/model-a", "anthropic/model-b"],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return modelStr === "openai/model-a"
          ? new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
              status: 503,
              headers: { "content-type": "application/json" },
            })
          : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["openai/model-a", "anthropic/model-b"]);
    assert.equal(getCircuitBreaker("openai").failureCount, 1);
  });
});
