import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";
import { comboRepository } from "../../../../src/lib/db/repositories/comboRepository.ts";
import { modelComboMappingRepository } from "../../../../src/lib/db/repositories/modelComboMappingRepository.ts";
import { routingConfigRepositories } from "../../../../src/lib/db/repositories/routingConfigRepositories.ts";
import {
  getCombos,
  getCombosCount,
  setActiveCombo,
} from "../../../../src/lib/db/combos.ts";
import {
  createReasoningRoutingRule,
  deleteReasoningRoutingRule,
  getReasoningRoutingRuleById,
  getReasoningRoutingRuleReferenceErrors,
  getReasoningRoutingRules,
  updateReasoningRoutingRule,
} from "../../../../src/lib/db/reasoningRoutingRules.ts";
import {
  assignRoutingCombo,
  createCompressionCombo,
  deleteCompressionCombo,
  getAssignmentsForCompressionCombo,
  getCompressionComboForRoutingCombo,
  getDefaultCompressionCombo,
  listCompressionCombos,
  setDefaultCompressionCombo,
  setEngineInDefaultCombo,
  updateAssignments,
  updateCompressionCombo,
} from "../../../../src/lib/db/compressionCombos.ts";
import {
  deleteCloudAgentCredential,
  getCloudAgentCredentialFromDb,
  listCloudAgentCredentials,
  saveCloudAgentCredential,
} from "../../../../src/lib/cloudAgent/credentials.ts";
import {
  deleteCloudAgentTask,
  getAllCloudAgentTasks,
  getCloudAgentTaskById,
  getCloudAgentTasksByProvider,
  getCloudAgentTasksByStatus,
  insertCloudAgentTask,
  updateCloudAgentTask,
} from "../../../../src/lib/cloudAgent/db.ts";
import {
  advanceLogExportCursor,
  createLogExportDestination,
  deleteLogExportDestination,
  getEnabledLogExportDestinations,
  getLogExportDestination,
  getLogExportDestinations,
  recordLogExportRun,
  resetLogExportCursor,
  updateLogExportDestination,
} from "../../../../src/lib/db/logExportDestinations.ts";
import {
  createMiddlewareHook,
  deleteMiddlewareHook,
  getAllMiddlewareHooks,
  getEnabledMiddlewareHooks,
  getMiddlewareHook,
  recordHookExecution,
  updateMiddlewareHook,
} from "../../../../src/lib/db/middleware.ts";
import {
  cleanupOrphanedRuns,
  getAllJobs,
  getJob,
  getRuns,
  pruneRuns,
  recordRun,
  updateJobEnabled,
  upsertJob,
} from "../../../../src/lib/db/jobRegistryDb.ts";
import {
  createWebhook,
  deleteWebhook,
  disableWebhooksWithHighFailures,
  getEnabledWebhooks,
  getWebhook,
  getWebhooks,
  recordWebhookDelivery,
  updateWebhook,
} from "../../../../src/lib/db/webhooks.ts";
import {
  deleteVersionManagerTool,
  getVersionManagerStatus,
  getVersionManagerTool,
  setToolStatus,
  updateServiceField,
  updateToolHealth,
  updateToolVersion,
  updateVersionManagerTool,
  upsertVersionManagerTool,
} from "../../../../src/lib/db/versionManager.ts";
import {
  initTierConfigTable,
  loadTierConfig,
  loadTierConfigFromDb,
  saveTierConfig,
} from "../../../../src/lib/db/tierConfig.ts";
import { DEFAULT_TIER_CONFIG } from "../../../../open-sse/services/tierConfig.ts";
import { db } from "../../../../src/lib/db/pg.ts";

beforeEach(async () => {
  await truncateAll(getTestBackend());
});

const newCombo = (name: string, extra: Record<string, unknown> = {}) =>
  comboRepository.create({ name, models: [], ...extra });

// ── combos ───────────────────────────────────────────────────────────────

test("combos: create, read, case-insensitive name, update, count, delete", async () => {
  const created = await newCombo("Alpha", { description: "first" });
  assert.equal(typeof created.id, "string");
  assert.equal(created.sortOrder, 1);

  const byId = await comboRepository.findById(created.id as string);
  assert.equal(byId?.name, "Alpha");
  assert.equal((await comboRepository.findByName("alpha"))?.id, created.id);
  assert.equal((await comboRepository.findByName("ALPHA"))?.id, created.id);
  assert.equal(await comboRepository.findByName("missing"), null);

  // unique on lower(name)
  await assert.rejects(newCombo("ALPHA"));

  const updated = await comboRepository.update(created.id as string, {
    description: "second",
    context_cache_protection: true,
  });
  assert.equal(updated?.previousName, "Alpha");
  assert.equal(updated?.modelsFieldProvided, false);
  assert.equal(updated?.combo.description, "second");
  const row = await db().queryOne<{ context_cache_protection: boolean }>(
    "SELECT context_cache_protection FROM combos WHERE id = $1",
    [created.id]
  );
  assert.equal(row?.context_cache_protection, true);
  assert.equal((await comboRepository.findById(created.id as string))?.context_cache_protection, true);

  assert.equal(await comboRepository.update("nope", { description: "x" }), null);
  assert.equal(await getCombosCount(), 1);
  assert.equal((await getCombos()).length, 1);
  assert.equal(routingConfigRepositories.combos, comboRepository);

  assert.equal(await comboRepository.deleteById(created.id as string), true);
  assert.equal(await comboRepository.deleteById(created.id as string), false);
  assert.equal(await getCombosCount(), 0);
});

test("combos: concurrent updates of different fields are both kept (row lock)", async () => {
  const created = await newCombo("Race");
  const id = created.id as string;
  await Promise.all([
    comboRepository.update(id, { fieldA: "a" }),
    comboRepository.update(id, { fieldB: "b" }),
    comboRepository.update(id, { fieldC: "c" }),
  ]);
  const combo = await comboRepository.findById(id);
  assert.equal(combo?.fieldA, "a");
  assert.equal(combo?.fieldB, "b");
  assert.equal(combo?.fieldC, "c");
});

test("combos: reorder and pagination", async () => {
  const a = await newCombo("A");
  const b = await newCombo("B");
  const c = await newCombo("C");
  const result = await comboRepository.reorder([c.id as string, "unknown", a.id as string]);
  assert.equal(result.rowsReordered, 3);
  assert.deepEqual(
    result.combos.map((combo) => combo.id),
    [c.id, a.id, b.id]
  );
  const page = await comboRepository.list(1, 1);
  assert.equal(page.length, 1);
  assert.equal(page[0].id, a.id);
  assert.equal((await comboRepository.reorder([])).rowsReordered, 3);
});

test("combos: delete cascades mappings, assignments, proxy scope rows", async () => {
  const combo = await newCombo("Doomed");
  const id = combo.id as string;
  await modelComboMappingRepository.create({ pattern: "gpt-*", comboId: id });
  const cc = await createCompressionCombo({ name: "cc" });
  await assignRoutingCombo(cc.id, id);
  await assignRoutingCombo(cc.id, "Doomed");
  await db().execute(
    `INSERT INTO proxy_registry (id, name, type, host, port) VALUES ('px1', 'px', 'http', 'h', 8080)`
  );
  await db().execute(
    `INSERT INTO proxy_assignments (proxy_id, scope, scope_id) VALUES ('px1', 'combo', $1)`,
    [id]
  );

  assert.equal(await comboRepository.deleteById(id), true);
  assert.equal((await modelComboMappingRepository.list()).total, 0);
  assert.deepEqual(await getAssignmentsForCompressionCombo(cc.id), []);
  const left = await db().queryOne<{ n: number }>(
    "SELECT count(*) AS n FROM proxy_assignments WHERE scope = 'combo'"
  );
  assert.equal(left?.n, 0);
});

test("setActiveCombo writes the settings entry", async () => {
  await setActiveCombo("Alpha");
  await setActiveCombo("Beta");
  const row = await db().queryOne<{ value: unknown }>(
    "SELECT value FROM config_entries WHERE namespace = 'settings' AND key = 'activeCombo'"
  );
  assert.equal(row?.value, "Beta");
});

// ── model_combo_mappings ─────────────────────────────────────────────────

test("model combo mappings: CRUD, ordering and resolution", async () => {
  const combo = await newCombo("Mapped");
  const other = await newCombo("Other");
  const low = await modelComboMappingRepository.create({
    pattern: "claude-*",
    comboId: combo.id as string,
    priority: 1,
  });
  const high = await modelComboMappingRepository.create({
    pattern: "claude-*-opus*",
    comboId: other.id as string,
    priority: 10,
    description: "opus",
  });
  assert.equal(low.enabled, true);

  const page = await modelComboMappingRepository.list({ limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items[0].id, high.id);
  assert.equal(page.items[0].comboName, "Other");

  const resolved = await modelComboMappingRepository.resolveForModel("claude-3-opus-latest");
  assert.equal(resolved?.name, "Other");
  assert.equal((await modelComboMappingRepository.resolveForModel("claude-sonnet"))?.name, "Mapped");
  assert.equal(await modelComboMappingRepository.resolveForModel("gpt-4"), null);

  const disabled = await modelComboMappingRepository.update(high.id, { enabled: false });
  assert.equal(disabled?.enabled, false);
  assert.equal(
    (await modelComboMappingRepository.resolveForModel("claude-3-opus-latest"))?.name,
    "Mapped"
  );
  assert.equal(await modelComboMappingRepository.update("nope", { priority: 1 }), null);

  await assert.rejects(
    modelComboMappingRepository.create({ pattern: "x", comboId: "missing-combo" })
  );

  assert.equal(await modelComboMappingRepository.deleteById(low.id), true);
  assert.equal(await modelComboMappingRepository.deleteById(low.id), false);
  assert.equal((await modelComboMappingRepository.findById(high.id))?.pattern, "claude-*-opus*");
});

// ── reasoning_routing_rules ──────────────────────────────────────────────

const baseRule = {
  name: "rule",
  description: "",
  scope: "global" as const,
  apiKeyId: null,
  comboId: null,
  connectionId: null,
  modelPattern: null,
  sourceEffort: "any" as const,
  requestTags: ["Fast", "fast", " Slow "],
  tagMatchMode: "any" as const,
  effortMode: "force" as const,
  targetEffort: "high" as const,
  targetKind: "keep" as const,
  targetModel: null,
  targetComboId: null,
  budgetAction: "set" as const,
  budgetTokens: 2048,
  priority: 5,
  enabled: true,
};

test("reasoning routing rules: CRUD, cache invalidation, reference errors", async () => {
  const created = await createReasoningRoutingRule(baseRule);
  assert.deepEqual(created.requestTags, ["fast", "slow"]);
  assert.equal(created.enabled, true);
  assert.equal(created.budgetTokens, 2048);
  assert.equal(typeof created.createdAt, "string");

  assert.equal((await getReasoningRoutingRules()).length, 1);
  const updated = await updateReasoningRoutingRule(created.id, { enabled: false, priority: 9 });
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.priority, 9);
  assert.equal((await getReasoningRoutingRules({ enabledOnly: true })).length, 0);
  assert.equal((await getReasoningRoutingRules()).length, 1);
  assert.equal((await getReasoningRoutingRuleById(created.id))?.name, "rule");
  assert.equal(await updateReasoningRoutingRule("nope", { priority: 1 }), null);

  const comboRule = { ...baseRule, scope: "combo" as const, comboId: "missing" };
  assert.deepEqual(await getReasoningRoutingRuleReferenceErrors(comboRule), [
    "The referenced source combo does not exist",
  ]);
  await assert.rejects(createReasoningRoutingRule(comboRule));
  const combo = await newCombo("RuleCombo");
  const ok = await createReasoningRoutingRule({ ...comboRule, comboId: combo.id as string });
  assert.equal(ok.comboId, combo.id);

  // FK cascade on combo delete
  await comboRepository.deleteById(combo.id as string);
  assert.equal(await getReasoningRoutingRuleById(ok.id), null);

  assert.equal(await deleteReasoningRoutingRule(created.id), true);
  assert.equal(await deleteReasoningRoutingRule(created.id), false);
});

// ── compression combos ───────────────────────────────────────────────────

test("compression combos: seed, default switch, assignments, engine edit, delete", async () => {
  const seeded = await getDefaultCompressionCombo();
  assert.equal(seeded?.id, "default-caveman");
  assert.equal(seeded?.isDefault, true);
  assert.deepEqual(seeded?.pipeline, [{ engine: "session-dedup" }, { engine: "lite" }]);

  const made = await createCompressionCombo({
    name: "Mine",
    pipeline: [{ engine: "caveman" }],
    outputMode: true,
    isDefault: true,
  });
  assert.equal(made.outputMode, true);
  assert.deepEqual(made.languagePacks, ["en"]);
  assert.equal((await getDefaultCompressionCombo())?.id, made.id);
  const defaults = await db().queryOne<{ n: number }>(
    "SELECT count(*) AS n FROM compression_combos WHERE is_default"
  );
  assert.equal(defaults?.n, 1);

  const renamed = await updateCompressionCombo(made.id, { name: "Renamed", isDefault: false });
  assert.equal(renamed?.name, "Renamed");
  assert.equal(renamed?.isDefault, false);
  assert.equal(await setDefaultCompressionCombo("nope"), false);
  assert.equal(await setDefaultCompressionCombo(made.id), true);
  assert.equal((await getDefaultCompressionCombo())?.id, made.id);

  const other = await createCompressionCombo({ name: "Other" });
  assert.equal(await assignRoutingCombo(other.id, "route-1"), true);
  assert.equal(await assignRoutingCombo("nope", "route-1"), false);
  assert.equal((await getCompressionComboForRoutingCombo("route-1"))?.id, other.id);
  // moving the routing combo to another compression combo replaces the assignment
  await assignRoutingCombo(made.id, "route-1");
  assert.equal((await getCompressionComboForRoutingCombo("route-1"))?.id, made.id);
  assert.equal(await updateAssignments(other.id, ["route-1", "route-2", " ", "route-2"]), true);
  assert.deepEqual(
    (await getAssignmentsForCompressionCombo(other.id)).map((a) => a.routingComboId),
    ["route-1", "route-2"]
  );
  assert.deepEqual(await getAssignmentsForCompressionCombo(made.id), []);
  assert.equal(await updateAssignments("nope", []), false);

  assert.equal(await deleteCompressionCombo(made.id), false); // default
  assert.equal(await deleteCompressionCombo(other.id), true);
  assert.deepEqual(await getAssignmentsForCompressionCombo(other.id), []);
  assert.ok((await listCompressionCombos()).length >= 2);
});

test("compression combos: concurrent engine toggles on the default combo both apply", async () => {
  await getDefaultCompressionCombo();
  await Promise.all([
    setEngineInDefaultCombo("rtk", true),
    setEngineInDefaultCombo("headroom", true),
    setEngineInDefaultCombo("ccr", true),
  ]);
  const engines = (await getDefaultCompressionCombo())?.pipeline.map((step) => step.engine);
  assert.ok(engines?.includes("rtk"));
  assert.ok(engines?.includes("headroom"));
  assert.ok(engines?.includes("ccr"));
  assert.equal(await setEngineInDefaultCombo("unknown-engine", true), null);
  const without = await setEngineInDefaultCombo("rtk", false);
  assert.ok(!without?.pipeline.some((step) => step.engine === "rtk"));
});

// ── cloud agent ──────────────────────────────────────────────────────────

test("cloud agent credentials: save, upsert, list masked, read, delete", async () => {
  await saveCloudAgentCredential("jules", "key-1234567890", "https://example.test");
  await saveCloudAgentCredential("jules", "key-abcdefghij");
  assert.deepEqual(await getCloudAgentCredentialFromDb("jules"), { apiKey: "key-abcdefghij" });
  assert.equal(await getCloudAgentCredentialFromDb("devin"), null);
  const list = await listCloudAgentCredentials();
  assert.equal(list.length, 1);
  assert.equal(list[0].apiKey, "****ghij");
  assert.equal(list[0].baseUrl, null);
  await deleteCloudAgentCredential("jules");
  assert.deepEqual(await listCloudAgentCredentials(), []);
});

test("cloud agent tasks: insert, update, query, delete (JSON stays text)", async () => {
  const now = new Date().toISOString();
  const row = {
    id: "task_1",
    provider_id: "jules",
    external_id: null,
    status: "queued",
    prompt: "do it \u0000 now",
    source: JSON.stringify({ repoName: "r", repoUrl: "u" }),
    options: "{}",
    result: null,
    activities: "[]",
    error: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  await insertCloudAgentTask(row);
  const fetched = await getCloudAgentTaskById("task_1");
  assert.equal(fetched?.prompt, "do it  now");
  assert.deepEqual(JSON.parse(fetched!.source), { repoName: "r", repoUrl: "u" });
  assert.equal(fetched?.result, null);
  assert.equal(fetched?.created_at, now);

  await updateCloudAgentTask("task_1", {
    status: "completed",
    result: JSON.stringify({ ok: true, note: "a\\u0000b" }),
    activities: JSON.stringify([{ n: 1 }]),
    completed_at: now,
    id: "ignored",
  } as never);
  const done = await getCloudAgentTaskById("task_1");
  assert.equal(done?.status, "completed");
  assert.deepEqual(JSON.parse(done!.activities), [{ n: 1 }]);
  assert.equal(JSON.parse(done!.result!).ok, true);
  assert.equal(done?.completed_at, now);

  await updateCloudAgentTask("task_1", { bogus: "x" } as never); // no valid columns: no-op
  await updateCloudAgentTask("missing", { status: "failed" });

  await insertCloudAgentTask({ ...row, id: "task_2", provider_id: "devin" });
  assert.equal((await getCloudAgentTasksByProvider("jules")).length, 1);
  assert.equal((await getCloudAgentTasksByStatus("queued")).length, 1);
  assert.equal((await getAllCloudAgentTasks(10)).length, 2);
  await deleteCloudAgentTask("task_1");
  assert.equal(await getCloudAgentTaskById("task_1"), null);
});

// ── log export destinations ──────────────────────────────────────────────

test("log export destinations: CRUD, cursor, run record", async () => {
  const created = await createLogExportDestination({
    name: "dest",
    type: "webhook",
    config: { url: "https://x.test" },
  });
  assert.equal(created.enabled, false);
  assert.equal(created.batchSize, 500);
  assert.equal(created.cursorRowId, 0);
  assert.deepEqual(created.config, { url: "https://x.test" });

  assert.equal((await getEnabledLogExportDestinations()).length, 0);
  const updated = await updateLogExportDestination(created.id, { enabled: true, batchSize: 10 });
  assert.equal(updated?.enabled, true);
  assert.equal(updated?.batchSize, 10);
  assert.deepEqual(updated?.config, { url: "https://x.test" });
  assert.equal((await getEnabledLogExportDestinations()).length, 1);
  assert.equal(await updateLogExportDestination("nope", { name: "x" }), null);

  await Promise.all([
    advanceLogExportCursor(created.id, 10, 3),
    advanceLogExportCursor(created.id, 10, 4),
    advanceLogExportCursor(created.id, 10, 5),
  ]);
  const advanced = await getLogExportDestination(created.id);
  assert.equal(advanced?.cursorRowId, 10);
  assert.equal(advanced?.exportedTotal, 12);

  await resetLogExportCursor(created.id);
  assert.equal((await getLogExportDestination(created.id))?.cursorRowId, 0);
  await recordLogExportRun(created.id, "failure", "boom");
  const failed = await getLogExportDestination(created.id);
  assert.equal(failed?.lastStatus, "failure");
  assert.equal(failed?.lastError, "boom");
  assert.equal(typeof failed?.lastRunAt, "string");

  assert.equal((await getLogExportDestinations()).length, 1);
  assert.equal(await deleteLogExportDestination(created.id), true);
  assert.equal(await deleteLogExportDestination(created.id), false);
});

// ── middleware hooks ─────────────────────────────────────────────────────

test("middleware hooks: CRUD and atomic run counter", async () => {
  const hook = {
    name: "h1",
    description: "d",
    priority: 100,
    scope: { type: "global" as const },
    enabled: true,
    code: "return 1",
    createdAt: "",
    updatedAt: "",
    runCount: 0,
  };
  const created = await createMiddlewareHook(hook as never);
  assert.equal(created.name, "h1");
  assert.deepEqual(created.scope, { type: "global" });
  assert.equal(created.runCount, 0);
  assert.equal(created.lastError, undefined);

  await createMiddlewareHook({
    ...hook,
    name: "h2",
    priority: 50,
    scope: { type: "combo", comboId: "c1" },
    enabled: false,
  } as never);
  assert.deepEqual((await getAllMiddlewareHooks()).map((h) => h.name), ["h2", "h1"]);
  assert.deepEqual((await getEnabledMiddlewareHooks()).map((h) => h.name), ["h1"]);
  assert.deepEqual((await getMiddlewareHook("h2"))?.scope, { type: "combo", comboId: "c1" });

  const updated = await updateMiddlewareHook("h1", { enabled: false, code: "return 2" });
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.code, "return 2");
  assert.equal(await updateMiddlewareHook("nope", {}), undefined);

  await Promise.all(Array.from({ length: 8 }, () => recordHookExecution("h1")));
  await recordHookExecution("h1", "kaput");
  const counted = await getMiddlewareHook("h1");
  assert.equal(counted?.runCount, 9);
  assert.equal(counted?.lastError, "kaput");
  await recordHookExecution("h1");
  assert.equal((await getMiddlewareHook("h1"))?.lastError, undefined);

  assert.equal(await deleteMiddlewareHook("h1"), true);
  assert.equal(await deleteMiddlewareHook("h1"), false);
  assert.equal(await getMiddlewareHook("h1"), undefined);
});

// ── jobs ─────────────────────────────────────────────────────────────────

test("jobs: upsert keeps enabled, runs, prune, orphan cleanup, concurrent upserts", async () => {
  const job = {
    id: "job-a",
    type: "interval" as const,
    cron: null,
    intervalMs: 60_000,
    enabled: true,
    envFlag: null,
    config: { a: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "",
  };
  await Promise.all([upsertJob(job), upsertJob(job), upsertJob(job)]);
  assert.equal((await getAllJobs()).length, 1);
  const stored = await getJob("job-a");
  assert.equal(stored?.enabled, true);
  assert.deepEqual(stored?.config, { a: 1 });
  assert.equal(stored?.createdAt, "2026-01-01T00:00:00.000Z");

  await updateJobEnabled("job-a", false);
  await upsertJob({ ...job, type: "cron", cron: "* * * * *", intervalMs: null, config: { b: 2 } });
  const after = await getJob("job-a");
  assert.equal(after?.enabled, false); // the toggle survives re-registration
  assert.equal(after?.type, "cron");
  assert.deepEqual(after?.config, { b: 2 });
  assert.equal(after?.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(await getJob("missing"), null);

  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  for (let i = 0; i < 5; i++) {
    await recordRun("job-a", "success", {
      startedAt: new Date(Date.parse(old) + i * 1000).toISOString(),
      durationMs: 250,
      recordsAffected: 2.4,
    });
  }
  await recordRun("job-a", "failure", { errorMessage: "bad" });
  const runs = await getRuns("job-a", 20);
  assert.equal(runs.length, 6);
  assert.equal(runs[0].status, "failure");
  assert.equal(runs[0].errorMessage, "bad");
  assert.equal(runs[5].durationMs, 250);
  assert.equal(runs[5].recordsAffected, 2);
  assert.equal(
    Date.parse(runs[5].finishedAt!) - Date.parse(runs[5].startedAt),
    250
  );

  await pruneRuns("job-a", 3, 30);
  assert.equal((await getRuns("job-a", 20)).length, 3);

  await db().execute(
    "INSERT INTO job_runs (job_id, started_at, status) VALUES ('job-a', now() - interval '1 hour', 'running')"
  );
  await recordRun("job-a", "running");
  await cleanupOrphanedRuns(5);
  const statuses = (await getRuns("job-a", 20)).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === "running").length, 1); // the fresh one survives
  assert.ok(statuses.includes("failure"));
});

// ── webhooks ─────────────────────────────────────────────────────────────

test("webhooks: CRUD, delivery counters under concurrency, auto-disable", async () => {
  const hook = await createWebhook({ url: "https://h.test", description: "d", kind: "slack" });
  assert.match(hook.secret ?? "", /^whsec_/);
  assert.deepEqual(hook.events, ["*"]);
  assert.equal(hook.enabled, true);
  assert.equal(hook.kind, "slack");

  const mine = await createWebhook({
    url: "https://m.test",
    events: ["a", "b"],
    secret: "s3cret",
    metadataEncrypted: "enc:v1:abc",
  });
  assert.equal(mine.secret, "s3cret");
  assert.deepEqual((await getWebhook(mine.id))?.events, ["a", "b"]);
  assert.equal((await getWebhook(mine.id))?.metadata_encrypted, "enc:v1:abc");

  const updated = await updateWebhook(mine.id, {
    events: ["c"],
    enabled: false,
    secret: "new-secret",
    metadataEncrypted: null,
  });
  assert.deepEqual(updated?.events, ["c"]);
  assert.equal(updated?.enabled, false);
  assert.equal(updated?.secret, "new-secret");
  assert.equal(updated?.metadata_encrypted, null);
  assert.equal((await updateWebhook(mine.id, {}))?.id, mine.id);
  assert.equal(await updateWebhook("nope", { url: "x" }), null);

  assert.deepEqual((await getEnabledWebhooks()).map((w) => w.id), [hook.id]);
  const page = await getWebhooks({ limit: 1, offset: 0 });
  assert.equal(page.total, 2);
  assert.equal(page.webhooks.length, 1);

  await Promise.all(Array.from({ length: 10 }, () => recordWebhookDelivery(hook.id, 500, false)));
  const failing = await getWebhook(hook.id);
  assert.equal(failing?.failure_count, 10);
  assert.equal(failing?.last_status, 500);
  assert.equal(typeof failing?.last_triggered_at, "string");
  assert.equal(await disableWebhooksWithHighFailures(10), 1);
  assert.equal((await getWebhook(hook.id))?.enabled, false);
  await recordWebhookDelivery(hook.id, 200, true);
  assert.equal((await getWebhook(hook.id))?.failure_count, 0);

  assert.equal(await deleteWebhook(hook.id), true);
  assert.equal(await deleteWebhook(hook.id), false);
});

// ── version manager ──────────────────────────────────────────────────────

test("version manager: upsert, partial updates, helpers, delete", async () => {
  const created = await upsertVersionManagerTool({
    tool: "cliproxyapi",
    currentVersion: "1.0.0",
    apiKey: "sk-secret",
    configOverrides: { a: 1 },
  });
  assert.equal(created.tool, "cliproxyapi");
  assert.equal(created.status, "not_installed");
  assert.equal(created.port, 8317);
  assert.equal(created.apiKey, "sk-secret");
  assert.equal(created.autoUpdate, true);
  assert.equal(created.autoStart, false);
  assert.deepEqual(created.configOverrides, { a: 1 });

  const again = await upsertVersionManagerTool({ tool: "cliproxyapi", currentVersion: "1.1.0" });
  assert.equal(again.currentVersion, "1.1.0");
  assert.equal(again.apiKey, null);
  assert.equal(again.createdAt, created.createdAt);

  const updated = await updateVersionManagerTool("cliproxyapi", {
    status: "running",
    pid: 4321,
    autoStart: true,
    providerExpose: true,
    managementKey: "mk",
    configOverrides: { b: 2 },
    lastSyncAt: "2026-11-16T10:00:00.000Z",
    ignored: "x",
    pinnedVersion: null,
  });
  assert.equal(updated?.status, "running");
  assert.equal(updated?.pid, 4321);
  assert.equal(updated?.autoStart, true);
  assert.equal(updated?.providerExpose, true);
  assert.equal(updated?.managementKey, "mk");
  assert.deepEqual(updated?.configOverrides, { b: 2 });
  assert.equal(updated?.lastSyncAt, "2026-11-16T10:00:00.000Z");
  assert.equal(await updateVersionManagerTool("nope", { status: "running" }), null);

  assert.equal(await updateToolHealth("cliproxyapi", "healthy"), true);
  assert.equal(await updateToolVersion("cliproxyapi", "installed_version", "2.0.0"), true);
  assert.equal(await setToolStatus("cliproxyapi", "error", 9, "failed"), true);
  assert.equal(await setToolStatus("cliproxyapi", "stopped"), true);
  const tool = await getVersionManagerTool("cliproxyapi");
  assert.equal(tool?.healthStatus, "healthy");
  assert.equal(typeof tool?.lastHealthCheck, "string");
  assert.equal(tool?.installedVersion, "2.0.0");
  assert.equal(tool?.status, "stopped");
  assert.equal(tool?.errorMessage, null);
  assert.equal((await updateServiceField("cliproxyapi", "port", 9000))?.port, 9000);
  await assert.rejects(updateServiceField("cliproxyapi", "tool", "x"));

  assert.equal((await getVersionManagerStatus()).length, 1);
  assert.equal(await deleteVersionManagerTool("cliproxyapi"), true);
  assert.equal(await deleteVersionManagerTool("cliproxyapi"), false);
  assert.equal(await getVersionManagerTool("cliproxyapi"), null);
});

test("version manager: supervisor transient states and odd values respect the CHECKs", async () => {
  await upsertVersionManagerTool({ tool: "svc", status: "starting", healthStatus: "weird" });
  assert.equal((await getVersionManagerTool("svc"))?.status, "running");
  assert.equal((await getVersionManagerTool("svc"))?.healthStatus, "unknown");
  assert.equal(await setToolStatus("svc", "starting", 123), true);
  assert.equal((await getVersionManagerTool("svc"))?.status, "running");
  assert.equal(await setToolStatus("svc", "stopping"), true);
  assert.equal((await getVersionManagerTool("svc"))?.status, "stopped");
  assert.equal((await updateServiceField("svc", "status", "bogus"))?.status, "error");
  assert.equal((await updateVersionManagerTool("svc", { healthStatus: "bad" }))?.healthStatus, "unknown");
  assert.equal(await updateToolHealth("svc", "bad"), true);
});

test("cloud agent tasks: literal backslash-u0000 text survives; NUL in error is stripped", async () => {
  const now = new Date().toISOString();
  const literal = "see \\u0000 here\\";
  await insertCloudAgentTask({
    id: "t_lit",
    provider_id: "jules",
    external_id: null,
    status: "queued",
    prompt: `p ${literal} \u0000`,
    source: "{}",
    options: "{}",
    result: null,
    activities: JSON.stringify([{ text: literal }]),
    error: "bad \u0000 thing",
    created_at: now,
    updated_at: now,
    completed_at: null,
  });
  const row = await getCloudAgentTaskById("t_lit");
  assert.equal(row?.prompt, `p ${literal} `);
  assert.equal(row?.error, "bad  thing");
  assert.deepEqual(JSON.parse(row!.activities), [{ text: literal }]);
  await updateCloudAgentTask("t_lit", {
    result: JSON.stringify({ text: literal }),
    error: "e \u0000",
  });
  const after = await getCloudAgentTaskById("t_lit");
  assert.deepEqual(JSON.parse(after!.result!), { text: literal });
  assert.equal(after?.error, "e ");
});

test("compression combos: default reappears after the table is emptied under the process", async () => {
  assert.ok((await listCompressionCombos()).some((c) => c.id === "default-caveman"));
  await db().execute("DELETE FROM compression_combos");
  const list = await listCompressionCombos();
  assert.ok(list.some((c) => c.id === "default-caveman"));
  await db().execute("DELETE FROM compression_combos");
  assert.ok(await getDefaultCompressionCombo());
});

test("middleware hooks: update does not clobber a concurrent run counter", async () => {
  await createMiddlewareHook({
    name: "race",
    description: "",
    priority: 1,
    scope: { type: "global" },
    enabled: true,
    code: "",
    createdAt: "",
    updatedAt: "",
    runCount: 0,
  } as never);
  await Promise.all([
    ...Array.from({ length: 10 }, () => recordHookExecution("race")),
    ...Array.from({ length: 10 }, (_, i) => updateMiddlewareHook("race", { priority: i + 2 })),
  ]);
  assert.equal((await getMiddlewareHook("race"))?.runCount, 10);
  const set = await updateMiddlewareHook("race", { runCount: 0, lastError: "x" });
  assert.equal(set?.runCount, 0);
  assert.equal(set?.lastError, "x");
});

test("combos: delete removes the combo's LKGP pins in the same transaction", async () => {
  const combo = await newCombo("Pin_%");
  const other = await newCombo("PinXY");
  await db().execute(
    "INSERT INTO lkgp_pins (pin_key, provider) VALUES ('Pin_%:m1', 'p'), ('PinXY:m1', 'p')"
  );
  assert.equal(await comboRepository.deleteById(combo.id as string), true);
  const keys = (await db().query<{ pin_key: string }>("SELECT pin_key FROM lkgp_pins")).map(
    (r) => r.pin_key
  );
  assert.deepEqual(keys, ["PinXY:m1"]);
  assert.ok(other);
});

// ── tier config ──────────────────────────────────────────────────────────

test("tier config: save, load, overwrite, corrupt value falls back", async () => {
  initTierConfigTable();
  assert.equal(await loadTierConfigFromDb(), null);
  assert.deepEqual(await loadTierConfig(), DEFAULT_TIER_CONFIG);

  await saveTierConfig(DEFAULT_TIER_CONFIG);
  await saveTierConfig(DEFAULT_TIER_CONFIG);
  assert.deepEqual(await loadTierConfigFromDb(), DEFAULT_TIER_CONFIG);
  const count = await db().queryOne<{ n: number }>(
    "SELECT count(*) AS n FROM config_entries WHERE namespace = 'tier'"
  );
  assert.equal(count?.n, 1);

  await db().execute(
    `UPDATE config_entries SET value = '{"bogus": true}'::jsonb WHERE namespace = 'tier'`
  );
  assert.equal(await loadTierConfigFromDb(), null);
  assert.deepEqual(await loadTierConfig(), DEFAULT_TIER_CONFIG);
});
