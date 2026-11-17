// MCP skill tools act on per-tenant data. The tenant must be the authenticated caller,
// never an `apiKeyId` written into the tool arguments: otherwise any MCP client could enable or
// run another tenant's or the global skills.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-mcp-owner-"));
const TEST_DATA_DIR = path.join(TEST_ROOT, "data");
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY;
const ORIGINAL_ROUTER_API_KEY = process.env.ROUTER_API_KEY;
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.OMNIROUTE_API_KEY;
delete process.env.ROUTER_API_KEY;

const coreDb = await import("../../src/lib/db/core.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");
const { skillRegistry } = await import("../../src/lib/skills/registry.ts");
const { skillExecutor } = await import("../../src/lib/skills/executor.ts");
const { skillTools } = await import("../../open-sse/mcp-server/tools/skillTools.ts");

type ToolResult = {
  skills: Array<{ name: string }>;
  count: number;
  success: boolean;
};
type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
const handlerOf = (tool: unknown): ToolHandler => (tool as { handler: ToolHandler }).handler;

const callerA = { authInfo: { clientId: "tenant-a", scopes: ["mcp:connect"] } };

function resetSkills() {
  skillRegistry["registeredSkills"].clear();
  skillRegistry["versionCache"].clear();
  skillExecutor["handlers"].clear();
}

test.beforeEach(async () => {
  resetSkills();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(async () => {
  resetSkills();
  await coreDb.resetDbInstance();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_OMNIROUTE_API_KEY !== undefined)
    process.env.OMNIROUTE_API_KEY = ORIGINAL_OMNIROUTE_API_KEY;
  if (ORIGINAL_ROUTER_API_KEY !== undefined) process.env.ROUTER_API_KEY = ORIGINAL_ROUTER_API_KEY;
});

async function registerSkill(name: string, apiKeyId: string, enabled: boolean, handler: string) {
  return skillRegistry.register({
    name,
    version: "1.0.0",
    description: name,
    schema: { input: {}, output: {} },
    handler,
    enabled,
    apiKeyId,
  });
}

test("skills_enable as tenant A cannot switch on a global or another tenant's skill", async () => {
  const globalSkill = await registerSkill("global-tool", "system", false, "global-handler");
  const otherSkill = await registerSkill("b-tool", "tenant-b", false, "b-handler");

  for (const [skillId, ownerArg] of [
    [globalSkill.id, "system"],
    [otherSkill.id, "tenant-b"],
  ]) {
    await assert.rejects(
      handlerOf(skillTools.omniroute_skills_enable)(
        { apiKeyId: ownerArg, skillId, enabled: true },
        callerA
      ),
      /Skill not found/
    );
  }

  await skillRegistry.loadFromDatabase("system");
  assert.equal(skillRegistry.list("system").find((s) => s.name === "global-tool")?.enabled, false);
});

test("skills_execute as tenant A never runs tenant B's skill", async () => {
  let ran = false;
  skillExecutor.registerHandler("b-handler", async () => {
    ran = true;
    return { ok: true };
  });
  await registerSkill("b-tool", "tenant-b", true, "b-handler");

  await assert.rejects(
    handlerOf(skillTools.omniroute_skills_execute)(
      { apiKeyId: "tenant-b", skillName: "b-tool", input: {} },
      callerA
    ),
    /Skill not found/
  );
  assert.equal(ran, false);
});

test("skills_list and skills_executions default to the caller's own tenant", async () => {
  await registerSkill("a-tool", "tenant-a", true, "a-handler");
  await registerSkill("b-tool", "tenant-b", true, "b-handler");

  const listed = await handlerOf(skillTools.omniroute_skills_list)(
    { apiKeyId: "tenant-b" },
    callerA
  );
  const names = listed.skills.map((s) => s.name);
  assert.ok(names.includes("a-tool"));
  assert.ok(!names.includes("b-tool"));

  const executions = await handlerOf(skillTools.omniroute_skills_executions)(
    { apiKeyId: "tenant-b" },
    callerA
  );
  assert.equal(executions.count, 0);
});

test("a local process with no key still manages skills by the owner it names", async () => {
  await registerSkill("local-tool", "local-owner", false, "l-handler");
  const skill = skillRegistry.list("local-owner").find((s) => s.name === "local-tool");

  const result = await handlerOf(skillTools.omniroute_skills_enable)(
    { apiKeyId: "local-owner", skillId: skill!.id, enabled: true },
    undefined
  );

  assert.equal(result.success, true);
});
