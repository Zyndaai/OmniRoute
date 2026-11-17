/**
 * Issue #12453 — conversation_turn_nodes / agentic_conversations have no
 * retention path, so the database grows without bound (1.15M node rows,
 * ~775 MB in four days on one busy coding-agent workload).
 *
 * The identity nodes only make sense while the call_logs row their
 * last_correlation_id points at still exists, so both tables follow their
 * own `retention.conversationTurnNodes` window, not `retention.callLogs`
 * directly — the default (30) matches callLogs' default so upgrading an
 * existing install changes no behavior until an operator overrides one of
 * the two knobs independently.
 *
 * These tests call the REAL cleanup functions against the per-process Postgres
 * database (tests/_setup/isolatePostgres.ts), seeded with test rows. Retention
 * overrides are saved the way the dashboard saves them: config_entries rows in the
 * 'databaseSettings' namespace, key `retention.<name>`.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { cleanupConversationTurnNodes, cleanupAgenticConversations, runAutoCleanup } =
  await import("../../src/lib/db/cleanup.ts");
const { getRetentionSettings } = await import("../../src/lib/db/retentionSettings.ts");
const { DEFAULT_DATABASE_SETTINGS } = await import("../../src/types/databaseSettings.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

const DAY_MS = 86_400_000;
const RETENTION_DAYS = (await getRetentionSettings()).conversationTurnNodes;
const OLD = new Date(Date.now() - (RETENTION_DAYS + 1) * DAY_MS).toISOString();
const RECENT = new Date().toISOString();

async function insertConversation(id: string, lastSeenAt: string): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO agentic_conversations
       (id, api_key_id, fingerprint_hash, turn_count, first_seen_at, last_seen_at)
     VALUES ($1, 'key1', 'fp', 1, $2, $2)`,
    [id, lastSeenAt]
  );
}

async function insertNode(id: string, conversationId: string, lastSeenAt: string): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO conversation_turn_nodes
       (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
     VALUES ($1, $2, NULL, 'user', 'hash', 'corr', $3, $3)`,
    [id, conversationId, lastSeenAt]
  );
}

async function count(table: string): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM ${table}`
  );
  return row?.cnt ?? 0;
}

async function ids(table: string): Promise<string[]> {
  const rows = await getTestBackend().query<{ id: string }>(
    `SELECT id FROM ${table} ORDER BY id`
  );
  return rows.map((r) => r.id);
}

/** Saves (value) or clears (null) one retention override, as the dashboard does. */
async function setRetentionOverride(name: string, value: number | null): Promise<void> {
  const b = getTestBackend();
  if (value === null) {
    await b.execute(
      `DELETE FROM config_entries WHERE namespace = 'databaseSettings' AND key = $1`,
      [`retention.${name}`]
    );
    return;
  }
  await b.execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('databaseSettings', $1, $2::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`retention.${name}`, String(value)]
  );
}

test.beforeEach(async () => {
  await resetTestDb();
});

test.after(async () => {
  await resetTestDb().catch(() => {});
});

test("#12453 cleanupConversationTurnNodes: deletes nodes older than the call-log retention window", async () => {
  await insertConversation("conv_a", RECENT);
  await insertNode("old-1", "conv_a", OLD);
  await insertNode("old-2", "conv_a", OLD);
  await insertNode("old-3", "conv_a", OLD);
  await insertNode("recent-1", "conv_a", RECENT);
  await insertNode("recent-2", "conv_a", RECENT);

  const result = await cleanupConversationTurnNodes();

  assert.strictEqual(result.deleted, 3);
  assert.strictEqual(result.errors, 0);
  assert.deepStrictEqual(await ids("conversation_turn_nodes"), ["recent-1", "recent-2"]);
});

test("#12453 cleanupConversationTurnNodes: yields between bounded delete batches", async () => {
  await insertConversation("conv_bulk", OLD);
  await getTestBackend().execute(
    `INSERT INTO conversation_turn_nodes
       (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
     SELECT 'bulk-' || g, 'conv_bulk', NULL, 'user', 'hash', 'corr', $1, $1
       FROM generate_series(0, 10000) AS g`,
    [OLD]
  );

  let eventLoopTurnObserved = false;
  setImmediate(() => {
    eventLoopTurnObserved = true;
  });

  const result = await cleanupConversationTurnNodes();

  assert.strictEqual(result.deleted, 10_001);
  assert.strictEqual(result.errors, 0);
  assert.strictEqual(await count("conversation_turn_nodes"), 0);
  assert.strictEqual(eventLoopTurnObserved, true, "cleanup should yield after a full batch");
});

test("#12453 cleanupAgenticConversations: sweeps stale conversations that have no nodes left", async () => {
  // Stale and orphaned: every node already expired -> must go.
  await insertConversation("conv_orphan_old", OLD);
  // Stale but still anchored by a live node -> must stay.
  await insertConversation("conv_anchored", OLD);
  await insertNode("live-1", "conv_anchored", RECENT);
  // Fresh root whose nodes are not written yet (createConversation runs before
  // the node insert in the same request) -> must stay.
  await insertConversation("conv_fresh_no_nodes", RECENT);

  const result = await cleanupAgenticConversations();

  assert.strictEqual(result.deleted, 1);
  assert.strictEqual(result.errors, 0);
  assert.deepStrictEqual(await ids("agentic_conversations"), [
    "conv_anchored",
    "conv_fresh_no_nodes",
  ]);
  assert.strictEqual(await count("conversation_turn_nodes"), 1);
});

test("#12453 nodes expire first, then the conversation they anchored is swept in the same pass", async () => {
  await insertConversation("conv_dead", OLD);
  await insertNode("dead-1", "conv_dead", OLD);
  await insertNode("dead-2", "conv_dead", OLD);

  // Conversation-only sweep must not touch a root that still has (old) nodes.
  const first = await cleanupAgenticConversations();
  assert.strictEqual(first.deleted, 0);
  assert.strictEqual(await count("agentic_conversations"), 1);

  const nodes = await cleanupConversationTurnNodes();
  assert.strictEqual(nodes.deleted, 2);

  const second = await cleanupAgenticConversations();
  assert.strictEqual(second.deleted, 1);
  assert.strictEqual(await count("agentic_conversations"), 0);
});

test("#12453 runAutoCleanup: registers both tables and reports them in results", async () => {
  await insertConversation("conv_x", OLD);
  await insertNode("x-1", "conv_x", OLD);
  await insertConversation("conv_y", RECENT);
  await insertNode("y-1", "conv_y", RECENT);

  const summary = await runAutoCleanup();

  assert.ok(summary.results.conversationTurnNodes, "conversationTurnNodes missing from results");
  assert.ok(summary.results.agenticConversations, "agenticConversations missing from results");
  assert.strictEqual(summary.results.conversationTurnNodes.deleted, 1);
  assert.strictEqual(summary.results.agenticConversations.deleted, 1);
  assert.strictEqual(summary.results.conversationTurnNodes.errors, 0);
  assert.strictEqual(summary.results.agenticConversations.errors, 0);
  assert.deepStrictEqual(await ids("conversation_turn_nodes"), ["y-1"]);
  assert.deepStrictEqual(await ids("agentic_conversations"), ["conv_y"]);
});

test("#12453 cleanupAgenticConversations: missing node table is reported, not thrown", async () => {
  // SQLite tolerated a missing table silently; Postgres reports a missing relation as an
  // error count (the cleanup never throws), and deletes nothing.
  await insertConversation("conv_without_table", OLD);
  const b = getTestBackend();
  await b.execute("ALTER TABLE conversation_turn_nodes RENAME TO conversation_turn_nodes_unavailable");

  try {
    const result = await cleanupAgenticConversations();
    assert.deepStrictEqual(result, { deleted: 0, errors: 1 });
    assert.strictEqual(await count("agentic_conversations"), 1);
  } finally {
    await b.execute(
      "ALTER TABLE conversation_turn_nodes_unavailable RENAME TO conversation_turn_nodes"
    );
  }
});

test("#12453 conversationTurnNodes window is independent of callLogs", async () => {
  try {
    await setRetentionOverride("callLogs", 90);
    await setRetentionOverride("conversationTurnNodes", 1);

    const dayMs = 86_400_000;
    const twoDaysAgo = new Date(Date.now() - 2 * dayMs).toISOString();
    const recent = new Date().toISOString();
    await insertConversation("conv_ind", recent);
    await insertNode("old-ind", "conv_ind", twoDaysAgo);
    await insertNode("new-ind", "conv_ind", recent);

    const result = await cleanupConversationTurnNodes();
    assert.strictEqual(result.deleted, 1);
    assert.deepStrictEqual(await ids("conversation_turn_nodes"), ["new-ind"]);
    assert.equal((await getRetentionSettings()).callLogs, 90);
  } finally {
    await setRetentionOverride("callLogs", null);
    await setRetentionOverride("conversationTurnNodes", null);
  }
});

test("#12453 default conversationTurnNodes retention matches callLogs (no behavior change on upgrade)", async () => {
  // Read the SHIPPED default directly (not a value this test sets itself) —
  // this is what actually ships to every existing install on upgrade.
  assert.strictEqual(
    DEFAULT_DATABASE_SETTINGS.retention.conversationTurnNodes,
    DEFAULT_DATABASE_SETTINGS.retention.callLogs,
    "default conversationTurnNodes must equal default callLogs so merging the split knob is a no-op for existing installs"
  );

  try {
    // Clear both overrides so the shipped defaults apply (an earlier test in this
    // file may have saved its own).
    await setRetentionOverride("callLogs", null);
    await setRetentionOverride("conversationTurnNodes", null);

    // A node that would have survived under the old shared callLogs window
    // (30 days) must still survive under the new dedicated default.
    const twentyNineDaysAgo = new Date(Date.now() - 29 * DAY_MS).toISOString();
    const recent = new Date().toISOString();
    await insertConversation("conv_default", recent);
    await insertNode("still-alive", "conv_default", twentyNineDaysAgo);

    const result = await cleanupConversationTurnNodes();
    assert.strictEqual(result.deleted, 0);
    assert.deepStrictEqual(await ids("conversation_turn_nodes"), ["still-alive"]);
  } finally {
    await setRetentionOverride("callLogs", null);
    await setRetentionOverride("conversationTurnNodes", null);
  }
});
