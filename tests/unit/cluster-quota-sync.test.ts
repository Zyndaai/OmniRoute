// Quota cache sync across cluster processes (src/domain/quotaCache.ts): changed entries and
// 429 marks travel over the bus; receivers keep the newer observation and never republish.
import test from "node:test";
import assert from "node:assert/strict";

import { createClusterBus, setClusterBus } from "../../src/lib/cluster/bus.ts";

const quota = await import("../../src/domain/quotaCache.ts");
const { getQuotaCacheState } = await import("../../src/domain/quotaCacheState.ts");
const { withQuotaCacheReadView } = await import("../../src/domain/quotaCacheReadView.ts");

type BusMessage = {
  scope?: string;
  id?: string;
  data?: { entry?: string; reload?: boolean; healthyUntil?: number };
};
type Sent = { channel: string; message: BusMessage };

function installBus(instanceId = "worker-0") {
  const sent: Sent[] = [];
  const bus = createClusterBus({
    publisher: {
      publish: async (channel, message) => {
        sent.push({ channel, message: JSON.parse(message) });
        return 1;
      },
    },
    subscriber: { subscribe: async () => 1, on: () => undefined },
    instanceId,
  });
  setClusterBus(bus);
  return { bus, sent };
}

function receive(bus: ReturnType<typeof createClusterBus>, message: Record<string, unknown>) {
  bus.dispatch("cluster:invalidate", JSON.stringify({ ...message, origin: "another-process" }));
}

test.afterEach(() => {
  setClusterBus(null);
  quota.__clearForTests();
  getQuotaCacheState().healthyUntil.clear();
});

test("a 429 mark is published as a whole entry and parks the account on the receiver", () => {
  const { bus, sent } = installBus();
  quota.markAccountExhaustedFrom429("conn-429", "claude");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.scope, "quota");
  assert.equal(sent[0].message.id, "conn-429");
  const entry = JSON.parse(sent[0].message.data.entry);
  assert.equal(entry.exhausted, true);

  // Another process: the account was healthy there; the message parks it.
  quota.__clearForTests();
  getQuotaCacheState().healthyUntil.set("conn-429", Date.now() + 60_000);
  receive(bus, { scope: "quota", id: "conn-429", data: { entry: sent[0].message.data.entry } });
  assert.equal(quota.isAccountQuotaExhausted("conn-429"), true);
  assert.equal(getQuotaCacheState().healthyUntil.has("conn-429"), false);
  assert.equal(sent.length, 1, "a received entry is never republished");
});

test("an older entry never overwrites a newer local observation", () => {
  const { bus } = installBus();
  const newer = {
    connectionId: "conn-order",
    provider: "claude",
    quotas: {},
    modelQuotas: {},
    fetchedAt: 2000,
    exhausted: false,
    nextResetAt: null,
  };
  getQuotaCacheState().cache.set("conn-order", newer);
  const older = { ...newer, fetchedAt: 1000, exhausted: true };
  receive(bus, { scope: "quota", id: "conn-order", data: { entry: JSON.stringify(older) } });
  assert.equal(getQuotaCacheState().cache.get("conn-order")?.exhausted, false);
});

test("an unchanged refresh publishes nothing; a change publishes once", () => {
  const { sent } = installBus();
  const windows = { session: { remainingPercentage: 40, resetAt: null } };
  quota.setQuotaCache("conn-refresh", "claude", windows);
  const afterFirst = sent.length;
  assert.ok(afterFirst >= 1, "the first observation is shared");
  quota.setQuotaCache("conn-refresh", "claude", windows);
  assert.equal(sent.length, afterFirst, "same values: nothing sent");
  quota.setQuotaCache("conn-refresh", "claude", {
    session: { remainingPercentage: 0, resetAt: null },
  });
  assert.equal(sent.length, afterFirst + 1, "a real change is sent");
});

test("a private read view never publishes", () => {
  const { sent } = installBus();
  withQuotaCacheReadView(() => quota.markAccountExhaustedFrom429("conn-view", "claude"));
  assert.equal(sent.length, 0);
});

test("the healthy override is shared once per window, and only when it turns on", () => {
  const { bus, sent } = installBus();
  quota.markQuotaHealthy("conn-healthy");
  quota.markQuotaHealthy("conn-healthy");
  const healthyMessages = sent.filter((s) => typeof s.message.data?.healthyUntil === "number");
  assert.equal(healthyMessages.length, 1);

  getQuotaCacheState().healthyUntil.clear();
  receive(bus, { scope: "quota", id: "conn-healthy", data: healthyMessages[0].message.data });
  assert.equal(getQuotaCacheState().healthyUntil.has("conn-healthy"), true);
});

test("standalone (no bus) publishes nothing and behaves as before", () => {
  setClusterBus(null);
  quota.markAccountExhaustedFrom429("conn-standalone", "claude");
  assert.equal(quota.isAccountQuotaExhausted("conn-standalone"), true);
});
