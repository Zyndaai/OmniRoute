import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "open-sse/services/rateLimitManager.ts"),
  "utf8"
);

test("preservedReplacementSettings is size-capped (boundedMap, lru)", () => {
  // The wedge watchdog stashes per-key limiter settings here for the next
  // replacement. A key that is never requested again (model churn) would keep
  // its entry for the whole process lifetime — the plain Map leaked. The lru
  // cap bounds it: evicting an entry only means the replacement rebuilds from
  // defaults (no carried reservoir), which is always safe.
  assert.match(
    source,
    /preservedReplacementSettings = boundedMap</,
    "preservedReplacementSettings must be a boundedMap, not a plain Map"
  );
  assert.match(
    source,
    /boundedMap<Bottleneck\.ConstructorOptions>\(\s*"preserved-limiter-settings",\s*\d+,\s*"lru"/s,
    "the cap must be a positive number and use the lru policy so hot keys survive"
  );
});
