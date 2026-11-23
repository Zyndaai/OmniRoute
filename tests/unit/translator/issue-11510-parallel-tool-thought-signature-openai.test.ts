import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToGeminiRequest } from "../../../open-sse/translator/request/openai-to-gemini.ts";
import { prefetchThoughtSignatures } from "../../../open-sse/translator/index.ts";
import { FORMATS } from "../../../open-sse/translator/formats.ts";
import {
  storeGeminiThoughtSignature,
  buildGeminiThoughtSignatureKey,
  scopeGeminiThoughtSignatureNamespace,
} from "../../../open-sse/services/geminiThoughtSignatureStore.ts";

// Mirror of tests/unit/translator/issue-11510-parallel-tool-thought-signature.test.ts for the
// OpenAI-protocol → Gemini path (openai-to-gemini.ts). The same
// shouldUseEmbeddedSignature/firstPersistedSignature gating dropped a resolved,
// individually-valid thoughtSignature for every tool_calls[] entry after the
// first one in a parallel (multi tool_calls) assistant turn, reproducing
// Gemini 3.x's HTTP 400 "Function call is missing a thought_signature in
// functionCall parts" (#11510).
test("openai→gemini must attach EACH resolved thoughtSignature on a parallel (multi tool_calls) turn (#11510)", async () => {
  const ns = "conn-11510-openai-parallel";
  const model = "gemini-3.5-flash";
  const toolId1 = "call_11510_first";
  const toolId2 = "call_11510_second_webfetch";
  const sig1 = "SIG_11510_OPENAI_FIRST";
  const sig2 = "SIG_11510_OPENAI_SECOND";

  // Production scopes the connection namespace by model family before keying the store
  // (translator/index.ts); the store keys and the translator credentials must use that scope.
  const scoped = scopeGeminiThoughtSignatureNamespace(ns, model);
  await storeGeminiThoughtSignature(buildGeminiThoughtSignatureKey(scoped, toolId1), sig1);
  await storeGeminiThoughtSignature(buildGeminiThoughtSignatureKey(scoped, toolId2), sig2);

  const body = {
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolId1,
            type: "function",
            function: { name: "default_api:Read", arguments: JSON.stringify({ path: "/a" }) },
          },
          {
            id: toolId2,
            type: "function",
            function: {
              name: "default_api:WebFetch",
              arguments: JSON.stringify({ url: "https://example.com" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: toolId1, content: "file a" },
      { role: "tool", tool_call_id: toolId2, content: "fetched" },
    ],
  };
  // The Gemini translators read the signature store through the snapshot the async
  // caller prefetches (translator/index.ts prefetchThoughtSignatures), as the chat pipeline does.
  const thoughtSignatures = await prefetchThoughtSignatures(FORMATS.GEMINI, model, body, ns);

  const result = (await openaiToGeminiRequest(model, body, false, {
    _signatureNamespace: scoped,
    _thoughtSignatures: thoughtSignatures,
  })) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };

  const modelTurn = result.contents.find(
    (c) => c.role === "model" && c.parts?.some((p) => p.functionCall)
  );
  assert.ok(modelTurn, "expected a model turn with functionCall parts");

  const fcParts = modelTurn!.parts.filter((p) => p.functionCall) as Array<{
    thoughtSignature?: string;
    functionCall: { name: string };
  }>;
  assert.equal(fcParts.length, 2, "both tool_calls entries must be emitted as native functionCall");

  const webFetchPart = fcParts.find((p) => p.functionCall.name.includes("WebFetch"));
  assert.ok(webFetchPart, "WebFetch functionCall part must be present");

  assert.equal(
    webFetchPart!.thoughtSignature,
    sig2,
    "second functionCall in a parallel tool_calls turn must keep its own resolved " +
      "thoughtSignature, or Gemini 3.x rejects the request with HTTP 400 " +
      "'Function call is missing a thought_signature in functionCall parts'"
  );
});
