import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";

const repoRoot = process.cwd();

test("Tailwind scans only the UI source roots declared by OmniRoute (#12074 phase 1)", () => {
  const css = readFileSync(path.join(repoRoot, "src/app/globals.css"), "utf8");

  assert.match(
    css,
    /@import\s+"tailwindcss"\s+source\(none\);/,
    "automatic repository-wide Tailwind source detection must stay disabled"
  );
  assert.match(css, /@source\s+"\.\.\/app";/, "App Router components must stay scanned");
  assert.match(css, /@source\s+"\.\.\/shared";/, "shared UI components must stay scanned");
  assert.match(
    css,
    /@source\s+"\.\.\/\.\.\/node_modules\/fumadocs-ui\/dist\/\*\*\/\*\.js";/,
    "Fumadocs runtime classes must stay scanned"
  );
});
