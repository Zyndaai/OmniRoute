/**
 * The root error boundary (`src/app/root.tsx`) embeds hardcoded copies of the en.json
 * not-found / error strings for when no catalog is loaded (a 404 runs no loader);
 * importing the whole catalog would ship it with every page. These tests fail when the
 * copies drift from en.json.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/** Parses the `key: "value"` pairs of a `const NAME = { ... } as const;` literal in `source`. */
function readFallbackLiteral(source: string, name: string): Record<string, string> {
  const match = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\} as const;`));
  assert.ok(match, `${name} literal not found in root.tsx`);
  const actual: Record<string, string> = {};
  const pairRe = /(?:"([^"]+)"|([A-Za-z0-9_]+))\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let pair: RegExpExecArray | null;
  while ((pair = pairRe.exec(match[1])) !== null) {
    const key = pair[1] ?? pair[2];
    actual[key] = JSON.parse(`"${pair[3]}"`);
  }
  return actual;
}

test("root error boundary fallback strings stay in sync with en.json", () => {
  const en = JSON.parse(
    readFileSync(join(REPO_ROOT, "src", "i18n", "messages", "en.json"), "utf8")
  );
  const source = readFileSync(join(REPO_ROOT, "src", "app", "root.tsx"), "utf8");

  assert.deepEqual(
    readFallbackLiteral(source, "FALLBACK_EN_NOT_FOUND"),
    en.publicSystem.notFound,
    "FALLBACK_EN_NOT_FOUND drifted from en.json publicSystem.notFound"
  );
  assert.deepEqual(
    readFallbackLiteral(source, "FALLBACK_EN_ERROR"),
    en.publicSystem.error,
    "FALLBACK_EN_ERROR drifted from en.json publicSystem.error"
  );
  assert.deepEqual(
    readFallbackLiteral(source, "FALLBACK_EN_COMMON"),
    { goToDashboard: en.common.goToDashboard },
    "FALLBACK_EN_COMMON drifted from en.json common.goToDashboard"
  );
});

test("root.tsx does not import a full locale catalog", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "app", "root.tsx"), "utf8");
  assert.ok(
    !/^\s*import\s+.*from\s+["']@\/i18n\/messages\//m.test(source),
    "root.tsx must not import from @/i18n/messages/* (ships ~870 KB on every page)"
  );
  assert.doesNotMatch(
    source,
    /import\s*\(\s*[`"'][^`"']*i18n\/messages\//,
    "lazy imports must also keep full catalogs outside the client bundle"
  );
});
