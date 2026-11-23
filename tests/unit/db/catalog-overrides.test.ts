import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-overrides-"));
process.env.DATA_DIR = directory;
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { setConfigText } = await import("../../../src/lib/db/configEntries.ts");
const { getCcAliasSettingsBulk } = await import("../../../src/lib/db/ccDiscoveryAliases.ts");
const { getFunctionalGatewaySettingsBulk } =
  await import("../../../src/lib/db/functionalGatewayMirrors.ts");
test.after(async () => {
  await resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("bulk loaders isolate namespaces and ignore invalid settings and unknown keys", async () => {
  for (const [namespace, value] of [
    ["ccDiscoveryAliases", "on"],
    ["functionalGatewayMirrors", "off"],
  ] as const) {
    for (const [key, setting] of [
      ["provider:sample", value],
      ["model:sample/nested/model", value],
      ["provider:invalid", "ON"],
      ["model:invalid", "inherit"],
      ["unknown:sample", "on"],
      ["provider:", value],
    ]) {
      await setConfigText(namespace, key, setting);
    }
  }
  for (const [load, expected] of [
    [getCcAliasSettingsBulk, "on"],
    [getFunctionalGatewaySettingsBulk, "off"],
  ] as const) {
    const result = await load();
    assert.deepEqual(
      result.providers,
      new Map([
        ["sample", expected],
        ["", expected],
      ])
    );
    assert.deepEqual(result.models, new Map([["sample/nested/model", expected]]));
    result.providers.clear();
    assert.equal((await load()).providers.size, 2);
  }
});
