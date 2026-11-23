import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  getTaskFitnessWithSource,
  setUserFitnessOverride,
  clearUserFitnessOverride,
  invalidateFitnessCache,
} from "../../../open-sse/services/autoCombo/taskFitness.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
import { resetTestDb } from "../../helpers/postgres.ts";

/**
 * TDD regression for #11489: an effort variant must inherit its base model's
 * task-fitness score instead of falling through to the wildcard 0.5, and a
 * sibling model must NOT inherit it.
 */
describe("taskFitness inherits from the scoresAs base (#11489)", () => {
  before(async () => {
    await resetTestDb();
    await setUserFitnessOverride("gpt-5.6-sol", "coding", 0.97);
    invalidateFitnessCache();
  });

  after(async () => {
    await clearUserFitnessOverride("gpt-5.6-sol", "coding");
    invalidateFitnessCache();
    await resetDbInstance();
  });

  it("scores the base model from its own user_override row", async () => {
    const result = await getTaskFitnessWithSource("gpt-5.6-sol", "coding");
    assert.equal(result.score, 0.97);
    assert.equal(result.source, "user_override");
  });

  it("inherits the base score for an effort variant, tagged as inherited", async () => {
    // Before the fix this returned the wildcard 0.5.
    const result = await getTaskFitnessWithSource("gpt-5.6-sol-xhigh", "coding");
    assert.equal(result.score, 0.97);
    assert.equal(result.source, "user_override:inherited");
  });

  it("inherits through an explicit forward vendor alias (gpt-5.6 -> gpt-5.6-sol)", async () => {
    const result = await getTaskFitnessWithSource("gpt-5.6", "coding");
    assert.equal(result.score, 0.97);
    assert.equal(result.source, "user_override:inherited");
  });

  it("does NOT leak the base score to a sibling model", async () => {
    const result = await getTaskFitnessWithSource("gpt-5.6-luna", "coding");
    assert.notEqual(result.source, "user_override");
    assert.notEqual(result.source, "user_override:inherited");
    assert.notEqual(result.score, 0.97);
  });
});
