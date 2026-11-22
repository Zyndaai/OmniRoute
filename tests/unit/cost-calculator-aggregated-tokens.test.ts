import test from "node:test";
import assert from "node:assert/strict";

// #19429: rows of usage analytics sum many requests; the per-request long-context tier must not
// be applied to that sum.

const { computeCostFromPricing } = await import("../../src/lib/usage/costCalculator.ts");

const pricing = {
  input: 1,
  output: 5,
  long_context: { threshold: 200_000, input: 2, output: 10 },
};

test("a single long request crosses the tier", () => {
  const cost = computeCostFromPricing(pricing, { input: 300_000, output: 0 });
  assert.equal(cost, 0.6);
});

test("summed tokens of many requests are priced at the base rates", () => {
  const cost = computeCostFromPricing(
    pricing,
    { input: 300_000, output: 0 },
    { aggregatedTokens: true }
  );
  assert.equal(cost, 0.3);
});
