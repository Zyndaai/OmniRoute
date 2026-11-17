import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-radar-intel-db-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STORAGE_ENCRYPTION_KEY = "test-encryption-key-for-radar-intel-db-32b!";

const core = await import("../../src/lib/db/core.ts");
const radar = await import("../../src/lib/db/radar.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");

async function resetStorage(): Promise<void> {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Intel migration provides a byte-preserving single-row cache", async () => {
  assert.equal(await radar.getRadarIntelCache(), null);
  await radar.setRadarIntelCache({
    version: "2026.08.09.1",
    tier: "live",
    payload: '{"exact":true}\n',
    signature: "signed",
    supporterIdentity: `radar:${"a".repeat(64)}`,
    fetchedAt: "2026-08-09T12:05:00.000Z",
  });
  assert.deepEqual(await radar.getRadarIntelCache(), {
    version: "2026.08.09.1",
    tier: "live",
    payload: '{"exact":true}\n',
    signature: "signed",
    supporterIdentity: `radar:${"a".repeat(64)}`,
    fetchedAt: "2026-08-09T12:05:00.000Z",
  });
});

test("changing supporter key invalidates catalog, referrals, offers, and Intel atomically", async () => {
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
  await radar.setRadarIntelCache({
    version: "2026.08.09.1",
    tier: "live",
    payload: "{}",
    signature: "d",
    supporterIdentity: `radar:${"a".repeat(64)}`,
  });

  await radar.setRadarKey(`omr_${"b".repeat(40)}`);

  assert.equal(await radar.getRadarCache(), null);
  assert.equal(await radar.getRadarReferralsCache(), null);
  assert.equal(await radar.getRadarOffersCache(), null);
  assert.equal(await radar.getRadarIntelCache(), null);
});
