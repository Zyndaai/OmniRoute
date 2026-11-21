import { describe, it } from "node:test";
import { ok, equal } from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

describe("Response compression verification (#6736)", () => {
  it("the server compresses JSON responses but never streamed ones", async () => {
    const { shouldCompress } = await import("@/server/http/compression");
    const req = { method: "GET", headers: { "accept-encoding": "gzip" } } as IncomingMessage;
    const responseWith = (contentType: string, extra: Record<string, string> = {}) => {
      const headers: Record<string, string> = { "content-type": contentType, ...extra };
      return {
        getHeader: (name: string) => headers[name.toLowerCase()],
      } as unknown as ServerResponse;
    };

    equal(shouldCompress(req, responseWith("application/json")), true);
    equal(shouldCompress(req, responseWith("text/event-stream")), false);
    equal(shouldCompress(req, responseWith("application/json", { "x-accel-buffering": "no" })), false);
  });

  it("stripStaleForwardingHeaders deletes content-encoding", async () => {
    const { stripStaleForwardingHeaders } = await import(
      "@/../open-sse/handlers/chatCore/responseHeaders"
    );
    const headers = new Headers({ "content-encoding": "gzip", "x-custom": "keep" });
    stripStaleForwardingHeaders(headers);
    equal(headers.has("content-encoding"), false, "content-encoding should be stripped");
    ok(headers.has("x-custom"), "custom headers should survive");
  });

  it("stripStaleForwardingHeaders deletes content-length and transfer-encoding", async () => {
    const { stripStaleForwardingHeaders } = await import(
      "@/../open-sse/handlers/chatCore/responseHeaders"
    );
    const headers = new Headers({
      "content-length": "1024",
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
    });
    stripStaleForwardingHeaders(headers);
    equal(headers.has("content-length"), false);
    equal(headers.has("content-encoding"), false);
    equal(headers.has("transfer-encoding"), false);
  });
});
