import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-affinity-order-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "synthetic-affinity-secret";
delete process.env.REDIS_URL;
delete process.env.OMNIROUTE_SESSION_AFFINITY_STORE;
const core = await import("../../../src/lib/db/core.ts");
const sqlite = await import("../../../src/lib/db/sessionAffinity/sqliteStore.ts");
const pin = await import("../../../src/sse/services/sessionAffinityPin.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// The removed SQLite driver wrote synchronously, so the "replacement is visible before control
// yields", "provider usage is touched before control yields" and chat-eviction "continuation is
// synchronous" cases asserted a guarantee PostgreSQL cannot give; they are deleted with it. The
// ordering contract that still holds is that a later concurrent selection stays the last writer.
for (const mode of ["select", "lease-commit"] as const) {
  function start(key: string, candidate: string) {
    const connections = [{ id: candidate }];
    if (mode === "select")
      return pin.selectSessionAffinityConnection("glm", key, connections, 60_000);
    return pin.planSessionAffinityConnection("glm", key, connections, 60_000)!.commit();
  }
  test(`${mode}: a later concurrent selection stays the last writer`, async () => {
    const key = `synthetic-${mode}-order`;
    await sqlite.upsertSessionAccountAffinity(key, "glm", "obsolete", Date.now(), 60_000);
    const first = start(key, "A");
    const second = start(key, "B");
    await Promise.all([first, second]);
    assert.equal(
      (await sqlite.getSessionAccountAffinity(key, "glm", 60_000))?.connectionId,
      "B"
    );
  });
}
