/**
 * A Chat Completions client behind an Anthropic upstream must see prompt-cache WRITES inside
 * prompt_tokens (OpenAI-SDK billing contract), in `prompt_tokens_details.cache_write_tokens`.
 *
 * Before: cold call -> { prompt_tokens: 18, cache_creation_input_tokens: 4425 } (SDKs ignore the
 * top-level field and under-bill ~250x). The fold is RESPONSE SHAPE only: OmniRoute's own
 * accounting (state.usage -> call logs / usage DB / cost, extractUsageFromResponse) must keep
 * the exact numbers it had before, so these tests pin both sides.
 */
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/lib/db/core.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
const { foldCacheWriteIntoPromptTokens, normalizeUsage } =
  await import("../../open-sse/utils/usageTracking.ts");
const { extractUsageFromResponse } = await import("../../open-sse/handlers/usageExtractor.ts");
const { translateNonStreamingClientResponse } =
  await import("../../open-sse/handlers/chatCore/nonStreamingClientTranslate.ts");
const { getLoggedInputTokens, getPromptCacheCreationTokens, getPromptCacheReadTokens } =
  await import("../../src/lib/usage/tokenAccounting.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

test.after(() => core.resetDbInstance());

type Rec = Record<string, unknown>;

const COLD = { input_tokens: 18, cache_creation_input_tokens: 4425, cache_read_input_tokens: 0 };
const WARM = { input_tokens: 18, cache_creation_input_tokens: 0, cache_read_input_tokens: 4425 };

function claudeEvents(startUsage: Rec): string[] {
  const sse = (type: string, data: Rec) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_cache",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        usage: { ...startUsage, output_tokens: 1 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 20 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

async function runStream(startUsage: Rec) {
  let completed: Rec | null = null;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of claudeEvents(startUsage)) {
        controller.enqueue(new TextEncoder().encode(event));
      }
      controller.close();
    },
  });
  const text = await new Response(
    source.pipeThrough(
      createSSEStream({
        mode: "translate",
        targetFormat: FORMATS.CLAUDE,
        sourceFormat: FORMATS.OPENAI,
        provider: "claude",
        model: "claude-sonnet-4-5",
        body: { messages: [{ role: "user", content: "hi" }] },
        onComplete: (payload: Rec) => {
          completed = payload;
        },
      })
    )
  ).text();
  const usages = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Rec)
    .filter((chunk) => chunk.usage)
    .map((chunk) => chunk.usage as Rec);
  assert.equal(usages.length, 1, "exactly one client usage block");
  assert.ok(completed, "onComplete must run");
  return { client: usages[0], internal: (completed as Rec).usage as Rec };
}

test("streaming cold call: write is inside prompt_tokens, named cache_write_tokens", async () => {
  const { client } = await runStream(COLD);
  const details = client.prompt_tokens_details as Rec;
  assert.equal(client.prompt_tokens, 4443, "18 uncached + 4425 written");
  assert.equal(client.completion_tokens, 20);
  assert.equal(client.total_tokens, 4463);
  assert.equal(details.cache_write_tokens, 4425);
  assert.equal(details.cached_tokens, undefined);
  assert.equal(details.cache_creation_in_prompt, true, "marker flips so readers do not re-add");
  assert.equal(client.cache_creation_input_tokens, 4425, "top-level field kept for back-compat");
});

test("streaming warm call: same prompt_tokens, cached_tokens carries the read", async () => {
  const cold = (await runStream(COLD)).client;
  const warm = (await runStream(WARM)).client;
  const details = warm.prompt_tokens_details as Rec;
  assert.equal(warm.prompt_tokens, 4443);
  assert.equal(warm.prompt_tokens, cold.prompt_tokens, "cold and warm bill the same prompt size");
  assert.equal(warm.total_tokens, 4463);
  assert.equal(details.cached_tokens, 4425);
  assert.equal(details.cache_write_tokens, undefined);
});

test("streaming: internal accounting (state.usage / call log) is unchanged", async () => {
  const cold = (await runStream(COLD)).internal;
  // Exactly what the pre-change code recorded: write stays OUT of prompt_tokens internally.
  assert.equal(cold.prompt_tokens, 18);
  assert.equal(cold.input_tokens, 18);
  assert.equal(cold.cache_creation_input_tokens, 4425);
  assert.equal(cold.completion_tokens, 20);
  assert.equal(cold.prompt_tokens_details, undefined, "client-only details never reach state");
  assert.equal(getLoggedInputTokens(cold), 18);
  assert.equal(getPromptCacheCreationTokens(cold), 4425);
  const normalized = normalizeUsage(cold) as Rec;
  assert.equal(normalized.prompt_tokens, 18);
  assert.equal(normalized.cache_creation_input_tokens, 4425);

  const warm = (await runStream(WARM)).internal;
  assert.equal(warm.prompt_tokens, 4443, "read is billable input internally (unchanged)");
  assert.equal(warm.cache_read_input_tokens, 4425);
  assert.equal(getPromptCacheReadTokens(warm), 4425);
});

test("non-streaming: client body folds the write, raw-body extraction is unchanged", () => {
  const claudeBody = (usage: Rec) => ({
    id: "msg_cache",
    type: "message",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Hello" }],
    usage: { ...usage, output_tokens: 20 },
  });
  const translate = (usage: Rec) =>
    translateNonStreamingClientResponse({
      responseBody: claudeBody(usage),
      responsePayloadFormat: FORMATS.CLAUDE,
      clientResponseFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      provider: "claude",
      model: "claude-sonnet-4-5",
      requestBody: { messages: [{ role: "user", content: "hi" }] },
      responseToolNameMap: null,
      requestToolIdentityMap: null,
      reasoningCacheScope: null,
      clientHeaders: null,
      isClaudeCodeCompatible: false,
      phase: "final",
    }).response.usage as Rec;

  const cold = translate(COLD);
  const warm = translate(WARM);
  const coldDetails = cold.prompt_tokens_details as Rec;
  assert.equal(cold.prompt_tokens, 4443);
  assert.equal(cold.total_tokens, 4463);
  assert.equal(coldDetails.cache_write_tokens, 4425);
  assert.equal(coldDetails.cache_creation_in_prompt, true);
  assert.equal(warm.prompt_tokens, 4443);
  assert.equal((warm.prompt_tokens_details as Rec).cached_tokens, 4425);
  assert.equal((warm.prompt_tokens_details as Rec).cache_write_tokens, undefined);

  // Billing/log extraction reads the raw provider body: untouched by the client fold.
  const internal = extractUsageFromResponse(claudeBody(COLD), "claude") as Rec;
  assert.deepEqual(internal, {
    prompt_tokens: 4443,
    completion_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 4425,
  });
});

test("non-streaming: intermediate (tool-loop) phase keeps the raw pivot usage", () => {
  const usage = translateNonStreamingClientResponse({
    responseBody: {
      id: "msg_cache",
      type: "message",
      model: "claude-sonnet-4-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Hello" }],
      usage: { ...COLD, output_tokens: 20 },
    },
    responsePayloadFormat: FORMATS.CLAUDE,
    clientResponseFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI,
    provider: "claude",
    model: "claude-sonnet-4-5",
    requestBody: { messages: [{ role: "user", content: "hi" }] },
    responseToolNameMap: null,
    requestToolIdentityMap: null,
    reasoningCacheScope: null,
    clientHeaders: null,
    isClaudeCodeCompatible: false,
    phase: "intermediate",
  }).response.usage as Rec;
  assert.equal(usage.prompt_tokens, 18);
  assert.equal((usage.prompt_tokens_details as Rec).cache_creation_in_prompt, false);
});

test("non-streaming: an OpenAI-format upstream keeps its own usage shape", () => {
  const body = {
    id: "chatcmpl-x",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 910,
      completion_tokens: 5,
      total_tokens: 915,
      prompt_tokens_details: { cache_creation_tokens: 700, cache_creation_in_prompt: false },
    },
  };
  const out = translateNonStreamingClientResponse({
    responseBody: body,
    responsePayloadFormat: FORMATS.OPENAI,
    clientResponseFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI,
    provider: "openai-compatible",
    model: "m",
    requestBody: { messages: [{ role: "user", content: "hi" }] },
    responseToolNameMap: null,
    requestToolIdentityMap: null,
    reasoningCacheScope: null,
    clientHeaders: null,
    isClaudeCodeCompatible: false,
    phase: "final",
  }).response.usage as Rec;
  assert.equal(out.prompt_tokens, 910, "OpenAI-format upstream keeps its own shape");
});

test("foldCacheWriteIntoPromptTokens is idempotent, pure and conservative", () => {
  const usage = {
    prompt_tokens: 18,
    completion_tokens: 20,
    total_tokens: 38,
    cache_creation_input_tokens: 4425,
    prompt_tokens_details: { cached_tokens: 0, cache_creation_in_prompt: false },
  };
  const snapshot = JSON.parse(JSON.stringify(usage));
  const once = foldCacheWriteIntoPromptTokens(usage);
  assert.deepEqual(usage, snapshot, "input is not mutated");
  assert.equal(once.prompt_tokens, 4443);
  assert.equal(once.total_tokens, 4463);
  assert.deepEqual(foldCacheWriteIntoPromptTokens(once), once, "second call is a no-op");

  // An already-inclusive provider (marker true, e.g. Bedrock/Cursor/Command Code) is untouched.
  const inclusive = {
    prompt_tokens: 4443,
    completion_tokens: 20,
    total_tokens: 4463,
    prompt_tokens_details: { cache_creation_tokens: 4425, cache_creation_in_prompt: true },
  };
  assert.equal(foldCacheWriteIntoPromptTokens(inclusive), inclusive);

  // No write, or an unmarked usage without the caller's assertion: untouched.
  const noWrite = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  assert.equal(foldCacheWriteIntoPromptTokens(noWrite, { writeExcludedFromPrompt: true }), noWrite);
  const unmarked = { prompt_tokens: 18, completion_tokens: 2, cache_creation_input_tokens: 9 };
  assert.equal(foldCacheWriteIntoPromptTokens(unmarked), unmarked);
  assert.equal(
    foldCacheWriteIntoPromptTokens(unmarked, { writeExcludedFromPrompt: true }).prompt_tokens,
    27
  );
});
