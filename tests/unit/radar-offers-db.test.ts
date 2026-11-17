import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-radar-offers-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STORAGE_ENCRYPTION_KEY = "test-encryption-key-for-radar-offers-db-32b!";

const radar = await import("../../src/lib/db/radar.ts");

async function resetStorage(): Promise<void> {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.STORAGE_ENCRYPTION_KEY;
});

test("Radar offers cache is a single-row, byte-preserving kind in radar_cache", async () => {
  const backend = getTestBackend();
  assert.equal(await radar.getRadarOffersCache(), null);

  await radar.setRadarOffersCache({
    version: "2026.08.09.1",
    tier: "live",
    payload: '{"byte":"exact"}\n',
    signature: "signed",
    fetchedAt: "2026-08-09T12:05:00.000Z",
  });
  await radar.setRadarOffersCache({
    version: "2026.08.09.2",
    tier: "live",
    payload: '{"replacement":true}',
    signature: "signed-again",
    fetchedAt: "2026-08-09T12:10:00.000Z",
  });

  const cached = await radar.getRadarOffersCache();
  assert.deepEqual(
    { ...cached, fetchedAt: cached && Date.parse(cached.fetchedAt) },
    {
      version: "2026.08.09.2",
      tier: "live",
      payload: '{"replacement":true}',
      signature: "signed-again",
      fetchedAt: Date.parse("2026-08-09T12:10:00.000Z"),
    }
  );
  const row = await backend.queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM radar_cache WHERE kind = 'offers'"
  );
  assert.equal(row?.count, 1);
});

test("changing the supporter key atomically invalidates every entitlement-sensitive cache", async () => {
  const backend = getTestBackend();
  await radar.setRadarCache({
    version: "2026.08.09.1",
    tier: "live",
    payload: "{}",
    signature: "a",
  });
  await radar.setRadarReferralsCache({
    generatedAt: "2026-08-09T12:00:00.000Z",
    tier: "live",
    payload: "{}",
    signature: "b",
  });
  await radar.setRadarOffersCache({
    version: "2026.08.09.1",
    tier: "live",
    payload: "{}",
    signature: "c",
  });

  await radar.setRadarKey(`omr_${"a".repeat(40)}`);

  assert.equal(await radar.getRadarCache(), null);
  assert.equal(await radar.getRadarReferralsCache(), null);
  assert.equal(await radar.getRadarOffersCache(), null);
  const stored = await backend.queryOne<{ key: string }>(
    "SELECT supporter_key_encrypted AS key FROM radar_settings WHERE id = 1"
  );
  assert.ok(stored?.key, "an encrypted key must be stored");
  assert.ok(!stored.key.includes("omr_"), "supporter key must stay encrypted at rest");
});
