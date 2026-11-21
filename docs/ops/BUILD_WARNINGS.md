---
title: "Build Warnings Reference"
version: 3.8.52
lastUpdated: 2026-10-18
---

# Build Warnings Reference

`npm run build` (React Router + Vite, `scripts/build/build.mjs`) can print warnings that
do not mean the artifact is broken. This page says which ones are known and what they mean,
so an operator can tell known build-time noise from a real regression.

> The build used to run on Next.js with webpack or Turbopack. The warnings that page
> catalogued (webpack "Critical dependency" for the Codex executor, the Fumadocs MDX
> `webpack.cache` message, and the log lines printed while Next collected page data) belong
> to that toolchain, and `scripts/build/knownBuildWarnings.mjs` that suppressed one of them no
> longer exists. The Vite build has no page-data collection step, so it does not import
> application modules to run them. Whether a given message still appears has not been
> re-catalogued: if you see one, treat it as new and investigate it.

## Dynamic `require` in `open-sse/executors/codex/wreqLoader.ts` is intentional

`open-sse/executors/codex/wreqLoader.ts` loads the optional `wreq-js` native helper through a
`createRequire()`-returned function whose specifier is kept as a **variable** on purpose
(`Reflect.apply(requireFn, undefined, [moduleName])`). A bundler that sees a literal specifier
may rewrite the call into a bundled require target that is absent from the Docker runtime
image, so the dynamic form is required (#12491). Do not "simplify" it to a string literal.

### `[SECURITY] FATAL: JWT_SECRET is not set`

`JWT_SECRET` is **required at runtime** — without it, login fails closed and the dashboard
is unreachable. Set it in your environment before starting the server (see
`../reference/ENVIRONMENT.md`). The module-level warning in
`src/app/api/auth/login/route.ts` fires whenever the variable is unset when that module
loads, and the request handler returns `500` when the secret is missing.

## Bun and dependency installation

OmniRoute is built and run with **Node.js** (`engines.node` in `package.json`). Install
dependencies with `npm ci` (or `npm install`):

```bash
npm ci
npm run build
```

**`bun install` is not a supported way to install OmniRoute's dependencies** for this
branch. Bun `1.4.2` is pinned as a devDependency and is used only to run a small,
allow-listed set of gate/generator scripts. If you install with Bun you may see:

- `warn: Bun currently only supports one level of nested "overrides"` — Bun's support for
  `package.json` `overrides` is shallower than npm's; npm applies the full tree.
- **Blocked lifecycle scripts** for native packages (Playwright Chromium,
  SWC, protobufjs, Parcel Watcher, unrs-resolver). Bun blocks install scripts by default;
  the supported `npm ci` path runs them, and `npm run check:native-deps` verifies that
  every externalized package resolves afterward.

### Bun script-runner failures

Bun runs only the allow-listed gate/generator scripts (`check:provider-consistency`,
`check:compression-budget`, `check:known-symbols`, `gen:provider-reference`,
`bench:compression`) plus the `test:bun:db` smoke suite — see `AGENTS.md` → Environment.
After pulling the lockfile change, run `npm install` so `bun` resolves locally (a stale
`node_modules` will fail those scripts with `bun: not found`).

**Two distinct Bun failures, two different fixes — do not confuse them.**

- **(a) `bun: not found`** → the tree is stale; `npm install`.
- **(b) Bun exists but refuses to run** → `node_modules/bun/bin/bun.exe` is still the
  ~450-byte **bash placeholder** the package ships, because its `postinstall` was skipped
  (`npm install --ignore-scripts`, or a package manager that skips lifecycle scripts). The real
  binary is already on disk in the platform package (e.g.
  `node_modules/@oven/bun-windows-x64/bin/bun.exe`, ~86 MB), so nothing is missing and
  re-running `npm install` on an already-satisfied tree may not fix it. Fix:
  `cd node_modules/bun && node install.js`.

**On Windows the error is actively misleading** — `cmd.exe` asks the loader to run a bash
script, which reports `This version of … is not compatible with the version of Windows you're running`,
which reads like an OS/architecture problem but means "this is not a Windows executable".
Confirm the real cause with `ls -l node_modules/bun/bin/bun.exe` (a few hundred bytes =
placeholder). Either way `node --import tsx <script>` is the validated byte-identical fallback
for all four scripts.
