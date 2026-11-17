/**
 * Performance regression tests for OmniRoute
 *
 * Tests bulk data operations against acceptable time thresholds.
 * Thresholds are 2x the expected target to account for slow CI machines.
 *
 * Run: node --import tsx --test tests/integration/performance-regression.test.ts
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Environment setup (must come before dynamic imports) ---
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-perf-regression-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.REQUIRE_API_KEY = "false";
if (!process.env.API_KEY_SECRET) {
  process.env.API_KEY_SECRET = "test-perf-secret-" + Date.now();
}

// --- Dynamic imports after env setup ---
const core = await import("../../src/lib/db/core.ts");
const { skillRegistry } = await import("../../src/lib/skills/registry.ts");
const { getTestBackend } = await import("../helpers/postgres.ts");

// --- Constants ---
const TEST_API_KEY_ID = "perf-test-api-key";
const SKILL_COUNT = 100;

// --- Thresholds (2x buffer for CI) ---
const THRESHOLD_SKILLS_CACHED_MS = 100;
const THRESHOLD_SKILLS_UNCACHED_MS = 400;

// ============================================================
// Skills registry - cached vs uncached list
// ============================================================
describe("Performance: skills registry cached vs uncached", () => {
  // Register 100 skills in the database
  it(`registers ${SKILL_COUNT} skills`, async () => {
    for (let i = 0; i < SKILL_COUNT; i++) {
      await skillRegistry.register({
        name: `perf-skill-${i}`,
        version: "1.0.0",
        description: `Performance test skill ${i}`,
        schema: { input: {}, output: {} },
        handler: `echo "skill ${i}"`,
        enabled: true,
        apiKeyId: TEST_API_KEY_ID,
      });
    }
  });

  after(async () => {
    // Clean up skills, then release the pool and temp dir
    await getTestBackend().execute("DELETE FROM skills WHERE api_key_id = $1", [TEST_API_KEY_ID]);
    skillRegistry.invalidateCache();
    await core.resetDbInstance();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it(`should load skills from DB (uncached) in <${THRESHOLD_SKILLS_UNCACHED_MS}ms`, async () => {
    // Force cache invalidation so loadFromDatabase actually hits DB
    skillRegistry.invalidateCache();

    const start = performance.now();
    await skillRegistry.loadFromDatabase();
    const elapsed = performance.now() - start;

    assert.ok(
      elapsed < THRESHOLD_SKILLS_UNCACHED_MS,
      `Uncached loadFromDatabase took ${elapsed.toFixed(1)}ms, expected <${THRESHOLD_SKILLS_UNCACHED_MS}ms`
    );
  });

  it(`should list skills from cache in <${THRESHOLD_SKILLS_CACHED_MS}ms`, async () => {
    // Ensure cache is warm (loadFromDatabase was just called above)
    // Call list() which reads from in-memory Map
    const start = performance.now();
    const skills = skillRegistry.list();
    const elapsed = performance.now() - start;

    assert.ok(skills.length >= SKILL_COUNT, `Should have at least ${SKILL_COUNT} skills`);
    assert.ok(
      elapsed < THRESHOLD_SKILLS_CACHED_MS,
      `Cached list() took ${elapsed.toFixed(1)}ms, expected <${THRESHOLD_SKILLS_CACHED_MS}ms`
    );
  });
});
