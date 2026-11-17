import test from "node:test";
import assert from "node:assert/strict";

import { jsonb, toMs, ts } from "../../../../src/lib/db/pg.ts";
import { withPglite } from "../../../helpers/postgres.ts";

test("ts normalises every timestamp shape the code passes today", () => {
  const iso = "2026-11-16T10:20:30.000Z";
  assert.equal(ts(new Date(iso)), iso);
  assert.equal(ts(iso), iso);
  assert.equal(ts("2026-11-16 10:20:30"), iso);
  assert.equal(ts(Date.parse(iso)), iso);
  assert.equal(ts(Date.parse(iso) / 1000), iso);
  assert.equal(ts(String(Date.parse(iso))), iso);
  assert.equal(ts(null), null);
  assert.equal(ts(""), null);
  assert.equal(ts("not a date"), null);
  assert.equal(toMs(iso), Date.parse(iso));
  assert.equal(toMs(null), null);
});

test("jsonb keeps arrays as JSON arrays and maps undefined to NULL", () => {
  assert.equal(jsonb([1, "a"]), '[1,"a"]');
  assert.equal(jsonb({ a: 1 }), '{"a":1}');
  assert.equal(jsonb(undefined), null);
  assert.equal(jsonb(null), null);
});

test("rows come back with the shared shapes on PGlite", async () => {
  await withPglite(async (backend) => {
    const row = await backend.queryOne<Record<string, unknown>>(
      `SELECT 42::bigint AS n, 1.5::numeric AS money, true AS flag,
              '2026-11-16'::date AS day,
              '2026-11-16 10:20:30+00'::timestamptz AS at,
              $1::jsonb AS doc`,
      [jsonb([1, { a: 2 }])]
    );
    assert.deepEqual(row, {
      n: 42,
      money: 1.5,
      flag: true,
      day: "2026-11-16",
      at: "2026-11-16T10:20:30.000Z",
      doc: [1, { a: 2 }],
    });
  });
});
