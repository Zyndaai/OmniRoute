/**
 * HTTP status carried by an SSE error-only frame (upstream OmniRoute #19448).
 *
 * `extractSSEErrorMessage` (../sseParser.ts) surfaces the sanitized message of an error-only
 * `data:` chunk. The same chunk often carries its own class (`error.status` or a numeric
 * `error.code`, e.g. 429). A non-stream reply built from it was always a 502, which hid the 429 from
 * account fallback and from client retry logic. This reads the status of the first error-only chunk
 * (a chunk with an `error` and no `choices` array), the same chunk `extractSSEErrorMessage` reads.
 */

function frameErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || Array.isArray(err)) return undefined;
  const { status, code } = err as Record<string, unknown>;
  for (const value of [status, code]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  return undefined;
}

export function extractSSEErrorFrameStatus(rawSSE: unknown): number | undefined {
  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.choices) || record.error == null) continue;
    return frameErrorStatus(record.error);
  }
  return undefined;
}
