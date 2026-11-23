import test from "node:test";
import assert from "node:assert/strict";

// Only the pure case-mapping helpers remain in src/lib/db/core.ts. The SQLite driver
// detection, singleton lifecycle, vacuum/health-check and page-size helpers were removed
// with the PostgreSQL move, so their cases are gone.

const core = await import("../../../src/lib/db/core.ts");

test("toSnakeCase converts camelCase to snake_case", () => {
  assert.equal(core.toSnakeCase("camelCase"), "camel_case");
  assert.equal(core.toSnakeCase("testCase"), "test_case");
  assert.equal(core.toSnakeCase("already"), "already");
});

test("toCamelCase converts snake_case to camelCase", () => {
  assert.equal(core.toCamelCase("snake_case"), "snakeCase");
  assert.equal(core.toCamelCase("test_case"), "testCase");
  assert.equal(core.toCamelCase("already"), "already");
  assert.equal(core.toCamelCase("a"), "a");
});

test("objToSnake converts object keys to snake_case", () => {
  const result = core.objToSnake({ camelCase: 1, anotherKey: 2 }) as any;
  assert.equal(result.camel_case, 1);
  assert.equal(result.another_key, 2);
});

test("objToSnake handles null/undefined/primitives", () => {
  assert.equal(core.objToSnake(null), null);
  assert.equal(core.objToSnake(undefined), undefined);
  assert.equal(core.objToSnake(42), 42);
  assert.equal(core.objToSnake("str"), "str");
});

test("rowToCamel converts object keys to camelCase", () => {
  const result = core.rowToCamel({ snake_case: 1, another_key: 2 });
  assert.ok(result);
  assert.equal(result.snakeCase, 1);
  assert.equal(result.anotherKey, 2);
});

test("rowToCamel returns null for null/undefined", () => {
  assert.equal(core.rowToCamel(null), null);
  assert.equal(core.rowToCamel(undefined), null);
});

test("rowToCamel handles isActive conversion", () => {
  const result = core.rowToCamel({ is_active: 1 });
  assert.ok(result);
  assert.equal(result.isActive, true);
});

test("rowToCamel handles is_active=0 as false", () => {
  const result = core.rowToCamel({ is_active: 0 });
  assert.ok(result);
  assert.equal(result.isActive, false);
});

test("cleanNulls removes null values from object", () => {
  const result = core.cleanNulls({ a: 1, b: null, c: "hello", d: null });
  assert.deepEqual(result, { a: 1, c: "hello" });
});

test("cleanNulls handles nested objects", () => {
  const result = core.cleanNulls({ a: { b: null, c: 1 }, d: null });
  assert.deepEqual(result, { a: { b: null, c: 1 } });
});

test("cleanNulls returns empty object for null input", () => {
  const result = core.cleanNulls(null);
  assert.deepEqual(result, {});
});
