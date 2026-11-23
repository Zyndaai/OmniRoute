import test from "node:test";
import assert from "node:assert/strict";

import { REDIRECT_STATUS, REDIRECTS, resolveRedirect } from "../../../src/server/http/redirects.ts";

test("renamed pages redirect permanently (308)", () => {
  assert.equal(REDIRECT_STATUS, 308);
});

test("/dashboard/cli-tools redirects to /dashboard/cli-code, with and without a tail", () => {
  assert.equal(resolveRedirect("/dashboard/cli-tools"), "/dashboard/cli-code");
  assert.equal(resolveRedirect("/dashboard/cli-tools/claude"), "/dashboard/cli-code/claude");
  assert.equal(resolveRedirect("/dashboard/cli-tools/a/b"), "/dashboard/cli-code/a/b");
});

test("/dashboard/agents redirects to /dashboard/acp-agents, with and without a tail", () => {
  assert.equal(resolveRedirect("/dashboard/agents"), "/dashboard/acp-agents");
  assert.equal(resolveRedirect("/dashboard/agents/x"), "/dashboard/acp-agents/x");
});

test("other dashboard renames", () => {
  assert.equal(resolveRedirect("/dashboard/providers/freepik"), "/dashboard/providers/magnific");
  assert.equal(resolveRedirect("/dashboard/skills"), "/dashboard/omni-skills");
  assert.equal(resolveRedirect("/dashboard/skills/x"), null);
});

test("58 rules: 52 docs pages plus 6 dashboard renames", () => {
  assert.equal(REDIRECTS.length, 58);
  assert.equal(REDIRECTS.filter((rule) => rule.source.startsWith("/docs/")).length, 52);
  assert.equal(resolveRedirect("/docs/features"), "/docs/guides/features");
  assert.equal(resolveRedirect("/docs/architecture"), "/docs/architecture/architecture");
  assert.equal(resolveRedirect("/docs/architecture/architecture"), null);
});

test("matching is case-insensitive and a trailing slash is removed first", () => {
  assert.equal(resolveRedirect("/Docs/Features"), "/docs/guides/features");
  assert.equal(resolveRedirect("/api/v1/models/"), "/api/v1/models");
  assert.equal(resolveRedirect("/"), null);
  assert.equal(resolveRedirect("/dashboard"), null);
});
