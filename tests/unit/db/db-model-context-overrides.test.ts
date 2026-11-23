import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetTestDb } from "../../helpers/postgres.ts";

// Feature 5004 — model_context_overrides DB module round-trip.

const mco = await import("../../../src/lib/db/modelContextOverrides.ts");

beforeEach(async () => {
  await resetTestDb();
});

describe("modelContextOverrides", () => {
  it("returns null when there is no override", async () => {
    assert.equal(await mco.getModelContextOverride("openai", "gpt-5"), null);
    assert.equal(await mco.getModelContextOverrideRecord("openai", "gpt-5"), null);
  });

  it("round-trips a manual override (set -> get -> record)", async () => {
    assert.equal(await mco.setModelContextOverride("openai", "gpt-5", 400000), true);
    assert.equal(await mco.getModelContextOverride("openai", "gpt-5"), 400000);
    const rec = await mco.getModelContextOverrideRecord("openai", "gpt-5");
    assert.equal(rec?.realContext, 400000);
    assert.equal(rec?.source, "manual");
    assert.equal(rec?.provider, "openai");
    assert.equal(rec?.modelId, "gpt-5");
  });

  it("upserts on the same (provider, model) key and records the source", async () => {
    await mco.setModelContextOverride("anthropic", "claude-sonnet-4-5", 200000, "auto:discovery");
    assert.equal(
      (await mco.getModelContextOverrideRecord("anthropic", "claude-sonnet-4-5"))?.source,
      "auto:discovery"
    );
    // Re-set as manual overwrites the same row.
    await mco.setModelContextOverride("anthropic", "claude-sonnet-4-5", 1000000, "manual");
    const rec = await mco.getModelContextOverrideRecord("anthropic", "claude-sonnet-4-5");
    assert.equal(rec?.realContext, 1000000);
    assert.equal(rec?.source, "manual");
    assert.equal((await mco.listModelContextOverrides()).length, 1);
  });

  it("rejects non-positive / non-integer windows and empty keys (no write)", async () => {
    assert.equal(await mco.setModelContextOverride("openai", "gpt-5", 0), false);
    assert.equal(await mco.setModelContextOverride("openai", "gpt-5", -1), false);
    assert.equal(await mco.setModelContextOverride("openai", "gpt-5", 1.5), false);
    assert.equal(await mco.setModelContextOverride("", "gpt-5", 1000), false);
    assert.equal(await mco.setModelContextOverride("openai", "  ", 1000), false);
    assert.equal(await mco.getModelContextOverride("openai", "gpt-5"), null);
  });

  it("trims keys so lookups match writes", async () => {
    await mco.setModelContextOverride("  openai  ", "  gpt-5  ", 333000);
    assert.equal(await mco.getModelContextOverride("openai", "gpt-5"), 333000);
  });

  it("removes an override", async () => {
    await mco.setModelContextOverride("groq", "llama-3.3-70b", 128000);
    assert.equal(await mco.removeModelContextOverride("groq", "llama-3.3-70b"), true);
    assert.equal(await mco.getModelContextOverride("groq", "llama-3.3-70b"), null);
    assert.equal(await mco.removeModelContextOverride("groq", "llama-3.3-70b"), false);
  });

  it("lists all overrides", async () => {
    await mco.setModelContextOverride("openai", "gpt-5", 400000);
    await mco.setModelContextOverride("anthropic", "claude-sonnet-4-5", 200000, "auto:discovery");
    const all = await mco.listModelContextOverrides();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((o) => `${o.provider}/${o.modelId}`).sort(), [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
  });
});
