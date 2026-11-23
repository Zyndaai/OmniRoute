import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The per-request API key quota check reads request_cost_ledger through a covering index
// (api_key_id, timestamp) INCLUDE (success, service_tier, amount_usd), migration 0004.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ledger-cover-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const { resetTestDb } = await import("../../helpers/postgres.ts");
const { db } = await import("../../../src/lib/db/pg.ts");

test.before(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("the ledger has one covering index and the old prefix index is gone", async () => {
  const rows = await db().query<{ indexname: string; indexdef: string }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'request_cost_ledger'"
  );
  const names = rows.map((row) => row.indexname);
  assert.ok(!names.includes("request_cost_ledger_api_key_ts_idx"));
  const cover = rows.find((row) => row.indexname === "request_cost_ledger_api_key_cover_idx");
  assert.ok(cover, "covering index exists");
  assert.match(cover.indexdef, /\(api_key_id, "timestamp"\) INCLUDE \(success, service_tier, amount_usd\)/);
});

test("a spend lookup by key and time range can use the index only", async () => {
  await db().execute(
    `INSERT INTO request_cost_ledger (api_key_id, "timestamp", provider, model, amount_usd)
       SELECT 'k1', now() - (g || ' minutes')::interval, 'p', 'm', 0.01 FROM generate_series(1, 2000) g`
  );
  await db().execute("VACUUM (ANALYZE) request_cost_ledger");
  const plan = await db().query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT success, service_tier, amount_usd FROM request_cost_ledger
       WHERE api_key_id = 'k1' AND "timestamp" >= now() - interval '10 minutes'`
  );
  const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
  assert.match(text, /request_cost_ledger_api_key_cover_idx/);
});
