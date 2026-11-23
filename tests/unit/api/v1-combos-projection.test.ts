/**
 * Issue #2300 — Public projection of combo metadata for GET /v1/combos.
 * Verifies that internal routing details (connectionId, weights) are stripped
 * before being exposed to API-key callers.
 *
 * Issue #10968 — and that a step still reports *whether* it pins an account,
 * which is derivable from the stripped connectionId without exposing it.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { projectCombo, projectComboStep } =
  await import("../../../src/app/api/v1/combos/projectCombo.ts");

test("#2300 projectComboStep keeps model + providerId, drops connectionId/weight/label", async () => {
  const out = projectComboStep({
    id: "step_internal_id",
    kind: "model",
    model: "anthropic/claude-sonnet-4",
    providerId: "anthropic",
    connectionId: "conn_secret_xyz",
    weight: 0.7,
    label: "primary",
    tags: ["fast"],
  });

  assert.deepEqual(out, {
    kind: "model",
    model: "anthropic/claude-sonnet-4",
    providerId: "anthropic",
    accountPinned: true,
  });
});

test("#2300 projectComboStep keeps combo-ref's comboName, drops weight/label", async () => {
  const out = projectComboStep({
    id: "step_internal",
    kind: "combo-ref",
    comboName: "fallback-combo",
    weight: 0.3,
    label: "secondary",
  });

  assert.deepEqual(out, { kind: "combo-ref", comboName: "fallback-combo" });
});

test("#2300 projectComboStep returns null for unknown kinds + malformed steps", async () => {
  assert.equal(projectComboStep({ kind: "unknown" }), null);
  assert.equal(projectComboStep({ kind: "model" }), null); // missing model
  assert.equal(projectComboStep({ kind: "combo-ref" }), null); // missing comboName
  assert.equal(projectComboStep({}), null);
  assert.equal(projectComboStep({ not_a_kind: true }), null);
});

test("#2300 projectCombo preserves name/strategy/description, projects models", async () => {
  const out = await projectCombo({
    id: "internal_id",
    name: "my-combo",
    strategy: "priority",
    description: "primary route",
    sortOrder: 5,
    models: [
      {
        kind: "model",
        model: "openai/gpt-5",
        providerId: "openai",
        connectionId: "conn_X",
        weight: 1,
      },
    ],
    schemaVersion: 2,
    config: { secret: "should-not-leak" },
  });

  assert.deepEqual(out, {
    name: "my-combo",
    strategy: "priority",
    description: "primary route",
    models: [{ kind: "model", model: "openai/gpt-5", providerId: "openai", accountPinned: true }],
  });

  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes("conn_X"), "connection id must not leak");
  assert.ok(!serialized.includes("should-not-leak"), "config.secret must not leak");
  assert.ok(!serialized.includes("sortOrder"), "sortOrder must not leak");
});

test("#2300 projectCombo defaults strategy to 'priority' when missing", async () => {
  const out = await projectCombo({ name: "default-strategy", models: [] });
  assert.equal(out?.strategy, "priority");
});

test("#2300 projectCombo returns null for empty name", async () => {
  assert.equal(await projectCombo({ name: "", models: [] }), null);
  assert.equal(await projectCombo({ name: "   ", models: [] }), null);
  assert.equal(await projectCombo({ models: [] }), null);
});

test("#2300 projectCombo filters out malformed step entries silently", async () => {
  const out = await projectCombo({
    name: "noisy",
    strategy: "auto",
    models: [
      { kind: "model", model: "openai/gpt-5" },
      "not-an-object",
      null,
      { kind: "unknown" },
      { kind: "model" }, // missing model
    ],
  });
  assert.equal(out?.models.length, 1);
  assert.equal(out?.models[0].model, "openai/gpt-5");
});

test("#2300 projectCombo omits description when empty", async () => {
  const out = await projectCombo({ name: "no-desc", strategy: "priority", models: [] });
  assert.equal("description" in (out ?? {}), false);
});

/**
 * Issue #10968 — two steps that pin different accounts of the same provider are
 * indistinguishable in the projection, so a client reads a two-account failover
 * as one duplicated step. `accountPinned` says which it is; the connectionId it
 * is derived from must stay stripped.
 */
test("#10968 projectComboStep reports a pinned account without the connectionId", async () => {
  const out = projectComboStep({
    kind: "model",
    model: "jina-ai/some-embed",
    providerId: "jina-ai",
    connectionId: "conn_secret_xyz",
  });

  assert.deepEqual(out, {
    kind: "model",
    model: "jina-ai/some-embed",
    providerId: "jina-ai",
    accountPinned: true,
  });
  assert.ok(!JSON.stringify(out).includes("conn_secret_xyz"), "connection id must not leak");
});

test("#10968 projectComboStep reports false for an unpinned model step", async () => {
  assert.equal(
    projectComboStep({ kind: "model", model: "jina-ai/some-embed", providerId: "jina-ai" })
      ?.accountPinned,
    false
  );
});

test("#10968 an empty or non-string connectionId is not a pin", async () => {
  // Same shape test providerId gets: present but empty pins nothing, and a
  // non-string cannot be a connection id at all.
  for (const connectionId of ["", null, 0, false, {}, []]) {
    assert.equal(
      projectComboStep({ kind: "model", model: "openai/gpt-5", connectionId })?.accountPinned,
      false,
      `connectionId ${JSON.stringify(connectionId)} must not read as a pin`
    );
  }
});

test("#10968 a combo-ref carries no accountPinned", async () => {
  const out = projectComboStep({
    kind: "combo-ref",
    comboName: "fallback-combo",
    connectionId: "conn_ignored",
  });

  assert.deepEqual(out, { kind: "combo-ref", comboName: "fallback-combo" });
  assert.equal("accountPinned" in (out ?? {}), false);
});

test("#10968 malformed steps stay null rather than gaining the flag", async () => {
  assert.equal(projectComboStep({ kind: "model", connectionId: "conn_X" }), null);
  assert.equal(projectComboStep({ kind: "unknown", connectionId: "conn_X" }), null);
});

test("#10968 two pinned accounts of one provider are no longer identical", async () => {
  const out = await projectCombo({
    name: "failover",
    strategy: "priority",
    models: [
      {
        kind: "model",
        model: "jina-ai/some-embed",
        providerId: "jina-ai",
        connectionId: "conn_wallet_a",
      },
      {
        kind: "model",
        model: "jina-ai/some-embed",
        providerId: "jina-ai",
        connectionId: "conn_wallet_b",
      },
      { kind: "model", model: "jina-ai/some-embed", providerId: "jina-ai" },
    ],
  });

  assert.deepEqual(
    out?.models.map((m) => m.accountPinned),
    [true, true, false]
  );

  const serialized = JSON.stringify(out);
  for (const id of ["conn_wallet_a", "conn_wallet_b"]) {
    assert.ok(!serialized.includes(id), `${id} must not leak`);
  }
});
