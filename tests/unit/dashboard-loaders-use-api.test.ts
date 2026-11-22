/**
 * Dashboard loaders and actions read through the API routes (`apiJson()` / `apiAction()` in
 * src/server/routing/dashboardApi.server.ts), never through the DB modules directly: a `/dashboard`
 * request passes the authz pipeline as a dashboard page, so rules judged on the `/api/...` path
 * (LOCAL_ONLY, always-protected routes under requireLogin=false, access-token scopes,
 * session-only routes) would not apply to a direct read. Type-only imports are fine.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DASHBOARD_DIR = path.join(ROOT, "src", "app", "(dashboard)");

/** Value imports of these modules give a page server-side data without the API path's rules. */
const SERVER_DATA_MODULE = /^(@\/lib\/db(\/|$)|@\/sse\/services(\/|$)|(\.\.\/)+.*lib\/db(\/|$))/;

/**
 * Known direct reads. Each returns only a yes/no to the page, never row data.
 * Converting one to `apiJson()` removes it from this list.
 */
const ALLOWED: Record<string, string> = {
  "src/app/(dashboard)/dashboard/tools/agent-bridge/page.tsx":
    "getProviderConnections() -> hasProviders boolean only",
  "src/app/(dashboard)/home/loadHomeSettings.ts": "getSettings() -> setupComplete only",
};

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") yield* sourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Module specifiers of value (non-`import type`) imports and re-exports in `source`. */
function valueImports(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /\b(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (match[5]) {
      specifiers.push(match[5]);
      continue;
    }
    if (match[2]) continue; // `import type ... from`
    const clause = match[3].trim();
    // `import { type A, type B } from` imports nothing at runtime either.
    const named = /^\{([\s\S]*)\}$/.exec(clause);
    if (named && named[1].split(",").every((part) => /^\s*(type\s+\S|$)/.test(part))) continue;
    specifiers.push(match[4]);
  }
  return specifiers;
}

test("dashboard pages do not import DB or SSE service modules for their data", () => {
  const offenders: string[] = [];
  const seenAllowed = new Set<string>();
  for (const file of sourceFiles(DASHBOARD_DIR)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const hits = valueImports(fs.readFileSync(file, "utf8")).filter((spec) =>
      SERVER_DATA_MODULE.test(spec)
    );
    if (hits.length === 0) continue;
    if (ALLOWED[rel]) {
      seenAllowed.add(rel);
      continue;
    }
    offenders.push(`${rel}: ${hits.join(", ")}`);
  }
  assert.deepEqual(offenders, [], "read through apiJson()/apiAction() instead");
  assert.deepEqual(
    Object.keys(ALLOWED).filter((rel) => !seenAllowed.has(rel)),
    [],
    "remove allow-list entries that no longer import a DB module"
  );
});

test("the import scanner tells type-only imports from value imports", () => {
  assert.deepEqual(
    valueImports(
      [
        'import type { A } from "@/lib/db/a";',
        'import { type B, type C } from "@/lib/db/b";',
        'import { getX } from "@/lib/db/x";',
        'import { type D, getY } from "@/lib/db/y";',
        'const m = await import("@/lib/db/z");',
      ].join("\n")
    ),
    ["@/lib/db/x", "@/lib/db/y", "@/lib/db/z"]
  );
});
