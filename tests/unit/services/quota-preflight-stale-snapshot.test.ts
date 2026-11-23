import test from "node:test";
import assert from "node:assert/strict";

// #18942: a stale snapshot (served because the live refresh failed) counts only while its own
// windows clear the cutoff. A spent stale snapshot is "unknown", not "exhausted", and its
// paid credits cannot vouch for a window that is already spent.

const { evaluateQuotaCutoff } = await import("../../../open-sse/services/quotaPreflight.ts");

const thresholds = { defaultThresholdPercent: 98 };

function snapshot(percentUsed: number, stale: boolean) {
  return {
    used: percentUsed,
    total: 100,
    percentUsed,
    stale,
    windows: {
      session: { percentUsed, resetAt: null },
    },
  };
}

test("a fresh snapshot over the cutoff still blocks", () => {
  const result = evaluateQuotaCutoff(snapshot(100, false) as never, thresholds as never, {
    provider: "claude",
  } as never);
  assert.equal(result.proceed, false);
});

test("a stale snapshot over the cutoff is treated as unknown and proceeds", () => {
  const result = evaluateQuotaCutoff(snapshot(100, true) as never, thresholds as never, {
    provider: "claude",
  } as never);
  assert.equal(result.proceed, true);
});

test("a stale snapshot under the cutoff is still honoured", () => {
  const result = evaluateQuotaCutoff(snapshot(10, true) as never, thresholds as never, {
    provider: "claude",
  } as never);
  assert.equal(result.proceed, true);
});
