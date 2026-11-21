/**
 * The framework packages must be pinned to exact versions.
 *
 * The image ships a prebuilt `.build/app` whose server bundle imports the React Router runtime
 * from node_modules at run time. That build output is coupled to the exact runtime that
 * produced it, so a caret range would let a fresh upstream release change the runtime under
 * an existing build. (Under Next.js this broke installs: Next 16.3.1 added `validationLevel` to
 * its server config schema and a build made by 16.2.12 crashed at boot.)
 *
 * `react`/`react-dom` are pinned exactly for the same reason, and package.json must match the
 * lockfile version the build actually uses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** Deps whose build output is coupled to the exact installed runtime. */
const MUST_BE_EXACT = [
  "react-router",
  "@react-router/node",
  "@react-router/dev",
  "react",
  "react-dom",
];

async function readJson(relative: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fileURLToPath(new URL(relative, ROOT)), "utf8"));
}

function declaredVersion(pkg: Record<string, unknown>, name: string): string | undefined {
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  return deps[name] ?? devDeps[name];
}

test("build-coupled dependencies are pinned to exact versions", async () => {
  const pkg = await readJson("package.json");
  const ranged = MUST_BE_EXACT.filter((name) => {
    const version = declaredVersion(pkg, name);
    return version !== undefined && !EXACT_VERSION.test(version);
  });
  assert.deepEqual(
    ranged,
    [],
    "these are coupled to the prebuilt output and must be pinned exactly: " +
      ranged.map((n) => `${n}@${declaredVersion(pkg, n)}`).join(", ")
  );
});

test("pinned framework versions match the lockfile versions the build uses", async () => {
  const pkg = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  const packages = (lock.packages ?? {}) as Record<string, { version?: string }>;

  for (const name of MUST_BE_EXACT) {
    const declared = declaredVersion(pkg, name);
    assert.ok(declared, `${name} missing from package.json`);
    const locked = packages[`node_modules/${name}`]?.version;
    assert.ok(locked, `${name} missing from package-lock.json`);
    assert.equal(declared, locked, `package.json declares ${name}@${declared}, lockfile ${locked}`);
  }
});

test("Next.js is no longer a dependency", async () => {
  const pkg = await readJson("package.json");
  assert.equal(declaredVersion(pkg, "next"), undefined);
});
