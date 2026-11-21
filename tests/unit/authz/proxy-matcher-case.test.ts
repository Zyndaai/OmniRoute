import { test } from "node:test";
import assert from "node:assert/strict";

import { isAuthzPath } from "../../../src/server/http/authzPaths.ts";
import { resolveRewrite } from "../../../src/server/http/rewrites.ts";
import { classifyRoute } from "../../../src/server/authz/classify.ts";

// Regression guard — GHSA-jvqc-mp9f-q936 (case-sensitive authz-matcher bypass).
//
// The rewrites route `/V1/chat/completions` to the same handler as `/v1/...`. If the authz
// path set matched only the lowercase spelling, the uppercase alias would reach the handler
// without the authz pipeline — an unauthenticated inference bypass. Both tables must match
// case-insensitively.

test("authz path set covers the canonical lowercase client aliases", () => {
  for (const p of [
    "/v1/chat/completions",
    "/v1/models",
    "/v1beta/models",
    "/responses",
    "/codex/x",
    "/models",
  ]) {
    assert.equal(isAuthzPath(p), true, `expected the authz pipeline to cover ${p}`);
  }
});

test("authz path set covers uppercase / mixed-case client aliases (GHSA-jvqc-mp9f-q936)", () => {
  for (const p of [
    "/V1/chat/completions",
    "/V1/models",
    "/V1BETA/models",
    "/CHAT/completions",
    "/RESPONSES",
    "/CODEX/x",
    "/MODELS",
    "/Responses/x",
    "/v1BeTa/models",
  ]) {
    assert.equal(isAuthzPath(p), true, `uppercase alias ${p} must reach the authz pipeline`);
    assert.notEqual(resolveRewrite(p), null, `${p} is rewritten to a handler`);
  }
});

test("every rewritten client alias is covered by the authz path set", () => {
  for (const p of ["/v1", "/v1beta", "/v0/management/usage", "/codex", "/chat/completions"]) {
    assert.notEqual(resolveRewrite(p), null);
    assert.equal(isAuthzPath(p), true, `${p}`);
  }
});

test("classifyRoute treats uppercase client aliases as CLIENT_API, not management fallback", () => {
  assert.equal(classifyRoute("/V1/chat/completions", "POST").routeClass, "CLIENT_API");
  assert.equal(classifyRoute("/V1BETA/models", "GET").routeClass, "CLIENT_API");
  assert.equal(classifyRoute("/MODELS", "GET").routeClass, "CLIENT_API");
  assert.equal(classifyRoute("/CODEX", "POST").routeClass, "CLIENT_API");
  // Lowercase behavior is unchanged.
  assert.equal(classifyRoute("/v1/chat/completions", "POST").routeClass, "CLIENT_API");
});
