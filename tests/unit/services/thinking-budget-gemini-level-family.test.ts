/**
 * #18910: Gemini major versions <= 3 (including 3.8) keep the numeric thinkingBudget
 * off-switch; major versions >= 4 reject it and need the lowest thinkingLevel instead.
 * The translators and the Zed adapter are wired by their own owners; this covers the shared
 * helpers in thinkingBudget.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { gemini38ThinkingConfig, isGemini38Model, isGemini4PlusModel, isGeminiThinkingLevelModel } =
  await import("../../../open-sse/services/thinkingBudget.ts");

test("thinking-level models are 3.8 and every major version >= 4", () => {
  for (const model of [
    "gemini-3.8-flash-high",
    "gemini-4-argon-high",
    "vertex/gemini-4-argon",
    "gemini-5-pro",
    "gemini-10-flash",
  ]) {
    assert.equal(isGeminiThinkingLevelModel(model), true, model);
  }
  for (const model of ["gemini-2.5-flash", "gemini-3-flash", "gemini-3.1-pro", "gemma-4-27b"]) {
    assert.equal(isGeminiThinkingLevelModel(model), false, model);
  }
  assert.equal(isGemini38Model("gemini-5-pro"), true, "legacy alias follows the new predicate");
});

test("only major versions >= 4 are rejected by the numeric off-switch", () => {
  assert.equal(isGemini4PlusModel("gemini-4-argon-high"), true);
  assert.equal(isGemini4PlusModel("gemini-6-flash"), true);
  assert.equal(isGemini4PlusModel("gemini-3.8-flash-high"), false);
  assert.equal(isGemini4PlusModel("gemini-2.5-flash"), false);
});

test("turning thinking off: <= 3 keeps the numeric budget, >= 4 gets the lowest level", async () => {
  assert.deepEqual(await gemini38ThinkingConfig("gemini-3.8-flash-high", 0, {}), {
    thinkingBudget: 0,
    includeThoughts: false,
  });
  assert.deepEqual(await gemini38ThinkingConfig("gemini-4-argon-high", 0, {}), {
    thinkingLevel: "low",
  });
});

test("includeThoughts defaults on and a client can opt out", async () => {
  const byDefault = await gemini38ThinkingConfig("gemini-4-argon-high", 24576, {});
  assert.equal((byDefault as { includeThoughts?: boolean }).includeThoughts, true);
  const optedOut = await gemini38ThinkingConfig("gemini-4-argon-high", 24576, {
    include_thoughts: false,
  });
  assert.equal((optedOut as { includeThoughts?: boolean }).includeThoughts, undefined);
});
