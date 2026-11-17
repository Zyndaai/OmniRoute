import { randomUUID } from "node:crypto";
import { db, type DbExecutor } from "./pg";
import {
  sanitizeErrorMessage,
  sanitizeUpstreamDetails,
} from "@omniroute/open-sse/utils/errorSanitization";

const MAX_PERSISTED_OUTPUT_CHARS = 32_768;
const MAX_PERSISTED_ERROR_CHARS = 4_096;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ServerToolClaim =
  | { kind: "claimed"; executionId: string }
  | {
      kind: "replay";
      executionId: string;
      status: "success" | "error" | "timeout";
      output: unknown;
      errorMessage: string | null;
    }
  | { kind: "in_progress"; executionId: string }
  | { kind: "unknown"; executionId: string }
  | { kind: "identity_conflict"; executionId: string };

/** Postgres rejects U+0000 in text; tool output is upstream content. */
function stripNul(value: string): string {
  return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

function sanitizeAndBounded(value: unknown, maxChars: number): string | null {
  if (value === null || value === undefined) return null;
  // Strings: sanitize credentials/stack, store as bounded plain text (error_message is TEXT)
  if (typeof value === "string") {
    const sanitized = stripNul(sanitizeErrorMessage(value));
    return sanitized.length > maxChars ? sanitized.slice(0, maxChars) : sanitized;
  }
  // Objects/arrays: recursive sanitization, JSON.stringify, then guaranteed-valid truncation
  const sanitized = sanitizeUpstreamDetails(value);
  let text: string;
  try {
    text = stripNul(JSON.stringify(sanitized));
  } catch {
    text = JSON.stringify({ error: "Value is not JSON-serializable" });
  }
  if (text.length <= maxChars) return text;
  // Truncation envelope: progressively shorten preview until serialized envelope fits
  const envelope = { truncated: true, preview: "" as string };
  for (let len = maxChars - 40; len > 0; len -= 20) {
    envelope.preview = text.slice(0, len);
    const candidate = JSON.stringify(envelope);
    if (candidate.length <= maxChars) return candidate;
  }
  envelope.preview = text.slice(0, 20);
  return JSON.stringify(envelope);
}

export async function readRow(
  executor: DbExecutor,
  executionId: string
): Promise<{
  id: string;
  tool_name: string;
  input_digest: string;
  status: string;
  output: string | null;
  error_message: string | null;
} | null> {
  if (!UUID_RE.test(executionId)) return null;
  const row = await executor.queryOne<{
    id: string;
    tool_name: string;
    input_digest: string;
    status: string;
    output: string | null;
    error_message: string | null;
  }>(
    "SELECT id, tool_name, input_digest, status, output, error_message FROM server_tool_executions WHERE id = $1",
    [executionId]
  );
  return row ?? null;
}

async function readExistingByIdentity(
  executor: DbExecutor,
  apiKeyId: string,
  requestIdentity: string,
  toolCallId: string
) {
  const row = await executor.queryOne<{
    id: string;
    tool_name: string;
    input_digest: string;
    status: string;
    output: string | null;
    error_message: string | null;
    claim_expires_at: string;
  }>(
    `SELECT id, tool_name, input_digest, status, output, error_message, claim_expires_at
     FROM server_tool_executions
     WHERE api_key_id = $1 AND request_identity = $2 AND tool_call_id = $3`,
    [apiKeyId, requestIdentity, toolCallId]
  );
  return row ?? null;
}

function buildReplayClaim(row: {
  id: string;
  status: string;
  output: string | null;
  error_message: string | null;
}): ServerToolClaim {
  let parsedOutput: unknown = null;
  if (row.output !== null) {
    try {
      parsedOutput = JSON.parse(row.output);
    } catch {
      parsedOutput = row.output;
    }
  }
  return {
    kind: "replay",
    executionId: row.id,
    status: row.status as "success" | "error" | "timeout",
    output: parsedOutput,
    errorMessage: row.error_message,
  };
}

export async function claimServerToolExecution(
  input: {
    apiKeyId: string;
    requestIdentity: string;
    toolCallId: string;
    toolName: string;
    inputDigest: string;
    leaseExpiresAt: string;
  },
  executor: DbExecutor = db(),
  nowMs?: number
): Promise<ServerToolClaim> {
  const executionId = randomUUID();
  const now = nowMs ?? Date.now();

  // ON CONFLICT DO NOTHING: a conflict returns no row instead of aborting the
  // transaction, so the re-read below works on the same connection.
  const inserted = await executor.queryOne(
    `INSERT INTO server_tool_executions
      (id, api_key_id, request_identity, tool_call_id, tool_name, input_digest, status, claim_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)
     ON CONFLICT (api_key_id, request_identity, tool_call_id) DO NOTHING
     RETURNING id`,
    [
      executionId,
      input.apiKeyId,
      input.requestIdentity,
      input.toolCallId,
      input.toolName,
      input.inputDigest,
      input.leaseExpiresAt,
    ]
  );
  if (inserted) return { kind: "claimed", executionId };

  const existing = await readExistingByIdentity(
    executor,
    input.apiKeyId,
    input.requestIdentity,
    input.toolCallId
  );

  if (!existing) {
    return { kind: "unknown", executionId };
  }

  // Identity conflict: different name or digest
  if (existing.tool_name !== input.toolName || existing.input_digest !== input.inputDigest) {
    return { kind: "identity_conflict", executionId: existing.id };
  }

  // Terminal status → replay
  if (
    existing.status === "success" ||
    existing.status === "error" ||
    existing.status === "timeout"
  ) {
    return buildReplayClaim(existing);
  }

  // Running status — check STORED lease expiry (not input)
  const storedExpiresAt = new Date(existing.claim_expires_at).getTime();
  if (storedExpiresAt <= now) {
    return { kind: "unknown", executionId: existing.id };
  }

  // Running + unexpired → in_progress
  return { kind: "in_progress", executionId: existing.id };
}

export async function finalizeServerToolExecution(
  input: {
    executionId: string;
    status: "success" | "error" | "timeout";
    output: unknown | null;
    errorMessage: string | null;
    durationMs: number;
  },
  executor: DbExecutor = db()
): Promise<boolean> {
  if (!UUID_RE.test(input.executionId)) return false;
  const safeOutput = sanitizeAndBounded(input.output, MAX_PERSISTED_OUTPUT_CHARS);
  const safeError = sanitizeAndBounded(input.errorMessage, MAX_PERSISTED_ERROR_CHARS);

  const result = await executor.execute(
    `UPDATE server_tool_executions
     SET status = $1, output = $2, error_message = $3, duration_ms = $4, completed_at = now()
     WHERE id = $5 AND status = 'running'`,
    [input.status, safeOutput, safeError, Math.round(input.durationMs), input.executionId]
  );

  return result.changes > 0;
}
