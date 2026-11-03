import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Production builds skip the webpack and Turbopack persistent caches unless the
// operator opts in with OMNIROUTE_BUILD_CACHE=1: a clean CI or Docker build never
// reads the cache back, and writing webpack's adds about 2.5 GB of peak build
// memory at a 6144 MB heap cap.
const repoRoot = process.cwd();
const nextConfigUrl = pathToFileURL(path.join(repoRoot, "next.config.mjs")).href;

async function withBuildCache<T>(value: string | undefined, run: () => Promise<T> | T) {
  const previous = process.env.OMNIROUTE_BUILD_CACHE;
  if (value === undefined) delete process.env.OMNIROUTE_BUILD_CACHE;
  else process.env.OMNIROUTE_BUILD_CACHE = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BUILD_CACHE;
    else process.env.OMNIROUTE_BUILD_CACHE = previous;
  }
}

// next.config.mjs reads the env when it is evaluated, so each case loads a fresh copy.
async function loadNextConfig(caseName: string) {
  return (await import(`${nextConfigUrl}?case=build-cache-${caseName}`)).default;
}

const nextConfig = await loadNextConfig("webpack");

const FILESYSTEM_CACHE = { type: "filesystem" };

function runWebpackHook(dev: boolean, optIn: string | undefined) {
  return withBuildCache(optIn, () => {
    const config: Record<string, unknown> = {
      cache: FILESYSTEM_CACHE,
      context: repoRoot,
      ignoreWarnings: [],
      optimization: { splitChunks: { cacheGroups: {} } },
      plugins: [],
    };
    nextConfig.webpack(config, { dev, isServer: true, defaultLoaders: { babel: {} }, webpack: {} });
    return config.cache;
  });
}

test("production webpack builds disable the persistent cache by default", async () => {
  assert.equal(await runWebpackHook(false, undefined), false);
});

test("only OMNIROUTE_BUILD_CACHE=1 keeps the production webpack cache", async () => {
  assert.equal(await runWebpackHook(false, "1"), FILESYSTEM_CACHE);
  assert.equal(await runWebpackHook(false, "true"), false);
  assert.equal(await runWebpackHook(false, "0"), false);
});

test("dev builds keep the cache Next configured", async () => {
  assert.equal(await runWebpackHook(true, undefined), FILESYSTEM_CACHE);
});

test("the Turbopack build cache follows the same opt-in", async () => {
  const off = await withBuildCache(undefined, () => loadNextConfig("unset"));
  assert.equal(off.experimental.turbopackFileSystemCacheForBuild, false);
  const on = await withBuildCache("1", () => loadNextConfig("on"));
  assert.equal(on.experimental.turbopackFileSystemCacheForBuild, true);
});

// Docker drops a --build-arg the stage never declares, so the opt-in has to be an
// ARG promoted to ENV inside the builder stage, before the build step runs.
for (const dockerfile of ["Dockerfile"]) {
  test(`${dockerfile} builder stage passes OMNIROUTE_BUILD_CACHE to the build`, () => {
    const lines = fs.readFileSync(path.join(repoRoot, dockerfile), "utf-8").split("\n");
    const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+builder\b/i.test(l.trim()));
    assert.ok(start >= 0, `${dockerfile} must have a builder stage`);
    const next = lines.slice(start + 1).findIndex((l) => /^FROM\s+/i.test(l.trim()));
    const stage = lines.slice(start, next === -1 ? lines.length : start + 1 + next);

    const argIdx = stage.findIndex((l) => /^ARG\s+OMNIROUTE_BUILD_CACHE\b/.test(l.trim()));
    const envIdx = stage.findIndex((l) =>
      /^ENV\s+OMNIROUTE_BUILD_CACHE=\$\{?OMNIROUTE_BUILD_CACHE\}?$/.test(l.trim())
    );
    const buildIdx = stage.findIndex(
      (l) => !l.trim().startsWith("#") && /\b(npm|bun) run (--quiet )?build\b/.test(l)
    );
    assert.ok(argIdx >= 0, `${dockerfile} builder stage must declare the ARG`);
    assert.ok(envIdx > argIdx, `${dockerfile} must promote the ARG to ENV`);
    assert.ok(buildIdx > envIdx, `${dockerfile} must set the ENV before the build step`);
  });
}
