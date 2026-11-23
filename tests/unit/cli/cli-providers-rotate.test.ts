import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Covers the server-backed `providers status` command. Rotate runs through the server API too,
// and its cases used the CLI's direct SQLite store, so they were removed with that store.

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_FETCH = globalThis.fetch;

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cli-rotate-"));
}

async function withEnv(fn: (dataDir: string) => Promise<void>) {
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
  }
}

// --- status tests ---

test("providers status exits 3 when server is offline", async () => {
  await withEnv(async (_dataDir) => {
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const { runProvidersStatusCommand } = await import("../../../bin/cli/commands/providers.mjs");
    const exitCode = await runProvidersStatusCommand({});
    assert.equal(exitCode, 3, "should exit 3 when server is offline");
  });
});

test("providers status returns json when server returns expiration list", async () => {
  await withEnv(async (_dataDir) => {
    const mockList = [
      {
        connectionId: "abc123",
        provider: "openai",
        name: "OpenAI",
        status: "active",
        testStatus: "active",
        expiresAt: null,
        rateLimitedUntil: null,
      },
    ];
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ list: mockList, summary: {} }),
      text: async () => "",
    });
    globalThis.fetch = mockFetch;
    const { runProvidersStatusCommand } = await import("../../../bin/cli/commands/providers.mjs");
    // Run with our fetch in place
    const savedFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    const exitCode = await runProvidersStatusCommand({ json: true });
    globalThis.fetch = savedFetch;
    assert.equal(exitCode, 0);
  });
});
