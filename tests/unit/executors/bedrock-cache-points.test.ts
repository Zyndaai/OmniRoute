import test from "node:test";
import assert from "node:assert/strict";

import { openAIToBedrockConverse } from "../../../open-sse/executors/bedrock.ts";

const CLAUDE = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const NOVA = "us.amazon.nova-pro-v1:0";
const LLAMA = "meta.llama3-70b-instruct-v1:0";

type Block = Record<string, unknown>;
const isPoint = (block: Block) => Boolean(block.cachePoint);
const eph = { type: "ephemeral" };

test("cache_control markers become Converse cache points on Claude and Nova", () => {
  for (const model of [CLAUDE, NOVA]) {
    const payload = openAIToBedrockConverse(model, {
      messages: [
        { role: "system", content: "stable prefix", cache_control: { type: "ephemeral", ttl: "1h" } },
        {
          role: "user",
          content: [{ type: "text", text: "question", cache_control: eph }],
        },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow up" },
      ],
    });
    assert.deepEqual(payload.system, [
      { text: "stable prefix" },
      { cachePoint: { type: "default", ttl: "1h" } },
    ]);
    const first = payload.messages[0].content as Block[];
    assert.deepEqual(first, [{ text: "question" }, { cachePoint: { type: "default" } }]);
    assert.equal((payload.messages[2].content as Block[]).some(isPoint), false, model);
  }
});

test("models without prompt caching never receive cache point blocks", () => {
  const payload = openAIToBedrockConverse(LLAMA, {
    messages: [
      { role: "system", content: "s", cache_control: eph },
      { role: "user", content: [{ type: "text", text: "q", cache_control: eph }] },
    ],
  });
  assert.equal((payload.system ?? []).some(isPoint), false);
  assert.equal((payload.messages[0].content as Block[]).some(isPoint), false);
});

test("a cache point follows a tool result and the request keeps at most the last four", () => {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: "s", cache_control: eph },
    { role: "user", content: [{ type: "text", text: "u1", cache_control: eph }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "result", cache_control: eph },
    { role: "user", content: [{ type: "text", text: "u2", cache_control: eph }] },
    { role: "assistant", content: [{ type: "text", text: "a2", cache_control: eph }] },
    { role: "user", content: [{ type: "text", text: "u3", cache_control: eph }] },
  ];
  const payload = openAIToBedrockConverse(CLAUDE, { messages });
  const all = [payload.system ?? [], ...payload.messages.map((m) => m.content as Block[])];
  assert.equal(all.flat().filter(isPoint).length, 4);
  const toolTurn = payload.messages.find((m) =>
    (m.content as Block[]).some((block) => block.toolResult)
  );
  assert.ok(toolTurn);
  // The surviving (latest) points are the ones nearest the end of the conversation.
  const last = payload.messages[payload.messages.length - 1].content as Block[];
  assert.equal(isPoint(last[last.length - 1]), true);
  // No turn starts with a cache point and none holds two in a row.
  for (const message of payload.messages) {
    const blocks = message.content as Block[];
    assert.equal(isPoint(blocks[0]), false);
    blocks.forEach((block, i) => assert.ok(!(isPoint(block) && i > 0 && isPoint(blocks[i - 1]))));
  }
});
