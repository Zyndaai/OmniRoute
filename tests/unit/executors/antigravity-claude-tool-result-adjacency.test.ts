import test from "node:test";
import assert from "node:assert/strict";

const { normalizeAntigravityClaudeContents } =
  await import("../../../open-sse/executors/antigravity.ts");
const core = await import("../../../src/lib/db/core.ts");

test.after(async () => {
  await core.resetDbInstance();
});

const response = { functionResponse: { name: "read", response: { ok: true } } };

test("functionResponse parts lead a pure tool-result user turn and <total_tokens> notices go", () => {
  const out = normalizeAntigravityClaudeContents([
    {
      role: "user",
      parts: [
        { text: "<total_tokens>12000 left</total_tokens>" },
        { text: "continue" },
        response,
      ],
    },
  ]) as Array<{ parts: unknown[] }>;
  assert.deepEqual(out[0].parts, [response, { text: "continue" }]);
});

test("turns without a functionResponse, model turns and mixed functionCall turns are untouched", () => {
  const plain = { role: "user", parts: [{ text: "<total_tokens>1</total_tokens>" }] };
  const model = { role: "model", parts: [{ functionCall: { name: "read", args: {} } }] };
  const mixed = {
    role: "user",
    parts: [{ text: "x" }, response, { functionCall: { name: "a", args: {} } }],
  };
  const out = normalizeAntigravityClaudeContents([plain, model, mixed]);
  assert.strictEqual(out[0], plain);
  assert.strictEqual(out[1], model);
  assert.strictEqual(out[2], mixed);
});
