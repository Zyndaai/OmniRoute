#!/usr/bin/env node

/**
 * OmniRoute — Co-locate dynamically loaded optional dependencies into a standalone bundle.
 *
 * `js-tiktoken` (exact token counting, `src/shared/utils/tiktokenCounter.ts`) is an
 * `optionalDependency` loaded through `createRequire`, which the Next.js standalone trace
 * cannot see. npm installs it into the ROOT `node_modules` on `--include=optional`; this step
 * copies its dependency closure into the bundle's `node_modules` so the runtime resolves it
 * from inside the bundle instead of falling back to the chars/4 estimate.
 *
 * Idempotent + fail-soft: skips when the optionals are absent or already co-located, never
 * overwrites a package the trace already materialized, and a per-package copy failure only
 * degrades token counting, so this never throws into the install or the build.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

/** Entry packages of the co-located optional closure. */
export const SEED_PACKAGES = ["js-tiktoken"];

/**
 * Compute the transitive dependency closure of `seeds` by walking each package's `dependencies` +
 * `optionalDependencies` from a `node_modules` directory. Packages that are not present in that
 * tree are skipped — the closure only contains packages that actually exist in `nodeModulesDir`.
 *
 * @param {string} nodeModulesDir absolute path to the source `node_modules`
 * @param {string[]} [seeds] closure roots (defaults to {@link SEED_PACKAGES})
 * @returns {string[]} package names in discovery order, seeds first
 */
export function computeDependencyClosure(nodeModulesDir, seeds = SEED_PACKAGES) {
  const closure = [];
  const seen = new Set();
  const stack = [...seeds];

  while (stack.length) {
    const name = stack.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const pkgDir = join(nodeModulesDir, name);
    if (!existsSync(pkgDir)) continue; // absent in this tree — skip

    closure.push(name);

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    } catch {
      continue; // unreadable/absent manifest — copy the dir but do not recurse
    }

    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const dep of Object.keys(deps)) {
      if (!seen.has(dep)) stack.push(dep);
    }
  }

  return closure;
}

/**
 * A package in the target tree counts as PRESENT only when its entrypoint
 * resolves from inside that tree — the same contract the Dockerfile's
 * post-build guard enforces. Next's file tracing can materialize a package
 * PARTIALLY (the package.json lands, the files its `main` points at do not),
 * and a directory-level `existsSync` check then skips the package forever
 * while the runtime dies with "Cannot find module <pkg>/dist/index.js".
 *
 * @param {string} targetNodeModulesDir
 * @param {string} name
 * @returns {boolean}
 */
function isPackageIntact(targetNodeModulesDir, name) {
  if (!existsSync(join(targetNodeModulesDir, name))) return false;
  try {
    const probe = createRequire(join(targetNodeModulesDir, "__colocate_probe__.js"));
    const resolved = probe.resolve(name);
    // A resolution that walked past the target into an ancestor tree does not
    // prove the target copy is usable.
    const realTarget = realpathSync(targetNodeModulesDir);
    const realResolved = realpathSync(resolved);
    return realResolved.startsWith(realTarget + sep);
  } catch {
    return false;
  }
}

/**
 * Co-locate the optional dependency closure from `<rootDir>/node_modules`
 * into a standalone bundle's `node_modules`.
 *
 * The default destination remains `<rootDir>/dist/node_modules` for the npm
 * postinstall path. Standalone builders, including Docker, may provide
 * `targetNodeModulesDir`.
 *
 * Packages already present in the destination are never overwritten. This
 * preserves the standalone bundle's pinned dependency instances while filling
 * dynamically loaded packages that Next.js did not trace.
 *
 * @param {{
 *   rootDir: string,
 *   targetNodeModulesDir?: string,
 *   seeds?: string[],
 *   log?: (message: string) => void
 * }} opts
 * @returns {{ skipped: true, reason: string }
 *   | { skipped: false, copied: number, closure: number }}
 */
export function colocateOptionalPackages({
  rootDir,
  targetNodeModulesDir,
  seeds = SEED_PACKAGES,
  log = () => {},
}) {
  const rootNm = join(rootDir, "node_modules");
  const targetNm = targetNodeModulesDir ?? join(rootDir, "dist", "node_modules");

  if (!existsSync(targetNm)) {
    return {
      skipped: true,
      reason: targetNodeModulesDir ? "no target node_modules" : "no standalone dist/node_modules",
    };
  }

  // Only run when every requested closure root was installed.
  if (!seeds.every((seed) => existsSync(join(rootNm, seed)))) {
    return { skipped: true, reason: "optional packages not installed at root" };
  }

  const closure = computeDependencyClosure(rootNm, seeds);

  // Check the complete closure rather than only the entry package, and judge
  // presence by entrypoint integrity — a partially traced directory (see
  // isPackageIntact) must still receive its missing files.
  if (closure.length > 0 && closure.every((name) => isPackageIntact(targetNm, name))) {
    return { skipped: true, reason: "already co-located" };
  }

  let copied = 0;

  for (const name of closure) {
    const dest = join(targetNm, name);
    if (isPackageIntact(targetNm, name)) continue;

    try {
      mkdirSync(dirname(dest), { recursive: true });
      // force:false merges into a partially traced directory: files the trace
      // already materialized are kept, missing ones (the package payload) are
      // filled in from the root tree.
      cpSync(join(rootNm, name), dest, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      copied++;
    } catch (err) {
      log(`  ⚠️  optional package co-location failed for ${name}: ${err.message}`);
    }
  }

  if (copied > 0) {
    log(`  ✅ Co-located ${copied} optional package(s) into standalone node_modules.\n`);
  }

  return { skipped: false, copied, closure: closure.length };
}
