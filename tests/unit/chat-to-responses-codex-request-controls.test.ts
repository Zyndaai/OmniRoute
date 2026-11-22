import test from "node:test";
import assert from "node:assert/strict";

const { openaiToOpenAIResponsesRequest } =
  await import("../../open-sse/translator/request/openai-responses/toResponses.ts");

type Out = {
  parallel_tool_calls?: boolean;
  stream_options?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  reasoning?: Record<string, unknown>;
};

const body = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "hi" }],
  tools: [
    {
      type: "function",
      function: { name: "t", parameters: { type: "object", properties: {} }, defer_loading: true },
    },
  ],
  stream_options: { reasoning_summary_delivery: "concise" },
  ...extra,
});

test("codex keeps deferred tool loading and reasoning summary delivery", () => {
  const out = openaiToOpenAIResponsesRequest("gpt-5-codex", body(), true, {
    _provider: "codex",
  }) as Out;
  assert.equal(out.tools?.[0].defer_loading, true);
  assert.deepEqual(out.stream_options, { reasoning_summary_delivery: "concise" });
});

test("other providers do not receive the Codex-only extensions", () => {
  const out = openaiToOpenAIResponsesRequest("gpt-5", body(), true, { _provider: "openai" }) as Out;
  assert.equal(out.tools?.[0].defer_loading, undefined);
  assert.equal(out.stream_options, undefined);
});

test("an explicit parallel_tool_calls choice is forwarded", () => {
  const out = openaiToOpenAIResponsesRequest(
    "gpt-5",
    body({ parallel_tool_calls: false }),
    true,
    null
  ) as Out;
  assert.equal(out.parallel_tool_calls, false);
});

test("mistral gets effort only, without an invented summary", () => {
  const out = openaiToOpenAIResponsesRequest(
    "mistral-medium",
    body({ reasoning_effort: "high" }),
    true,
    { _provider: "mistral" }
  ) as Out;
  assert.deepEqual(out.reasoning, { effort: "high" });
});
