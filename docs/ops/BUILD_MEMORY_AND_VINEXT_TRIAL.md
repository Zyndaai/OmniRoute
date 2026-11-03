---
title: "Build Memory and vinext Trial"
version: 3.8.53
lastUpdated: 2026-11-01
---

# Build memory and vinext trial (2026-11-01)

Measurements and findings from trying to lower `next build` memory, and from a trial
build with [vinext](https://github.com/cloudflare/vinext) (Cloudflare's Vite-based
reimplementation of the Next.js API). The trial branch was deleted afterwards; this
page is the record.

**Outcome:** vinext builds 3–4× faster but does not meaningfully lower peak memory, and
it still has blocking gaps for this app. Limiting Next.js page-data workers lowers
memory but costs time. Since production images are built on GitHub Actions, where the
`Dockerfile` already limits workers, no local setting was changed.

## Environment

- Windows 11, 16 cores, 15.2 GB RAM
- Node.js 22.19.0, Next.js 16.4.2 (webpack; the build script picks webpack below 16 GB),
  React 19.2.8
- Commit `42277749` in an isolated worktree with its own `node_modules`
- Peak memory = summed working set of all `node` processes of the build, sampled every
  2 seconds

## Results

| Build                                                    | Time          | Peak memory | Node processes at peak |
| -------------------------------------------------------- | ------------- | ----------- | ---------------------- |
| `next build` (default: 15 page-data workers)             | 20.3 min      | 6.6 GB      | 16                     |
| `next build`, 1 page-data worker (`CIRCLE_NODE_TOTAL=2`) | 27.9 min      | 4.3 GB      | 2                      |
| `next build`, 1 worker + `reactCompiler: false`          | not completed | —           | —                      |
| vinext `vite build` (run 1)                              | 5.2 min       | 6.05 GB     | 4                      |
| vinext `vite build` (run 2)                              | 6.2 min       | 4.9 GB      | 4                      |

Notes:

- Webpack compile took 10.9 min of the default build; static generation of 659 pages
  took 88 s.
- The vinext builds ran without the React Compiler (it needs
  `vinext({ react: { compiler: true } })`), so their memory figure is optimistic.
- Standalone output: 882 MB (`next build`) vs 729 MB (vinext).
- The `Dockerfile` already defaults to 1 page-data worker
  (`OMNIROUTE_BUILD_WORKERS=2`, which sets `CIRCLE_NODE_TOTAL`), so CI image builds
  already use the low-memory setting.

## vinext compatibility scan

`vinext check` (vinext 1.4.0) rated the app 90% compatible: all `next/*` imports, 789
route handlers, 150 pages, `src/proxy.ts`, rewrites/redirects/headers, `basePath`,
`serverExternalPackages`, `transpilePackages`, server actions and `next-intl` are
supported. It flagged `experimental.proxyClientMaxBodySize` (ignored by vinext) and
`__dirname`/`__filename` use (only two app files matter:
`src/lib/copilot/codegraphKnowledge.ts` and `src/lib/system/autoUpdate.ts`).

## What it took to build

vinext needs React `^19.3.1` and `react-server-dom-webpack@19.3.1`, plus
`vinext@1.4.0` and `@vitejs/plugin-rsc@0.5.38`. The trial `vite.config.ts`:

```ts
import { defineConfig, type Plugin } from "vite";
import mdx from "fumadocs-mdx/vite";
import vinext from "vinext";

// Some routes import CLI scripts that start with `#!/usr/bin/env node`.
function stripHashbang(): Plugin {
  return {
    name: "omniroute:strip-hashbang",
    enforce: "pre",
    transform(code, id) {
      if (!code.startsWith("#!") || id.includes("/node_modules/")) return null;
      return { code: code.replace(/^#![^\n]*/, ""), map: null };
    },
  };
}

export default defineConfig({
  plugins: [stripHashbang(), mdx(), vinext()],
});
```

Three fixes were needed:

1. The in-app docs (Fumadocs) use a webpack loader; `fumadocs-mdx/vite` replaces it.
2. `src/app/api/system/env/repair/route.ts` imports `scripts/dev/sync-env.mjs`, which
   starts with a hashbang that breaks once Vite prepends imports (the plugin above).
3. A dead CommonJS guard (`require.main === module`) in
   `src/shared/services/initializeCloudSync.ts` made Node reject the built ES module
   with an "ambiguous module syntax" error, so every route returned 500. The guard can never be
   true under `"type": "module"`; it was removed from the code base as a fix in its own
   right.

## Smoke test (both builds side by side)

Same requests, fresh data directory, `REQUIRE_API_KEY=false`:

| Request                                                       | `next build` | vinext                                             |
| ------------------------------------------------------------- | ------------ | -------------------------------------------------- |
| `GET /api/monitoring/health`                                  | 200          | 200                                                |
| `GET /v1/models`                                              | 401          | 200, then 401 with the same `INITIAL_PASSWORD` set |
| `GET /login`, `GET /docs`                                     | 200          | 200                                                |
| `GET /.well-known/agent.json`, `/.well-known/agent-card.json` | 200          | **404**                                            |
| `GET` an unknown path under `/api`                            | 401          | 401                                                |
| `POST /v1/chat/completions` (unknown model)                   | same error   | same error                                         |

The `/v1/models` difference was environment only: the Next.js standalone output carries
a copy of `.env` (with `INITIAL_PASSWORD`) and loads it; vinext's server loads no `.env`.

## Open gaps before vinext could replace `next build`

1. Route folders starting with a dot are ignored, so the A2A agent card
   (`src/app/.well-known/*`) returns 404.
2. Runtime files are not copied into `dist/standalone`: 0 migration SQL files and 0
   compression rule files (Next.js copies them through `outputFileTracingIncludes`).
3. No `.env` loading at runtime (pass env vars explicitly instead).
4. Fonts imported through CSS (`@fontsource/inter`) are not emitted; the dashboard falls
   back to a system font.
5. Not ported or tested: the React Compiler option, large uploads (vinext ignores
   `proxyClientMaxBodySize`, today 512 MB), the custom webpack tweaks, and the
   `Dockerfile`/standalone scripts that expect `.build/next/standalone`.

## Windows build note

SWC refuses its native-binding cache when the cache folder grants replacement rights to
another account (the default `%LOCALAPPDATA%` and `D:\` locations both fail here). Set
`SWC_NATIVE_BINDING_CACHE` to a folder only you can write to, per command, for example
`C:\Users\<you>\.cache\swc-native-omniroute`.
