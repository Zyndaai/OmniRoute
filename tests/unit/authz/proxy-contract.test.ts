/**
 * Request pipeline contract — lockdown test.
 *
 * The authz pipeline only protects routes when ALL of the following hold:
 *
 *   1. The server's request handler (`src/server/http/handler.ts`) calls
 *      `runAuthzPipeline` with `enforce: true`.
 *   2. It does so for every path in `AUTHZ_PATH_PATTERNS`, and those patterns cover every
 *      prefix routes are mounted under, so unauthenticated requests cannot slip past the
 *      centralized authorization tiers (PUBLIC / CLIENT_API / MANAGEMENT).
 *
 * Without either guarantee the pipeline silently becomes dead code and every `/api/*` route
 * falls back to per-route self-enforcement, the failure mode that led to the v3.8.4
 * hardening pass.
 *
 * @see docs/security/ROUTE_GUARD_TIERS.md
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { AUTHZ_PATH_PATTERNS, isAuthzPath } from "../../../src/server/http/authzPaths.ts";

test("the request handler delegates to runAuthzPipeline with enforce: true", () => {
  const content = fs.readFileSync("src/server/http/handler.ts", "utf8");
  assert.match(
    content,
    /runAuthzPipeline\(request,\s*\{\s*enforce:\s*true\b/,
    "must call runAuthzPipeline with { enforce: true } — otherwise the pipeline never blocks"
  );
  assert.match(content, /isAuthzPath\(pathname\)/, "the pipeline must be gated on isAuthzPath");
});

test("the authz path set covers every /api/* route plus dashboard and client aliases", () => {
  const required = [
    "/api/:path*",
    "/dashboard/:path*",
    "/home/:path*",
    "/v1/:path*",
    "/v1beta/:path*",
    "/chat/:path*",
    "/responses/:path*",
    "/codex/:path*",
    "/models",
    // CLIProxyAPI management compatibility (/v0/management/* rewrite).
    "/v0/:path*",
    "/",
  ];
  for (const pattern of required) {
    assert.ok(
      AUTHZ_PATH_PATTERNS.includes(pattern),
      `AUTHZ_PATH_PATTERNS must include ${pattern} — otherwise routes under it bypass authz`
    );
  }
});

test("bare and nested paths under each prefix are covered", () => {
  for (const p of [
    "/",
    "/api",
    "/api/keys",
    "/dashboard",
    "/dashboard/providers",
    "/home",
    "/v1",
    "/v1/chat/completions",
    "/v0/management/usage",
  ]) {
    assert.equal(isAuthzPath(p), true, p);
  }
});

test("public non-API pages and the JSON-404 aliases bypass the pipeline, as before", () => {
  for (const p of [
    "/healthz",
    "/livez",
    "/readyz",
    "/a2a",
    "/login",
    "/docs/guides/i18n",
    "/callback",
    "/anthropic/v1/messages",
    "/openai/v1/models",
    "/metrics",
    "/debug",
    "/.env",
    "/models/x",
    "/sw.js",
  ]) {
    assert.equal(isAuthzPath(p), false, p);
  }
});

test("src/proxy.ts and src/middleware.ts are gone (the server bundle owns the pipeline)", () => {
  assert.ok(!fs.existsSync("src/proxy.ts"));
  assert.ok(!fs.existsSync("src/middleware.ts"));
});
