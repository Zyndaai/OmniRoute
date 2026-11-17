import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cost-responsive-"));
process.env.DATA_DIR = dataDir;
const { getTestBackend, resetTestDb } = await import("../helpers/postgres.ts");
const core = await import("../../src/lib/db/core.ts");
const { getProviderWindowCostBreakdown } =
  await import("../../src/lib/usage/providerWindowCosts.ts");
const { updatePricing } = await import("../../src/lib/db/settings.ts");
const { RecordedCostMatcher } = await import("../../src/lib/usage/recordedCostMatcher.ts");
const now = Date.parse("2026-06-28T12:00:00Z");

async function seed(count: number, extraCost: boolean) {
  const b = getTestBackend();
  await b.execute("DELETE FROM usage_history");
  await b.execute("DELETE FROM domain_cost_history");
  await updatePricing({ codex: { "test-model": { input: 1, output: 1 } } });
  // One usage row and one recorded cost per request, one second apart. Generated in SQL
  // so a few thousand rows seed in one round trip each.
  const first = now - 86400000;
  await b.execute(
    `INSERT INTO usage_history
       (provider, model, connection_id, api_key_id, api_key_name, tokens_input, timestamp)
     SELECT 'codex', 'test-model', 'synthetic-connection', 'synthetic-key', 'Synthetic', 1000000,
            to_timestamp(($1::bigint + g.i * 1000) / 1000.0)
     FROM generate_series(0, $2::int - 1) AS g(i)`,
    [first, count]
  );
  await b.execute(
    `INSERT INTO domain_cost_history (api_key_id, cost, timestamp)
     SELECT 'synthetic-key', 2, to_timestamp(($1::bigint + g.i * 1000) / 1000.0)
     FROM generate_series(0, $2::int - 1) AS g(i)`,
    [first, count]
  );
  // The same key can have costs from another provider/connection. Force the
  // detailed branch without creating an extra usage row in this selection.
  if (extraCost) {
    await b.execute(
      "INSERT INTO domain_cost_history (api_key_id, cost, timestamp) VALUES ('synthetic-key', 2, $1)",
      [new Date(now - 1000).toISOString()]
    );
  }
}

const breakdown = () =>
  getProviderWindowCostBreakdown({
    provider: "codex",
    connectionId: "synthetic-connection",
    now,
  });

test.before(async () => {
  await resetTestDb();
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("mismatched cost counts yield to an HTTP heartbeat before analytics completes", async () => {
  await seed(4096, true);
  let completed = false;
  let servedBeforeCompletion = false;
  let matches = 0;
  let matchesAtHeartbeat = 0;
  const server = http.createServer((_request, response) => {
    servedBeforeCompletion = !completed;
    matchesAtHeartbeat = matches;
    response.end("healthy");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let sendHeartbeat: () => void;
  const heartbeat = new Promise<void>((resolve, reject) => {
    sendHeartbeat = () => {
      const request = http.get(`http://127.0.0.1:${address.port}/health`, (response) => {
        response.resume();
        response.on("end", resolve);
      });
      request.on("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("heartbeat timed out")));
    };
  });
  const originalTake = RecordedCostMatcher.prototype.takeClosest;
  RecordedCostMatcher.prototype.takeClosest = function (timestamp, tolerance) {
    if (++matches === 1) sendHeartbeat();
    return originalTake.call(this, timestamp, tolerance);
  };
  try {
    const result = await breakdown();
    completed = true;
    assert.ok(matches > 0, "fixture must exercise the detailed matching path");
    await heartbeat;
    assert.equal(result.totalCostUsd, 8192);
    assert.equal(result.rows[0].requests, 4096);
    assert.ok(
      servedBeforeCompletion,
      "HTTP must make progress while cost matching is still running"
    );
    assert.ok(
      matchesAtHeartbeat > 0 && matchesAtHeartbeat < 4096,
      "yield during matching, not just before it"
    );
  } finally {
    RecordedCostMatcher.prototype.takeClosest = originalTake;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("aggregate-only calculation never loads detailed cost records", async () => {
  await seed(16, false);
  const b = getTestBackend() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const methods = ["query", "queryOne", "execute"] as const;
  const originals = Object.fromEntries(methods.map((m) => [m, b[m]])) as Record<
    (typeof methods)[number],
    (...args: unknown[]) => Promise<unknown>
  >;
  const detailedQueries: string[] = [];
  for (const m of methods) {
    const real = originals[m].bind(b);
    b[m] = (sql: unknown, ...rest: unknown[]) => {
      const text = String(sql);
      if (/id as "?rowId"?/i.test(text) && /FROM domain_cost_history/i.test(text))
        detailedQueries.push(text);
      return real(sql, ...rest);
    };
  }
  try {
    const result = await breakdown();
    assert.equal(result.totalCostUsd, 32);
    assert.equal(detailedQueries.length, 0);
  } finally {
    for (const m of methods) b[m] = originals[m];
  }
});

test("partial recorded history falls back to pricing only for the unmatched usage row", async () => {
  await seed(2, false);
  await getTestBackend().execute("DELETE FROM domain_cost_history WHERE timestamp = $1", [
    new Date(now - 86400000 + 1000).toISOString(),
  ]);
  const result = await breakdown();
  assert.equal(result.rows[0].requests, 2);
  assert.equal(result.totalCostUsd, 3); // recorded $2 once, then calculated $1
});

test("matching is request-local and respects the selected provider connection", async () => {
  await seed(4, true);
  await getTestBackend().execute(
    `INSERT INTO usage_history
       (provider, model, connection_id, api_key_id, api_key_name, tokens_input, timestamp)
     VALUES ('codex', 'test-model', 'other-connection', 'synthetic-key', 'Synthetic', 1000000, $1)`,
    [new Date(now - 1000).toISOString()]
  );
  const [first, second] = await Promise.all([breakdown(), breakdown()]);
  for (const result of [first, second]) {
    assert.equal(result.rows[0].requests, 4);
    assert.equal(result.totalCostUsd, 8);
  }
  const other = await getProviderWindowCostBreakdown({
    provider: "codex",
    connectionId: "other-connection",
    now,
  });
  assert.equal(other.rows[0].requests, 1);
  assert.equal(other.totalCostUsd, 2);
});
