import test from "node:test";
import assert from "node:assert/strict";

import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";

const providersDb = await import("../../../src/lib/db/providers.ts");
const {
  setConnectionRateLimitUntil,
  clearConnectionRateLimit,
  isConnectionRateLimited,
} = providersDb;

// rate_limited_until is a timestamptz; the driver returns it as an ISO string (or null).
async function readRateLimitedUntil(connectionId: string): Promise<number | null> {
  const row = await getTestBackend().queryOne<{ rate_limited_until: string | null }>(
    "SELECT rate_limited_until FROM provider_connections WHERE id = $1",
    [connectionId]
  );
  const value = row?.rate_limited_until ?? null;
  return value === null ? null : Date.parse(String(value));
}

test.beforeEach(async () => {
  await resetTestDb();
});

async function seedConnection(): Promise<string> {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Guard probe",
    apiKey: "guard-key",
  });
  return (connection as { id: string }).id;
}

test("ignores NaN (row unchanged)", async () => {
  const id = await seedConnection();
  await setConnectionRateLimitUntil(id, NaN);
  assert.equal(await readRateLimitedUntil(id), null);
});

test("ignores Infinity and -Infinity", async () => {
  const id = await seedConnection();
  await setConnectionRateLimitUntil(id, Infinity);
  await setConnectionRateLimitUntil(id, -Infinity);
  assert.equal(await readRateLimitedUntil(id), null);
});

test("ignores past timestamps and 0 (documented noop; clear path is null)", async () => {
  const id = await seedConnection();
  await setConnectionRateLimitUntil(id, Date.now() - 1000);
  await setConnectionRateLimitUntil(id, 0);
  assert.equal(await readRateLimitedUntil(id), null);
});

test("writes future timestamps", async () => {
  const id = await seedConnection();
  const until = Date.now() + 60_000;
  await setConnectionRateLimitUntil(id, until);
  assert.equal(await readRateLimitedUntil(id), until);
  assert.equal(await isConnectionRateLimited(id), true);
});

test("preserves null clear (non-regression for clearConnectionRateLimit)", async () => {
  const id = await seedConnection();
  await setConnectionRateLimitUntil(id, Date.now() + 60_000);
  await clearConnectionRateLimit(id);
  assert.equal(await readRateLimitedUntil(id), null);
  assert.equal(await isConnectionRateLimited(id), false);
});

test("expired write does not overwrite a live row (future preserved)", async () => {
  const id = await seedConnection();
  const future = Date.now() + 60_000;
  await setConnectionRateLimitUntil(id, future);
  await setConnectionRateLimitUntil(id, Date.now() - 1000);
  assert.equal(await readRateLimitedUntil(id), future);
  assert.equal(await isConnectionRateLimited(id), true);
});

// Without the guard the TEXT column stores the string "NaN" — rejected by
// current readers, but hygiene demands never writing it.
