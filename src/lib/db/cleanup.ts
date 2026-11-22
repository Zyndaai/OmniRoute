/**
 * Database cleanup functions for removing old data based on retention policies.
 *
 * The three per-request log tables (`call_logs`, `usage_history`, `proxy_logs`) are
 * partitioned by UTC day, so their retention drops whole partitions (see ./logPartitions);
 * every other table is trimmed by a bounded `DELETE`.
 *
 * @module lib/db/cleanup
 */

import { rollupUsageHistoryBeforeDate } from "@/lib/usage/aggregateHistory";
import { purgeCallLogArtifactDirectory } from "@/lib/usage/callLogArtifacts";

import { db } from "./pg";
import { getRetentionSettings } from "./retentionSettings";
import {
  dropLogPartitionsBefore,
  ensureLogPartitions,
  warnOnDefaultPartitionRows,
} from "./logPartitions";
import {
  collectCallLogArtifactsBefore,
  deleteAllFromTable,
  deleteCallLogArtifacts,
  deleteFromTableBefore,
  deleteFromTableBeforeInBatches,
  type DeleteByPeriodTarget,
} from "./cleanup/usagePurge";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

interface CleanupResult {
  deleted: number;
  deletedArtifacts?: number;
  errors: number;
}

function cutoffFor(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * 86_400_000);
}

/**
 * `DELETE ... WHERE <column> < cutoff` over a plain table in batches of 10,000 rows, with the
 * event loop running in between, so a large backlog never holds one long statement.
 */
async function deleteOlderThan(
  table: string,
  column: string,
  retentionDays: number
): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };
  try {
    result.deleted = await deleteFromTableBeforeInBatches(
      { table, column, cutoff: "iso" },
      cutoffFor(retentionDays).toISOString()
    );
    console.log(`[Cleanup] Deleted ${result.deleted} ${table} older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error(`[Cleanup] Error cleaning ${table}:`, err);
    result.errors++;
  }
  return result;
}

/**
 * Clean up old quota_snapshots based on retention settings.
 */
export async function cleanupQuotaSnapshots(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan("quota_snapshots", "created_at", retention.quotaSnapshots);
}

// A closed quota-share bucket is read by no window once it is older than two monthly windows.
const QUOTA_SHARE_BUCKET_RETENTION_DAYS = 62;

/**
 * Delete closed quota-share consumption buckets that no window reads any more (#19445), so
 * `quota_counters` stops growing without limit. The per-key tpm/rpm counters ('key-quota:*')
 * prune themselves on write and are left alone here.
 */
export async function cleanupQuotaShareBuckets(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };
  try {
    result.deleted = await deleteFromTableBeforeInBatches(
      {
        table: "quota_counters",
        column: "updated_at",
        cutoff: "iso",
        extraWhere: "dimension_key NOT LIKE 'key-quota:%'",
      },
      cutoffFor(QUOTA_SHARE_BUCKET_RETENTION_DAYS).toISOString()
    );
    console.log(`[Cleanup] Deleted ${result.deleted} closed quota-share buckets`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning quota-share buckets:", err);
    result.errors++;
  }
  return result;
}

/**
 * Clean up old call_logs based on retention settings: whole UTC days are dropped, and the
 * artifact directories of the dropped days are removed with them.
 */
export async function cleanupCallLogs(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  const retentionDays = retention.callLogs;
  const result: CleanupResult = { deleted: 0, deletedArtifacts: 0, errors: 0 };

  try {
    const dropped = await dropLogPartitionsBefore("call_logs", cutoffFor(retentionDays));
    result.deleted = dropped.deletedRows;
    result.deletedArtifacts = dropped.deletedArtifacts;

    console.log(`[Cleanup] Deleted ${result.deleted} call_logs older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning call_logs:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old usage_history based on retention settings.
 */
export async function cleanupUsageHistory(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();

  const retentionDays = retention.usageHistory;
  const cutoffDate = cutoffFor(retentionDays);
  const cutoffDateStr = cutoffDate.toISOString().split("T")[0];

  const result: CleanupResult = { deleted: 0, errors: 0 };

  // Roll up rows that are about to be deleted into daily_usage_summary so that the
  // analytics route can still surface historical data via the UNION query. The rollup
  // uses the exact same day boundary as the partition drop below, so every deleted row
  // is guaranteed to have been aggregated first.
  //
  // rollupUsageHistoryBeforeDate catches its own errors and reports them via the
  // returned result, so we inspect that rather than relying on a thrown exception.
  // If the rollup failed, abort the drop to avoid permanently losing raw usage data
  // that was never aggregated.
  const rollupResult = await rollupUsageHistoryBeforeDate(cutoffDateStr);
  if (rollupResult.errors > 0) {
    console.error(
      "[Cleanup] Aborting usage_history deletion because the pre-delete rollup failed."
    );
    result.errors += rollupResult.errors;
    return result;
  }

  try {
    const dropped = await dropLogPartitionsBefore("usage_history", cutoffDate);
    result.deleted = dropped.deletedRows;

    console.log(
      `[Cleanup] Deleted ${result.deleted} usage_history older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning usage_history:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old compression_analytics based on retention settings.
 */
export async function cleanupCompressionAnalytics(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan("compression_analytics", "timestamp", retention.compressionAnalytics);
}

/**
 * Clean up old compression_engine_breakdown based on retention settings (#14268).
 * Uses retention.compressionAnalytics (same retention window as compression_analytics).
 */
export async function cleanupCompressionEngineBreakdown(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan(
    "compression_engine_breakdown",
    "timestamp",
    retention.compressionAnalytics
  );
}

/**
 * Clean up old mcp_tool_audit based on retention settings.
 */
export async function cleanupMcpAudit(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan("mcp_tool_audit", "created_at", retention.mcpAudit);
}

/**
 * Clean up old a2a_task_events based on retention settings.
 */
export async function cleanupA2aEvents(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan("a2a_task_events", "created_at", retention.a2aEvents);
}

/**
 * Clean up old domain_cost_history based on retention settings. (#6848)
 */
export async function cleanupDomainCostHistory(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan("domain_cost_history", "timestamp", retention.domainCostHistory);
}

/**
 * Clean up old compression_cache_stats based on retention settings. (#6848)
 */
export async function cleanupCompressionCacheStats(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan("compression_cache_stats", "created_at", retention.compressionCacheStats);
}

/**
 * Clean up old compression_run_telemetry based on retention settings. (#6848)
 */
export async function cleanupCompressionRunTelemetry(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  return deleteOlderThan(
    "compression_run_telemetry",
    "timestamp",
    retention.compressionRunTelemetry
  );
}

/**
 * Clean up expired CCR blocks (#9061).
 *
 * Unlike the tables above, these rows carry their own expiry: the engine writes
 * `expires_at` from the block's TTL, so this needs no retention-days setting of its own.
 * It is the same sweep the engine does opportunistically, run on the operator's schedule
 * so the table cannot sit on rows nobody will read again.
 */
export async function cleanupCcrBlocks(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const { pruneExpiredCcrBlocks } = await import("./ccrBlocks");
    result.deleted = await pruneExpiredCcrBlocks(Date.now());
    console.log(`[Cleanup] Deleted ${result.deleted} expired ccr_blocks`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning ccr_blocks:", err);
    result.errors++;
  }

  return result;
}

const BATCH_RETENTION_DAYS_DEFAULT = 30; // matches OpenAI's own Batch API output retention window

function getBatchRetentionDays(): number {
  const raw = process.env.OMNIROUTE_BATCH_RETENTION_DAYS;
  if (!raw) return BATCH_RETENTION_DAYS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : BATCH_RETENTION_DAYS_DEFAULT;
}

/**
 * Clean up terminal batches (completed/failed/cancelled/expired) older than the
 * retention window, along with their per-line checkpoints and referenced files.
 *
 * batch_item_checkpoints had no cleanup path at all before this: the only
 * existing sweep (deleteCompletedBatches(), the operator-triggered DELETE
 * /api/v1/batches/delete-completed route) is scoped to `status = 'completed'`
 * with no age filter, and is left untouched here -- it's a public API
 * contract, not the automatic cleanup path. Observed live: 182K checkpoint
 * rows / 5.25 GB, with no batch ever explicitly deleted by an operator.
 *
 * Gated by `BATCH_AND_FILE_AUTO_CLEANUP_ENABLED` (default off, #12999): every
 * existing install would otherwise start deleting terminal batches (and their
 * checkpoints) that today are kept forever, on the very next 6-hourly sweep.
 * Fail closed -- an operator must opt in before this sweep touches anything.
 */
export async function cleanupOldBatches(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };

  if (!isFeatureFlagEnabled("BATCH_AND_FILE_AUTO_CLEANUP_ENABLED")) {
    console.log(
      "[Cleanup] Batch auto-cleanup disabled (BATCH_AND_FILE_AUTO_CLEANUP_ENABLED=false); skipping."
    );
    return result;
  }

  try {
    const { deleteTerminalBatchesOlderThan } = await import("./batches");
    const retentionDays = getBatchRetentionDays();
    const { deletedBatches, hasMore } = await deleteTerminalBatchesOlderThan(retentionDays);
    result.deleted = deletedBatches;
    console.log(
      `[Cleanup] Deleted ${result.deleted} terminal batches older than ${retentionDays} days` +
        (hasMore ? " (per-run cap reached; the remainder is swept on the next run)" : "")
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning old batches:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clear the content of files past their own `expires_at`.
 *
 * Like ccr_blocks, a file carries its own expiry -- this needs no separate
 * retention-days setting, just an operator-scheduled sweep, since nothing
 * previously enforced expires_at at all. Observed live: 1,874 rows / 5.19 GB
 * of uploaded file content, most long past expiry.
 *
 * Gated by `BATCH_AND_FILE_AUTO_CLEANUP_ENABLED` (default off, #12999): every
 * existing install would otherwise start clearing file content that today is
 * kept until explicitly deleted. Fail closed -- an operator must opt in.
 */
export async function cleanupExpiredFiles(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };

  if (!isFeatureFlagEnabled("BATCH_AND_FILE_AUTO_CLEANUP_ENABLED")) {
    console.log(
      "[Cleanup] Expired-file auto-cleanup disabled (BATCH_AND_FILE_AUTO_CLEANUP_ENABLED=false); skipping."
    );
    return result;
  }

  try {
    const { pruneExpiredFiles } = await import("./files");
    result.deleted = await pruneExpiredFiles(Math.floor(Date.now() / 1000));
    console.log(`[Cleanup] Deleted ${result.deleted} expired files`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning expired files:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up conversation_turn_nodes older than their own retention window (#12453).
 *
 * The nodes are identity-only: the transcript view resolves each turn's display
 * content from the call_logs row `last_correlation_id` points at. Once
 * cleanupCallLogs purges that row the node can never render again, so this
 * window should not outlive `retention.callLogs` in practice — but the two
 * settings are independent knobs (`retention.conversationTurnNodes`, default
 * 30, matching callLogs' default so upgrading changes nothing until an
 * operator overrides one of them). `CALL_LOG_RETENTION_DAYS` configures the
 * separate compliance cleanup path and does not override this window.
 * Deleting an old node only affects reconnect anchors: a conversation resumed
 * after the window mints a new id, which is already the documented
 * anchor-miss behavior of resolveConversationId. Bounded batches yield between
 * writes so an existing large table cannot park the event loop for the whole
 * cleanup pass.
 */
export async function cleanupConversationTurnNodes(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();

  const retentionDays = retention.conversationTurnNodes;
  const cutoffISO = cutoffFor(retentionDays).toISOString();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    result.deleted = await deleteFromTableBeforeInBatches(
      { table: "conversation_turn_nodes", column: "last_seen_at", cutoff: "iso" },
      cutoffISO
    );
    console.log(
      `[Cleanup] Deleted ${result.deleted} conversation_turn_nodes older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning conversation_turn_nodes:", err);
    result.errors++;
  }

  return result;
}

/**
 * Sweep agentic_conversations left without any conversation_turn_nodes (#12453).
 *
 * Runs after cleanupConversationTurnNodes so a root whose whole chain just
 * expired goes in the same pass. The `last_seen_at` predicate bounds the
 * NOT EXISTS probe to roots that are already past the retention window.
 * Deletion is batched for the same event-loop fairness guarantee as the
 * preceding node cleanup.
 */
export async function cleanupAgenticConversations(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  const retentionDays = retention.conversationTurnNodes;
  const cutoffISO = cutoffFor(retentionDays).toISOString();
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const batchSize = 10_000;
    while (true) {
      const batch = (
        await db().execute(
          `DELETE FROM agentic_conversations
            WHERE id IN (
              SELECT ac.id FROM agentic_conversations ac
               WHERE ac.last_seen_at < $1
                 AND NOT EXISTS (
                   SELECT 1 FROM conversation_turn_nodes n WHERE n.conversation_id = ac.id
                 )
               LIMIT $2
            )`,
          [cutoffISO, batchSize]
        )
      ).changes;
      result.deleted += batch;
      if (batch < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    console.log(
      `[Cleanup] Deleted ${result.deleted} orphaned agentic_conversations older than ${retentionDays} days`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning agentic_conversations:", err);
    result.errors++;
  }

  return result;
}

/**
 * Run all cleanup functions if auto-cleanup is enabled.
 */
export async function runAutoCleanup(): Promise<{
  totalDeleted: number;
  totalErrors: number;
  results: Record<string, CleanupResult>;
}> {
  const retention = await getRetentionSettings();
  const autoCleanupEnabled = retention.autoCleanupEnabled;

  if (!autoCleanupEnabled) {
    console.log("[Cleanup] Auto-cleanup is disabled");
    return { totalDeleted: 0, totalErrors: 0, results: {} };
  }

  console.log("[Cleanup] Starting auto-cleanup...");

  const results: Record<string, CleanupResult> = {
    quotaSnapshots: await cleanupQuotaSnapshots(),
    quotaShareBuckets: await cleanupQuotaShareBuckets(),
    callLogs: await cleanupCallLogs(),
    usageHistory: await cleanupUsageHistory(),
    compressionAnalytics: await cleanupCompressionAnalytics(),
    compressionEngineBreakdown: await cleanupCompressionEngineBreakdown(),
    mcpAudit: await cleanupMcpAudit(),
    a2aEvents: await cleanupA2aEvents(),
    domainCostHistory: await cleanupDomainCostHistory(),
    compressionCacheStats: await cleanupCompressionCacheStats(),
    compressionRunTelemetry: await cleanupCompressionRunTelemetry(),
    proxyLogs: await cleanupProxyLogs(),
    ccrBlocks: await cleanupCcrBlocks(),
    conversationTurnNodes: await cleanupConversationTurnNodes(),
    agenticConversations: await cleanupAgenticConversations(),
    oldBatches: await cleanupOldBatches(),
    expiredFiles: await cleanupExpiredFiles(),
  };

  const totalDeleted = Object.values(results).reduce((sum, r) => sum + r.deleted, 0);
  const totalErrors = Object.values(results).reduce((sum, r) => sum + r.errors, 0);

  console.log(`[Cleanup] Auto-cleanup complete: ${totalDeleted} deleted, ${totalErrors} errors`);

  return { totalDeleted, totalErrors, results };
}

/**
 * Purge ALL quota_snapshots immediately (no retention check).
 */
export async function purgeQuotaSnapshots(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    result.deleted = (await db().execute("DELETE FROM quota_snapshots")).changes;

    console.log(`[Cleanup] Purged ${result.deleted} quota_snapshots`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging quota_snapshots:", err);
    result.errors++;
  }

  return result;
}

/**
 * Purge ALL call_logs immediately (no retention check).
 */
export async function purgeCallLogs(): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, deletedArtifacts: 0, errors: 0 };

  try {
    result.deleted = await deleteAllFromTable("call_logs");

    console.log(`[Cleanup] Purged ${result.deleted} call_logs`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error purging call_logs:", err);
    result.errors++;
  }

  const artifactResult = purgeCallLogArtifactDirectory();
  result.deletedArtifacts = artifactResult.deletedArtifacts;
  result.errors += artifactResult.errors;

  if (artifactResult.errors === 0) {
    console.log(`[Cleanup] Purged ${result.deletedArtifacts} call log artifact(s)`);
  }

  return result;
}

/**
 * Whitelist of periods accepted by {@link resetUsageHistory}. `"all"` wipes
 * every row; any other value deletes rows strictly older than `now - period`.
 */
export const RESET_USAGE_HISTORY_PERIODS = [
  "5m",
  "1h",
  "3h",
  "6h",
  "12h",
  "1d",
  "7d",
  "30d",
  "all",
] as const;

export type ResetUsageHistoryPeriod = (typeof RESET_USAGE_HISTORY_PERIODS)[number];

type TimedResetUsageHistoryPeriod = Exclude<ResetUsageHistoryPeriod, "all">;

const RESET_USAGE_HISTORY_PERIOD_MS: Record<TimedResetUsageHistoryPeriod, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface ResetUsageHistoryResult extends CleanupResult {
  deletedUsageHistory: number;
  deletedDailySummary: number;
  deletedDailyTeamSummary: number;
  /** Always 0: `hourly_usage_summary` no longer exists. */
  deletedHourlySummary: number;
  deletedCallLogs: number;
  deletedCallLogArtifacts: number;
  /** Always 0: `request_detail_logs` no longer exists. */
  deletedRequestDetailLogs: number;
  deletedProxyLogs: number;
  deletedRelayLogs: number;
  deletedCompressionAnalytics: number;
  deletedCompressionEngineBreakdown: number;
  deletedCompressionRunTelemetry: number;
  /** Always 0: `routing_decisions` no longer exists. */
  deletedRoutingDecisions: number;
  deletedQuotaConsumption: number;
  deletedConversationTurnNodes: number;
  deletedAgenticConversations: number;
}

function isResetUsageHistoryPeriod(period: string): period is ResetUsageHistoryPeriod {
  return (RESET_USAGE_HISTORY_PERIODS as readonly string[]).includes(period);
}

/**
 * On-demand, period-scoped reset of usage analytics data (`usage_history`,
 * `daily_usage_summary`).
 *
 * Unlike {@link cleanupUsageHistory} (retention-based background cleanup,
 * which rolls up rows into `daily_usage_summary` before deleting them), this
 * is a destructive user-triggered reset — it intentionally does NOT roll up
 * first, since the whole point is to wipe the data the user selected.
 *
 * @param period - One of {@link RESET_USAGE_HISTORY_PERIODS}. `"all"` wipes
 *   every reset target, including conversation identity metadata; any other
 *   value deletes only time-scoped usage/log rows older than `now - period`.
 *   Throws on an invalid period.
 */
const RESET_TARGETS: Array<
  DeleteByPeriodTarget & { resultKey: keyof ResetUsageHistoryResult; allOnly?: boolean }
> = [
  { table: "usage_history", column: "timestamp", cutoff: "iso", resultKey: "deletedUsageHistory" },
  {
    table: "daily_usage_summary",
    column: "date",
    cutoff: "date",
    resultKey: "deletedDailySummary",
  },
  {
    table: "daily_team_usage_summary",
    column: "date",
    cutoff: "date",
    resultKey: "deletedDailyTeamSummary",
  },
  { table: "call_logs", column: "timestamp", cutoff: "iso", resultKey: "deletedCallLogs" },
  { table: "proxy_logs", column: "timestamp", cutoff: "iso", resultKey: "deletedProxyLogs" },
  {
    table: "relay_logs",
    column: "created_at",
    cutoff: "iso",
    resultKey: "deletedRelayLogs",
  },
  {
    table: "compression_analytics",
    column: "timestamp",
    cutoff: "iso",
    resultKey: "deletedCompressionAnalytics",
  },
  {
    table: "compression_engine_breakdown",
    column: "timestamp",
    cutoff: "iso",
    resultKey: "deletedCompressionEngineBreakdown",
  },
  {
    table: "compression_run_telemetry",
    column: "timestamp",
    cutoff: "iso",
    resultKey: "deletedCompressionRunTelemetry",
  },
  {
    // quota_counters also holds the per-key tpm/rpm counters ('key-quota:*'): leave those.
    table: "quota_counters",
    column: "updated_at",
    cutoff: "iso",
    resultKey: "deletedQuotaConsumption",
    extraWhere: "dimension_key NOT LIKE 'key-quota:%'",
  },
  {
    table: "conversation_turn_nodes",
    column: "last_seen_at",
    cutoff: "iso",
    resultKey: "deletedConversationTurnNodes",
    allOnly: true,
  },
  {
    table: "agentic_conversations",
    column: "last_seen_at",
    cutoff: "iso",
    resultKey: "deletedAgenticConversations",
    allOnly: true,
  },
];

export async function resetUsageHistory(period: string): Promise<ResetUsageHistoryResult> {
  if (!isResetUsageHistoryPeriod(period)) {
    throw new Error(`Invalid reset period: ${period}`);
  }

  const result: ResetUsageHistoryResult = {
    deleted: 0,
    deletedUsageHistory: 0,
    deletedDailySummary: 0,
    deletedDailyTeamSummary: 0,
    deletedHourlySummary: 0,
    deletedCallLogs: 0,
    deletedCallLogArtifacts: 0,
    deletedRequestDetailLogs: 0,
    deletedProxyLogs: 0,
    deletedRelayLogs: 0,
    deletedCompressionAnalytics: 0,
    deletedCompressionEngineBreakdown: 0,
    deletedCompressionRunTelemetry: 0,
    deletedRoutingDecisions: 0,
    deletedQuotaConsumption: 0,
    deletedConversationTurnNodes: 0,
    deletedAgenticConversations: 0,
    deletedArtifacts: 0,
    errors: 0,
  };

  try {
    let artifactsToDelete: string[] = [];

    await db().transaction(async (tx) => {
      if (period === "all") {
        // Children before parents: turn nodes reference their conversation.
        for (const target of RESET_TARGETS) {
          (result[target.resultKey] as number) = await deleteAllFromTable(
            target.table,
            target.extraWhere,
            tx
          );
        }
        return;
      }

      const cutoffIso = new Date(Date.now() - RESET_USAGE_HISTORY_PERIOD_MS[period]).toISOString();
      artifactsToDelete = await collectCallLogArtifactsBefore(cutoffIso, tx);
      for (const target of RESET_TARGETS) {
        if (target.allOnly) continue;
        (result[target.resultKey] as number) = await deleteFromTableBefore(target, cutoffIso, tx);
      }
    });

    let artifactResult: { deletedArtifacts: number; errors: number };
    if (period === "all") {
      artifactResult = purgeCallLogArtifactDirectory();
    } else {
      artifactResult = deleteCallLogArtifacts(artifactsToDelete);
    }
    result.deletedCallLogArtifacts = artifactResult.deletedArtifacts;
    result.deletedArtifacts = artifactResult.deletedArtifacts;
    result.errors += artifactResult.errors;

    result.deleted = RESET_TARGETS.reduce((sum, t) => sum + (result[t.resultKey] as number), 0);

    console.log(
      `[Cleanup] Reset usage/log data (period=${period}): ${result.deleted} row(s), ` +
        `${result.deletedCallLogArtifacts} call log artifact(s)`
    );
  } catch (err: unknown) {
    console.error("[Cleanup] Error resetting usage history:", err);
    result.errors++;
  }

  return result;
}

/**
 * Clean up old proxy_logs based on retention settings: whole UTC days are dropped.
 * Uses the same retention period as call_logs (30 days default).
 */
export async function cleanupProxyLogs(): Promise<CleanupResult> {
  const retention = await getRetentionSettings();
  const retentionDays = retention.callLogs;

  const result: CleanupResult = { deleted: 0, errors: 0 };

  try {
    const dropped = await dropLogPartitionsBefore("proxy_logs", cutoffFor(retentionDays));
    result.deleted = dropped.deletedRows;

    console.log(`[Cleanup] Deleted ${result.deleted} proxy_logs older than ${retentionDays} days`);
  } catch (err: unknown) {
    console.error("[Cleanup] Error cleaning proxy_logs:", err);
    result.errors++;
  }

  return result;
}

// ──────────────── Background Cleanup Scheduler ────────────────

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _cleanupSchedulerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * One scheduled pass: make sure the day partitions of the log tables exist ahead of
 * time, then run the retention cleanup (`runAutoCleanup` already covers proxy_logs).
 * Exported so tests can drive the exact code path the timers run.
 */
export async function runScheduledCleanupPass(phase: "startup" | "periodic"): Promise<void> {
  const label = phase === "startup" ? "Startup" : "Periodic";

  try {
    await ensureLogPartitions();
  } catch (err) {
    console.error(`[Cleanup] Could not create log partitions during ${phase} cleanup:`, err);
  }

  const result = await runAutoCleanup();
  if (result.totalDeleted > 0) {
    console.log(`[Cleanup] ${label} cleanup freed ${result.totalDeleted} rows.`);
  }

  try {
    await warnOnDefaultPartitionRows();
  } catch {
    /* best effort */
  }
}
/**
 * Start the background cleanup scheduler. Runs cleanup on startup and then
 * every 6 hours.
 *
 * Without the cleanup itself, tables grow unboundedly (compression_analytics
 * 600K+ rows, usage_history 250K+ rows).
 */
export function startCleanupScheduler(): void {
  if (_cleanupSchedulerTimer) return;

  // Run cleanup 30s after startup (let the server initialize first).
  setTimeout(async () => {
    try {
      await runScheduledCleanupPass("startup");
    } catch (err) {
      console.error("[Cleanup] Startup cleanup failed:", err);
    }
  }, 30_000);

  // Schedule periodic cleanup every 6 hours.
  _cleanupSchedulerTimer = setInterval(async () => {
    try {
      await runScheduledCleanupPass("periodic");
    } catch (err) {
      console.error("[Cleanup] Periodic cleanup failed:", err);
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't keep the process alive solely for cleanup.
  if (_cleanupSchedulerTimer && typeof _cleanupSchedulerTimer.unref === "function") {
    _cleanupSchedulerTimer.unref();
  }

  console.log("[Cleanup] Background cleanup scheduler started (every 6 hours).");
}

/**
 * Stop the background cleanup scheduler (for tests).
 */
export function stopCleanupScheduler(): void {
  if (_cleanupSchedulerTimer) {
    clearInterval(_cleanupSchedulerTimer);
    _cleanupSchedulerTimer = null;
  }
}
