import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const envDoc = "docs/reference/ENVIRONMENT.md";
const qualityDoc = "docs/routing/AUTO-COMBO.md";
const names = [
  "OMNIROUTE_NO_UPDATE_NOTIFIER",
  "OMNIROUTE_DOCTOR_LIVENESS_URL",
  "OMNIROUTE_PROVIDER_CATALOG_PATH",
  "OMNIROUTE_PROVIDER_TEST_MODEL",
  "CODEBUDDY_SYSTEM_PROMPT_MAX_LEN",
];
const qualityPath = "open-sse/services/routing/quality.ts";

test("published English sources contain CLI and CodeBuddy variables and the cold-start note", () => {
  for (const name of names) assert(read(envDoc).includes(name));
  assert(read(qualityDoc).includes(qualityPath));
});
