import test from "node:test";
import assert from "node:assert/strict";

// The memory engine was removed (Postgres migration): the injectMemoryAndSkills cases were dropped.
// The pure helpers below still exist in the chatCore skills injection module and are kept.
const { getSkillsProviderForFormat, sortToolsByName, mergeInjectedFallbackOwnerNames } =
  await import("../../open-sse/handlers/chatCore/memorySkillsInjection.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

// ─── getSkillsProviderForFormat (pure switch) ────────────────────────────────

test("getSkillsProviderForFormat maps CLAUDE -> anthropic", () => {
  assert.equal(getSkillsProviderForFormat(FORMATS.CLAUDE), "anthropic");
});

test("getSkillsProviderForFormat maps GEMINI -> google", () => {
  assert.equal(getSkillsProviderForFormat(FORMATS.GEMINI), "google");
});

test("getSkillsProviderForFormat maps OPENAI and any unknown format -> openai (default)", () => {
  assert.equal(getSkillsProviderForFormat(FORMATS.OPENAI), "openai");
  // any other / unknown format falls through to the default branch
  assert.equal(getSkillsProviderForFormat("removed-google-cli"), "openai");
  assert.equal(getSkillsProviderForFormat("codex"), "openai");
  assert.equal(getSkillsProviderForFormat("totally-unknown"), "openai");
  assert.equal(getSkillsProviderForFormat(""), "openai");
});

test("sortToolsByName sorts tools deterministically by function name or top-level name", () => {
  const unsorted = [
    { function: { name: "z_tool" } },
    { name: "a_tool" },
    { function: { name: "m_tool" } },
  ];
  const sorted = sortToolsByName(unsorted);
  assert.deepEqual(sorted, [
    { name: "a_tool" },
    { function: { name: "m_tool" } },
    { function: { name: "z_tool" } },
  ]);
});

// ─── Fix Round 2: Defect 5 — mergeInjectedFallbackOwnerNames + provenance ───

test("mergeInjectedFallbackOwnerNames: adds name only when enabled=true, convertedToolCount>0, toolName non-null, and not already in client tools", () => {
  const result = mergeInjectedFallbackOwnerNames({ builtinToolNames: ["memory_search"] }, [
    { enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 },
    { enabled: true, toolName: null, convertedToolCount: 1 },
    { enabled: false, toolName: "omniroute_web_fetch", convertedToolCount: 3 },
    { enabled: true, toolName: "omniroute_web_fetch", convertedToolCount: 0 },
  ]);

  assert.deepEqual(result.builtinToolNames, ["memory_search", "omniroute_web_search"]);
});

test("mergeInjectedFallbackOwnerNames: does not mutate input injectionResult", () => {
  const input = { builtinToolNames: ["original"] };
  const plans = [{ enabled: true, toolName: "omniroute_web_search", convertedToolCount: 1 }];
  const result = mergeInjectedFallbackOwnerNames(input, plans);

  // input must be unchanged
  assert.deepEqual(input.builtinToolNames, ["original"]);
  // result is a new object
  assert.notEqual(result, input);
  assert.deepEqual(result.builtinToolNames, ["original", "omniroute_web_search"]);
});

test("mergeInjectedFallbackOwnerNames: skips name already present in pre-conversion client tools", () => {
  const result = mergeInjectedFallbackOwnerNames({ builtinToolNames: ["omniroute_web_search"] }, [
    { enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 },
  ]);

  // Must not duplicate — omniroute_web_search already present
  assert.deepEqual(result.builtinToolNames, ["omniroute_web_search"]);
});

// ─── Fix Round 3: Defect 3 — pre-conversion collision guard ─────────────────

test("mergeInjectedFallbackOwnerNames: client has omniroute_web_search → not added to builtinToolNames even if enabled=true", () => {
  // Scenario: client sends {type:"web_search"} plus function named omniroute_web_search.
  // prepareWebSearchFallbackBody emits enabled=true, convertedToolCount=2 (from the
  // builtin conversion) but the synthetic tool was NOT added because client already has it.
  // mergeInjectedFallbackOwnerNames must check pre-conversion client names.
  const result = mergeInjectedFallbackOwnerNames(
    { builtinToolNames: [] },
    [{ enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 }],
    ["omniroute_web_search"]
  );

  // Must NOT add omniroute_web_search — client already owns it
  assert.deepEqual(result.builtinToolNames, []);
});

test("mergeInjectedFallbackOwnerNames: client has omniroute_web_fetch → not added to builtinToolNames", () => {
  const result = mergeInjectedFallbackOwnerNames(
    { builtinToolNames: [] },
    [{ enabled: true, toolName: "omniroute_web_fetch", convertedToolCount: 1 }],
    ["omniroute_web_fetch"]
  );

  assert.deepEqual(result.builtinToolNames, []);
});

test("mergeInjectedFallbackOwnerNames: client does NOT have the fallback name → added to builtinToolNames", () => {
  const result = mergeInjectedFallbackOwnerNames(
    { builtinToolNames: [] },
    [{ enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 }],
    ["some_other_tool"]
  );

  assert.deepEqual(result.builtinToolNames, ["omniroute_web_search"]);
});

test("mergeInjectedFallbackOwnerNames: no preConversionClientToolNames provided → falls back to existing behavior", () => {
  const result = mergeInjectedFallbackOwnerNames({ builtinToolNames: [] }, [
    { enabled: true, toolName: "omniroute_web_search", convertedToolCount: 2 },
  ]);

  assert.deepEqual(result.builtinToolNames, ["omniroute_web_search"]);
});
