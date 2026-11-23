import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeClaudeFinalAssistantWhitespace } from "../../../open-sse/services/claudeFinalAssistantWhitespace.ts";

describe("normalizeClaudeFinalAssistantWhitespace", () => {
  it("trims a string tail on the last assistant turn", () => {
    const out = normalizeClaudeFinalAssistantWhitespace([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Sure \n " },
    ]);
    assert.equal(out[1].content, "Sure");
  });

  it("trims the final text block and removes tail blocks that trim to empty", () => {
    const out = normalizeClaudeFinalAssistantWhitespace([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Answer \n" },
          { type: "text", text: "  \n" },
        ],
      },
    ]);
    assert.deepEqual(out[1].content, [{ type: "text", text: "Answer" }]);
  });

  it("leaves non-text tails, user-last conversations and clean turns untouched", () => {
    const toolUse = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
    ];
    assert.equal(normalizeClaudeFinalAssistantWhitespace(toolUse), toolUse);
    const userLast = [{ role: "user", content: "hi \n" }];
    assert.equal(normalizeClaudeFinalAssistantWhitespace(userLast), userLast);
    const clean = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    assert.equal(normalizeClaudeFinalAssistantWhitespace(clean), clean);
  });

  it("drops an emptied assistant turn but never empties the body", () => {
    const out = normalizeClaudeFinalAssistantWhitespace([
      { role: "user", content: "hi" },
      { role: "assistant", content: "  " },
    ]);
    assert.equal(out.length, 1);
    const lone = [{ role: "assistant", content: " " }];
    assert.equal(normalizeClaudeFinalAssistantWhitespace(lone), lone);
  });
});
