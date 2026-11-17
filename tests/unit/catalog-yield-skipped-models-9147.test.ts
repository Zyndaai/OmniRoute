import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #9147: the catalog builder yields every N loop iterations, but the yield used to sit at
// the BOTTOM of each loop body, so entries skipped by an early `continue` never counted.
// A registry made mostly of skipped rows was then walked without a single yield. This
// counts the builder's `setImmediate` yields with and without a large block of rows that
// the custom-model loop skips (no string id), and requires the skipped rows to yield.
// The auto-candidate preparation that runs inside the same request now yields on a
// wall-clock budget, so its yield count differs between the cold baseline run and the warm
// run and would swamp this difference. The budget slice is pinned to Infinity (it never
// yields on time) so only the catalog loop's deterministic every-N yields are compared.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-9147-skip-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-9147-skip-secret";
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../src/lib/db/core.ts");
const { resetTestDb, getTestBackend } = await import("../helpers/postgres.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const cooperativeYield = await import("../../open-sse/services/autoCombo/cooperativeYield.ts");

const SKIPPED_ROWS = 2000;

async function resetStorage() {
  await resetTestDb();
  apiKeysDb.resetApiKeyState();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function seed(skippedRows: number) {
  const db = getTestBackend();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO provider_connections (id, provider, auth_type, name, priority, is_active, api_key, created_at, updated_at)
     VALUES ('skip-conn', 'openai', 'apikey', 'skip-connection', 1, true, 'sk-skip', $1, $2)`,
    [now, now]
  );
  const rows = Array.from({ length: skippedRows }, (_, i) => ({ name: `no-id-${i}` }));
  await db.execute(
    `INSERT INTO provider_model_catalog (provider, custom_models) VALUES ('openai', $1::jsonb)`,
    [JSON.stringify(rows)]
  );
}

async function countBuildYields(skippedRows: number): Promise<number> {
  await resetStorage();
  await seed(skippedRows);
  const original = globalThis.setImmediate;
  let yields = 0;
  globalThis.setImmediate = ((...args: Parameters<typeof setImmediate>) => {
    yields++;
    return original(...args);
  }) as typeof setImmediate;
  try {
    const res = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(res.status, 200);
  } finally {
    globalThis.setImmediate = original;
  }
  return yields;
}

test.after(async () => {
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#9147 — rows skipped by an early `continue` still count toward catalog yields", async () => {
  cooperativeYield.__setCooperativeYieldSliceMsForTest(Number.POSITIVE_INFINITY);
  let baseline: number;
  let withSkipped: number;
  try {
    baseline = await countBuildYields(0);
    withSkipped = await countBuildYields(SKIPPED_ROWS);
  } finally {
    cooperativeYield.__setCooperativeYieldSliceMsForTest(null);
  }
  const extra = withSkipped - baseline;
  // One yield per 5 iterations → ~400 for 2000 skipped rows; allow slack for jitter.
  assert.ok(
    extra >= SKIPPED_ROWS / 5 - 5,
    `expected ~${SKIPPED_ROWS / 5} extra yields for ${SKIPPED_ROWS} skipped rows, got ${extra} ` +
      `(baseline ${baseline}, with skipped rows ${withSkipped})`
  );
});
