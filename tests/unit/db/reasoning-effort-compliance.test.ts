/**
 * Bounded call_logs reader for reasoning_effort=none compliance.
 *
 * One test per gate case. Rows are inserted directly (the production writer
 * only persists effort columns on the encrypted path) and removed between
 * tests, so every input reaches the code through the journal it reads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-none-honored-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const mod = await import("../../../src/lib/db/reasoningEffortCompliance.ts");
import type { DbExecutor } from "../../../src/lib/db/backends/types.ts";

const FIXED_NOW = new Date("2026-03-28T12:00:00.000Z").getTime();
const isoHoursAgo = (hours: number) => new Date(FIXED_NOW - hours * 3_600_000).toISOString();

let idSeq = 0;
async function insertRow(row: Record<string, unknown>) {
  const full = {
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: null,
    requested_model: null,
    provider: "openai",
    duration: 100,
    tokens_in: 10,
    tokens_out: 20,
    cache_source: "upstream",
    detail_state: "none",
    has_request_body: false,
    has_response_body: false,
    has_pipeline_details: false,
    tokens_reasoning: null,
    reasoning_chars: null,
    reasoning_encrypted: null,
    reasoning_effort_requested: null,
    ...row,
    id: (row.id as string) ?? `none-honored-${++idSeq}`,
    timestamp: (row.timestamp as string) ?? isoHoursAgo(1),
  };
  await getTestBackend().execute(
    `INSERT INTO call_logs (
      id, "timestamp", method, path, status, model, requested_model, provider,
      duration, tokens_in, tokens_out, cache_source, detail_state,
      has_request_body, has_response_body, has_pipeline_details,
      tokens_reasoning, reasoning_chars, reasoning_encrypted, reasoning_effort_requested
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13,
      $14, $15, $16,
      $17, $18, $19, $20
    )`,
    [
      full.id,
      full.timestamp,
      full.method,
      full.path,
      full.status,
      full.model,
      full.requested_model,
      full.provider,
      full.duration,
      full.tokens_in,
      full.tokens_out,
      full.cache_source,
      full.detail_state,
      full.has_request_body,
      full.has_response_body,
      full.has_pipeline_details,
      full.tokens_reasoning,
      full.reasoning_chars,
      full.reasoning_encrypted === null ? null : Boolean(full.reasoning_encrypted),
      full.reasoning_effort_requested,
    ]
  );
}

async function clearCallLogs() {
  await getTestBackend().execute("DELETE FROM call_logs");
}

function clearEnv() {
  delete process.env.NONE_HONORED_WINDOW_HOURS;
  delete process.env.NONE_HONORED_CACHE_TTL_MS;
  delete process.env.NONE_HONORED_MIN_SAMPLE;
}

test.before(async () => {
  await resetTestDb();
});

test.beforeEach(async () => {
  clearEnv();
  mod.clearNoneHonoredCache();
  await clearCallLogs();
});

test.after(async () => {
  clearEnv();
  mod.clearNoneHonoredCache();
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("none requested with no reasoning applied reads honored with window and sample size", async () => {
  try {
    for (let i = 0; i < 3; i++) {
      await insertRow({ requested_model: "model-a", reasoning_effort_requested: "none" });
    }
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(typeof snapshot.observedAt, "string");
    assert.equal(snapshot.window.hours, 24);
    assert.equal(typeof snapshot.window.sinceIso, "string");
    const entry = snapshot.entries.get("model-a");
    assert.ok(entry, "expected a snapshot entry for model-a");
    assert.equal(entry.honored, true);
    assert.equal(entry.sampleSize, 3);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("none requested with reasoning applied reads not honored", async () => {
  try {
    await insertRow({ requested_model: "model-b", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-b", reasoning_effort_requested: "none" });
    await insertRow({
      requested_model: "model-b",
      reasoning_effort_requested: "none",
      tokens_reasoning: 384,
    });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.get("model-b")?.honored, false);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("model without a none request in the window reads unknown", async () => {
  try {
    await insertRow({ requested_model: "other-model", reasoning_effort_requested: "low" });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.has("model-c"), false);
    assert.equal(mod.readNoneHonored(snapshot, "model-c").honored, null);
    assert.equal(mod.readNoneHonored(snapshot, "model-c").sampleSize, 0);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("two close reads issue a single journal query", async () => {
  const backend = getTestBackend();
  let journalReads = 0;
  const counting: DbExecutor = {
    query: (sql, params) => {
      if (sql.includes("call_logs")) journalReads += 1;
      return backend.query(sql, params);
    },
    queryOne: (sql, params) => backend.queryOne(sql, params),
    execute: (sql, params) => backend.execute(sql, params),
  };
  try {
    await insertRow({ requested_model: "model-cache", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-cache", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-cache", reasoning_effort_requested: "none" });
    mod.clearNoneHonoredCache();
    journalReads = 0;
    const first = await mod.getNoneHonoredSnapshot(counting, FIXED_NOW);
    const second = await mod.getNoneHonoredSnapshot(counting, FIXED_NOW);
    assert.equal(journalReads, 1);
    assert.equal(second, first);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("request outside the window is not counted", async () => {
  try {
    await insertRow({
      requested_model: "model-d",
      reasoning_effort_requested: "none",
      tokens_reasoning: 1016,
      timestamp: isoHoursAgo(25),
    });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.has("model-d"), false);
    assert.equal(mod.readNoneHonored(snapshot, "model-d").honored, null);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("small sample reads unknown instead of not honored", async () => {
  try {
    await insertRow({ requested_model: "model-e", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-e", reasoning_effort_requested: "none" });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.get("model-e")?.honored, null);
    assert.equal(snapshot.entries.get("model-e")?.sampleSize, 2);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("row without any model key is ignored", async () => {
  try {
    await insertRow({
      model: null,
      requested_model: null,
      reasoning_effort_requested: "none",
      tokens_reasoning: 5,
    });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.size, 0);
    for (const key of snapshot.entries.keys()) {
      assert.ok(typeof key === "string" && key.length > 0);
    }
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("effort matching ignores case and padding", async () => {
  try {
    await insertRow({ requested_model: "model-f", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-f", reasoning_effort_requested: " None " });
    await insertRow({ requested_model: "model-f", reasoning_effort_requested: "NONE" });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.get("model-f")?.honored, true);
    assert.equal(snapshot.entries.get("model-f")?.sampleSize, 3);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("missing requested model falls back to the served model", async () => {
  try {
    await insertRow({ model: "model-g", requested_model: null, reasoning_effort_requested: "none" });
    await insertRow({ model: "model-g", requested_model: null, reasoning_effort_requested: "none" });
    await insertRow({ model: "model-g", requested_model: "", reasoning_effort_requested: "none" });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.get("model-g")?.honored, true);
    assert.equal(snapshot.entries.get("model-g")?.sampleSize, 3);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("encrypted reasoning marker counts as reasoning applied", async () => {
  try {
    await insertRow({ requested_model: "model-h", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-h", reasoning_effort_requested: "none" });
    await insertRow({
      requested_model: "model-h",
      reasoning_effort_requested: "none",
      reasoning_encrypted: 1,
    });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.get("model-h")?.honored, false);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("reasoning character count counts as reasoning applied", async () => {
  try {
    await insertRow({ requested_model: "model-i", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-i", reasoning_effort_requested: "none" });
    await insertRow({
      requested_model: "model-i",
      reasoning_effort_requested: "none",
      reasoning_chars: 50,
    });
    const snapshot = await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(snapshot.entries.get("model-i")?.honored, false);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});

test("repeated reads keep a single cache entry", async () => {
  try {
    await insertRow({ requested_model: "model-j", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-j", reasoning_effort_requested: "none" });
    await insertRow({ requested_model: "model-j", reasoning_effort_requested: "none" });
    mod.clearNoneHonoredCache();
    assert.equal(mod.noneHonoredCacheSizeForTest(), 0);
    await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    await mod.getNoneHonoredSnapshot(undefined, FIXED_NOW);
    assert.equal(mod.noneHonoredCacheSizeForTest(), 1);
    mod.clearNoneHonoredCache();
    assert.equal(mod.noneHonoredCacheSizeForTest(), 0);
  } finally {
    await clearCallLogs();
    mod.clearNoneHonoredCache();
  }
});
