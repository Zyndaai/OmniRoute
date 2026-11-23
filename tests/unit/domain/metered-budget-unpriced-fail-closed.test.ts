/**
 * Dollar-budget accounting for usage that cannot be priced.
 *
 * A completed metered call whose model has no pricing row (and whose response
 * carries no provider-reported cost) was charged $0 and the zero charge was
 * dropped, so a budgeted key could spend on that model forever. The budget now
 * fails closed for the rest of its period — the policy the per-key usage limit
 * already applies (#12341 / #13257) — and honours the same
 * USAGE_LIMIT_IGNORE_UNPRICED opt-out. Flat-rate providers stay exempt.
 *
 * End-to-end proof through the real chat pipeline:
 * tests/integration/metered-budget-unpriced-fail-closed.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-budget-unpriced-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budget-unpriced-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const costRules = await import("../../../src/domain/costRules.ts");
const policy = await import("../../../src/lib/usage/meteredBudgetPolicy.ts");
const domainState = await import("../../../src/lib/db/domainState.ts");
const { recordStreamingCost } = await import("../../../open-sse/handlers/chatCore/streamingCost.ts");

const KEY = "key-unpriced";
const METERED = "openai";
const FLAT_RATE = "opencode-go";
const CTX = costRules.buildCostCtx(
  METERED,
  "gpt-unpriced",
  { prompt_tokens: 10 },
  "standard",
  null
);

async function giveDailyBudget(limitUsd: number) {
  await costRules.resetCostData();
  await costRules.setBudget(KEY, { dailyLimitUsd: limitUsd, resetInterval: "daily" });
}

// Awaited directly: the chat path fires this write without waiting, so the
// test calls the same function and waits for the write to land.
async function chargeUnpriced() {
  await costRules.recordUnpricedBudgetUsage(KEY, CTX);
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

test.after(async () => {
  await costRules.resetCostData();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("an unpriced metered charge closes the budget for the rest of its period", async () => {
  await giveDailyBudget(1);
  assert.equal((await costRules.checkBudget(KEY)).allowed, true);

  await chargeUnpriced();

  const check = await costRules.checkBudget(KEY);
  assert.equal(check.allowed, false);
  assert.match(String(check.reason), /without a price/i);
  assert.equal(check.periodUsed, 0, "no fabricated spend is recorded");
  assert.equal((await policy.checkMeteredBudgetForProvider(KEY, METERED)).allowed, false);
  // The budget does not pay for flat-rate plans, so they stay eligible.
  assert.equal((await policy.checkMeteredBudgetForProvider(KEY, FLAT_RATE)).allowed, true);
});

test("a priced charge of $0 (a genuinely free model) leaves the budget open", async () => {
  await giveDailyBudget(1);
  costRules.recordChatCallCost({ id: KEY }, 0, CTX, true, false);
  costRules.recordChatCallCost({ id: KEY }, 0, CTX, true);
  assert.equal((await costRules.checkBudget(KEY)).allowed, true);
});

test("priced spend over the limit still reports the spend, not the unpriced reason", async () => {
  await giveDailyBudget(1);
  await chargeUnpriced();
  costRules.recordChatCallCost({ id: KEY }, 5, CTX, true);
  await waitFor(() => false, 50);
  const check = await costRules.checkBudget(KEY);
  assert.equal(check.allowed, false);
  assert.match(String(check.reason), /budget exceeded/i);
});

test("USAGE_LIMIT_IGNORE_UNPRICED=true counts unpriced usage as $0, as it does for the usage limit", async () => {
  const previous = process.env.USAGE_LIMIT_IGNORE_UNPRICED;
  process.env.USAGE_LIMIT_IGNORE_UNPRICED = "true";
  try {
    await giveDailyBudget(1);
    await chargeUnpriced();
    assert.equal((await costRules.checkBudget(KEY)).allowed, true);
    // Priced spend is still enforced under the opt-out.
    costRules.recordChatCallCost({ id: KEY }, 5, CTX, true);
    await waitFor(() => false, 50);
    assert.equal((await costRules.checkBudget(KEY)).allowed, false);
  } finally {
    if (previous === undefined) delete process.env.USAGE_LIMIT_IGNORE_UNPRICED;
    else process.env.USAGE_LIMIT_IGNORE_UNPRICED = previous;
  }
});

test("a key without a budget, or with a zero (no-limit) budget, is not affected", async () => {
  await costRules.resetCostData();
  await chargeUnpriced();
  assert.equal((await costRules.checkBudget(KEY)).allowed, true);
  assert.equal(await costRules.getBudget(KEY), null, "no budget is created as a side effect");
  assert.equal(await domainState.loadBudgetUnpricedPeriodStart(KEY), null);

  await costRules.setBudget(KEY, { dailyLimitUsd: 0, resetInterval: "daily" });
  await chargeUnpriced();
  assert.equal((await costRules.checkBudget(KEY)).allowed, true);
});

test("the closure lives in storage with its budget period, so a restart keeps it", async () => {
  await giveDailyBudget(1);
  await chargeUnpriced();
  const { periodStartAt } = costRules.getBudgetWindow("daily", "00:00");
  assert.equal(await domainState.loadBudgetUnpricedPeriodStart(KEY), periodStartAt);

  // A closure written by an earlier process is enforced as well.
  await giveDailyBudget(1);
  assert.equal((await costRules.checkBudget(KEY)).allowed, true);
  await domainState.saveBudgetUnpricedPeriodStart(KEY, periodStartAt);
  assert.equal((await costRules.checkBudget(KEY)).allowed, false);
});

test("a closure left by an earlier period does not block the current one", async () => {
  await giveDailyBudget(1);
  const { periodStartAt } = costRules.getBudgetWindow("daily", "00:00");
  await domainState.saveBudgetUnpricedPeriodStart(KEY, periodStartAt - 24 * 60 * 60 * 1000);
  assert.equal((await costRules.checkBudget(KEY)).allowed, true);
});

test("saving the budget again (an operator action) reopens it, and deleting it clears the closure", async () => {
  await giveDailyBudget(1);
  await chargeUnpriced();
  assert.equal((await costRules.checkBudget(KEY)).allowed, false);

  await costRules.setBudget(KEY, { dailyLimitUsd: 1, resetInterval: "daily" });
  assert.equal((await costRules.checkBudget(KEY)).allowed, true);
  assert.equal(await domainState.loadBudgetUnpricedPeriodStart(KEY), null);

  await chargeUnpriced();
  await costRules.deleteBudget(KEY);
  assert.equal(await domainState.loadBudgetUnpricedPeriodStart(KEY), null);
});

test("isUnpricedMeteredCost: only a metered provider with no price behind the estimate", () => {
  assert.equal(policy.isUnpricedMeteredCost(METERED, { costUsd: 0, priced: false }), true);
  // A failed pricing lookup is not a price either.
  assert.equal(
    policy.isUnpricedMeteredCost(METERED, { costUsd: 0, priced: false, failed: true }),
    true
  );
  assert.equal(policy.isUnpricedMeteredCost(METERED, { costUsd: 0, priced: true }), false);
  assert.equal(policy.isUnpricedMeteredCost(FLAT_RATE, { costUsd: 0, priced: false }), false);
  assert.equal(
    policy.isUnpricedMeteredCost("not-a-real-provider", { costUsd: 0, priced: false }),
    true
  );
  // No usage reported means nothing was priced at all.
  assert.equal(policy.isUnpricedMeteredCost(METERED, null), false);
});

test("recordStreamingCost reports an unpriced result and still records priced costs", async () => {
  const recorded: number[] = [];
  const unpriced: unknown[] = [];
  const common = {
    apiKeyId: "key-stream",
    provider: METERED,
    model: "gpt-unpriced",
    streamUsage: { prompt_tokens: 10, completion_tokens: 5 },
    recordCost: (_apiKeyId: string, cost: number) => {
      recorded.push(cost);
    },
    recordUnpricedCost: (_apiKeyId: string, result: unknown) => {
      unpriced.push(result);
    },
  };

  recordStreamingCost({ ...common, calculateCost: async () => ({ costUsd: 0, priced: false }) });
  await waitFor(() => unpriced.length > 0);
  assert.equal(unpriced.length, 1);
  assert.equal(recorded.length, 0);

  recordStreamingCost({ ...common, calculateCost: async () => ({ costUsd: 0.25, priced: true }) });
  await waitFor(() => recorded.length > 0);
  assert.deepEqual(recorded, [0.25]);
  assert.equal(unpriced.length, 1);
});
