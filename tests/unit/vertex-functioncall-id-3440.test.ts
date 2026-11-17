// Regression test for #3440 — Vertex AI rejects tool calls because OmniRoute
// emits an `id` field inside `function_call` / `function_response` parts.
//
// Vertex AI (aiplatform.googleapis.com) follows an older Gemini REST schema whose
// FunctionCall/FunctionResponse protos have no `id` field, so it returns
// `400 INVALID_ARGUMENT: Unknown name "id" at 'contents[].parts[].function_call'`.
// The public Gemini API (generativelanguage.googleapis.com) DOES use `id` for
// Gemini 3+ signature matching, so the strip must be scoped to the vertex provider
// only (threaded via credentials._provider), never applied unconditionally.

import test from "node:test";
import assert from "node:assert/strict";

const { openaiToGeminiRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { translateRequest, prefetchThoughtSignatures } =
  await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const {
  buildGeminiThoughtSignatureKey,
  scopeGeminiThoughtSignatureNamespace,
  storeGeminiThoughtSignature,
} = await import("../../open-sse/services/geminiThoughtSignatureStore.ts");

type UnknownRecord = Record<string, unknown>;

/** Shape of the translated Gemini request the three finders below walk. */
interface GeminiRequestLike {
  contents?: Array<{ parts?: UnknownRecord[] }>;
}

const CLAUDE_SIGNATURE_NAMESPACE = "regression-3440";
const GEMINI_MODEL = "gemini-2.5-pro";

async function seedClaudeThoughtSignature() {
  await storeGeminiThoughtSignature(
    buildGeminiThoughtSignatureKey(
      scopeGeminiThoughtSignatureNamespace(CLAUDE_SIGNATURE_NAMESPACE, GEMINI_MODEL),
      "tu_weather_1"
    ),
    "SIG_3440"
  );
}

// Claude -> Gemini through the translate entry point, which prefetches the persisted
// thought signatures the synchronous translator reads (the signature store is async).
async function translateClaudeToGemini(provider: string | null): Promise<GeminiRequestLike> {
  const thoughtSignatures = await prefetchThoughtSignatures(
    FORMATS.GEMINI,
    GEMINI_MODEL,
    CLAUDE_TOOL_BODY,
    CLAUDE_SIGNATURE_NAMESPACE
  );
  return (await translateRequest(
    FORMATS.CLAUDE,
    FORMATS.GEMINI,
    GEMINI_MODEL,
    structuredClone(CLAUDE_TOOL_BODY),
    false,
    null,
    provider,
    null,
    { signatureNamespace: CLAUDE_SIGNATURE_NAMESPACE, thoughtSignatures }
  )) as GeminiRequestLike;
}

function findFunctionCall(result: GeminiRequestLike): UnknownRecord | undefined {
  for (const content of result.contents ?? []) {
    for (const part of content.parts ?? []) {
      if (part?.functionCall) return part.functionCall as UnknownRecord;
    }
  }
  return undefined;
}

function findFunctionCallPart(result: GeminiRequestLike): UnknownRecord | undefined {
  for (const content of result.contents ?? []) {
    for (const part of content.parts ?? []) {
      if (part?.functionCall) return part as UnknownRecord;
    }
  }
  return undefined;
}

function findFunctionResponse(result: GeminiRequestLike): UnknownRecord | undefined {
  for (const content of result.contents ?? []) {
    for (const part of content.parts ?? []) {
      if (part?.functionResponse) return part.functionResponse as UnknownRecord;
    }
  }
  return undefined;
}

const OPENAI_TOOL_BODY = {
  messages: [
    { role: "user", content: "What's the weather?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_weather_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_weather_1", content: '{"temp":20}' },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ],
};

const CLAUDE_TOOL_BODY = {
  messages: [
    { role: "user", content: "What's the weather?" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_weather_1", name: "get_weather", input: { city: "Tokyo" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_weather_1", content: '{"temp":20}' }],
    },
  ],
};

test("#3440 OpenAI->Gemini: vertex provider omits id from functionCall and functionResponse", async () => {
  const result = await openaiToGeminiRequest("gemini-2.5-pro", OPENAI_TOOL_BODY, false, {
    _provider: "vertex",
  });

  const fc = findFunctionCall(result);
  assert.ok(fc, "expected a functionCall part");
  assert.equal(fc.id, undefined, "functionCall.id must be omitted for Vertex");
  assert.equal(fc.name, "get_weather");

  const fr = findFunctionResponse(result);
  assert.ok(fr, "expected a functionResponse part");
  assert.equal(fr.id, undefined, "functionResponse.id must be omitted for Vertex");
});

test("#3440 OpenAI->Gemini: vertex-partner provider also omits id", async () => {
  const result = await openaiToGeminiRequest("gemini-2.5-pro", OPENAI_TOOL_BODY, false, {
    _provider: "vertex-partner",
  });
  assert.equal(findFunctionCall(result)?.id, undefined);
  assert.equal(findFunctionResponse(result)?.id, undefined);
});

test("#3440 OpenAI->Gemini: public gemini provider PRESERVES id (Gemini 3+ signature matching)", async () => {
  const result = await openaiToGeminiRequest("gemini-2.5-pro", OPENAI_TOOL_BODY, false, {
    _provider: "gemini",
  });
  assert.equal(
    findFunctionCall(result)?.id,
    "call_weather_1",
    "functionCall.id must be preserved for the public Gemini API"
  );
});

test("#3440 OpenAI->Gemini: no provider hint PRESERVES id (default, non-vertex)", async () => {
  const result = await openaiToGeminiRequest("gemini-2.5-pro", OPENAI_TOOL_BODY, false, null);
  assert.equal(findFunctionCall(result)?.id, "call_weather_1");
});

test("#3440 Claude->Gemini: vertex provider omits id from functionCall and functionResponse", async () => {
  await seedClaudeThoughtSignature();
  const result = await translateClaudeToGemini("vertex");
  assert.equal(
    findFunctionCall(result)?.id,
    undefined,
    "functionCall.id must be omitted for Vertex"
  );
  assert.equal(
    findFunctionResponse(result)?.id,
    undefined,
    "functionResponse.id must be omitted for Vertex"
  );

  const vertexPart = findFunctionCallPart(result);
  assert.ok(vertexPart, "expected a functionCall part");
  assert.equal(
    vertexPart.thoughtSignature,
    "SIG_3440",
    "thoughtSignature must be replayed even for Vertex (only id is stripped)"
  );
});

test("#3440 Claude->Gemini: no provider hint PRESERVES id (default, non-vertex)", async () => {
  await seedClaudeThoughtSignature();
  const result = await translateClaudeToGemini(null);
  assert.equal(findFunctionCall(result)?.id, "tu_weather_1");

  const nonVertexPart = findFunctionCallPart(result);
  assert.ok(nonVertexPart, "expected a functionCall part");
  assert.equal(
    nonVertexPart.thoughtSignature,
    "SIG_3440",
    "thoughtSignature must be replayed for direct Claude->Gemini path"
  );
});
