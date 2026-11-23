import test from "node:test";
import assert from "node:assert/strict";
import { createTranslator } from "use-intl";
import en from "../../../src/i18n/messages/en.json" with { type: "json" };
import { countCatalogVisibility } from "../../../src/app/(dashboard)/dashboard/models/catalogVisibility.ts";
// A type regression red on release/v3.8.53 (#17219), fixed without behavior change: the
// Models catalog passes its visibility counts straight to t(). (The second case covered the
// rate-limit wedge watchdog, removed with Bottleneck.)

test("catalog visibility counts render through the real modelCatalog.visibilityCounts message", () => {
  const counts = countCatalogVisibility([
    { hidden: false },
    { hidden: true },
    { hidden: false },
    { hidden: false },
  ] as Parameters<typeof countCatalogVisibility>[0]);
  assert.deepEqual(counts, { visible: 3, hidden: 1, total: 4 });
  const t = createTranslator({ locale: "en", messages: en, namespace: "modelCatalog" });
  assert.equal(t("visibilityCounts", counts), "3 visible · 1 hidden · 4 total");
});
