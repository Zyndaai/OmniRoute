/**
 * Persistent local Radar overrides and tombstones.
 *
 * These tests exercise the real migration-backed DB module and the production
 * getRadarCatalog() wiring. They deliberately do not inject local merge state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestBackend, resetTestDb } from "../helpers/postgres.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-radar-local-state-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.RADAR_ENABLED = "true";

const {
  clearRadarLocalModelOverride,
  getRadarLocalMergeState,
  listRadarLocalModelState,
  setRadarLocalModelOverride,
  setRadarModelTombstone,
  setRadarCache,
} = await import("../../src/lib/db/radar.ts");
const { getRadarCatalog } = await import("../../src/lib/radar/index.ts");

async function resetStorage(): Promise<void> {
  await resetTestDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(resetStorage);

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.DATA_DIR;
  delete process.env.RADAR_ENABLED;
});

test("radar_local_model_state has the closed local model state schema", async () => {
  const backend = getTestBackend();
  const columns = await backend.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'radar_local_model_state'
      ORDER BY ordinal_position`
  );

  assert.deepEqual(
    columns.map((column) => column.column_name),
    ["provider", "model_id", "display_name", "enabled", "tombstoned", "updated_at"]
  );
});

test("local overrides round-trip, merge partial updates, and clear without stale fields", async () => {
  assert.equal(
    await setRadarLocalModelOverride(" groq ", " llama-3.3-70b-versatile ", {
      displayName: " My Groq model ",
      enabled: false,
    }),
    true
  );

  const initial = await listRadarLocalModelState();
  assert.equal(initial.length, 1);
  assert.deepEqual(
    { ...initial[0], updatedAt: undefined },
    {
      provider: "groq",
      modelId: "llama-3.3-70b-versatile",
      displayName: "My Groq model",
      enabled: false,
      tombstoned: false,
      updatedAt: undefined,
    }
  );
  assert.match(initial[0].updatedAt, /^\d{4}-\d{2}-\d{2}/);

  assert.equal(
    await setRadarLocalModelOverride("groq", "llama-3.3-70b-versatile", { enabled: true }),
    true
  );
  const updated = (await listRadarLocalModelState())[0];
  assert.equal(updated.displayName, "My Groq model", "partial updates preserve the other field");
  assert.equal(updated.enabled, true);

  assert.equal(
    await setRadarLocalModelOverride("groq", "llama-3.3-70b-versatile", { displayName: null }),
    true
  );
  assert.equal(
    (await listRadarLocalModelState())[0].displayName,
    null,
    "null explicitly clears a field"
  );

  assert.equal(await clearRadarLocalModelOverride("groq", "llama-3.3-70b-versatile"), true);
  assert.deepEqual(await listRadarLocalModelState(), [], "an empty non-tombstoned row is deleted");
});

test("tombstones survive override resets and restoring the last field removes the row", async () => {
  assert.equal(
    await setRadarLocalModelOverride("groq", "llama-3.3-70b-versatile", {
      displayName: "Local name",
    }),
    true
  );
  assert.equal(await setRadarModelTombstone("groq", "llama-3.3-70b-versatile", true), true);
  assert.equal(await clearRadarLocalModelOverride("groq", "llama-3.3-70b-versatile"), true);

  const hidden = (await listRadarLocalModelState())[0];
  assert.equal(hidden.tombstoned, true);
  assert.equal(hidden.displayName, null);
  assert.equal(hidden.enabled, null);

  const mergeState = await getRadarLocalMergeState();
  assert.deepEqual([...mergeState.localOverrides], []);
  assert.deepEqual([...mergeState.tombstones], ["groq:llama-3.3-70b-versatile"]);

  assert.equal(await setRadarModelTombstone("groq", "llama-3.3-70b-versatile", false), true);
  assert.deepEqual(await listRadarLocalModelState(), []);
});

test("invalid identities and empty override patches fail closed", async () => {
  assert.equal(await setRadarLocalModelOverride("", "model", { displayName: "name" }), false);
  assert.equal(await setRadarLocalModelOverride("groq", "", { displayName: "name" }), false);
  assert.equal(await setRadarLocalModelOverride("groq", "model", {}), false);
  assert.equal(await setRadarLocalModelOverride("groq", "model", { displayName: "   " }), false);
  assert.equal(await setRadarModelTombstone("bad provider", "model", true), false);
  assert.deepEqual(await listRadarLocalModelState(), []);
});

test("production getRadarCatalog loads persisted overrides and tombstones", async () => {
  const fixturePath = path.join(process.cwd(), "tests/fixtures/radar-feed-canonical.json");
  const payload = fs.readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(payload) as {
    version: string;
    tier: string;
    models: Array<{ provider: string; modelId: string; enabled: boolean }>;
  };
  const visible = fixture.models.find((model) => model.enabled);
  const hidden = fixture.models.find(
    (model) =>
      model.enabled &&
      `${model.provider}:${model.modelId}` !== `${visible?.provider}:${visible?.modelId}`
  );
  assert.ok(visible && hidden, "fixture must contain two enabled models");

  await setRadarCache({
    version: fixture.version,
    tier: fixture.tier,
    payload,
    signature: "test-signature",
  });
  assert.equal(
    await setRadarLocalModelOverride(visible.provider, visible.modelId, {
      displayName: "Persisted local name",
      enabled: false,
    }),
    true
  );
  assert.equal(await setRadarModelTombstone(hidden.provider, hidden.modelId, true), true);

  const catalog = await getRadarCatalog();
  const overridden = catalog.entries.find(
    (entry) => entry.provider === visible.provider && entry.modelId === visible.modelId
  );
  assert.ok(overridden);
  assert.equal(overridden.displayName, "Persisted local name");
  assert.equal(overridden.enabled, false);
  assert.equal(overridden.origin, "local");
  assert.equal(
    catalog.entries.some(
      (entry) => entry.provider === hidden.provider && entry.modelId === hidden.modelId
    ),
    false,
    "a persisted tombstone must remove the model from the production catalog"
  );
});
