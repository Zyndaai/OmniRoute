import test from "node:test";
import assert from "node:assert/strict";

import {
  INVALIDATE_CHANNEL,
  REFRESH_REQUEST_CHANNEL,
  createClusterBus,
  getClusterBus,
  onInvalidation,
  onRefreshRequest,
  publishInvalidation,
  setClusterBus,
  type BusPublisher,
  type BusSubscriber,
} from "../../../src/lib/cluster/bus.ts";

/** One in-memory Redis channel space shared by several fake processes. */
function fakeNetwork() {
  const listeners: Array<(channel: string, message: string) => void> = [];
  const published: Array<{ channel: string; message: string }> = [];
  const publisher: BusPublisher = {
    async publish(channel, message) {
      published.push({ channel, message });
      for (const listener of listeners) listener(channel, message);
      return listeners.length;
    },
  };
  const subscriber = (): BusSubscriber => {
    let listener: ((channel: string, message: string) => void) | null = null;
    return {
      on(_event, fn) {
        listener = fn;
      },
      async subscribe() {
        if (listener) listeners.push(listener);
      },
    };
  };
  return { publisher, subscriber, published };
}

const quiet = () => {};

test("an invalidation reaches other processes, not the sender", async () => {
  const net = fakeNetwork();
  const leader = createClusterBus({
    publisher: net.publisher,
    subscriber: net.subscriber(),
    instanceId: "omniroute-1",
    warn: quiet,
  });
  const worker = createClusterBus({
    publisher: net.publisher,
    subscriber: net.subscriber(),
    instanceId: "omniroute-2",
    warn: quiet,
  });
  await leader.start();
  await worker.start();

  const received: Array<string | undefined> = [];
  const off = onInvalidation("test-scope-a", (id) => received.push(id));
  try {
    leader.publishInvalidation("test-scope-a", "key-1");
    await new Promise((resolve) => setImmediate(resolve));
    // Delivered to omniroute-2 only: the sender ignores its own origin.
    assert.deepEqual(received, ["key-1"]);
  } finally {
    off();
  }
});

test("invalidation data travels with the message", () => {
  const net = fakeNetwork();
  const bus = createClusterBus({
    publisher: net.publisher,
    subscriber: net.subscriber(),
    instanceId: "b",
    warn: quiet,
  });
  const seen: unknown[] = [];
  const off = onInvalidation("test-scope-d", (id, data) => seen.push([id, data]));
  try {
    bus.dispatch(
      INVALIDATE_CHANNEL,
      JSON.stringify({
        scope: "test-scope-d",
        id: "c1",
        data: { skipModelCatalog: true },
        origin: "a",
      })
    );
    bus.dispatch(
      INVALIDATE_CHANNEL,
      JSON.stringify({ scope: "test-scope-d", data: [1], origin: "a" })
    );
    assert.deepEqual(seen, [
      ["c1", { skipModelCatalog: true }],
      [undefined, undefined],
    ]);
  } finally {
    off();
  }
});

test("a received message never republishes (local-only handlers)", async () => {
  const net = fakeNetwork();
  const bus = createClusterBus({
    publisher: net.publisher,
    subscriber: net.subscriber(),
    instanceId: "omniroute-2",
    warn: quiet,
  });
  let calls = 0;
  const off = onInvalidation("test-scope-b", () => calls++);
  try {
    bus.dispatch(
      INVALIDATE_CHANNEL,
      JSON.stringify({ scope: "test-scope-b", origin: "omniroute-1" })
    );
    assert.equal(calls, 1);
    assert.equal(net.published.length, 0);
  } finally {
    off();
  }
});

test("refresh requests reach the registered handler; malformed messages are dropped", () => {
  const net = fakeNetwork();
  const warnings: string[] = [];
  const bus = createClusterBus({
    publisher: net.publisher,
    subscriber: net.subscriber(),
    instanceId: "omniroute-1",
    warn: (line) => warnings.push(line),
  });
  const requested: string[] = [];
  const off = onRefreshRequest((id) => requested.push(id));
  try {
    bus.dispatch(
      REFRESH_REQUEST_CHANNEL,
      JSON.stringify({ connectionId: "conn-1", origin: "omniroute-2" })
    );
    bus.dispatch(REFRESH_REQUEST_CHANNEL, "{not json");
    bus.dispatch(
      REFRESH_REQUEST_CHANNEL,
      JSON.stringify({ connectionId: 7, origin: "omniroute-2" })
    );
    assert.deepEqual(requested, ["conn-1"]);
    assert.equal(warnings.length, 1);
  } finally {
    off();
  }
});

test("a failing handler does not stop the others", () => {
  const net = fakeNetwork();
  const bus = createClusterBus({
    publisher: net.publisher,
    subscriber: net.subscriber(),
    instanceId: "x",
    warn: quiet,
  });
  let reached = false;
  const offA = onInvalidation("test-scope-c", () => {
    throw new Error("boom");
  });
  const offB = onInvalidation("test-scope-c", () => (reached = true));
  try {
    bus.dispatch(INVALIDATE_CHANNEL, JSON.stringify({ scope: "test-scope-c", origin: "y" }));
    assert.equal(reached, true);
  } finally {
    offA();
    offB();
  }
});

test("standalone (no bus installed): publishing is a no-op", () => {
  assert.equal(getClusterBus(), null);
  assert.doesNotThrow(() => publishInvalidation("settings"));
  const net = fakeNetwork();
  setClusterBus(
    createClusterBus({
      publisher: net.publisher,
      subscriber: net.subscriber(),
      instanceId: "i",
      warn: quiet,
    })
  );
  try {
    publishInvalidation("settings", "k");
    assert.equal(net.published.length, 1);
    assert.deepEqual(JSON.parse(net.published[0].message), {
      scope: "settings",
      id: "k",
      origin: "i",
    });
  } finally {
    setClusterBus(null);
  }
});
