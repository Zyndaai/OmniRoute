// Claude accepts an image block whose source is a URL, next to the base64 form.
// claude-to-openai.ts handled that in its `image` case but not in the `tool_result` branch
// right below it, so a tool that returned a URL image had the block JSON.stringify'd into the
// tool message. claude-to-gemini.ts had no URL branch at all: #13335 lifted base64 tool_result
// images there and noted that URL images were still flattened, leaving this half open. Gemini
// takes a remote image as `fileData: { fileUri }`, the mapping helpers/geminiHelper.ts uses for
// an OpenAI image_url that is a URL (#2807) — HTTPS only, the scheme the repo's own media-URL
// validator requires, so an empty, `http:`, `data:` or `file:` url stays dropped rather than
// reaching Gemini as a fileUri it will reject.
import test from "node:test";
import assert from "node:assert/strict";

const { claudeToOpenAIRequest } =
  await import("../../open-sse/translator/request/claude-to-openai.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const {
  buildGeminiThoughtSignatureKey,
  scopeGeminiThoughtSignatureNamespace,
  storeGeminiThoughtSignature,
} = await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
const { prefetchThoughtSignatures } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

type Part = Record<string, unknown>;
type Message = { role: string; content?: unknown; tool_call_id?: string };

const IMAGE_URL = "https://example.com/screenshot.png";
const urlImage = { type: "image", source: { type: "url", url: IMAGE_URL } };
const base64Image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
};

function toolCallHistory(resultContent: unknown[]) {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "screenshot", input: {} }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: resultContent }],
    },
  ];
}

function toOpenAI(messages: unknown[]): Message[] {
  return claudeToOpenAIRequest("gpt-4o", { messages }, false).messages as Message[];
}

let signatureSeq = 0;

// The signature store is async, so the chat pipeline prefetches the historical tool calls'
// signatures (chatCore → prefetchThoughtSignatures) and the translator reads that snapshot.
// Mirror that here: store under the model-scoped namespace, prefetch, then translate.
const GEMINI_MODEL = "gemini-2.5-pro";

async function toGemini(messages: unknown[]): Promise<Part[]> {
  const raw = `url-image-${++signatureSeq}`;
  const ns = scopeGeminiThoughtSignatureNamespace(raw, GEMINI_MODEL);
  await storeGeminiThoughtSignature(buildGeminiThoughtSignatureKey(ns, "tu_1"), "SIG");
  const thoughtSignatures = await prefetchThoughtSignatures(
    FORMATS.GEMINI,
    GEMINI_MODEL,
    { messages },
    raw
  );
  const result = await claudeToGeminiRequest(GEMINI_MODEL, { messages }, false, {
    _signatureNamespace: ns,
    _thoughtSignatures: thoughtSignatures,
  });
  return result.contents.flatMap((c: { parts: Part[] }) => c.parts);
}

test("claude→openai lifts a URL image out of a tool_result", () => {
  const messages = toOpenAI(toolCallHistory([urlImage]));
  const toolMessage = messages.find((m) => m.role === "tool");
  assert.equal(toolMessage?.content, "[tool returned an image; see attached]");
  assert.deepEqual(messages.at(-1), {
    role: "user",
    content: [{ type: "image_url", image_url: { url: IMAGE_URL } }],
  });
});

test("claude→openai keeps tool_result text next to a URL image", () => {
  const messages = toOpenAI(toolCallHistory([{ type: "text", text: "done" }, urlImage]));
  assert.equal(messages.find((m) => m.role === "tool")?.content, "done");
  assert.deepEqual(messages.at(-1), {
    role: "user",
    content: [{ type: "image_url", image_url: { url: IMAGE_URL } }],
  });
});

test("claude→openai still lifts a base64 tool_result image", () => {
  const messages = toOpenAI(toolCallHistory([base64Image]));
  assert.deepEqual(messages.at(-1), {
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } }],
  });
});

test("claude→gemini sends a URL image as fileData", async () => {
  const parts = await toGemini([
    { role: "user", content: [{ type: "text", text: "look" }, urlImage] },
  ]);
  assert.deepEqual(parts, [
    { text: "look" },
    { fileData: { fileUri: IMAGE_URL, mimeType: "image/*" } },
  ]);
});

test("claude→gemini sends a URL image from a tool_result after the tool response", async () => {
  const parts = await toGemini(toolCallHistory([urlImage]));
  const fileDataIndex = parts.findIndex((p) => p.fileData);
  const responseIndex = parts.findIndex((p) => p.functionResponse);
  assert.notEqual(fileDataIndex, -1, "the image must survive");
  assert.ok(fileDataIndex > responseIndex, "the image follows the tool response");
  assert.deepEqual(parts[fileDataIndex], {
    fileData: { fileUri: IMAGE_URL, mimeType: "image/*" },
  });
  assert.deepEqual(
    (parts[responseIndex].functionResponse as { response: { result: unknown } }).response.result,
    "[tool returned an image; see attached]"
  );
});

test("claude→gemini still sends a base64 image as inlineData", async () => {
  const parts = await toGemini([{ role: "user", content: [base64Image] }]);
  assert.deepEqual(parts, [{ inlineData: { mimeType: "image/png", data: "iVBORw0K" } }]);
});

test("claude→gemini keeps both tool_result images in order after the response and folds the text that follows into it", async () => {
  // The trailing text is the shape #13335 was about: Claude Code appends a reminder after the
  // tool result, and the images have to land right after the response. Since #16601 that
  // reminder is folded into functionResponse.response.result instead of following the images
  // as a loose text part, which Vertex Gemini 3.6+ Flash rejects next to a functionResponse
  // (#16443).
  const parts = await toGemini([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "screenshot", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: [base64Image, urlImage] },
        { type: "text", text: "keep going" },
      ],
    },
  ]);
  const responseIndex = parts.findIndex((p) => p.functionResponse);
  assert.deepEqual(parts.slice(responseIndex + 1), [
    { inlineData: { mimeType: "image/png", data: "iVBORw0K" } },
    { fileData: { fileUri: IMAGE_URL, mimeType: "image/*" } },
  ]);
  assert.equal(
    (parts[responseIndex].functionResponse as { response: { result: unknown } }).response.result,
    "[tool returned an image; see attached]\nkeep going"
  );
});

test("claude→gemini sends a URL image from a signature-less tool result too", async () => {
  // Without a stored thought signature the tool result becomes context text (#8979 / #3688);
  // the image still follows it, as the base64 half does.
  const result = await claudeToGeminiRequest(
    "gemini-2.5-pro",
    { messages: toolCallHistory([urlImage]) },
    false,
    {
      _signatureNamespace: "url-image-unsigned",
    }
  );
  const parts = result.contents.flatMap((c: { parts: Part[] }) => c.parts);
  const contextIndex = parts.findIndex(
    (p) => typeof p.text === "string" && p.text.includes("previous_tool_result_context")
  );
  assert.notEqual(contextIndex, -1, "an unsigned tool result becomes context text");
  assert.deepEqual(parts[contextIndex + 1], {
    fileData: { fileUri: IMAGE_URL, mimeType: "image/*" },
  });
});

test("a url source that Gemini cannot fetch is dropped, not forwarded", async () => {
  // Before: these were dropped silently. Forwarding them as a fileUri would turn a request
  // that worked without the image into a 400 from Gemini.
  for (const url of [
    "",
    "http://example.com/a.png",
    "data:image/png;base64,iVBORw0K",
    "file:///etc/passwd",
  ]) {
    const block = { type: "image", source: { type: "url", url } };
    assert.deepEqual(
      await toGemini([{ role: "user", content: [{ type: "text", text: "hi" }, block] }]),
      [{ text: "hi" }],
      `expected ${JSON.stringify(url)} to be dropped`
    );
  }
});

test("an image block with neither source shape is left alone", async () => {
  const odd = { type: "image", source: { type: "file", file_id: "file_123" } };
  assert.deepEqual(
    await toGemini([{ role: "user", content: [{ type: "text", text: "hi" }, odd] }]),
    [{ text: "hi" }]
  );
  const messages = toOpenAI(toolCallHistory([odd]));
  assert.equal(
    messages.find((m) => m.role === "tool")?.content,
    JSON.stringify([odd]),
    "unknown source shapes keep the old JSON fallback"
  );
});
