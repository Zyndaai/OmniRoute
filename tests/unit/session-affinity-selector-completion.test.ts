import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-completion-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
delete process.env.OMNIROUTE_SESSION_AFFINITY_STORE;
delete process.env.REDIS_URL;
const core = await import("../../src/lib/db/core.ts");
const local = await import("../../src/lib/db/sessionAffinity/sqliteStore.ts");
const identity = await import("../../src/lib/db/sessionAffinity/accountIdentity.ts");
const pin = await import("../../src/sse/services/sessionAffinityPin.ts");
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// The selector's contract used to be pinned as an exact microtask trace, which only a
// synchronous store could satisfy. The store is async (PostgreSQL) now, so the same contract is
// stated in terms that survive real I/O: the selector issues exactly the store operations it
// always did (same order, none skipped, none added), and every one of them has completed by the
// time the selector's promise settles (no fire-and-forget write left racing the caller).
const source = fs.readFileSync(
  new URL("../../src/sse/services/sessionAffinityPin.ts", import.meta.url),
  "utf8"
);
const ast = ts.createSourceFile("pin.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "compareLruConnections",
  "liveAffinitySnapshot",
  "formatSessionKeyForLog",
  "clearObsoleteSessionAffinity",
  "logSessionAffinitySelection",
  "logSharedSessionAffinitySelection",
  "selectSessionAffinityConnection",
  "planSessionAffinityConnection",
]);
const bodies = ast.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name!.text))
  .map((node) => node.getText(ast).replace(/^export /, ""))
  .join("\n");
const js = ts.transpileModule(bodies, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// Wraps the real store: each call takes a few ms (like a database round trip) and is recorded
// on entry; `inFlight` is non-zero until the underlying operation has finished.
function slowStore() {
  const calls: string[] = [];
  let inFlight = 0;
  const inner = local.sqliteSessionAffinityStore;
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls.push(name);
      inFlight++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await fn(...args);
      } finally {
        inFlight--;
      }
    };
  const store = {
    ...inner,
    get: wrap("get", inner.get),
    upsert: wrap("upsert", inner.upsert),
    touch: wrap("touch", inner.touch),
    delete: wrap("delete", inner.delete),
  };
  return { store, calls, inFlight: () => inFlight };
}

let currentStore: unknown = local.sqliteSessionAffinityStore;
const dependencies = {
  ...local,
  ...identity,
  getSessionAffinityStore: () => currentStore,
  touchConnectionLastUsed: async () => {}, // no hidden I/O beyond the store under observation
  log: { info: () => {} },
};
const selectors = vm.compileFunction(
  js + "; return { selectSessionAffinityConnection, planSessionAffinityConnection };",
  Object.keys(dependencies)
)(...Object.values(dependencies)) as Pick<
  typeof pin,
  "selectSessionAffinityConnection" | "planSessionAffinityConnection"
>;

const expectedCalls = {
  select: {
    miss: ["get", "upsert"],
    reuse: ["get", "touch"],
    obsolete: ["get", "delete", "upsert"],
  },
  // The plan is built from a caller-supplied prefetch, so it never issues its own get.
  commit: { miss: ["upsert"], reuse: ["touch"], obsolete: ["delete", "upsert"] },
};

for (const initial of ["miss", "reuse", "obsolete"] as const) {
  for (const mode of ["select", "lease-commit", "auth-await-commit"] as const) {
    test(`default ${mode} ${initial}: store operations are exact and complete before settling`, async () => {
      const key = `synthetic-${mode}-${initial}`;
      const seededAt = Date.now() - 30_000;
      if (initial !== "miss")
        await local.upsertSessionAccountAffinity(
          key,
          "glm",
          initial === "reuse" ? "A" : "old",
          seededAt,
          60_000
        );
      const seeded = await local.getSessionAccountAffinitySerialized(key, "glm");
      const observed = await local.getSessionAccountAffinity(key, "glm", 60_000);
      const spy = slowStore();
      currentStore = spy.store;
      try {
        if (mode === "select") {
          const selected = await selectors.selectSessionAffinityConnection(
            "glm",
            key,
            [{ id: "A" }],
            60_000
          );
          assert.equal(selected?.id, "A");
        } else {
          const plan = selectors.planSessionAffinityConnection(
            "glm",
            key,
            [{ id: "A" }],
            60_000,
            observed
          )!;
          assert.equal(plan.connection.id, "A");
          // auth.ts already awaited this callback on base; only that existing layer is allowed.
          if (mode === "lease-commit") await plan.commit();
          else
            await (async () => {
              await plan.commit();
            })();
        }
        assert.equal(spy.inFlight(), 0, "no store operation is still running when it settles");
        assert.deepEqual(
          spy.calls,
          mode === "select" ? expectedCalls.select[initial] : expectedCalls.commit[initial]
        );
      } finally {
        currentStore = local.sqliteSessionAffinityStore;
      }
      const after = await local.getSessionAccountAffinity(key, "glm", 60_000);
      assert.equal(after?.connectionId, "A", "the session ends up pinned to the selected account");
      if (initial === "reuse") {
        assert.notEqual(
          await local.getSessionAccountAffinitySerialized(key, "glm"),
          seeded,
          "a reused pin has its expiry slid"
        );
      }
    });
  }
}

test("real default selector completes its store writes before settling", async () => {
  const key = "synthetic-real-trace";
  const selected = await pin.selectSessionAffinityConnection(
    "glm",
    key,
    [{ id: "missing-synthetic-connection" }],
    60_000
  );
  assert.equal(selected?.id, "missing-synthetic-connection");
  // Read straight after settling: a fire-and-forget upsert could still be in flight.
  const stored = await local.getSessionAccountAffinity(key, "glm", 60_000);
  assert.equal(stored?.connectionId, "missing-synthetic-connection");
});
