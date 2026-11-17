import test from "node:test";
import assert from "node:assert/strict";

// The case-mapping helpers (toSnakeCase, toCamelCase, objToSnake, rowToCamel, cleanNulls)
// are pure functions re-exported by src/lib/db/core.ts. The SQLite pragma helpers
// (autoVacuum, page/cache size, vacuum, driver info) were removed with the PostgreSQL move
// and are no longer tested here.

const core = await import("../../src/lib/db/core.ts");

// ─── toSnakeCase ───────────────────────────────────────

test("toSnakeCase: basic camelCase conversion", () => {
  assert.equal(core.toSnakeCase("apiKey"), "api_key");
  assert.equal(core.toSnakeCase("isActive"), "is_active");
  assert.equal(core.toSnakeCase("providerName"), "provider_name");
});

test("toSnakeCase: empty string and single word", () => {
  assert.equal(core.toSnakeCase(""), "");
  assert.equal(core.toSnakeCase("name"), "name");
  assert.equal(core.toSnakeCase("id"), "id");
});

test("toSnakeCase: consecutive uppercase (acronyms)", () => {
  // The implementation inserts _ before each uppercase including the first
  // character, then lowercases. So "APIKey" → "_a_p_i_key".
  assert.equal(core.toSnakeCase("APIKey"), "_a_p_i_key");
  assert.equal(core.toSnakeCase("DBConnection"), "_d_b_connection");
});

test("toSnakeCase: already snake_case stays same", () => {
  assert.equal(core.toSnakeCase("already_snake"), "already_snake");
  assert.equal(core.toSnakeCase("already_snake_case"), "already_snake_case");
});

test("toSnakeCase: mixed snake and camel", () => {
  assert.equal(core.toSnakeCase("provider_name"), "provider_name");
  assert.equal(core.toSnakeCase("provider_Name"), "provider__name");
});

// ─── toCamelCase ───────────────────────────────────────

test("toCamelCase: basic snake_case conversion", () => {
  assert.equal(core.toCamelCase("api_key"), "apiKey");
  assert.equal(core.toCamelCase("is_active"), "isActive");
  assert.equal(core.toCamelCase("provider_name"), "providerName");
});

test("toCamelCase: empty string and single word", () => {
  assert.equal(core.toCamelCase(""), "");
  assert.equal(core.toCamelCase("name"), "name");
  assert.equal(core.toCamelCase("id"), "id");
});

test("toCamelCase: multiple underscores", () => {
  assert.equal(core.toCamelCase("foo_bar_baz"), "fooBarBaz");
  assert.equal(core.toCamelCase("a_b_c"), "aBC");
});

test("toCamelCase: leading underscore", () => {
  assert.equal(core.toCamelCase("_private"), "Private");
});

test("toCamelCase: trailing underscore is preserved", () => {
  // Regex _([a-z]) doesn't match trailing underscore (no char after it)
  assert.equal(core.toCamelCase("trailing_"), "trailing_");
});

// ─── objToSnake ────────────────────────────────────────

test("objToSnake: converts object keys to snake_case", () => {
  const input = { apiKey: "sk-test", isActive: true, providerName: "openai" };
  const result = core.objToSnake(input);
  assert.deepEqual(result, { api_key: "sk-test", is_active: true, provider_name: "openai" });
});

test("objToSnake: null/undefined/non-object input", () => {
  assert.equal(core.objToSnake(null), null);
  assert.equal(core.objToSnake(undefined), undefined);
  assert.equal(core.objToSnake("string"), "string");
  assert.equal(core.objToSnake(42), 42);
});

test("objToSnake: empty object", () => {
  assert.deepEqual(core.objToSnake({}), {});
});

test("objToSnake: nested values preserved as-is (shallow)", () => {
  const input = { nestedObj: { innerKey: "val" }, items: [1, 2, 3] };
  const result = core.objToSnake(input);
  assert.deepEqual(result, { nested_obj: { innerKey: "val" }, items: [1, 2, 3] });
});

// ─── rowToCamel ────────────────────────────────────────

test("rowToCamel: converts snake_case row to camelCase", () => {
  const row = { api_key: "sk-test", is_active: 1, provider_name: "openai" };
  const result = core.rowToCamel(row);
  assert.deepEqual(result, { apiKey: "sk-test", isActive: true, providerName: "openai" });
});

test("rowToCamel: null/undefined row returns null", () => {
  assert.equal(core.rowToCamel(null), null);
  assert.equal(core.rowToCamel(undefined), null);
});

test("rowToCamel: isActive boolean conversion (1/0)", () => {
  assert.deepEqual(core.rowToCamel({ is_active: 1 }), { isActive: true });
  assert.deepEqual(core.rowToCamel({ is_active: 0 }), { isActive: false });
  assert.deepEqual(core.rowToCamel({ is_active: true }), { isActive: true });
  assert.deepEqual(core.rowToCamel({ is_active: false }), { isActive: false });
});

test("rowToCamel: rateLimitProtection boolean conversion", () => {
  assert.deepEqual(core.rowToCamel({ rate_limit_protection: 1 }), { rateLimitProtection: true });
  assert.deepEqual(core.rowToCamel({ rate_limit_protection: 0 }), { rateLimitProtection: false });
});

test("rowToCamel: providerSpecificData JSON string parsing", () => {
  const data = JSON.stringify({ org: "my-org" });
  const result = core.rowToCamel({ provider_specific_data: data });
  assert.deepEqual(result, { providerSpecificData: { org: "my-org" } });
});

test("rowToCamel: providerSpecificData invalid JSON", () => {
  const result = core.rowToCamel({ provider_specific_data: "not-json" });
  assert.equal(result?.providerSpecificData, "not-json");
});

test("rowToCamel: providerSpecificData non-string passes through", () => {
  const result = core.rowToCamel({ provider_specific_data: 42 });
  assert.equal(result?.providerSpecificData, 42);
});

test("rowToCamel: _json suffix columns parsed into base key", () => {
  const result = core.rowToCamel({ quota_window_thresholds_json: JSON.stringify([1, 2, 3]) });
  assert.deepEqual(result, { quotaWindowThresholds: [1, 2, 3] });
});

test("rowToCamel: _json suffix with invalid JSON sets null", () => {
  const result = core.rowToCamel({ quota_window_thresholds_json: "broken" });
  assert.deepEqual(result, { quotaWindowThresholds: null });
});

test("rowToCamel: ordinary fields pass through unchanged", () => {
  const result = core.rowToCamel({ name: "test", created_at: "2025-01-01" });
  assert.deepEqual(result, { name: "test", createdAt: "2025-01-01" });
});

test("rowToCamel: empty row returns empty object", () => {
  assert.deepEqual(core.rowToCamel({}), {});
});

// ─── cleanNulls ────────────────────────────────────────

test("cleanNulls: removes null and undefined values", () => {
  const result = core.cleanNulls({ a: 1, b: null, c: "keep", d: undefined, e: 0, f: "" });
  assert.deepEqual(result, { a: 1, c: "keep", e: 0, f: "" });
});

test("cleanNulls: all values kept", () => {
  const result = core.cleanNulls({ a: 1, b: "x", c: false });
  assert.deepEqual(result, { a: 1, b: "x", c: false });
});

test("cleanNulls: empty object returns empty object", () => {
  assert.deepEqual(core.cleanNulls({}), {});
});

test("cleanNulls: all null/undefined returns empty object", () => {
  assert.deepEqual(core.cleanNulls({ a: null, b: undefined }), {});
});

// ─── Edge Cases ────────────────────────────────────────

test("toSnakeCase and toCamelCase are inverses for simple cases", () => {
  const pairs = [
    ["apiKey", "api_key"],
    ["isActive", "is_active"],
    ["providerName", "provider_name"],
    ["createdAt", "created_at"],
    ["updatedAt", "updated_at"],
  ];
  for (const [camel, snake] of pairs) {
    assert.equal(core.toSnakeCase(camel), snake);
    assert.equal(core.toCamelCase(snake), camel);
  }
});

test("cleanNulls with falsy values preserves 0, false, empty string", () => {
  const result = core.cleanNulls({ zero: 0, falseVal: false, emptyStr: "", nil: null });
  assert.deepEqual(result, { zero: 0, falseVal: false, emptyStr: "" });
});

test("objToSnake returns same object reference for primitives", () => {
  const num = 42;
  assert.equal(core.objToSnake(num), 42);
});

test("rowToCamel with isActive=1/non-1 edge cases", () => {
  assert.deepEqual(core.rowToCamel({ is_active: 1 }), { isActive: true });
  assert.deepEqual(core.rowToCamel({ is_active: 0 }), { isActive: false });
  assert.deepEqual(core.rowToCamel({ is_active: 2 }), { isActive: false });
  assert.deepEqual(core.rowToCamel({ is_active: "yes" }), { isActive: false });
});
