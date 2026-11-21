import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The MCP SDK client graph contains a module-level `class extends Client` cycle against the
// async Client module. A bundler that inlines it can throw `ReferenceError: Cannot access 'l'
// before initialization` during module evaluation, which takes down /api/mcp/stream with
// HTTP 500 on every initialize. Node's native ESM loader resolves the same circular graph
// through live bindings, so the SDK must stay external to the server bundle.
//
// The server build keeps every package listed in `dependencies` external by default; the SDK
// stays external as long as it is such a dependency and the build never forces it in.
test("the MCP SDK is a runtime dependency and is never forced into the server bundle", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.ok(
    pkg.dependencies?.["@modelcontextprotocol/sdk"],
    "@modelcontextprotocol/sdk must be a runtime dependency so the server bundle leaves it external"
  );

  const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
  // Anchor: the build config itself, so the guard below cannot pass against a moved file.
  assert.match(viteConfig, /reactRouter\(\)/);
  assert.doesNotMatch(
    viteConfig,
    /noExternal/,
    "vite.config.ts must not set ssr.noExternal: it would bundle the SDK's circular graph"
  );
});
