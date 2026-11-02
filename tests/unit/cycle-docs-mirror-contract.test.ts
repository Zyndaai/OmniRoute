import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const qualityDoc = "docs/architecture/QUALITY_GATES.md";
const checklistDoc = "docs/ops/RELEASE_CHECKLIST.md";
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const cycleRow = (text: string) =>
  text.split("\n").find((line) => /^\|\s*`check:cycles`\s*\|/.test(line));
const cycleCheckbox = (text: string) =>
  text.split("\n").find((line) => line.startsWith("- [ ] `npm run check:cycles"));

test("English cycle documentation distinguishes bare fail-closed from the CI ratchet", () => {
  assert(cycleRow(read(qualityDoc))?.includes("#15281"));
  assert(cycleCheckbox(read(checklistDoc))?.startsWith("- [ ] `npm run check:cycles:ratchet`"));
});
