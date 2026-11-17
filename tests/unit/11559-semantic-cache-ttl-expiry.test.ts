/**
 * #11559 — the semantic cache never expired an entry whose `expires_at` fell on the
 * current UTC calendar day.
 *
 * `expires_at` is written as an ISO-8601 string ("2026-08-26T14:00:00.000Z") but was read
 * back with `expires_at > datetime('now')`, and `datetime('now')` renders as
 * "2026-08-26 14:00:00". Both are TEXT, so SQLite compares them lexicographically and they
 * diverge at index 10, where the stored value has 'T' (0x54) and `datetime('now')` has
 * ' ' (0x20). 'T' sorts after ' ', so any row whose date part equalled today's date looked
 * unexpired no matter what its time-of-day TTL said — up to ~24h of staleness, and it
 * survived restarts because `getCachedResponse` promotes DB rows back into the LRU.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearCache,
  clearMemoryCache,
  getCachedResponse,
  getCacheStats,
  setCachedResponse,
} from "../../src/lib/semanticCache.ts";
import { getTestBackend } from "../helpers/postgres.ts";

/** Midnight of the UTC day the database considers "today" — always <= now(). */
async function startOfDbToday(): Promise<string> {
  const row = await getTestBackend().queryOne<{ day: string }>(
    "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day"
  );
  return `${String(row?.day)}T00:00:00.000Z`;
}

async function insertRow(signature: string, expiresAt: string, response: unknown) {
  await getTestBackend().execute(
    `INSERT INTO semantic_cache
       (signature, model, prompt_hash, response, tokens_saved, hit_count, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
     ON CONFLICT (signature) DO UPDATE SET expires_at = EXCLUDED.expires_at,
       response = EXCLUDED.response`,
    [
      signature,
      "gpt-4o",
      signature.slice(0, 16),
      JSON.stringify(response),
      7,
      new Date(Date.now() - 60_000).toISOString(),
      expiresAt,
    ]
  );
}

describe("#11559 semantic cache TTL expiry", () => {
  beforeEach(async () => {
    await clearCache();
  });

  it("misses a row that expired earlier today (UTC)", async () => {
    // Expired at 00:00 UTC today: the same calendar date as now(), which the old
    // text comparison (`expires_at > datetime('now')`) treated as unexpired.
    await insertRow("sig-expired-today", await startOfDbToday(), { choices: ["stale"] });
    clearMemoryCache();

    assert.equal(
      await getCachedResponse("sig-expired-today"),
      null,
      "an entry whose TTL lapsed earlier today must not be served"
    );
  });

  it("does not count a row that expired earlier today in dbEntries", async () => {
    await insertRow("sig-stats-expired", await startOfDbToday(), { choices: ["stale"] });
    clearMemoryCache();

    assert.equal((await getCacheStats()).dbEntries, 0);
  });

  it("still serves a row whose TTL has not lapsed", async () => {
    const response = { choices: [{ message: { content: "fresh" } }] };
    await insertRow("sig-live", new Date(Date.now() + 3_600_000).toISOString(), response);
    clearMemoryCache();

    assert.deepEqual(await getCachedResponse("sig-live"), response);
    assert.equal((await getCacheStats()).dbEntries, 1);
  });

  it("survives a memory eviction on a normally written entry", async () => {
    const response = { choices: [{ message: { content: "written" } }] };
    await setCachedResponse("sig-roundtrip", "gpt-4o", response, 12, 3_600_000);
    clearMemoryCache();

    assert.deepEqual(
      await getCachedResponse("sig-roundtrip"),
      response,
      "the read predicate must still match the ISO format setCachedResponse writes"
    );
  });
});
