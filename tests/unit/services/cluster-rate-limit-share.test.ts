// Static per-process share of upstream rate limits (open-sse/services/clusterShare.ts):
// N processes together must stay within one account's limit.
import test from "node:test";
import assert from "node:assert/strict";

import {
  clusterProcessCount,
  shareLimiterOptions,
  shareOfCount,
  shareOfSpacing,
} from "../../../open-sse/services/clusterShare.ts";

const SENTINELS = { unlimitedReservoir: Number.MAX_SAFE_INTEGER, unlimitedConcurrency: 1000 };

test("cluster size comes from OMNIROUTE_CLUSTER_SIZE; unset, invalid or 1 means a single process", () => {
  assert.equal(clusterProcessCount({}), 1);
  assert.equal(clusterProcessCount({ OMNIROUTE_CLUSTER_SIZE: "1" }), 1);
  assert.equal(clusterProcessCount({ OMNIROUTE_CLUSTER_SIZE: "abc" }), 1);
  assert.equal(clusterProcessCount({ OMNIROUTE_CLUSTER_SIZE: "3" }), 3);
});

test("the safety-net defaults split across 3 processes stay within the account limit", () => {
  // 60 RPM, 350 ms spacing, 6 concurrent per API-key connection (DEFAULT_API_LIMITS).
  const defaults = {
    maxConcurrent: 6,
    minTime: 350,
    reservoir: 60,
    reservoirRefreshAmount: 60,
    reservoirRefreshInterval: 60_000,
  };
  const share = shareLimiterOptions(defaults, 3, SENTINELS);
  assert.deepEqual(share, {
    maxConcurrent: 2,
    minTime: 1050,
    reservoir: 20,
    reservoirRefreshAmount: 20,
    reservoirRefreshInterval: 60_000,
  });
  assert.ok(share.maxConcurrent * 3 <= defaults.maxConcurrent);
  assert.ok(share.reservoirRefreshAmount * 3 <= defaults.reservoirRefreshAmount);
});

test("only keys present in the input are touched (a minTime update stays minTime-only)", () => {
  const share = shareLimiterOptions({ minTime: 350 }, 3, SENTINELS);
  assert.deepEqual(Object.keys(share), ["minTime"]);
  assert.equal(share.minTime, 1050);
});

test("a single process changes nothing", () => {
  const options = { maxConcurrent: 6, minTime: 350, reservoir: 60 };
  assert.equal(shareLimiterOptions(options, 1, SENTINELS), options);
});

test("'no limit' sentinels, zero and exhausted values pass through", () => {
  const share = shareLimiterOptions(
    {
      maxConcurrent: 1000,
      minTime: 0,
      reservoir: Number.MAX_SAFE_INTEGER,
      reservoirRefreshAmount: 0,
    },
    3,
    SENTINELS
  );
  assert.equal(share.maxConcurrent, 1000);
  assert.equal(share.minTime, 0);
  assert.equal(share.reservoir, Number.MAX_SAFE_INTEGER);
  assert.equal(share.reservoirRefreshAmount, 0, "exhausted stays exhausted");
});

test("a count below N keeps 1 per process (the documented limit of a static split)", () => {
  assert.equal(shareOfCount(1, 3), 1);
  assert.equal(shareOfCount(2, 3), 1);
  assert.equal(shareOfCount(7, 3), 2);
  assert.equal(shareOfSpacing(500, 3), 1500);
});

test("a cluster limiter splits in memory without Redis and shares through Redis with it", async () => {
  const { createKeyedLimiter } = await import("../../../open-sse/services/rateLimiter/index.ts");
  const { setClusterRedis } = await import("../../../src/lib/cluster/redisClient.ts");
  const saved = process.env.OMNIROUTE_CLUSTER_SIZE;
  process.env.OMNIROUTE_CLUSTER_SIZE = "3";
  try {
    // PostgreSQL coordination: this process enforces 1/3 of the budget.
    const split = createKeyedLimiter("share:memory", {
      reservoir: 60,
      reservoirRefreshAmount: 60,
      reservoirRefreshInterval: 60_000,
    });
    assert.equal(await split.currentReservoir(), 20);

    // Redis coordination: the limiter's state goes to Redis, unsplit.
    const scripts: unknown[][] = [];
    setClusterRedis({
      eval: async (...args: unknown[]) => {
        scripts.push(args);
        return null;
      },
    });
    const shared = createKeyedLimiter("share:redis", { reservoir: 60 });
    await shared.currentReservoir();
    assert.ok(scripts.length > 0, "the Redis state must be used");
    assert.ok(
      scripts.some((args) => args.includes("tokens") && args.includes("60")),
      "the shared budget is the account's full budget"
    );
  } finally {
    setClusterRedis(null);
    if (saved === undefined) delete process.env.OMNIROUTE_CLUSTER_SIZE;
    else process.env.OMNIROUTE_CLUSTER_SIZE = saved;
  }
});

test("the provider default sliding window and concurrency cap are shared too", async () => {
  const saved = process.env.OMNIROUTE_CLUSTER_SIZE;
  process.env.OMNIROUTE_CLUSTER_SIZE = "3";
  try {
    const mod = await import(
      `../../../open-sse/services/providerDefaultRateLimit.ts?share=${Date.now()}`
    );
    // nvidia: documented 40 RPM and 6 concurrent per connection.
    assert.equal(mod.getProviderDefaultRateLimit("nvidia")?.requests, 13);
    assert.equal(mod.getProviderConcurrencyCap("nvidia", 6), 2);
  } finally {
    if (saved === undefined) delete process.env.OMNIROUTE_CLUSTER_SIZE;
    else process.env.OMNIROUTE_CLUSTER_SIZE = saved;
  }
});
