import test from "node:test";
import assert from "node:assert/strict";

import {
  filterNonstandardCodexSse,
  peekCodexSseTransientError,
} from "../../../open-sse/executors/codex.ts";

// chatgpt.com can answer a streaming request with an empty content-type; an explicitly
// streaming request must still be filtered and peeked as SSE.

const overloaded = `event: response.failed\ndata: ${JSON.stringify({
  type: "response.failed",
  response: {
    status: "failed",
    error: { code: "server_is_overloaded", message: "selected model is at capacity" },
  },
})}\n\n`;

function noContentType(body: string): Response {
  // A string body would get a text/plain content-type; bytes leave it empty.
  return new Response(new TextEncoder().encode(body), { status: 200 });
}

test("peek ignores an empty content-type unless the request was streaming", async () => {
  const plain = await peekCodexSseTransientError(noContentType(overloaded));
  assert.equal(plain.matched, null);

  const streaming = await peekCodexSseTransientError(noContentType(overloaded), undefined, true);
  assert.ok(streaming.matched, "the streaming request must see the overload declaration");
});

test("filter leaves an empty content-type alone unless the request was streaming", async () => {
  const unchanged = noContentType("x");
  assert.strictEqual(filterNonstandardCodexSse(unchanged), unchanged);

  const nonstandard = `event: codex.rate_limits\ndata: {"type":"codex.rate_limits"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`;
  const filtered = filterNonstandardCodexSse(noContentType(nonstandard), true);
  const text = await filtered.text();
  assert.ok(text.includes("response.completed"));
});
