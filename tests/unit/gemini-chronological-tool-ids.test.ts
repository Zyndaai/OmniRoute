import test from "node:test";
import assert from "node:assert/strict";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.ts";
import {
  openaiToCloudCodeGeminiRequest,
  openaiToAntigravityRequest,
} from "../../open-sse/translator/request/openai-to-gemini.ts";
import {
  buildGeminiThoughtSignatureKey,
  scopeGeminiThoughtSignatureNamespace,
  storeGeminiThoughtSignature,
  clearGeminiThoughtSignatures,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { prefetchThoughtSignatures } from "../../open-sse/translator/index.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

type ToolPart = {
  thoughtSignature?: string;
  functionCall?: { id: string; name: string; args: unknown };
  functionResponse?: { id: string; name: string; response: { result: unknown } };
};
type Wire = { contents?: Array<{ parts: ToolPart[] }> };

function inputHistory() {
  return {
    input: [
      { type: "message", role: "user", content: "First turn" },
      { type: "function_call", call_id: "call_repeat", name: "first_tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call_repeat", output: "FIRST_RESULT" },
      { type: "message", role: "user", content: "Second turn" },
      { type: "custom_tool_call", call_id: "call_repeat", name: "second_tool", input: "raw patch" },
      { type: "custom_tool_call_output", call_id: "call_repeat", output: "SECOND_RESULT" },
      { type: "message", role: "user", content: "Continue" },
    ],
  };
}

function toolParts(wire: Wire): ToolPart[] {
  return (wire.contents || [])
    .flatMap((content) => content.parts)
    .filter((part) => part.functionCall || part.functionResponse);
}

test.after(async () => {
  await clearGeminiThoughtSignatures();
  await resetDbInstance();
});

test("#15312: Responses function/custom histories get unique paired Cloud Code wire IDs", async () => {
  const body = inputHistory();
  const original = structuredClone(body);
  const chat = openaiResponsesToOpenAIRequest("gemini-3.8-flash", body, false, null);
  const originalChat = structuredClone(chat);
  const wire = (await openaiToCloudCodeGeminiRequest("gemini-3.8-flash", chat, false)) as Wire;
  const parts = toolParts(wire);
  assert.deepEqual(
    parts.filter((part) => part.functionCall).map((part) => part.functionCall.id),
    ["call_repeat", "call_repeat_occ2"]
  );
  assert.deepEqual(
    parts.filter((part) => part.functionResponse).map((part) => part.functionResponse),
    [
      { id: "call_repeat", name: "first_tool", response: { result: "FIRST_RESULT" } },
      { id: "call_repeat_occ2", name: "second_tool", response: { result: "SECOND_RESULT" } },
    ]
  );
  assert.deepEqual(parts[2].functionCall.args, { input: "raw patch" });
  assert.deepEqual(body, original);
  assert.deepEqual(chat, originalChat);
  assert.deepEqual(
    toolParts((await openaiToCloudCodeGeminiRequest("gemini-3.8-flash", chat, false)) as Wire),
    parts
  );
});

test("ambiguous overlapping duplicate calls fail locally instead of guessing result pairing", async () => {
  const body = {
    input: [
      { type: "message", role: "user", content: "Parallel calls" },
      { type: "function_call", call_id: "same", name: "first", arguments: "{}" },
      { type: "function_call", call_id: "same", name: "second", arguments: "{}" },
      { type: "function_call_output", call_id: "same", output: "first result" },
      { type: "function_call_output", call_id: "same", output: "second result" },
    ],
  };
  const chat = openaiResponsesToOpenAIRequest("gemini-3.8-flash", body, false, null);
  await assert.rejects(
    openaiToCloudCodeGeminiRequest("gemini-3.8-flash", chat, false),
    (error: Error & { statusCode?: number; errorType?: string }) =>
      error.statusCode === 400 &&
      error.errorType === "invalid_request_error" &&
      error.message.includes("overlapping tool calls")
  );
});

test("Antigravity resolves cached signatures with original IDs before wire normalization", async () => {
  // Keys are model-family scoped (#4136) on both the store and the prefetch side.
  const namespace = scopeGeminiThoughtSignatureNamespace(
    "chronological-test",
    "gemini-3.8-flash"
  ) as string;
  await storeGeminiThoughtSignature(
    buildGeminiThoughtSignatureKey(namespace, "call_repeat"),
    "original-signature"
  );
  await storeGeminiThoughtSignature(
    buildGeminiThoughtSignatureKey(namespace, "call_repeat_occ2"),
    "wrong-signature"
  );
  const chat = openaiResponsesToOpenAIRequest("gemini-3.8-flash", inputHistory(), false, null);
  // The translators are synchronous; the async caller (translateRequest) reads the persisted
  // signatures first and hands them over as `_thoughtSignatures`. Mirror that here.
  // The prefetch scopes the raw connection namespace itself, so it gets the unscoped value.
  const _thoughtSignatures = await prefetchThoughtSignatures(
    FORMATS.ANTIGRAVITY,
    "gemini-3.8-flash",
    chat,
    "chronological-test"
  );
  const envelope = await openaiToAntigravityRequest("gemini-3.8-flash", chat, false, {
    projectId: "test-project",
    _signatureNamespace: namespace,
    _thoughtSignatures,
  });
  const calls = toolParts(envelope.request as Wire).filter((part) => part.functionCall);
  assert.deepEqual(
    calls.map((part) => part.functionCall.id),
    ["call_repeat", "call_repeat_occ2"]
  );
  assert.deepEqual(
    calls.map((part) => part.thoughtSignature),
    ["original-signature", "original-signature"]
  );
});

test("duplicate calls separated by a user turn are rejected before fallback response synthesis", async () => {
  const body = inputHistory();
  body.input.splice(2, 1);
  const chat = openaiResponsesToOpenAIRequest("gemini-3.8-flash", body, false, null);
  await assert.rejects(
    openaiToCloudCodeGeminiRequest("gemini-3.8-flash", chat, false),
    /overlapping tool calls/
  );
});

test("native Codex Responses passthrough retains the original repeated IDs", async () => {
  const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
  const history = inputHistory();
  const body = {
    ...history,
    input: history.input.map((item) =>
      item.type === "message"
        ? { ...item, content: [{ type: "input_text", text: item.content }] }
        : item
    ),
    model: "gpt-6.1",
    _nativeCodexPassthrough: true,
  };
  const input = structuredClone(body.input);
  const result = await new CodexExecutor().transformRequest("gpt-6.1", body, false, {} as never);
  assert.deepEqual(result.input, input);
  assert.deepEqual(body.input, input);
});
