import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { matchRoutes } from "react-router";

import { urlPatterns } from "../../src/app/routeConvention.ts";

/**
 * `src/app/[...rest]/page.tsx` answers every URL that no other route matches with a 404 that
 * runs the root loader (so the 404 page is localised). It must never take a URL that the JSON
 * catch-alls under `/api/*` and `/api/v1/*` serve.
 */

const APP_DIR = path.join(process.cwd(), "src", "app");

/** Every URL pattern served by a `page.tsx` or `route.ts` below `src/app`, with its source. */
function collectRoutes(dir: string, folders: string[] = []) {
  const found: Array<{ path: string; file: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...collectRoutes(path.join(dir, entry.name), [...folders, entry.name]));
    } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
      for (const pattern of urlPatterns(folders)) {
        found.push({ path: pattern, file: [...folders, entry.name].join("/") });
      }
    }
  }
  return found;
}

const routes = collectRoutes(APP_DIR);

function winner(url: string): string | undefined {
  const matches = matchRoutes(
    routes.map((route) => ({ path: route.path, id: route.file })),
    url
  );
  return matches?.at(-1)?.route.id;
}

test("the folder maps to the top-level splat", () => {
  assert.deepEqual(urlPatterns(["[...rest]"]), ["/*"]);
});

test("an unknown page URL is matched by the not-found route", () => {
  assert.equal(winner("/no-such-page"), "[...rest]/page.tsx");
  assert.equal(winner("/dashboard/no/such/page"), "[...rest]/page.tsx");
  assert.equal(winner("/openai/v1/chat/completions"), "[...rest]/page.tsx");
});

test("the JSON catch-alls keep /api/* and /api/v1/*", () => {
  assert.equal(winner("/api/no-such-endpoint"), "api/[...omnirouteApiCatchAll]/route.ts");
  assert.equal(winner("/api/no/such/endpoint"), "api/[...omnirouteApiCatchAll]/route.ts");
  assert.match(winner("/api/v1/no-such-endpoint") ?? "", /^api\/v1\/\[\.\.\.\w+\]\/route\.ts$/);
});

test("known pages and endpoints are not taken by the not-found route", () => {
  assert.equal(winner("/login"), "login/page.tsx");
  assert.equal(winner("/"), "page.tsx");
  assert.equal(winner("/api/v1/models"), "api/v1/models/route.ts");
});
