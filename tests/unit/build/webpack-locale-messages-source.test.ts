import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createLocaleMessagesLoader, parseLocaleMessages } from "../../../src/i18n/messages.ts";

// src/i18n/messages.ts accepts a catalog as raw JSON text or as an already parsed object, and
// parses each locale once per process.
const repoRoot = process.cwd();

test("parseLocaleMessages accepts raw text and parsed objects", () => {
  const raw = fs.readFileSync(path.join(repoRoot, "src/i18n/messages/ar.json"), "utf-8");
  const parsed = JSON.parse(raw);
  assert.deepEqual(parseLocaleMessages(raw), parsed);
  assert.equal(parseLocaleMessages(parsed), parsed);
});

test("each locale catalog is imported and parsed once per process", async () => {
  const imported: string[] = [];
  const load = createLocaleMessagesLoader(async (locale) => {
    imported.push(locale);
    return JSON.stringify({ locale });
  });
  const de = await load("de");
  assert.deepEqual(de, { locale: "de" });
  assert.equal(await load("de"), de);
  assert.deepEqual(await load("en"), { locale: "en" });
  assert.deepEqual(imported, ["de", "en"]);
});
