/**
 * Anthropic reads an assistant-last turn as a prefill and rejects it with
 *   400 "final assistant content cannot end with trailing whitespace".
 * Compression and client edits can leave such a tail. Trim only the final text block;
 * a tail block that trims to empty is removed (repeat), and an emptied turn is dropped.
 * A non-text tail (tool_use, thinking) is left alone. Pure: inputs are not mutated.
 */

type Block = Record<string, unknown> | null;

/** Trim the last text block; a tail text block that trims to empty is removed (repeat). */
function trimFinalTextBlocks(content: Block[]): Block[] {
  const blocks = [...content];
  let tail = blocks.at(-1);
  while (tail?.type === "text") {
    const text = typeof tail.text === "string" ? tail.text.trimEnd() : "";
    if (text) {
      blocks[blocks.length - 1] = { ...tail, text };
      break;
    }
    blocks.pop();
    tail = blocks.at(-1);
  }
  return blocks;
}

export function normalizeClaudeFinalAssistantWhitespace(
  messages: Record<string, unknown>[]
): Record<string, unknown>[] {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  if (last?.role !== "assistant") return messages;

  let content: unknown;
  if (typeof last.content === "string") {
    content = last.content.trimEnd();
  } else if (Array.isArray(last.content)) {
    content = trimFinalTextBlocks(last.content as Block[]);
  } else {
    return messages;
  }

  if (JSON.stringify(content) === JSON.stringify(last.content)) return messages;
  const rest = messages.slice(0, -1);
  const empty = typeof content === "string" ? content === "" : (content as unknown[]).length === 0;
  // A lone emptied assistant turn is kept so the body never becomes empty.
  if (empty) return rest.length > 0 ? rest : messages;
  return [...rest, { ...last, content }];
}
