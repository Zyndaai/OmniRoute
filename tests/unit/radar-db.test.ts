/**
 * tests/unit/radar-db.test.ts
 *
 * TDD regression guard for the Radar client local DB module:
 * - radar_cache (kind = 'feed'): single-row signed feed cache
 * - radar_settings: opt-in + encrypted supporter key
 *
 * Covers: empty state, round-trip, upsert replacement, encryption at rest,
 * key clear, and settings persistence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

// Isolate the data directory (the database itself is isolated per process by isolatePostgres.ts)
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-radar-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Enable encryption so we can verify at-rest encryption of supporter key
process.env.STORAGE_ENCRYPTION_KEY = "test-encryption-key-for-radar-db-tests-32b!";

const radar = await import("../../src/lib/db/radar.ts");

async function resetStorage() {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.STORAGE_ENCRYPTION_KEY;
});

// ---------------------------------------------------------------------------
// radar_cache (kind = 'feed')
// ---------------------------------------------------------------------------

test("getRadarCache returns null when no cache exists", async () => {
  const result = await radar.getRadarCache();
  assert.equal(result, null, "empty cache must return null");
});

test("setRadarCache then getRadarCache round-trips exactly", async () => {
  const feed = {
    version: "2026-08-03T00:00:00Z",
    tier: "community",
    payload: JSON.stringify({ models: [{ id: "gpt-4o", provider: "openai" }] }),
    signature: "ed25519:abc123def456",
  };

  await radar.setRadarCache(feed);
  const result = await radar.getRadarCache();

  assert.ok(result, "cache must not be null after set");
  assert.equal(result.version, feed.version, "version must round-trip");
  assert.equal(result.tier, feed.tier, "tier must round-trip");
  assert.equal(result.payload, feed.payload, "payload must round-trip byte-identically");
  assert.equal(result.signature, feed.signature, "signature must round-trip");
  assert.ok(result.fetchedAt, "fetchedAt must be set");
});

test("second setRadarCache REPLACES the row (still single row)", async () => {
  const backend = getTestBackend();

  await radar.setRadarCache({
    version: "v1",
    tier: "community",
    payload: '{"old":true}',
    signature: "sig-old",
  });

  await radar.setRadarCache({
    version: "v2",
    tier: "live",
    payload: '{"new":true}',
    signature: "sig-new",
  });

  const result = await radar.getRadarCache();
  assert.ok(result);
  assert.equal(result.version, "v2", "must have the second version");
  assert.equal(result.tier, "live", "must have the second tier");
  assert.equal(result.payload, '{"new":true}', "must have the second payload");

  // Verify only one feed row exists
  const count = await backend.queryOne<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM radar_cache WHERE kind = 'feed'"
  );
  assert.equal(count?.c, 1, "must have exactly one feed row");
});

test("setRadarCache uses fetchedAt when provided", async () => {
  const fixed = "2026-08-03T12:00:00.000Z";

  await radar.setRadarCache({
    version: "v1",
    tier: "community",
    payload: "{}",
    signature: "sig",
    fetchedAt: fixed,
  });

  const result = await radar.getRadarCache();
  assert.ok(result);
  assert.equal(
    new Date(result.fetchedAt).getTime(),
    Date.parse(fixed),
    "must use the provided fetchedAt"
  );
});

// ---------------------------------------------------------------------------
// radar_settings
// ---------------------------------------------------------------------------

test("getRadarSettings defaults: optIn false, key null", async () => {
  const settings = await radar.getRadarSettings();

  assert.equal(settings.optIn, false, "default optIn must be false");
  assert.equal(settings.supporterKey, null, "default supporterKey must be null");
  assert.ok(settings.updatedAt, "updatedAt must be set on first read");
});

test("setRadarOptIn(true) persists", async () => {
  await radar.setRadarOptIn(true);
  const settings = await radar.getRadarSettings();
  assert.equal(settings.optIn, true, "optIn must be true after setRadarOptIn(true)");

  await radar.setRadarOptIn(false);
  const settings2 = await radar.getRadarSettings();
  assert.equal(settings2.optIn, false, "optIn must be false after setRadarOptIn(false)");
});

test("setRadarKey encrypts at rest and getRadarSettings decrypts", async () => {
  const backend = getTestBackend();
  const clearKey = "omr_" + "a".repeat(40);

  await radar.setRadarKey(clearKey);
  const settings = await radar.getRadarSettings();

  assert.equal(settings.supporterKey, clearKey, "getRadarSettings must return the clear key");

  // Direct DB query to prove encryption at rest
  const row = await backend.queryOne<{ supporter_key_encrypted: string | null }>(
    "SELECT supporter_key_encrypted FROM radar_settings WHERE id = 1"
  );
  assert.ok(row, "radar_settings row must exist");
  assert.ok(
    row.supporter_key_encrypted !== clearKey,
    "stored value must NOT be the clear key (encryption at rest)"
  );
  assert.ok(
    row.supporter_key_encrypted?.startsWith("enc:v1:"),
    "stored value must carry the enc:v1: prefix"
  );
});

test("setRadarKey(null) clears the key", async () => {
  const backend = getTestBackend();

  await radar.setRadarKey("omr_" + "b".repeat(40));
  assert.ok((await radar.getRadarSettings()).supporterKey, "key must be set");

  await radar.setRadarKey(null);
  const settings = await radar.getRadarSettings();
  assert.equal(settings.supporterKey, null, "key must be null after clearing");

  // Direct DB check
  const cleared = await backend.queryOne<{ supporter_key_encrypted: string | null }>(
    "SELECT supporter_key_encrypted FROM radar_settings WHERE id = 1"
  );
  assert.equal(cleared?.supporter_key_encrypted, null, "DB value must be null");
});

test("changing the supporter key invalidates the entitlement-sensitive referrals cache", async () => {
  await radar.setRadarCache({
    version: "2026.08.07.1",
    tier: "live",
    payload: '{"models":[]}',
    signature: "catalog-live-signature",
  });
  await radar.setRadarReferralsCache({
    generatedAt: "2026-08-07T12:00:00.000Z",
    tier: "live",
    payload: '{"referrals":{"fixed":[],"campaigns":[{"provider":"groq"}]}}',
    signature: "live-signature",
  });
  assert.ok(await radar.getRadarReferralsCache(), "precondition: live referrals cache exists");
  assert.ok(await radar.getRadarCache(), "precondition: live catalog cache exists");

  await radar.setRadarKey("omr_" + "d".repeat(40));

  assert.equal(
    await radar.getRadarReferralsCache(),
    null,
    "a new key must force the next referrals read to resolve entitlement server-side"
  );
  assert.equal(
    await radar.getRadarCache(),
    null,
    "a new key must force the next catalog sync to resolve entitlement server-side"
  );
});

test("setRadarKey uses existing AES-256-GCM encryption from encryption.ts", async () => {
  const backend = getTestBackend();
  const clearKey = "omr_" + "c".repeat(40);

  await radar.setRadarKey(clearKey);

  const encRow = await backend.queryOne<{ supporter_key_encrypted: string }>(
    "SELECT supporter_key_encrypted FROM radar_settings WHERE id = 1"
  );
  assert.ok(encRow);

  // Verify it uses the enc:v1: format (same as provider credentials)
  assert.ok(
    encRow.supporter_key_encrypted.startsWith("enc:v1:"),
    "must use enc:v1: prefix (AES-256-GCM from encryption.ts)"
  );

  // Verify the format: enc:v1:<iv_hex>:<ciphertext_hex>:<authTag_hex>
  const body = encRow.supporter_key_encrypted.slice("enc:v1:".length);
  const parts = body.split(":");
  assert.equal(parts.length, 3, "must have 3 parts (iv:ciphertext:authTag)");
});

// ---------------------------------------------------------------------------
// radar_cache (kind = 'referrals') -- standalone `GET /v1/referrals/latest`
// cache, separate from the catalog feed (kind = 'feed').
// ---------------------------------------------------------------------------

test("getRadarReferralsCache returns null when no cache exists", async () => {
  const result = await radar.getRadarReferralsCache();
  assert.equal(result, null, "empty referrals cache must return null");
});

test("setRadarReferralsCache then getRadarReferralsCache round-trips exactly", async () => {
  const entry = {
    generatedAt: "2026-08-07T12:00:00.000Z",
    tier: "live",
    payload: JSON.stringify({ referrals: { fixed: [], campaigns: [] } }),
    signature: "ed25519:referrals-sig-abc",
  };

  await radar.setRadarReferralsCache(entry);
  const result = await radar.getRadarReferralsCache();

  assert.ok(result, "referrals cache must not be null after set");
  assert.equal(result.generatedAt, entry.generatedAt, "generatedAt must round-trip");
  assert.equal(result.tier, entry.tier, "tier must round-trip");
  assert.equal(result.payload, entry.payload, "payload must round-trip byte-identically");
  assert.equal(result.signature, entry.signature, "signature must round-trip");
  assert.ok(result.fetchedAt, "fetchedAt must be set");
});

test("second setRadarReferralsCache REPLACES the row (still single row)", async () => {
  const backend = getTestBackend();

  await radar.setRadarReferralsCache({
    generatedAt: "2026-08-07T10:00:00.000Z",
    tier: "community",
    payload: '{"old":true}',
    signature: "sig-old",
  });

  await radar.setRadarReferralsCache({
    generatedAt: "2026-08-07T12:00:00.000Z",
    tier: "live",
    payload: '{"new":true}',
    signature: "sig-new",
  });

  const result = await radar.getRadarReferralsCache();
  assert.ok(result);
  assert.equal(
    new Date(result.generatedAt).toISOString(),
    "2026-08-07T12:00:00.000Z",
    "must have the second generatedAt"
  );
  assert.equal(result.tier, "live", "must have the second tier");
  assert.equal(result.payload, '{"new":true}', "must have the second payload");

  const count = await backend.queryOne<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM radar_cache WHERE kind = 'referrals'"
  );
  assert.equal(count?.c, 1, "must have exactly one referrals row");
});

test("setRadarReferralsCache uses fetchedAt when provided", async () => {
  const fixed = "2026-08-07T12:00:00.000Z";

  await radar.setRadarReferralsCache({
    generatedAt: "2026-08-07T12:00:00.000Z",
    tier: "community",
    payload: "{}",
    signature: "sig",
    fetchedAt: fixed,
  });

  const result = await radar.getRadarReferralsCache();
  assert.ok(result);
  assert.equal(
    new Date(result.fetchedAt).getTime(),
    Date.parse(fixed),
    "must use the provided fetchedAt"
  );
});

test("referrals cache is independent of the catalog feed cache (separate kinds)", async () => {
  await radar.setRadarCache({
    version: "2026.08.01.1",
    tier: "community",
    payload: '{"catalog":true}',
    signature: "catalog-sig",
  });
  await radar.setRadarReferralsCache({
    generatedAt: "2026-08-07T12:00:00.000Z",
    tier: "live",
    payload: '{"referrals":true}',
    signature: "referrals-sig",
  });

  const catalogCache = await radar.getRadarCache();
  const referralsCache = await radar.getRadarReferralsCache();

  assert.equal(catalogCache?.payload, '{"catalog":true}');
  assert.equal(referralsCache?.payload, '{"referrals":true}');
  assert.notEqual(
    catalogCache?.payload,
    referralsCache?.payload,
    "the two caches must never share storage"
  );
});
