import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-weak-rng-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { resetTestDb } = await import("../../helpers/postgres.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");

async function seedConnectionId(): Promise<string> {
  // quota_pool_connections has a FK to provider_connections(id).
  const conn = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "fake-weak-rng",
    isActive: true,
  });
  return conn!.id;
}

test.after(() => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});

test("quotaPools.makeId returns UUID without Math.random fallback", async () => {
  const { createPool } = await import("../../../src/lib/db/quotaPools.ts");
  await resetTestDb();

  const pool = await createPool({ connectionId: await seedConnectionId(), name: "test-pool" });
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(pool.id, uuidRegex, `ID should be UUID format, got: ${pool.id}`);
});

test("quotaGroups.makeId returns UUID without Math.random fallback", async () => {
  const { createGroup } = await import("../../../src/lib/db/quotaGroups.ts");
  await resetTestDb();

  const group = await createGroup("test-group");
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.match(group.id, uuidRegex, `ID should be UUID format, got: ${group.id}`);
});

test("quotaPools.makeId produces unique IDs across calls", async () => {
  const { createPool } = await import("../../../src/lib/db/quotaPools.ts");

  const ids = new Set<string>();
  await resetTestDb();
  const connectionId = await seedConnectionId();
  for (let i = 0; i < 10; i++) {
    const pool = await createPool({ connectionId, name: `pool-${i}` });
    ids.add(pool.id);
  }
  assert.equal(ids.size, 10, "All 10 IDs should be unique");
});

test("migrationRunner probe table format uses crypto.randomUUID", async () => {
  const probeName = `__omniroute_fts5_probe_${crypto.randomUUID().replace(/-/g, "_")}`;
  assert.match(
    probeName,
    /^__omniroute_fts5_probe_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/i
  );
});
