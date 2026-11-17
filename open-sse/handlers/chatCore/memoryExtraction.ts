import { isClaudeCodeClassifierRequest } from "./claudeClassifierCompat.ts";
import { isNoMemoryRequested } from "./headers.ts";

// The memory engine (extraction, injection) is gone. What stays is the per-request owner
// resolution: chatCore uses it as the skills owner id (`skillsOwnerId`).

export function resolveMemoryOwnerId(apiKeyInfo: Record<string, unknown> | null): string | null {
  const rawId = apiKeyInfo?.id;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    return rawId;
  }
  return null;
}

/**
 * Owner id for this request, or null when it must not be attributed to a key at all. A null
 * owner disables per-owner skill execution. Covers the `x-omniroute-no-memory` opt-out and
 * Claude Code's internal security-classifier turns: those are not user conversation.
 */
export function resolveRequestMemoryOwnerId(input: {
  apiKeyInfo: Record<string, unknown> | null;
  headers: Record<string, unknown> | Headers | null | undefined;
  sourceFormat: string;
  body: Record<string, unknown> | null | undefined;
}): string | null {
  const { apiKeyInfo, headers, sourceFormat, body } = input;
  if (isNoMemoryRequested(headers) || isClaudeCodeClassifierRequest(sourceFormat, body)) {
    return null;
  }
  return resolveMemoryOwnerId(apiKeyInfo);
}
