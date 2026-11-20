/**
 * Conformance tests for the keyed limiter (open-sse/services/rateLimiter/): the same cases
 * run against the in-memory state and, when OMNIROUTE_TEST_REDIS_URL points at a Redis,
 * against the Redis-shared state. Redis-only cases cover what makes the shared state worth
 * having: two limiters (two processes) on one key share one limit.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const {
  KeyedLimiter,
  MemorySlotState,
  RedisSlotState,
  LimiterExecutionTimeoutError,
  LimiterJobDroppedError,
} = await import("../../open-sse/services/rateLimiter/index.ts");
type LimiterSettings = import("../../open-sse/services/rateLimiter/index.ts").LimiterSettings;
type KeyedLimiterT = import("../../open-sse/services/rateLimiter/index.ts").KeyedLimiter;

const REDIS_URL = process.env.OMNIROUTE_TEST_REDIS_URL?.trim();
type RedisClient = import("ioredis").Redis;
let redis: RedisClient | null = null;
if (REDIS_URL) {
  const { default: Redis } = await import("ioredis");
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
}

test.after(async () => {
  await redis?.quit();
});

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type Build = (settings: LimiterSettings, key?: string) => KeyedLimiterT;

const backends: Array<{ name: string; build: Build | null }> = [
  {
    name: "memory",
    build: (settings, key = randomUUID()) =>
      new KeyedLimiter(key, settings, new MemorySlotState(settings)),
  },
  {
    name: "redis",
    build: redis
      ? (settings, key = `test:${randomUUID()}`) =>
          new KeyedLimiter(key, settings, new RedisSlotState(redis!, key, settings))
      : null,
  },
];

for (const { name, build } of backends) {
  describe(
    `keyed limiter (${name})`,
    { skip: build ? false : "OMNIROUTE_TEST_REDIS_URL unset" },
    () => {
      test("runs jobs and returns their results", async () => {
        const limiter = build!({});
        assert.equal(await limiter.schedule({}, async () => 42), 42);
        await assert.rejects(
          limiter.schedule({}, async () => {
            throw new Error("boom");
          }),
          /boom/
        );
        assert.deepEqual(limiter.counts(), { QUEUED: 0, RUNNING: 0, EXECUTING: 0, DONE: 2 });
      });

      test("spaces job starts by minTime, in FIFO order", async () => {
        const limiter = build!({ minTime: 100 });
        const starts: Array<[number, number]> = [];
        const t0 = Date.now();
        await Promise.all(
          [0, 1, 2].map((i) =>
            limiter.schedule({}, async () => {
              starts.push([i, Date.now() - t0]);
            })
          )
        );
        assert.deepEqual(
          starts.map(([i]) => i),
          [0, 1, 2]
        );
        assert.ok(starts[1][1] - starts[0][1] >= 90, `gap ${starts[1][1] - starts[0][1]}ms`);
        assert.ok(starts[2][1] - starts[1][1] >= 90, `gap ${starts[2][1] - starts[1][1]}ms`);
      });

      test("caps concurrency and starts the next job when one finishes", async () => {
        const limiter = build!({ maxConcurrent: 1 });
        let running = 0;
        let peak = 0;
        const job = async () => {
          running++;
          peak = Math.max(peak, running);
          await wait(40);
          running--;
        };
        await Promise.all([
          limiter.schedule({}, job),
          limiter.schedule({}, job),
          limiter.schedule({}, job),
        ]);
        assert.equal(peak, 1);
      });

      test("an empty reservoir waits for the refill", async () => {
        const limiter = build!({
          reservoir: 1,
          reservoirRefreshAmount: 1,
          reservoirRefreshInterval: 300,
        });
        const t0 = Date.now();
        await limiter.schedule({}, async () => undefined);
        await limiter.schedule({}, async () => undefined);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 250, `second job started after ${elapsed}ms, before the refill`);
        assert.equal(await limiter.currentReservoir(), 0);
      });

      test("updateSettings applies to the next job immediately", async () => {
        const limiter = build!({});
        limiter.updateSettings({
          reservoir: 0,
          reservoirRefreshAmount: 5,
          reservoirRefreshInterval: 200,
        });
        const t0 = Date.now();
        await limiter.schedule({}, async () => undefined);
        assert.ok(Date.now() - t0 >= 150, "the job ran before the paused reservoir refilled");
        assert.equal(await limiter.currentReservoir(), 4);

        limiter.updateSettings({
          reservoir: null,
          reservoirRefreshAmount: null,
          reservoirRefreshInterval: null,
        });
        assert.equal(await limiter.currentReservoir(), null);
      });

      test("a reservoir with no refill waits until settings change", async () => {
        const limiter = build!({ reservoir: 0 });
        let ran = false;
        const pending = limiter.schedule({}, async () => {
          ran = true;
        });
        await wait(250);
        assert.equal(ran, false);
        limiter.updateSettings({ reservoir: 1 });
        await pending;
        assert.equal(ran, true);
      });

      test("cancel removes a queued job; the rest keep their order", async () => {
        const limiter = build!({ maxConcurrent: 1 });
        const order: string[] = [];
        let open: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const first = limiter.schedule({ id: "first" }, async () => {
          await gate;
          order.push("first");
        });
        const rest = ["a", "b", "c"].map((id) =>
          limiter
            .schedule({ id }, async () => {
              order.push(id);
            })
            .catch((error: unknown) => (error instanceof LimiterJobDroppedError ? "dropped" : "?"))
        );
        await wait(30);
        assert.equal(limiter.cancel("b"), true);
        assert.equal(limiter.cancel("first"), false, "a started job cannot be cancelled");
        open();
        await first;
        assert.deepEqual(await Promise.all(rest), [undefined, "dropped", undefined]);
        assert.deepEqual(order, ["first", "a", "c"]);
      });

      test("expiration rejects a job that runs too long and frees its slot", async () => {
        const limiter = build!({ maxConcurrent: 1 });
        const slow = limiter.schedule({ expiration: 50 }, () => new Promise(() => {}));
        await assert.rejects(slow, (error: unknown) => {
          assert.ok(error instanceof LimiterExecutionTimeoutError);
          assert.equal((error as Error).message, "This job timed out after 50 ms.");
          return true;
        });
        assert.equal(await limiter.schedule({}, async () => "next"), "next");
      });

      test("stop rejects queued jobs and refuses new ones", async () => {
        const limiter = build!({ reservoir: 0 });
        const queued = limiter.schedule({}, async () => "never");
        await wait(20);
        limiter.stop();
        await assert.rejects(queued, LimiterJobDroppedError);
        await assert.rejects(
          limiter.schedule({}, async () => "x"),
          LimiterJobDroppedError
        );
      });
    }
  );
}

describe("memory state: cluster share", () => {
  test("scales spacing and counts by the share it is given", async () => {
    const settings = { minTime: 50, maxConcurrent: 4 };
    const scale = (s: LimiterSettings) => ({
      ...s,
      ...(typeof s.minTime === "number" ? { minTime: s.minTime * 2 } : {}),
      ...(typeof s.maxConcurrent === "number" ? { maxConcurrent: s.maxConcurrent / 2 } : {}),
    });
    const limiter = new KeyedLimiter("share", settings, new MemorySlotState(settings, scale));
    const starts: number[] = [];
    await Promise.all(
      [0, 1].map(() =>
        limiter.schedule({}, async () => {
          starts.push(Date.now());
        })
      )
    );
    assert.ok(starts[1] - starts[0] >= 90, `spacing ${starts[1] - starts[0]}ms, expected ~100`);
    assert.deepEqual(limiter.getSettings(), settings, "configured settings stay account-wide");
  });
});

describe(
  "redis state: one limit across processes",
  { skip: redis ? false : "OMNIROUTE_TEST_REDIS_URL unset" },
  () => {
    const pair = (settings: LimiterSettings) => {
      const key = `test:${randomUUID()}`;
      return [0, 1].map(
        () => new KeyedLimiter(key, settings, new RedisSlotState(redis!, key, settings))
      );
    };

    test("spacing holds across two limiters on one key", async () => {
      const [a, b] = pair({ minTime: 150 });
      const starts: number[] = [];
      const t0 = Date.now();
      await Promise.all([
        a.schedule({}, async () => void starts.push(Date.now() - t0)),
        b.schedule({}, async () => void starts.push(Date.now() - t0)),
        a.schedule({}, async () => void starts.push(Date.now() - t0)),
      ]);
      starts.sort((x, y) => x - y);
      assert.ok(starts[1] - starts[0] >= 140, `gap ${starts[1] - starts[0]}ms`);
      assert.ok(starts[2] - starts[1] >= 140, `gap ${starts[2] - starts[1]}ms`);
    });

    test("concurrency holds across two limiters on one key", async () => {
      const [a, b] = pair({ maxConcurrent: 1 });
      let running = 0;
      let peak = 0;
      const job = async () => {
        running++;
        peak = Math.max(peak, running);
        await wait(80);
        running--;
      };
      await Promise.all([
        a.schedule({}, job),
        b.schedule({}, job),
        a.schedule({}, job),
        b.schedule({}, job),
      ]);
      assert.equal(peak, 1);
    });

    test("a budget spent by one limiter is spent for the other", async () => {
      const [a, b] = pair({
        reservoir: 2,
        reservoirRefreshAmount: 2,
        reservoirRefreshInterval: 60_000,
      });
      await a.schedule({}, async () => undefined);
      await a.schedule({}, async () => undefined);
      assert.equal(await b.currentReservoir(), 0);
      let ran = false;
      const pending = b.schedule({ id: "late" }, async () => {
        ran = true;
      });
      pending.catch(() => {});
      await wait(300);
      assert.equal(ran, false, "the second limiter must not get a fresh budget");
      b.cancel("late");
    });

    test("a new limiter on a used key keeps the shared budget", async () => {
      const key = `test:${randomUUID()}`;
      const settings = {
        reservoir: 3,
        reservoirRefreshAmount: 3,
        reservoirRefreshInterval: 60_000,
      };
      const first = new KeyedLimiter(key, settings, new RedisSlotState(redis!, key, settings));
      await first.schedule({}, async () => undefined);
      const second = new KeyedLimiter(key, settings, new RedisSlotState(redis!, key, settings));
      assert.equal(await second.currentReservoir(), 2);
      await second.discardState();
      const third = new KeyedLimiter(key, settings, new RedisSlotState(redis!, key, settings));
      assert.equal(await third.currentReservoir(), 3, "discarded state restarts from settings");
    });
  }
);

describe(
  "redis state: lost state",
  { skip: redis ? false : "OMNIROUTE_TEST_REDIS_URL unset" },
  () => {
    test("an expired or discarded state is rebuilt from settings, never read as unlimited", async () => {
      const key = `test:${randomUUID()}`;
      const settings = { reservoir: 0 };
      const limiter = new KeyedLimiter(key, settings, new RedisSlotState(redis!, key, settings));
      assert.equal(await limiter.currentReservoir(), 0);
      await redis!.del(`omniroute:rl:${key}`); // what a TTL expiry leaves behind
      let ran = false;
      const pending = limiter.schedule({ id: "after-expiry" }, async () => {
        ran = true;
      });
      pending.catch(() => {});
      await wait(300);
      assert.equal(ran, false, "the empty budget must survive the lost state");
      assert.equal(await limiter.currentReservoir(), 0);
      limiter.cancel("after-expiry");
    });
  }
);

describe("redis state: failure", () => {
  test("an unreachable Redis lets requests through", async () => {
    const broken = {
      eval: async () => {
        throw new Error("connection refused");
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const limiter = new KeyedLimiter(
        "down",
        { maxConcurrent: 1, minTime: 10_000 },
        new RedisSlotState(broken, "down", {})
      );
      assert.equal(await limiter.schedule({}, async () => "a"), "a");
      assert.equal(await limiter.schedule({}, async () => "b"), "b");
    } finally {
      console.warn = warn;
    }
  });
});
