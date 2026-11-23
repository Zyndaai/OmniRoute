import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import zlib from "node:zlib";

const { compressResponses } = await import("../../../src/server/http/compression.ts");
const { createNodeListener } = await import("../../../src/server/http/nodeListener.ts");

const bigJson = JSON.stringify({ data: Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}` })) });

function streamed(contentType: string, extra: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === 3) {
        controller.close();
        return;
      }
      if (sent > 0) await new Promise((resolve) => setTimeout(resolve, 150));
      // Each chunk alone exceeds the 1 KB threshold.
      controller.enqueue(encoder.encode(`data: ${sent}-${"x".repeat(2048)}\n\n`));
      sent++;
    },
  });
  return new Response(body, { headers: { "content-type": contentType, ...extra } });
}

const listener = createNodeListener(async (request) => {
  switch (new URL(request.url).pathname) {
    case "/json":
      return new Response(bigJson, { headers: { "content-type": "application/json" } });
    case "/html":
      return new Response(`<!doctype html><p>${"page ".repeat(500)}</p>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/sse":
      return streamed("text/event-stream; charset=utf-8");
    case "/ndjson":
      return streamed("application/x-ndjson");
    case "/accel":
      return streamed("application/json", { "x-accel-buffering": "no" });
    default:
      return new Response("not found", { status: 404 });
  }
});

const server = http.createServer((req, res) => compressResponses(req, res, () => listener(req, res)));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function get(
  path: string,
  acceptEncoding?: string
): Promise<{ headers: http.IncomingHttpHeaders; chunks: Array<{ at: number; size: number }>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = acceptEncoding ? { "accept-encoding": acceptEncoding } : {};
    const request = http.get({ host: "127.0.0.1", port, path, headers }, (response) => {
      const chunks: Array<{ at: number; size: number }> = [];
      const buffers: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push({ at: Date.now(), size: chunk.length });
        buffers.push(chunk);
      });
      response.on("end", () =>
        resolve({ headers: response.headers, chunks, body: Buffer.concat(buffers) })
      );
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

test("JSON and pages are gzip-compressed when the client accepts gzip", async () => {
  for (const path of ["/json", "/html"]) {
    const { headers, body } = await get(path, "gzip");
    assert.equal(headers["content-encoding"], "gzip", path);
    assert.match(String(headers.vary), /Accept-Encoding/i, path);
    assert.ok(zlib.gunzipSync(body).length > body.length, path);
  }
  const { body } = await get("/json", "gzip");
  assert.equal(zlib.gunzipSync(body).toString("utf8"), bigJson);
});

test("nothing is compressed without Accept-Encoding", async () => {
  const { headers, body } = await get("/json");
  assert.equal(headers["content-encoding"], undefined);
  assert.equal(body.toString("utf8"), bigJson);
});

test("streamed responses are never compressed and arrive chunk by chunk", async () => {
  for (const path of ["/sse", "/ndjson", "/accel"]) {
    const { headers, chunks, body } = await get(path, "gzip, br");
    assert.equal(headers["content-encoding"], undefined, path);
    assert.ok(body.toString("utf8").startsWith("data: 0-"), path);
    assert.ok(chunks.length >= 3, `${path}: ${chunks.length} chunk(s)`);
    const spread = chunks[chunks.length - 1].at - chunks[0].at;
    assert.ok(spread >= 250, `${path}: chunks arrived within ${spread} ms`);
  }
});
