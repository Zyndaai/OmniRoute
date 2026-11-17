/**
 * Structured call log management.
 *
 * SQLite stores only summary metadata. Detailed request/response payloads live in
 * filesystem artifacts and are loaded only for explicit detail/export flows.
 */

import type { RequestPipelinePayloads } from "@omniroute/open-sse/utils/requestLogger.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/errorSanitization.ts";
import { db, ts } from "../db/pg";
import { jsonTextParam, stripNul } from "../db/pgJsonText";
import { isNextBuildPhase } from "../buildPhase";
import { failPendingCallLogDetail, publishPendingCallLogDetail } from "../db/callLogDetails";
import { applyNodePrefix, resolveProviderDisplay } from "./callLogDisplay";
export { applyNodePrefix, resolveProviderDisplay } from "./callLogDisplay";
import { dashboardDetailIo, resolveCallLogDetail } from "./callLogDetailResolver";
import { updateRequestTokensById } from "./usageHistory";
import { getCallLogApiKeyContext } from "./callLogApiKeyContext";
import { serializeResilienceActions, resetResilienceActions } from "./resilienceActionsContext";
import { parseResilienceActions } from "./resilienceActionsParse";
import {
  seedPendingContinuationState,
  clearPendingContinuationState,
  type ContinuationPipeline,
} from "../db/responsesContinuationStore";
import {
  getLoggedInputTokens,
  getLoggedOutputTokens,
  getPromptCacheReadTokensOrNull,
  getPromptCacheCreationTokensOrNull,
  getReasoningTokensOrNull,
  getObservedReasoning,
} from "./tokenAccounting";
import {
  hasRenderedContent,
  isNonTextRequest,
  resolveUsageProvenance,
} from "./callContentProvenance";
import { isNoLog } from "../compliance/noLog";
import {
  parseStoredPayload,
  protectErrorPayloadForLog,
  protectPayloadForLog,
} from "../logPayloads";
import { pickDisplayValue } from "@/shared/utils/maskEmail";
import {
  buildArtifactRelativePath,
  getCallLogsDir,
  type CallLogArtifact,
  type CallLogDetailState,
} from "./callLogArtifacts";
import { closeCallLogArtifactWriter, writeCallArtifactAsync } from "./callLogArtifactWriter";
import {
  toNumber,
  toStringOrNull,
  normalizeDetailState,
  sanitizeErrorForLog,
  toStoredErrorSummary,
  protectPipelinePayloads,
  buildRequestSummary,
  classifyCallLogError,
  toStoredErrorType,
} from "./callLogs/format";
import {
  clearArtifactReference,
  cleanupOrphanCallLogFiles,
  cleanupOverflowCallLogFiles,
  deleteCallLogsBefore,
  trimCallLogsToMaxRows,
  rotateCallLogs,
  scheduleCallLogRotation,
} from "./callLogRotation";

// Re-exported for existing importers (usageDb.ts, compliance/index.ts, purge-logs route,
// and the call-log rotation/cap test suite) — the implementation now lives in
// ./callLogRotation.ts (extracted to satisfy the file-size gate, #10125).
export {
  cleanupOrphanCallLogFiles,
  cleanupOverflowCallLogFiles,
  deleteCallLogsBefore,
  trimCallLogsToMaxRows,
  rotateCallLogs,
  scheduleCallLogRotation,
};

type JsonRecord = Record<string, unknown>;

// Persistence is always on; only the Next.js build phase has no database to write to.
const persistCallLogs = !isNextBuildPhase();

const pendingCallLogSaves = new Set<Promise<void>>();
let callLogSavesClosing = false;

type CallLogSummaryRow = {
  id: string;
  timestamp: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  model: string | null;
  requested_model: string | null;
  provider: string | null;
  account: string | null;
  connection_id: string | null;
  duration: number | null;
  ttft_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  tokens_reasoning: number | null;
  tokens_compressed: number | null;
  reasoning_source?: string | null;
  reasoning_chars?: number | null;
  cache_source: string | null;
  request_type: string | null;
  source_format: string | null;
  target_format: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  combo_name: string | null;
  combo_step_id: string | null;
  combo_execution_key: string | null;
  error_summary: string | null;
  detail_state: string | null;
  artifact_relpath: string | null;
  artifact_size_bytes: number | null;
  artifact_sha256: string | null;
  has_request_body: boolean | null;
  has_response_body: boolean | null;
  has_pipeline_details: boolean | null;
  /** jsonb: arrives parsed. */
  request_summary: unknown;
  provider_node_name?: string | null;
  provider_node_prefix?: string | null;
  resolved_account?: string | null;
  correlation_id?: string | null;
  model_pinned?: boolean | null;
  session_tag?: string | null;
  client_session_id?: string | null;
  /** jsonb: arrives parsed. */
  resilience_actions?: unknown;
  has_content?: boolean | null;
  usage_provenance?: string | null;
};

export const RESOLVED_ACCOUNT_SQL =
  "COALESCE(NULLIF(pc.name, ''), NULLIF(pc.email, ''), cl.account)";

type DeleteResult = {
  deletedRows: number;
  deletedArtifacts: number;
};

const CALL_LOG_ID_RETRY_LIMIT = 3;

function generateLogId() {
  return globalThis.crypto.randomUUID();
}

// The PK is (id, "timestamp"): only a reused id with the same timestamp conflicts, and
// SQLSTATE 23505 on insert is the collision signal (no pre-check query).
function isCallLogIdCollision(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, kind } = error as { code?: unknown; kind?: unknown };
  return code === "23505" || kind === "unique_violation";
}

/** jsonb columns arrive parsed; the row mappers below still read JSON text. */
function jsonColumnToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

// TTFT is only meaningful when measured and non-negative; normalize anything
// else (undefined/NaN/negative) to the column's "not tracked" state.
function toNullableTtftMs(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

async function resolveAccountName(connectionId: string | null | undefined) {
  let account = connectionId ? connectionId.slice(0, 8) : "-";

  if (!connectionId) {
    return account;
  }

  try {
    const { getProviderConnections } = await import("@/lib/db/providers");
    const connections = await getProviderConnections();
    const conn = connections.find((item) => item.id === connectionId);
    if (conn) {
      account = pickDisplayValue(
        [toStringOrNull(conn.name), toStringOrNull(conn.email)],
        true,
        account
      );
    }
  } catch {
    // Best-effort lookup only.
  }

  return account;
}

async function resolveProviderPrefix(providerId: string): Promise<string | null> {
  if (!providerId) return null;
  try {
    const { getProviderNodeById } = await import("@/lib/db/providers");
    const node = await getProviderNodeById(providerId);
    if (node && typeof node.prefix === "string" && node.prefix.trim().length > 0) {
      return node.prefix.trim();
    }
  } catch {
    // Best-effort lookup only.
  }
  return null;
}

function isCompatibleProviderId(providerId: string | null): boolean {
  if (!providerId) return false;
  return (
    providerId.startsWith("openai-compatible-") || providerId.startsWith("anthropic-compatible-")
  );
}

function buildArtifact(
  logEntry: {
    id: string;
    timestamp: string;
    method: string;
    path: string;
    status: number;
    model: string;
    requestedModel: string | null;
    provider: string;
    account: string;
    connectionId: string | null;
    duration: number;
    tokensIn: number;
    tokensOut: number;
    tokensCacheRead: number | null;
    tokensCacheCreation: number | null;
    tokensReasoning: number | null;
    tokensCompressed: number | null;
    requestType: string | null;
    sourceFormat: string | null;
    targetFormat: string | null;
    apiKeyId: string | null;
    apiKeyName: string | null;
    comboName: string | null;
    comboStepId: string | null;
    comboExecutionKey: string | null;
  },
  requestBody: unknown,
  responseBody: unknown,
  error: unknown,
  pipelinePayloads: RequestPipelinePayloads | null
): CallLogArtifact {
  return {
    schemaVersion: 5,
    summary: {
      id: logEntry.id,
      timestamp: logEntry.timestamp,
      method: logEntry.method,
      path: logEntry.path,
      status: logEntry.status,
      model: logEntry.model,
      requestedModel: logEntry.requestedModel,
      provider: logEntry.provider,
      account: logEntry.account,
      connectionId: logEntry.connectionId,
      duration: logEntry.duration,
      tokens: {
        in: logEntry.tokensIn,
        out: logEntry.tokensOut,
        cacheRead: logEntry.tokensCacheRead,
        cacheWrite: logEntry.tokensCacheCreation,
        reasoning: logEntry.tokensReasoning,
        compressed: logEntry.tokensCompressed,
      },
      requestType: logEntry.requestType,
      sourceFormat: logEntry.sourceFormat,
      targetFormat: logEntry.targetFormat,
      apiKeyId: logEntry.apiKeyId,
      apiKeyName: logEntry.apiKeyName,
      comboName: logEntry.comboName,
      comboStepId: logEntry.comboStepId,
      comboExecutionKey: logEntry.comboExecutionKey,
    },
    requestBody: requestBody ?? null,
    responseBody: responseBody ?? null,
    error: error ?? null,
    ...(pipelinePayloads ? { pipeline: pipelinePayloads } : {}),
  };
}

// #6187: extract the assistant message from a chat-completion-shaped response
// body so we can inspect its reasoning_content / <think> content.
function extractAssistantMessage(responseBody: unknown): unknown {
  if (!responseBody || typeof responseBody !== "object") return responseBody;
  const choices = (responseBody as JsonRecord).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as JsonRecord;
    return first?.message ?? first?.delta ?? first;
  }
  return responseBody;
}

// #6187: decide the reasoning SOURCE and (char-only) count recorded alongside
// the usage-derived tokens_reasoning. Usage is authoritative when it reports
// non-zero reasoning tokens; otherwise we fall back to observed reasoning
// content so "reasoned but metered 0" stays distinguishable. reasoning_chars is
// a CHARACTER count, never a token count — it must not touch cost math.
//
// Encrypted-reasoning observability: an opaque Responses `reasoning` item
// (`encrypted_content` / signature / format, no readable summary) overrides
// every other source with 'encrypted'. The sink-side scan covers non-streaming
// snapshots and batch-completed-without-added payloads; the streaming path
// threads the same signal via `entry.reasoningMeta` (flag + wall-clock delta).
// NEVER inspect or persist the opaque blob itself — presence only.
function snapshotHasOpaqueReasoningItem(body: unknown): boolean {
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body) ? (body as JsonRecord) : null;
  if (!record) return false;
  const outputs: unknown[] = [];
  if (Array.isArray(record.output)) outputs.push(...record.output);
  const nested =
    record.response !== null &&
    typeof record.response === "object" &&
    !Array.isArray(record.response)
      ? (record.response as JsonRecord)
      : null;
  if (nested && Array.isArray(nested.output)) outputs.push(...nested.output);
  return outputs.some((item) => {
    const itemRecord =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as JsonRecord)
        : null;
    if (!itemRecord || itemRecord.type !== "reasoning") return false;
    return (
      (typeof itemRecord.encrypted_content === "string" &&
        itemRecord.encrypted_content.length > 0) ||
      itemRecord.signature !== undefined ||
      itemRecord.format !== undefined
    );
  });
}

function resolveReasoningObservation(
  usageReasoning: number | null,
  responseBody: unknown,
  streamMeta?: { encryptedSeen?: boolean } | null
): { source: string | null; chars: number | null } {
  if (streamMeta?.encryptedSeen === true || snapshotHasOpaqueReasoningItem(responseBody)) {
    return { source: "encrypted", chars: null };
  }
  if (usageReasoning != null && usageReasoning > 0) {
    return { source: "usage", chars: null };
  }
  const observed = getObservedReasoning(extractAssistantMessage(responseBody));
  if (observed.chars > 0) {
    return { source: observed.source, chars: observed.chars };
  }
  return { source: null, chars: null };
}

export { parseResilienceActions };

function mapSummaryRow(row: CallLogSummaryRow) {
  const detailState = normalizeDetailState(row.detail_state);
  // The path is stored at insert, before the artifact exists: it only means "has an
  // artifact" once the detail is published (detail_state = 'ready').
  const artifactRelPath = detailState === "ready" ? row.artifact_relpath : null;
  const requestSummaryText = jsonColumnToText(row.request_summary);
  const provider = row.provider;
  const nodeName = row.provider_node_name ?? null;
  const nodePrefix = row.provider_node_prefix ?? null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    method: row.method,
    path: row.path,
    status: toNumber(row.status),
    model: row.model,
    requestedModel: applyNodePrefix(row.requested_model, provider, nodePrefix),
    provider,
    providerDisplay: resolveProviderDisplay(provider, nodeName, nodePrefix),
    account: row.resolved_account || row.account,
    connectionId: row.connection_id,
    duration: toNumber(row.duration),
    ttft: row.ttft_ms != null ? toNumber(row.ttft_ms) : null,
    tokens: {
      in: toNumber(row.tokens_in),
      out: toNumber(row.tokens_out),
      cacheRead: row.tokens_cache_read != null ? toNumber(row.tokens_cache_read) : null,
      cacheWrite: row.tokens_cache_creation != null ? toNumber(row.tokens_cache_creation) : null,
      reasoning: row.tokens_reasoning != null ? toNumber(row.tokens_reasoning) : null,
      compressed: row.tokens_compressed != null ? toNumber(row.tokens_compressed) : null,
    },
    cacheSource: row.cache_source || "upstream",
    // #6187/#13965: observed reasoning (source + CHARACTER count, never tokens) so the
    // detail view can tell "reasoned but not metered" apart from "did not reason".
    reasoningSource: row.reasoning_source ?? null,
    reasoningChars: row.reasoning_chars != null ? toNumber(row.reasoning_chars) : null,
    // Tri-state; consumers (CallContentProvenanceBadges) compare it to 0/1.
    hasContent: row.has_content === null || row.has_content === undefined ? null : row.has_content ? 1 : 0,
    usageProvenance: row.usage_provenance ?? null,
    requestType: row.request_type,
    sourceFormat: row.source_format,
    targetFormat: row.target_format,
    apiKeyId: row.api_key_id,
    apiKeyName: row.api_key_name,
    comboName: row.combo_name,
    comboStepId: row.combo_step_id,
    comboExecutionKey: row.combo_execution_key,
    error: row.error_summary,
    detailState,
    artifactRelPath,
    artifactSizeBytes: row.artifact_size_bytes,
    artifactSha256: row.artifact_sha256,
    requestSummary: requestSummaryText ? parseStoredPayload(requestSummaryText) : null,
    hasRequestBody: row.has_request_body === true,
    hasResponseBody: row.has_response_body === true,
    hasPipelineDetails: row.has_pipeline_details === true,
    correlationId: row.correlation_id || null,
    modelPinned: row.model_pinned === true,
    sessionTag: row.session_tag || null,
    clientSessionId: row.client_session_id || null,
    resilienceActions: parseResilienceActions(jsonColumnToText(row.resilience_actions)),
  };
}

async function saveCallLogOperation(entry: any): Promise<void> {
  let prepared: PreparedCallLogRow;
  try {
    prepared = await buildCallLogRow(entry);
  } catch (error) {
    logCallLogSaveFailure(error);
    return;
  }
  try {
    await insertCallLogRow(prepared);
  } catch (error) {
    logCallLogSaveFailure(error);
    return;
  }
  try {
    await publishCallLogDetail(prepared);
  } catch (error) {
    logCallLogSaveFailure(error);
  }
}

type PreparedCallLogRow = {
  logEntry: Record<string, unknown>;
  insertParams: Record<string, unknown>;
  detailState: CallLogDetailState;
  responseId: string | null;
  /** Builds the artifact from the row's FINAL id; null when no detail is expected. */
  buildDetailArtifact: (() => ReturnType<typeof buildArtifact>) | null;
};

function logCallLogSaveFailure(error: unknown): void {
  console.error(
    "[callLogs] Failed to save call log:",
    sanitizeErrorMessage(error) || "Call log persistence failed"
  );
}

async function buildCallLogRow(entry: any): Promise<PreparedCallLogRow> {
  const apiKeyContext = getCallLogApiKeyContext();
  // `||` (not `??`): an empty-string apiKeyId/apiKeyName is "unattributed",
  // same as before this fallback existed — it must not be persisted verbatim
  // nor block the request-scoped context.
  const apiKeyId = entry.apiKeyId || apiKeyContext?.apiKeyId || null;
  const apiKeyName = entry.apiKeyName || apiKeyContext?.apiKeyName || null;
  const connectionId = entry.connectionId || apiKeyContext?.connectionId || null;
  // resilience resilience summary for this attempt (implicit ALS store opened
  // around the attempt; null outside a store or when nothing was noted).
  // Read BEFORE any await: the ALS context is synchronous and later awaits
  // (isNoLog, resolveAccountName, artifact write) may cross async boundaries.
  const resilienceActions = serializeResilienceActions();
  // isNoLog answers from an in-process set/30s cache; only a cache miss reaches the database.
  const noLogEnabled = Boolean(entry.noLog) || (apiKeyId ? await isNoLog(apiKeyId) : false);

  const protectedRequestBody = noLogEnabled ? null : protectPayloadForLog(entry.requestBody);
  const responseStatus = Number(entry.status);
  const failedResponse = Number.isFinite(responseStatus) && responseStatus >= 400;
  const protectedResponseBody = noLogEnabled
    ? null
    : failedResponse
      ? protectErrorPayloadForLog(entry.responseBody)
      : protectPayloadForLog(entry.responseBody);
  const protectedPipelinePayloads = noLogEnabled
    ? null
    : protectPipelinePayloads(
        entry.pipelinePayloads ?? entry.pipeline ?? null,
        failedResponse ? responseStatus : undefined
      );
  const protectedError = sanitizeErrorForLog(entry.error);

  // Bridges the window before this row's own artifact write (queued below,
  // async) lands with detail_state = 'ready': a client that fires its next
  // turn immediately -- normal in a tight tool-calling loop -- can reach
  // resolvePreviousResponseState before that write exists at all. Seeded
  // synchronously, before any await, from the same protected pipeline
  // payload the artifact will eventually hold (and the same
  // videoContentRemoved/fail-closed rules), so it is available the instant
  // this function is called. See responsesContinuationStore.ts.
  if (typeof entry.responseId === "string" && entry.responseId.length > 0) {
    seedPendingContinuationState(
      entry.responseId,
      apiKeyId,
      // The store's own contract, not a looser restatement of it: the inline shape
      // widened both fields to `unknown`, which does not assign to
      // ContinuationPipeline's typed members (TS2345 under typecheck:core).
      protectedPipelinePayloads as ContinuationPipeline | null,
      Boolean(entry.videoContentRemoved)
    );
  }

  const account = await resolveAccountName(connectionId);
  const rawProvider: string = entry.provider || "-";
  const rawRequestedModel: string | null = entry.requestedModel || null;
  let resolvedRequestedModel = rawRequestedModel;
  if (rawRequestedModel && isCompatibleProviderId(rawProvider)) {
    const nodePrefix = await resolveProviderPrefix(rawProvider);
    resolvedRequestedModel = applyNodePrefix(rawRequestedModel, rawProvider, nodePrefix);
  }
  // #6187: usage-derived reasoning tokens stay UNCHANGED (cost math reads this),
  // while reasoning source/char-count are recorded separately for observability.
  const tokensReasoning = getReasoningTokensOrNull(entry.tokens);
  const streamReasoningMeta =
    entry.reasoningMeta !== null && typeof entry.reasoningMeta === "object"
      ? (entry.reasoningMeta as { encryptedSeen?: boolean; durationMs?: unknown })
      : null;
  const reasoningObservation = resolveReasoningObservation(
    tokensReasoning,
    entry.responseBody,
    streamReasoningMeta
  );
  // Encrypted-reasoning observability (nullable, additive): stream-side
  // flag+duration win when present; the sink scan above already forced
  // source='encrypted' for opaque snapshots (duration NULL there).
  const streamDurationRaw = streamReasoningMeta?.durationMs;
  const streamDurationMs =
    typeof streamDurationRaw === "number" &&
    Number.isFinite(streamDurationRaw) &&
    streamDurationRaw >= 0 &&
    streamDurationRaw <= 86_400_000
      ? Math.round(streamDurationRaw)
      : null;
  const reasoningEncrypted =
    streamReasoningMeta?.encryptedSeen === true || reasoningObservation.source === "encrypted"
      ? 1
      : null;
  const reasoningDurationMs = reasoningObservation.source === "encrypted" ? streamDurationMs : null;
  const readEffortValue = (body: unknown): string | null => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const direct = record.reasoning_effort;
    if (typeof direct === "string" && direct.trim().length > 0) return direct;
    const nested = record.reasoning;
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const effort = (nested as Record<string, unknown>).effort;
      if (typeof effort === "string" && effort.trim().length > 0) return effort;
    }
    return null;
  };
  const reasoningEffortRequested =
    reasoningObservation.source === "encrypted"
      ? readEffortValue(entry.clientRequestBody ?? entry.requestBody)
      : null;
  const reasoningEffortUpstream =
    reasoningObservation.source === "encrypted" ? readEffortValue(entry.upstreamRequestBody) : null;
  const errorType = toStoredErrorType(
    classifyCallLogError(entry.status, entry.error, entry.provider)
  );
  // Rendered-content presence plus usage provenance: success-only, additive,
  // nullable. A 2xx is a success even with token counts at zero, so the
  // success bound is 200-299 (not <400).
  const numericStatus = Number(entry.status);
  const isSuccess = Number.isFinite(numericStatus) && numericStatus >= 200 && numericStatus < 300;
  const clientVisibleBody =
    entry.clientResponse ??
    (entry.pipelinePayloads as { clientResponse?: unknown } | null | undefined)?.clientResponse ??
    (entry.pipeline as { clientResponse?: unknown } | null | undefined)?.clientResponse ??
    entry.responseBody;
  const measurableContent =
    isSuccess && !noLogEnabled && !isNonTextRequest(entry.requestType, entry.path ?? entry.method);
  const renderedContent = measurableContent ? hasRenderedContent(clientVisibleBody) : null;
  const hasContent = renderedContent === null ? null : renderedContent ? 1 : 0;
  const usageProvenance = resolveUsageProvenance({
    usageEstimated: entry.usageEstimated === true,
    tokens: entry.tokens,
    isSuccess,
  });
  const logEntry = {
    id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : generateLogId(),
    // Normalised so the row key and the artifact path (derived from it) always agree.
    timestamp:
      (typeof entry.timestamp === "string" ? ts(entry.timestamp) : null) ??
      new Date().toISOString(),
    method: entry.method || "POST",
    path: entry.path || "/v1/chat/completions",
    status: entry.status || 0,
    errorType,
    model: entry.model || "-",
    requestedModel: resolvedRequestedModel,
    provider: rawProvider,
    account,
    connectionId,
    duration: entry.duration || 0,
    // #13130: TTFT (ms to first forwarded stream chunk) when the streaming
    // pipeline measured it; null for non-streaming rows. The dashboard TPS
    // divides by duration - ttft so queueing/prefill wait does not drag the
    // reported generation rate down.
    ttftMs: toNullableTtftMs(entry.ttftMs ?? entry.ttft),
    tokensIn: toNumber(getLoggedInputTokens(entry.tokens)),
    tokensOut: toNumber(getLoggedOutputTokens(entry.tokens)),
    tokensCacheRead: getPromptCacheReadTokensOrNull(entry.tokens),
    tokensCacheCreation: getPromptCacheCreationTokensOrNull(entry.tokens),
    tokensReasoning,
    reasoningSource: reasoningObservation.source,
    reasoningChars: reasoningObservation.chars,
    reasoningDurationMs,
    reasoningEffortRequested,
    reasoningEffortUpstream,
    reasoningEncrypted,
    tokensCompressed: entry.tokensCompressed != null ? toNumber(entry.tokensCompressed) : null,
    cacheSource: entry.cacheSource === "semantic" ? "semantic" : "upstream",
    requestType: entry.requestType || null,
    sourceFormat: entry.sourceFormat || null,
    targetFormat: entry.targetFormat || null,
    apiKeyId,
    apiKeyName,
    comboName: entry.comboName || null,
    comboStepId: toStringOrNull(entry.comboStepId),
    comboExecutionKey: toStringOrNull(entry.comboExecutionKey) || toStringOrNull(entry.comboStepId),
    correlationId: entry.correlationId || null,
    // Ms of pacing/park wait imposed before dispatch (null = none).
    addedWaitMs:
      typeof entry.addedWaitMs === "number" && Number.isFinite(entry.addedWaitMs)
        ? entry.addedWaitMs
        : null,
    addedWaitCause: toStringOrNull(entry.addedWaitCause),
    modelPinned: entry.modelPinned ? 1 : 0,
    sessionTag: entry.sessionTag || null,
    // The client's own session id (call_logs.client_session_id, migration 214); NULL for
    // writers that have no client request to read it from.
    clientSessionId: toStringOrNull(entry.clientSessionId)?.slice(0, 128) || null,
    // OpenAI Responses API response id, when this attempt produced one --
    // indexed so a later request's `previous_response_id` can resolve
    // this row's artifact for OmniRoute-native continuation. See
    // src/lib/db/responsesContinuationStore.ts.
    responseId: typeof entry.responseId === "string" ? entry.responseId : null,
    // Second redaction surface for #12150: 1 when this request's persisted client snapshot had
    // its video transcript cues structurally redacted, so
    // resolvePreviousResponseState refuses to rehydrate it as continuation
    // history. See src/lib/db/responsesContinuationStore.ts.
    videoContentRemoved: entry.videoContentRemoved ? 1 : 0,
    hasContent,
    usageProvenance,
  };

  const requestSummary = noLogEnabled
    ? null
    : buildRequestSummary(logEntry.requestType, protectedRequestBody);
  const detailExpected =
    !noLogEnabled &&
    (protectedRequestBody !== null ||
      protectedResponseBody !== null ||
      protectedError !== null ||
      protectedPipelinePayloads !== null);

  // The row is inserted BEFORE its artifact is written: the artifact path is
  // derived from (timestamp, id), so the id must be final — i.e. accepted by
  // the UNIQUE primary key — before any file is published. Writing first and
  // regenerating the id afterwards let a repeated explicit id + timestamp
  // overwrite an earlier row's artifact. Pending is a durable export barrier;
  // a failed or abandoned write becomes terminal missing instead.
  const detailState: CallLogDetailState = detailExpected ? "pending" : "none";
  const detailPendingUntil = detailExpected ? Date.now() + 5 * 60_000 : null;

  const insertParams = {
    ...logEntry,
    errorSummary: toStoredErrorSummary(protectedError),
    detailState,
    detailPendingUntil,
    artifactRelPath: null,
    artifactSizeBytes: null,
    artifactSha256: null,
    hasRequestBody: protectedRequestBody !== null ? 1 : 0,
    hasResponseBody: protectedResponseBody !== null ? 1 : 0,
    resilienceActions,
    hasPipelineDetails: protectedPipelinePayloads ? 1 : 0,
    requestSummary,
  };
  return {
    logEntry,
    insertParams,
    detailState,
    responseId: typeof logEntry.responseId === "string" ? logEntry.responseId : null,
    buildDetailArtifact: detailExpected
      ? () =>
          buildArtifact(
            logEntry,
            protectedRequestBody,
            protectedResponseBody,
            protectedError,
            protectedPipelinePayloads
          )
      : null,
  };
}

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
const flag = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : value === 1 || value === true;

const CALL_LOG_INSERT_SQL = `
      INSERT INTO call_logs (
        id, "timestamp", method, path, status, model, requested_model, provider,
        account, connection_id, duration, ttft_ms, tokens_in, tokens_out,
        tokens_cache_read, tokens_cache_creation, tokens_reasoning, tokens_compressed,
        reasoning_source, reasoning_chars,
        reasoning_duration_ms, reasoning_effort_requested, reasoning_effort_upstream,
        reasoning_encrypted,
        cache_source, request_type, source_format, target_format, api_key_id, api_key_name,
        combo_name, combo_step_id, combo_execution_key, error_summary, detail_state,
        detail_pending_until, artifact_relpath, artifact_size_bytes, artifact_sha256,
        has_request_body, has_response_body, has_pipeline_details, request_summary,
        correlation_id, model_pinned, session_tag, client_session_id, response_id, error_type,
        video_content_removed, has_content, usage_provenance,
        added_wait_ms, added_wait_cause, resilience_actions
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20,
        $21, $22, $23,
        $24,
        $25, $26, $27, $28, $29, $30,
        $31, $32, $33, $34, $35,
        $36, $37, $38, $39,
        $40, $41, $42, $43,
        $44, $45, $46, $47, $48, $49,
        $50, $51, $52,
        $53, $54, $55
      )
    `;

function callLogInsertValues(p: Record<string, unknown>): unknown[] {
  return [
    p.id,
    ts(p.timestamp as string),
    p.method,
    p.path,
    intOrNull(Number(p.status)) ?? 0,
    p.model,
    p.requestedModel,
    p.provider,
    p.account,
    p.connectionId,
    intOrNull(Number(p.duration)) ?? 0,
    intOrNull(p.ttftMs),
    intOrNull(p.tokensIn) ?? 0,
    intOrNull(p.tokensOut) ?? 0,
    intOrNull(p.tokensCacheRead),
    intOrNull(p.tokensCacheCreation),
    intOrNull(p.tokensReasoning),
    intOrNull(p.tokensCompressed),
    p.reasoningSource,
    intOrNull(p.reasoningChars),
    intOrNull(p.reasoningDurationMs),
    p.reasoningEffortRequested,
    p.reasoningEffortUpstream,
    flag(p.reasoningEncrypted),
    p.cacheSource,
    p.requestType,
    p.sourceFormat,
    p.targetFormat,
    p.apiKeyId,
    p.apiKeyName,
    p.comboName,
    p.comboStepId,
    p.comboExecutionKey,
    typeof p.errorSummary === "string" ? stripNul(p.errorSummary) : null,
    p.detailState,
    ts(p.detailPendingUntil as number | null),
    p.artifactRelPath,
    intOrNull(p.artifactSizeBytes),
    p.artifactSha256,
    flag(p.hasRequestBody) === true,
    flag(p.hasResponseBody) === true,
    flag(p.hasPipelineDetails) === true,
    jsonTextParam(p.requestSummary as string | null),
    p.correlationId,
    flag(p.modelPinned) === true,
    p.sessionTag,
    p.clientSessionId,
    p.responseId,
    p.errorType,
    flag(p.videoContentRemoved) === true,
    flag(p.hasContent),
    p.usageProvenance,
    intOrNull(p.addedWaitMs),
    p.addedWaitCause,
    jsonTextParam(p.resilienceActions as string | null),
  ];
}

async function insertCallLogRow(prepared: PreparedCallLogRow): Promise<void> {
  const { logEntry, insertParams } = prepared;
  // #14451: a 6-char dashboard traceId (or any reused explicit id) can collide.
  // Regenerate logEntry.id too, so the artifact summary and path use the final id.
  for (let attempt = 0; ; attempt++) {
    // The path is a pure function of (timestamp, id), so it is stored at insert and the
    // detail publish never has to touch it.
    insertParams.artifactRelPath = prepared.buildDetailArtifact
      ? buildArtifactRelativePath(String(insertParams.timestamp), String(insertParams.id))
      : null;
    try {
      await db().execute(CALL_LOG_INSERT_SQL, callLogInsertValues(insertParams));
      break;
    } catch (error) {
      if (!isCallLogIdCollision(error) || attempt >= CALL_LOG_ID_RETRY_LIMIT) throw error;
      insertParams.id = generateLogId();
      logEntry.id = insertParams.id;
    }
  }
  // sink note: the sink is the unique consumer — reset only after a successful
  // INSERT, so a failed write (or a second persistence of the same
  // attempt) keeps the summary instead of silently writing NULL.
  resetResilienceActions();
}

/** Write the inserted row's artifact and publish it, or make the row terminal missing. */
async function publishCallLogDetail(prepared: PreparedCallLogRow): Promise<void> {
  const { logEntry, buildDetailArtifact, responseId } = prepared;
  let detailState = prepared.detailState;
  if (buildDetailArtifact) {
    const id = String(logEntry.id);
    const rowTimestamp = String(logEntry.timestamp);
    try {
      const artifactResult = await writeCallArtifactAsync(buildDetailArtifact());
      if (
        artifactResult &&
        (await publishPendingCallLogDetail(db(), id, artifactResult, rowTimestamp))
      ) {
        detailState = "ready";
      }
    } finally {
      // A null result or a thrown write must not strand the export cursor.
      await failPendingCallLogDetail(db(), id, rowTimestamp);
    }
  }

  if (detailState === "ready" && typeof responseId === "string") {
    // The durable row is now authoritative; drop the bridge entry instead
    // of letting it idle until its TTL.
    clearPendingContinuationState(responseId);
  }

  scheduleCallLogRotation();
}

export function saveCallLog(entry: any): Promise<void> {
  // Usage is also needed by the live dashboard when disk history is disabled.
  // Retain only counters, never the request/response bodies from this entry.
  if (entry?.tokens && typeof entry.tokens === "object") {
    updateRequestTokensById(entry.pendingRequestId ?? entry.id, {
      in: getLoggedInputTokens(entry.tokens),
      out: getLoggedOutputTokens(entry.tokens),
      cacheRead: getPromptCacheReadTokensOrNull(entry.tokens),
      cacheCreation: getPromptCacheCreationTokensOrNull(entry.tokens),
      reasoning: getReasoningTokensOrNull(entry.tokens),
      compressed: typeof entry.tokensCompressed === "number" ? entry.tokensCompressed : null,
    });
  }
  if (!persistCallLogs || callLogSavesClosing) return Promise.resolve();

  const operation = saveCallLogOperation(entry);
  pendingCallLogSaves.add(operation);
  void operation.then(
    () => pendingCallLogSaves.delete(operation),
    () => pendingCallLogSaves.delete(operation)
  );
  return operation;
}

export async function waitForCallLogSaves(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (pendingCallLogSaves.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;

    let timeout: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.allSettled([...pendingCallLogSaves]).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!settled) return false;
  }
  return true;
}

export async function closeCallLogSaves(timeoutMs = 2_000): Promise<void> {
  callLogSavesClosing = true;
  const drained = await waitForCallLogSaves(timeoutMs);
  if (!drained) {
    await closeCallLogArtifactWriter(0);
  }

  // The admission gate above makes this a stable snapshot. After a forced worker
  // close, queued artifact promises have resolved fail-open and their SQLite
  // continuations can finish before the database is closed.
  await Promise.allSettled([...pendingCallLogSaves]);
  await closeCallLogArtifactWriter(0);
}

if (persistCallLogs && process.env.NODE_ENV !== "test") {
  scheduleCallLogRotation();
}

/**
 * Pushes a `column LIKE %value%` condition (mirrors the correlationId/sessionTag substring-match
 * precedent). Extracted so getCallLogs stays under the max-lines-per-function ratchet — #8249.
 */
function pushLikeFilter(
  conditions: string[],
  params: unknown[],
  column: string,
  value: unknown
) {
  if (!value) return;
  params.push(`%${value}%`);
  conditions.push(`cl.${column} ILIKE $${params.length}`);
}

export async function getCallLogs(filter: any = {}) {
  let sql = `
    SELECT cl.*,
      pn.name AS provider_node_name, pn.prefix AS provider_node_prefix,
      ${RESOLVED_ACCOUNT_SQL} AS resolved_account
    FROM call_logs cl
    LEFT JOIN provider_nodes pn ON pn.id = cl.provider
    LEFT JOIN provider_connections pc ON pc.id = cl.connection_id
  `;
  const conditions: string[] = [];
  const params: unknown[] = [];
  // Appends a value and returns its `$n` placeholder.
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.status) {
    if (filter.status === "error") {
      conditions.push("(cl.status >= 400 OR cl.error_summary IS NOT NULL)");
    } else if (filter.status === "ok") {
      conditions.push("cl.status >= 200 AND cl.status < 300");
    } else {
      const statusCode = Number.parseInt(filter.status, 10);
      if (!Number.isNaN(statusCode)) {
        conditions.push(`cl.status = ${bind(statusCode)}`);
      }
    }
  }

  // SQLite's LIKE ignored ASCII case; ILIKE keeps the filters behaving the same.
  if (filter.model) {
    const q = bind(`%${filter.model}%`);
    conditions.push(`(cl.model ILIKE ${q} OR cl.requested_model ILIKE ${q})`);
  }
  if (filter.provider) {
    conditions.push(`cl.provider ILIKE ${bind(`%${filter.provider}%`)}`);
  }
  if (filter.account) {
    const q = bind(`%${filter.account}%`);
    conditions.push(`(cl.account ILIKE ${q} OR ${RESOLVED_ACCOUNT_SQL} ILIKE ${q})`);
  }
  if (filter.apiKey) {
    const q = bind(`%${filter.apiKey}%`);
    conditions.push(`(cl.api_key_name ILIKE ${q} OR cl.api_key_id ILIKE ${q})`);
  }
  pushLikeFilter(conditions, params, "correlation_id", filter.correlationId);
  pushLikeFilter(conditions, params, "session_tag", filter.sessionTag);
  if (filter.combo) {
    conditions.push("cl.combo_name IS NOT NULL");
  }
  if (filter.excludeTests) {
    // Home "Recent Requests" is an allowlist of real provider inference, not a
    // blacklist of known backend log types. Persisted provider requests enter via
    // the public gateway namespaces (/v1/* or /api/v1/*); internal management work
    // (connection tests, model sync, and future /api/providers/* jobs) does not.
    // Apply this before LIMIT so backend rows can never displace real traffic.
    conditions.push(`(cl.path LIKE '/v1/%' OR cl.path LIKE '/api/v1/%')`);
  }
  if (filter.since) {
    const since = ts(filter.since instanceof Date ? filter.since : String(filter.since));
    if (since) conditions.push(`cl."timestamp" >= ${bind(since)}`);
  }
  if (filter.until) {
    const until = ts(filter.until instanceof Date ? filter.until : String(filter.until));
    if (until) conditions.push(`cl."timestamp" <= ${bind(until)}`);
  }
  if (filter.search) {
    const q = bind(`%${filter.search}%`);
    conditions.push(`(
      cl.model ILIKE ${q} OR cl.path ILIKE ${q} OR cl.account ILIKE ${q} OR
      ${RESOLVED_ACCOUNT_SQL} ILIKE ${q} OR
      cl.requested_model ILIKE ${q} OR cl.provider ILIKE ${q} OR
      cl.api_key_name ILIKE ${q} OR cl.api_key_id ILIKE ${q} OR
      cl.combo_name ILIKE ${q} OR cl.status::text ILIKE ${q}
      OR cl.combo_step_id ILIKE ${q} OR cl.combo_execution_key ILIKE ${q}
      OR cl.error_summary ILIKE ${q}
      OR cl.correlation_id ILIKE ${q}
    )`);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200;
  const offset = Number.isInteger(filter.offset) && filter.offset > 0 ? filter.offset : 0;
  sql += ` ORDER BY cl."timestamp" DESC, cl.seq DESC LIMIT ${bind(limit)} OFFSET ${bind(offset)}`;

  const rows = await db().query<CallLogSummaryRow>(sql, params);
  return rows.map(mapSummaryRow);
}

/**
 * Detail view by id. The detail route only has the id, so without `timestamp` this probes
 * every partition's PK index (fine for one interactive read). Callers that already hold
 * the row's timestamp (export, conversation views) pass it so the lookup prunes to one day.
 */
export async function getCallLogById(id: string, timestamp?: string | null) {
  const rowTs = ts(timestamp);
  const row = await db().queryOne<CallLogSummaryRow>(
    `SELECT cl.*,
        pn.name AS provider_node_name,
        pn.prefix AS provider_node_prefix,
        ${RESOLVED_ACCOUNT_SQL} AS resolved_account
       FROM call_logs cl
       LEFT JOIN provider_nodes pn ON pn.id = cl.provider
       LEFT JOIN provider_connections pc ON pc.id = cl.connection_id
       WHERE cl.id = $1${rowTs ? ` AND cl."timestamp" = $2` : ""}
       ORDER BY cl."timestamp" DESC
       LIMIT 1`,
    rowTs ? [id, rowTs] : [id]
  );
  if (!row) return null;

  const entry = mapSummaryRow(row);
  return resolveCallLogDetail(entry, getCallLogsDir(), {
    io: dashboardDetailIo,
    async onArtifactState(relativePath, state) {
      if (state === "missing") await clearArtifactReference(relativePath, "missing");
      else {
        // Runs right after reading the row, so it prunes by the row's own partition key.
        await db().execute(
          `UPDATE call_logs SET detail_state = 'corrupt' WHERE id = $1 AND "timestamp" = $2`,
          [id, row.timestamp]
        );
      }
    },
  });
}

export async function exportCallLogsSince(since: string) {
  const rows = await db().query<{ id: string; timestamp: string }>(
    `SELECT id, "timestamp" FROM call_logs WHERE "timestamp" >= $1 ORDER BY "timestamp" DESC`,
    [ts(since)]
  );

  const logs: unknown[] = [];
  for (const row of rows) {
    const log = await getCallLogById(String(row.id), row.timestamp);
    if (log) logs.push(log);
  }
  return logs;
}

/**
 * Total number of call_logs rows with timestamp >= `since` — a cheap
 * aggregate query, no row hydration. Used by /api/logs/export to report
 * `totalAvailable` without paying the cost of hydrating every row (#13123).
 */
export async function countCallLogsSince(since: string): Promise<number> {
  const row = await db().queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM call_logs WHERE "timestamp" >= $1`,
    [ts(since)]
  );
  return Number(row?.count ?? 0);
}

/**
 * Streams up to `limit` hydrated call logs with timestamp >= `since`, most
 * recent first, one at a time. Only fetches the id list eagerly (small — just
 * strings) and bounds it with SQL LIMIT; each full log entry (which can
 * include large request/response artifacts via `getCallLogById`) is only
 * hydrated and held in memory long enough to be yielded (#13123: the previous
 * `exportCallLogsSince()` + slice-after-fetch approach hydrated and buffered
 * every matching row — including rows beyond the cap — before the row cap
 * was ever applied, which is what left the peak V8 heap unchanged).
 */
export async function* iterateCallLogsSince(
  since: string,
  limit: number
): AsyncGenerator<unknown, void, void> {
  const rows = await db().query<{ id: string; timestamp: string }>(
    `SELECT id, "timestamp" FROM call_logs WHERE "timestamp" >= $1 ORDER BY "timestamp" DESC LIMIT $2`,
    [ts(since), limit]
  );

  for (const row of rows) {
    const log = await getCallLogById(String(row.id), row.timestamp);
    if (log) yield log;
  }
}
