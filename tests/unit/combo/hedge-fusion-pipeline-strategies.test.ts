/* eslint-disable @typescript-eslint/no-explicit-any */
// Hedging, fusion, pipeline and abort strategies of handleComboChat. Merged from nine files so
// the combo.ts module graph loads once; each original file is one `describe` below, named after
// the file it came from.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HandleSingleModel } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-hedge-fusion-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-hedge-fusion-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../src/lib/db/core.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { handleComboChat, shouldSkipForPredictedTtft } =
  await import("../../../open-sse/services/combo.ts");
const { getDefaultComboConfig, resolveComboConfig } =
  await import("../../../open-sse/services/comboConfig.ts");
const { dispatchWithCooldownRetry } =
  await import("../../../open-sse/services/combo/comboAttemptLoop.ts");
const { remainderIsHomogeneous, shouldAbortOnInputBoundFailure } =
  await import("../../../open-sse/services/combo/executeTargetClassify.ts");
const { hasIdenticalModelErrorStreak, shouldSkipConnDisable } =
  await import("../../../open-sse/services/combo/comboPredicates.ts");
const { countToolResultTurns, handleAgenticPipelineChat, hasTrailingToolResult } =
  await import("../../../open-sse/services/agenticPipeline.ts");

const { resetAllComboMetrics } = await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearAllModelLockouts } = await import("../../../open-sse/services/accountFallback.ts");
const { _resetAllDecks } = await import("../../../src/shared/utils/shuffleDeck.ts");

// Each source file used to start in a fresh process; every describe starts from the same clean
// slate (DB rows, combo metrics, circuit breakers, lockouts, round-robin decks).
async function resetSharedState() {
  await resetTestDb();
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  clearAllModelLockouts();
  _resetAllDecks();
}

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-hedge-isolation", () => {
  before(resetSharedState);
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const noop = () => {};
  async function run(mode: string, hedge = true) {
    const dispatched: number[] = [],
      cancelled: number[] = [];
    const state: any = {
      orderedTargets: ["qwen", "qwen", "qwen", "qwen", "luna", "gemini"].map((modelStr) => ({
        modelStr,
      })),
      comboExpired: false,
      comboErrors: [],
    };
    const response = await dispatchWithCooldownRetry({
      state,
      deps: {
        config: { hedging: hedge, hedgeDelayMs: 0, zeroLatencyOptimizationsEnabled: true },
        body: { messages: [] },
        strategy: "priority",
        log: { info: noop, warn: noop, error: noop },
        combo: { name: "isolation-test" },
      } as any,
      extra: {
        maxSetRetries: 0,
        comboTimeoutMs: 1000,
        comboStartTime: Date.now(),
        evaluateGates: async () => ({ kind: "proceed" }),
        executeAttempt: async ({ index }: any) => {
          dispatched.push(index);
          state.abortControllers
            .get(index)
            .signal.addEventListener("abort", () => cancelled.push(index));
          if (mode === "allfail")
            return {
              ok: false,
              response: index === 5 ? new Response("failed", { status: 502 }) : undefined,
            };
          if (index === 4) {
            await delay(20);
            return { ok: true, response: new Response("luna") };
          }
          if (index > 0 && index < 4) {
            state.comboErrors.push({ kind: "model", status: 409, error: "duplicate" });
            return { ok: false };
          }
          if (mode === "context" && index === 5) {
            assert.equal(
              shouldAbortOnInputBoundFailure({
                structuredError: { code: "context_length_exceeded" },
                remainderIsHomogeneous:
                  remainderIsHomogeneous(state.orderedTargets, index, "gemini") &&
                  state.orderedTargets.every((t: any) => t.modelStr === "gemini"),
              }),
              false
            );
            return { ok: false };
          }
          if (mode === "context" && index === 0) {
            await delay(60);
            return { ok: false };
          }
          await delay(70);
          return { ok: false };
        },
      },
    } as any);
    await delay(80);
    return { response, dispatched, cancelled };
  }
  test("hedges launch different models before sibling accounts, preserving indices", async () => {
    const r = await run("duplicates");
    assert.equal(await r.response.text(), "luna");
    assert.deepEqual(r.dispatched.slice(0, 3), [0, 4, 5]);
    assert(r.cancelled.includes(0));
    assert(!r.cancelled.includes(4));
  });
  test("context failure cannot override pending heterogeneous success", async () => {
    const r = await run("context");
    assert.equal(await r.response.text(), "luna");
  });
  test("pending rate-limited branch cannot hold fast successful sibling", async () => {
    const r = await run("429");
    assert.equal(await r.response.text(), "luna");
    assert(r.cancelled.includes(0));
  });
  test("all failed settles without hanging", async () => {
    const r = await run("allfail");
    assert.equal(r.response.status, 502);
  });
  test("serial dispatch preserves original account order", async () => {
    const r = await run("duplicates", false);
    assert.equal(await r.response.text(), "luna");
    assert.deepEqual(r.dispatched, [0, 1, 2, 3, 4]);
  });
  test("duplicate conflicts are not malformed request evidence", () => {
    assert.equal(
      hasIdenticalModelErrorStreak(
        Array(3).fill({ kind: "model", status: 409, error: "duplicate" })
      ),
      false
    );
    assert.equal(
      hasIdenticalModelErrorStreak(
        Array(3).fill({ kind: "model", status: 400, error: "malformed" })
      ),
      true
    );
  });
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  const overflow = () =>
    new Response(
      JSON.stringify({
        error: { code: "context_length_exceeded", message: "Input exceeds context window" },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  test("real classifier: last-model context overflow leaves earlier hedge alive", async () => {
    const called: string[] = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "real-context-hedge",
        strategy: "priority",
        models: [{ model: "providerA/large" }, { model: "providerB/small" }],
        config: {
          hedging: true,
          hedgeDelayMs: 0,
          zeroLatencyOptimizationsEnabled: true,
          maxRetries: 0,
          maxSetRetries: 0,
        },
      },
      handleSingleModel: async (_body: any, model: string) => {
        called.push(model);
        if (model === "providerB/small") return overflow();
        await delay(30);
        return new Response(JSON.stringify({ choices: [{ message: { content: "winner" } }] }), {
          headers: { "content-type": "application/json" },
        });
      },
      log,
      settings: {},
      allCombos: [],
    } as any);
    assert.equal(response.status, 200);
    assert.equal(called.length, 2);
  });
  test("real classifier: serial homogeneous suffix still stops after first overflow", async () => {
    const called: string[] = [];
    const response = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "serial-context-suffix",
        strategy: "priority",
        models: [{ model: "providerA/a" }, { model: "providerB/b" }, { model: "providerB/b" }],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body: any, model: string) => {
        called.push(model);
        return model === "providerA/a" ? new Response("unavailable", { status: 502 }) : overflow();
      },
      log,
      settings: {},
      allCombos: [],
    } as any);
    assert.equal(response.status, 400);
    assert.deepEqual(called, ["providerA/a", "providerB/b"]);
  });

  for (const reverse of [false, true]) {
    test(`thrown branch and model400 aggregate consistently (${reverse})`, async () => {
      const state: any = {
        orderedTargets: [{ modelStr: "a" }, { modelStr: "b" }],
        comboErrors: [],
        recordedAttempts: 0,
        comboExpired: false,
      };
      const response = await dispatchWithCooldownRetry({
        state,
        deps: {
          config: { hedging: true, hedgeDelayMs: 0, zeroLatencyOptimizationsEnabled: true },
          body: { messages: [] },
          strategy: "priority",
          log,
          combo: { name: "throw-aggregation" },
        } as any,
        extra: {
          maxSetRetries: 0,
          comboTimeoutMs: 1000,
          comboStartTime: Date.now(),
          evaluateGates: async () => ({ kind: "proceed" }),
          executeAttempt: async ({ index }: any) => {
            await delay((index === 0) === reverse ? 2 : 10);
            if (index === 0) throw new Error("synthetic");
            state.comboErrors.push({
              model: "b",
              status: 400,
              error: "unsupported model",
              kind: "model",
            });
            state.recordedAttempts++;
            state.lastStatus = 400;
            state.lastError = "unsupported model";
            return { ok: false };
          },
        },
      } as any);
      assert.equal(response.status, 502);
      assert.equal(state.comboErrors.length, 2);
    });
  }

  test("genuine fatal global response cancels pending siblings", async () => {
    const state: any = {
      orderedTargets: [{ modelStr: "a" }, { modelStr: "b" }],
      comboErrors: [],
      comboExpired: false,
    };
    let cancelled = false;
    const response = await dispatchWithCooldownRetry({
      state,
      deps: {
        config: { hedging: true, hedgeDelayMs: 0, zeroLatencyOptimizationsEnabled: true },
        body: { messages: [] },
        strategy: "priority",
        log,
        combo: { name: "fatal-cleanup" },
      } as any,
      extra: {
        maxSetRetries: 0,
        comboTimeoutMs: 1000,
        comboStartTime: Date.now(),
        evaluateGates: async () => ({ kind: "proceed" }),
        executeAttempt: async ({ index }: any) => {
          if (index === 1)
            return {
              ok: false,
              response: new Response("malformed global request", { status: 400 }),
            };
          state.abortControllers.get(index).signal.addEventListener("abort", () => {
            cancelled = true;
          });
          await delay(40);
          return { ok: false };
        },
      },
    } as any);
    assert.equal(response.status, 400);
    assert.equal(cancelled, true);
  });
  test("all nonterminal failures aggregate only after all branches settle", async () => {
    const state: any = {
      orderedTargets: [{ modelStr: "a" }, { modelStr: "b" }],
      comboErrors: [],
      recordedAttempts: 0,
      comboExpired: false,
    };
    let settled = 0;
    const response = await dispatchWithCooldownRetry({
      state,
      deps: {
        config: { hedging: true, hedgeDelayMs: 0, zeroLatencyOptimizationsEnabled: true },
        body: { messages: [] },
        strategy: "priority",
        log,
        combo: { name: "all-local-fail" },
      } as any,
      extra: {
        maxSetRetries: 0,
        comboTimeoutMs: 1000,
        comboStartTime: Date.now(),
        evaluateGates: async () => ({ kind: "proceed" }),
        executeAttempt: async ({ index }: any) => {
          await delay(index === 0 ? 20 : 5);
          settled++;
          state.comboErrors.push({
            model: String(index),
            status: 502,
            error: "provider unavailable",
            kind: "provider",
          });
          state.recordedAttempts++;
          state.lastStatus = 502;
          state.lastError = "provider unavailable";
          return { ok: false };
        },
      },
    } as any);
    assert.equal(settled, 2);
    assert.equal(response.status, 502);
  });

  test("local turn conflicts never disable accounts; upstream conflicts retain normal handling", async () => {
    for (const provider of ["groq", "codex", "antigravity"]) {
      assert.equal(
        shouldSkipConnDisable(
          { status: 409, errorCode: "turn_in_progress" },
          false,
          false,
          provider
        ),
        true
      );
      assert.equal(
        shouldSkipConnDisable(
          { status: 409, errorType: "turn_in_progress" },
          false,
          false,
          provider
        ),
        true
      );
      assert.equal(
        shouldSkipConnDisable(
          { status: 409, errorCode: "upstream_conflict" },
          false,
          false,
          provider
        ),
        false
      );
    }
  });
});

describe("combo-hedging", () => {
  // Previously a placeholder (two `assert.ok(true)`). Now exercises the two zero-latency
  // features it claims to cover:
  //   1. Predictive-TTFT circuit-breaker DECISION (shouldSkipForPredictedTtft).
  //   2. Hedging / zero-latency CONFIG resolution (defaults + per-combo override),
  //      i.e. the knobs the combo engine reads before racing/skip-ahead.
  // The full hedging DISPATCH (Promise.race + loser abort) is covered end-to-end in
  // combo-routing-engine.test.ts; here we pin the decision logic + config plumbing that gate it
  // (both opt-in / off by default).

  // ── Predictive-TTFT circuit breaker (decision) ──
  test("predictive-TTFT — skips a model whose avg latency exceeds the ceiling (enough samples)", () => {
    assert.equal(shouldSkipForPredictedTtft({ requests: 10, avgLatencyMs: 5000 }, 2000), true);
  });

  test("predictive-TTFT — does NOT skip with too few samples (< 5)", () => {
    assert.equal(shouldSkipForPredictedTtft({ requests: 4, avgLatencyMs: 9000 }, 2000), false);
  });

  test("predictive-TTFT — does NOT skip when avg latency is within the ceiling", () => {
    assert.equal(shouldSkipForPredictedTtft({ requests: 50, avgLatencyMs: 1200 }, 2000), false);
  });

  test("predictive-TTFT — disabled (ceiling <= 0) never skips", () => {
    assert.equal(shouldSkipForPredictedTtft({ requests: 50, avgLatencyMs: 9000 }, 0), false);
  });

  test("predictive-TTFT — null/missing metric never skips", () => {
    assert.equal(shouldSkipForPredictedTtft(null, 2000), false);
    assert.equal(shouldSkipForPredictedTtft(undefined, 2000), false);
  });

  // ── Hedging / zero-latency config resolution ──
  test("hedging — defaults are opt-in (off) so normal combos never race", () => {
    const d = getDefaultComboConfig();
    assert.equal(d.hedging, false);
    assert.equal(d.hedgeDelayMs, 500);
    assert.equal(d.predictiveTtftMs, 0);
    assert.equal(d.zeroLatencyOptimizationsEnabled, false);
  });

  test("hedging — per-combo config overrides the zero-latency defaults", () => {
    const resolved = resolveComboConfig(
      {
        config: {
          hedging: true,
          hedgeDelayMs: 200,
          zeroLatencyOptimizationsEnabled: true,
          predictiveTtftMs: 3000,
        },
      },
      null
    );
    assert.equal(resolved.hedging, true);
    assert.equal(resolved.hedgeDelayMs, 200);
    assert.equal(resolved.zeroLatencyOptimizationsEnabled, true);
    assert.equal(resolved.predictiveTtftMs, 3000);
  });
});

describe("combo-hedge-body-size", () => {
  // Hedge dispatch sends the request body twice. The gate must refuse bodies over 256KB and
  // bodies whose size cannot be measured (circular), while still hedging a normal small body.
  before(resetSharedState);

  const log = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  };

  const HEDGE_CONFIG = {
    maxRetries: 0,
    retryDelayMs: 1,
    zeroLatencyOptimizationsEnabled: true,
    hedging: true,
    hedgeDelayMs: 1,
  };

  function okResponse(content: string): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  type HedgeMode = "serial-hold" | "hedge-race";

  async function dispatchWithHedge(
    body: Record<string, unknown>,
    mode: HedgeMode
  ): Promise<{ status: number; calls: string[]; content: string }> {
    const calls: string[] = [];
    const result = await handleComboChat({
      body,
      combo: {
        name: "hedge-body-size",
        strategy: "priority",
        models: ["model-a", "model-b"],
        config: HEDGE_CONFIG,
      },
      handleSingleModel: async (_body, modelStr, target) => {
        calls.push(modelStr);
        if (mode === "hedge-race" && modelStr === "model-b") {
          return okResponse("fast");
        }
        if (mode === "hedge-race") {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 100);
            target?.modelAbortSignal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
          return okResponse("slow");
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
        return okResponse(modelStr);
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });
    const payload = (await result.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return {
      status: result.status,
      calls: [...calls],
      content: payload.choices?.[0]?.message?.content ?? "",
    };
  }

  test("combo hedge does not start a second target when the body is over 256KB", async () => {
    const oversized = "x".repeat(256 * 1024 + 1);
    const outcome = await dispatchWithHedge(
      { messages: [{ role: "user", content: oversized }] },
      "serial-hold"
    );

    assert.equal(outcome.status, 200);
    assert.equal(outcome.content, "model-a");
    assert.deepEqual(outcome.calls, ["model-a"]);
  });

  test("combo hedge does not start a second target when the body cannot be stringified", async () => {
    const circular: Record<string, unknown> = {
      messages: [{ role: "user", content: "hi" }],
    };
    circular.self = circular;

    const outcome = await dispatchWithHedge(circular, "serial-hold");

    assert.equal(
      outcome.status,
      200,
      `hedge must not dispatch a second target (calls=${outcome.calls.join(",")})`
    );
    assert.equal(outcome.content, "model-a");
    assert.deepEqual(outcome.calls, ["model-a"]);
  });

  test("combo hedge still starts the fallback for a small plain body", async () => {
    const outcome = await dispatchWithHedge(
      { messages: [{ role: "user", content: "hi" }] },
      "hedge-race"
    );

    assert.equal(outcome.status, 200);
    assert.equal(outcome.content, "fast");
    assert.deepEqual(outcome.calls, ["model-a", "model-b"]);
  });
});

describe("combo-fusion-config-warn-6455", () => {
  // Regression guard for #6455 — silent no-op when config.judgeModel is set on a combo whose
  // top-level strategy is anything other than "fusion".
  //
  // Before the fix, open-sse/services/combo.ts read `config.judgeModel` and `config.fusionTuning`
  // only inside the `if (strategy === "fusion")` branch, so a persisted judgeModel on a
  // priority/weighted/auto/round-robin combo was silently ignored. The minimal-diff fix logs a
  // warn immediately before the fusion branch, so the misconfiguration is observable in logs
  // without changing runtime behavior for legitimate fusion combos.
  before(resetSharedState);

  function okResponse(content: string): Response {
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  function makeLog() {
    const records: Array<{ level: string; scope: string; msg: string }> = [];
    const cap = (level: string) => (scope: string, msg: string) => {
      records.push({ level, scope, msg: String(msg) });
    };
    return {
      log: {
        info: cap("info"),
        warn: cap("warn"),
        debug: cap("debug"),
        error: cap("error"),
      },
      records,
    };
  }

  test("6455: warns when config.judgeModel is set but strategy is not fusion", async () => {
    const { log, records } = makeLog();
    const handleSingleModel = async () => okResponse("resp");

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "fusion-free",
        strategy: "priority",
        models: [{ model: "p/first" }, { model: "p/second" }],
        config: { judgeModel: "auto/claude-opus" },
      },
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 200);
    const warns = records.filter(
      (r) => r.level === "warn" && r.scope === "COMBO" && r.msg.includes("judgeModel")
    );
    assert.equal(warns.length, 1, `expected exactly one judgeModel warn, got ${warns.length}`);
    assert.match(warns[0].msg, /priority/);
    assert.match(warns[0].msg, /fusion-free/);
    assert.match(warns[0].msg, /#6455/);
  });

  test("6455: warns when config.fusionTuning is set but strategy is not fusion", async () => {
    const { log, records } = makeLog();
    const handleSingleModel = async () => okResponse("resp");

    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "wrong-strategy",
        strategy: "weighted",
        models: [{ model: "p/a", weight: 1 }],
        config: { fusionTuning: { judgeTemperature: 0.2 } },
      },
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    const warns = records.filter(
      (r) => r.level === "warn" && r.scope === "COMBO" && r.msg.includes("fusionTuning")
    );
    assert.equal(warns.length, 1);
  });

  test("6455: does NOT warn when strategy is fusion (legitimate use)", async () => {
    const { log, records } = makeLog();
    const handleSingleModel = async () => okResponse("resp");

    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "real-fusion",
        strategy: "fusion",
        models: [{ model: "p/panelA" }, { model: "p/panelB" }],
        config: { judgeModel: "auto/claude-opus" },
      },
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    const warns = records.filter(
      (r) =>
        r.level === "warn" &&
        r.scope === "COMBO" &&
        (r.msg.includes("judgeModel") || r.msg.includes("fusionTuning"))
    );
    assert.equal(
      warns.length,
      0,
      `expected no judgeModel warn on legitimate fusion, got ${warns.length}`
    );
  });

  test("6455: does NOT warn when strategy is non-fusion and no judgeModel/fusionTuning set", async () => {
    const { log, records } = makeLog();
    const handleSingleModel = async () => okResponse("resp");

    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "plain-priority",
        strategy: "priority",
        models: [{ model: "p/only" }],
        config: {},
      },
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    const warns = records.filter(
      (r) =>
        r.level === "warn" &&
        r.scope === "COMBO" &&
        (r.msg.includes("judgeModel") || r.msg.includes("fusionTuning"))
    );
    assert.equal(warns.length, 0);
  });
});

describe("combo-fusion-strategy-comboref-6764", () => {
  // #6764 — fusion strategy silently dropped `combo-ref` panel members.
  //
  // Every other combo strategy resolves a `{kind:"combo-ref", comboName}` panel member through
  // the shared execute-mode machinery (see `open-sse/services/combo/runtimeUnits.ts::
  // executeComboRefUnit`); the fusion branch in `open-sse/services/combo.ts` only recognized
  // plain `string` or `{model: string}` entries, so a combo-ref member was filtered out with no
  // error or warning. This suite proves the fix: a combo-ref fusion panel member is dispatched as
  // ONE black-box panel voice (a recursive `handleComboChat` call into the referenced combo), not
  // dropped, not fanned out into the referenced combo's own targets.
  before(resetSharedState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  type Body = Record<string, unknown>;

  function okResponse(content: string): Response {
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  function fusionCombo(models: unknown[], extra: Record<string, unknown> = {}) {
    return {
      name: "test-fusion-combo-ref",
      strategy: "fusion",
      models,
      config: extra,
    };
  }

  test("fusion: a combo-ref panel member is dispatched, not silently dropped", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      if (m === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${m}`);
    };
    const nestedPriority = {
      name: "nested-priority",
      strategy: "priority",
      models: ["openai/nested-a"],
      config: { maxRetries: 0, retryDelayMs: 0 },
    };
    const combo = fusionCombo(
      [{ kind: "combo-ref", comboName: "nested-priority" }, { model: "p/plain" }],
      { judgeModel: "p/judge" }
    );

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo,
      handleSingleModel,
      log,
      settings: {},
      allCombos: [combo, nestedPriority],
    });

    assert.equal(res.status, 200);
    // Proves the combo-ref member was actually dispatched (its nested target
    // model reached handleSingleModel) instead of being silently filtered out.
    assert.ok(
      seen.includes("openai/nested-a"),
      `expected nested combo's target model to be dispatched, saw: ${seen.join(", ")}`
    );
    assert.ok(
      seen.includes("p/plain"),
      "plain panel member must still dispatch alongside combo-ref"
    );
  });

  test("fusion: combo-ref-only panel resolves normally (not a 400 empty-panel error)", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      return okResponse(`ans-${m}`);
    };
    const nestedPriority = {
      name: "solo-nested",
      strategy: "priority",
      models: ["openai/solo-target"],
      config: { maxRetries: 0, retryDelayMs: 0 },
    };
    const combo = fusionCombo([{ kind: "combo-ref", comboName: "solo-nested" }]);

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo,
      handleSingleModel,
      log,
      settings: {},
      allCombos: [combo, nestedPriority],
    });

    assert.notEqual(res.status, 400);
    assert.ok(seen.includes("openai/solo-target"));
  });

  test("fusion: self-referencing combo-ref fails that panel member gracefully, not an infinite loop", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      return okResponse(`ans-${m}`);
    };
    const combo = fusionCombo([
      { kind: "combo-ref", comboName: "test-fusion-combo-ref" },
      { model: "p/other" },
    ]);

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo,
      handleSingleModel,
      log,
      settings: {},
      allCombos: [combo],
    });

    // Overall request still degrades gracefully because "p/other" survives.
    assert.equal(res.status, 200);
    assert.ok(seen.includes("p/other"));
    assert.ok(!seen.includes("test-fusion-combo-ref"));
  });

  test("fusion: combo-ref pointing at a nonexistent combo fails only that panel member", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      return okResponse(`ans-${m}`);
    };
    const combo = fusionCombo([
      { kind: "combo-ref", comboName: "does-not-exist" },
      { model: "p/other" },
    ]);

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo,
      handleSingleModel,
      log,
      settings: {},
      allCombos: [combo],
    });

    assert.equal(res.status, 200);
    assert.ok(seen.includes("p/other"));
  });

  test("fusion: mixed plain string / auto-style / combo-ref panel members all dispatch together", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      return okResponse(`ans-${m}`);
    };
    const nestedPriority = {
      name: "mixed-nested",
      strategy: "priority",
      models: ["openai/mixed-target"],
      config: { maxRetries: 0, retryDelayMs: 0 },
    };
    const combo = fusionCombo([
      "auto/best-coding",
      { model: "p/direct" },
      { kind: "combo-ref", comboName: "mixed-nested" },
    ]);

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo,
      handleSingleModel,
      log,
      settings: {},
      allCombos: [combo, nestedPriority],
    });

    assert.equal(res.status, 200);
    assert.ok(seen.includes("auto/best-coding"));
    assert.ok(seen.includes("p/direct"));
    assert.ok(seen.includes("openai/mixed-target"));
  });
});

describe("combo-fusion-strategy", () => {
  // Fusion combo strategy — parallel panel + judge synthesis.
  //
  // Ported from upstream decolua/9router (Daniil Schovkunov). Adds Fusion as the 16th combo
  // strategy: fan the prompt out to every panel model in parallel, then a judge model
  // synthesizes one final answer from all panel responses.
  before(resetSharedState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  type Body = Record<string, unknown>;

  // Minimal OpenAI-chat Response-shaped object compatible with the engine's .ok + .clone().json() surface.
  function okResponse(content: string, { delayMs = 0 } = {}): Response | Promise<Response> {
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
    const make = () =>
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    return delayMs > 0 ? new Promise((r) => setTimeout(() => r(make()), delayMs)) : make();
  }

  function errResponse(status = 500): Response {
    return new Response(JSON.stringify({ error: { message: "boom" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function fusionCombo(models: string[], extra: Record<string, unknown> = {}) {
    return {
      name: "test-fusion-combo",
      strategy: "fusion",
      models: models.map((m) => ({ model: m })),
      config: extra,
    };
  }

  test("fusion: single-model panel answers directly (nothing to fuse)", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return okResponse("solo");
    };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["p/only"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "p/only");
    assert.equal(res.status, 200);
  });

  test("fusion: fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen: string[] = [];
    const seenBodies: Body[] = [];
    const handleSingleModel = async (b: Body, m: string) => {
      seen.push(m);
      seenBodies.push(b);
      if (m === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${m}`);
    };

    const res = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "Q" }],
        stream: true,
      },
      combo: fusionCombo(["p/a", "p/b", "p/c"], { judgeModel: "p/judge" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // 3 panel calls + 1 judge call.
    assert.equal(seen.length, 4);
    assert.deepEqual(seen.slice(0, 3).sort(), ["p/a", "p/b", "p/c"]);
    assert.equal(seen[3], "p/judge");

    // Panel calls are non-streaming with tools stripped.
    for (let i = 0; i < 3; i++) {
      const b = seenBodies[i];
      assert.equal(b.stream, false, "panel call should be non-streaming");
      assert.equal(b.tools, undefined, "panel call should have tools stripped");
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const judgeBody = seenBodies[3];
    const judgeMsgs = judgeBody.messages as Array<{ role: string; content: string }>;
    const judgeText = judgeMsgs[judgeMsgs.length - 1].content;
    assert.match(judgeText, /ans-p\/a/);
    assert.match(judgeText, /ans-p\/b/);
    assert.match(judgeText, /ans-p\/c/);
    assert.match(judgeText, /Source 1/);
    assert.equal(judgeBody.stream, true);

    assert.equal(res.status, 200);
  });

  test("fusion: defaults the judge to the first panel model when none is set", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      return okResponse(`ans-${m}`);
    };
    await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: fusionCombo(["p/first", "p/second"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });
    // Last call is the judge; defaults to panel[0].
    assert.equal(seen[seen.length - 1], "p/first");
  });

  test("fusion: proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = async (_b: Body, m: string) => {
      if (m === "p/slow") return okResponse("slow", { delayMs: 5000 });
      if (m === "p/judge") return okResponse("FINAL");
      return okResponse(`fast-${m}`);
    };

    const t0 = Date.now();
    const seenBodies: Body[] = [];
    const wrapped = async (b: Body, m: string) => {
      seenBodies.push(b);
      return handleSingleModel(b, m);
    };
    await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: fusionCombo(["p/x", "p/y", "p/slow"], {
        judgeModel: "p/judge",
        fusionTuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
      }),
      handleSingleModel: wrapped,
      log,
      settings: {},
      allCombos: [],
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    assert.ok(elapsed < 2000, `should not wait for straggler (took ${elapsed}ms)`);

    const judgeBody = seenBodies[seenBodies.length - 1];
    const judgeMsgs = judgeBody.messages as Array<{ role: string; content: string }>;
    const judgeText = judgeMsgs[judgeMsgs.length - 1].content;
    assert.match(judgeText, /fast-p\/x/);
    assert.match(judgeText, /fast-p\/y/);
    assert.ok(!/slow/.test(judgeText), "straggler answer should not appear in the judge prompt");
  });

  test("fusion: returns the lone survivor directly when only one panel model succeeds and no judgeModel is configured", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      if (m === "p/ok") return okResponse("lone");
      return errResponse(500);
    };
    await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: fusionCombo(["p/ok", "p/bad"], {
        // No judgeModel configured: the implicit "judge" is just panel[0], so
        // synthesizing a single source through itself is redundant.
        fusionTuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
      }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });
    // No judge call — single answer + no explicit judge means there is nothing to fuse.
    assert.ok(
      !seen.includes("p/judge"),
      "judge should not be invoked when only one panel model survives and no judgeModel is set"
    );
  });

  // #6455: when an explicit judgeModel IS configured, the lone-survivor degrade
  // path used to silently return the raw panel answer, never invoking the
  // configured judge. See tests/unit/fusion-judge-model-6455.test.ts for the
  // full regression guard.
  test("fusion: honors an explicit judgeModel even with a single surviving panel answer", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      if (m === "p/ok") return okResponse("lone");
      if (m === "p/judge") return okResponse("JUDGED");
      return errResponse(500);
    };
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: fusionCombo(["p/ok", "p/bad"], {
        judgeModel: "p/judge",
        fusionTuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
      }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });
    assert.ok(
      seen.includes("p/judge"),
      "explicit judgeModel should still be invoked to synthesize a single panel answer"
    );
    assert.equal(seen[seen.length - 1], "p/judge");
    assert.equal(res.status, 200);
  });

  test("fusion: preserves explicit providers when filtering structured panel targets", async () => {
    await modelsDb.mergeModelCompatOverride("nvidia", "openai/gpt-oss-120b", { isHidden: true });
    const seen: string[] = [];

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: {
        name: "structured-fusion-combo",
        strategy: "fusion",
        models: [
          { model: "openai/gpt-oss-120b", providerId: "nvidia" },
          { model: "p/a" },
          { model: "p/b" },
        ],
        config: {},
      },
      handleSingleModel: async (_body: Body, model: string) => {
        seen.push(model);
        return okResponse(`answer-${model}`);
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["p/a", "p/b", "p/a"]);
  });

  test("fusion: dispatches visible structured panel targets with their provider identity", async () => {
    const targets: Array<{ model: string; providerId?: string | null }> = [];

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: {
        name: "structured-fusion-dispatch",
        strategy: "fusion",
        models: [
          { model: "vendor/model-a", providerId: "nvidia" },
          { model: "vendor/model-b", providerId: "nvidia" },
        ],
        config: {},
      },
      handleSingleModel: async (_body: Body, model: string, target) => {
        targets.push({
          model,
          providerId: target && "providerId" in target ? target.providerId : undefined,
        });
        return okResponse(`answer-${model}`);
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(targets.slice(0, 2), [
      { model: "vendor/model-a", providerId: "nvidia" },
      { model: "vendor/model-b", providerId: "nvidia" },
    ]);
  });

  test("fusion: never dispatches hidden panel members or a hidden explicit judge", async () => {
    await modelsDb.mergeModelCompatOverride("p", "hidden-panel", { isHidden: true });
    await modelsDb.mergeModelCompatOverride("p", "hidden-judge", { isHidden: true });
    const seen: string[] = [];

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: fusionCombo(["p/hidden-panel", "p/a", "p/b"], {
        judgeModel: "p/hidden-judge",
      }),
      handleSingleModel: async (_body: Body, model: string) => {
        seen.push(model);
        return okResponse(`answer-${model}`);
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["p/a", "p/b", "p/a"]);
  });

  test("fusion: returns 503 when the whole panel fails", async () => {
    const handleSingleModel = async () => errResponse(500);
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      combo: fusionCombo(["p/a", "p/b"], {
        fusionTuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
      }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });
    assert.equal(res.status, 503);
  });
});

describe("combo-pipeline-strategy", () => {
  // Pipeline combo strategy — sequential chain (#6297).
  //
  // The 18th combo strategy: run targets IN ORDER, thread each step's output into the next
  // step's input (each step has its own optional prompt), and return only the final step's
  // response. Sequential counterpart to `fusion` (parallel + judge).
  before(resetSharedState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  type Body = Record<string, unknown>;

  // Minimal OpenAI-chat Response-shaped object compatible with the engine's
  // .ok + .clone().json() + .json() surface.
  function okResponse(content: string): Response {
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  function errResponse(status = 500): Response {
    return new Response(JSON.stringify({ error: { message: "boom" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // steps: array of { model, prompt? }.
  function pipelineCombo(steps: Array<{ model: string; prompt?: string }>) {
    return {
      name: "test-pipeline-combo",
      strategy: "pipeline",
      models: steps,
      config: {},
    };
  }

  function lastUserContent(b: Body): string {
    const msgs = b.messages as Array<{ role: string; content: string }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") return msgs[i].content;
    }
    return "";
  }

  test("pipeline: 2 steps — step 1 gets the original input, step 2 gets step 1's output + its own prompt, only step 2's output is returned", async () => {
    const seen: string[] = [];
    const seenBodies: Body[] = [];
    const handleSingleModel = async (b: Body, m: string) => {
      seen.push(m);
      seenBodies.push(b);
      if (m === "p/a") return okResponse("OUT_A");
      return okResponse("FINAL_B");
    };

    const res = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        tools: [{ name: "x" }],
      },
      combo: pipelineCombo([{ model: "p/a" }, { model: "p/b", prompt: "SUMMARIZE" }]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // Exactly 2 calls, in order.
    assert.deepEqual(seen, ["p/a", "p/b"]);

    // Step 1 sees the original user request.
    assert.equal(lastUserContent(seenBodies[0]), "hi");
    // Step 1 is intermediate → non-streaming, tools stripped.
    assert.equal(seenBodies[0].stream, false);
    assert.equal(seenBodies[0].tools, undefined);

    // Step 2 receives step 1's output as its user input + its own prompt as a system turn.
    assert.equal(lastUserContent(seenBodies[1]), "OUT_A");
    const step2Msgs = seenBodies[1].messages as Array<{ role: string; content: string }>;
    assert.ok(
      step2Msgs.some((m) => m.role === "system" && m.content === "SUMMARIZE"),
      "step 2 should carry its own prompt as a system instruction"
    );
    // Final step keeps the client's original stream flag + tools.
    assert.equal(seenBodies[1].stream, true);
    assert.ok(Array.isArray(seenBodies[1].tools));

    // Only the final step's output is returned.
    assert.equal(res.status, 200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0].message.content, "FINAL_B");
  });

  test("pipeline: skips hidden steps without dispatching them", async () => {
    await modelsDb.mergeModelCompatOverride("p", "hidden-step", { isHidden: true });
    const seen: string[] = [];

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: pipelineCombo([{ model: "p/a" }, { model: "p/hidden-step" }, { model: "p/b" }]),
      handleSingleModel: async (_body: Body, model: string) => {
        seen.push(model);
        return okResponse(`answer-${model}`);
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["p/a", "p/b"]);
  });

  test("pipeline: preserves explicit providers when filtering structured steps", async () => {
    await modelsDb.mergeModelCompatOverride("nvidia", "openai/gpt-oss-120b", { isHidden: true });
    const seen: string[] = [];

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "structured-pipeline-combo",
        strategy: "pipeline",
        models: [
          { model: "p/a" },
          { model: "openai/gpt-oss-120b", providerId: "nvidia" },
          { model: "p/b" },
        ],
        config: {},
      },
      handleSingleModel: async (_body: Body, model: string) => {
        seen.push(model);
        return okResponse(`answer-${model}`);
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["p/a", "p/b"]);
  });

  test("pipeline: 3-step chain threads output → input correctly", async () => {
    const seen: string[] = [];
    const seenBodies: Body[] = [];
    const outputs: Record<string, string> = { "p/1": "o1", "p/2": "o2", "p/3": "o3" };
    const handleSingleModel = async (b: Body, m: string) => {
      seen.push(m);
      seenBodies.push(b);
      return okResponse(outputs[m]);
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "start" }] },
      combo: pipelineCombo([{ model: "p/1" }, { model: "p/2" }, { model: "p/3" }]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.deepEqual(seen, ["p/1", "p/2", "p/3"]);
    assert.equal(lastUserContent(seenBodies[0]), "start"); // original
    assert.equal(lastUserContent(seenBodies[1]), "o1"); // step 1 output
    assert.equal(lastUserContent(seenBodies[2]), "o2"); // step 2 output

    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0].message.content, "o3"); // final step output
  });

  test("pipeline: a failing middle step surfaces an error and short-circuits the chain", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      if (m === "p/a") return okResponse("OK");
      if (m === "p/bad") return errResponse(500);
      return okResponse("SHOULD_NOT_RUN");
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "go" }] },
      combo: pipelineCombo([{ model: "p/a" }, { model: "p/bad" }, { model: "p/c" }]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // Failure is surfaced (not a silent pass), and the downstream step never runs.
    assert.equal(res.status, 500);
    assert.ok(!seen.includes("p/c"), "the step after the failure must not execute");

    // Error body must not leak a stack trace.
    const body = (await res.json()) as { error?: { message?: string } };
    const msg = body.error?.message ?? "";
    assert.ok(!msg.includes("at /"), "error response must not leak a stack trace");
  });

  test("pipeline: an intermediate step that returns empty output fails the pipeline", async () => {
    const seen: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      seen.push(m);
      if (m === "p/empty") return okResponse("");
      return okResponse("FINAL");
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "go" }] },
      combo: pipelineCombo([{ model: "p/empty" }, { model: "p/final" }]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 502);
    assert.ok(!seen.includes("p/final"), "the final step must not run after an empty intermediate");
  });

  test("pipeline: a single-step pipeline runs the one model directly and streams through", async () => {
    const seen: string[] = [];
    const seenBodies: Body[] = [];
    const handleSingleModel = async (b: Body, m: string) => {
      seen.push(m);
      seenBodies.push(b);
      return okResponse("solo");
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true },
      combo: pipelineCombo([{ model: "p/only" }]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.deepEqual(seen, ["p/only"]);
    // Single step is the final step → keeps the client's stream flag.
    assert.equal(seenBodies[0].stream, true);
    assert.equal(res.status, 200);
  });

  test("pipeline: dispatches visible structured steps with their provider identity", async () => {
    const targets: Array<{ model: string; providerId?: string | null }> = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: {
        name: "structured-pipeline-dispatch",
        strategy: "pipeline",
        models: [{ model: "vendor/model", providerId: "nvidia" }],
        config: {},
      },
      handleSingleModel: async (_body: Body, model: string, target) => {
        targets.push({
          model,
          providerId: target && "providerId" in target ? target.providerId : undefined,
        });
        return okResponse("done");
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(res.status, 200);
    assert.deepEqual(targets, [{ model: "vendor/model", providerId: "nvidia" }]);
  });
});

describe("combo-agentic-pipeline", () => {
  before(resetSharedState);

  type Body = Record<string, unknown>;

  const noop = () => undefined;
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function responseText(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }

  function steps() {
    return [{ model: "p/planner" }, { model: "p/executor" }];
  }

  test("agentic detector recognizes trailing tool results across supported request formats", () => {
    assert.equal(
      hasTrailingToolResult({
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] }],
      }),
      true
    );
    assert.equal(
      hasTrailingToolResult({ messages: [{ role: "tool", tool_call_id: "t1", content: "ok" }] }),
      true
    );
    assert.equal(
      hasTrailingToolResult({ input: [{ type: "function_call_output", call_id: "c1" }] }),
      true
    );
    assert.equal(
      hasTrailingToolResult({ contents: [{ role: "user", parts: [{ functionResponse: {} }] }] }),
      true
    );
    assert.equal(
      hasTrailingToolResult({
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "old" }] },
          { role: "user", content: "a later fresh question" },
        ],
      }),
      false,
      "historical tool use must not classify a fresh turn as a continuation"
    );
  });

  test("agentic detector counts completed rounds for bounded sequential loops", () => {
    assert.equal(
      countToolResultTurns({
        messages: [
          { role: "tool", content: "one" },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "two" }] },
        ],
        input: [{ type: "function_call_output", call_id: "three" }],
        contents: [{ role: "user", parts: [{ functionResponse: { name: "four" } }] }],
      }),
      4
    );
  });

  test("round counting ignores completed tool loops before the current user request", () => {
    assert.equal(
      countToolResultTurns({
        messages: [
          { role: "user", content: "old request" },
          { role: "tool", content: "old result" },
          { role: "user", content: "new request" },
          { role: "assistant", content: [{ type: "tool_use", id: "new" }] },
          { role: "tool", content: "new result" },
        ],
      }),
      1
    );
  });

  test("fresh tool-bearing turn buffers planner then streams executor with native tools intact", async () => {
    const calls: Array<{ model: string; body: Body }> = [];
    const handle: HandleSingleModel = async (body, model) => {
      calls.push({ model, body });
      return model === "p/planner"
        ? responseText("OMNIROUTE_ROUTE: TOOLS\nRead the two files in parallel.")
        : responseText("executor-response");
    };

    const result = await handleAgenticPipelineChat({
      body: {
        messages: [{ role: "user", content: "inspect both files" }],
        tools: [{ name: "read_file" }],
        stream: true,
      },
      steps: steps(),
      handleSingleModel: handle,
      log,
    });

    assert.equal(result.status, 200);
    assert.deepEqual(
      calls.map((call) => call.model),
      ["p/planner", "p/executor"]
    );
    assert.equal(calls[0].body.stream, false);
    assert.equal(calls[0].body.tools, undefined);
    assert.match(JSON.stringify(calls[0].body), /read_file/);
    assert.equal(calls[1].body.stream, true);
    assert.deepEqual(calls[1].body.tools, [{ name: "read_file" }]);
  });

  test("tool-result continuation returns to planner and planner owns the streamed final answer", async () => {
    const calls: Array<{ model: string; body: Body }> = [];
    const handle: HandleSingleModel = async (body, model) => {
      calls.push({ model, body });
      return calls.length === 1
        ? responseText("OMNIROUTE_ROUTE: FINAL\nThe file is valid.")
        : responseText("final-from-planner");
    };

    await handleAgenticPipelineChat({
      body: {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ],
        tools: [{ name: "read" }],
        stream: true,
      },
      steps: steps(),
      handleSingleModel: handle,
      log,
    });

    assert.deepEqual(
      calls.map((call) => call.model),
      ["p/planner", "p/planner"]
    );
    assert.equal(calls[1].body.stream, true);
    assert.equal(calls[1].body.tools, undefined);
  });

  test("planner may request another sequential tool round after reviewing results", async () => {
    const seen: string[] = [];
    const handle: HandleSingleModel = async (_body, model) => {
      seen.push(model);
      return model === "p/planner"
        ? responseText("OMNIROUTE_ROUTE: TOOLS\nNow run the test suite.")
        : responseText("next-tool-call");
    };

    await handleAgenticPipelineChat({
      body: {
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] }],
        tools: [{ name: "shell" }, { name: "read" }],
      },
      steps: steps(),
      handleSingleModel: handle,
      log,
    });

    assert.deepEqual(seen, ["p/planner", "p/executor"]);
  });

  test("tool-round limit overrides a planner TOOLS decision and forces planner final", async () => {
    const calls: Array<{ model: string; body: Body }> = [];
    const handle: HandleSingleModel = async (body, model) => {
      calls.push({ model, body });
      return responseText("OMNIROUTE_ROUTE: TOOLS\nCall another tool.");
    };

    await handleAgenticPipelineChat({
      body: {
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] }],
        tools: [{ name: "shell" }],
        stream: true,
      },
      steps: steps(),
      handleSingleModel: handle,
      log,
      config: { maxToolRounds: 1 },
    });

    assert.deepEqual(
      calls.map((call) => call.model),
      ["p/planner", "p/planner"]
    );
    assert.equal(calls[1].body.tools, undefined);
  });

  test("malformed continuation decisions fail closed to planner final", async () => {
    const seen: string[] = [];
    const handle: HandleSingleModel = async (_body, model) => {
      seen.push(model);
      return responseText("unstructured planner prose");
    };

    await handleAgenticPipelineChat({
      body: {
        messages: [{ role: "tool", content: "done" }],
        tools: [{ name: "shell" }],
      },
      steps: steps(),
      handleSingleModel: handle,
      log,
    });

    assert.deepEqual(seen, ["p/planner", "p/planner"]);
  });

  test("requests without usable client tools route directly to planner once", async () => {
    const seen: string[] = [];
    const handle: HandleSingleModel = async (_body, model) => {
      seen.push(model);
      return responseText("answer");
    };

    await handleAgenticPipelineChat({
      body: { messages: [{ role: "user", content: "hello" }], stream: true },
      steps: steps(),
      handleSingleModel: handle,
      log,
    });

    assert.deepEqual(seen, ["p/planner"]);
  });

  test("agentic pipeline rejects configurations that are not planner + executor", async () => {
    const result = await handleAgenticPipelineChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      steps: [{ model: "p/only" }],
      handleSingleModel: async () => responseText("unused"),
      log,
    });
    assert.equal(result.status, 400);
  });

  test("pipeline dispatch wiring selects agentic mode when enabled", async () => {
    const seen: string[] = [];
    const result = await handleComboChat({
      body: {
        messages: [{ role: "user", content: "inspect" }],
        tools: [{ name: "read" }],
      },
      combo: {
        name: "agentic-pipeline",
        strategy: "pipeline",
        models: [{ model: "p/planner" }, { model: "p/executor" }],
        config: { agenticOrchestration: { enabled: true } },
      },
      handleSingleModel: async (_body, model) => {
        seen.push(model);
        return model === "p/planner"
          ? responseText("OMNIROUTE_ROUTE: TOOLS\nRead it.")
          : responseText("tool-call");
      },
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(result.status, 200);
    assert.deepEqual(seen, ["p/planner", "p/executor"]);
  });
});

describe("combo-499-abort", () => {
  before(resetSharedState);

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function makeCombo(strategy = "priority", models = ["a/model-1", "b/model-2", "c/model-3"]) {
    return {
      name: "test-combo-499",
      strategy,
      models: models.map((m) => ({ model: m })),
    };
  }

  test("combo loop stops immediately when handleSingleModel returns 499 (client disconnect)", async () => {
    let callCount = 0;
    const handleSingleModel = async () => {
      callCount++;
      return new Response("Client disconnected", { status: 499 });
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo("priority"),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // Should stop after the FIRST model — no fallback to model-2 or model-3
    assert.equal(callCount, 1, "should only call handleSingleModel once on 499");
    assert.equal(result.status, 499, "should return 499 status");
  });

  test("combo loop stops on signal.aborted before trying any model", async () => {
    let callCount = 0;
    const handleSingleModel = async () => {
      callCount++;
      return new Response("ok", { status: 200 });
    };

    const ac = new AbortController();
    ac.abort(); // Pre-abort

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo("priority"),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
      signal: ac.signal,
    });

    assert.equal(callCount, 0, "should NOT call handleSingleModel when signal is already aborted");
    assert.equal(result.status, 499);
  });

  test("combo loop with 3 models: 499 on model-1 prevents trying model-2 and model-3", async () => {
    const modelsCalled = [];
    const handleSingleModel = async (_body, modelStr) => {
      modelsCalled.push(modelStr);
      return new Response("Client disconnected", { status: 499 });
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo("priority", ["provider-a/fast", "provider-b/medium", "provider-c/large"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(modelsCalled.length, 1);
    assert.ok(
      modelsCalled[0].includes("fast"),
      `Expected first model to contain 'fast', got '${modelsCalled[0]}'`
    );
    assert.equal(result.status, 499);
  });

  test("combo loop does NOT stop on 502 (transient) — tries more than one model", async () => {
    let callCount = 0;
    const handleSingleModel = async () => {
      callCount++;
      return new Response("Bad Gateway", { status: 502 });
    };

    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo("priority", ["a/m1", "b/m2", "c/m3"]),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // Key assertion: unlike 499, a 502 should try more than 1 model
    assert.ok(callCount >= 2, `502 should attempt multiple models, but only tried ${callCount}`);
    assert.equal(result.status, 502, "should still return 502 if all models fail");
  });

  async function runRoundRobinEmptyContentAbort(flag: "true" | "false") {
    const previous = process.env.EMPTY_STREAM_SIBLING_RECOVERY_ENABLED;
    process.env.EMPTY_STREAM_SIBLING_RECOVERY_ENABLED = flag;
    const controller = new AbortController();
    const dispatchedModels: string[] = [];
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const retryLog = {
      ...log,
      info: (_tag: string, message: string) => {
        if (message.startsWith("Retrying ")) {
          abortTimer = setTimeout(() => controller.abort(), 1);
        }
      },
    };
    try {
      const response = await handleComboChat({
        body: { model: "test", messages: [{ role: "user", content: "hi" }] },
        combo: {
          ...makeCombo("round-robin", ["a/m1", "b/m2"]),
          config: { maxRetries: 1, retryDelayMs: 100, maxGlobalAttempts: 3 },
        },
        handleSingleModel: async (_body, modelStr) => {
          dispatchedModels.push(modelStr);
          return new Response(
            JSON.stringify({
              error: { code: "empty_content", message: "Provider returned empty content" },
            }),
            { status: 502, headers: { "Content-Type": "application/json" } }
          );
        },
        log: retryLog,
        settings: {},
        allCombos: [],
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => {});
      return { status: response.status, dispatchedModels, aborted: controller.signal.aborted };
    } finally {
      clearTimeout(abortTimer);
      if (previous === undefined) delete process.env.EMPTY_STREAM_SIBLING_RECOVERY_ENABLED;
      else process.env.EMPTY_STREAM_SIBLING_RECOVERY_ENABLED = previous;
    }
  }

  test("#16438 flag on: round-robin empty-content recovery stops when the client cancels during retry delay", async () => {
    const result = await runRoundRobinEmptyContentAbort("true");
    assert.equal(result.aborted, true);
    assert.equal(
      result.dispatchedModels.length,
      1,
      "cancellation must prevent retry and sibling dispatch"
    );
    assert.equal(result.status, 499);
  });

  test("#16438 flag off: round-robin keeps the release retry-delay behavior on cancellation", async () => {
    const result = await runRoundRobinEmptyContentAbort("false");
    // Release behavior: the fixed retry delay is not abort-aware, so the loop keeps
    // dispatching until the shared attempt budget (3) runs out and answers 503.
    assert.equal(result.aborted, true);
    assert.equal(result.dispatchedModels.length, 3);
    assert.equal(result.status, 503);
  });

  test("signal abort during fallback wait interrupts immediately", async () => {
    const ac = new AbortController();
    let callCount = 0;

    const handleSingleModel = async () => {
      callCount++;
      if (callCount === 1) {
        // First call returns 502 (which triggers fallback wait)
        return new Response("Bad Gateway", { status: 502 });
      }
      return new Response("ok", { status: 200 });
    };

    // Abort 50ms after start — should interrupt any wait
    const timer = setTimeout(() => ac.abort(), 50);

    const startMs = Date.now();
    const result = await handleComboChat({
      body: { model: "test", messages: [{ role: "user", content: "hi" }] },
      combo: makeCombo("priority", ["a/m1", "b/m2"]),
      handleSingleModel,
      log,
      settings: { fallbackDelayMs: 5000 }, // 5s delay would normally be slow
      allCombos: [],
      signal: ac.signal,
    });

    clearTimeout(timer);
    const elapsed = Date.now() - startMs;

    // Should complete in well under 5s — the abort interrupted the fallback wait
    assert.ok(elapsed < 2000, `Expected fast abort, but took ${elapsed}ms`);
    assert.equal(result.status, 499, "should return 499 after abort during wait");
  });
});
