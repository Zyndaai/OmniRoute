/**
 * Every configured locale carries every English key, with a real value.
 *
 * Replaces the per-issue i18n tests that each checked a hand-picked key list for the
 * "__MISSING__:" sentinel that sync-ui-keys.mjs stamps on untranslated keys (#6290, #6694,
 * #12272, #12561, #16220, ...): one walk over the whole catalog covers all of them and every
 * key added later.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOCALES } from "../../src/i18n/config";

const MESSAGES_DIR = fileURLToPath(new URL("../../src/i18n/messages", import.meta.url));
const SENTINEL = "__MISSING__";

function flatten(node: unknown, prefix = "", out = new Map<string, unknown>()) {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, node);
  }
  return out;
}

function readCatalog(locale: string): Map<string, unknown> {
  const file = path.join(MESSAGES_DIR, `${locale}.json`);
  assert.ok(fs.existsSync(file), `missing catalog for locale ${locale}`);
  return flatten(JSON.parse(fs.readFileSync(file, "utf8")));
}

const english = readCatalog("en");

test("the English catalog has no untranslated sentinel values", () => {
  const bad = [...english].filter(([, v]) => typeof v === "string" && v.startsWith(SENTINEL));
  assert.deepEqual(bad.map(([k]) => k), []);
});

for (const locale of LOCALES.filter((code) => code !== "en")) {
  test(`locale ${locale} has every English key with a real value`, () => {
    const catalog = readCatalog(locale);
    const missing = [...english.keys()].filter((key) => !catalog.has(key));
    assert.deepEqual(missing.slice(0, 20), [], `${missing.length} keys missing in ${locale}.json`);
    const sentinel = [...catalog]
      .filter(([, v]) => typeof v === "string" && v.startsWith(SENTINEL))
      .map(([k]) => k);
    assert.deepEqual(sentinel.slice(0, 20), [], `${sentinel.length} untranslated keys in ${locale}`);
  });
}
