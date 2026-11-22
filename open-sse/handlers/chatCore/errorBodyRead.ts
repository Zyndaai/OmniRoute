/**
 * Bounded read of an upstream error body (upstream OmniRoute #19425).
 *
 * A stalled or oversized error body must not hold a request slot until the 600 s body timeout.
 * At most 64 KiB and at most 5 s are read. On timeout the reader is cancelled and the text read
 * so far is returned; past the byte cap the body is cancelled and
 * {@link NonStreamingResponseTooLargeError} is thrown.
 */

import {
  NonStreamingResponseTooLargeError,
  cancelNonStreamingReader,
  getMaxNonStreamingResponseBytes,
} from "../../utils/responseBodyCap.ts";

export const ERROR_BODY_MAX_BYTES = 64 * 1024;
export const ERROR_BODY_READ_TIMEOUT_MS = 5_000;

export async function readErrorBodyText(
  response: Response,
  timeoutMs: number = ERROR_BODY_READ_TIMEOUT_MS
): Promise<string> {
  const maxBytes = Math.min(ERROR_BODY_MAX_BYTES, getMaxNonStreamingResponseBytes());
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new NonStreamingResponseTooLargeError(declared, maxBytes);
  }
  if (!response.body || response.bodyUsed) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesSeen = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timedOut]);
      if (chunk === "timeout") {
        cancelNonStreamingReader(reader, new Error("Upstream error body read timed out"));
        break;
      }
      if (chunk.done) break;
      bytesSeen += chunk.value.byteLength;
      if (bytesSeen > maxBytes) throw new NonStreamingResponseTooLargeError(bytesSeen, maxBytes);
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    cancelNonStreamingReader(reader, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return text + decoder.decode();
}
