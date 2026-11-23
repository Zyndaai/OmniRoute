import test from "node:test";
import assert from "node:assert/strict";

import { readRateLimitRetryHintMs } from "../../../open-sse/executors/rateLimitIntraRetry.ts";
import { applyPayloadRules } from "../../../open-sse/services/payloadRules.ts";

test("a stalled 429 body does not hold the retry-hint read past the 5 s bound", async () => {
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":'));
      // never closes
    },
  });
  const response = new Response(stalled, { status: 429 });
  const started = Date.now();
  const hint = await readRateLimitRetryHintMs(response);
  assert.equal(hint, null);
  assert.ok(Date.now() - started < 7_000, "read must stop at the error-body timeout");
  void response.body?.cancel().catch(() => {});
});

test("an oversized 429 body is not read in full", async () => {
  const big = "x".repeat(200 * 1024);
  const response = new Response(big, { status: 429 });
  assert.equal(await readRateLimitRetryHintMs(response), null);
});

test("applyPayloadRules with no rules returns the caller's payload without cloning", () => {
  const input = [{ type: "message", content: "x".repeat(1000) }];
  const payload = { model: "m", input };
  const result = applyPayloadRules(payload, "m", "openai", {
    default: [],
    override: [],
    filter: [],
    defaultRaw: [],
  });
  assert.strictEqual(result.payload.input, input);
  assert.deepEqual(result.applied, []);
});
