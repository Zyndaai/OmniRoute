import test from "node:test";
import assert from "node:assert/strict";

const { openaiToClaudeRequest } =
  await import("../../open-sse/translator/request/openai-to-claude.ts");
const { openaiToGeminiRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");

// OpenAI-compatible clients routinely serialize an unset `stop` as an explicit
// `"stop": null`. The upstream APIs only accept strings in stop_sequences /
// stopSequences, so a null must be dropped rather than wrapped into `[null]`.

const baseBody = () => ({
  model: "x",
  messages: [{ role: "user", content: "hi" }],
});

test("openaiToClaudeRequest omits stop_sequences when stop is null", async () => {
  const result = await openaiToClaudeRequest("claude-haiku-4-5", { ...baseBody(), stop: null }, false);
  assert.equal("stop_sequences" in result, false);
});

test("openaiToClaudeRequest keeps string stop values and drops non-string entries", async () => {
  const single = await openaiToClaudeRequest("claude-haiku-4-5", { ...baseBody(), stop: "END" }, false);
  assert.deepEqual(single.stop_sequences, ["END"]);

  const list = await openaiToClaudeRequest(
    "claude-haiku-4-5",
    { ...baseBody(), stop: ["A", null, "B"] },
    false
  );
  assert.deepEqual(list.stop_sequences, ["A", "B"]);
});

test("openaiToGeminiRequest omits stopSequences when stop is null", async () => {
  const result = await openaiToGeminiRequest("gemini-2.5-flash", { ...baseBody(), stop: null }, false);
  assert.equal("stopSequences" in result.generationConfig, false);
});

test("openaiToGeminiRequest keeps string stop values and drops non-string entries", async () => {
  const single = await openaiToGeminiRequest("gemini-2.5-flash", { ...baseBody(), stop: "END" }, false);
  assert.deepEqual(single.generationConfig.stopSequences, ["END"]);

  const list = await openaiToGeminiRequest(
    "gemini-2.5-flash",
    { ...baseBody(), stop: ["A", null, "B"] },
    false
  );
  assert.deepEqual(list.generationConfig.stopSequences, ["A", "B"]);
});
