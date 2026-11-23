/**
 * #13941 pending 2 - MCP audit rows must carry the caller's API-key id.
 *
 * logToolCall used to stamp process.env.OMNIROUTE_API_KEY_ID, which is unset
 * on almost every install. Selecting any dashboard key then dropped every MCP
 * bar. The stamp must come from resolveMcpCallerApiKeyId (HTTP headers first,
 * env-key lookup for stdio).
 *
 * The audit log lives in PostgreSQL (mcp_tool_audit); each case reads the row back.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

const audit = await import("../../../open-sse/mcp-server/audit.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");

beforeEach(async () => {
  await resetTestDb();
});

async function onlyAuditRowApiKeyId(): Promise<unknown> {
  const { entries, total } = await audit.queryAuditEntries({});
  assert.equal(total, 1, "exactly one audit row");
  return entries[0].apiKeyId;
}

test("logToolCall stamps the resolved caller id, not OMNIROUTE_API_KEY_ID", async (t) => {
  process.env.OMNIROUTE_API_KEY_ID = "env-stale-id";
  t.after(() => {
    delete process.env.OMNIROUTE_API_KEY_ID;
  });
  audit.__setAuditCallerIdResolverForTests(async () => "key-from-header");
  t.after(() => audit.__setAuditCallerIdResolverForTests(null));

  await audit.logToolCall("omniroute_get_health", {}, {}, 3, true);
  assert.equal(await onlyAuditRowApiKeyId(), "key-from-header");
});

test("logToolCall writes null when no caller id resolves and the env id is unset", async (t) => {
  delete process.env.OMNIROUTE_API_KEY_ID;
  audit.__setAuditCallerIdResolverForTests(async () => undefined);
  t.after(() => audit.__setAuditCallerIdResolverForTests(null));

  await audit.logToolCall("omniroute_get_health", {}, {}, 3, true);
  assert.equal(await onlyAuditRowApiKeyId(), null);
});

test("logToolCall writes null when the resolver returns an empty string", async (t) => {
  audit.__setAuditCallerIdResolverForTests(async () => "");
  t.after(() => audit.__setAuditCallerIdResolverForTests(null));

  await audit.logToolCall("omniroute_get_health", {}, {}, 3, true);
  assert.equal(await onlyAuditRowApiKeyId(), null);
});
