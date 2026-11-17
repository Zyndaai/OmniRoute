import test from "node:test";
import assert from "node:assert/strict";

const settings = await import("../../src/lib/db/settings.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");

test("#10312: empty store defaults debugMode to false (fresh install is not in debug)", async () => {
  await resetTestDb();
  const result = await settings.getSettings();
  assert.equal(result.debugMode, false);
});

test("#10312: persisted debugMode=true is preserved after the default flip", async () => {
  await resetTestDb();
  await settings.updateSettings({ debugMode: true });
  const result = await settings.getSettings();
  assert.equal(result.debugMode, true);
});

test("#10312: persisted debugMode=false stays false after the default flip", async () => {
  await resetTestDb();
  await settings.updateSettings({ debugMode: false });
  const result = await settings.getSettings();
  assert.equal(result.debugMode, false);
});
