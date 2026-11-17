/** JobRegistry runtime tests . Uses real timers + isolated temp DB. */

// Access private internals (avoids `as any`).
type TestRegistry = JobRegistry & {
  timers: Map<string, unknown>;
  cronFailCount: Map<string, number>;
  queued: Set<string>;
};
function regInternals(reg: JobRegistry): TestRegistry {
  return reg as TestRegistry;
}

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { JobDefinition } from "@/lib/jobRegistry/core.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-jr-rt-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("@/lib/db/core.ts");
const { db } = await import("@/lib/db/pg.ts");
const { resetTestDb } = await import("../../../helpers/postgres.ts");
const index = await import("@/lib/jobRegistry/index.ts");
const { getJobRegistry, __resetJobRegistry } = index;

/**
 * Fail the job_runs writes of the given kind while leaving every other statement
 * and the real database intact. Failed attempts are counted; `recover()` lets the
 * writes through again.
 */
function failHistoryWrites(t: TestContext, operations: Array<"record" | "prune">) {
  const backend = db();
  const execute = backend.execute.bind(backend);
  const attempts: Array<"record" | "prune"> = [];
  let failing = true;
  t.mock.method(backend, "execute", (sql: string, params?: readonly unknown[]) => {
    const operation = /^\s*INSERT INTO job_runs\b/.test(sql)
      ? "record"
      : /^\s*DELETE FROM job_runs\b/.test(sql)
        ? "prune"
        : null;
    if (!operation || !operations.includes(operation)) return execute(sql, params);
    attempts.push(operation);
    if (failing) throw new Error("database is locked");
    return execute(sql, params);
  });
  return {
    attempts,
    recover() {
      failing = false;
    },
  };
}

/** Polls `cond` (checking between real event-loop turns) until it holds. */
async function waitFor(cond: () => unknown, maxTurns = 4000): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (await cond()) return;
    await settle();
  }
  assert.fail("condition was not met in time");
}

let nowIso: string;
function def(
  id: string,
  handler: () => Promise<{ success: boolean; recordsAffected?: number; error?: string }>,
  over: Record<string, unknown> = {}
): JobDefinition {
  return {
    id,
    type: "interval",
    cron: null,
    intervalMs: 100000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: nowIso,
    updatedAt: nowIso,
    handler,
    ...over,
  } as JobDefinition;
}

async function resetAll() {
  // Stop any live timers on the current singleton before wiping the DB, otherwise
  // an in-flight safeRun from the previous test writes to a closed/wiped DB (FK error).
  try {
    getJobRegistry().stopAll();
  } catch {
    // no singleton yet on first run
  }
  __resetJobRegistry();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  nowIso = new Date().toISOString();
  await resetAll();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("register + start (interval) fires handler immediately", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def("j", async () => {
      calls++;
      return { success: true, recordsAffected: 0 };
    })
  );
  await reg.start("j");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1, "interval fires once on start");
  reg.stop("j");
});

test("re-entrancy: second tick skipped while handler is running", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  let release: (v: void) => void = () => {};
  const gate = new Promise<void>((res) => (release = res));
  await reg.register(
    def(
      "j",
      async () => {
        calls++;
        await gate;
        return { success: true };
      },
      { intervalMs: 30 }
    )
  );
  await reg.start("j"); // fires immediately, blocks on gate
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  // ~100ms passes; setInterval would tick again but must be skipped (running guard).
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls, 1, "must not re-enter while handler runs");
  release();
  await new Promise((r) => setTimeout(r, 30));
  reg.stop("j");
});

test("cron nextTick: handler fires via recursive setTimeout", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def(
      "j",
      async () => {
        calls++;
        return { success: true };
      },
      {
        type: "cron",
        cron: "* * * * * *", // every second (6-field) for fast deterministic test
        intervalMs: null,
        config: { timezone: "UTC" },
      }
    )
  );
  await reg.start("j");
  await new Promise((r) => setTimeout(r, 1400));
  reg.stop("j");
  assert.ok(calls >= 1, `cron handler should fire at least once, got ${calls}`);
});

test("runNow: manual trigger starts a disabled job's run", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def("j", async () => {
      calls++;
      return { success: true };
    })
  );
  const res = await reg.runNow("j");
  assert.deepEqual(res, { started: true });
  await waitFor(() => calls === 1);
});

test("runNow: disabled job returns reason=disabled", async () => {
  const reg = getJobRegistry();
  await reg.register(def("j", async () => ({ success: true }), { enabled: false }));
  const res = await reg.runNow("j");
  assert.deepEqual(res, { started: false, reason: "disabled" });
});

test("runNow: unknown job returns reason=not_found", async () => {
  const reg = getJobRegistry();
  const res = await reg.runNow("nope");
  assert.deepEqual(res, { started: false, reason: "not_found" });
});

test("runNow: queue depth=1, coalesces concurrent triggers then re-runs", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  let release: (v: void) => void = () => {};
  const gate = new Promise<void>((res) => (release = res));
  await reg.register(
    def("j", async () => {
      calls++;
      await gate;
      return { success: true };
    })
  );
  const first = await reg.runNow("j"); // starts, blocks on gate
  assert.deepEqual(first, { started: true });
  // While running, a second runNow should queue (depth=1) and resolve after.
  const queued = reg.runNow("j");
  await waitFor(() => regInternals(reg).queued.has("j"));
  // The queued promise must not pile up: only one extra fire after release.
  release();
  const queuedRes = await queued;
  await waitFor(() => calls === 2);
  assert.equal(calls, 2, "initial + one queued re-run = 2 fires, no pile-up");
  assert.deepEqual(queuedRes, { started: true });
});

test("runNow: env gate blocks when env explicitly disabled", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def("j", async () => ({ success: true }), { envFlag: "OMNIROUTE_TEST_JOB_ENABLED" })
  );
  process.env.OMNIROUTE_TEST_JOB_ENABLED = "0";
  const res = await reg.runNow("j");
  delete process.env.OMNIROUTE_TEST_JOB_ENABLED;
  assert.deepEqual(res, { started: false, reason: "env_disabled" });
  assert.equal(calls, 0);
});

test("setEnabled(false) stops timer; handler no longer fires", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def(
      "j",
      async () => {
        calls++;
        return { success: true };
      },
      { intervalMs: 40 }
    )
  );
  await reg.start("j");
  await new Promise((r) => setTimeout(r, 25));
  await reg.setEnabled("j", false);
  await new Promise((r) => setTimeout(r, 120));
  reg.stop("j");
  assert.equal(calls, 1, "only the immediate fire before disable");
});

test("setEnabled(true) restarts a stopped job", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def(
      "j",
      async () => {
        calls++;
        return { success: true };
      },
      { intervalMs: 40 }
    )
  );
  await reg.setEnabled("j", true);
  await new Promise((r) => setTimeout(r, 130));
  reg.stop("j");
  assert.ok(calls >= 2, `expected repeated fires, got ${calls}`);
});

test("envFlag gate generic: unset env fires (defaultWhenUnset=true)", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def(
      "j",
      async () => {
        calls++;
        return { success: true };
      },
      {
        type: "cron",
        cron: "* * * * * *",
        intervalMs: null,
        envFlag: "OMNIROUTE_GENERIC_JOB_ENABLED", // unset -> default true -> fires
        config: { timezone: "UTC" },
      }
    )
  );
  await reg.start("j");
  await new Promise((r) => setTimeout(r, 1400));
  reg.stop("j");
  assert.ok(calls >= 1, "unset env with default=true should fire");
});

test("envFlag gate warmup: unset env does NOT fire (envDefault=false)", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def("j", async () => ({ success: true }), {
      type: "cron",
      cron: "* * * * * *",
      intervalMs: null,
      envFlag: "OMNIROUTE_WARMUP_ENABLED",
      config: { timezone: "UTC", envDefault: false },
    })
  );
  await reg.start("j");
  await new Promise((r) => setTimeout(r, 1400));
  reg.stop("j");
  assert.equal(calls, 0, "unset env with envDefault=false must not fire");
});

test("startAll: registers + starts all enabled jobs; throws if no handlers", async () => {
  const reg = getJobRegistry();
  await assert.rejects(() => reg.startAll(), /No handlers registered/);

  let a = 0;
  let b = 0;
  await reg.register(
    def("a", async () => {
      a++;
      return { success: true, recordsAffected: 0 };
    })
  );
  await reg.register(
    def("b", async () => {
      b++;
      return { success: true, recordsAffected: 0 };
    })
  );
  await reg.startAll();
  await waitFor(() => a >= 1 && b >= 1);
  assert.ok(a >= 1, "job a started");
  assert.ok(b >= 1, "job b started");
  reg.stopAll();
});

test("startAll isolation: a missing handler skips that job, starts the rest", async () => {
  const reg = getJobRegistry();
  let a = 0;
  await reg.register(
    def("a", async () => {
      a++;
      return { success: true, recordsAffected: 0 };
    })
  );
  // Seed a job in DB with no handler registered in the registry.
  const { upsertJob } = await import("@/lib/db/jobRegistryDb.ts");
  await upsertJob({
    id: "orphan",
    type: "interval",
    cron: null,
    intervalMs: 1000,
    enabled: true,
    envFlag: null,
    config: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  await reg.startAll();
  await waitFor(() => a >= 1);
  assert.ok(a >= 1, "registered job a still starts despite orphan in DB");
  reg.stopAll();
});

test("startAll isolation: one job whose start() throws does not abort the rest", async () => {
  const reg = getJobRegistry();
  let a = 0;
  let c = 0;
  for (const [id, counter] of [
    ["a", () => a++],
    ["boom", () => 0],
    ["c", () => c++],
  ] as Array<[string, () => number]>) {
    await reg.register(
      def(id, async () => {
        counter();
        return { success: true, recordsAffected: 0 };
      })
    );
  }

  // start() reads the DB (getJob), so it can throw for one job while the others
  // are fine. Nothing in the registry catches per-job, so this asserts the loop
  // in startAll() isolates it.
  const realStart = reg.start.bind(reg);
  reg.start = (jobId: string) => {
    if (jobId === "boom") throw new Error("start blew up for boom");
    return realStart(jobId);
  };

  try {
    await reg.startAll();
  } finally {
    reg.start = realStart;
  }

  await waitFor(() => a >= 1 && c >= 1);
  assert.ok(a >= 1, "job registered before the throwing one still started");
  assert.ok(c >= 1, "job registered after the throwing one still started");
  reg.stopAll();
});

test("error isolation: handler throw records failure and survives", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def("j", async () => {
      calls++;
      if (calls === 1) throw new Error("boom at /some/file.ts");
      return { success: true };
    })
  );
  await reg.runNow("j");
  await waitFor(async () => (await reg.getRuns("j")).length === 1);
  const runs = await reg.getRuns("j");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failure");
  // Error message must be sanitized - no stack path leaked.
  assert.ok(!runs[0].errorMessage?.includes("at /"), "error must be sanitized");
});

test("getRuns returns recent records newest-first", async () => {
  const reg = getJobRegistry();
  await reg.register(def("j", async () => ({ success: true, recordsAffected: 0 })));
  await reg.runNow("j");
  await waitFor(async () => (await reg.getRuns("j")).length === 1);
  await reg.runNow("j");
  await waitFor(async () => (await reg.getRuns("j")).length === 2);
  const runs = await reg.getRuns("j");
  assert.equal(runs.length, 2);
  assert.ok(
    new Date(runs[0].startedAt).getTime() >= new Date(runs[1].startedAt).getTime(),
    "newest first"
  );
});

test("listJobs returns registered jobs with handlers", async () => {
  const reg = getJobRegistry();
  await reg.register(def("j", async () => ({ success: true })));
  const jobs = await reg.listJobs();
  const j = jobs.find((x) => x.id === "j");
  assert.ok(j, "registered job j should appear in listJobs");
  assert.equal(typeof j!.handler, "function");
});

test("cron: invalid expression stops re-scheduling after MAX_CRON_PARSE_FAILURES", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def(
      "badcron",
      async () => {
        calls++;
        return { success: true };
      },
      {
        type: "cron",
        cron: "not-a-valid-cron-expression",
        intervalMs: null,
        config: { timezone: "UTC" },
      }
    )
  );
  await reg.start("badcron");
  const failCount = regInternals(reg).cronFailCount.get("badcron") ?? 0;
  assert.ok(failCount >= 1, `parse should fail, got failCount=${failCount}`);
  assert.equal(calls, 0, "invalid cron handler should never fire");
  reg.stop("badcron");
});

test("runNow: queued trigger waits for current run then re-fires", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  let release: (v: void) => void = () => {};
  const gate = new Promise<void>((res) => (release = res));
  await reg.register(
    def("slow", async () => {
      calls++;
      await gate;
      return { success: true };
    })
  );
  const first = await reg.runNow("slow");
  assert.deepEqual(first, { started: true });
  const queued = reg.runNow("slow");
  await waitFor(() => regInternals(reg).queued.has("slow"));
  release();
  const queuedRes = await queued;
  await waitFor(() => calls === 2);
  assert.equal(calls, 2, "initial + one queued re-run = 2 fires");
  assert.deepEqual(queuedRes, { started: true });
});

test("dispose clears timers and cron failure counts", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def(
      "j",
      async () => {
        calls++;
        return { success: true };
      },
      { intervalMs: 30 }
    )
  );
  await reg.start("j");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(regInternals(reg).timers.has("j"));
  reg.dispose();
  assert.equal(regInternals(reg).timers.size, 0);
  assert.equal(regInternals(reg).cronFailCount.size, 0);
  const callsBefore = calls;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, callsBefore, "disposed timers must not fire");
});

test("cronGetter: re-reads cron on each fire", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  let cronExpr = "*/2 * * * * *";
  await reg.register({
    id: "dynamic",
    type: "cron",
    cron: cronExpr,
    intervalMs: null,
    enabled: true,
    envFlag: null,
    config: { timezone: "UTC" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handler: async () => {
      calls++;
      return { success: true };
    },
    cronGetter: () => cronExpr,
  });
  await reg.start("dynamic");
  await new Promise((r) => setTimeout(r, 2500));
  const callsAfterInitial = calls;
  assert.ok(callsAfterInitial >= 1, `should fire with initial cron, got ${callsAfterInitial}`);
  cronExpr = "0 0 1 1 * 2099";
  await new Promise((r) => setTimeout(r, 3000));
  reg.stop("dynamic");
  const extraFires = calls - callsAfterInitial;
  assert.ok(extraFires <= 1, `cronGetter change should stop fires, got ${extraFires} extra`);
});

test("cronFailCount: resets after successful parse", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register({
    id: "recover",
    type: "cron",
    cron: "not-a-cron",
    intervalMs: null,
    enabled: true,
    envFlag: null,
    config: { timezone: "UTC" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handler: async () => {
      calls++;
      return { success: true };
    },
  });
  await reg.start("recover");
  const failCountAfterFail = regInternals(reg).cronFailCount.get("recover") ?? 0;
  assert.ok(failCountAfterFail >= 1, `parse should fail, got failCount=${failCountAfterFail}`);
  await reg.register({
    id: "recover",
    type: "cron",
    cron: "* * * * * *",
    intervalMs: null,
    enabled: true,
    envFlag: null,
    config: { timezone: "UTC" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handler: async () => {
      calls++;
      return { success: true };
    },
    cronGetter: () => "* * * * * *",
  });
  reg.stop("recover");
  await reg.start("recover");
  const failCountAfterRecovery = regInternals(reg).cronFailCount.get("recover") ?? 0;
  assert.equal(failCountAfterRecovery, 0, "successful parse should reset failure count");
  reg.stop("recover");
});

test("cronGetter: throws falls back to static cron", async () => {
  const reg = getJobRegistry();
  let calls = 0;
  let shouldThrow = true;
  await reg.register({
    id: "throwing",
    type: "cron",
    cron: "* * * * * *",
    intervalMs: null,
    enabled: true,
    envFlag: null,
    config: { timezone: "UTC" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    handler: async () => {
      calls++;
      return { success: true };
    },
    cronGetter: () => {
      if (shouldThrow) throw new Error("transient failure");
      return "* * * * * *";
    },
  });
  await reg.start("throwing");
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(calls >= 1, "job should fire with static cron fallback when cronGetter throws");
  reg.stop("throwing");
});

for (const outcome of ["success", "failure", "throw", "throw-empty"] as const) {
  test(`history: failed recording is contained after handler ${outcome}`, async (t) => {
    const reg = getJobRegistry();
    let calls = 0;
    await reg.register(
      def("j", async () => {
        calls++;
        if (outcome === "throw") throw new Error("handler failed");
        if (outcome === "throw-empty") throw new Error("");
        return {
          success: outcome === "success",
          error: outcome === "failure" ? "handler failed" : undefined,
          recordsAffected: 7,
        };
      })
    );
    const fault = failHistoryWrites(t, ["record"]);
    const errors = t.mock.method(console, "error", () => {});

    assert.deepEqual(await reg.runNow("j"), { started: true });
    await waitFor(() => errors.mock.callCount() === 1);
    assert.equal(calls, 1, "a history failure must not retry the handler");
    assert.deepEqual(fault.attempts, ["record"], "do not record the DB error as a job failure");
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments.join(" "), /record.*j.*database is locked/i);
    assert.equal((await reg.getRuns("j")).length, 0);

    fault.recover();
    assert.deepEqual(await reg.runNow("j"), { started: true });
    await waitFor(async () => (await reg.getRuns("j")).length === 1);
    assert.equal(calls, 2, "the running guard must be released after a history failure");
    const [run] = await reg.getRuns("j");
    assert.equal(run.status, outcome === "success" ? "success" : "failure");
    assert.equal(
      run.errorMessage,
      outcome === "success" ? null : outcome === "throw-empty" ? "" : "handler failed"
    );
    assert.equal(run.recordsAffected, outcome.startsWith("throw") ? 0 : 7);
  });
}

test("history: failed pruning preserves the recorded result and permits another run", async (t) => {
  const reg = getJobRegistry();
  let calls = 0;
  await reg.register(
    def("j", async () => {
      calls++;
      return { success: true, recordsAffected: 3 };
    })
  );
  const fault = failHistoryWrites(t, ["prune"]);
  const errors = t.mock.method(console, "error", () => {});
  await reg.runNow("j");
  await waitFor(() => errors.mock.callCount() === 1);
  assert.deepEqual(fault.attempts, ["prune"]);
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments.join(" "), /prune.*j.*database is locked/i);
  const [recorded] = await reg.getRuns("j");
  assert.equal(recorded.status, "success");
  assert.equal(recorded.recordsAffected, 3);

  fault.recover();
  await reg.runNow("j");
  await waitFor(async () => (await reg.getRuns("j")).length === 2);
  assert.equal(calls, 2);
  assert.equal((await reg.getRuns("j")).length, 2);
});

test("history: simultaneous failures release one queued run without blocking other jobs", async (t) => {
  const reg = getJobRegistry();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await reg.register(
    def("j", async () => {
      calls++;
      await gate;
      return { success: true };
    })
  );
  let otherCalls = 0;
  await reg.register(
    def("other", async () => {
      otherCalls++;
      return { success: true };
    })
  );
  const fault = failHistoryWrites(t, ["record", "prune"]);
  const errors = t.mock.method(console, "error", () => {});

  await reg.runNow("j");
  const queued = reg.runNow("j");
  await waitFor(() => regInternals(reg).queued.has("j"));
  assert.deepEqual(await reg.runNow("j"), { started: false, reason: "already_queued" });
  assert.equal(calls, 1, "the queued request must wait for the current handler");
  release();
  assert.deepEqual(await queued, { started: true });
  await waitFor(() => errors.mock.callCount() === 4);
  assert.equal(calls, 2, "only the explicitly queued request runs again");
  assert.equal(fault.attempts.filter((op) => op === "record").length, 2);
  assert.equal(fault.attempts.filter((op) => op === "prune").length, 2);
  assert.equal(errors.mock.callCount(), 4);

  await reg.runNow("other");
  await waitFor(() => otherCalls === 1);
  assert.equal(otherCalls, 1, "other jobs still execute while history is unavailable");
  fault.recover();
  await reg.runNow("j");
  await waitFor(() => calls === 3);
  assert.equal(calls, 3);
  await waitFor(async () => (await reg.getRuns("j")).length === 1);
  assert.equal((await reg.getRuns("j")).length, 1);
});

for (const type of ["interval", "cron"] as const) {
  test(`history: ${type} scheduling continues after a pruning failure`, async (t) => {
    const reg = getJobRegistry();
    let calls = 0;
    await reg.register(
      def(
        "j",
        async () => {
          calls++;
          return { success: true };
        },
        { type, intervalMs: 1000, cron: "* * * * * *", config: { timezone: "UTC" } }
      )
    );
    const fault = failHistoryWrites(t, ["prune"]);
    const errors = t.mock.method(console, "error", () => {});
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
    t.after(() => reg.stopAll());

    await reg.start("j");
    if (type === "cron") t.mock.timers.tick(1000);
    await waitFor(() => errors.mock.callCount() === 1);
    assert.equal(calls, 1);
    assert.equal(errors.mock.callCount(), 1);

    fault.recover();
    t.mock.timers.tick(1000);
    await waitFor(() => calls === 2);
    assert.equal(calls, 2);
    await waitFor(async () => (await reg.getRuns("j")).length === 2);
    assert.equal((await reg.getRuns("j")).length, 2);
  });
}
