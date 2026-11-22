import { test } from "node:test";
import assert from "node:assert/strict";
import { readErrorBodyText } from "../../open-sse/handlers/chatCore/errorBodyRead.ts";
import { NonStreamingResponseTooLargeError } from "../../open-sse/utils/responseBodyCap.ts";

function stalledResponse(firstChunk: string, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      // never closes: a stalled upstream error body
    },
  });
  return new Response(stream, { status: 429, headers });
}

test("a stalled error body returns the text read so far at the deadline", async () => {
  const started = Date.now();
  const text = await readErrorBodyText(stalledResponse('{"error":"slow"}'), 50);
  assert.equal(text, '{"error":"slow"}');
  assert.ok(Date.now() - started < 2_000);
});

test("a body over 64 KiB is cancelled and rejected", async () => {
  const big = "x".repeat(70 * 1024);
  await assert.rejects(
    readErrorBodyText(new Response(big, { status: 500 })),
    NonStreamingResponseTooLargeError
  );
});

test("a declared Content-Length over the cap is rejected before reading", async () => {
  await assert.rejects(
    readErrorBodyText(stalledResponse("x", { "content-length": String(1024 * 1024) })),
    NonStreamingResponseTooLargeError
  );
});

test("a normal error body is read in full", async () => {
  const text = await readErrorBodyText(
    new Response('{"error":{"message":"nope"}}', { status: 400 })
  );
  assert.equal(text, '{"error":{"message":"nope"}}');
});
