import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-15531-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const TEST_PROVIDER = "__test_provider_15531__";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const { resetTestDb } = await import("../helpers/postgres.ts");

async function resetStorage() {
  await resetTestDb();
}

test.beforeEach(async () => {
  await resetStorage();
});
test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Every seeded entry MUST carry fetchedAt + source: normalizeCacheEntry drops
// entries without a non-empty fetchedAt, which would make the sanity asserts
// pass vacuously and the regression meaningless.
function cacheEntry(tag: string) {
  return {
    quotas: { "test-model": { used: 1, total: 100 } },
    plan: "pro",
    message: `seeded for ${tag}`,
    fetchedAt: new Date().toISOString(),
    source: "test",
  };
}

async function setupConnectionWithCache(tag: string) {
  const created = await providersDb.createProviderConnection({
    provider: TEST_PROVIDER,
    authType: "apikey",
    name: `Test conn ${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    apiKey: `sk-test-15531-${Math.random().toString(36).slice(2, 9)}`,
  });
  assert.ok(created?.id, "connection must be created");
  const connId = (created as { id: string }).id;
  await providerLimitsDb.setProviderLimitsCache(connId, cacheEntry(tag));

  const before = await providerLimitsDb.getProviderLimitsCache(connId);
  assert.ok(before, `sanity: providerLimitsCache entry exists before delete for ${connId}`);
  assert.ok(
    (await providerLimitsDb.getAllProviderLimitsCache())[connId],
    `sanity: getAllProviderLimitsCache exposes ${connId} before delete`
  );
  return connId;
}

test("#15531: deleteProviderConnection purges the providerLimitsCache entry of the deleted connection", async () => {
  const connId = await setupConnectionWithCache("single");

  const deleted = await providersDb.deleteProviderConnection(connId);
  assert.equal(deleted, true, "connection row must be deleted");

  assert.equal(
    await providerLimitsDb.getProviderLimitsCache(connId),
    null,
    "EXPECTED: providerLimitsCache entry purged with the connection"
  );
  assert.equal(
    (await providerLimitsDb.getAllProviderLimitsCache())[connId],
    undefined,
    "EXPECTED: providerLimitsCache key absent from the full cache after delete"
  );
});

test("#15531: deleteProviderConnections purges providerLimitsCache entries for the whole batch", async () => {
  const connA = await setupConnectionWithCache("bulk-a");
  const connB = await setupConnectionWithCache("bulk-b");

  const deleted = await providersDb.deleteProviderConnections([connA, connB]);
  assert.equal(deleted, 2, "both connections deleted");

  assert.equal(await providerLimitsDb.getProviderLimitsCache(connA), null);
  assert.equal(await providerLimitsDb.getProviderLimitsCache(connB), null);
  const all = await providerLimitsDb.getAllProviderLimitsCache();
  assert.equal(all[connA], undefined);
  assert.equal(all[connB], undefined);
});

test("#15531: deleteProviderConnectionsByProvider purges providerLimitsCache entries for all provider connections", async () => {
  const connA = await setupConnectionWithCache("by-provider-a");
  const connB = await setupConnectionWithCache("by-provider-b");

  const deleted = await providersDb.deleteProviderConnectionsByProvider(TEST_PROVIDER);
  assert.equal(deleted, 2, "both provider connections deleted");

  assert.equal(await providerLimitsDb.getProviderLimitsCache(connA), null);
  assert.equal(await providerLimitsDb.getProviderLimitsCache(connB), null);
  const all = await providerLimitsDb.getAllProviderLimitsCache();
  assert.equal(all[connA], undefined);
  assert.equal(all[connB], undefined);
});

test("#15531: deleteProviderConnections with an empty batch is a no-op and leaves providerLimitsCache untouched", async () => {
  const connId = await setupConnectionWithCache("noop-batch");

  const deleted = await providersDb.deleteProviderConnections([]);
  assert.equal(deleted, 0, "empty batch deletes nothing");

  assert.ok(
    await providerLimitsDb.getProviderLimitsCache(connId),
    "providerLimitsCache entry must survive the empty batch"
  );
});

test("#15531: deleteProviderConnectionsByProvider with no matching provider leaves providerLimitsCache untouched", async () => {
  const connId = await setupConnectionWithCache("noop-provider");

  const deleted = await providersDb.deleteProviderConnectionsByProvider(
    "__no_such_provider_15531__"
  );
  assert.equal(deleted, 0, "no provider connections matched, nothing to delete");

  assert.ok(
    await providerLimitsDb.getProviderLimitsCache(connId),
    "providerLimitsCache entry must survive the unmatched provider delete"
  );
});
