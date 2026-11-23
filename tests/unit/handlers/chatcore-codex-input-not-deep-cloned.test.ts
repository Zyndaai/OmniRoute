import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-codex-input-share-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../../src/lib/db/core.ts");
const { prepareUpstreamBody } = await import("../../../open-sse/handlers/chatCore/upstreamBody.ts");
const { FORMATS } = await import("../../../open-sse/translator/formats.ts");

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(async () => {
  await coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function source() {
  return {
    model: "gpt-5.2",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    tools: [{ type: "function", name: "t", parameters: { type: "object" } }],
  };
}

// Records what the per-attempt step hands to structuredClone. A Codex Responses attempt must not
// deep-clone the full body (its `input` history can be huge); every other target still does.
async function wholeBodyClones(provider: string): Promise<{ clones: number; out: unknown }> {
  const body = source();
  const original = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    if (value === body) clones++;
    return original(value, options);
  }) as typeof structuredClone;
  try {
    const out = await prepareUpstreamBody({
      translatedBody: body,
      modelToCall: "gpt-5.2",
      provider,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      credentials: null,
    });
    assert.deepEqual((out as { tools: unknown }).tools, body.tools);
    assert.notEqual((out as { tools: unknown }).tools, body.tools, "tools stay isolated");
    return { clones, out };
  } finally {
    globalThis.structuredClone = original;
  }
}

test("a Codex Responses attempt does not deep-clone the whole body", async () => {
  assert.equal((await wholeBodyClones("codex")).clones, 0);
});

test("every other target keeps a full deep clone", async () => {
  assert.equal((await wholeBodyClones("openai")).clones, 1);
});
