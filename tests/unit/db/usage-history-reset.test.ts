/**
 * TDD regression guard for the on-demand, period-scoped usage-data reset
 * (Settings → Storage → "Reset usage data").
 *
 * Ported from decolua/9router PR #2272 (usage-reset concern only — the
 * connection bulk-delete half of that PR is intentionally not ported;
 * OmniRoute already has a native bulk-delete for connections).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let originalDataDir: string | undefined;

function setup() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-reset-test-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
}

async function teardown() {
  try {
    const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
    await resetDbInstance();
  } catch {
    // ignore if import fails
  }
  if (originalDataDir !== undefined) {
    process.env.DATA_DIR = originalDataDir;
  } else {
    delete process.env.DATA_DIR;
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // ignore cleanup errors
  }
}

async function countRows(table: string): Promise<number> {
  const { getTestBackend } = await import("../../helpers/postgres.ts");
  const row = await getTestBackend().queryOne<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM ${table}`
  );
  return Number(row?.c ?? 0);
}

test("purge usage API exposes every conversation reset counter", () => {
  const routeSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/settings/purge-usage-history/route.ts"),
    "utf8"
  );

  assert.match(
    routeSource,
    /deletedConversationTurnNodes:\s*result\.deletedConversationTurnNodes/,
    "the API response should expose deleted conversation nodes"
  );
  assert.match(
    routeSource,
    /deletedAgenticConversations:\s*result\.deletedAgenticConversations/,
    "the API response should expose deleted conversation roots"
  );
});

test("resetUsageHistory: 'all' wipes usage_history, daily_usage_summary and the call/proxy/compression logs; a period only deletes rows older than the cutoff; an invalid period throws", async () => {
  setup();
  try {
    const { getTestBackend } = await import("../../helpers/postgres.ts");
    const { resetUsageHistory } = await import("../../../src/lib/db/cleanup.ts");
    const b = getTestBackend();

    const now = Date.now();
    const oldIso = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const recentIso = new Date(now - 60 * 60 * 1000).toISOString(); // 1 hour ago
    const oldDate = oldIso.slice(0, 10);
    const recentDate = recentIso.slice(0, 10);
    const oldArtifactRelpath = "2026-01-01/old-call.json";
    const recentArtifactRelpath = "2026-01-01/recent-call.json";
    const oldArtifactPath = path.join(tempDir, "call_logs", oldArtifactRelpath);
    const recentArtifactPath = path.join(tempDir, "call_logs", recentArtifactRelpath);

    fs.mkdirSync(path.dirname(oldArtifactPath), { recursive: true });
    fs.writeFileSync(oldArtifactPath, "{}");
    fs.writeFileSync(recentArtifactPath, "{}");

    async function seed() {
      await b.execute(
        "INSERT INTO provider_nodes (id, type, name, prefix, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          "openai-compatible-chat-test",
          "openai-compatible",
          "Custom Test",
          "custom-test",
          recentIso,
          recentIso,
        ]
      );
      await b.execute(
        "INSERT INTO api_keys (id, name, key, key_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
        ["key-test", "Test Key", "sk-test", "a".repeat(64), recentIso]
      );
      await b.execute(
        "INSERT INTO combos (id, name, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
        ["combo-test", "Test Combo", "{}", recentIso, recentIso]
      );
      await b.execute(
        `INSERT INTO agentic_conversations
           (id, api_key_id, fingerprint_hash, turn_count, first_seen_at, last_seen_at)
         VALUES ('conversation-test', 'key-test', 'fp', 1, $1, $2)`,
        [recentIso, recentIso]
      );
      await b.execute(
        `INSERT INTO conversation_turn_nodes
           (id, conversation_id, parent_id, role, content_hash, last_correlation_id, first_seen_at, last_seen_at)
         VALUES ('turn-test', 'conversation-test', NULL, 'user', 'hash', 'recent-call', $1, $2)`,
        [recentIso, recentIso]
      );

      await b.execute(
        'INSERT INTO usage_history (provider, model, "timestamp") VALUES ($1, $2, $3)',
        ["openai", "gpt-test", oldIso]
      );
      await b.execute(
        'INSERT INTO usage_history (provider, model, "timestamp") VALUES ($1, $2, $3)',
        ["openai", "gpt-test", recentIso]
      );

      await b.execute(
        'INSERT INTO call_logs (id, "timestamp", artifact_relpath) VALUES ($1, $2, $3)',
        ["old-call", oldIso, oldArtifactRelpath]
      );
      await b.execute(
        'INSERT INTO call_logs (id, "timestamp", artifact_relpath) VALUES ($1, $2, $3)',
        ["recent-call", recentIso, recentArtifactRelpath]
      );
      await b.execute('INSERT INTO proxy_logs (id, "timestamp") VALUES ($1, $2)', [
        "old-proxy",
        oldIso,
      ]);
      await b.execute('INSERT INTO proxy_logs (id, "timestamp") VALUES ($1, $2)', [
        "recent-proxy",
        recentIso,
      ]);
      await b.execute(
        'INSERT INTO compression_analytics ("timestamp", mode, original_tokens, compressed_tokens, tokens_saved) VALUES ($1, $2, $3, $4, $5)',
        [oldIso, "lite", 100, 50, 50]
      );
      await b.execute(
        'INSERT INTO compression_analytics ("timestamp", mode, original_tokens, compressed_tokens, tokens_saved) VALUES ($1, $2, $3, $4, $5)',
        [recentIso, "lite", 100, 50, 50]
      );

      await b.execute(
        "INSERT INTO daily_usage_summary (provider, model, date) VALUES ($1, $2, $3)",
        ["openai", "gpt-test", oldDate]
      );
      await b.execute(
        "INSERT INTO daily_usage_summary (provider, model, date) VALUES ($1, $2, $3)",
        ["openai", "gpt-test", recentDate]
      );
    }

    await seed();

    assert.equal(await countRows("usage_history"), 2, "sanity: 2 usage_history rows seeded");
    assert.equal(await countRows("call_logs"), 2, "sanity: 2 call_logs rows seeded");
    assert.equal(await countRows("proxy_logs"), 2, "sanity: 2 proxy_logs rows seeded");
    assert.equal(
      await countRows("compression_analytics"),
      2,
      "sanity: 2 compression_analytics rows seeded"
    );
    assert.equal(
      await countRows("daily_usage_summary"),
      2,
      "sanity: 2 daily_usage_summary rows seeded"
    );

    // 1) A period ("1d") deletes only the row older than the cutoff, keeps the recent one.
    const periodResult = await resetUsageHistory("1d");

    assert.equal(periodResult.errors, 0, "period reset should not report errors");
    assert.equal(
      periodResult.deletedUsageHistory,
      1,
      "should delete only the old usage_history row"
    );
    assert.equal(periodResult.deletedCallLogs, 1, "should delete only the old call_logs row");
    assert.equal(periodResult.deletedProxyLogs, 1, "should delete only the old proxy_logs row");
    assert.equal(
      periodResult.deletedCompressionAnalytics,
      1,
      "should delete only the old compression_analytics row"
    );
    assert.equal(
      periodResult.deletedDailySummary,
      1,
      "should delete only the old daily_usage_summary row"
    );
    assert.equal(periodResult.deleted, 5, "total deleted should sum the reset tables");
    assert.equal(
      periodResult.deletedCallLogArtifacts,
      1,
      "period reset should delete only old call artifact"
    );
    assert.equal(
      fs.existsSync(oldArtifactPath),
      false,
      "period reset should delete old call artifact"
    );
    assert.equal(
      fs.existsSync(recentArtifactPath),
      true,
      "period reset should preserve recent call artifact"
    );

    assert.equal(await countRows("provider_nodes"), 1, "provider config should survive reset");
    assert.equal(await countRows("api_keys"), 1, "API keys should survive reset");
    assert.equal(await countRows("combos"), 1, "combos should survive reset");
    assert.equal(
      await countRows("conversation_turn_nodes"),
      1,
      "a timed reset should preserve conversation identity nodes"
    );
    assert.equal(
      await countRows("agentic_conversations"),
      1,
      "a timed reset should preserve conversation roots"
    );

    assert.equal(await countRows("usage_history"), 1, "recent usage_history row should survive");
    assert.equal(await countRows("call_logs"), 1, "recent call_logs row should survive");
    assert.equal(await countRows("proxy_logs"), 1, "recent proxy_logs row should survive");
    assert.equal(
      await countRows("compression_analytics"),
      1,
      "recent compression_analytics row should survive"
    );
    assert.equal(
      await countRows("daily_usage_summary"),
      1,
      "recent daily_usage_summary row should survive"
    );

    const survivingUsage = await b.queryOne<{ timestamp: string }>(
      'SELECT "timestamp" FROM usage_history'
    );
    assert.equal(
      Date.parse(survivingUsage?.timestamp ?? ""),
      Date.parse(recentIso),
      "the surviving usage_history row should be the recent one"
    );

    // 2) "all" wipes everything left (including the row the period reset kept).
    const allResult = await resetUsageHistory("all");

    assert.equal(allResult.errors, 0, "'all' reset should not report errors");
    assert.equal(
      allResult.deletedUsageHistory,
      1,
      "'all' should delete the remaining usage_history row"
    );
    assert.equal(allResult.deletedCallLogs, 1, "'all' should delete the remaining call_logs row");
    assert.equal(allResult.deletedProxyLogs, 1, "'all' should delete the remaining proxy_logs row");
    assert.equal(
      allResult.deletedCompressionAnalytics,
      1,
      "'all' should delete the remaining compression_analytics row"
    );
    assert.equal(
      allResult.deletedDailySummary,
      1,
      "'all' should delete the remaining daily_usage_summary row"
    );
    assert.equal(
      allResult.deletedCallLogArtifacts,
      1,
      "'all' should delete remaining call artifact"
    );
    assert.equal(
      allResult.deletedConversationTurnNodes,
      1,
      "'all' should delete conversation identity nodes"
    );
    assert.equal(
      allResult.deletedAgenticConversations,
      1,
      "'all' should delete conversation roots"
    );
    assert.equal(
      fs.existsSync(recentArtifactPath),
      false,
      "'all' should delete recent call artifact"
    );

    assert.equal(await countRows("usage_history"), 0, "'all' should empty usage_history");
    assert.equal(await countRows("call_logs"), 0, "'all' should empty call_logs");
    assert.equal(await countRows("proxy_logs"), 0, "'all' should empty proxy_logs");
    assert.equal(
      await countRows("compression_analytics"),
      0,
      "'all' should empty compression_analytics"
    );
    assert.equal(await countRows("daily_usage_summary"), 0, "'all' should empty daily_usage_summary");
    assert.equal(
      await countRows("conversation_turn_nodes"),
      0,
      "'all' should empty conversation_turn_nodes"
    );
    assert.equal(
      await countRows("agentic_conversations"),
      0,
      "'all' should empty agentic_conversations"
    );
    assert.equal(await countRows("provider_nodes"), 1, "provider config should still survive 'all'");
    assert.equal(await countRows("api_keys"), 1, "API keys should still survive 'all'");
    assert.equal(await countRows("combos"), 1, "combos should still survive 'all'");

    // 3) An invalid period throws instead of silently doing nothing / deleting everything.
    await assert.rejects(
      () => resetUsageHistory("bogus-period"),
      /Invalid reset period/,
      "an invalid period should throw"
    );
  } finally {
    await teardown();
  }
});
