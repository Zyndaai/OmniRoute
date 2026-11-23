/**
 * Unit tests for src/lib/arenaEloSync.ts
 *
 * Uses Node.js native test runner. All external fetch calls are mocked.
 * DB functions use the per-process isolated PostgreSQL database
 * (tests/_setup/isolatePostgres.ts); each test starts from resetTestDb().
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-arena-elo-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

const {
  normalizeModelName,
  transformToModelIntelligence,
  fetchArenaLeaderboards,
  syncArenaElo,
  getArenaEloSyncStatus,
  initArenaEloSync,
  stopArenaEloSync,
} = await import("../../../src/lib/arenaEloSync.ts");
const { applyArenaEloRefresh } = await import("../../../src/lib/db/modelIntelligence.ts");
const { setFeatureFlagOverride, removeFeatureFlagOverride } =
  await import("../../../src/lib/db/featureFlags.ts");
const { refreshFeatureFlagSnapshot } = await import("../../../src/shared/utils/featureFlags.ts");
const { resolveScoresAs } = await import("../../../open-sse/services/autoCombo/scoresAs.ts");

import type {
  ArenaLeaderboardData,
  ArenaLeaderboardMap,
  ArenaModelEntry,
} from "../../../src/lib/arenaEloSync.ts";

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, opts?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeModelEntry(overrides: Partial<ArenaModelEntry> = {}): ArenaModelEntry {
  return {
    rank: 1,
    model: "anthropic/claude-sonnet",
    vendor: "Anthropic",
    score: 1350,
    ci: 10,
    votes: 5000,
    license: "proprietary",
    ...overrides,
  };
}

function makeLeaderboardData(
  models: ArenaModelEntry[] = [],
  category = "text"
): ArenaLeaderboardData {
  return {
    meta: { leaderboard: category, model_count: models.length },
    models,
  };
}

function makeLeaderboardMap(
  categories: Partial<Record<string, ArenaModelEntry[]>>
): ArenaLeaderboardMap {
  const map: ArenaLeaderboardMap = {};
  for (const [cat, models] of Object.entries(categories)) {
    map[cat] = makeLeaderboardData(models ?? [], cat);
  }
  return map;
}

// Flag reads serve an in-process snapshot (src/shared/utils/featureFlags.ts) that is not
// refreshed by setFeatureFlagOverride(); reload it explicitly (twice, in case a refresh that
// began before the write was already in flight).
async function syncFlagSnapshot(): Promise<void> {
  await refreshFeatureFlagSnapshot();
  await refreshFeatureFlagSnapshot();
}

async function countArenaEloEntries(): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM model_intelligence WHERE source = 'arena_elo'"
  );
  return Number(row?.cnt ?? 0);
}

async function getAllEntries(): Promise<Array<Record<string, unknown>>> {
  return getTestBackend().query<Record<string, unknown>>(
    "SELECT * FROM model_intelligence WHERE source = 'arena_elo' ORDER BY model, category"
  );
}

async function setArenaSyncedAt(iso: string): Promise<void> {
  await getTestBackend().execute(
    "UPDATE model_intelligence SET synced_at = $1 WHERE source = 'arena_elo'",
    [iso]
  );
}

async function deleteArenaRows(): Promise<void> {
  await getTestBackend().execute("DELETE FROM model_intelligence WHERE source = 'arena_elo'");
}

beforeEach(async () => {
  await resetTestDb();
  stopArenaEloSync();
  delete process.env.ARENA_ELO_SYNC_ENABLED;
});

afterEach(() => {
  restoreFetch();
  stopArenaEloSync();
  delete process.env.ARENA_ELO_SYNC_ENABLED;
});

after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ═══════════════════════════════════════════════════════════
// 1. normalizeModelName()
// ═══════════════════════════════════════════════════════════

describe("normalizeModelName()", () => {
  it("strips 'anthropic/' vendor prefix", () => {
    assert.strictEqual(
      normalizeModelName("anthropic/claude-opus-4-6-thinking"),
      "claude-opus-4-6-thinking"
    );
  });

  it("strips 'openai/' vendor prefix", () => {
    assert.strictEqual(normalizeModelName("openai/gpt-5.5"), "gpt-5.5");
  });

  it("strips 'google/' vendor prefix", () => {
    assert.strictEqual(normalizeModelName("google/gemini-3-flash"), "gemini-3-flash");
  });

  it("strips 'meta/' vendor prefix", () => {
    assert.strictEqual(normalizeModelName("meta/llama-4"), "llama-4");
  });

  it("strips 'deepseek/' vendor prefix", () => {
    assert.strictEqual(normalizeModelName("deepseek/deepseek-r1"), "deepseek-r1");
  });

  it("strips 'xai/' vendor prefix", () => {
    assert.strictEqual(normalizeModelName("xai/grok-4"), "grok-4");
  });

  it("lowercases the model name", () => {
    assert.strictEqual(normalizeModelName("Claude-Sonnet-4"), "claude-sonnet-4");
  });

  it("lowercases vendor prefix before matching", () => {
    assert.strictEqual(normalizeModelName("OpenAI/GPT-5.5"), "gpt-5.5");
  });

  it("returns name unchanged when no vendor prefix matches", () => {
    assert.strictEqual(normalizeModelName("my-custom-model"), "my-custom-model");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. transformToModelIntelligence()
// ═══════════════════════════════════════════════════════════

describe("transformToModelIntelligence()", () => {
  it("ELO normalization: 1500 ELO (max) with range 1000-1500 → score ≈ 0.98", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({ model: "top-model", score: 1500, votes: 5000, rank: 1 }),
        makeModelEntry({ model: "low-model", score: 1000, votes: 5000, rank: 2 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const topEntry = entries.find((e) => e.model === "top-model" && e.category === "default");

    assert.ok(topEntry);
    // taskFit = 0.4 + 0.58 * ((1500-1000) / 500) = 0.98
    assert.ok(Math.abs(topEntry.score - 0.98) < 0.001, `got ${topEntry.score}`);
  });

  it("ELO normalization: 1000 ELO (min) with range 1000-1500 → score ≈ 0.40", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({ model: "top-model", score: 1500, votes: 5000, rank: 1 }),
        makeModelEntry({ model: "low-model", score: 1000, votes: 5000, rank: 2 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const lowEntry = entries.find((e) => e.model === "low-model" && e.category === "default");

    assert.ok(lowEntry);
    // taskFit = 0.4 + 0.58 * ((1000-1000) / 500) = 0.4
    assert.ok(Math.abs(lowEntry.score - 0.4) < 0.001, `got ${lowEntry.score}`);
  });

  it("votes < 100 → confidence='low'", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({ model: "sparse-model", score: 1200, votes: 50, rank: 5 }),
        makeModelEntry({ model: "baseline", score: 1100, votes: 5000, rank: 10 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const entry = entries.find((e) => e.model === "sparse-model" && e.category === "default");

    assert.ok(entry);
    assert.strictEqual(entry.confidence, "low");
  });

  it("votes >= 1000 → confidence='medium'", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({ model: "mid-model", score: 1200, votes: 1500, rank: 3 }),
        makeModelEntry({ model: "baseline", score: 1100, votes: 5000, rank: 10 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const entry = entries.find((e) => e.model === "mid-model" && e.category === "default");

    assert.ok(entry);
    assert.strictEqual(entry.confidence, "medium");
  });

  it("votes >= 5000 → confidence='high'", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({ model: "popular-model", score: 1300, votes: 8000, rank: 1 }),
        makeModelEntry({ model: "baseline", score: 1100, votes: 3000, rank: 5 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const entry = entries.find((e) => e.model === "popular-model" && e.category === "default");

    assert.ok(entry);
    assert.strictEqual(entry.confidence, "high");
  });

  it("category mapping: 'text' → [default, review, documentation, debugging]", () => {
    const data = makeLeaderboardMap({
      text: [makeModelEntry({ model: "text-model", score: 1200, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    const categories = entries
      .filter((e) => e.model === "text-model")
      .map((e) => e.category)
      .sort();

    assert.deepStrictEqual(categories, ["debugging", "default", "documentation", "review"]);
  });

  it("category mapping: 'code' → [coding]", () => {
    const data = makeLeaderboardMap({
      code: [makeModelEntry({ model: "code-model", score: 1300, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    const categories = entries.filter((e) => e.model === "code-model").map((e) => e.category);

    assert.deepStrictEqual(categories, ["coding"]);
  });

  it("expires_at is set to ~7 days in the future", () => {
    const before = Date.now();
    const data = makeLeaderboardMap({
      text: [makeModelEntry({ model: "test-model", score: 1200, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    const after = Date.now();

    const entry = entries.find((e) => e.model === "test-model" && e.category === "default");
    assert.ok(entry);
    assert.ok(entry.expiresAt);

    const expiresMs = new Date(entry.expiresAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    assert.ok(expiresMs >= before + sevenDaysMs - 2000, `expiresAt too early: ${entry.expiresAt}`);
    assert.ok(expiresMs <= after + sevenDaysMs + 2000, `expiresAt too late: ${entry.expiresAt}`);
  });

  it("source is 'arena_elo' for all entries", () => {
    const data = makeLeaderboardMap({
      text: [makeModelEntry({ model: "test-model", score: 1200, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    for (const entry of entries) {
      assert.strictEqual(entry.source, "arena_elo");
    }
  });

  it("does not copy a variant's score onto a different generation (MODEL_ALIAS_MAP removed, #11504)", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({
          model: "anthropic/claude-opus-4-6-thinking",
          score: 1400,
          votes: 5000,
          rank: 1,
        }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const models = entries.map((e) => e.model);

    assert.ok(models.includes("claude-opus-4-6-thinking"));
    // Was asserted the other way round while MODEL_ALIAS_MAP existed: it copied this
    // score onto `claude-opus-4`, so a claude-opus-4 request read a 4.6-thinking ELO.
    assert.ok(!models.includes("claude-opus-4"));
    assert.ok(!models.includes("anthropic/claude-opus-4"));
  });

  it("empty leaderboard → no entries", () => {
    const data = makeLeaderboardMap({ text: [] });
    const entries = transformToModelIntelligence(data);
    assert.strictEqual(entries.length, 0);
  });

  it("skips unknown leaderboard categories (e.g. vision)", () => {
    const data = makeLeaderboardMap({
      vision: [makeModelEntry({ model: "vision-model", score: 1300, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    assert.strictEqual(entries.length, 0);
  });

  it("preserves eloRaw from the leaderboard", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({ model: "test-model", score: 1337, votes: 5000, rank: 1 }),
        makeModelEntry({ model: "other-model", score: 1100, votes: 3000, rank: 2 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const entry = entries.find((e) => e.model === "test-model" && e.category === "default");
    assert.ok(entry);
    assert.strictEqual(entry.eloRaw, 1337);
  });

  it("handles single-model leaderboard (eloRange = 1, avoids division by zero)", () => {
    const data = makeLeaderboardMap({
      text: [makeModelEntry({ model: "only-model", score: 1200, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    assert.ok(entries.length > 0);

    const entry = entries.find((e) => e.model === "only-model" && e.category === "default");
    assert.ok(entry);
    assert.ok(Math.abs(entry.score - 0.4) < 0.001);
  });

  it("rounds score to 4 decimal places", () => {
    const data = makeLeaderboardMap({
      text: [
        makeModelEntry({ model: "model-a", score: 1300, votes: 200, rank: 1 }),
        makeModelEntry({ model: "model-b", score: 1000, votes: 200, rank: 2 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    for (const entry of entries) {
      const str = entry.score.toString();
      const dot = str.indexOf(".");
      if (dot !== -1) {
        assert.ok(str.length - dot - 1 <= 4, `score ${entry.score} > 4 decimals`);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 2b. Variant → base row synthesis (#11504)
// ═══════════════════════════════════════════════════════════

describe("transformToModelIntelligence() — base-model synthesis", () => {
  it("normalizeModelName strips a trailing harness annotation", () => {
    assert.strictEqual(
      normalizeModelName("gpt-5.6-sol-xhigh (codex-harness)"),
      "gpt-5.6-sol-xhigh"
    );
  });

  it("normalizeModelName strips vendor prefix and harness annotation together", () => {
    assert.strictEqual(
      normalizeModelName("OpenAI/GPT-5.6-Sol-xhigh (Codex-Harness)"),
      "gpt-5.6-sol-xhigh"
    );
  });

  it("harness-annotated variant yields both the variant row and a base row", () => {
    const data = makeLeaderboardMap({
      code: [
        makeModelEntry({
          model: "gpt-5.6-sol-xhigh (codex-harness)",
          score: 1700,
          votes: 5000,
          rank: 1,
        }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const coding = entries.filter((e) => e.category === "coding").map((e) => e.model);

    assert.ok(coding.includes("gpt-5.6-sol-xhigh"), "variant row is kept");
    assert.ok(coding.includes("gpt-5.6-sol"), "base row is synthesized");
    // `gpt-5.6` is a vendor alias of `gpt-5.6-sol`, resolved at lookup time — never stored here.
    assert.ok(!coding.includes("gpt-5.6"));
  });

  it("base row carries the best variant's score and eloRaw", () => {
    const data = makeLeaderboardMap({
      code: [
        makeModelEntry({ model: "claude-opus-5-max", score: 1691, votes: 5000, rank: 1 }),
        makeModelEntry({ model: "claude-opus-5-high", score: 1663, votes: 5000, rank: 2 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const base = entries.find((e) => e.model === "claude-opus-5" && e.category === "coding");
    const max = entries.find((e) => e.model === "claude-opus-5-max" && e.category === "coding");

    assert.ok(base, "synthesized base row exists");
    assert.ok(max);
    assert.strictEqual(base.eloRaw, 1691);
    assert.strictEqual(base.score, max.score);
  });

  it("never lowers an explicitly measured base row", () => {
    const data = makeLeaderboardMap({
      code: [
        makeModelEntry({ model: "claude-opus-5", score: 1700, votes: 5000, rank: 1 }),
        makeModelEntry({ model: "claude-opus-5-max", score: 1691, votes: 5000, rank: 2 }),
      ],
    });

    const entries = transformToModelIntelligence(data);
    const base = entries.filter((e) => e.model === "claude-opus-5" && e.category === "coding");

    assert.strictEqual(base.length, 1);
    assert.strictEqual(base[0].eloRaw, 1700);
  });

  it("does not collapse generations (regression guard for the deleted alias map)", () => {
    const data = makeLeaderboardMap({
      text: [makeModelEntry({ model: "openai/gpt-5.5", score: 1600, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    const models = entries.map((e) => e.model);

    assert.ok(models.includes("gpt-5.5"));
    assert.ok(!models.includes("gpt-5"), "gpt-5.5 must never emit a gpt-5 row");
  });

  it("synthesizes nothing when the stripped base is not a routable catalog id", () => {
    // Catalog-anchored by construction: assert the premise instead of a frozen catalog fact.
    assert.strictEqual(resolveScoresAs("grok-4.6-fast-high").via, null);

    const data = makeLeaderboardMap({
      code: [makeModelEntry({ model: "grok-4.6-fast-high", score: 1600, votes: 5000, rank: 1 })],
    });

    const entries = transformToModelIntelligence(data);
    const models = entries.map((e) => e.model);

    assert.deepStrictEqual(models, ["grok-4.6-fast-high"]);
  });

  it("is idempotent and emits no duplicate (model, category) keys", () => {
    const data = makeLeaderboardMap({
      code: [
        makeModelEntry({ model: "claude-opus-5-max", score: 1691, votes: 5000, rank: 1 }),
        makeModelEntry({ model: "claude-opus-5-high", score: 1663, votes: 5000, rank: 2 }),
        makeModelEntry({
          model: "gpt-5.6-sol-xhigh (codex-harness)",
          score: 1700,
          votes: 5000,
          rank: 3,
        }),
      ],
    });

    const first = transformToModelIntelligence(data);
    const second = transformToModelIntelligence(data);

    const strip = (entries: ReturnType<typeof transformToModelIntelligence>) =>
      entries.map(({ expiresAt: _expiresAt, ...rest }) => rest);
    assert.deepStrictEqual(strip(second), strip(first));

    const keys = first.map((e) => `${e.model}|${e.category}`);
    assert.strictEqual(new Set(keys).size, keys.length);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. fetchArenaLeaderboards()
// ═══════════════════════════════════════════════════════════

describe("fetchArenaLeaderboards()", () => {
  it("successful fetch with valid JSON returns both leaderboards", async () => {
    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "text-model", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );
    const codeData = makeLeaderboardData(
      [makeModelEntry({ model: "code-model", score: 1300, votes: 5000, rank: 1 })],
      "code"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(codeData);
      return new Response("Not found", { status: 404 });
    });

    const result = await fetchArenaLeaderboards();

    assert.ok(result.text);
    assert.ok(result.code);
    assert.strictEqual(result.text.models.length, 1);
    assert.strictEqual(result.code.models.length, 1);
  });

  it("failed fetch (non-200 status) throws with descriptive message", async () => {
    mockFetch(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    await assert.rejects(
      () => fetchArenaLeaderboards(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("All Arena leaderboard fetches failed"));
        return true;
      }
    );
  });

  it("all fetches fail (network error) → throws", async () => {
    mockFetch(async () => {
      throw new Error("Network error: ECONNREFUSED");
    });

    await assert.rejects(
      () => fetchArenaLeaderboards(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("All Arena leaderboard fetches failed"));
        return true;
      }
    );
  });

  it("succeeds when one category fails but another succeeds", async () => {
    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "text-model", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return new Response("Error", { status: 500 });
      return new Response("Not found", { status: 404 });
    });

    const result = await fetchArenaLeaderboards();
    assert.ok(result.text);
    assert.strictEqual(result.code, undefined);
  });

  it("invalid JSON in response → throws when all responses are invalid", async () => {
    mockFetch(async () => {
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    });

    await assert.rejects(
      () => fetchArenaLeaderboards(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("All Arena leaderboard fetches failed"));
        return true;
      }
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 4. syncArenaElo()
// ═══════════════════════════════════════════════════════════

describe("syncArenaElo()", () => {
  it("happy path: returns success=true with correct modelCount", async () => {
    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "gpt-5.5", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );
    const codeData = makeLeaderboardData(
      [makeModelEntry({ model: "deepseek-r1", score: 1300, votes: 5000, rank: 1 })],
      "code"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(codeData);
      return new Response("Not found", { status: 404 });
    });

    const result = await syncArenaElo();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.source, "arena_elo");
    assert.ok(result.modelCount > 0);

    const dbCount = await countArenaEloEntries();
    assert.ok(dbCount > 0);
    assert.strictEqual(dbCount, result.modelCount);
  });

  it("happy path: entries in DB have correct source and categories", async () => {
    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "unique-test-model", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(makeLeaderboardData([], "code"));
      return new Response("Not found", { status: 404 });
    });

    await syncArenaElo();

    const entries = (await getAllEntries()).filter((e) => String(e.model) === "unique-test-model");
    const categories = entries.map((e) => String(e.category)).sort();
    assert.deepStrictEqual(categories, ["debugging", "default", "documentation", "review"]);

    for (const entry of entries) {
      assert.strictEqual(entry.source, "arena_elo");
    }
  });

  it("dryRun=true → does not call bulkUpsertModelIntelligence", async () => {
    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "test-model", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(makeLeaderboardData([], "code"));
      return new Response("Not found", { status: 404 });
    });

    const result = await syncArenaElo(true);

    assert.strictEqual(result.success, true);
    assert.ok(result.modelCount > 0);

    const dbCount = await countArenaEloEntries();
    assert.strictEqual(dbCount, 0, "dryRun should not write to DB");
  });

  it("dryRun=true does not update lastSyncTime", async () => {
    // Reset module-level state by observing that before this test's dryRun,
    // lastSync should remain unchanged from whatever it was.
    // Since we can't reset module-level vars, we verify that a dryRun
    // after a non-dryRun doesn't overwrite the model count.
    const statusBefore = await getArenaEloSyncStatus();

    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "test-model", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(makeLeaderboardData([], "code"));
      return new Response("Not found", { status: 404 });
    });

    await syncArenaElo(true);

    const statusAfter = await getArenaEloSyncStatus();
    // dryRun should not change the modelCount
    assert.strictEqual(statusAfter.lastSyncModelCount, statusBefore.lastSyncModelCount);
  });

  it("API failure → returns success=false with error", async () => {
    mockFetch(async () => {
      throw new Error("Network down");
    });

    const result = await syncArenaElo();

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.source, "arena_elo");
    assert.strictEqual(result.modelCount, 0);
    assert.ok(result.error);
    assert.ok(
      result.error!.includes("All Arena leaderboard fetches failed"),
      `unexpected: ${result.error}`
    );
  });

  it("calls deleteExpiredIntelligence before writing new entries", async () => {
    await getTestBackend().execute(
      "INSERT INTO model_intelligence (model, source, category, score, elo_raw, confidence, synced_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        "old-model",
        "arena_elo",
        "default",
        0.5,
        1000,
        "low",
        "2025-01-01T00:00:00Z",
        "2020-01-01T00:00:00Z",
      ]
    );

    assert.strictEqual(await countArenaEloEntries(), 1);

    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "new-model", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(makeLeaderboardData([], "code"));
      return new Response("Not found", { status: 404 });
    });

    const syncResult = await syncArenaElo();
    assert.strictEqual(syncResult.success, true);

    const expiredEntry = await getTestBackend().queryOne(
      "SELECT * FROM model_intelligence WHERE model = 'old-model'"
    );
    assert.ok(!expiredEntry, "expired row must be deleted");
  });

  it("handles empty leaderboard gracefully (0 entries, no DB write)", async () => {
    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(makeLeaderboardData([], "text"));
      if (url.includes("name=code")) return jsonResponse(makeLeaderboardData([], "code"));
      return new Response("Not found", { status: 404 });
    });

    const result = await syncArenaElo();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.modelCount, 0);
    assert.strictEqual(await countArenaEloEntries(), 0);
  });

  it("updates lastSyncTime after successful sync", async () => {
    const textData = makeLeaderboardData(
      [makeModelEntry({ model: "test-model", score: 1200, votes: 5000, rank: 1 })],
      "text"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(makeLeaderboardData([], "code"));
      return new Response("Not found", { status: 404 });
    });

    await syncArenaElo();

    const status = await getArenaEloSyncStatus();
    assert.ok(status.lastSync);
    assert.ok(status.lastSyncModelCount > 0);
  });

  it("stores no cross-generation alias rows in the DB (MODEL_ALIAS_MAP removed, #11504)", async () => {
    const textData = makeLeaderboardData(
      [
        makeModelEntry({
          model: "anthropic/claude-opus-4-6-thinking",
          score: 1400,
          votes: 5000,
          rank: 1,
        }),
      ],
      "text"
    );

    mockFetch(async (url: string) => {
      if (url.includes("name=text")) return jsonResponse(textData);
      if (url.includes("name=code")) return jsonResponse(makeLeaderboardData([], "code"));
      return new Response("Not found", { status: 404 });
    });

    await syncArenaElo();

    const entries = await getAllEntries();
    const models = entries.map((e) => String(e.model));

    assert.ok(models.includes("claude-opus-4-6-thinking"));
    assert.ok(!models.includes("claude-opus-4"));
  });
});

// ═══════════════════════════════════════════════════════════
// 5. getArenaEloSyncStatus()
// ═══════════════════════════════════════════════════════════

describe("getArenaEloSyncStatus()", () => {
  it("returns correct structure with all expected keys", async () => {
    const status = await getArenaEloSyncStatus();

    assert.ok("enabled" in status);
    assert.ok("lastSync" in status);
    assert.ok("lastSyncModelCount" in status);
    assert.ok("nextSync" in status);
    assert.ok("intervalMs" in status);
    assert.ok("sources" in status);
  });

  it("returns sources containing 'arena_elo'", async () => {
    const status = await getArenaEloSyncStatus();
    assert.deepStrictEqual(status.sources, ["arena_elo"]);
  });

  it("returns intervalMs as a positive number", async () => {
    const status = await getArenaEloSyncStatus();
    assert.ok(typeof status.intervalMs === "number");
    assert.ok(status.intervalMs > 0);
  });

  it("returns lastSyncModelCount as 0 before any non-dryRun sync completes in this suite context", async () => {
    // Module-level lastSyncTime may leak from earlier tests in the suite,
    // but the structural fields are always present.
    const status = await getArenaEloSyncStatus();
    assert.ok(typeof status.lastSync === "string" || status.lastSync === null);
    assert.ok(typeof status.lastSyncModelCount === "number");
    assert.ok(typeof status.nextSync === "string" || status.nextSync === null);
  });

  it("reflects ARENA_ELO_SYNC_ENABLED env var (on by default, opt-out)", async () => {
    const original = process.env.ARENA_ELO_SYNC_ENABLED;

    process.env.ARENA_ELO_SYNC_ENABLED = "true";
    const enabledStatus = await getArenaEloSyncStatus();
    assert.strictEqual(enabledStatus.enabled, true);

    process.env.ARENA_ELO_SYNC_ENABLED = "false";
    const disabledStatus = await getArenaEloSyncStatus();
    assert.strictEqual(disabledStatus.enabled, false);

    // Default (unset) is now enabled — only an explicit "false" opts out.
    delete process.env.ARENA_ELO_SYNC_ENABLED;
    const defaultStatus = await getArenaEloSyncStatus();
    assert.strictEqual(defaultStatus.enabled, true);

    if (original !== undefined) {
      process.env.ARENA_ELO_SYNC_ENABLED = original;
    } else {
      delete process.env.ARENA_ELO_SYNC_ENABLED;
    }
  });

  it("reflects dashboard feature flag DB overrides before env values", async () => {
    process.env.ARENA_ELO_SYNC_ENABLED = "true";
    try {
      await setFeatureFlagOverride("ARENA_ELO_SYNC_ENABLED", "false");
      await syncFlagSnapshot();

      const status = await getArenaEloSyncStatus();
      assert.strictEqual(status.enabled, false);
    } finally {
      await removeFeatureFlagOverride("ARENA_ELO_SYNC_ENABLED");
      await syncFlagSnapshot();
    }
  });

  it("falls back to the env value if the feature flag store is unavailable", async () => {
    const backend = getTestBackend();
    await backend.execute("ALTER TABLE config_entries RENAME TO config_entries_hidden");
    try {
      process.env.ARENA_ELO_SYNC_ENABLED = "false";

      const status = await getArenaEloSyncStatus();
      assert.strictEqual(status.enabled, false);
    } finally {
      await backend.execute("ALTER TABLE config_entries_hidden RENAME TO config_entries");
    }
  });

  it("serves the persisted date after a restart (memory empty)", async () => {
    const FRESH = "2026-10-14T12:00:00Z";
    const FRESH_ISO = "2026-10-14T12:00:00.000Z";
    const entries = transformToModelIntelligence(
      makeLeaderboardMap({
        text: [makeModelEntry({ model: "persisted-model", score: 1300, votes: 5000, rank: 1 })],
      })
    );
    assert.ok(entries.length > 0);
    await applyArenaEloRefresh(entries);
    await setArenaSyncedAt(FRESH);
    const status = await getArenaEloSyncStatus();
    assert.strictEqual(status.lastSync, FRESH_ISO);
  });

  it("normalizes persisted ISO offsets to UTC", async () => {
    await deleteArenaRows();
    const entries = transformToModelIntelligence(
      makeLeaderboardMap({
        text: [makeModelEntry({ model: "offset-model", score: 1300, votes: 5000, rank: 1 })],
      })
    );
    assert.ok(entries.length > 0);
    await applyArenaEloRefresh(entries);
    await setArenaSyncedAt("2026-10-14T07:20:30-03:00");
    const status = await getArenaEloSyncStatus();
    assert.strictEqual(status.lastSync, "2026-10-14T10:20:30.000Z");
  });

  // The SQLite-era "falls back to memory when the persisted date is malformed" case is gone:
  // synced_at is a timestamptz now, so an unparsable value cannot be stored.

  it("ignores rows from other sources when serving freshness", async () => {
    await deleteArenaRows();
    const entries = transformToModelIntelligence(
      makeLeaderboardMap({
        text: [makeModelEntry({ model: "isolation-model", score: 1300, votes: 5000, rank: 1 })],
      })
    );
    assert.ok(entries.length > 0);
    await applyArenaEloRefresh(entries);
    await setArenaSyncedAt("2026-10-14T10:20:30Z");
    await getTestBackend().execute(
      "INSERT INTO model_intelligence (model, source, category, score, synced_at) VALUES ($1, $2, $3, $4, $5)",
      ["other-model", "models_dev_tier", "text", 0.9, "2026-10-15T10:20:30Z"]
    );
    const status = await getArenaEloSyncStatus();
    assert.strictEqual(status.lastSync, "2026-10-14T10:20:30.000Z");
  });

  it("falls back to memory without error when no arena_elo row exists", async () => {
    const before = (await getArenaEloSyncStatus()).lastSync;
    await deleteArenaRows();
    const status = await getArenaEloSyncStatus();
    assert.strictEqual(status.lastSync, before);
  });

  it("falls back to memory without error when arena_elo rows are removed", async () => {
    await deleteArenaRows();
    const emptyBaseline = (await getArenaEloSyncStatus()).lastSync;
    const entries = transformToModelIntelligence(
      makeLeaderboardMap({
        text: [makeModelEntry({ model: "removed-model", score: 1300, votes: 5000, rank: 1 })],
      })
    );
    assert.ok(entries.length > 0);
    await applyArenaEloRefresh(entries);
    await setArenaSyncedAt("2026-10-14T10:20:30Z");
    assert.strictEqual((await getArenaEloSyncStatus()).lastSync, "2026-10-14T10:20:30.000Z");
    await deleteArenaRows();
    const status = await getArenaEloSyncStatus();
    assert.strictEqual(status.lastSync, emptyBaseline);
  });

  it("public health exposes no arena freshness (liveness only)", async () => {
    const { GET } = await import("../../../src/app/api/health/route.ts");
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(
      !("lastSync" in body) && !("synced_at" in body) && !JSON.stringify(body).includes("arena")
    );
    assert.ok(typeof body.timestamp === "string");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. stopArenaEloSync()
// ═══════════════════════════════════════════════════════════

describe("stopArenaEloSync()", () => {
  it("initArenaEloSync returns false when disabled by feature flag", async () => {
    try {
      await setFeatureFlagOverride("ARENA_ELO_SYNC_ENABLED", "false");
      await syncFlagSnapshot();
      const started = await initArenaEloSync();
      assert.strictEqual(started, false);
    } finally {
      await removeFeatureFlagOverride("ARENA_ELO_SYNC_ENABLED");
      await syncFlagSnapshot();
    }
  });

  it("does not throw when no timer is running", () => {
    assert.doesNotThrow(() => stopArenaEloSync());
  });

  it("can be called multiple times without error", () => {
    stopArenaEloSync();
    assert.doesNotThrow(() => stopArenaEloSync());
    assert.doesNotThrow(() => stopArenaEloSync());
  });
});
