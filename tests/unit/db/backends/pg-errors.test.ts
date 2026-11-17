import test from "node:test";
import assert from "node:assert/strict";

import { classifyPgError } from "../../../../src/lib/db/backends/postgres/errors.ts";

const table: Array<[string, string, string]> = [
  ["40001", "serialization_failure", "retryable"],
  ["40P01", "deadlock_detected", "retryable"],
  ["55P03", "lock_not_available", "retryable"],
  ["57014", "statement_timeout", "retryable"],
  ["23505", "unique", "unique_violation"],
  ["23503", "fk", "foreign_key_violation"],
  ["23502", "not null", "not_null_violation"],
  ["ECONNREFUSED", "conn", "unavailable"],
  ["ENOTFOUND", "dns", "unavailable"],
  ["57P01", "admin shutdown", "unavailable"],
  ["08006", "connection_failure", "unavailable"],
  ["42P01", "undefined table", "other"],
];

for (const [code, message, kind] of table) {
  test(`classifyPgError maps ${code} to ${kind}`, () => {
    const out = classifyPgError(Object.assign(new Error(message), { code }));
    assert.equal(out.kind, kind);
    assert.equal(out.code, code);
  });
}

test("classifyPgError handles errors without a code and non-errors", () => {
  assert.equal(classifyPgError(new Error("boom")).kind, "other");
  assert.equal(classifyPgError("weird").kind, "other");
  assert.equal(classifyPgError(undefined).kind, "other");
});

test("unavailable errors do not echo host or credentials from the driver message", () => {
  const err = Object.assign(
    new Error("connect ECONNREFUSED postgres://u:s3cret@db.internal:5432"),
    { code: "ECONNREFUSED" }
  );
  const out = classifyPgError(err);
  assert.ok(!out.message.includes("s3cret"));
  assert.ok(!out.message.includes("db.internal"));
});
