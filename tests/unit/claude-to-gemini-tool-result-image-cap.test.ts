/**
 * Claude -> Gemini: every tool_result image is re-sent on every turn, so a long agent
 * session with screenshots grows the Gemini request without bound. Only the five newest
 * base64 tool_result images stay; each older one becomes a short text placeholder at the
 * same position, and the count is logged once per request.
 * (The Responses -> Chat path has the same cap, see translator-tool-output-image-cap-18684.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-image-cap-"));

const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { buildGeminiThoughtSignatureKey, clearGeminiThoughtSignatures } =
  await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

type Part = { inlineData?: { data: string }; text?: string };
type Translated = { contents: Array<{ role: string; parts: Part[] }> };

const PLACEHOLDER = "[Earlier tool result image omitted to bound request size]";

test.after(() => {
  clearGeminiThoughtSignatures();
  resetDbInstance();
});

function screenshotSession(_ns: string, count: number): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: "start" }];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `shot_${i}`, name: "screenshot", input: {} }],
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `shot_${i}`,
          content: [
            { type: "text", text: `shot ${i}` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: `IMG${i}` } },
          ],
        },
      ],
    });
  }
  return { messages };
}

async function translate(body: Record<string, unknown>, ns: string) {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  // The request translator reads thought signatures ahead of time (credentials), not from
  // the store: sign every tool_use of the session.
  const signatures = new Map<unknown, string>();
  for (const message of body.messages as Array<{ content: unknown }>) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type?: string; id?: string }>) {
      if (block.type === "tool_use" && block.id) {
        signatures.set(buildGeminiThoughtSignatureKey(ns, block.id), `SIG_${block.id}`);
      }
    }
  }
  try {
    const result = (await claudeToGeminiRequest("gemini-2.5-pro", body, false, {
      _signatureNamespace: ns,
      _thoughtSignatures: signatures,
    })) as Translated;
    return { result, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

const imagesIn = (result: Translated) =>
  result.contents.flatMap((c) => c.parts).filter((p) => p.inlineData);

test("only the five newest tool_result images are kept; older ones become placeholders", async () => {
  const { result, warnings } = await translate(screenshotSession("cap-eight", 8), "cap-eight");

  assert.deepEqual(
    imagesIn(result).map((p) => p.inlineData?.data),
    ["IMG3", "IMG4", "IMG5", "IMG6", "IMG7"]
  );
  assert.equal(JSON.stringify(result.contents).split(PLACEHOLDER).length - 1, 3);
  const capLogs = warnings.filter((w) => w.startsWith("TOOL_RESULT_IMAGE_CAP"));
  assert.equal(capLogs.length, 1, "the cap logs once per request");
  assert.match(capLogs[0], /kept=5 dropped=3/);
});

test("five tool_result images are all kept and nothing is logged", async () => {
  const { result, warnings } = await translate(screenshotSession("cap-five", 5), "cap-five");

  assert.equal(imagesIn(result).length, 5);
  assert.ok(!JSON.stringify(result.contents).includes(PLACEHOLDER));
  assert.equal(warnings.filter((w) => w.startsWith("TOOL_RESULT_IMAGE_CAP")).length, 0);
});

test("the placeholder keeps the tool response and the turn order valid", async () => {
  const { result } = await translate(screenshotSession("cap-order", 7), "cap-order");

  for (const content of result.contents) {
    const kinds = content.parts.map((p) => Object.keys(p)[0]);
    // A tool_result turn is one functionResponse (the placeholder text is folded into it),
    // optionally followed by its kept image.
    if (kinds.includes("functionResponse")) {
      assert.ok(
        kinds.length === 1 || (kinds.length === 2 && kinds[1] === "inlineData"),
        `unexpected part order: ${kinds.join(",")}`
      );
    }
  }
});

test("the caller's request body is not mutated", async () => {
  const body = screenshotSession("cap-pure", 7);
  const before = JSON.stringify(body);

  await translate(body, "cap-pure");

  assert.equal(JSON.stringify(body), before);
});
