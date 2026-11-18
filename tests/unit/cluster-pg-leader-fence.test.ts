// Runs against the per-file test database (tests/_setup/isolatePostgres.ts): advisory locks are
// per database, so this file cannot collide with other test files.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

import {
  FENCE_APPLICATION_PREFIX,
  acquirePgLeaderFence,
  readPgLeaderHolder,
} from "../../src/lib/cluster/pgLeaderFence.ts";
import { LeaderFenceHeldError } from "../../src/lib/cluster/leaderFence.ts";

const url = process.env.OMNIROUTE_POSTGRES_URL;
const quiet = () => {};
const opened: pg.Client[] = [];

async function connect(instanceId: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    application_name: FENCE_APPLICATION_PREFIX + instanceId,
  });
  // A killed session emits "error"; the fence listens too, but node-postgres needs one
  // listener before connect so an early error never crashes the test process.
  client.on("error", () => {});
  await client.connect();
  opened.push(client);
  return client;
}

test.after(async () => {
  await Promise.all(opened.map((c) => c.end().catch(() => undefined)));
});

function manualTimer() {
  let fn: (() => void) | null = null;
  return {
    setInterval: (cb: () => void) => ((fn = cb), 1),
    clearInterval: () => {
      fn = null;
    },
    async tick() {
      fn?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

test(
  "one leader at a time; the holder is named; release frees the lock",
  { skip: !url },
  async () => {
    const first = await acquirePgLeaderFence({
      client: await connect("omniroute-1"),
      instanceId: "omniroute-1",
      log: quiet,
      ...manualTimer(),
    });
    const observer = await connect("observer");
    assert.equal(await readPgLeaderHolder(observer), "omniroute-1");

    await assert.rejects(
      acquirePgLeaderFence({
        client: await connect("omniroute-3"),
        instanceId: "omniroute-3",
        log: quiet,
      }),
      (error: unknown) => error instanceof LeaderFenceHeldError && error.holder === "omniroute-1"
    );

    await first.release();
    assert.equal(await readPgLeaderHolder(observer), null);
    const next = await acquirePgLeaderFence({
      client: await connect("omniroute-3"),
      instanceId: "omniroute-3",
      log: quiet,
      ...manualTimer(),
    });
    await next.release();
  }
);

test("a killed fence session is reported as lost", { skip: !url }, async () => {
  const timer = manualTimer();
  let lost = "";
  const client = await connect("omniroute-1");
  const fence = await acquirePgLeaderFence({
    client,
    instanceId: "omniroute-1",
    onLost: (reason) => (lost = reason),
    log: quiet,
    ...timer,
  });
  const admin = await connect("admin");
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
    [FENCE_APPLICATION_PREFIX + "omniroute-1"]
  );
  // The connection error/end event or the next probe notices the session is gone.
  for (let i = 0; i < 20 && !lost; i++) await timer.tick();
  assert.match(lost, /fence (connection|probe)/);
  // The server released the lock with the session: another leader can start.
  assert.equal(await readPgLeaderHolder(admin), null);
  await fence.release();
});
