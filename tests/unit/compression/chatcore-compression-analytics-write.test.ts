// Characterization of writeCompressionAnalytics — the full compression analytics write extracted
// from handleChatCore's request-setup compression path (chatCore god-file decomposition, #3501).
// Returns the write promise; uses a real temp DB. Locks: the analytics row mapping (tokens, engine,
// validation_fallback, output_mode), the per-engine breakdown insert, and fail-open.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-comp-analytics-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../../src/lib/db/core.ts");
const { getTestBackend } = await import("../../helpers/postgres.ts");
const { writeCompressionAnalytics } =
  await import("../../../open-sse/handlers/chatCore/compressionAnalyticsWrite.ts");

type Stats = Parameters<typeof writeCompressionAnalytics>[0]["stats"];

function makeStats(overrides: Record<string, unknown> = {}): Stats {
  return {
    originalTokens: 200,
    compressedTokens: 80,
    fallbackApplied: false,
    engine: "rtk",
    compressionComboId: null,
    durationMs: 12,
    rtkRawOutputPointers: [],
    engineBreakdown: [],
    ...overrides,
  } as unknown as Stats;
}

async function analyticsRow(requestId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (
      (await getTestBackend().queryOne<Record<string, unknown>>(
        "SELECT mode, engine, original_tokens AS orig, compressed_tokens AS comp, tokens_saved AS saved, estimated_usd_saved AS usd, validation_fallback AS vf FROM compression_analytics WHERE request_id = $1",
        [requestId]
      )) ?? undefined
    );
  } catch {
    return undefined;
  }
}

async function breakdownCount(requestId: string): Promise<number> {
  try {
    const row = await getTestBackend().queryOne<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM compression_engine_breakdown WHERE request_id = $1",
      [requestId]
    );
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(await pred())) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

function baseOpts(requestId: string, statsOverrides = {}) {
  return {
    stats: makeStats(statsOverrides),
    provider: "openai",
    effectiveModel: "gpt-x",
    effectiveServiceTier: "standard",
    comboName: null,
    mode: "rtk",
    compressionComboId: null,
    skillRequestId: requestId,
    cavemanOutputModeApplied: false,
    cavemanOutputModeIntensity: null,
  } as Parameters<typeof writeCompressionAnalytics>[0];
}

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(async () => {
  await coreDb.resetDbInstance();
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort cleanup
  }
});

test("writes the analytics row with mapped tokens/engine and resolves", async () => {
  await writeCompressionAnalytics(baseOpts("ca-req-1"));
  const row = await analyticsRow("ca-req-1");
  assert.ok(row, "expected a compression_analytics row");
  assert.equal(row!.engine, "rtk");
  assert.equal(row!.orig, 200);
  assert.equal(row!.comp, 80);
  assert.equal(row!.saved, 120);
  assert.equal(row!.vf, false);
});

test("validation_fallback is true when the stats flagged a fallback", async () => {
  await writeCompressionAnalytics(baseOpts("ca-req-2", { fallbackApplied: true }));
  const row = await analyticsRow("ca-req-2");
  assert.equal(row!.vf, true);
});

test("inserts a per-engine breakdown when present", async () => {
  await writeCompressionAnalytics(
    baseOpts("ca-req-3", {
      engineBreakdown: [
        { engine: "rtk", originalTokens: 200, compressedTokens: 120, durationMs: 5 },
        { engine: "caveman", originalTokens: 120, compressedTokens: 80, durationMs: 4 },
      ],
    })
  );
  await waitFor(async () => (await breakdownCount("ca-req-3")) >= 2);
  assert.equal(await breakdownCount("ca-req-3"), 2);
});

test("inserts the analytics row when calculateCost throws", async () => {
  await writeCompressionAnalytics(baseOpts("ca-req-cost-error"), {
    calculateCost: async () => {
      throw new Error("forced cost-estimate failure");
    },
  });

  const row = await analyticsRow("ca-req-cost-error");
  assert.ok(row, "expected a compression_analytics row despite the cost-estimate failure");
  assert.equal(row!.saved, 120);
  assert.equal(row!.usd, null);
});

test("never rejects even on a bad write (fail-open)", async () => {
  await coreDb.resetDbInstance();
  await assert.doesNotReject(writeCompressionAnalytics(baseOpts("ca-req-4")));
  await coreDb.ensureDbInitialized();
});
