import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTestBackend, resetTestDb } from "../../helpers/postgres.ts";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-used-month-"));

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { sumUsageTokensThisMonth } = await import("../../../src/lib/db/usageSummary.ts");

test.after(() => resetDbInstance());

async function insertSummary(
  provider: string,
  model: string,
  date: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  await getTestBackend().execute(
    "INSERT INTO daily_usage_summary (provider, model, date, total_input_tokens, total_output_tokens) VALUES ($1,$2,$3,$4,$5)",
    [provider, model, date, inputTokens, outputTokens]
  );
}

async function insertHistory(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  timestamp: string
): Promise<void> {
  await getTestBackend().execute(
    'INSERT INTO usage_history (provider, model, tokens_input, tokens_output, "timestamp") VALUES ($1,$2,$3,$4,$5)',
    [provider, model, inputTokens, outputTokens, timestamp]
  );
}

/** First instant (UTC) of the month containing `now`, and of the month after it. */
function monthBounds(now: Date): { start: string; next: string } {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { start: new Date(start).toISOString(), next: new Date(next).toISOString() };
}

test("sumUsageTokensThisMonth sums only the current calendar month's rolled-up tokens", async () => {
  await resetTestDb();
  const thisMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  await insertSummary("groq", "llama", `${thisMonth}-05`, 100, 200);
  await insertSummary("cerebras", "qwen", `${thisMonth}-12`, 50, 50);
  await insertSummary("groq", "llama", "2000-01-01", 9999, 9999); // long ago — excluded
  assert.equal(await sumUsageTokensThisMonth(), 400);
});

// #10381: the current month's LIVE usage lives in usage_history (per-request rows written
// by saveRequestUsage) and is never rolled into daily_usage_summary until retention cleanup
// (~365 days). sumUsageTokensThisMonth must count both legs without double-counting.
test("sumUsageTokensThisMonth includes the current month's raw usage_history rows (#10381)", async () => {
  await resetTestDb();
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7); // YYYY-MM
  const liveStamp = `${thisMonth}-15T12:00:00.000Z`;
  const pastStamp = "2000-01-15T12:00:00.000Z";

  await insertHistory("openai", "gpt-4.1", 150, 250, liveStamp); // 400 current-month live tokens
  await insertHistory("openai", "gpt-4.1", 9999, 9999, pastStamp); // very old — excluded

  // A rolled-up current-month row coexisting (no double-count — the source usage_history row
  // was already deleted by the retention rollup, so both legs are additive and disjoint).
  await insertSummary("groq", "llama", `${thisMonth}-20`, 25, 25); // +50 rolled-up

  assert.equal(await sumUsageTokensThisMonth(), 400 + 50);
});

// #10509 sweep: the `substr(timestamp, 1, 7) = strftime('%Y-%m', 'now')` predicate was
// fragile/non-indexable (SQLite cannot use a range index on a substr() expression, and a
// non-ISO-shaped timestamp string silently mismatches). Replaced with an indexable UTC
// month-range comparison (`timestamp >= <month start> AND timestamp < <next month start>`).
// This test pins the exact boundary: the first instant of the current month is INCLUDED,
// the last instant of the PREVIOUS month is EXCLUDED, and a NEXT-month row is EXCLUDED too
// (guards the upper-bound half of the range, which substr() could never express directly).
test("sumUsageTokensThisMonth uses an inclusive-start/exclusive-end UTC month range (#10509)", async () => {
  await resetTestDb();
  const { start, next } = monthBounds(new Date());
  const lastInstantOfPrevMonth = new Date(new Date(start).getTime() - 1).toISOString();

  await insertHistory("openai", "gpt-4.1", 10, 0, start); // first instant of THIS month — included
  await insertHistory("openai", "gpt-4.1", 9999, 0, lastInstantOfPrevMonth); // last ms of PREV month — excluded
  await insertHistory("openai", "gpt-4.1", 9999, 0, next); // first instant of NEXT month — excluded

  assert.equal(await sumUsageTokensThisMonth(), 10);
});
