// The config audit log moved out of the database with the PostgreSQL move (config_audit_log
// is gone; src/domain/configAudit.ts keeps only the pure diff helpers). The persistence,
// pagination, rollback and cleanup cases were removed with it; computeDiff is still pure.
import test from "node:test";
import assert from "node:assert/strict";

const audit = await import("../../../src/domain/configAudit.ts");

test("computeDiff stays pure", () => {
  const d = audit.computeDiff({ a: 1 }, { a: 2, b: 3 });
  assert.deepEqual(d.added, ["b"]);
  assert.deepEqual(d.changed, [{ key: "a", from: 1, to: 2 }]);
});
