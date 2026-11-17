import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #16814 — a single auto/* request burned ~11 CPU-s and stalled the event loop 1-4 s.
// The per-candidate scoring/limit helpers redo registry scans and DB lookups on every call.
// These assertions count the repeated work instead of timing it, so they are load-independent.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auto-cpu-16814-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");
const { PROVIDER_MODELS, getProviderModel } =
  await import("../../open-sse/config/providerModels.ts");
const { getTaskFitness, invalidateFitnessCache } =
  await import("../../open-sse/services/autoCombo/taskFitness.ts");
const { resolveScoresAs } = await import("../../open-sse/services/autoCombo/scoresAs.ts");
const { computeAdvertisedLimits } =
  await import("../../open-sse/services/autoCombo/advertisedLimits.ts");

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function sampleModelIds(count: number): Array<{ provider: string; id: string }> {
  const out: Array<{ provider: string; id: string }> = [];
  for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
    for (const m of models) {
      out.push({ provider, id: m.id });
      if (out.length === count) return out;
    }
  }
  return out;
}

/** Counts the statements (and transactions) the process backend receives while `fnUnderTest` runs. */
async function countDbStatements<T>(
  fnUnderTest: () => Promise<T>
): Promise<{ result: T; prepares: number }> {
  const backend = getTestBackend() as unknown as Record<string, (...args: unknown[]) => unknown>;
  const names = ["query", "queryOne", "execute", "transaction"];
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  let prepares = 0;
  for (const name of names) {
    const original = backend[name];
    originals.set(name, original);
    backend[name] = (...args: unknown[]) => {
      prepares++;
      return original.apply(backend, args);
    };
  }
  try {
    return { result: await fnUnderTest(), prepares };
  } finally {
    for (const [name, original] of originals) backend[name] = original;
  }
}

test("#16814: getTaskFitness answers a repeated lookup from memory (no DB round-trip per call)", async () => {
  invalidateFitnessCache();
  const [{ id }] = sampleModelIds(1);
  await getTaskFitness(id, "default"); // first call may hit the DB and warm one-off state
  const { prepares } = await countDbStatements(async () => {
    for (let i = 0; i < 50; i++) await getTaskFitness(id, "default");
  });
  assert.equal(prepares, 0, `50 repeat getTaskFitness(${id}) issued ${prepares} DB statements`);
});

test("#16814: resolveScoresAs does not rescan the whole provider registry for an id it already resolved", () => {
  const [{ id }] = sampleModelIds(1);
  resolveScoresAs(id);
  let scans = 0;
  const realValues = Object.values;
  (Object as { values: unknown }).values = (o: unknown) => {
    if (o === PROVIDER_MODELS) scans++;
    return realValues(o as object);
  };
  try {
    for (let i = 0; i < 50; i++) resolveScoresAs(id);
  } finally {
    (Object as { values: unknown }).values = realValues;
  }
  assert.equal(scans, 0, `50 repeat resolveScoresAs(${id}) scanned PROVIDER_MODELS ${scans} times`);
});

function countRegistryScans(fnUnderTest: () => void): number {
  let scans = 0;
  const realValues = Object.values;
  (Object as { values: unknown }).values = (o: unknown) => {
    if (o === PROVIDER_MODELS) scans++;
    return realValues(o as object);
  };
  try {
    fnUnderTest();
  } finally {
    (Object as { values: unknown }).values = realValues;
  }
  return scans;
}

test("getProviderModel's cross-provider fallback does not rescan the registry for a repeated id", () => {
  // An unknown provider forces the global lookup.
  const [{ id }] = sampleModelIds(1);
  assert.equal(getProviderModel("no-such-provider", id)?.id, id);
  const scans = countRegistryScans(() => {
    for (let i = 0; i < 50; i++) getProviderModel("no-such-provider", id);
  });
  assert.equal(scans, 0, `50 repeat lookups of ${id} scanned PROVIDER_MODELS ${scans} times`);
});

test("getProviderModel sees a provider added after the id was looked up", () => {
  const provider = "memo-invalidation-test";
  const modelId = "memo-invalidation-only-model";
  assert.equal(getProviderModel("no-such-provider", modelId), undefined);
  PROVIDER_MODELS[provider] = [{ id: modelId, name: "Memo Invalidation" }];
  try {
    assert.equal(getProviderModel("no-such-provider", modelId)?.name, "Memo Invalidation");
  } finally {
    delete PROVIDER_MODELS[provider];
  }
  assert.equal(getProviderModel("no-such-provider", modelId), undefined);
});

test("#16814: computeAdvertisedLimits does not issue per-candidate DB statements on the request path", async () => {
  const pool = sampleModelIds(120).map(({ provider, id }) => ({ provider, model: id }));
  await computeAdvertisedLimits(pool.slice(0, 1)); // warm one-off init
  const { prepares } = await countDbStatements(() => computeAdvertisedLimits(pool));
  assert.ok(
    prepares < 10,
    `computeAdvertisedLimits over ${pool.length} candidates issued ${prepares} DB statements`
  );
});
