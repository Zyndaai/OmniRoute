import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const BROWSER_POOL_PATHS = [
  path.join(REPO_ROOT, "open-sse/services/browserPool.ts"),
  path.join(REPO_ROOT, "packages/browser-pool/src/services/browserPool.ts"),
];

describe("browserPool optional cloakbrowser import", () => {
  it("keeps cloakbrowser out of static dynamic import resolution", () => {
    for (const browserPoolPath of BROWSER_POOL_PATHS) {
      const source = readFileSync(browserPoolPath, "utf8");

      assert.equal(
        /import\(\s*["']cloakbrowser["']\s*\)/.test(source),
        false,
        "cloakbrowser must remain runtime-optional; a literal dynamic import makes the bundler resolve it"
      );
      assert.match(
        source,
        /makes the bundler try to resolve it at build time/,
        "the computed import rationale should stay documented near the helper"
      );
      assert.match(source, /return \["cloak", "browser"\]\.join\(""\);/);
      assert.match(
        source,
        /\/\* @vite-ignore \*\//,
        "Vite must leave the optional runtime import unresolved without warning"
      );
    }
  });
});
