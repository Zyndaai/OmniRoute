import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNonStreamingResponseBody } from "../../../open-sse/handlers/chatCore/nonStreamingResponseParse.ts";
import { extractSSEErrorFrameStatus } from "../../../open-sse/handlers/chatCore/sseErrorFrameStatus.ts";

function sse(frame: unknown): Response {
  return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function parse(frame: unknown) {
  return parseNonStreamingResponseBody({
    providerResponse: sse(frame),
    upstreamStream: false,
    providerHeaders: null,
    finalBody: {},
    targetFormat: "openai",
    model: "m",
    log: null,
  });
}

test("an error frame carrying status 429 keeps it", async () => {
  const parsed = await parse({ error: { message: "slow down", status: 429 } });
  assert.equal(parsed.kind, "invalid_sse");
  assert.equal(parsed.kind === "invalid_sse" ? parsed.status : null, 429);
});

test("a numeric error.code in the 4xx/5xx range is the status", async () => {
  const parsed = await parse({ error: { message: "overloaded", code: 503 } });
  assert.equal(parsed.kind === "invalid_sse" ? parsed.status : null, 503);
});

test("an error frame without a status stays a 502 (status absent)", async () => {
  const parsed = await parse({ error: { message: "boom", code: "internal" } });
  assert.equal(parsed.kind, "invalid_sse");
  assert.equal(parsed.kind === "invalid_sse" ? parsed.status : null, undefined);
});

test("statuses outside 400-599 are ignored", () => {
  assert.equal(
    extractSSEErrorFrameStatus('data: {"error":{"message":"x","status":200}}\n\n'),
    undefined
  );
  assert.equal(extractSSEErrorFrameStatus('data: {"choices":[]}\n\n'), undefined);
});
