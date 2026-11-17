import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Covers the offline provider catalog command. Provider list/test/validate run through the server API.

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY;
const ORIGINAL_FETCH = globalThis.fetch;

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cli-providers-"));
}

async function withProvidersEnv(fn: (dataDir: string) => Promise<void>) {
  const dataDir = createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.STORAGE_ENCRYPTION_KEY;
  globalThis.fetch = ORIGINAL_FETCH;

  try {
    await fn(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    globalThis.fetch = ORIGINAL_FETCH;

    if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = ORIGINAL_DATA_DIR;

    if (ORIGINAL_STORAGE_ENCRYPTION_KEY === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
    else process.env.STORAGE_ENCRYPTION_KEY = ORIGINAL_STORAGE_ENCRYPTION_KEY;
  }
}

test("providers available lists supported provider catalog", async () => {
  await withProvidersEnv(async () => {
    const { runAvailableCommand } = await import("../../bin/cli/commands/providers.mjs");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      const exitCode = await runAvailableCommand({ json: true, search: "openai" });
      assert.equal(exitCode, 0);
    } finally {
      console.log = originalLog;
    }

    const result = JSON.parse(logs.join("\n")) as {
      providers: Array<{ id: string; category: string }>;
    };
    assert.ok(result.providers.some((provider) => provider.id === "openai"));
    assert.ok(result.providers.some((provider) => provider.category === "api-key"));
  });
});
