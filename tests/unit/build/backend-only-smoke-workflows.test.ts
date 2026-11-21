// API-only smoke/nightly workflows build with OMNIROUTE_BUILD_BACKEND_ONLY=1 so the build skips
// the dashboard page graph they never exercise (#7226: without it a smoke run silently pays for
// the full UI build). This file pins how scripts/build/build.mjs turns that switch, the build
// heap and the service-worker id into the environment of `react-router build`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveBuildDir,
  resolveBuildEnv,
  resolveSwBuildId,
  stampServiceWorker,
} from "../../../scripts/build/build.mjs";

type RouteEntry = { file: string; children?: RouteEntry[] };

async function routeFiles(backendOnly: string | undefined): Promise<string[]> {
  const previous = process.env.OMNIROUTE_BUILD_BACKEND_ONLY;
  if (backendOnly === undefined) delete process.env.OMNIROUTE_BUILD_BACKEND_ONLY;
  else process.env.OMNIROUTE_BUILD_BACKEND_ONLY = backendOnly;
  try {
    // The route table is computed when routes.ts is evaluated, so load a fresh copy per case.
    const { default: routes } = (await import(
      `../../../src/app/routes.ts?backendOnly=${backendOnly}`
    )) as { default: RouteEntry[] };
    const files: string[] = [];
    const walk = (entries: RouteEntry[]) => {
      for (const entry of entries) {
        files.push(entry.file);
        if (entry.children) walk(entry.children);
      }
    };
    walk(routes);
    return files;
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BUILD_BACKEND_ONLY;
    else process.env.OMNIROUTE_BUILD_BACKEND_ONLY = previous;
  }
}

test("the build passes OMNIROUTE_BUILD_BACKEND_ONLY through to the route table", () => {
  assert.equal(
    resolveBuildEnv({ OMNIROUTE_BUILD_BACKEND_ONLY: "1" }).OMNIROUTE_BUILD_BACKEND_ONLY,
    "1"
  );
});

test("OMNIROUTE_BUILD_BACKEND_ONLY=1 leaves every page and layout out of the route table", async () => {
  const files = await routeFiles("1");
  assert.ok(files.length > 0, "the endpoints are still routed");
  assert.deepEqual(
    files.filter((file) => /(page|layout)\.tsx$/.test(file)),
    []
  );
});

test("the full build routes pages by default", async () => {
  for (const flag of [undefined, "0"]) {
    const files = await routeFiles(flag);
    assert.ok(
      files.some((file) => file.endsWith("page.tsx")),
      `pages routed with flag=${flag}`
    );
  }
});

test("the build does not mutate the environment it was given", () => {
  const env = { NODE_ENV: "test" };
  resolveBuildEnv(env);
  assert.deepEqual(env, { NODE_ENV: "test" });
});

// A local `npm run build` stalled or ran out of memory on V8's default heap of about 2 GB.
test("the build heap defaults to at least 4096 MB", () => {
  const match = (resolveBuildEnv({}).NODE_OPTIONS ?? "").match(/--max-old-space-size=(\d+)/);
  assert.ok(match, "the build must set --max-old-space-size");
  assert.ok(Number(match[1]) >= 4096, `got ${match[1]} MB`);
});

test("an existing --max-old-space-size (Docker) is not duplicated or overridden", () => {
  const env = resolveBuildEnv({ NODE_OPTIONS: "--max-old-space-size=8192 --trace-warnings" });
  assert.equal((env.NODE_OPTIONS.match(/--max-old-space-size=/g) || []).length, 1);
  assert.match(env.NODE_OPTIONS, /--max-old-space-size=8192/);
});

test("OMNIROUTE_BUILD_MEMORY_MB sets the heap and keeps other NODE_OPTIONS", () => {
  const env = resolveBuildEnv({
    OMNIROUTE_BUILD_MEMORY_MB: "6144",
    NODE_OPTIONS: "--trace-warnings",
  });
  assert.equal(env.NODE_OPTIONS, "--trace-warnings --max-old-space-size=6144");
});

test("one service-worker build id is fixed for the whole run", () => {
  assert.equal(resolveBuildEnv({ OMNIROUTE_SW_BUILD_ID: "abc" }).OMNIROUTE_SW_BUILD_ID, "abc");
  assert.equal(resolveSwBuildId({ SOURCE_VERSION: "sha1" }, 5), "sha1");
  assert.equal(resolveSwBuildId({}, 1234), "1234");
  assert.equal(resolveSwBuildId({ OMNIROUTE_SW_BUILD_ID: "x", SOURCE_VERSION: "y" }, 1), "x");
  const env = resolveBuildEnv({});
  assert.ok(env.OMNIROUTE_SW_BUILD_ID, "the id is set so the browser bundle and sw.js agree");
});

test("resolveBuildDir defaults to .build/app and honors OMNIROUTE_BUILD_DIR", () => {
  assert.equal(resolveBuildDir({}, "/repo"), resolve("/repo", ".build/app"));
  assert.equal(
    resolveBuildDir({ OMNIROUTE_BUILD_DIR: "out/x" }, "/repo"),
    resolve("/repo", "out/x")
  );
});

const SW_SOURCE = [
  "// service worker",
  'const CACHE_NAME = "omniroute-pwa-v3";',
  'const BASE_PATH = "";',
  "self.addEventListener('fetch', () => {});",
].join("\n");

test("stampServiceWorker puts the build id in the cache name and the base path in BASE_PATH", () => {
  const out = stampServiceWorker(SW_SOURCE, { buildId: "b42", basePath: "/omni" });
  assert.match(out, /^const CACHE_NAME = "omniroute-pwa-v3-b42";/m);
  assert.match(out, /^const BASE_PATH = "\/omni";$/m);
  assert.ok(out.includes("self.addEventListener"), "the rest of the worker is untouched");
});

test("the real public/sw.js carries both lines the build stamps", () => {
  const out = stampServiceWorker(readFileSync("public/sw.js", "utf8"), {
    buildId: "b42",
    basePath: "/omni",
  });
  assert.match(out, /omniroute-pwa-v3-b42/);
  assert.match(out, /^const BASE_PATH = "\/omni";$/m);
});

test("stampServiceWorker fails when a stamped line is missing", () => {
  assert.throws(
    () =>
      stampServiceWorker(SW_SOURCE.replace('const BASE_PATH = "";', ""), {
        buildId: "b",
        basePath: "",
      }),
    /sw\.js must contain/
  );
  assert.throws(
    () =>
      stampServiceWorker('const CACHE_NAME = "other";\nconst BASE_PATH = "";', {
        buildId: "b",
        basePath: "",
      }),
    /sw\.js must contain/
  );
});
