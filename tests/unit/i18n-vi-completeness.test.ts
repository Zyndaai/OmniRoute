import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "@formatjs/icu-messageformat-parser";

import en from "../../src/i18n/messages/en.json" with { type: "json" };
import ar from "../../src/i18n/messages/ar.json" with { type: "json" };

type MessageEntry = {
  key: string;
  value: string;
};

function flattenMessages(value: unknown, segments: Array<string | number> = []): MessageEntry[] {
  if (typeof value === "string") {
    return [{ key: segments.map(String).join("."), value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => flattenMessages(child, [...segments, index]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      flattenMessages(child, [...segments, key])
    );
  }
  return [];
}

const englishMessages = flattenMessages(en);
const arabicMessages = flattenMessages(ar);
const arabicByKey = new Map(arabicMessages.map((entry) => [entry.key, entry.value]));

test("Arabic locale has complete key parity with English", () => {
  assert.deepEqual(
    arabicMessages.map((entry) => entry.key).sort(),
    englishMessages.map((entry) => entry.key).sort()
  );
});

test("Arabic locale has no internal missing markers or empty fallbacks", () => {
  const invalid = arabicMessages.filter(
    ({ value }) => !value.trim() || /__(?:MISSING|TODO)__:?/i.test(value)
  );
  assert.deepEqual(invalid, []);
});

test("Arabic locale introduces no ICU parse regression", () => {
  const regressions = englishMessages.flatMap(({ key, value }) => {
    try {
      parse(value, { captureLocation: false, shouldParseSkeletons: true });
    } catch {
      return [];
    }

    const translated = arabicByKey.get(key);
    if (translated === undefined) return [{ key, reason: "missing" }];
    try {
      parse(translated, { captureLocation: false, shouldParseSkeletons: true });
      return [];
    } catch (error) {
      return [{ key, reason: error instanceof Error ? error.message : String(error) }];
    }
  });
  assert.deepEqual(regressions, []);
});

test("no-auth provider controls keep locale translators unambiguous", () => {
  const source = readFileSync(
    new URL(
      "../../src/app/(dashboard)/dashboard/providers/[id]/components/NoAuthProviderControls.tsx",
      import.meta.url
    ),
    "utf8"
  );

  assert.equal(source.match(/import \{ useTranslations \} from "next-intl";/g)?.length, 1);
  assert.match(source, /const noAuthT = useTranslations\("noAuthProvider"\);/);
  assert.match(source, /const t = useTranslations\("providers"\);/);
});
