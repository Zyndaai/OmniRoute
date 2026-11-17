import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// T05/C5 back-compat regression (#5653) at the DB read path. The new DEFAULT_COMPRESSION_CONFIG
// seeds preserveSystemPromptMode='always'. getCompressionSettings() spreads that default, so a
// legacy install that persisted ONLY the `preserveSystemPrompt` boolean (no mode row) would have
// the default 'always' shadow the boolean — silently flipping `preserveSystemPrompt=false` installs
// from "compress unless cached" (whenNoCache) to "always preserve". The read path must instead
// derive the mode from the boolean when no mode row exists.
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-preserve-mode-"));
process.env.DATA_DIR = TEMP_DIR;

const { ensureDbInitialized, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getCompressionSettings, updateCompressionSettings } =
  await import("../../../src/lib/db/compression.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

// `valueJson` is JSON text stored in the jsonb config row. The settings read keeps a 5s
// in-process cache that raw writes do not clear; an empty update clears it.
async function seedRow(key: string, valueJson: string) {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value) VALUES ('compression', $1, $2::jsonb)
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [key, valueJson]
  );
  await updateCompressionSettings({});
}

async function readSettings() {
  return getCompressionSettings();
}

before(async () => {
  await ensureDbInitialized();
});

beforeEach(async () => {
  await resetTestDb();
  // resetTestDb does not clear the settings module's 5s cache; an empty update does.
  await updateCompressionSettings({});
});

after(async () => {
  try {
    await resetDbInstance();
  } catch {
    /* core never loaded */
  }
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
});

test("legacy preserveSystemPrompt=false (no mode row) derives whenNoCache", async () => {
  await seedRow("preserveSystemPrompt", "false");

  const cfg = await readSettings();
  assert.equal(
    cfg.preserveSystemPromptMode,
    "whenNoCache",
    "legacy preserveSystemPrompt=false must derive whenNoCache, not inherit the 'always' default"
  );

  // End-to-end: without a cacheable prefix, a legacy-off install must still compress the prompt.
  const { resolveCacheAwareConfig } =
    await import("../../../open-sse/services/compression/cacheAwareConfig.ts");
  assert.equal(
    resolveCacheAwareConfig(cfg).preserveSystemPrompt,
    false,
    "legacy-off install must compress the system prompt when there is no cache"
  );
});

test("fresh install (no override rows) defaults to always", async () => {
  const cfg = await readSettings();
  assert.equal(cfg.preserveSystemPromptMode, "always", "fresh default mode is always");
  assert.equal(cfg.preserveSystemPrompt, true, "fresh default boolean is true");
});

test("an explicit mode row wins over the legacy boolean", async () => {
  await seedRow("preserveSystemPrompt", "false");
  await seedRow("preserveSystemPromptMode", '"never"');

  const cfg = await readSettings();
  assert.equal(cfg.preserveSystemPromptMode, "never", "an explicit stored mode row wins");
});
