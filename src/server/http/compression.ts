/**
 * Response compression (gzip, brotli or deflate, negotiated from `Accept-Encoding`) for pages,
 * JSON and static files. Streamed responses are never compressed: a compressor holds output
 * back until it has a full block, so server-sent events and NDJSON chunks would stop reaching
 * the client as they are written.
 *
 * Not compressed:
 *   - streaming media types (`text/event-stream`, NDJSON/JSON Lines, JSON text sequences, ...)
 *   - a response marked `X-Accel-Buffering: no` (the header streaming routes set for proxies)
 *   - `Cache-Control: no-transform`, HEAD requests, bodies under 1 KB and types mime-db does
 *     not list as compressible (the package's own rules)
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import compression from "compression";

const STREAMING_MEDIA_TYPE =
  /^\s*(?:text\/event-stream|application\/(?:x-)?ndjson|application\/jsonl|application\/json-seq|application\/stream\+json|multipart\/x-mixed-replace)\s*(?:;|$)/i;

function headerText(value: number | string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** Whether `res` is a streamed response (decided from its headers, before the first write). */
export function isStreamingResponse(res: ServerResponse): boolean {
  if (STREAMING_MEDIA_TYPE.test(headerText(res.getHeader("Content-Type")))) return true;
  return headerText(res.getHeader("X-Accel-Buffering")).trim().toLowerCase() === "no";
}

export function shouldCompress(req: IncomingMessage, res: ServerResponse): boolean {
  if (isStreamingResponse(res)) return false;
  return compression.filter(req, res);
}

/** Connect-style middleware; mount it before anything that writes a response. */
export const compressResponses = compression({ filter: shouldCompress });
