import test from "node:test";
import assert from "node:assert/strict";
import {
  INACTIVE_LIMITER_MS,
  sweepIdleLimiters,
} from "../../open-sse/services/rateLimitManager/idleSweep.ts";
import { KeyedLimiter, MemorySlotState } from "../../open-sse/services/rateLimiter/index.ts";
import type { LimiterSettings } from "../../open-sse/services/rateLimiter/index.ts";

function newLimiter(key: string, settings: LimiterSettings = {}) {
  return new KeyedLimiter(key, settings, new MemorySlotState(settings));
}

function buildSweep(
  keys: string[],
  lastUsedOf: (key: string) => number,
  settings: LimiterSettings = {},
  withDebug = true
) {
  const limiters = new Map<string, KeyedLimiter>();
  const limiterLastUsed = new Map<string, number>();
  for (const key of keys) {
    limiters.set(key, newLimiter(key, settings));
    limiterLastUsed.set(key, lastUsedOf(key));
  }
  const logCalls: unknown[][] = [];
  const debugCalls: unknown[][] = [];
  const deps = {
    limiters,
    limiterLastUsed,
    log: (...args: unknown[]) => {
      logCalls.push(args);
    },
    ...(withDebug
      ? {
          debug: (...args: unknown[]) => {
            debugCalls.push(args);
          },
        }
      : {}),
  };
  return { deps, limiters, logCalls, debugCalls };
}

test("idle eviction aggregates the info log to one line with per-key debug detail", () => {
  const now = Date.now();
  const keys = ["prov-a:conn-1", "prov-b:conn-2", "prov-c:conn-3"];
  const { deps, logCalls, debugCalls } = buildSweep(keys, () => now - INACTIVE_LIMITER_MS - 60_000);
  sweepIdleLimiters(deps, now);
  assert.equal(logCalls.length, 1);
  assert.match(String(logCalls[0][0]), /Evicted idle limiters: 3/);
  assert.equal(debugCalls.length, 3);
  for (const key of keys) {
    assert.ok(
      debugCalls.some((args) => String(args[0]).includes(key)),
      `expected debug detail for ${key}`
    );
  }
});

test("a single idle eviction still emits one aggregated info line", () => {
  const now = Date.now();
  const { deps, logCalls, debugCalls } = buildSweep(
    ["prov-a:conn-1"],
    () => now - INACTIVE_LIMITER_MS - 60_000
  );
  sweepIdleLimiters(deps, now);
  assert.equal(logCalls.length, 1);
  assert.match(String(logCalls[0][0]), /Evicted idle limiters: 1/);
  assert.equal(debugCalls.length, 1);
});

test("a pass without eviction emits no eviction info line", () => {
  const now = Date.now();
  const { deps, logCalls, debugCalls } = buildSweep(["prov-a:conn-1"], () => now);
  sweepIdleLimiters(deps, now);
  assert.equal(logCalls.length, 0);
  assert.equal(debugCalls.length, 0);
});

test("a limiter with queued work is kept and stays silent", async () => {
  const now = Date.now();
  const { deps, limiters, logCalls, debugCalls } = buildSweep(
    ["prov-a:conn-1"],
    () => now - INACTIVE_LIMITER_MS - 60_000,
    { reservoir: 0, reservoirRefreshAmount: 0, reservoirRefreshInterval: 60_000 }
  );
  const limiter = limiters.get("prov-a:conn-1")!;
  const gate = limiter.schedule({}, () => new Promise(() => {}));
  gate.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(limiter.counts().QUEUED, 1);
  try {
    sweepIdleLimiters(deps, now);
    assert.equal(logCalls.length, 0);
    assert.equal(debugCalls.length, 0);
    assert.ok(limiters.has("prov-a:conn-1"));
  } finally {
    limiter.stop();
  }
});

test("without an injected debug hook the per-key detail falls back to console.debug", (t) => {
  const now = Date.now();
  const { deps, logCalls } = buildSweep(
    ["prov-a:conn-1", "prov-b:conn-2", "prov-c:conn-3"],
    () => now - INACTIVE_LIMITER_MS - 60_000,
    {},
    false
  );
  const consoleDebugCalls: unknown[][] = [];
  const originalDebug = console.debug;
  console.debug = (...args: unknown[]) => {
    consoleDebugCalls.push(args);
  };
  t.after(() => {
    console.debug = originalDebug;
  });
  sweepIdleLimiters(deps, now);
  assert.equal(logCalls.length, 1);
  assert.equal(consoleDebugCalls.length, 3);
});

test("the headline oldest-idle figure ignores entries without a recorded last use", () => {
  const now = Date.now();
  const keys = ["prov-a:conn-1", "prov-b:conn-2", "prov-c:conn-3"];
  const { deps, logCalls } = buildSweep(keys, (key) =>
    key === "prov-c:conn-3" ? 0 : now - 642_000
  );
  sweepIdleLimiters(deps, now);
  assert.equal(logCalls.length, 1);
  assert.match(String(logCalls[0][0]), /oldest idle 642s/);
});
