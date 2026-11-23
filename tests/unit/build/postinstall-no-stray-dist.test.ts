/**
 * `npm install` must not create a dist/ folder outside a published dist/ bundle.
 *
 * postinstall's copy steps for the old Next.js standalone bundle (sql.js, node-machine-id,
 * js-tiktoken into dist/node_modules) used to run unguarded, so every source checkout and the
 * Docker image's `npm ci` grew a stray dist/node_modules. The React Router build (.build/app)
 * resolves packages from the root node_modules, so those copies are never read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../scripts/build/postinstall.mjs", import.meta.url), "utf8");

function body(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in postinstall.mjs`);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

for (const name of ["ensureStandaloneRuntimePackages", "ensureOptionalPackages"]) {
  test(`${name} returns before copying anything when there is no dist/ bundle`, () => {
    const fn = body(name);
    const guard = fn.indexOf("if (!hasStandaloneAppBundle(ROOT)) return;");
    assert.notEqual(guard, -1, `${name} must check for a dist/ bundle first`);
    const firstCopy = Math.min(
      ...["cpSync(", "mkdirSync(", "colocateOptionalPackages("]
        .map((call) => fn.indexOf(call))
        .filter((i) => i !== -1)
    );
    assert.ok(guard < firstCopy, `${name} must return before its first copy`);
  });
}
