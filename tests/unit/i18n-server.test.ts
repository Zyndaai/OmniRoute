import test from "node:test";
import assert from "node:assert/strict";

import { getRequestLocale, getRootIntlData, getTranslator } from "../../src/i18n/request.server.ts";
import { loadMessages, mergeWithFallback, getLoadedMessages } from "../../src/i18n/messages.ts";

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/x", { headers });
}

test("getRequestLocale: cookie wins, then x-locale header, then the default", () => {
  assert.equal(getRequestLocale(req({ cookie: "NEXT_LOCALE=ar" })), "ar");
  assert.equal(getRequestLocale(req({ "x-locale": "ar" })), "ar");
  assert.equal(getRequestLocale(req({ cookie: "NEXT_LOCALE=ar", "x-locale": "en" })), "ar");
  assert.equal(getRequestLocale(req()), "en");
  assert.equal(getRequestLocale(req({ cookie: "NEXT_LOCALE=zz-unknown" })), "en");
});

test("loadMessages: merges English into a locale and caches the result", async () => {
  const ar = await loadMessages("ar");
  assert.equal(await loadMessages("ar"), ar);
  assert.equal(getLoadedMessages("ar"), ar);
  const en = await loadMessages("en");
  for (const namespace of Object.keys(en)) assert.ok(namespace in ar, namespace);
});

test("mergeWithFallback: locale values win, __MISSING__ placeholders and absent keys come from English", () => {
  const merged = mergeWithFallback(
    { a: { x: "hola", y: "__MISSING__:y" } },
    { a: { x: "hello", y: "why", z: "zed" }, b: { c: "see" } }
  );
  assert.deepEqual(merged, { a: { x: "hola", y: "why", z: "zed" }, b: { c: "see" } });
});

test("getTranslator: namespaced translator for the request's locale", async () => {
  const t = await getTranslator("common", req());
  const en = (await loadMessages("en")) as { common: Record<string, string> };
  const [key, value] = Object.entries(en.common).find(
    ([, v]) => typeof v === "string" && !v.includes("{")
  )!;
  assert.equal(t(key as never), value);
});

test("getRootIntlData: serialisable locale, direction, time zone and now; no catalog", async () => {
  const data = await getRootIntlData(req({ cookie: "NEXT_LOCALE=ar" }));
  assert.equal(data.locale, "ar");
  assert.equal(data.dir, "rtl");
  assert.equal(typeof data.timeZone, "string");
  assert.ok(!Number.isNaN(Date.parse(data.now)));
  assert.deepEqual(Object.keys(data).sort(), ["dir", "locale", "now", "timeZone"]);
  assert.equal((await getRootIntlData(req())).dir, "ltr");
});
