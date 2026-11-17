/**
 * Redesign tests for src/lib/arenaEloSync.ts (remediation plan 2026-09-12).
 *
 * New invariants:
 *  1. A failing fetch must NEVER delete existing entries (the old
 *     delete-before-fetch bug drained the table on every failed sync).
 *  2. A successful sync replaces the dataset atomically: upsert all +
 *     prune entries not in the refreshed set, in one transaction.
 *  3. Freshness guard: skip syncing when the table is non-empty and the
 *     latest synced_at is within the sync interval.
 *  4. Failure backoff: a failed sync persists arena_elo.lastFailedAt in
 *     config_entries (namespace job_state); subsequent syncs within the backoff
 *     window are skipped (prevents boot-loop retry storms against a rate-limited
 *     upstream).
 *  5. A successful sync clears any lastFailedAt stamp.
 *
 * Runs against the isolated PostgreSQL test database (tests/helpers/postgres.ts).
 * Rows are seeded and read through the test backend with raw SQL.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-arena-redesign-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const { syncArenaElo, stopArenaEloSync } = await import("../../src/lib/arenaEloSync.ts");
import type { ArenaLeaderboardData, ArenaModelEntry } from "../../src/lib/arenaEloSync.ts";

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
  return { meta: { leaderboard: category, model_count: models.length }, models };
}

async function seedEntry(
  model: string,
  opts: { syncedAt?: string; category?: string; expiresAt?: string | null } = {}
): Promise<void> {
  const now = Date.now();
  await getTestBackend().execute(
    `INSERT INTO model_intelligence
       (model, source, category, score, elo_raw, confidence, synced_at, expires_at)
     VALUES ($1, 'arena_elo', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (model, source, category) DO UPDATE SET
       synced_at = EXCLUDED.synced_at, expires_at = EXCLUDED.expires_at`,
    [
      model,
      opts.category ?? "default",
      0.5,
      1200,
      "high",
      // Default: synced 2 days ago (stale) so the freshness guard does NOT
      // skip and tests actually reach the fetch path. Tests that WANT the
      // guard to fire pass an explicit fresh syncedAt.
      opts.syncedAt ?? new Date(now - 2 * 86400_000).toISOString(),
      opts.expiresAt ?? new Date(now + 86400_000).toISOString(),
    ]
  );
}

async function countArenaEloEntries(): Promise<number> {
  const row = await getTestBackend().queryOne<{ cnt: number }>(
    "SELECT COUNT(*)::int AS cnt FROM model_intelligence WHERE source = 'arena_elo'"
  );
  return Number(row?.cnt ?? 0);
}

async function getLastFailedAt(): Promise<string | null> {
  const row = await getTestBackend().queryOne<{ value: string | null }>(
    "SELECT value #>> '{}' AS value FROM config_entries WHERE namespace = 'job_state' AND key = 'arena_elo.lastFailedAt'"
  );
  return row?.value ?? null;
}

async function setLastFailedAt(value: string): Promise<void> {
  await getTestBackend().execute(
    `INSERT INTO config_entries (namespace, key, value)
     VALUES ('job_state', 'arena_elo.lastFailedAt', to_jsonb($1::text))
     ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
    [value]
  );
}

async function getAllEntries(): Promise<Array<Record<string, unknown>>> {
  return getTestBackend().query<Record<string, unknown>>(
    "SELECT * FROM model_intelligence WHERE source = 'arena_elo' ORDER BY model, category"
  );
}

/** Fetch mock that answers all categories with the given model lists. */
function fetchServing(modelsByCategory: Record<string, ArenaModelEntry[]>) {
  return async (url: string): Promise<Response> => {
    for (const [cat, models] of Object.entries(modelsByCategory)) {
      if (url.includes(`name=${cat}`)) return jsonResponse(makeLeaderboardData(models, cat));
    }
    return new Response("", { status: 404 });
  };
}

beforeEach(async () => {
  await core.resetDbInstance();
  await resetTestDb();
  stopArenaEloSync();
  delete process.env.ARENA_ELO_SYNC_INTERVAL;
});

afterEach(() => {
  restoreFetch();
  stopArenaEloSync();
});

describe("arenaEloSync redesign", () => {
  it("a failing fetch never deletes existing entries", async () => {
    await seedEntry("existing-model");
    assert.equal(await countArenaEloEntries(), 1);

    mockFetch(async () => {
      throw new Error("network down");
    });
    const result = await syncArenaElo();

    assert.equal(result.success, false);
    assert.equal(await countArenaEloEntries(), 1, "entries must survive a failed fetch");
    assert.ok(await getLastFailedAt(), "failure must persist arena_elo.lastFailedAt");
  });

  it("a successful sync replaces the dataset atomically (upsert + prune)", async () => {
    await seedEntry("stale-model"); // in DB, absent from the refreshed leaderboard

    mockFetch(
      fetchServing({
        text: [makeModelEntry({ model: "fresh-model" })],
        code: [],
      })
    );
    const result = await syncArenaElo();

    assert.equal(result.success, true);
    const models = (await getAllEntries()).map((r) => r.model as string);
    assert.ok(!models.includes("stale-model"), "stale entry must be pruned");
    assert.ok(models.includes("fresh-model"), "fresh entry must be present");
    assert.equal(await getLastFailedAt(), null, "success must clear lastFailedAt");
  });

  it("freshness guard: skips sync when table non-empty and synced_at within interval", async () => {
    await seedEntry("recent-model", { syncedAt: new Date(Date.now() - 60_000).toISOString() }); // 1 min ago

    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });
    const result = await syncArenaElo();

    assert.equal(fetchCalled, false, "fresh table must not trigger a fetch");
    assert.equal(result.success, true, "skip is a success (fast path)");
  });

  it("backoff wins even on an empty table: fresh lastFailedAt skips the fetch", async () => {
    // Empty table + fresh failure stamp = the exact boot-loop condition that
    // drained the live table (restart → sync → 429 → repeat). Backoff must
    // skip; the retry happens when the window (6h) elapses.
    await setLastFailedAt(new Date().toISOString());

    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });
    const result = await syncArenaElo();

    assert.equal(fetchCalled, false, "backoff must skip the fetch even when the table is empty");
    assert.equal(result.success, false, "backoff skip reports not-success (no data change)");
    assert.equal(await countArenaEloEntries(), 0, "table untouched during backoff");
  });

  it("failure backoff: skips sync within backoff window after a failure", async () => {
    await seedEntry("existing-model");
    mockFetch(async () => {
      throw new Error("429 rate limited");
    });
    await syncArenaElo();
    assert.ok(await getLastFailedAt(), "lastFailedAt persisted after failure");

    // Second attempt within the backoff window: fetch must NOT be called.
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });
    const result2 = await syncArenaElo();
    assert.equal(fetchCalled, false, "backoff must skip the fetch");
    assert.equal(result2.success, false, "backoff skip reports not-success (no data change)");
    assert.equal(await countArenaEloEntries(), 1, "entries untouched during backoff");
  });
});
