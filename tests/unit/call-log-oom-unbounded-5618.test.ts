import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

// #5618 — `cleanupExpiredLogs` → `rotateCallLogs` ran at daemon startup and used
// unbounded `SELECT … FROM call_logs …` calls that materialize the whole result set, so on a
// large table the JS heap blew up and the process crashed before binding. The two startup
// queries must page with LIMIT instead of loading the whole table at once.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-calllogs-oom-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const bounded = await import("../../src/lib/usage/callLogsBoundedQueries.ts");

async function insertCallLog(id: string, timestamp: string, artifact: string | null = null) {
  await getTestBackend().execute(
    `INSERT INTO call_logs (id, "timestamp", method, path, status, model, provider, detail_state, artifact_relpath)
     VALUES ($1, $2, 'POST', '/v1/chat/completions', 200, 'openai/gpt-4.1', 'openai', 'none', $3)`,
    [id, timestamp, artifact]
  );
}

async function seed(total: number, withArtifact: boolean) {
  await getTestBackend().execute(
    `INSERT INTO call_logs (id, "timestamp", method, path, status, model, provider, detail_state, artifact_relpath)
     SELECT 'r-' || lpad(i::text, 6, '0'),
            timestamptz '2026-01-01T00:00:00Z' + i * interval '1 second',
            'POST', '/v1/chat/completions', 200, 'openai/gpt-4.1', 'openai', 'none',
            CASE WHEN $1::boolean THEN '2026-01/' || i || '.json' END
       FROM generate_series(0, $2::int - 1) AS i`,
    [withArtifact, total]
  );
}

async function captureSql(run: () => Promise<void>): Promise<string[]> {
  const db = getTestBackend();
  const originalQuery = db.query;
  const originalQueryOne = db.queryOne;
  const sqls: string[] = [];
  db.query = ((sql: string, ...rest: unknown[]) => {
    sqls.push(sql);
    return (originalQuery as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.query;
  db.queryOne = ((sql: string, ...rest: unknown[]) => {
    sqls.push(sql);
    return (originalQueryOne as (...args: unknown[]) => unknown).call(db, sql, ...rest);
  }) as typeof db.queryOne;
  try {
    await run();
  } finally {
    db.query = originalQuery;
    db.queryOne = originalQueryOne;
  }
  return sqls;
}

const unboundedSelectsOnCallLogs = (sqls: string[]) =>
  sqls.filter((s) => /SELECT/i.test(s) && /\bFROM\s+call_logs\b/i.test(s) && !/LIMIT/i.test(s));

test.beforeEach(async () => {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#5618 collectReferencedArtifacts pages with LIMIT and collects across pages — no unbounded SELECT", async () => {
  const total = 6000; // > one 5000-row page → exercises the pagination loop
  await seed(total, true);

  let referenced: Set<string> | undefined;
  const sqls = await captureSql(async () => {
    referenced = await bounded.collectReferencedArtifacts();
  });

  assert.equal(referenced!.size, total, "every artifact path is collected across all pages");
  assert.deepEqual(
    unboundedSelectsOnCallLogs(sqls),
    [],
    `unbounded SELECT on call_logs (OOM risk): ${unboundedSelectsOnCallLogs(sqls).join("; ")}`
  );
});

test("bounded reference lookup keeps every candidate despite duplicate rows", async () => {
  for (let i = 0; i < 150; i++) {
    await insertCallLog(
      `duplicate-${i}`,
      `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      "2026-01/duplicate.json"
    );
  }
  await insertCallLog("second-path", "2026-01-01T00:01:00.000Z", "2026-01/second.json");

  assert.deepEqual(
    await bounded.findReferencedArtifacts(["2026-01/duplicate.json", "2026-01/second.json"]),
    new Set(["2026-01/duplicate.json", "2026-01/second.json"])
  );
});

test("#5618 deleteCallLogsBefore selects ids with LIMIT (bounded) instead of all at once", async () => {
  const total = 1200;
  await seed(total, false);

  let result: { deletedRows: number } | undefined;
  const sqls = await captureSql(async () => {
    result = await callLogs.deleteCallLogsBefore("2030-01-01T00:00:00.000Z");
  });

  assert.equal(result!.deletedRows, total, "all rows before the cutoff are deleted (across pages)");
  const unboundedIdSelects = sqls.filter(
    (s) => /SELECT\s+id\b/i.test(s) && /\bFROM\s+call_logs\b/i.test(s) && !/LIMIT/i.test(s)
  );
  assert.deepEqual(
    unboundedIdSelects,
    [],
    `unbounded id SELECT on call_logs (OOM risk): ${unboundedIdSelects.join("; ")}`
  );
});
