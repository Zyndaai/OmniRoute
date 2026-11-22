// Port of upstream #19222: the min-interval gate measures spacing between real fetch starts, so a
// timer that wakes late no longer shrinks the next gap.
import test from "node:test";
import assert from "node:assert/strict";

const { MinIntervalThrottle } = await import("../../open-sse/services/quotaFetchThrottle.ts");

test("a late timer wake-up does not shorten the gap to the next fetch start", async () => {
  let current = 1_000;
  const starts: number[] = [];
  const LATE_MS = 40;
  let sleeps = 0;
  const clock = {
    now: () => current,
    // A loaded box: the first sleep wakes LATE_MS after the instant it was due; later ones are on time.
    sleep: async (ms: number) => {
      current += ms + (sleeps++ === 0 ? LATE_MS : 0);
    },
  };
  const throttle = new MinIntervalThrottle({ minIntervalMs: 250, clock });

  for (let i = 0; i < 3; i++) {
    await throttle.acquire();
    starts.push(clock.now());
  }

  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(gap >= 250, `gap ${gap}ms between real starts is below the 250ms interval`);
  }
});
