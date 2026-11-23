// Regression guard for #5083 (Bug 1): the dashboard, when reached from a LAN /
// Tailscale / non-loopback host, opens `ws://<that-host>:<port>` to its own Live WS
// server. The Content-Security-Policy previously allowed `ws:` only for loopback origins
// (`ws://localhost:*`, `ws://127.0.0.1:*`) plus a bare `wss:` — so a plain-`ws:`
// connection to a non-loopback host was blocked by the browser. The fix permits the bare
// `ws:` scheme (symmetric with the bare `wss:` that was already allowed).
//
// This test pins the connect-src directive so the LAN/Tailscale WS allowance cannot
// silently regress, while confirming the other security directives are left intact.

import test from "node:test";
import assert from "node:assert/strict";

import { SECURITY_HEADERS } from "../../../src/server/http/securityHeaders.ts";

const csp = SECURITY_HEADERS.find(([name]) => name === "Content-Security-Policy")?.[1] ?? "";

function connectSrcDirective(): string {
  const directive = csp.split("; ").find((part) => part.startsWith("connect-src"));
  assert.ok(directive, "the CSP must define a connect-src directive");
  return directive!;
}

test("#5083 connect-src permits the bare ws: scheme for non-loopback dashboards", () => {
  const connectSrc = connectSrcDirective();
  assert.match(
    connectSrc,
    /(^|\s)ws:(\s|$)/,
    `connect-src must allow the bare ws: scheme; got: ${connectSrc}`
  );
});

test("#5083 connect-src keeps the bare wss: scheme it mirrors", () => {
  assert.match(connectSrcDirective(), /(^|\s)wss:(\s|$)/, "connect-src must still allow bare wss:");
});

test("#5083 connect-src still scopes 'self' and explicit loopback origins", () => {
  const connectSrc = connectSrcDirective();
  assert.ok(connectSrc.includes("'self'"), "connect-src must still include 'self'");
  assert.ok(
    connectSrc.includes("ws://localhost:*") && connectSrc.includes("ws://127.0.0.1:*"),
    "explicit loopback ws origins must remain listed"
  );
});

test("#5083 baseline security directives remain intact in the CSP", () => {
  assert.ok(csp.includes("frame-ancestors 'none'"), "frame-ancestors 'none' must remain");
  assert.ok(csp.includes("object-src 'none'"), "object-src 'none' must remain");
  assert.ok(csp.includes("base-uri 'self'"), "base-uri 'self' must remain");
});
