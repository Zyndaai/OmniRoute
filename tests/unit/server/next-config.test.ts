import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { REWRITES, resolveRewrite } from "../../../src/server/http/rewrites.ts";
import { SECURITY_HEADERS, securityHeadersFor } from "../../../src/server/http/securityHeaders.ts";
import { shouldStubBetterSqlite3 } from "../../../scripts/build/better-sqlite3-stub-flag.mjs";
import { shouldStubMitmManager } from "../../../scripts/build/mitm-stub-flag.mjs";

test("security headers carry the strict default policy", () => {
  const headers = Object.fromEntries(securityHeadersFor("/dashboard", null));

  assert.equal(headers["Content-Security-Policy"], SECURITY_HEADERS[0][1]);
  assert.match(headers["Content-Security-Policy"], /default-src 'self'/);
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(headers["Strict-Transport-Security"], /includeSubDomains/);
});

test("canonical rewrites put the client-API aliases first, in order", () => {
  assert.deepEqual(REWRITES.slice(0, 4), [
    { source: "/chat/completions", destination: "/api/v1/chat/completions" },
    { source: "/responses", destination: "/api/v1/responses" },
    { source: "/responses/:path*", destination: "/api/v1/responses/:path*" },
    { source: "/models", destination: "/api/v1/models" },
  ]);
  assert.equal(resolveRewrite("/chat/completions"), "/api/v1/chat/completions");
  assert.equal(resolveRewrite("/responses/abc"), "/api/v1/responses/abc");
  assert.equal(resolveRewrite("/dashboard"), null);
});

test("the @/mitm/manager stub is aliased ONLY when OMNIROUTE_MITM_STUB=1 (#6344)", () => {
  // A default production build must NOT alias it, or the stub ships to npm/Electron/VPS
  // artifacts and Agent Bridge start breaks.
  assert.equal(shouldStubMitmManager({}), false);
  assert.equal(shouldStubMitmManager({ OMNIROUTE_MITM_STUB: "0" }), false);
  assert.equal(shouldStubMitmManager({ OMNIROUTE_MITM_STUB: "1" }), true);
});

test("the better-sqlite3 stub is aliased ONLY when OMNIROUTE_BETTER_SQLITE3_STUB=1 (#11343)", () => {
  // An alias is applied before the bundler decides what stays external, so an unconditional
  // alias bakes the stub into the server bundle and every route answers 500 at runtime.
  assert.equal(shouldStubBetterSqlite3({}), false);
  assert.equal(shouldStubBetterSqlite3({ OMNIROUTE_BETTER_SQLITE3_STUB: "0" }), false);
  assert.equal(shouldStubBetterSqlite3({ OMNIROUTE_BETTER_SQLITE3_STUB: "1" }), true);
});

// ── manager.stub.ts must cover every static @/mitm/manager import (issue #3066) ──
//
// The build aliases `@/mitm/manager` → `manager.stub.ts` in Docker. Any route that statically
// imports a name the stub doesn't export breaks that build with "Export X doesn't exist in
// target module". This guard fails on that drift — it is what would have caught the missing
// getAllAgentsStatus export in #3066.

test("manager.stub.ts exports every name statically imported from @/mitm/manager", () => {
  const srcDir = path.join(process.cwd(), "src");

  // Collect value names imported via `... from "@/mitm/manager"` across ALL of src/ —
  // not just src/app: src/lib/tailscaleTunnel.ts imports from it and is pulled into
  // routes transitively, so a src/app-only scan would miss that surface. NOT
  // manager.runtime (loaded via dynamic import(), resolves to the real module at
  // runtime). Inline `type` imports are erased at build time and need no stub export.
  const collectImports = (dir: string, acc: Set<string>): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectImports(full, acc);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf-8");
      const re = /import\s*\{([^}]*)\}\s*from\s*["']@\/mitm\/manager["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        for (const raw of m[1].split(",")) {
          const token = raw.trim();
          if (!token || /^type\s/.test(token)) continue; // type-only import: no runtime export needed
          const name = token.split(/\s+as\s+/)[0].trim();
          if (name) acc.add(name);
        }
      }
    }
  };

  const imported = new Set<string>();
  collectImports(srcDir, imported);

  // Sanity: the guard is meaningless if the scan finds nothing to check. Kept generic
  // (>= 1 import) rather than asserting a specific symbol, so the test stays valid if any
  // single agent-bridge/traffic-inspector route is later renamed or removed.
  assert.ok(imported.size > 0, "expected at least one static @/mitm/manager import in src/");

  const stubSrc = fs.readFileSync(
    path.join(process.cwd(), "src", "mitm", "manager.stub.ts"),
    "utf-8"
  );
  // Collect stub exports from both declaration forms and named re-export blocks so the
  // guard doesn't false-positive if the stub later uses `export class` / `export { … }`.
  const stubExports = new Set<string>();
  for (const m of stubSrc.matchAll(
    /export\s+(?:const|let|var|class|function|async\s+function)\s+([A-Za-z0-9_]+)/g
  )) {
    stubExports.add(m[1]);
  }
  for (const m of stubSrc.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const exported = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim(); // `x as y` exports y
      if (exported) stubExports.add(exported);
    }
  }

  const missing = [...imported].filter((name) => !stubExports.has(name));
  assert.deepEqual(
    missing,
    [],
    `manager.stub.ts is missing exports statically imported by routes: ${missing.join(", ")}`
  );
});
