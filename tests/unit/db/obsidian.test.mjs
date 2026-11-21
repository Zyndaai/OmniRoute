import { test } from "node:test";
import assert from "node:assert";

test("obsidian DB module exports expected functions", async () => {
  const mod = await import("../../../src/lib/db/obsidian.ts");
  assert.equal(typeof mod.getObsidianToken, "function");
  assert.equal(typeof mod.setObsidianToken, "function");
  assert.equal(typeof mod.clearObsidianToken, "function");
  assert.equal(typeof mod.getObsidianConfig, "function");
});

test("getObsidianConfig returns expected shape", async () => {
  const { getObsidianConfig } = await import("../../../src/lib/db/obsidian.ts");
  const config = await getObsidianConfig();
  assert.ok(typeof config === "object");
  assert.ok("connected" in config);
  assert.ok("token" in config);
  assert.equal(typeof config.connected, "boolean");
});

test("setObsidianToken and clearObsidianToken resolve and round-trip the token", async () => {
  const { setObsidianToken, clearObsidianToken, getObsidianToken } =
    await import("../../../src/lib/db/obsidian.ts");
  await assert.doesNotReject(() => setObsidianToken("test"));
  assert.equal(await getObsidianToken(), "test");
  await assert.doesNotReject(() => clearObsidianToken());
  assert.equal(await getObsidianToken(), null);
});
