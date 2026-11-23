// Live proactive-compression threshold knob (PR: make the 0.7 ratio a setting).
//
// `getProactiveCompressionRatio()` (src/lib/db/compression.ts) replaces the
// hardcoded `COMPRESSION_THRESHOLD = 0.7` in open-sse/handlers/chatCore.ts with
// a config_entries-backed read: namespace "compression", key "proactiveConfig",
// JSON `{"thresholdRatio": <number>}`, guarded by a 30s TTL cache so the
// per-request path never pays a database read inside the TTL.
//
// Covered here:
//   1. no row            → shipped default 0.7
//   2. TTL cache         → a fresh DB write is invisible until the 30s TTL
//                          lapses (and visible right after)
//   3. valid override    → the stored ratio is returned
//   4. boundary values   → 0.1 and 0.99 are inside the validity window
//   5. out-of-range      → falls back to the DEFAULT (0.7) — the guard is a
//                          validity window, not clamping to the nearest bound
//   6. broken payload    → 0.7, without throwing
//   7. non-numeric value → 0.7
//
// The module keeps its TTL cache in a private module-level variable with no
// reset hook, so the clock itself is mocked (node:test mock timers, Date API)
// and each scenario advances past the TTL to force a fresh DB read. The DB is
// primed (migrations run) BEFORE the clock is mocked so migration timestamps
// stay real.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proactive-ratio-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const compression = await import("../../../src/lib/db/compression.ts");
const { setConfigValue } = await import("../../../src/lib/db/configEntries.ts");

const DEFAULT_RATIO = 0.7;
const TTL_MS = 30_000;

// Prime the DB (runs migrations, creates config_entries) in real time, then freeze
// the clock. Every getProactiveCompressionRatio() cache stamp after this point
// lives in mocked time, so tick() deterministically controls TTL expiry.
await core.ensureDbInitialized();
mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

async function writeRatioRow(value: unknown): Promise<void> {
  await setConfigValue("compression", "proactiveConfig", value);
}

/** Advance mocked time past the 30s TTL so the next read hits the DB. */
function expireTtl(): void {
  mock.timers.tick(TTL_MS + 1);
}

test.after(async () => {
  mock.timers.reset();
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("returns the shipped 0.7 default when no override row exists", async () => {
  assert.equal(await compression.getProactiveCompressionRatio(), DEFAULT_RATIO);
});

test("serves the cached value inside the 30s TTL — a fresh DB write is not visible yet", async () => {
  await writeRatioRow({ thresholdRatio: 0.85 });
  mock.timers.tick(5_000); // still inside the TTL primed by the previous read
  assert.equal(
    await compression.getProactiveCompressionRatio(),
    DEFAULT_RATIO,
    "a write inside the TTL window must not bypass the cache"
  );
});

test("reads a valid override from config_entries once the TTL lapses", async () => {
  // Row 0.85 was written in the previous test; only the clock moves here.
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), 0.85);
});

test("accepts both boundary values of the validity window (0.1 and 0.99)", async () => {
  await writeRatioRow({ thresholdRatio: 0.1 });
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), 0.1);

  await writeRatioRow({ thresholdRatio: 0.99 });
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), 0.99);
});

test("falls back to the default for out-of-range ratios (validity window, not clamping)", async () => {
  await writeRatioRow({ thresholdRatio: 0.05 }); // below 0.1
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), DEFAULT_RATIO);

  await writeRatioRow({ thresholdRatio: 1.2 }); // above 0.99
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), DEFAULT_RATIO);
});

test("falls back to the default without throwing on a broken payload", async () => {
  // config_entries.value is jsonb, so malformed JSON text is stored as a JSON string whose
  // content is not an object with a thresholdRatio.
  await writeRatioRow("{not json");
  expireTtl();
  let ratio = Number.NaN;
  await assert.doesNotReject(async () => {
    ratio = await compression.getProactiveCompressionRatio();
  });
  assert.equal(ratio, DEFAULT_RATIO);
});

test("falls back to the default on a non-numeric or absent thresholdRatio", async () => {
  await writeRatioRow({ thresholdRatio: "fast" });
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), DEFAULT_RATIO);

  await writeRatioRow({ somethingElse: 0.9 });
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), DEFAULT_RATIO);
});

test("a valid override recovers after a broken one, on the next TTL expiry", async () => {
  await writeRatioRow({ thresholdRatio: 0.5 });
  expireTtl();
  assert.equal(await compression.getProactiveCompressionRatio(), 0.5);
});
