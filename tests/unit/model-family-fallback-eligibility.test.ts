import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-family-fallback-eligibility-")
);
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const { getNextEligibleFamilyFallback, getContextFamilyFallback } =
  await import("../../open-sse/services/modelFamilyFallback.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");

const CONNECTION_ID = "family-fallback-connection";

async function resetStorage(): Promise<void> {
  await core.resetDbInstance();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  accountFallback.clearAllModelLockouts();
}

async function nextAntigravityFallback(tried = new Set<string>()): Promise<string | null> {
  return getNextEligibleFamilyFallback("agy/gemini-3.8-flash-high", tried, "agy", CONNECTION_ID);
}

test.beforeEach(resetStorage);

test.after(async () => {
  accountFallback.clearAllModelLockouts();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("family fallback skips a hidden regular model", async () => {
  await modelsDb.setModelIsHidden("anthropic", "claude-opus-4.8", true, "chat");

  const next = await getNextEligibleFamilyFallback(
    "anthropic/claude-opus-5",
    new Set(["anthropic/claude-opus-5"]),
    "anthropic",
    CONNECTION_ID
  );

  assert.equal(next, "anthropic/claude-opus-4.7");
});

test("family fallback skips a hidden passthrough model using its provider alias", async () => {
  await modelsDb.setModelIsHidden("antigravity", "gemini-3.8-flash-medium", true, "chat");

  assert.equal(await nextAntigravityFallback(), "agy/gemini-3.8-flash-low");
});

test("family fallback skips a model with an active connection-scoped lockout", async () => {
  accountFallback.lockExactModel(
    "agy",
    CONNECTION_ID,
    "gemini-3.8-flash-medium",
    "rate_limit",
    60_000
  );

  assert.equal(await nextAntigravityFallback(), "agy/gemini-3.8-flash-low");
});

test("family fallback advances past both hidden and locked siblings to an eligible model", async () => {
  await modelsDb.setModelIsHidden("claude", "claude-opus-4-8", true, "chat");
  accountFallback.lockExactModel("claude", CONNECTION_ID, "claude-opus-4-7", "rate_limit", 60_000);

  assert.equal(
    await getNextEligibleFamilyFallback(
      "claude/claude-opus-5",
      new Set(["claude/claude-opus-5"]),
      "claude",
      CONNECTION_ID
    ),
    "claude/claude-sonnet-5"
  );
});

test("family fallback applies hidden and lockout checks across provider aliases", async () => {
  await modelsDb.setModelIsHidden("claude", "claude-opus-4-8", true, "chat");
  accountFallback.lockExactModel("claude", CONNECTION_ID, "claude-opus-4-7", "rate_limit", 60_000);

  assert.equal(
    await getNextEligibleFamilyFallback(
      "cc/claude-opus-5",
      new Set(["cc/claude-opus-5"]),
      "cc",
      CONNECTION_ID
    ),
    "claude/claude-sonnet-5"
  );
});

test("family fallback restores eligibility after a lockout expires", async () => {
  await modelsDb.getHiddenModelsByProvider();
  accountFallback.lockExactModel(
    "agy",
    CONNECTION_ID,
    "gemini-3.8-flash-medium",
    "rate_limit",
    100
  );
  assert.equal(await nextAntigravityFallback(), "agy/gemini-3.8-flash-low");

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(await nextAntigravityFallback(), "agy/gemini-3.8-flash-medium");
});

test("family fallback returns null when every sibling is hidden", async () => {
  for (const model of [
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.8-flash-tiered",
    "gemini-3.8-flash",
  ]) {
    await modelsDb.setModelIsHidden("antigravity", model, true, "chat");
  }

  assert.equal(await nextAntigravityFallback(), null);
});

test("eligible family fallback keeps the existing preferred model order", async () => {
  assert.equal(await nextAntigravityFallback(), "agy/gemini-3.8-flash-medium");
});

test("bare family wire ids retain the explicit provider for visibility", async () => {
  await modelsDb.setModelIsHidden("claude", "claude-opus-4-8", true, "chat");
  assert.equal(
    await getNextEligibleFamilyFallback("claude-opus-5", new Set(), "claude", CONNECTION_ID),
    "claude-opus-4-7"
  );
});

test("a hidden sibling on another provider does not remove this provider's candidate", async () => {
  await modelsDb.setModelIsHidden("anthropic", "claude-opus-4.8", true, "chat");
  assert.equal(
    await getNextEligibleFamilyFallback("claude/claude-opus-5", new Set(), "claude", CONNECTION_ID),
    "claude/claude-opus-4-8"
  );
});

test("context fallback retains eligible ordering and skips hidden or locked siblings", async () => {
  await modelsDb.setModelIsHidden("claude", "claude-opus-4-8", true, "chat");
  accountFallback.lockExactModel("claude", CONNECTION_ID, "claude-opus-4-7", "rate_limit", 60_000);
  assert.equal(
    await getContextFamilyFallback("claude/claude-opus-5", new Set(), "claude", CONNECTION_ID),
    "claude/claude-sonnet-5"
  );
});

test("context fallback cannot escape an empty request allowlist", async () => {
  assert.equal(
    await getContextFamilyFallback("agy/gemini-3.8-flash-high", new Set(), "agy", CONNECTION_ID, []),
    null
  );
});

test("context fallback uses only permitted untried siblings", async () => {
  const current = "agy/gemini-3.8-flash-high";
  const permitted = "agy/gemini-3.8-flash-low";
  assert.equal(
    await getContextFamilyFallback(current, new Set(), "agy", CONNECTION_ID, [permitted]),
    permitted
  );
  assert.equal(
    await getContextFamilyFallback(current, new Set([permitted]), "agy", CONNECTION_ID, [permitted]),
    null
  );
});
