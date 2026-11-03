import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import i18nConfig from "../../config/i18n.json" with { type: "json" };

/**
 * Parity guard: every locale declared in config/i18n.json (the single source of
 * truth) must exist on every in-repo catalog surface — the dashboard catalog and
 * the CLI catalog. The reverse direction is guarded as well: every catalog file
 * must map back to a configured locale, so a retired locale cannot leave orphans
 * behind. (The translated docs mirror under docs/i18n/ was removed from this
 * private copy, so it is no longer part of the parity check.)
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_DIRS = [
  path.join(ROOT, "src", "i18n", "messages"),
  path.join(ROOT, "bin", "cli", "locales"),
];

for (const { code } of i18nConfig.locales) {
  test(`locale ${code} exists on every in-repo surface`, () => {
    assert.ok(
      existsSync(path.join(ROOT, "src", "i18n", "messages", `${code}.json`)),
      "dashboard catalog"
    );
    assert.ok(existsSync(path.join(ROOT, "bin", "cli", "locales", `${code}.json`)), "CLI catalog");
  });
}

test("no orphan locale catalog outside config/i18n.json (reverse parity)", () => {
  const configured = new Set(i18nConfig.locales.map(({ code }) => code));
  const offenders: string[] = [];

  for (const dir of CATALOG_DIRS) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const code = file.slice(0, -".json".length);
      if (!configured.has(code)) offenders.push(`${path.relative(ROOT, dir)}/${file}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `orphan locale catalogs that are not a configured locale (config/i18n.json) — retired locale left behind?: ${offenders.join("; ")}`
  );
});
