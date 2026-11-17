import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-layout-settings-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
const core = await import("../../src/lib/db/core.ts");
const { getRootLayoutSettings } = await import("../../src/lib/db/rootLayoutSettings.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");

async function resetStorage(): Promise<void> {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function setSettingValue(key: string, value: unknown): Promise<void> {
  const backend = getTestBackend();
  await backend.execute(
    "DELETE FROM config_entries WHERE namespace = 'settings' AND key = $1",
    [key]
  );
  await backend.execute(
    "INSERT INTO config_entries (namespace, key, value) VALUES ('settings', $1, $2::jsonb)",
    [key, JSON.stringify(value)]
  );
}

test.beforeEach(async () => {
  await resetStorage();
  delete process.env.INITIAL_PASSWORD;
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });

  if (ORIGINAL_INITIAL_PASSWORD === undefined) {
    delete process.env.INITIAL_PASSWORD;
  } else {
    process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  }
});

test("root layout imports the read-only settings leaf", () => {
  const layoutSource = fs.readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
  const leafSource = fs.readFileSync(
    path.join(process.cwd(), "src/lib/db/rootLayoutSettings.ts"),
    "utf8"
  );

  assert.match(
    layoutSource,
    /import \{ getRootLayoutSettings \} from "@\/lib\/db\/rootLayoutSettings";/
  );
  assert.doesNotMatch(layoutSource, /@\/lib\/db\/settings/);
  assert.doesNotMatch(leafSource, /db\/settings|runtimeSettings|tokenHealth|providerModels/);
  assert.doesNotMatch(leafSource, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
});

test("root layout settings reader does not initialize onboarding on a fresh database", async () => {
  process.env.INITIAL_PASSWORD = "must-not-trigger-startup";

  assert.deepEqual(await getRootLayoutSettings(), {
    instanceName: "OmniRoute",
    customFaviconUrl: "",
    customFaviconBase64: "",
  });

  const onboardingRows = await getTestBackend().query(
    "SELECT key FROM config_entries WHERE namespace = 'settings' AND key IN ('setupComplete', 'requireLogin')"
  );
  assert.deepEqual(onboardingRows, []);
});

test("root layout settings reader returns only the persisted metadata fields", async () => {
  await setSettingValue("instanceName", "Route Lab");
  await setSettingValue("customFaviconUrl", "https://example.com/favicon.png");
  await setSettingValue("customFaviconBase64", "data:image/png;base64,AA==");
  await setSettingValue("proxyEnabled", false);

  assert.deepEqual(await getRootLayoutSettings(), {
    instanceName: "Route Lab",
    customFaviconUrl: "https://example.com/favicon.png",
    customFaviconBase64: "data:image/png;base64,AA==",
  });
});

test("root layout settings reader is read-only and falls back safely", async () => {
  process.env.INITIAL_PASSWORD = "must-not-trigger-onboarding";
  // A non-string stored value is not a usable instance name: the reader must fall back.
  await setSettingValue("instanceName", 42);

  assert.deepEqual(await getRootLayoutSettings(), {
    instanceName: "OmniRoute",
    customFaviconUrl: "",
    customFaviconBase64: "",
  });

  const onboardingRows = await getTestBackend().query(
    "SELECT key FROM config_entries WHERE namespace = 'settings' AND key IN ('setupComplete', 'requireLogin')"
  );
  assert.deepEqual(onboardingRows, []);
});
