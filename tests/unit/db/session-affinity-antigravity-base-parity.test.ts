import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-affinity-agy-parity-"));
process.env.DATA_DIR = dataDir;
delete process.env.REDIS_URL;
delete process.env.OMNIROUTE_SESSION_AFFINITY_STORE;
const core = await import("../../../src/lib/db/core.ts");
const { sqliteSessionAffinityStore: local } =
  await import("../../../src/lib/db/sessionAffinity/sqliteStore.ts");
const eviction = await import("../../../src/lib/db/sessionAffinity/requestEviction.ts");
const headSource = fs.readFileSync(
  fileURLToPath(new URL("../../../src/sse/handlers/chat.ts", import.meta.url)),
  "utf8"
);

// Before the PostgreSQL migration these two antigravity fallback paths ran a synchronous
// two-argument `getSessionAccountAffinity(key, provider)` read. That read is TTL-gated, so with no
// TTL it always returned null and the pin was never evicted (a latent no-op). The handler now
// awaits the guarded eviction, which drops the pin only while it still points at the failed
// connection. This test runs the handler's real try block (extracted from chat.ts) against the
// store and pins both halves of that contract.
function affinityBlock(branch: string): string {
  const tree = ts.createSourceFile("chat.ts", headSource, ts.ScriptTarget.Latest, true);
  let found: ts.Block | undefined;
  function scan(node: ts.Node) {
    if (
      ts.isTryStatement(node) &&
      /evictSessionAccountAffinityForConnection\(/.test(node.tryBlock.getText(tree))
    )
      found = node.tryBlock;
    else ts.forEachChild(node, scan);
  }
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(tree) === branch)
      scan(node.thenStatement);
    else ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `missing affinity block in ${branch}`);
  return found.getText(tree);
}
function run(block: string, key: string) {
  const js = ts.transpileModule(`async function run() ${block}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return runInNewContext(`${js}; run();`, {
    runtimeOptions: { sessionAffinityKey: key },
    provider: "antigravity",
    credentials: { connectionId: "failed-A" },
    evictSessionAccountAffinityForConnection:
      eviction.evictSessionAccountAffinityForConnectionAsync,
  });
}
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
for (const branch of ["isAntigravityStreamReadinessFailure", "isAntigravityPreResponseTimeout"]) {
  test(`${branch}: fallback evicts only a pin still pointing at the failed connection`, async () => {
    const block = affinityBlock(branch);

    const failedKey = `${branch}-failed`;
    await local.upsert(failedKey, "antigravity", "failed-A", 1_000_000, 60_000);
    assert.ok(await local.getSerialized(failedKey, "antigravity"), "seeded pin exists");
    await run(block, failedKey);
    assert.equal(
      await local.getSerialized(failedKey, "antigravity"),
      null,
      "the pin on the failed connection is evicted so the retry can fail over"
    );

    const healthyKey = `${branch}-healthy`;
    await local.upsert(healthyKey, "antigravity", "healthy-B", 1_000_000, 60_000);
    const seeded = await local.getSerialized(healthyKey, "antigravity");
    await run(block, healthyKey);
    assert.equal(
      await local.getSerialized(healthyKey, "antigravity"),
      seeded,
      "a pin that already moved to a healthy connection is left byte-identical"
    );
  });
}
