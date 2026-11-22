/**
 * Claude -> Gemini: the Claude `tool_choice` must reach Gemini as `toolConfig`.
 * The direct translator built `tools` but never set `toolConfig`, so a forced tool
 * (`any`, a named tool) and a disabled tool call (`none`) were silently ignored.
 * The OpenAI -> Gemini translator already does this for the OpenAI `tool_choice`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-tool-choice-"));

const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

type Translated = {
  tools?: Array<{ functionDeclarations?: Array<{ name: string }>; googleSearch?: unknown }>;
  toolConfig?: { functionCallingConfig: Record<string, unknown> };
};

test.after(() => resetDbInstance());

const TOOLS = [
  { name: "read_file", description: "read", input_schema: { type: "object", properties: {} } },
  { name: "run shell", description: "run", input_schema: { type: "object", properties: {} } },
];

async function translate(toolChoice: unknown, tools: unknown[] = TOOLS): Promise<Translated> {
  return (await claudeToGeminiRequest(
    "gemini-2.5-pro",
    {
      messages: [{ role: "user", content: "go" }],
      tools,
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    },
    false
  )) as Translated;
}

test("tool_choice any forces a function call", async () => {
  assert.deepEqual((await translate({ type: "any" })).toolConfig, {
    functionCallingConfig: { mode: "ANY" },
  });
});

test("tool_choice none disables function calls", async () => {
  assert.deepEqual((await translate({ type: "none" })).toolConfig, {
    functionCallingConfig: { mode: "NONE" },
  });
});

test("a named tool_choice forces that function, using its sanitized declaration name", async () => {
  const result = await translate({ type: "tool", name: "run shell" });
  const declared = result.tools?.[0].functionDeclarations?.map((d) => d.name) ?? [];
  const config = result.toolConfig?.functionCallingConfig as {
    mode: string;
    allowedFunctionNames: string[];
  };

  assert.equal(config.mode, "ANY");
  assert.equal(config.allowedFunctionNames.length, 1);
  assert.ok(declared.includes(config.allowedFunctionNames[0]), "name must match a declaration");
  assert.notEqual(config.allowedFunctionNames[0], "run shell", "the raw name is not valid");
});

test("auto and an absent tool_choice leave toolConfig unset", async () => {
  assert.equal((await translate({ type: "auto" })).toolConfig, undefined);
  assert.equal((await translate(undefined)).toolConfig, undefined);
});

test("a forced tool without a declaration is rejected with a 400", async () => {
  await assert.rejects(
    () => translate({ type: "tool", name: "missing_tool" }),
    (error: Error & { statusCode?: number }) =>
      error.statusCode === 400 && /missing_tool/.test(error.message)
  );
});

test("tool_choice none also drops the native web search tool", async () => {
  const search = [{ type: "web_search_20250305", name: "web_search" }];

  assert.equal((await translate({ type: "auto" }, search)).tools?.[0].googleSearch !== undefined, true);
  assert.equal((await translate({ type: "none" }, search)).tools, undefined);
});

test("forcing the sole native web search tool does not throw or set toolConfig", async () => {
  const search = [{ type: "web_search_20250305", name: "web_search" }];
  const result = await translate({ type: "tool", name: "web_search" }, search);

  assert.equal(result.toolConfig, undefined);
  assert.notEqual(result.tools?.[0].googleSearch, undefined);
});

test("forcing a dropped native web search tool next to custom tools keeps the old behaviour", async () => {
  const mixed = [{ type: "web_search_20250305", name: "web_search" }, ...TOOLS];
  const result = await translate({ type: "tool", name: "web_search" }, mixed);

  assert.equal(result.toolConfig, undefined);
  assert.equal(result.tools?.[0].functionDeclarations?.length, 2);
});
