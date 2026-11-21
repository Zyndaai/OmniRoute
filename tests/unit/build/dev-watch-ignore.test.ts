/**
 * The Vite dev server watches only the app's own folders. Watching the whole repository root
 * froze `npm run dev` past Vite's 60 s module-load timeout on Windows (one synchronous native
 * watch per file), so tests/, build output and scratch folders must stay unwatched. Root files
 * are unwatched too: an edit there made Vite restart in place under the running boot jobs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createDevWatchIgnore } from "../../../scripts/build/dev-watch-ignore.mjs";

const ignored = createDevWatchIgnore("D:\\work\\OmniRoute");
const DIRECTORY = { isDirectory: () => true };
const FILE = { isDirectory: () => false };

test("app source and docs content stay watched", () => {
  for (const file of [
    "D:\\work\\OmniRoute\\src\\app\\root.tsx",
    "D:/work/OmniRoute/open-sse/handlers/chatCore.ts",
    "D:/work/OmniRoute/packages/ui-kit/src/button.tsx",
    "D:/work/OmniRoute/docs/guides/FEATURES.md",
    "D:/work/OmniRoute/public/favicon.svg",
    "D:/work/OmniRoute/.source/server.ts",
    "D:/work/OmniRoute",
  ]) {
    assert.equal(ignored(file), false, file);
  }
  for (const dir of ["src", "open-sse", "docs", ".source"]) {
    assert.equal(ignored(`D:/work/OmniRoute/${dir}`, DIRECTORY), false, dir);
  }
});

test("root files are not watched, so a config edit never restarts Vite in place", () => {
  assert.equal(ignored("D:/work/OmniRoute/vite.config.ts", FILE), true);
  assert.equal(ignored("D:/work/OmniRoute/.env", FILE), true);
  // A root entry seen without stats is kept: ignoring a watched folder would stop hot reload.
  assert.equal(ignored("D:/work/OmniRoute/src"), false);
});

test("non-app top-level folders are skipped as a whole", () => {
  for (const dir of ["tests", ".build", "_artifacts", "coverage", ".react-router"]) {
    assert.equal(ignored(`D:/work/OmniRoute/${dir}`, DIRECTORY), true, dir);
  }
});

test("tests, build output and private root folders are not watched", () => {
  for (const file of [
    "D:\\work\\OmniRoute\\tests\\unit\\x.test.ts",
    "D:/work/OmniRoute/.build/app/server/index.js",
    "D:/work/OmniRoute/_artifacts/rr-port/notes.md",
    "D:/work/OmniRoute/coverage/lcov.info",
    "D:/work/OmniRoute/open-sse/mcp-server/__tests__/tool.test.ts",
  ]) {
    assert.equal(ignored(file), true, file);
  }
});

test("paths outside the root are left to Vite's defaults", () => {
  assert.equal(ignored("C:/Users/someone/.cache/x.js"), false);
  assert.equal(ignored("D:/work/OmniRoute-other/src/a.ts"), false);
});

test("vite.config.ts wires the matcher into the dev server watcher", () => {
  const config = readFileSync(new URL("../../../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /watch: \{ ignored: \[createDevWatchIgnore\(ROOT\)\] \}/);
});
