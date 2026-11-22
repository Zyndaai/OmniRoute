/**
 * Prompt-cache rescue for the pure claude -> claude passthrough branch.
 *
 * Marker-less Anthropic-format clients (Cursor and similar) ship zero `cache_control`
 * breakpoints through passthrough, so the whole prefix is billed uncached on every turn. This
 * injects the standard breakpoints ONLY when the body carries none anywhere; a client that
 * manages its own markers is returned byte-untouched.
 *
 * Placement:
 *   - system tail: the provider default TTL (1h; the system prompt changes rarely)
 *   - second-to-last user turn and last assistant turn: ephemeral (5m) on the stable rolling
 *     prefix. The last user turn stays unmarked: it is the working set and would invalidate on
 *     every turn.
 * Anthropic rejects `cache_control` on thinking / redacted_thinking and blank text blocks, so
 * markers go on the last block that is none of those.
 *
 * Ported from upstream OmniRoute `ensurePassthroughCacheBreakpoints` (claudeHelper.ts). It lives
 * here so the translator helper stays untouched.
 */

import { createDefaultClaudeCacheControl } from "../../translator/helpers/claudeHelper.ts";
import type { ConnectionCacheOverride } from "../../utils/cacheControlPolicy.ts";
import type { ClaudeContentBlock, ClaudeMessage } from "./claudeMessageTypes.ts";

type CacheControl = { type: string; ttl?: string };

export type PassthroughCacheBody = {
  system?: unknown;
  messages?: ClaudeMessage[];
  tools?: unknown;
  [key: string]: unknown;
};

function hasMarker(block: unknown): boolean {
  return (
    !!block && typeof block === "object" && !!(block as { cache_control?: unknown }).cache_control
  );
}

function bodyHasAnyCacheControl(body: PassthroughCacheBody): boolean {
  if (Array.isArray(body.system) && body.system.some(hasMarker)) return true;
  if (Array.isArray(body.tools) && body.tools.some(hasMarker)) return true;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg?.content) && msg.content.some(hasMarker)) return true;
    }
  }
  return false;
}

function isThinkingLike(block: ClaudeContentBlock): boolean {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

// Only text blocks can be blank here; every other typed block (image, document, tool_use,
// tool_result, ...) is real content.
function isMarkable(block: ClaudeContentBlock): boolean {
  if (!block || typeof block !== "object" || isThinkingLike(block)) return false;
  if (block.type === "text") return typeof block.text === "string" && block.text.trim() !== "";
  return typeof block.type === "string" && block.type.length > 0;
}

function ensureContentArray(msg: ClaudeMessage): ClaudeContentBlock[] {
  if (Array.isArray(msg?.content)) return msg.content;
  if (typeof msg?.content === "string" && msg.content.trim()) {
    msg.content = [{ type: "text", text: msg.content }];
    return msg.content;
  }
  return [];
}

function markLastCacheableBlock(blocks: ClaudeContentBlock[], cacheControl: CacheControl): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!isMarkable(blocks[i])) continue;
    blocks[i].cache_control = { ...cacheControl };
    return true;
  }
  return false;
}

/** Mutates `body` in place and returns the same reference. */
export function ensurePassthroughCacheBreakpoints<T extends PassthroughCacheBody>(
  body: T,
  provider?: string | null
): T {
  if (bodyHasAnyCacheControl(body)) return body;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) ensureContentArray(msg);

  if (Array.isArray(body.system)) {
    markLastCacheableBlock(
      body.system as ClaudeContentBlock[],
      createDefaultClaudeCacheControl(provider)
    );
  }

  const tailCacheControl: CacheControl = { type: "ephemeral" };
  const userTurns: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") userTurns.push(i);
  }
  if (userTurns.length >= 2) {
    const secondToLast = messages[userTurns[userTurns.length - 2]];
    markLastCacheableBlock(ensureContentArray(secondToLast), tailCacheControl);
  }
  // A thinking-only turn has nothing to mark: take the closest earlier assistant turn.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    if (markLastCacheableBlock(ensureContentArray(messages[i]), tailCacheControl)) break;
  }

  return body;
}

/**
 * Anthropic-native upstreams only: third-party Claude-shape providers have their own (or no)
 * caching semantics. A connection's cache override is the operator's opt-out.
 */
export function acceptsInjectedCacheBreakpoints(
  provider: string,
  connectionCacheOverride: ConnectionCacheOverride | null | undefined
): boolean {
  if (provider !== "claude" && !provider.startsWith("anthropic-compatible-")) return false;
  return (
    connectionCacheOverride?.supportsPromptCaching !== false &&
    connectionCacheOverride?.cacheControlPassthrough !== "strip"
  );
}
