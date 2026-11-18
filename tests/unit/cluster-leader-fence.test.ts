import test from "node:test";
import assert from "node:assert/strict";

import {
  LEADER_FENCE_KEY,
  LeaderFenceHeldError,
  acquireLeaderFence,
  readLeaderHolder,
  type FenceRedis,
} from "../../src/lib/cluster/leaderFence.ts";

/** In-memory Redis for the three commands the fence uses, with a manual clock. */
function fakeRedis(clock: { now: number }) {
  const store = new Map<string, { value: string; expiresAt: number }>();
  let failing = false;
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt <= clock.now) store.delete(key);
    return store.get(key);
  };
  const redis: FenceRedis & { setFailing(v: boolean): void; steal(holder: string): void } = {
    async set(key, value, _px, ttlMs, _nx) {
      if (failing) throw new Error("connection refused");
      if (live(key)) return null;
      store.set(key, { value, expiresAt: clock.now + ttlMs });
      return "OK";
    },
    async get(key) {
      if (failing) throw new Error("connection refused");
      return live(key)?.value ?? null;
    },
    async eval(script, _numKeys, key, id, ttlMs) {
      if (failing) throw new Error("connection refused");
      const entry = live(String(key));
      if (!entry || entry.value !== id) return 0;
      if (script.includes("pexpire")) entry.expiresAt = clock.now + Number(ttlMs);
      else store.delete(String(key));
      return 1;
    },
    setFailing(v) {
      failing = v;
    },
    steal(holder) {
      store.set(LEADER_FENCE_KEY, { value: holder, expiresAt: clock.now + 30_000 });
    },
  };
  return redis;
}

/** Manual interval driver: tick() runs the registered renew callback once. */
function manualTimer() {
  let fn: (() => void) | null = null;
  return {
    setInterval: (cb: () => void) => {
      fn = cb;
      return 1;
    },
    clearInterval: () => {
      fn = null;
    },
    async tick() {
      fn?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    get active() {
      return fn !== null;
    },
  };
}

const quiet = () => {};

test("the first leader acquires; a second instance is refused", async () => {
  const clock = { now: 0 };
  const redis = fakeRedis(clock);
  const first = await acquireLeaderFence({
    redis,
    instanceId: "omniroute-1",
    log: quiet,
    ...manualTimer(),
  });
  assert.equal(await readLeaderHolder(redis), "omniroute-1");

  await assert.rejects(
    acquireLeaderFence({ redis, instanceId: "omniroute-3", log: quiet, ...manualTimer() }),
    (error: unknown) => error instanceof LeaderFenceHeldError && error.holder === "omniroute-1"
  );
  await first.release();
  assert.equal(await readLeaderHolder(redis), null);
});

test("the same instance id takes its own lease back after a restart", async () => {
  const clock = { now: 0 };
  const redis = fakeRedis(clock);
  await acquireLeaderFence({ redis, instanceId: "omniroute-1", log: quiet, ...manualTimer() });
  // Process restarts within the TTL with the same id.
  const again = await acquireLeaderFence({
    redis,
    instanceId: "omniroute-1",
    log: quiet,
    ...manualTimer(),
  });
  assert.equal(again.instanceId, "omniroute-1");
});

test("renewal keeps the lease past its TTL", async () => {
  const clock = { now: 0 };
  const redis = fakeRedis(clock);
  const timer = manualTimer();
  let lost = "";
  await acquireLeaderFence({
    redis,
    instanceId: "omniroute-1",
    now: () => clock.now,
    onLost: (reason) => (lost = reason),
    log: quiet,
    ...timer,
  });
  for (let i = 0; i < 6; i++) {
    clock.now += 10_000;
    await timer.tick();
  }
  assert.equal(lost, "");
  assert.equal(await readLeaderHolder(redis), "omniroute-1");
});

test("a lease taken by another process is reported as lost", async () => {
  const clock = { now: 0 };
  const redis = fakeRedis(clock);
  const timer = manualTimer();
  let lost = "";
  await acquireLeaderFence({
    redis,
    instanceId: "omniroute-1",
    now: () => clock.now,
    onLost: (reason) => (lost = reason),
    log: quiet,
    ...timer,
  });
  redis.steal("omniroute-9");
  clock.now += 10_000;
  await timer.tick();
  assert.match(lost, /held by another process/);
  assert.equal(timer.active, false, "renewal stops after the lease is lost");
});

test("Redis down: one failed renewal is tolerated, the lease is given up before it can expire", async () => {
  const clock = { now: 0 };
  const redis = fakeRedis(clock);
  const timer = manualTimer();
  let lost = "";
  await acquireLeaderFence({
    redis,
    instanceId: "omniroute-1",
    now: () => clock.now,
    onLost: (reason) => (lost = reason),
    log: quiet,
    ...timer,
  });
  redis.setFailing(true);
  clock.now += 10_000;
  await timer.tick();
  assert.equal(lost, "", "10 s without renewal is still inside the 30 s lease");
  clock.now += 10_000;
  await timer.tick();
  assert.match(lost, /renewal failed/);
});

test("renewMs must be shorter than the TTL", async () => {
  const redis = fakeRedis({ now: 0 });
  await assert.rejects(
    acquireLeaderFence({ redis, instanceId: "a", ttlMs: 1000, renewMs: 1000, log: quiet }),
    /renewMs/
  );
});
