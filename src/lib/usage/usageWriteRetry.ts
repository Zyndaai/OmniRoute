/**
 * Deferred retry for usage writes that meet a transient database conflict.
 *
 * The hot-path writers here are best-effort. When a write meets a retryable
 * conflict (deadlock, serialization failure, lock timeout, statement timeout),
 * the first failure is swallowed silently and the entry is attempted once more
 * after a short delay, off the request path (`setTimeout`, never awaited). If
 * the second attempt fails the existing log line is written and the row is
 * dropped. Any other error keeps the current behaviour: logged at once,
 * never retried. If the server stops during the wait the row is lost as
 * before, on a best-effort basis (the timer never keeps the loop alive).
 *
 * @module lib/usage/usageWriteRetry
 */

import { db, ts, type DbExecutor } from "@/lib/db/pg";
import { resolveBillingTeamIdForApiKeyAt } from "../db/teams";
import { resolveProviderId } from "@/shared/constants/providers";
import {
  resolveOrphanedUsageAccountIdentity,
  resolveUsageAccountIdentity,
} from "./accountIdentity";
import { normalizeServiceTier } from "./usageHistory/helpers";
import { readReportedCost } from "./creditMeteredProviders";
import { emitUsageRecorded } from "./usageEvents";
import {
  getLoggedInputTokens,
  getLoggedOutputTokens,
  getPromptCacheCreationTokens,
  getPromptCacheReadTokens,
  getReasoningTokens,
} from "./tokenAccounting";
import { backfillDuplicateUsageEntry } from "./usageHistory/duplicateEntry";
import type { UsageEntry } from "./usageHistory";

/** Delay before the single deferred attempt. Internal, not user-facing. */
const RETRY_DELAY_MS = 1000;

/** SQLSTATEs that are expected to clear within the retry delay. */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014"]);

/**
 * True when the error is a transient database conflict worth one deferred retry:
 * a `DbBackendError` of kind "retryable", or the raw SQLSTATE of a serialization
 * failure (40001), deadlock (40P01), lock timeout (55P03) or statement timeout (57014).
 * The name is kept from the SQLite era so existing callers need no change.
 */
export function isWriteLockError(error: unknown): boolean {
  const details = error as { code?: unknown; kind?: unknown } | null;
  if (details?.kind === "retryable") return true;
  return typeof details?.code === "string" && RETRYABLE_SQLSTATES.has(details.code);
}

/** Legacy natural-key dedup stays on unless the caller owns a physical attempt. */
type UsageWriteOptions = {
  deduplicate?: boolean;
};

/**
 * Single write attempt. Throws on failure so the caller decides between a
 * deferred retry (lock) and an immediate log (anything else).
 *
 * `deduplicate: false` is the image-attempt opt-out: two real upstream calls
 * can share every natural-key field, including the millisecond timestamp.
 */
export async function attemptWrite(
  entry: UsageEntry,
  options: UsageWriteOptions = {}
): Promise<void> {
  const prepared = await prepareEntry(entry);
  let inserted = false;
  const deduplicate = options.deduplicate !== false;

  await db().transaction(async (tx) => {
    if (!deduplicate) {
      await insertEntry(tx, prepared);
      inserted = true;
      return;
    }
    inserted = await insertUnlessDuplicate(tx, prepared);
  });

  // Decoupled via the event bus so usageHistory never imports providerLimits
  // (which would pull the executors/translator graph into the type-check surface).
  // Only emit when a row was actually inserted — not on dedup no-ops.
  if (inserted) {
    emitUsageRecorded(entry.provider, entry.connectionId);
  }
}

type PreparedEntry = {
  entry: UsageEntry;
  timestamp: string;
  serviceTier: string;
  billingTeamId: string | null;
  tokensInput: number;
  tokensOutput: number;
  accountIdentity: {
    accountKey: string | null;
    accountLabel: string | null;
    accountLabelPriority: number;
  };
};

async function prepareEntry(entry: UsageEntry): Promise<PreparedEntry> {
  // Normalised once: it is the partition key and the dedup key, and an unparseable
  // value would otherwise reach the insert as NULL.
  const timestamp = ts(entry.timestamp) ?? new Date().toISOString();
  const connection = entry.connectionId
    ? await db().queryOne<Record<string, unknown>>(
        "SELECT * FROM provider_connections WHERE id = $1",
        [entry.connectionId]
      )
    : undefined;
  return {
    entry,
    timestamp,
    serviceTier: normalizeServiceTier(entry.serviceTier ?? entry.service_tier),
    // Ordinary terminal writes always resolve ownership from effective history.
    // Historical snapshot restoration belongs to the authenticated JSON importer.
    billingTeamId: await resolveBillingTeamIdForApiKeyAt(entry.apiKeyId, timestamp),
    // Integer columns: round once here so the dedup lookup compares what is stored.
    tokensInput: Math.round(Number(getLoggedInputTokens(entry.tokens)) || 0),
    tokensOutput: Math.round(Number(getLoggedOutputTokens(entry.tokens)) || 0),
    accountIdentity: connection
      ? resolveUsageAccountIdentity(connection)
      : resolveOrphanedUsageAccountIdentity(entry.provider, entry.connectionId),
  };
}

// Dedup guard: skip INSERT when an identical row already exists in the same
// second. This prevents double-counting when onRequestSuccess fires more
// than once (e.g. combo routing calling the callback from both the
// streaming and non-streaming paths for the same underlying request).
// Keyed on the natural identity of a request: timestamp + provider + model
// + connectionId + apiKeyId + token counts. If only the endpoint is missing
// on the existing row, fill it in rather than inserting a duplicate.
async function insertUnlessDuplicate(tx: DbExecutor, prepared: PreparedEntry): Promise<boolean> {
  const { entry, timestamp, tokensInput, tokensOutput } = prepared;
  // SQLite's single writer made look-then-insert atomic; two concurrent callbacks for
  // one request would now both miss the lookup. Serialize them per natural key.
  const lockKey = [
    timestamp,
    entry.provider ?? "",
    entry.model ?? "",
    entry.connectionId ?? "",
    entry.apiKeyId ?? "",
    tokensInput,
    tokensOutput,
  ].join("|");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
  if (await backfillDuplicateUsageEntry(tx, entry, timestamp, tokensInput, tokensOutput)) {
    return false;
  }

  await insertEntry(tx, prepared);
  return true;
}

async function insertEntry(tx: DbExecutor, prepared: PreparedEntry): Promise<void> {
  const {
    entry,
    timestamp,
    serviceTier,
    billingTeamId,
    tokensInput,
    tokensOutput,
    accountIdentity,
  } = prepared;
  const { providerCredits, providerCostUsd } = readReportedCost(entry.provider, entry.tokens);
  // Integer columns reject fractional values (token counts after a ratio, latencies).
  const int = (value: unknown): number => Math.round(toFinite(value));
  await tx.execute(
    `
    INSERT INTO usage_history (provider, model, connection_id, account_key, account_label,
      account_label_priority, api_key_id, api_key_name, billing_team_id,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
      service_tier, status, success, latency_ms, ttft_ms, error_code, combo_strategy, endpoint,
      cpa_auth_index, "timestamp", provider_credits, provider_cost_usd)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
      $20, $21, $22, $23, $24, $25, $26)
  `,
    [
      entry.provider ? resolveProviderId(entry.provider) : null,
      entry.model || null,
      entry.connectionId || null,
      accountIdentity.accountKey,
      accountIdentity.accountLabel,
      int(accountIdentity.accountLabelPriority),
      entry.apiKeyId || null,
      entry.apiKeyName || null,
      billingTeamId,
      int(tokensInput),
      int(tokensOutput),
      int(getPromptCacheReadTokens(entry.tokens)),
      int(getPromptCacheCreationTokens(entry.tokens)),
      int(getReasoningTokens(entry.tokens)),
      serviceTier,
      entry.status || null,
      entry.success !== false,
      int(entry.latencyMs),
      Math.round(toFirstToken(entry)),
      entry.errorCode || null,
      entry.comboStrategy || entry.combo_strategy || null,
      entry.endpoint || null,
      entry.cpaAuthIndex || null,
      timestamp,
      providerCredits ?? null,
      providerCostUsd ?? null,
    ]
  );
}

function toFinite(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function toFirstToken(entry: UsageEntry): number {
  if (Number.isFinite(Number(entry.timeToFirstTokenMs))) return Number(entry.timeToFirstTokenMs);
  return toFinite(entry.latencyMs);
}

/**
 * Schedule the single deferred retry, off the request path. Never chained:
 * the retry attempts the write once and, on failure, writes the existing log
 * line and stops.
 */
export function scheduleWriteRetry(
  task: () => void | Promise<void>,
  onFinalFailure: (error: unknown) => void
): Promise<void>;
export function scheduleWriteRetry(entry: UsageEntry, options?: UsageWriteOptions): void;
export function scheduleWriteRetry(
  taskOrEntry: (() => void | Promise<void>) | UsageEntry,
  optionsOrFailure?: UsageWriteOptions | ((error: unknown) => void)
): Promise<void> | void {
  if (typeof taskOrEntry !== "function") {
    const entry = taskOrEntry;
    void scheduleWriteRetry(
      () => attemptWrite(entry, typeof optionsOrFailure === "object" ? optionsOrFailure : {}),
      (retryError) => console.error("Failed to save usage stats:", retryError)
    );
    return;
  }
  const task = taskOrEntry;
  const fail = typeof optionsOrFailure === "function" ? optionsOrFailure : () => {};
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await task();
        } catch (retryError) {
          fail(retryError);
        } finally {
          resolve();
        }
      })();
    }, RETRY_DELAY_MS);
    // Allow Node.js to exit naturally even if the timer is still pending
    // (avoids keeping the event loop alive for a stray retry).
    detachTimer(timer);
  });
}

type DetachableTimer = { unref?: () => void };

function detachTimer(timer: DetachableTimer): void {
  timer.unref?.();
}
