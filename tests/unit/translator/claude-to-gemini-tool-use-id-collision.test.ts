/**
 * Claude → Gemini: a `tool_use.id` is only unique within one assistant turn. Long agent
 * sessions can reuse the same id for DIFFERENT tools across turns. The translator used a
 * conversation-wide `id → name` map (last wins), so the earlier `tool_result` was emitted
 * as a `functionResponse` named after the LATER tool — Gemini then sees
 * `functionCall edit` answered by `functionResponse bash` and rejects the whole request
 * with 400 INVALID_ARGUMENT on every subsequent turn (the client re-sends the history).
 *
 * Each `tool_result` must pair with the oldest unconsumed `tool_use` of its id.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { claudeToGeminiRequest } =
  await import("../../../open-sse/translator/request/claude-to-gemini.ts");
const { prefetchThoughtSignatures, translateRequest } =
  await import("../../../open-sse/translator/index.ts");
const {
  buildGeminiThoughtSignatureKey,
  scopeGeminiThoughtSignatureNamespace,
  storeGeminiThoughtSignature,
  clearGeminiThoughtSignatures,
  setGeminiThoughtSignatureMode,
} = await import("../../../open-sse/services/geminiThoughtSignatureStore.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");

const MODEL = "gemini-3.5-flash";

type Part = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string };
  functionResponse?: { id?: string; name: string; response: { result: unknown } };
};
type TranslatedBody = { contents: Array<{ role: string; parts: Part[] }> };

test.beforeEach(async () => {
  await clearGeminiThoughtSignatures();
});

test.after(async () => {
  await clearGeminiThoughtSignatures();
  resetDbInstance();
});

// The stream writer stores signatures under the model-family-scoped namespace, so the
// fixtures do the same; the request side reads them back through the same scoping.
async function storeSignature(ns: string, toolCallId: string, signature: string) {
  const scoped = scopeGeminiThoughtSignatureNamespace(ns, MODEL);
  await storeGeminiThoughtSignature(buildGeminiThoughtSignatureKey(scoped, toolCallId), signature);
}

function turnsFor(calls: Array<{ id: string; name: string; result: string; sig?: string }>) {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "start" }];
  for (const call of calls) {
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
          ...(call.sig ? { thoughtSignature: call.sig } : {}),
        },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: call.id, content: call.result }],
    });
  }
  return { messages };
}

async function translate(body: Record<string, unknown>, ns: string): Promise<TranslatedBody> {
  // Same read-ahead chatCore performs before translating a request to Gemini.
  const thoughtSignatures = await prefetchThoughtSignatures("gemini", MODEL, body, ns);
  return (await translateRequest("claude", "gemini", MODEL, body, false, null, null, null, {
    signatureNamespace: ns,
    thoughtSignatures,
  })) as TranslatedBody;
}

// Direct translator call, for the orphan case only: translateRequest strips orphaned
// tool_result blocks before a Gemini target (open-sse/translator/index.ts), so the
// context-text fallback is reachable only by calling the request translator itself.
async function translateDirect(body: Record<string, unknown>, ns: string): Promise<TranslatedBody> {
  return (await claudeToGeminiRequest(MODEL, body, false, {
    _signatureNamespace: ns,
  })) as TranslatedBody;
}

function allParts(result: TranslatedBody): Part[] {
  return result.contents.flatMap((c) => c.parts);
}

function callNames(result: TranslatedBody): string[] {
  return allParts(result)
    .filter((p) => p.functionCall)
    .map((p) => p.functionCall!.name);
}

function responseNames(result: TranslatedBody): string[] {
  return allParts(result)
    .filter((p) => p.functionResponse)
    .map((p) => p.functionResponse!.name);
}

test("a tool_use id reused across turns pairs each functionResponse with its own functionCall", async () => {
  const ns = "conn-4397-reuse";
  await storeSignature(ns, "toolu_same", "SIG_4397");

  const result = await translate(
    turnsFor([
      { id: "toolu_same", name: "edit", result: "edited" },
      { id: "toolu_same", name: "bash", result: "ran" },
    ]),
    ns
  );

  assert.deepEqual(callNames(result), ["edit", "bash"]);
  assert.deepEqual(responseNames(result), ["edit", "bash"]);
  const responses = allParts(result).filter((p) => p.functionResponse);
  assert.equal(responses[0].functionResponse!.response.result, "edited");
  assert.equal(responses[1].functionResponse!.response.result, "ran");
});

test("distinct tool_use ids keep their own names (guard)", async () => {
  const ns = "conn-4397-distinct";
  await storeSignature(ns, "toolu_a", "SIG_A");
  await storeSignature(ns, "toolu_b", "SIG_B");

  const result = await translate(
    turnsFor([
      { id: "toolu_a", name: "edit", result: "edited" },
      { id: "toolu_b", name: "bash", result: "ran" },
    ]),
    ns
  );

  assert.deepEqual(callNames(result), ["edit", "bash"]);
  assert.deepEqual(responseNames(result), ["edit", "bash"]);
});

test("three reuses of the same id are paired in arrival order", async () => {
  const ns = "conn-4397-triple";
  await storeSignature(ns, "toolu_same", "SIG_4397");

  const result = await translate(
    turnsFor([
      { id: "toolu_same", name: "edit", result: "r1" },
      { id: "toolu_same", name: "bash", result: "r2" },
      { id: "toolu_same", name: "read", result: "r3" },
    ]),
    ns
  );

  assert.deepEqual(callNames(result), ["edit", "bash", "read"]);
  assert.deepEqual(responseNames(result), ["edit", "bash", "read"]);
});

test("signature-less history: context text names the tool of its own occurrence", async () => {
  const result = await translate(
    turnsFor([
      { id: "toolu_same", name: "edit", result: "edited" },
      { id: "toolu_same", name: "bash", result: "ran" },
    ]),
    "conn-4397-nosig"
  );

  const contextTexts = allParts(result)
    .map((p) => p.text)
    .filter(
      (t): t is string => typeof t === "string" && t.includes("previous_tool_result_context")
    );
  assert.equal(contextTexts.length, 2);
  assert.ok(contextTexts[0].includes('source="edit"'), contextTexts[0]);
  assert.ok(contextTexts[0].includes("edited"));
  assert.ok(contextTexts[1].includes('source="bash"'), contextTexts[1]);
  assert.ok(contextTexts[1].includes("ran"));
  assert.equal(responseNames(result).length, 0);
});

test("per-occurrence client signatures stay on their own call, and native/text is decided per occurrence", async () => {
  // bypass mode honours a valid client-supplied thoughtSignature on each tool_use block.
  setGeminiThoughtSignatureMode("bypass");
  const sigEdit = `R${Buffer.from([0x12, 0x01, 0x41]).toString("base64")}`;
  const sigBash = `R${Buffer.from([0x12, 0x01, 0x42]).toString("base64")}`;

  const signedBoth = await translate(
    turnsFor([
      { id: "toolu_same", name: "edit", result: "edited", sig: sigEdit },
      { id: "toolu_same", name: "bash", result: "ran", sig: sigBash },
    ]),
    "conn-4397-bypass"
  );
  const signedCalls = allParts(signedBoth).filter((p) => p.functionCall);
  assert.deepEqual(
    signedCalls.map((p) => [p.functionCall!.name, p.thoughtSignature]),
    [
      ["edit", sigEdit],
      ["bash", sigBash],
    ]
  );
  assert.deepEqual(responseNames(signedBoth), ["edit", "bash"]);

  // Earlier occurrence unsigned, later one signed: the earlier pair must stay context
  // text — a native functionResponse there would answer a functionCall that was never sent.
  const mixed = await translate(
    turnsFor([
      { id: "toolu_same", name: "edit", result: "edited" },
      { id: "toolu_same", name: "bash", result: "ran", sig: sigBash },
    ]),
    "conn-4397-mixed"
  );
  assert.deepEqual(callNames(mixed), ["bash"]);
  assert.deepEqual(responseNames(mixed), ["bash"]);
  const mixedContext = allParts(mixed)
    .map((p) => p.text)
    .filter(
      (t): t is string => typeof t === "string" && t.includes("previous_tool_result_context")
    );
  assert.equal(mixedContext.length, 1);
  assert.ok(mixedContext[0].includes('source="edit"'), mixedContext[0]);
});

test("a tool_result whose tool_use is absent still falls back to context text", async () => {
  const result = await translateDirect(
    {
      messages: [
        { role: "user", content: "start" },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_orphan", content: "x" }],
        },
      ],
    },
    "conn-4397-orphan"
  );
  const texts = allParts(result).map((p) => p.text ?? "");
  assert.ok(texts.some((t) => t.includes('source="unknown"')));
  assert.equal(responseNames(result).length, 0);
});
