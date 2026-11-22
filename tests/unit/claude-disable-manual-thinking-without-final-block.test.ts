import test from "node:test";
import assert from "node:assert/strict";

const { disableManualThinkingWithoutFinalBlock } =
  await import("../../open-sse/translator/helpers/claudeHelper.ts");

function body(assistantBlocks: unknown[], thinking: Record<string, unknown> = { type: "enabled" }) {
  return {
    thinking,
    context_management: { edits: [{ type: "clear_thinking_20251015" }, { type: "clear_tool_uses" }] },
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: assistantBlocks },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ],
  } as Parameters<typeof disableManualThinkingWithoutFinalBlock>[0];
}

test("manual thinking is disabled when the final tool-use turn has no thinking block", () => {
  const b = body([{ type: "tool_use", id: "t1", name: "Read", input: {} }]);
  disableManualThinkingWithoutFinalBlock(b);
  assert.equal(b.thinking, undefined);
  assert.deepEqual(b.context_management, { edits: [{ type: "clear_tool_uses" }] });
});

test("a thinking block on the final assistant turn keeps thinking on", () => {
  const b = body([
    { type: "thinking", thinking: "x", signature: "sig" },
    { type: "tool_use", id: "t1", name: "Read", input: {} },
  ]);
  disableManualThinkingWithoutFinalBlock(b);
  assert.deepEqual(b.thinking, { type: "enabled" });
});

test("adaptive thinking and non tool-use turns are left alone", () => {
  const adaptive = body([{ type: "tool_use", id: "t1", name: "Read", input: {} }], {
    type: "adaptive",
  });
  disableManualThinkingWithoutFinalBlock(adaptive);
  assert.deepEqual(adaptive.thinking, { type: "adaptive" });
  const plain = body([{ type: "text", text: "hi" }]);
  disableManualThinkingWithoutFinalBlock(plain);
  assert.deepEqual(plain.thinking, { type: "enabled" });
});
