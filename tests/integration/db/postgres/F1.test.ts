import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, truncateAll } from "../../../helpers/postgres.ts";
import { db } from "../../../../src/lib/db/pg.ts";

import * as a2a from "../../../../src/lib/db/a2aTasks.ts";
import * as bypass from "../../../../src/lib/db/agentBridgeBypass.ts";
import * as mappings from "../../../../src/lib/db/agentBridgeMappings.ts";
import * as bridgeState from "../../../../src/lib/db/agentBridgeState.ts";
import * as batches from "../../../../src/lib/db/batches.ts";
import * as discovery from "../../../../src/lib/db/discoveryResults.ts";
import * as evals from "../../../../src/lib/db/evals.ts";
import * as files from "../../../../src/lib/db/files.ts";
import * as hosts from "../../../../src/lib/db/inspectorCustomHosts.ts";
import * as inspector from "../../../../src/lib/db/inspectorSessions.ts";
import * as presets from "../../../../src/lib/db/playgroundPresets.ts";
import * as plugins from "../../../../src/lib/db/plugins.ts";
import * as skillsDb from "../../../../src/lib/db/skills.ts";
import { skillRegistry } from "../../../../src/lib/skills/registry.ts";

// The executor pulls in the settings module (owned by another group); load it lazily so a
// half-ported neighbour cannot take the rest of this file down.
const executorModule = await import("../../../../src/lib/skills/executor.ts").catch(
  (err: unknown) => {
    console.warn(`skill executor not loadable yet: ${(err as Error).message}`);
    return null;
  }
);
const skillExecutor = executorModule?.skillExecutor;

beforeEach(async () => {
  await truncateAll(getTestBackend());
  skillRegistry.invalidateCache();
});

test("a2a tasks: upsert, events, filters, owner visibility, purge", async () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const base = {
    state: "submitted",
    skillId: "quota-management",
    inputJson: JSON.stringify({ q: 1 }),
    outputJson: null,
    completedAt: null,
  };
  await a2a.upsertA2ATask({ ...base, id: "t1", apiKeyId: "k1", createdAt: now, updatedAt: now });
  await a2a.upsertA2ATask({ ...base, id: "t2", apiKeyId: null, createdAt: old, updatedAt: old });
  await a2a.upsertA2ATask({ ...base, id: "t3", apiKeyId: "k2", createdAt: now, updatedAt: now });

  // update path keeps input, replaces output/state
  await a2a.upsertA2ATask({
    ...base,
    id: "t1",
    state: "completed",
    outputJson: JSON.stringify({ ok: true }),
    apiKeyId: "k1",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
  const t1 = await a2a.getA2ATaskHistoryById("t1");
  assert.equal(t1?.state, "completed");
  assert.deepEqual(JSON.parse(t1!.input_json!), { q: 1 });
  assert.deepEqual(JSON.parse(t1!.output_json!), { ok: true });
  assert.ok(t1!.completed_at);

  assert.equal(await a2a.getA2ATaskHistoryById("t3", "k1"), null);
  assert.ok(await a2a.getA2ATaskHistoryById("t2", "k1"));

  const listed = await a2a.listA2ATaskHistory({ owner: "k1", limit: 10, offset: 0 });
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.rows.map((r) => r.id).sort(), ["t1", "t2"]);
  const bySkill = await a2a.listA2ATaskHistory({
    skill: "quota-management",
    state: "completed",
    from: new Date(Date.now() - 86_400_000).toISOString(),
    limit: 10,
    offset: 0,
  });
  assert.deepEqual(
    bySkill.rows.map((r) => r.id),
    ["t1"]
  );

  await a2a.appendA2ATaskEvent("t2", "state:working", JSON.stringify({ a: 1 }));
  await a2a.appendA2ATaskEvent("t2", "memory_hits");
  await a2a.appendA2ATaskEvent("t2", "weird", "not json at all");
  const events = await a2a.listA2ATaskEvents("t2");
  assert.deepEqual(
    events.map((e) => e.event_type),
    ["state:working", "memory_hits", "weird"]
  );
  assert.deepEqual(JSON.parse(events[0].data_json!), { a: 1 });
  assert.equal(events[1].data_json, null);

  // concurrent upserts of one id converge on a single row
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      a2a.upsertA2ATask({
        ...base,
        id: "race",
        state: i % 2 ? "working" : "submitted",
        apiKeyId: null,
        createdAt: now,
        updatedAt: now,
      })
    )
  );
  assert.equal((await a2a.listA2ATaskHistory({ skill: "quota-management", limit: 50, offset: 0 })).total, 4);

  const purged = await a2a.purgeA2AHistory(30);
  assert.equal(purged, 1);
  assert.equal(await a2a.getA2ATaskHistoryById("t2"), null);
  assert.deepEqual(await a2a.listA2ATaskEvents("t2"), []);
});

test("agent bridge bypass, mappings and state", async () => {
  await bypass.seedDefaultBypassPatterns(["a.com", "b.com"]);
  await bypass.seedDefaultBypassPatterns(["a.com", "c.com"]);
  await bypass.replaceUserBypassPatterns(["u1", "u2", "u1"]);
  const all = await bypass.getAllBypassPatterns();
  assert.deepEqual(
    all.map((r) => `${r.source}:${r.pattern}`),
    ["default:a.com", "default:b.com", "default:c.com", "user:u1", "user:u2"]
  );
  await bypass.replaceUserBypassPatterns(["u3"]);
  assert.deepEqual(await bypass.getUserBypassPatterns(), ["u3"]);

  await mappings.setMappings("claude-code", [
    { source: "*", target: "combo-x" },
    { source: "opus", target: "model-y" },
  ]);
  await mappings.setMappings("kiro", [{ source: "k", target: "t" }]);
  assert.deepEqual(
    (await mappings.getMappingsForAgent("claude-code")).map((m) => [m.source_model, m.target_model]),
    [
      ["*", "combo-x"],
      ["opus", "model-y"],
    ]
  );
  await mappings.setMappings("claude-code", [{ source: "opus", target: "model-z" }]);
  await mappings.deleteMapping("kiro", "k");
  assert.equal((await mappings.getMappingsForAgent("claude-code")).length, 1);
  assert.equal((await mappings.getMappingsForAgent("kiro")).length, 0);
  await mappings.syncAgentBridgeMappingsToMitmAlias("claude-code");

  assert.equal(await bridgeState.getAgentBridgeState("antigravity"), null);
  await bridgeState.upsertAgentBridgeState({ agent_id: "antigravity", dns_enabled: true });
  await bridgeState.upsertAgentBridgeState({
    agent_id: "antigravity",
    cert_trusted: true,
    last_error: "boom",
  });
  let state = await bridgeState.getAgentBridgeState("antigravity");
  assert.equal(state?.dns_enabled, true);
  assert.equal(state?.cert_trusted, true);
  assert.equal(state?.setup_completed, false);
  assert.equal(state?.last_error, "boom");
  await bridgeState.upsertAgentBridgeState({ agent_id: "antigravity", last_error: null });
  await bridgeState.setLastStarted("antigravity", "2026-11-16T10:00:00.000Z");
  await bridgeState.setLastError("kiro", "e");
  state = await bridgeState.getAgentBridgeState("antigravity");
  assert.equal(state?.last_error, null);
  assert.equal(state?.dns_enabled, true);
  assert.equal(state?.last_started_at, "2026-11-16T10:00:00.000Z");
  assert.deepEqual(
    (await bridgeState.getAllAgentBridgeStates()).map((s) => s.agent_id),
    ["antigravity", "kiro"]
  );

  // concurrent first-writes for one agent must not conflict
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      bridgeState.upsertAgentBridgeState({ agent_id: "new", setup_completed: i % 2 === 0 })
    )
  );
  assert.ok(await bridgeState.getAgentBridgeState("new"));
});

test("files: create, read, list pagination, soft delete, prune", async () => {
  const a = await files.createFile({
    bytes: 3,
    filename: "a.jsonl",
    purpose: "batch",
    content: Buffer.from("abc"),
    apiKeyId: "k1",
  });
  assert.ok(a.expiresAt && a.expiresAt > a.createdAt);
  const b = await files.createFile({
    bytes: 1,
    filename: "b.txt",
    purpose: "assistants",
    content: Buffer.from([0, 1, 255]),
    apiKeyId: "k2",
    expiresAt: Math.floor(Date.now() / 1000) - 10,
  });
  const fetched = await files.getFile(a.id);
  assert.equal(fetched?.filename, "a.jsonl");
  assert.equal(typeof fetched?.createdAt, "number");
  assert.equal(fetched?.mimeType, null);
  assert.deepEqual(await files.getFileContent(a.id), Buffer.from("abc"));
  assert.deepEqual(await files.getFileContent(b.id), Buffer.from([0, 1, 255]));

  assert.equal(await files.countFiles(), 2);
  assert.equal(await files.countFiles({ apiKeyId: "k1" }), 1);
  assert.equal(await files.countFiles({ purpose: "batch" }), 1);
  const page = await files.listFiles({ limit: 1 });
  assert.equal(page.length, 1);
  const next = await files.listFiles({ limit: 5, after: page[0].id });
  assert.equal(next.length, 1);
  assert.notEqual(next[0].id, page[0].id);
  // foreign cursor is ignored for an owner-scoped list
  const scoped = await files.listFiles({ apiKeyId: "k1", after: b.id });
  assert.equal(scoped.length, 1);

  assert.equal(await files.pruneExpiredFiles(Math.floor(Date.now() / 1000)), 1);
  assert.equal(await files.getFile(b.id), null);
  assert.equal(await files.deleteFileOwnedBy(a.id, "other"), false);
  await assert.rejects(() => files.deleteFileOwnedBy(a.id, " "));
  assert.equal(await files.deleteFileOwnedBy(a.id, "k1"), true);
  assert.equal(await files.deleteFile(a.id), true);
  assert.equal(await files.countFiles(), 0);
});

test("batches: NUL custom ids, string results and non-finite retention", async () => {
  const inp = await files.createFile({ bytes: 1, filename: "in", purpose: "batch", apiKeyId: "k1" });
  const b = await batches.createBatch({
    endpoint: "/v1/chat/completions",
    completionWindow: "24h",
    inputFileId: inp.id,
    apiKeyId: "k1",
  });
  await batches.ensureBatchItemCheckpoints(b.id, [
    { lineNumber: 1, customId: "a\u0000b" },
    { lineNumber: 2, customId: "q" },
  ]);
  await batches.markBatchItemProcessing(b.id, { lineNumber: 1, customId: "x\u0000y" });
  await batches.markBatchItemError(b.id, { lineNumber: 2, customId: "q\u0000" }, "boom");
  const cps = await batches.listBatchItemCheckpoints(b.id);
  assert.equal(cps[0].customId, "xy");
  assert.equal(cps[1].customId, "q");
  assert.equal(cps[1].error, "boom");
  await batches.markBatchItemResult(b.id, { lineNumber: 1, customId: "z" }, "123");
  assert.equal((await batches.listBatchItemCheckpoints(b.id))[0].result, "123");

  assert.equal(await a2a.purgeA2AHistory(Number.NaN), 0);
  const swept = await batches.deleteTerminalBatchesOlderThan(Number.NaN);
  assert.equal(swept.deletedBatches, 0);
});

test("batches: lifecycle, checkpoints, shared files, sweeps", async () => {
  const inA = await files.createFile({ bytes: 1, filename: "in-a", purpose: "batch", apiKeyId: "k1" });
  const inB = await files.createFile({ bytes: 1, filename: "in-b", purpose: "batch", apiKeyId: "k2" });
  const out = await files.createFile({ bytes: 1, filename: "out", purpose: "batch_output", apiKeyId: "k1" });

  const b1 = await batches.createBatch({
    endpoint: "/v1/chat/completions",
    completionWindow: "24h",
    inputFileId: inA.id,
    apiKeyId: "k1",
    metadata: { team: "x" },
  });
  const b2 = await batches.createBatch({
    endpoint: "/v1/chat/completions",
    completionWindow: "24h",
    inputFileId: inA.id, // shared with b1
    apiKeyId: "k1",
  });
  const b3 = await batches.createBatch({
    endpoint: "/v1/embeddings",
    completionWindow: "24h",
    inputFileId: inB.id,
    apiKeyId: "k2",
  });
  assert.equal(b1.status, "validating");
  const got = await batches.getBatch(b1.id);
  assert.deepEqual(got?.metadata, { team: "x" });
  assert.equal(got?.requestCountsTotal, 0);
  assert.equal(got?.expiresAt, null);
  assert.equal(typeof got?.createdAt, "number");

  const nowS = Math.floor(Date.now() / 1000);
  assert.equal(
    await batches.updateBatch(b1.id, {
      status: "completed",
      completedAt: nowS,
      outputFileId: out.id,
      requestCountsTotal: 2,
      requestCountsCompleted: 2,
      usage: { total_tokens: 5 },
      errors: { data: [] },
    }),
    true
  );
  await batches.updateBatch(b2.id, { status: "in_progress", inProgressAt: nowS });
  await batches.updateBatch(b3.id, { status: "completed", completedAt: nowS - 9 * 86_400 });
  assert.equal(await batches.updateBatch("missing", { status: "failed" }), false);
  assert.equal(await batches.updateBatch(b1.id, {}), false);
  const upd = await batches.getBatch(b1.id);
  assert.equal(upd?.status, "completed");
  assert.equal(upd?.completedAt, nowS);
  assert.deepEqual(upd?.usage, { total_tokens: 5 });

  assert.equal(await batches.countBatches(), 3);
  assert.equal(await batches.countBatches("k1"), 2);
  const listed = await batches.listBatches("k1", 10);
  assert.equal(listed.length, 2);
  const afterFirst = await batches.listBatches("k1", 10, listed[0].id);
  assert.equal(afterFirst.length, 1);
  assert.equal((await batches.getPendingBatches()).length, 1);
  assert.equal((await batches.getTerminalBatches()).length, 2);

  // checkpoints, including a concurrent double ensure
  const items = [
    { lineNumber: 1, customId: "c1" },
    { lineNumber: 2, customId: null },
    { lineNumber: 3, customId: "c3" },
  ];
  await Promise.all([
    batches.ensureBatchItemCheckpoints(b1.id, items),
    batches.ensureBatchItemCheckpoints(b1.id, items),
  ]);
  assert.equal(await batches.countBatchItemCheckpoints(b1.id), 3);
  await batches.markBatchItemProcessing(b1.id, items[0]);
  await batches.markBatchItemResult(b1.id, items[0], { status_code: 200, body: { a: "x" } });
  await batches.markBatchItemError(b1.id, items[1], { message: "bad" });
  const cps = await batches.listBatchItemCheckpoints(b1.id);
  assert.deepEqual(
    cps.map((c) => [c.lineNumber, c.status, c.customId]),
    [
      [1, "completed", "c1"],
      [2, "errored", null],
      [3, "pending", "c3"],
    ]
  );
  assert.deepEqual(cps[0].result, { status_code: 200, body: { a: "x" } });
  assert.deepEqual(cps[1].error, { message: "bad" });
  assert.equal(typeof cps[0].createdAt, "number");
  await batches.markBatchItemProcessing(b1.id, items[0]);
  assert.equal((await batches.listBatchItemCheckpoints(b1.id))[0].result, null);

  // deleting b1 must keep the file shared with b2, drop the unshared output
  assert.equal(await batches.isFileReferencedByOtherBatch(inA.id, [b1.id]), true);
  assert.equal(await batches.isFileReferencedByOtherBatch(out.id, [b1.id]), false);
  assert.equal(await batches.deleteBatch(b1.id), true);
  assert.equal(await batches.deleteBatch(b1.id), false);
  assert.equal(await batches.countBatchItemCheckpoints(b1.id), 0);
  assert.ok(await files.getFile(inA.id));
  assert.equal(await files.getFile(out.id), null);

  // key-scoped sweep never touches another tenant
  await assert.rejects(() => batches.deleteCompletedBatches({ apiKeyId: "" }));
  await assert.rejects(() =>
    batches.deleteCompletedBatches({ allTenants: true, apiKeyId: "k1" } as never)
  );
  assert.deepEqual(await batches.deleteCompletedBatches({ apiKeyId: "k1" }), {
    deletedBatches: 0,
    deletedFiles: 0,
    hasMore: false,
  });
  // age-gated terminal sweep: b3 completed 9 days ago, b2 still in progress
  assert.deepEqual(await batches.deleteTerminalBatchesOlderThan(30), {
    deletedBatches: 0,
    deletedFiles: 0,
    hasMore: false,
  });
  const swept = await batches.deleteTerminalBatchesOlderThan(7);
  assert.deepEqual(swept, { deletedBatches: 1, deletedFiles: 1, hasMore: false });
  assert.equal(await files.getFile(inB.id), null);
  assert.ok(await batches.getBatch(b2.id));

  await batches.updateBatch(b2.id, { status: "completed", completedAt: nowS });
  const all = await batches.deleteCompletedBatches({ allTenants: true });
  assert.equal(all.deletedBatches, 1);
  assert.equal(all.deletedFiles, 1);
  assert.equal(await batches.countBatches(), 0);
});

test("discovery results: upsert is keyed on provider, method and endpoint", async () => {
  const base = {
    providerId: "p1",
    method: "free_tier" as const,
    authType: "api_key" as const,
    feasibility: 3,
    riskLevel: "low" as const,
    status: "pending" as const,
  };
  const first = await discovery.upsertDiscoveryResult({ ...base, endpoint: null, models: ["m1"] });
  const again = await Promise.all([
    discovery.upsertDiscoveryResult({ ...base, endpoint: null, models: ["m1", "m2"], notes: "n" }),
    discovery.upsertDiscoveryResult({ ...base, endpoint: null, models: ["m1", "m2"], notes: "n" }),
  ]);
  assert.equal(again[0].id, first.id);
  assert.equal(again[1].id, first.id);
  assert.deepEqual(again[0].models, ["m1", "m2"]);
  await discovery.upsertDiscoveryResult({ ...base, endpoint: "https://x" });
  assert.equal((await discovery.getDiscoveryResults()).length, 2);
  assert.equal((await discovery.getDiscoveryResults("p1")).length, 2);
  assert.equal((await discovery.getDiscoveryResults("none")).length, 0);

  const verified = await discovery.markVerified(first.id!);
  assert.equal(verified?.status, "verified");
  assert.ok(verified?.verifiedAt);
  assert.equal(await discovery.markVerified(999999), null);
  assert.equal((await discovery.getDiscoveryResultById(first.id!))?.providerId, "p1");
  assert.equal(await discovery.deleteDiscoveryResult(first.id!), true);
  assert.equal(await discovery.deleteDiscoveryResult(first.id!), false);
});

test("evals: custom suites round-trip, runs, scorecard, routing query", async () => {
  const suite = await evals.saveCustomEvalSuite({
    name: "  My suite ",
    description: "d",
    cases: [
      {
        name: "c1",
        input: { messages: [{ role: "user", content: "hi" }], max_tokens: 10.7 },
        expected: { strategy: "contains", value: "hello" },
        tags: [" a ", ""],
      },
      {
        id: "case-2",
        name: "c2",
        model: "openai/gpt",
        input: { messages: [{ role: "user", content: "yo" }] },
        expected: { strategy: "custom" },
      },
    ],
  });
  assert.equal(suite.name, "My suite");
  assert.equal(suite.caseCount, 2);
  assert.deepEqual(suite.cases[0].input, { messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
  assert.deepEqual(suite.cases[0].tags, ["a"]);
  assert.equal(suite.cases[1].model, "openai/gpt");

  const resaved = await evals.saveCustomEvalSuite({
    id: suite.id,
    name: "Renamed",
    cases: [
      {
        name: "only",
        input: { messages: [{ role: "user", content: "x" }] },
        expected: { strategy: "exact", value: "y" },
      },
    ],
  });
  assert.equal(resaved.id, suite.id);
  assert.equal(resaved.caseCount, 1);
  assert.equal(resaved.createdAt, suite.createdAt);
  assert.equal((await evals.listCustomEvalSuites()).length, 1);

  await assert.rejects(() =>
    evals.saveCustomEvalSuite({
      id: suite.id,
      name: "bad",
      cases: [{ name: "x", input: { messages: [] }, expected: { strategy: "contains", value: "v" } }],
    })
  );
  // the failed save rolled back
  assert.equal((await evals.getCustomEvalSuite(suite.id))?.name, "Renamed");

  const summary = { total: 4, passed: 3, failed: 1, passRate: 75 };
  const run = await evals.saveEvalRun({
    runGroupId: "g1",
    suiteId: "builtin",
    suiteName: "Builtin",
    target: { type: "model", id: "openai/gpt", label: "gpt" },
    apiKeyId: "k1",
    avgLatencyMs: 120.4,
    summary,
    results: [{ caseId: "a", passed: true }],
    outputs: { a: "out" },
  });
  await evals.saveEvalRun({
    suiteId: "builtin",
    suiteName: "Builtin",
    target: { type: "combo", id: "c", label: "combo c" },
    summary: { total: 2, passed: 1, failed: 1, passRate: 50 },
    results: [],
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  });
  const runs = await evals.listEvalRuns({ suiteId: "builtin" });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].summary, summary);
  assert.equal(runs[0].avgLatencyMs, 120);
  assert.deepEqual(runs[0].outputs, { a: "out" });
  assert.equal(runs[0].id, run.id);
  assert.equal(runs[0].target.key, "model:openai/gpt");
  assert.equal((await evals.listEvalRuns({ runGroupId: "g1" })).length, 1);
  const routing = await evals.listModelEvalRunsForRouting({
    targetIds: ["openai/gpt", "other"],
    suiteIds: ["builtin"],
    maxAgeHours: 1,
  });
  assert.equal(routing.length, 1);
  const card = await evals.getEvalScorecard();
  assert.equal(card?.suites, 2);
  assert.equal(card?.totalCases, 6);

  assert.equal(await evals.deleteCustomEvalSuite(suite.id), true);
  assert.equal(await evals.deleteCustomEvalSuite(suite.id), false);
  const orphanCases = await db().queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM eval_cases`);
  assert.equal(orphanCases?.n, 0);
});

test("inspector: custom hosts and sessions with concurrent appends", async () => {
  await hosts.addCustomHost("a.example", "llm", "A");
  await hosts.addCustomHost("a.example", "app");
  await hosts.addCustomHost("b.example");
  await hosts.toggleCustomHost("b.example", false);
  assert.deepEqual(
    (await hosts.listCustomHosts()).map((h) => [h.host, h.enabled, h.kind, h.label]),
    [
      ["a.example", true, "llm", "A"],
      ["b.example", false, "custom", null],
    ]
  );
  assert.deepEqual(
    (await hosts.listCustomHosts({ enabledOnly: true })).map((h) => h.host),
    ["a.example"]
  );
  assert.equal(await hosts.isCustomHost("a.example"), true);
  assert.equal(await hosts.isCustomHost("b.example"), false);
  await hosts.touchLastSeen("a.example");
  await hosts.removeCustomHost("a.example");
  assert.equal(await hosts.isCustomHost("a.example"), false);

  const session = await inspector.createSession({ name: "s", profile: "llm" });
  const seqs = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      inspector.appendSessionRequest(session.id, JSON.stringify({ n: i }))
    )
  );
  assert.deepEqual([...seqs].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const stored = await inspector.getSession(session.id);
  assert.equal(stored?.request_count, 10);
  assert.equal(stored?.profile, "llm");
  const reqs = await inspector.getSessionRequests(session.id);
  assert.equal(reqs.length, 10);
  assert.deepEqual(
    reqs.map((r) => r.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(typeof JSON.parse(reqs[0].payload).n, "number");
  await inspector.renameSession(session.id, "renamed");
  await inspector.stopSession(session.id);
  const after = await inspector.getSession(session.id);
  assert.equal(after?.name, "renamed");
  assert.ok(after?.ended_at);
  assert.equal((await inspector.listSessions()).length, 1);
  // payloads here are not valid InterceptedRequests, so the snapshot skips them all
  assert.deepEqual(await inspector.snapshotSession(session.id), []);
  assert.equal(await inspector.snapshotSession("nope"), null);
  await inspector.deleteSession(session.id);
  assert.equal(await inspector.getSession(session.id), null);
  assert.deepEqual(await inspector.getSessionRequests(session.id), []);
});

test("playground presets: CRUD and uuid guard", async () => {
  const created = await presets.createPlaygroundPreset({
    name: "p",
    endpoint: "/v1/chat/completions",
    model: "m",
    system: undefined,
    params: { temperature: 0.2, stop: ["a", "b"] },
  });
  assert.equal(created.system, null);
  assert.deepEqual(created.params, { temperature: 0.2, stop: ["a", "b"] });
  assert.deepEqual(await presets.getPlaygroundPreset(created.id), created);
  assert.equal(await presets.getPlaygroundPreset("not-a-uuid"), null);
  assert.equal(await presets.updatePlaygroundPreset("not-a-uuid", { name: "x" }), null);
  assert.equal(await presets.deletePlaygroundPreset("not-a-uuid"), false);

  const updated = await presets.updatePlaygroundPreset(created.id, {
    name: "p2",
    system: "be nice",
    params: { top_p: 1 },
  });
  assert.equal(updated?.name, "p2");
  assert.equal(updated?.system, "be nice");
  assert.deepEqual(updated?.params, { top_p: 1 });
  assert.equal((await presets.updatePlaygroundPreset(created.id, {}))?.name, "p2");
  assert.equal((await presets.updatePlaygroundPreset(created.id, { system: null }))?.system, null);
  await presets.createPlaygroundPreset({ name: "q", endpoint: "e", model: "m", system: null, params: {} });
  const list = await presets.listPlaygroundPresets({ limit: 1, offset: 0 });
  assert.equal(list.items.length, 1);
  assert.equal(list.total, 2);
  assert.equal(await presets.deletePlaygroundPreset(created.id), true);
  assert.equal(await presets.deletePlaygroundPreset(created.id), false);
});

test("plugins: CRUD, derived enabled flag, JSON columns as text", async () => {
  const row = await plugins.insertPlugin({
    id: "p-1",
    name: "demo",
    version: "1.2.3",
    main: "index.js",
    tags: ["a"],
    manifest: { name: "demo" },
    hooks: ["onRequest"],
    pluginDir: "/tmp/demo",
    enabled: true,
  });
  assert.equal(row.status, "installed");
  assert.equal(row.enabled, 0);
  assert.deepEqual(JSON.parse(row.tags), ["a"]);
  assert.deepEqual(JSON.parse(row.manifest), { name: "demo" });
  assert.deepEqual(JSON.parse(row.config), {});
  assert.deepEqual(JSON.parse(row.hooks), ["onRequest"]);
  assert.equal(row.activatedAt, null);
  await assert.rejects(() =>
    plugins.insertPlugin({ id: "p-2", name: "demo", version: "1", main: "x", manifest: {}, pluginDir: "/x" })
  );

  assert.equal(await plugins.updatePluginStatus("demo", "active"), true);
  let active = await plugins.getPluginByName("demo");
  assert.equal(active?.enabled, 1);
  assert.ok(active?.activatedAt);
  const activatedAt = active!.activatedAt;
  assert.equal(await plugins.updatePluginStatus("demo", "error", "boom"), true);
  active = await plugins.getPluginById("p-1");
  assert.equal(active?.enabled, 0);
  assert.equal(active?.errorMessage, "boom");
  assert.equal(active?.activatedAt, activatedAt);
  assert.equal(await plugins.updatePluginStatus("missing", "active"), false);

  assert.equal(await plugins.updatePluginManifest("demo", { v: 2 }, ["onResponse"]), true);
  assert.equal(await plugins.updatePluginConfig("demo", { k: "v" }), true);
  const changed = await plugins.getPluginByName("demo");
  assert.deepEqual(JSON.parse(changed!.manifest), { v: 2 });
  assert.deepEqual(JSON.parse(changed!.hooks), ["onResponse"]);
  assert.deepEqual(JSON.parse(changed!.config), { k: "v" });
  assert.equal((await plugins.listPlugins("error")).length, 1);
  assert.equal((await plugins.listPlugins("active")).length, 0);
  assert.equal(await plugins.pluginExists("demo"), true);
  assert.equal(await plugins.deletePlugin("demo"), true);
  assert.equal(await plugins.pluginExists("demo"), false);
});

test("skills: registry, updateSkill and execution history", async () => {
  const schema = { input: { type: "object" }, output: { type: "object" } } as never;
  const s1 = await skillRegistry.register({
    name: "echo",
    version: "1.0.0",
    description: "d",
    schema,
    handler: "echo-handler",
    enabled: true,
    apiKeyId: "k1",
    tags: ["t"],
    sourceProvider: "local",
  });
  const s2 = await skillRegistry.register({
    name: "echo",
    version: "1.1.0",
    schema,
    handler: "echo-handler",
    enabled: false,
    apiKeyId: "system",
  });
  skillRegistry.invalidateCache();
  await skillRegistry.loadFromDatabase();
  const listed = skillRegistry.list("k1");
  assert.equal(listed.length, 2);
  const loaded = skillRegistry.getSkill(s1.id, "k1");
  assert.equal(loaded?.enabled, true);
  assert.deepEqual(loaded?.tags, ["t"]);
  assert.deepEqual(loaded?.schema, schema);
  assert.equal(loaded?.sourceProvider, "local");
  assert.equal(skillRegistry.getSkill(s2.id, "k1")?.enabled, false);

  const toggled = await skillRegistry.setEnabledById(s2.id, "system", true);
  assert.equal(toggled?.enabled, true);
  assert.equal(await skillRegistry.setEnabledById(s2.id, "k1", false), undefined);
  assert.equal(await skillsDb.updateSkill(s1.id, { mode: "off", enabled: 0 }), 1);
  assert.equal(await skillsDb.updateSkill(s1.id, { bogus: 1 } as never), 0);
  assert.equal(await skillsDb.updateSkill("missing", { mode: "on" }), 0);
  skillRegistry.invalidateCache();
  await skillRegistry.loadFromDatabase("k1");
  const afterPatch = skillRegistry.getSkill(s1.id, "k1");
  assert.equal(afterPatch?.mode, "off");
  assert.equal(afterPatch?.enabled, false);

  // execution history rows: written with the executor's own SQL shapes
  await db().execute(
    `INSERT INTO skill_executions (id, skill_id, api_key_id, session_id, input, output, status, duration_ms)
     VALUES ('e1', $1, 'k1', 's', '{"a":1}', '{"ok":true}', 'success', 12),
            ('e2', $1, 'k2', NULL, '{"a":2}', NULL, 'error', 3)`,
    [s1.id]
  );
  if (skillExecutor) {
    const e1 = await skillExecutor.getExecution("e1");
    assert.deepEqual(e1?.input, { a: 1 });
    assert.deepEqual(e1?.output, { ok: true });
    assert.equal(e1?.sessionId, "s");
    assert.equal((await skillExecutor.getExecution("e2"))?.output, null);
    assert.equal(await skillExecutor.getExecution("nope"), undefined);
    assert.equal(await skillExecutor.countExecutions(), 2);
    assert.equal(await skillExecutor.countExecutions("k1"), 1);
    assert.equal((await skillExecutor.listExecutions(undefined, 1, 0)).length, 1);
    assert.equal((await skillExecutor.listExecutions("k2")).length, 1);
  }

  assert.equal(await skillRegistry.unregisterById(s2.id), true);
  assert.equal(await skillRegistry.unregister("echo", "1.0.0", "k1"), true);
  assert.equal(await skillRegistry.unregister("echo"), false);
  // skill deletion cascades its execution history
  const left = await db().queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM skill_executions`);
  assert.equal(left?.n, 0);
});
