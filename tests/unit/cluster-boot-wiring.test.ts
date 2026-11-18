// Stage 6 wiring: worker migration wait, worker background switch, refresh backstop,
// leader refresh-for-worker handling, and cluster cache invalidation over the bus.
import test from "node:test";
import assert from "node:assert/strict";

import { enforceWorkerBackgroundSwitch } from "../../src/lib/cluster/role.ts";
import { createClusterBus, setClusterBus } from "../../src/lib/cluster/bus.ts";
import {
  refreshForWorker,
  installLeaderRefreshHandler,
} from "../../src/lib/cluster/leaderRefresh.ts";

const { waitForMigrationHead } = await import("../../src/lib/db/core.ts");
const { serializeRefresh, PassiveRefreshBlockedError } =
  await import("../../open-sse/services/refreshSerializer.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const { webRuntimeEnvSchema } = await import("../../src/lib/env/runtimeEnv.ts");

function withRole<T>(role: string | undefined, fn: () => T): T {
  const saved = process.env.OMNIROUTE_ROLE;
  if (role === undefined) delete process.env.OMNIROUTE_ROLE;
  else process.env.OMNIROUTE_ROLE = role;
  const restore = () => {
    if (saved === undefined) delete process.env.OMNIROUTE_ROLE;
    else process.env.OMNIROUTE_ROLE = saved;
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/** A clock that only moves when the test sleeps. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const backend = {} as never;

// ── Worker migration wait ────────────────────────────────────────────────────────────

test("worker wait: returns at once when the database is at this image's head", async () => {
  const clock = fakeClock();
  const head = await waitForMigrationHead(backend, {
    bundledHead: "pg-0003",
    readHead: async () => "pg-0003",
    ...clock,
    log: () => {},
  });
  assert.equal(head, "pg-0003");
});

test("worker wait: polls until the leader reaches the head", async () => {
  const clock = fakeClock();
  const heads = [null, "pg-0001", "pg-0002", "pg-0003"];
  let reads = 0;
  const head = await waitForMigrationHead(backend, {
    bundledHead: "pg-0003",
    readHead: async () => heads[Math.min(reads++, heads.length - 1)],
    pollMs: 1000,
    timeoutMs: 60_000,
    ...clock,
    log: () => {},
  });
  assert.equal(head, "pg-0003");
  assert.equal(reads, 4);
});

test("worker wait: a database newer than the image fails loudly (old worker image)", async () => {
  await assert.rejects(
    waitForMigrationHead(backend, {
      bundledHead: "pg-0003",
      readHead: async () => "pg-0004",
      ...fakeClock(),
      log: () => {},
    }),
    /newer than this image/
  );
});

test("worker wait: times out with a message naming the leader", async () => {
  await assert.rejects(
    waitForMigrationHead(backend, {
      bundledHead: "pg-0003",
      readHead: async () => "pg-0001",
      pollMs: 1000,
      timeoutMs: 5000,
      ...fakeClock(),
      log: () => {},
    }),
    /Is the leader running\?/
  );
});

// ── Worker background switch ────────────────────────────────────────────────────────

test("a worker turns OMNIROUTE_DISABLE_BACKGROUND_SERVICES on; other roles leave it", () => {
  const worker: Record<string, string | undefined> = { OMNIROUTE_ROLE: "worker" };
  assert.equal(enforceWorkerBackgroundSwitch(worker), true);
  assert.equal(worker.OMNIROUTE_DISABLE_BACKGROUND_SERVICES, "true");
  // The value must pass the startup env validation, or every worker refuses to boot
  // (found in the first PM2 run: "1" was rejected).
  const parsed = webRuntimeEnvSchema.safeParse({
    OMNIROUTE_DISABLE_BACKGROUND_SERVICES: worker.OMNIROUTE_DISABLE_BACKGROUND_SERVICES,
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));

  for (const role of [undefined, "leader"]) {
    const env: Record<string, string | undefined> = { OMNIROUTE_ROLE: role };
    assert.equal(enforceWorkerBackgroundSwitch(env), false);
    assert.equal(env.OMNIROUTE_DISABLE_BACKGROUND_SERVICES, undefined);
  }
});

// ── Refresh backstop ─────────────────────────────────────────────────────────────────

test("serializer backstop: a worker never runs a passive provider's refresh", async () => {
  let posts = 0;
  const post = async () => {
    posts++;
    return { accessToken: "new" };
  };
  await withRole("worker", async () => {
    for (const provider of ["claude", "codex", "kiro", "github"]) {
      await assert.rejects(serializeRefresh(provider, post), PassiveRefreshBlockedError);
    }
    // Google never rotates: a worker may refresh it.
    assert.deepEqual(await serializeRefresh("antigravity", post), { accessToken: "new" });
  });
  assert.equal(posts, 1);

  // Standalone keeps refreshing everything.
  await withRole(undefined, async () => {
    assert.deepEqual(await serializeRefresh("claude", post), { accessToken: "new" });
  });
  assert.equal(posts, 2);
});

// ── Leader refresh-for-worker ───────────────────────────────────────────────────────

const HOUR = 3_600_000;

function connection(overrides: Record<string, unknown> = {}) {
  return {
    provider: "claude",
    isActive: true,
    refreshToken: "rt",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
}

test("leader: refreshes an expired token, skips one that is already fresh", async () => {
  const refreshed: string[] = [];
  const refresh = async (_provider: string, _conn: unknown, id: string) => {
    refreshed.push(id);
  };
  assert.equal(
    await refreshForWorker("c1", "expired", { readConnection: async () => connection(), refresh }),
    "refreshed"
  );
  const fresh = connection({ expiresAt: new Date(Date.now() + HOUR).toISOString() });
  assert.equal(
    await refreshForWorker("c2", "expired", { readConnection: async () => fresh, refresh }),
    "skipped"
  );
  // A token the worker saw rejected is refreshed even though it has not expired.
  assert.equal(
    await refreshForWorker("c3", "rejected", { readConnection: async () => fresh, refresh }),
    "refreshed"
  );
  for (const conn of [null, connection({ isActive: false }), connection({ refreshToken: "" })]) {
    assert.equal(
      await refreshForWorker("c4", "expired", { readConnection: async () => conn, refresh }),
      "skipped"
    );
  }
  assert.deepEqual(refreshed, ["c1", "c3"]);
});

test("leader: duplicate and rapid requests for one connection run one refresh", async () => {
  let refreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let now = 0;
  const unregister = installLeaderRefreshHandler({
    // The fake clock also drives the expiry check, so the token must be expired at t=0.
    readConnection: async () => connection({ expiresAt: new Date(0).toISOString() }),
    refresh: async () => {
      refreshes++;
      await gate;
    },
    now: () => now,
    minIntervalMs: 15_000,
    warn: () => {},
  });
  const bus = createClusterBus({
    publisher: { publish: async () => 1 },
    subscriber: { subscribe: async () => 1, on: () => undefined },
    instanceId: "leader",
  });
  const send = (id: string) =>
    bus.dispatch(
      "cluster:refresh-request",
      JSON.stringify({ connectionId: id, reason: "expired", origin: "worker-1" })
    );
  try {
    send("c1");
    send("c1"); // in flight
    await new Promise((r) => setTimeout(r, 10));
    release();
    await new Promise((r) => setTimeout(r, 10));
    now = 5_000;
    send("c1"); // inside the minimum interval
    send("c2"); // another connection is independent
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(refreshes, 2);
    now = 20_000;
    send("c1");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(refreshes, 3);
  } finally {
    unregister();
  }
});

// ── Bundle copies share one bus ─────────────────────────────────────────────────────

test("a second copy of bus.ts (another Next bundle) publishes through the bus installed by the first", async () => {
  // Next compiles instrumentation and route handlers into separate bundles: the boot code
  // installs the bus in its copy of the module, routes publish from theirs (found in the
  // first local PM2 run: a deleted API key kept working on the workers).
  const copy = await import(`../../src/lib/cluster/bus.ts?bundle-copy=${Date.now()}`);
  const sent: string[] = [];
  const bus = createClusterBus({
    publisher: { publish: async (_channel, message) => void sent.push(message) },
    subscriber: { subscribe: async () => 1, on: () => undefined },
    instanceId: "boot-copy",
  });
  setClusterBus(bus);
  let received = 0;
  const unregister = copy.onInvalidation("bundle-test", () => received++);
  try {
    copy.publishInvalidation("bundle-test");
    assert.equal(sent.length, 1, "the route-side copy found the boot-side bus");
    bus.dispatch(
      "cluster:invalidate",
      JSON.stringify({ scope: "bundle-test", origin: "another-process" })
    );
    assert.equal(received, 1, "a handler registered in the other copy receives the message");
  } finally {
    unregister();
    setClusterBus(null);
  }
});

// ── Cluster boot failures end the process ──────────────────────────────────────────

test("a failed cluster boot step exits with code 1; a passing one returns its value", async () => {
  const { exitOnClusterBootFailure } = await import("../../src/instrumentation-node.ts");
  const codes: number[] = [];
  const exit = ((code: number) => {
    codes.push(code);
    throw new Error("exited");
  }) as (code: number) => never;
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(await exitOnClusterBootFailure(async () => 42, "ok step", exit), 42);
    await assert.rejects(
      exitOnClusterBootFailure(
        async () => {
          throw new Error('Leader fence cluster:leader is held by "omniroute-1"');
        },
        "cluster start",
        exit
      ),
      /exited/
    );
  } finally {
    console.error = error;
  }
  // Found in the local PM2 run: a refused second leader stayed up without a boot.
  assert.deepEqual(codes, [1]);
});

// ── Cache invalidation over the bus ─────────────────────────────────────────────────

test("a write publishes db-cache; a received message drops the local cache", async () => {
  const published: Array<{ channel: string; message: Record<string, unknown> }> = [];
  const bus = createClusterBus({
    publisher: {
      publish: async (channel, message) => {
        published.push({ channel, message: JSON.parse(message) });
        return 1;
      },
    },
    subscriber: { subscribe: async () => 1, on: () => undefined },
    instanceId: "omniroute-1",
  });
  setClusterBus(bus);
  try {
    readCache.invalidateDbCache("settings", undefined, { skipModelCatalog: true });
    assert.deepEqual(published.at(-1), {
      channel: "cluster:invalidate",
      message: {
        scope: "db-cache",
        data: { scope: "settings", skipModelCatalog: true },
        origin: "omniroute-1",
      },
    });

    // A peer's catalog-relevant write bumps this process's catalog version.
    const before = readCache.getModelCatalogCacheVersion();
    const count = published.length;
    bus.dispatch(
      "cluster:invalidate",
      JSON.stringify({ scope: "db-cache", data: { scope: "combos" }, origin: "omniroute-2" })
    );
    assert.ok(readCache.getModelCatalogCacheVersion() > before);
    // Received messages are never republished.
    assert.equal(published.length, count);
  } finally {
    setClusterBus(null);
  }
});
