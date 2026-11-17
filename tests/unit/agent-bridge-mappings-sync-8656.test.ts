/**
 * Regression test for issue #8656 follow-up: model mappings saved via the UI
 * were invisible to the MITM proxy, because the proxy read a separate key_value
 * mirror (namespace='mitmAlias') that the UI never kept in sync.
 *
 * After the PostgreSQL migration the MITM proxy reads `agent_bridge_mappings`
 * directly, so the mirror is gone and `syncAgentBridgeMappingsToMitmAlias()` is a
 * no-op kept for callers. These tests pin the current contract: saved mappings are
 * the rows the proxy reads, replacing them replaces the rows, and no mitmAlias
 * entry is written.
 */
import test from "node:test";
import assert from "node:assert/strict";

const core = await import("../../src/lib/db/core.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const { getMitmAlias } = await import("../../src/lib/db/models/mitmAlias.ts");
const { setMappings, getMappingsForAgent, syncAgentBridgeMappingsToMitmAlias } =
  await import("../../src/lib/db/agentBridgeMappings.ts");

type StoredMapping = { source_model?: string; sourceModel?: string; target_model?: string; targetModel?: string };

async function storedPairs(agentId: string): Promise<Array<[string, string]>> {
  const rows = (await getMappingsForAgent(agentId)) as StoredMapping[];
  return rows
    .map((row): [string, string] => [
      (row.source_model ?? row.sourceModel) as string,
      (row.target_model ?? row.targetModel) as string,
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
});

test("setMappings stores antigravity mappings where the MITM proxy reads them", async () => {
  await setMappings("antigravity", [
    { source: "gpt-oss-120b-medium", target: "openai/gpt-4o" },
    { source: "gemini-2.0-flash", target: "anthropic/claude-sonnet-4" },
  ]);

  assert.deepEqual(await storedPairs("antigravity"), [
    ["gemini-2.0-flash", "anthropic/claude-sonnet-4"],
    ["gpt-oss-120b-medium", "openai/gpt-4o"],
  ]);
});

test("the MITM alias view reads the saved mappings and the sync step changes nothing", async () => {
  await setMappings("antigravity", [{ source: "gpt-oss-120b-medium", target: "openai/gpt-4o" }]);
  await syncAgentBridgeMappingsToMitmAlias("antigravity");

  assert.deepEqual(await getMitmAlias("antigravity"), {
    "gpt-oss-120b-medium": "openai/gpt-4o",
  });
});

test("setMappings replaces the previous mappings for the agent", async () => {
  await setMappings("antigravity", [{ source: "gpt-oss-120b-medium", target: "openai/gpt-4o" }]);
  await setMappings("antigravity", [
    { source: "gpt-oss-120b-medium", target: "anthropic/claude-opus-4" },
  ]);

  assert.deepEqual(await storedPairs("antigravity"), [
    ["gpt-oss-120b-medium", "anthropic/claude-opus-4"],
  ]);
});

test("setMappings with an empty list clears the agent's stored mappings", async () => {
  await setMappings("antigravity", [{ source: "gpt-oss-120b-medium", target: "openai/gpt-4o" }]);
  await setMappings("antigravity", []);

  assert.deepEqual(await storedPairs("antigravity"), []);
});

test("setMappings stores claude-code mappings independently of other agents", async () => {
  await setMappings("claude-code", [{ source: "claude-sonnet-4", target: "openai/gpt-4o" }]);
  await setMappings("cursor", [{ source: "gpt-4o", target: "openai/gpt-4o" }]);

  assert.deepEqual(await storedPairs("claude-code"), [["claude-sonnet-4", "openai/gpt-4o"]]);
  assert.deepEqual(await storedPairs("cursor"), [["gpt-4o", "openai/gpt-4o"]]);
});
