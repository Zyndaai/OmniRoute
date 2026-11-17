import test from "node:test";
import assert from "node:assert/strict";

import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { computeComboCapabilities } from "../../src/app/api/v1/combos/projectCombo.ts";

const REPORTED_VISION_MEMBERS = [
  "opencode-go/mimo-v2.5",
  "kilo-gateway/stepfun/step-3.7-flash:free",
  "opencode-zen/mimo-v2.5-free",
  "opencode/mimo-v2.5-free",
  "command-code/xiaomi/mimo-v2.5",
] as const;

test("#13847 reported combo members resolve as vision-capable", async () => {
  for (const model of REPORTED_VISION_MEMBERS) {
    assert.equal(
      (await getResolvedModelCapabilities(model)).supportsVision,
      true,
      `${model} should retain its vision capability through provider/free-route qualification`
    );
  }
});

test("#13847 known MiMo Pro text-only siblings stay excluded", async () => {
  for (const model of [
    "mimo-v2.5-pro",
    "command-code/xiaomi/mimo-v2.5-pro",
    "mimo-v2-pro",
  ]) {
    assert.notEqual(
      (await getResolvedModelCapabilities(model)).supportsVision,
      true,
      `${model} must not inherit the MiMo V2.5 multimodal heuristic`
    );
  }
});

test("#13847 combo projection agrees with vision-capable members", async () => {
  const combo = {
    name: "default-observer",
    strategy: "priority",
    models: REPORTED_VISION_MEMBERS.map((model) => ({ kind: "model", model })),
  };

  assert.deepEqual(await computeComboCapabilities(combo), {
    multimodal: true,
    reasoning: true,
    caching: false,
  });
});
