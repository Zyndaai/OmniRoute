// LISTEN/NOTIFY transport against the per-file test database (tests/_setup/isolatePostgres.ts).
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import {
  INVALIDATE_CHANNEL,
  REFRESH_REQUEST_CHANNEL,
  createClusterBus,
  onBusResync,
  onInvalidation,
  runBusResync,
} from "../../src/lib/cluster/bus.ts";
import { createPgBusPublisher, createPgBusSubscriber } from "../../src/lib/cluster/pgBus.ts";

const url = process.env.OMNIROUTE_POSTGRES_URL;
const quiet = () => {};
const opened: pg.Client[] = [];

async function connect(name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: name });
  client.on("error", () => {});
  await client.connect();
  opened.push(client);
  return client;
}

test.after(async () => {
  await Promise.all(opened.map((c) => c.end().catch(() => undefined)));
});

async function waitFor(predicate: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return predicate();
}

test("an invalidation crosses processes over LISTEN/NOTIFY", { skip: !url }, async () => {
  const pubClient = await connect("publisher");
  const publisher = createPgBusPublisher((text, values) => pubClient.query(text, values));
  const subscriber = createPgBusSubscriber({
    connect: () => connect("omniroute-2:listen"),
    onReconnect: () => runBusResync(quiet),
    warn: quiet,
  });
  const leader = createClusterBus({
    publisher,
    subscriber: { on() {}, async subscribe() {} },
    instanceId: "omniroute-1",
    warn: quiet,
  });
  const worker = createClusterBus({
    publisher,
    subscriber,
    instanceId: "omniroute-2",
    warn: quiet,
  });
  await worker.start();

  const seen: Array<string | undefined> = [];
  const off = onInvalidation("pg-bus-scope", (id) => seen.push(id));
  try {
    leader.publishInvalidation("pg-bus-scope", "key-7");
    assert.ok(await waitFor(() => seen.length === 1), "notification delivered");
    assert.deepEqual(seen, ["key-7"]);
  } finally {
    off();
    await subscriber.close();
  }
});

test(
  "after the listener connection is killed it reconnects and resyncs",
  { skip: !url },
  async () => {
    const pubClient = await connect("publisher-2");
    const publisher = createPgBusPublisher((text, values) => pubClient.query(text, values));
    let resyncs = 0;
    const offResync = onBusResync(() => resyncs++);
    const subscriber = createPgBusSubscriber({
      connect: () => connect("omniroute-3:listen"),
      onReconnect: () => runBusResync(quiet),
      minRetryMs: 50,
      warn: quiet,
    });
    const worker = createClusterBus({
      publisher,
      subscriber,
      instanceId: "omniroute-3",
      warn: quiet,
    });
    await worker.start();
    const seen: string[] = [];
    const off = onInvalidation("pg-bus-scope-2", (id) => seen.push(String(id)));
    try {
      const admin = await connect("admin");
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'omniroute-3:listen'"
      );
      assert.ok(await waitFor(() => resyncs === 1), "resync after reconnect");

      // LISTEN is re-issued on the new session: messages flow again.
      await publisher.publish(
        INVALIDATE_CHANNEL,
        JSON.stringify({ scope: "pg-bus-scope-2", id: "after", origin: "omniroute-1" })
      );
      assert.ok(await waitFor(() => seen.includes("after")), "delivered after reconnect");
    } finally {
      off();
      offResync();
      await subscriber.close();
    }
  }
);

test("channel names with a colon are quoted for LISTEN", { skip: !url }, async () => {
  const subscriber = createPgBusSubscriber({
    connect: () => connect("quote-check"),
    onReconnect: quiet,
    warn: quiet,
  });
  await subscriber.subscribe(INVALIDATE_CHANNEL, REFRESH_REQUEST_CHANNEL);
  await subscriber.close();
});
