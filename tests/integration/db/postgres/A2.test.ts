import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../../../../src/lib/db/pg.ts";
import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyById,
  getApiKeyMetadata,
  getApiKeys,
  getApiKeysCount,
  getExclusiveLeaseConnectionIds,
  regenerateApiKey,
  revokeApiKey,
  setApiKeyExpiry,
  updateApiKeyPermissions,
  validateApiKey,
  clearApiKeyCaches,
} from "../../../../src/lib/db/apiKeys.ts";
import { isNoLog, setNoLog } from "../../../../src/lib/compliance/noLog.ts";
import {
  createAccessToken,
  getAccessToken,
  listAccessTokens,
  revokeAccessToken,
  verifyAccessToken,
} from "../../../../src/lib/db/accessTokens.ts";
import {
  deleteApiKeyContextSource,
  getApiKeyContextSource,
  listApiKeyContextSources,
  setApiKeyContextSource,
} from "../../../../src/lib/db/apiKeyContextSources.ts";
import {
  addGroupPermission,
  addKeyToGroup,
  checkKeyModelAccess,
  createKeyGroup,
  deleteKeyGroup,
  filterExistingActiveKeyGroupIds,
  getAllKeyGroups,
  getGroupMembers,
  getKeyGroupWithPermissions,
  getKeyGroupsForApiKey,
  removeGroupPermission,
  removeKeyFromGroup,
  updateKeyGroup,
} from "../../../../src/lib/db/apiKeyGroups.ts";
import {
  deleteOverridesForApiKey,
  getExcludedConnectionIds,
  listOverrides,
  setExcluded,
} from "../../../../src/lib/db/autoCandidateOverrides.ts";
import {
  checkQuota,
  getAccountKeyLimit,
  getProviderKeyLimit,
  getRegisteredKey,
  incrementRegisteredKeyUsage,
  issueRegisteredKey,
  listRegisteredKeys,
  revokeRegisteredKey,
  setAccountKeyLimit,
  setProviderKeyLimit,
  validateRegisteredKey,
} from "../../../../src/lib/db/registeredKeys.ts";
import { getSsoIdentity, getSsoShadowSecret, provisionSsoIdentity } from "../../../../src/lib/db/ssoIdentities.ts";
import {
  createSyncTokenRecord,
  getSyncTokenByHash,
  getSyncTokenById,
  listSyncTokens,
  revokeSyncToken,
  touchSyncTokenLastUsed,
} from "../../../../src/lib/db/syncTokens.ts";
import {
  advanceTeamBudgetWindow,
  archiveTeam,
  assignApiKeyBillingTeam,
  createTeam,
  getActiveBillingTeamForApiKey,
  getTeam,
  hasPartialRetainedTeamUsage,
  listApiKeyBillingHistory,
  listTeamKeyOptions,
  listTeamMembers,
  listTeams,
  resolveBillingTeamIdForApiKeyAt,
  unassignApiKeyBillingTeam,
  updateTeam,
} from "../../../../src/lib/db/teams.ts";
import { revokeComboGrantsByName } from "../../../../src/lib/db/apiKeys/comboGrantRevocation.ts";
import { backfillApiKeySecretsAtRest } from "../../../../src/lib/db/apiKeys/secretAtRest.ts";

const MACHINE = "0123456789abcdef";
process.env.API_KEY_SECRET ||= "a2-test-api-key-secret";

beforeEach(async () => {
  await truncateAll(getTestBackend());
  clearApiKeyCaches();
});

test("api keys: create, read, validate, update, revoke, delete", async () => {
  const created = await createApiKey("alpha", MACHINE, ["manage"], {
    allowedModels: ["gpt-4o"],
    allowedConnections: ["conn-1"],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.ok(created.key.length > 12);
  assert.equal(await getApiKeysCount(), 1);

  const row = await db().queryOne<{ key_hash: string; key: string; allowed_models: unknown }>(
    "SELECT key_hash, key, allowed_models FROM api_keys WHERE id = $1",
    [created.id]
  );
  assert.match(row!.key_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(row!.allowed_models, ["gpt-4o"]);

  const byId = await getApiKeyById(created.id);
  assert.equal(byId!.key, created.key);
  assert.equal(byId!.modelAccessMode, "restricted");
  assert.deepEqual(byId!.allowedModels, ["gpt-4o"]);
  assert.deepEqual(byId!.scopes, ["manage"]);
  assert.equal(byId!.isActive, true);
  assert.equal(byId!.compressionEnabled, true);
  assert.equal(await getApiKeyById("missing"), null);

  assert.equal((await getApiKeys()).length, 1);
  assert.equal((await getApiKeys(10, 0)).length, 1);
  assert.equal((await getApiKeys(10, 5)).length, 0);

  assert.equal(await validateApiKey(created.key), true);
  assert.equal(await validateApiKey("sk-nope"), false);
  const used = await db().queryOne<{ last_used_at: string | null }>(
    "SELECT last_used_at FROM api_keys WHERE id = $1",
    [created.id]
  );
  assert.ok(used!.last_used_at);

  const meta = await getApiKeyMetadata(created.key);
  assert.equal(meta!.id, created.id);
  assert.equal(meta!.expiresAt !== null, true);
  assert.deepEqual(meta!.allowedConnections, ["conn-1"]);
  assert.deepEqual(meta!.accessSchedule, null);

  const schedule = { enabled: true, from: "08:00", until: "18:00", days: [1, 2, 3], tz: "UTC" };
  assert.equal(
    await updateApiKeyPermissions(created.id, {
      name: "alpha2",
      noLog: true,
      isBanned: false,
      blockedModels: ["bad-*"],
      allowedQuotas: ["q1"],
      accessSchedule: schedule,
      rateLimits: [{ limit: 5, window: 60 }],
      maxRequestsPerDay: 100,
      usageLimitEnabled: true,
      dailyUsageLimitUsd: 2.5,
      expiresAt: "2098-06-01T00:00:00.000Z",
      forcedModel: "x/y",
      scopes: ["manage", "extra"],
    }),
    true
  );
  clearApiKeyCaches();
  const after = await getApiKeyMetadata(created.key);
  assert.equal(after!.name, "alpha2");
  assert.equal(after!.noLog, true);
  assert.deepEqual(after!.blockedModels, ["bad-*"]);
  assert.deepEqual(after!.allowedQuotas, ["q1"]);
  assert.deepEqual(after!.accessSchedule, schedule);
  assert.deepEqual(after!.rateLimits, [{ limit: 5, window: 60 }]);
  assert.equal(after!.maxRequestsPerDay, 100);
  assert.equal(after!.usageLimitEnabled, true);
  assert.equal(after!.dailyUsageLimitUsd, 2.5);
  assert.equal(after!.forcedModel, "x/y");
  assert.deepEqual(after!.scopes, ["manage", "extra"]);
  assert.equal(await isNoLog(created.id), true);
  assert.equal(await updateApiKeyPermissions("missing", { name: "x" }), false);

  // lease:exclusive requires explicit connections
  await assert.rejects(
    updateApiKeyPermissions(created.id, { scopes: ["lease:exclusive"], allowedConnections: [] }),
    /lease:exclusive requires explicit allowedConnections/
  );
  await updateApiKeyPermissions(created.id, {
    scopes: ["lease:exclusive"],
    allowedConnections: ["c-lease"],
  });
  assert.deepEqual([...(await getExclusiveLeaseConnectionIds())], ["c-lease"]);

  const regenerated = await regenerateApiKey(created.id);
  assert.ok(regenerated);
  assert.equal(await validateApiKey(created.key), false);
  assert.equal(await validateApiKey(regenerated!.key), true);

  assert.equal(await setApiKeyExpiry(created.id, "2000-01-01T00:00:00.000Z"), true);
  clearApiKeyCaches();
  assert.equal(await validateApiKey(regenerated!.key), false);
  assert.equal(await setApiKeyExpiry(created.id, null), true);
  clearApiKeyCaches();
  assert.equal(await validateApiKey(regenerated!.key), true);

  assert.equal(await revokeApiKey(created.id), true);
  clearApiKeyCaches();
  assert.equal(await validateApiKey(regenerated!.key), false);
  assert.equal(await revokeApiKey("missing"), false);

  assert.equal(await deleteApiKey(created.id), true);
  assert.equal(await deleteApiKey(created.id), false);
  assert.equal(await getApiKeysCount(), 0);
});

test("deleteApiKey cascades children and clears the FK-less tables", async () => {
  const key = await createApiKey("cascade", MACHINE);
  await setApiKeyContextSource(key.id, "obsidian", { token: "t", baseUrl: "http://x" });
  const group = await createKeyGroup("g");
  await addKeyToGroup(key.id, group.id);
  await setExcluded(key.id, "auto", "conn-9", true);
  await db().execute(
    "INSERT INTO domain_budgets (api_key_id, daily_limit_usd) VALUES ($1, 5)",
    [key.id]
  ).catch(() => undefined);
  await createSyncTokenRecord({ name: "s", tokenHash: "h-cascade", syncApiKeyId: key.id });

  assert.equal(await deleteApiKey(key.id), true);
  assert.equal((await listApiKeyContextSources(key.id)).length, 0);
  assert.equal((await getGroupMembers(group.id)).length, 0);
  assert.equal((await listOverrides(key.id, "auto")).length, 0);
  assert.equal(await getSyncTokenByHash("h-cascade"), null);
});

test("noLog reads the persisted flag and honours setNoLog", async () => {
  const key = await createApiKey("nl", MACHINE);
  assert.equal(await isNoLog(key.id), false);
  await db().execute("UPDATE api_keys SET no_log = true WHERE id = $1", [key.id]);
  assert.equal(await isNoLog(key.id), false, "cached for 30s");
  setNoLog(key.id, true);
  assert.equal(await isNoLog(key.id), true);

  // a row the process never cached is read from the table
  await db().execute(
    "INSERT INTO api_keys (id, name, key, key_hash, no_log) VALUES ('raw-1', 'raw', 'sk-raw', $1, true)",
    ["a".repeat(64)]
  );
  assert.equal(await isNoLog("raw-1"), true);
  assert.equal(await isNoLog("never-seen"), false);
  assert.equal(await isNoLog(""), false);
});

test("access tokens: create, verify, list, revoke by id and prefix", async () => {
  const a = await createAccessToken({ name: "cli", scope: "write" });
  const b = await createAccessToken({ name: "ci", expiresAt: "2000-01-01T00:00:00.000Z" });
  await assert.rejects(createAccessToken({ name: "  " }), /name is required/);

  const verified = await verifyAccessToken(a.secret);
  assert.equal(verified!.id, a.record.id);
  assert.equal(verified!.scope, "write");
  assert.equal(await verifyAccessToken(b.secret), null, "expired token");
  assert.equal(await verifyAccessToken("nope"), null);
  assert.ok((await getAccessToken(a.record.id))!.lastUsedAt);

  assert.equal((await listAccessTokens()).length, 2);
  assert.equal((await getAccessToken("missing")), null);

  const revoked = await revokeAccessToken(a.record.tokenPrefix);
  assert.deepEqual(revoked, { revoked: true, alreadyRevoked: false, ambiguous: false });
  assert.equal(await verifyAccessToken(a.secret), null);
  assert.deepEqual(await revokeAccessToken(a.record.id), {
    revoked: true,
    alreadyRevoked: true,
    ambiguous: false,
  });
  assert.deepEqual(await revokeAccessToken("tok_unknown"), {
    revoked: false,
    alreadyRevoked: false,
    ambiguous: false,
  });
});

test("api key context sources: upsert keeps unset fields, token is encrypted-compatible", async () => {
  const key = await createApiKey("ctx", MACHINE);
  await setApiKeyContextSource(key.id, "obsidian", { token: "secret", baseUrl: "http://a" });
  await setApiKeyContextSource(key.id, "obsidian", { vaultPath: "/v" });
  const source = await getApiKeyContextSource(key.id, "obsidian");
  assert.equal(source!.token, "secret");
  assert.equal(source!.baseUrl, "http://a");
  assert.equal(source!.vaultPath, "/v");
  assert.equal(source!.enabled, true);

  await setApiKeyContextSource(key.id, "obsidian", { enabled: false });
  assert.equal(await getApiKeyContextSource(key.id, "obsidian"), null);
  assert.equal((await listApiKeyContextSources(key.id))[0].enabled, false);

  // concurrent first writes do not fail on the primary key
  await Promise.all([
    setApiKeyContextSource(key.id, "notion", { token: "a" }),
    setApiKeyContextSource(key.id, "notion", { baseUrl: "b" }),
  ]);
  assert.equal((await listApiKeyContextSources(key.id)).length, 2);

  await deleteApiKeyContextSource(key.id, "obsidian");
  assert.equal((await listApiKeyContextSources(key.id)).length, 1);
  assert.equal(await getApiKeyContextSource(null, "x"), null);
});

test("key groups: CRUD, membership, permission checks", async () => {
  const key = await createApiKey("grp", MACHINE);
  const group = await createKeyGroup("team-a", "desc");
  assert.equal(group.isActive, true);
  assert.equal((await getAllKeyGroups()).length, 1);

  assert.equal((await checkKeyModelAccess(key.id, "gpt-4o")).allowed, true, "no groups = open");
  assert.equal(await addKeyToGroup(key.id, group.id), true);
  assert.equal(await addKeyToGroup(key.id, group.id), true, "idempotent");
  assert.equal(await addKeyToGroup(key.id, "no-such-group"), false);
  assert.equal((await getGroupMembers(group.id)).length, 1);
  assert.equal((await getKeyGroupsForApiKey(key.id)).length, 1);

  assert.equal((await checkKeyModelAccess(key.id, "gpt-4o")).allowed, false, "no allow rule");
  const allow = await addGroupPermission(group.id, "gpt-*", "allow");
  const deny = await addGroupPermission(group.id, "gpt-4o", "deny", "openai");
  assert.equal((await checkKeyModelAccess(key.id, "gpt-3.5")).allowed, true);
  assert.equal((await checkKeyModelAccess(key.id, "gpt-4o", "openai")).allowed, false);
  assert.equal((await checkKeyModelAccess(key.id, "gpt-4o", "azure")).allowed, true);

  const full = await getKeyGroupWithPermissions(group.id);
  assert.equal(full!.permissions.length, 2);
  assert.equal(full!.memberCount, 1);

  const updated = await updateKeyGroup(group.id, { isActive: false, name: "team-b" });
  assert.equal(updated!.isActive, false);
  assert.equal(updated!.name, "team-b");
  assert.deepEqual(await filterExistingActiveKeyGroupIds([group.id, "ghost"]), []);
  assert.equal((await getKeyGroupsForApiKey(key.id)).length, 0);
  assert.equal((await getKeyGroupsForApiKey(key.id, true)).length, 1);
  assert.equal(await updateKeyGroup("ghost", { name: "x" }), undefined);

  assert.equal(await removeGroupPermission(deny.id), true);
  assert.equal(await removeGroupPermission(allow.id), true);
  assert.equal(await removeKeyFromGroup(key.id, group.id), true);
  assert.equal(await removeKeyFromGroup(key.id, group.id), false);
  assert.equal(await deleteKeyGroup(group.id), true);
  assert.equal(await deleteKeyGroup(group.id), false);
});

test("auto candidate overrides: upsert toggles one row per key/channel/connection", async () => {
  const key = await createApiKey("ovr", MACHINE);
  const first = await setExcluded(key.id, "auto", "c1", true);
  const toggled = await setExcluded(key.id, "auto", "c1", false);
  assert.equal(toggled.id, first.id, "same row");
  assert.equal(toggled.excluded, false);
  await Promise.all([
    setExcluded(key.id, "auto", "c2", true),
    setExcluded(key.id, "auto", "c2", true),
  ]);
  assert.deepEqual([...(await getExcludedConnectionIds(key.id, "auto"))], ["c2"]);
  assert.equal((await listOverrides(key.id, "auto")).length, 2);
  assert.equal(await deleteOverridesForApiKey(key.id), 2);
});

test("registered keys: issue, idempotency, limits and concurrent counters", async () => {
  const issued = await issueRegisteredKey({
    name: "k1",
    provider: "openai",
    accountId: "acc-1",
    idempotencyKey: "idem-1",
    dailyBudget: 2,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.ok("rawKey" in issued);
  const key = issued as Exclude<typeof issued, { idempotencyConflict: true }>;
  assert.match(key.rawKey, /^ork_/);
  assert.equal(key.provider, "openai");
  assert.equal(key.isActive, true);

  const again = await issueRegisteredKey({ name: "k1b", idempotencyKey: "idem-1" });
  assert.ok("idempotencyConflict" in again);
  assert.equal((again as { existing: { id: string } }).existing.id, key.id);

  const noScope = await issueRegisteredKey({ name: "plain" });
  assert.ok("rawKey" in noScope);
  assert.equal((noScope as { provider: string }).provider, "");

  assert.equal((await getRegisteredKey(key.id))!.name, "k1");
  assert.equal(await getRegisteredKey("not-a-uuid"), null);
  assert.equal((await listRegisteredKeys({ provider: "openai" })).length, 1);
  assert.equal((await listRegisteredKeys()).length, 2);

  // budgets and windows
  assert.ok(await validateRegisteredKey(key.rawKey));
  await incrementRegisteredKeyUsage(key.id);
  await incrementRegisteredKeyUsage(key.id);
  assert.equal(await validateRegisteredKey(key.rawKey), null, "daily budget of 2 is spent");
  await incrementRegisteredKeyUsage("not-a-uuid");

  // issuance counters: two concurrent issues for one provider count both
  await Promise.all([
    issueRegisteredKey({ name: "p1", provider: "anthropic" }),
    issueRegisteredKey({ name: "p2", provider: "anthropic" }),
  ]);
  const limit = await getProviderKeyLimit("anthropic");
  assert.equal(limit!.dailyIssued, 2);
  assert.equal(limit!.hourlyIssued, 2);

  await setProviderKeyLimit("anthropic", { maxActiveKeys: 5, dailyIssueLimit: 2 });
  assert.equal((await checkQuota("anthropic")).errorCode, "PROVIDER_QUOTA_EXCEEDED");
  await setProviderKeyLimit("anthropic", { maxActiveKeys: 2, dailyIssueLimit: 10 });
  const maxed = await checkQuota("anthropic");
  assert.equal(maxed.errorCode, "MAX_ACTIVE_KEYS_EXCEEDED");
  assert.equal(maxed.providerActiveKeys, 2);

  await setAccountKeyLimit("acc-1", { hourlyIssueLimit: 1 });
  assert.equal((await checkQuota("", "acc-1")).errorCode, "ACCOUNT_QUOTA_EXCEEDED");
  assert.equal((await getAccountKeyLimit("acc-1"))!.hourlyIssued, 1);
  assert.equal((await checkQuota("", "other")).allowed, true);
  assert.equal(await getProviderKeyLimit("none"), null);

  assert.equal(await revokeRegisteredKey(key.id), true);
  assert.equal(await revokeRegisteredKey(key.id), false);
  assert.equal(await validateRegisteredKey(key.rawKey), null);
  assert.equal(await revokeRegisteredKey("not-a-uuid"), false);

  // a stale window reads as zero and restarts on the next issue
  await db().execute(
    "UPDATE registered_key_limits SET last_reset_day = '2000-01-01', last_reset_hour = '2000-01-01T00:00:00Z' WHERE scope = 'provider' AND scope_id = 'anthropic'"
  );
  assert.equal((await getProviderKeyLimit("anthropic"))!.dailyIssued, 0);
  await issueRegisteredKey({ name: "p3", provider: "anthropic" });
  assert.equal((await getProviderKeyLimit("anthropic"))!.dailyIssued, 1);
});

test("registered keys: budget window reset bumps updated_at", async () => {
  const issued = (await issueRegisteredKey({ name: "w", dailyBudget: 5 })) as { id: string; rawKey: string };
  await db().execute(
    "UPDATE registered_keys SET last_reset_day = '2000-01-01', updated_at = '2000-01-01T00:00:00Z' WHERE id = $1",
    [issued.id]
  );
  assert.ok(await validateRegisteredKey(issued.rawKey));
  const row = await db().queryOne<{ fresh: boolean }>(
    "SELECT updated_at > '2001-01-01' AS fresh FROM registered_keys WHERE id = $1",
    [issued.id]
  );
  assert.equal(row!.fresh, true);
});

test("api keys: integer limit columns are rounded and negatives cleared", async () => {
  const created = await createApiKey("ints", MACHINE);
  assert.equal(
    await updateApiKeyPermissions(created.id, {
      maxRequestsPerDay: 5.5,
      maxRequestsPerMinute: -1,
      throttleDelayMs: 2.4,
    }),
    true
  );
  const row = await db().queryOne<{ d: number | null; m: number | null; t: number | null }>(
    "SELECT max_requests_per_day AS d, max_requests_per_minute AS m, throttle_delay_ms AS t FROM api_keys WHERE id = $1",
    [created.id]
  );
  assert.deepEqual(row, { d: 6, m: null, t: 2 });
});

test("registered keys: concurrent idempotent issue creates one key", async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) => issueRegisteredKey({ name: `r${i}`, idempotencyKey: "same" }))
  );
  assert.equal(results.filter((r) => "rawKey" in r).length, 1);
  assert.equal(results.filter((r) => "idempotencyConflict" in r).length, 3);
  assert.equal((await listRegisteredKeys()).length, 1);
});

test("sync tokens: env-key stores NULL, revoke and touch", async () => {
  const key = await createApiKey("sync-owner", MACHINE);
  const env = await createSyncTokenRecord({ name: "env", tokenHash: "h-env", syncApiKeyId: "env-key" });
  assert.equal(env.syncApiKeyId, null);
  const linked = await createSyncTokenRecord({
    name: "linked",
    tokenHash: "h-linked",
    syncApiKeyId: key.id,
    issuedBy: "cli",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal((await getSyncTokenById(linked.id))!.issuedBy, "cli");
  assert.equal((await getSyncTokenByHash("h-linked"))!.syncApiKeyId, key.id);
  assert.equal((await listSyncTokens()).length, 2);
  assert.equal(await getSyncTokenById("missing"), null);

  assert.equal(await touchSyncTokenLastUsed(linked.id), true);
  assert.equal(await touchSyncTokenLastUsed("missing"), false);
  assert.ok((await getSyncTokenById(linked.id))!.lastUsedAt);

  const revoked = await revokeSyncToken(linked.id);
  assert.ok(revoked!.revokedAt);
  assert.equal((await revokeSyncToken(linked.id))!.revokedAt, revoked!.revokedAt);
  assert.equal(await revokeSyncToken("missing"), null);

  await assert.rejects(createSyncTokenRecord({ name: "bad", tokenHash: "h-bad", syncApiKeyId: "ghost" }));
});

test("teams: CRUD, billing history and concurrent assignment", async () => {
  const key = await createApiKey("team-key", MACHINE);
  const team = await createTeam({ name: "Core", description: " d ", maxBudgetUsd: 10, budgetDuration: "7d" });
  assert.equal(team.status, "active");
  assert.equal(team.maxBudgetUsd, 10);
  assert.ok(team.budgetResetAt);
  await assert.rejects(createTeam({ name: "core" }), /already exists/);
  await assert.rejects(createTeam({ name: "  " }), /name is required/);

  const renamed = await updateTeam(team.id, { name: "Core 2", maxBudgetUsd: 20, budgetDuration: "7d" });
  assert.equal(renamed!.name, "Core 2");
  assert.equal(renamed!.maxBudgetUsd, 20);
  assert.equal(renamed!.budgetResetAt, team.budgetResetAt, "cadence kept");
  assert.equal(await updateTeam("missing", { name: "x" }), null);

  // budget window advance is compare-and-set
  const past = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await db().execute("UPDATE teams SET budget_reset_at = $1 WHERE id = $2", [past, team.id]);
  const stale = (await getTeam(team.id))!;
  const [adv1, adv2] = await Promise.all([advanceTeamBudgetWindow(stale), advanceTeamBudgetWindow(stale)]);
  assert.equal(adv1.budgetResetAt, adv2.budgetResetAt);
  assert.ok(Date.parse(adv1.budgetResetAt!) > Date.now());

  const other = await createTeam({ name: "Other" });
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const first = await assignApiKeyBillingTeam(key.id, team.id, t0);
  assert.equal(first.validTo, null);
  assert.equal((await assignApiKeyBillingTeam(key.id, team.id)).id, first.id, "same team is a no-op");
  assert.equal((await getActiveBillingTeamForApiKey(key.id))!.id, team.id);
  assert.equal((await listTeamMembers(team.id))[0].apiKeyName, "team-key");
  assert.equal((await listTeamKeyOptions())[0].teamName, "Core 2");

  const second = await assignApiKeyBillingTeam(key.id, other.id, undefined, team.id);
  assert.notEqual(second.id, first.id);
  const history = await listApiKeyBillingHistory(key.id);
  assert.equal(history.length, 2);
  assert.ok(history[0].validTo);
  assert.equal(await resolveBillingTeamIdForApiKeyAt(key.id, new Date(Date.parse(t0) + 1000).toISOString()), team.id);
  assert.equal(await resolveBillingTeamIdForApiKeyAt(key.id, new Date().toISOString()), other.id);

  await assert.rejects(
    assignApiKeyBillingTeam(key.id, team.id, undefined, team.id),
    /changed concurrently/,
    "stale expectedTeamId"
  );

  // two concurrent assignments of one key serialize: exactly one open interval remains
  const racer = await createApiKey("racer", MACHINE);
  const results = await Promise.allSettled([
    assignApiKeyBillingTeam(racer.id, team.id),
    assignApiKeyBillingTeam(racer.id, other.id),
  ]);
  assert.ok(results.some((r) => r.status === "fulfilled"));
  const open = await db().query(
    "SELECT 1 FROM api_key_billing_team_history WHERE api_key_id = $1 AND valid_to IS NULL",
    [racer.id]
  );
  assert.equal(open.length, 1);

  assert.equal(await hasPartialRetainedTeamUsage(team.id, "2026-01-01T00:00:00.000Z", "2026-01-08T00:00:00.000Z"), false);
  assert.equal(await hasPartialRetainedTeamUsage(team.id, "2026-01-01T05:00:00.000Z", "2026-01-08T05:00:00.000Z"), false);

  assert.equal(await unassignApiKeyBillingTeam(key.id, undefined, team.id), false, "wrong expected team");
  assert.equal(await unassignApiKeyBillingTeam(key.id, undefined, other.id), true);
  assert.equal(await getActiveBillingTeamForApiKey(key.id), null);

  await assert.rejects(assignApiKeyBillingTeam("ghost", team.id), /API key not found/);
  await assert.rejects(assignApiKeyBillingTeam(key.id, "ghost"), /Team not found/);

  // archive closes open bindings and blocks new ones
  const archived = await archiveTeam(other.id);
  assert.equal(archived!.status, "archived");
  assert.equal((await listTeamMembers(other.id)).length, 0);
  await assert.rejects(updateTeam(other.id, { name: "z" }), /Archived teams/);
  await assert.rejects(assignApiKeyBillingTeam(key.id, other.id), /archived team/);
  assert.equal((await archiveTeam(other.id))!.status, "archived");
  assert.equal(await archiveTeam("missing"), null);
  assert.equal((await listTeams()).length, 1);
  assert.equal((await listTeams({ includeArchived: true })).length, 2);
});

test("sso identities: provisioning is idempotent under concurrency", async () => {
  const group = await createKeyGroup("sso-group");
  await addGroupPermission(group.id, "*", "allow");
  const input = {
    oid: "oid-1",
    tenantId: "t1",
    upn: "a@x.com",
    displayName: "A",
    keyGroupIds: [group.id],
  };
  const secrets = await Promise.all([provisionSsoIdentity(input), provisionSsoIdentity(input), provisionSsoIdentity(input)]);
  assert.ok(secrets.every((s) => typeof s === "string" && s.length > 0));
  assert.equal(new Set(secrets).size, 1, "everyone sees the winner's key");
  assert.equal(await getApiKeysCount(), 1, "losers deleted their shadow keys");

  const identity = await getSsoIdentity("oid-1");
  assert.deepEqual(identity!.lastGroups, [group.id]);
  assert.ok(identity!.lastSeenAt);
  assert.equal(await getSsoShadowSecret("oid-1"), secrets[0]);

  const key = (await getApiKeyById(identity!.apiKeyId))!;
  assert.equal((key as { source?: string }).source, "sso");
  assert.equal(key.key, "", "shadow secret is redacted from key views");

  // a key group that does not exist leaves the key in no group: deactivated, no secret
  const none = await provisionSsoIdentity({ ...input, oid: "oid-2", keyGroupIds: ["ghost"] });
  assert.equal(none, null);
  assert.equal(await getSsoShadowSecret("oid-2"), null);

  // dropping a group on a later login reconciles membership
  const empty = await provisionSsoIdentity({ ...input, keyGroupIds: [] });
  assert.equal(empty, null);

  // deleting the key cascades the identity
  await deleteApiKey(identity!.apiKeyId);
  assert.equal(await getSsoIdentity("oid-1"), null);
});

test("combo grant revocation strips a deleted combo's name", async () => {
  const a = await createApiKey("a", MACHINE, [], { allowedCombos: ["combo/fast", "slow", "combo/*"] });
  const b = await createApiKey("b", MACHINE, [], { allowedCombos: ["other"] });
  const changed = await db().transaction((tx) => revokeComboGrantsByName(tx, "FAST"));
  assert.deepEqual(changed, [a.id]);
  const row = await db().queryOne<{ allowed_combos: string[] }>(
    "SELECT allowed_combos FROM api_keys WHERE id = $1",
    [a.id]
  );
  assert.deepEqual(row!.allowed_combos, ["slow", "combo/*"]);
  assert.equal((await db().queryOne("SELECT 1 FROM api_keys WHERE id = $1", [b.id])) !== undefined, true);

  // a combo that still exists (any case) keeps its grants
  await db().execute(
    "INSERT INTO combos (id, name, data) VALUES ('c1', 'Slow', '{}'::jsonb)"
  );
  assert.deepEqual(await db().transaction((tx) => revokeComboGrantsByName(tx, "slow")), []);
});

test("secretAtRest backfill is a no-op without an encryption key", async () => {
  await createApiKey("plain", MACHINE);
  assert.equal(await backfillApiKeySecretsAtRest(), 0);
});
