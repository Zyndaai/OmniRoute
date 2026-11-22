// Port of upstream #18669: the rate-limit semaphore tracks its cooldown drain timeouts so
// resetAll() clears them, and unrefs them so a long cooldown cannot keep the process alive.
import test from "node:test";
import assert from "node:assert/strict";

const semaphore = await import("../../open-sse/services/rateLimitSemaphore.ts");

type TimerLike = ReturnType<typeof setTimeout>;

function spyTimers() {
  const origSet = globalThis.setTimeout;
  const origClear = globalThis.clearTimeout;
  const created: TimerLike[] = [];
  const unrefed = new Set<TimerLike>();
  const cleared = new Set<TimerLike>();
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = origSet(...args);
    created.push(timer);
    const unref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefed.add(timer);
      return unref();
    };
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: TimerLike) => {
    cleared.add(timer);
    return origClear(timer);
  }) as typeof clearTimeout;
  return {
    created,
    unrefed,
    cleared,
    restore() {
      for (const timer of created) origClear(timer);
      globalThis.setTimeout = origSet;
      globalThis.clearTimeout = origClear;
    },
  };
}

test("the cooldown drain timer is unref'd so a long cooldown cannot keep the process alive", () => {
  semaphore.resetAll();
  const spy = spyTimers();
  try {
    semaphore.markRateLimited("cooldown-unref-model", 60_000);
    assert.equal(spy.created.length, 1);
    assert.ok(spy.unrefed.has(spy.created[0]), "cooldown timer must be unref'd");
  } finally {
    spy.restore();
    semaphore.resetAll();
  }
});

test("resetAll() clears pending cooldown drain timers", () => {
  semaphore.resetAll();
  const spy = spyTimers();
  try {
    semaphore.markRateLimited("cooldown-reset-model", 60_000);
    const [timer] = spy.created;
    assert.ok(timer, "markRateLimited must schedule a drain timer");
    semaphore.resetAll();
    assert.ok(spy.cleared.has(timer), "resetAll must clear the cooldown timer");
  } finally {
    spy.restore();
    semaphore.resetAll();
  }
});
