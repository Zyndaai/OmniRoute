// Vision-aware routing, fusion panel/judge, context-overflow and output-limit-advisory tests
// around combo.ts. Merged from ten files so combo.ts loads once; each original file is one
// `describe` below, named after the file it came from.
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResolvedComboTarget } from "../../../open-sse/services/combo/types.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-vision-fusion-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-vision-fusion-test-secret";

const { resetTestDb } = await import("../../helpers/postgres.ts");
const core = await import("../../../src/lib/db/core.ts");
const modelsDb = await import("../../../src/lib/db/models.ts");
const nodesDb = await import("../../../src/lib/db/providers/nodes.ts");
const nodePrefix = await import("../../../src/lib/db/providers/nodePrefix.ts");
const combosDb = await import("../../../src/lib/db/combos.ts");
const { updateSettingsSchema } = await import("../../../src/shared/validation/settingsSchemas.ts");
const { getSettings, updateSettings } = await import("../../../src/lib/db/settings.ts");
const modelCapabilities = await import("../../../src/lib/modelCapabilities.ts");
const { getResolvedModelCapabilities } = modelCapabilities;
const { getComboVisionBridgeDecision } =
  await import("../../../src/lib/guardrails/visionBridge.ts");
const { saveModelsDevCapabilities, clearModelsDevCapabilities } =
  await import("../../../src/lib/modelsDevSync.ts");
const comboModule = await import("../../../open-sse/services/combo.ts");
const { handleComboChat, filterTargetsByRequestCompatibility } = comboModule;
const comboStructure = await import("../../../open-sse/services/combo/comboStructure.ts");
const { rotateWithinVisionTiers } = await import("../../../open-sse/services/combo/rrState.ts");
const { getTokenLimit } = await import("../../../open-sse/services/contextManager.ts");
const { resetAllComboMetrics } = await import("../../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../../open-sse/services/rateLimitSemaphore.ts");

after(async () => {
  try {
    await core.resetDbInstance();
  } catch {
    /* ignore */
  }
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("combo-vision-aware-routing", () => {
  /**
   * Regression: combo routing must not send image requests to models
   * explicitly known to lack vision, while allowing unknown-capability fallbacks.
   *
   * Root cause: `getResolvedModelCapabilities` returned `supportsVision: null` for
   * every Mistral model — including Pixtral, which IS multimodal — because Mistral
   * ships no models.dev `attachment` flag and the provider registry sets no
   * `supportsVision`. The combo compatibility filter only dropped a target when
   * `supportsVision === false`, so a `null` (unknown) text model like
   * `ministral-14b` slipped through and received the image, replying
   * "IMAGEM_INDISPONIVEL" / "image not provided".
   *
   * Two-part fix, both asserted here:
   *  A) resolveVisionCapability falls back to a conservative model-id heuristic so
   *     known-multimodal families (pixtral, llava, qwen-vl, gpt-4o, …) resolve to
   *     `true` when there is no synced/registry/spec data.
   *  B) the combo filter excludes explicitly non-vision targets (#8332).
   *     Unknown capability remains unknown and may be attempted only after
   *     confirmed vision models (#17289); that does not resurrect a target with
   *     an explicit negative verdict.
   */
  const { deriveRequestCompatibilityRequirements, hasHardCapabilityFailure } = comboStructure;

  before(async () => {
    // Deterministic, isolated storage so capability resolution sees NO synced data
    // and exercises the registry/spec/heuristic path only.
    await resetTestDb();
  });

  after(async () => {
    await resetTestDb();
  });

  // --- Part A: capability resolution -----------------------------------------

  test("Pixtral resolves supportsVision=true via model-id heuristic (no synced data)", async () => {
    assert.equal(
      (await getResolvedModelCapabilities("mistral/pixtral-12b-latest")).supportsVision,
      true
    );
  });

  test("a text-only Mistral model is NOT a vision false-positive", async () => {
    assert.notEqual(
      (await getResolvedModelCapabilities("mistral/ministral-14b-latest")).supportsVision,
      true
    );
  });

  // --- Part B: combo routing --------------------------------------------------

  function target(modelStr: string) {
    return {
      kind: "model" as const,
      stepId: modelStr,
      executionKey: modelStr,
      modelStr,
      provider: modelStr.includes("/") ? modelStr.split("/")[0] : modelStr,
      providerId: null,
      connectionId: null,
      weight: 1,
      label: null,
    };
  }

  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

  const imageBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" },
          },
        ],
      },
    ],
  };

  test("image request: confirmed vision wins while unknown metadata remains fallback (#17289)", async () => {
    assert.equal(
      (await getResolvedModelCapabilities("mistral/ministral-14b-latest")).supportsVision,
      null
    );
    const out = await filterTargetsByRequestCompatibility(
      [target("mistral/ministral-14b-latest"), target("mistral/pixtral-12b-latest")],
      imageBody,
      noopLog
    );
    assert.deepEqual(
      out.map((t) => t.modelStr),
      ["mistral/pixtral-12b-latest", "mistral/ministral-14b-latest"],
      "confirmed vision must dispatch first; unknown metadata is last resort"
    );
  });

  test("nested case-insensitive image indicators still enforce hard vision compatibility", () => {
    const requirements = deriveRequestCompatibilityRequirements({
      messages: [
        {
          role: "user",
          content: [
            {
              payload: {
                type: "IMAGE_URL",
                image_url: { url: "data:image/png;base64,iVBOR" },
              },
            },
          ],
        },
      ],
    });

    assert.equal(requirements.requiresVision, true);
    assert.equal(hasHardCapabilityFailure(["vision"]), true);
    assert.equal(hasHardCapabilityFailure(["context_window"]), false);
  });

  test("image request with explicitly non-vision targets fails closed (#8332, #17289)", async () => {
    // Explicitly text-only variants stay excluded even after unknown-capability
    // fallbacks were enabled for other models.
    const models = ["cmd/gpt-5.3-codex", "mimo/mimo-v2.5-pro"];
    for (const model of models) {
      assert.equal((await getResolvedModelCapabilities(model)).supportsVision, false, model);
    }
    const out = await filterTargetsByRequestCompatibility(models.map(target), imageBody, noopLog);
    assert.deepEqual(out, [], "confirmed text-only targets must not receive images");
  });

  test("text-only request: targets are untouched by the vision filter", async () => {
    const out = await filterTargetsByRequestCompatibility(
      [target("mistral/ministral-14b-latest")],
      { messages: [{ role: "user", content: "hello" }] },
      noopLog
    );
    assert.equal(out.length, 1);
  });

  test("large output request: unknown maxOutputTokens does not filter a target", async () => {
    const out = await filterTargetsByRequestCompatibility(
      [target("openai-compatible-local/custom-large-output-model"), target("openai/gpt-4o-mini")],
      { messages: [{ role: "user", content: "hello" }], max_tokens: 32000 },
      noopLog
    );
    const ids = out.map((t) => t.modelStr);

    assert.deepEqual(ids, ["openai-compatible-local/custom-large-output-model"]);
  });
});

describe("combo-vision-prefixed-step-custom-override", () => {
  /**
   * Combo steps store their model with the provider-alias prefix
   * (`{ providerId: "codex", model: "cx/<id>" }`), which is how the dashboard and
   * the combo builder write them. The combo capability filter and the Vision
   * Bridge resolve those steps through the OBJECT form of
   * getResolvedModelCapabilities({ provider, model }). The string form
   * (`"cx/<id>"`) goes through parseModel and strips the prefix; the object form
   * kept `cx/<id>` as the model, so the Custom Models "Vision capable" row
   * (`customModels/codex` → `{ id: "<id>", supportsVision: true }`) never matched
   * and every such step resolved `supportsVision: null`.
   *
   * Effect: an image request to that combo failed closed with
   * `capability_mismatch` ("No target in combo … has confirmed vision support"),
   * and the Vision Bridge classified the combo as "no-vision" and replaced the
   * image with an "(unavailable …)" stub.
   *
   * MODEL_ID is deliberately absent from every static source (provider registry,
   * MODEL_SPECS, models.dev sync, id-fragment heuristic), so the custom row is
   * the only capability evidence, exactly like a newly released model an
   * operator declares by hand.
   */
  const { isVisionIncompatibleTarget } = comboStructure;
  const { addCustomModel } = modelsDb;
  const prefixedFilter = comboStructure.filterTargetsByRequestCompatibility;

  const MODEL_ID = "acme-sight-7";
  const TEXT_ONLY_MODEL_ID = "acme-blind-7";

  const log = { info() {}, warn() {}, error() {}, debug() {} };

  /** Responses API tool result that carries an image (the fail-closed shape). */
  const toolImageBody = {
    model: "prefixed-vision-combo",
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "screenshot",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_image", image_url: "https://example.com/swatch.png" }],
      },
    ],
  };

  function target(providerId: string, modelStr: string): ResolvedComboTarget {
    return {
      kind: "model",
      stepId: `step-${providerId}-${modelStr}`,
      executionKey: `step-${providerId}-${modelStr}`,
      modelStr,
      provider: providerId,
      providerId,
      connectionId: null,
      weight: 1,
      label: null,
    };
  }

  const visionRequirements = {
    requiresTools: false,
    requiresVision: true,
    requiresStructuredOutput: false,
    estimatedInputTokens: 10,
    requestedOutputTokens: 0,
    requiredContextTokens: 10,
  };

  before(async () => {
    await resetTestDb();
    await addCustomModel(
      "codex",
      MODEL_ID,
      "Acme Sight 7",
      "manual",
      "responses",
      ["chat"],
      undefined,
      {},
      true
    );
    await addCustomModel(
      "codex",
      TEXT_ONLY_MODEL_ID,
      "Acme Blind 7",
      "manual",
      "responses",
      ["chat"],
      undefined,
      {},
      false
    );
  });

  beforeEach(() => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
  });

  after(async () => {
    await resetTestDb();
  });

  test("control: the bare and string forms already honor the custom vision row", async () => {
    assert.equal(
      (await getResolvedModelCapabilities({ provider: "codex", model: MODEL_ID })).supportsVision,
      true
    );
    assert.equal((await getResolvedModelCapabilities(`cx/${MODEL_ID}`)).supportsVision, true);
  });

  for (const providerId of ["codex", "cx"]) {
    test(`object form {${providerId}, cx/<id>} resolves like the string form`, async () => {
      const caps = await getResolvedModelCapabilities({
        provider: providerId,
        model: `cx/${MODEL_ID}`,
      });
      assert.equal(caps.provider, "codex");
      assert.equal(caps.model, MODEL_ID, "the alias prefix of the same provider must be stripped");
      assert.equal(caps.supportsVision, true, "Custom Models 'Vision capable' must apply");
    });

    test(`combo filter keeps a prefixed step {${providerId}, cx/<id>} for an image request`, async () => {
      const step = target(providerId, `cx/${MODEL_ID}`);
      assert.equal(await isVisionIncompatibleTarget(step, visionRequirements), false);
      const kept = await prefixedFilter([step], toolImageBody, log);
      assert.deepEqual(
        kept.map((t) => t.modelStr),
        [`cx/${MODEL_ID}`]
      );
    });
  }

  test("the codex/<id> prefix form is treated the same as cx/<id>", async () => {
    const caps = await getResolvedModelCapabilities({
      provider: "codex",
      model: `codex/${MODEL_ID}`,
    });
    assert.equal(caps.model, MODEL_ID);
    assert.equal(caps.supportsVision, true);
  });

  test("explicit supportsVision:false on a prefixed step still wins", async () => {
    const caps = await getResolvedModelCapabilities({
      provider: "codex",
      model: `cx/${TEXT_ONLY_MODEL_ID}`,
    });
    assert.equal(caps.supportsVision, false);
    assert.equal(
      await isVisionIncompatibleTarget(
        target("codex", `cx/${TEXT_ONLY_MODEL_ID}`),
        visionRequirements
      ),
      true
    );
  });

  test("a slash in a native model id is not stripped when the prefix is another provider", async () => {
    // nvidia's registry id starts with `nvidia/`, but openrouter-style and
    // namespaced ids (`meta/…`, `openai/…`) under a different provider must keep
    // their full path: the first segment is part of the provider's model id.
    const openrouter = await getResolvedModelCapabilities({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct",
    });
    assert.equal(openrouter.provider, "openrouter");
    assert.equal(openrouter.model, "meta-llama/llama-3.3-70b-instruct");

    const crossProvider = await getResolvedModelCapabilities({
      provider: "nvidia",
      model: `cx/${MODEL_ID}`,
    });
    assert.equal(crossProvider.provider, "nvidia");
    assert.equal(
      crossProvider.model,
      `cx/${MODEL_ID}`,
      "a prefix that resolves to a DIFFERENT provider is part of the model id"
    );
    assert.notEqual(
      crossProvider.supportsVision,
      true,
      "codex's custom row must not leak to nvidia"
    );
  });

  test("a provider whose native ids carry its own name keeps resolving (#12112)", async () => {
    const caps = await getResolvedModelCapabilities({
      provider: "nvidia",
      model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    });
    assert.equal(caps.supportsVision, true);
  });

  test("a custom row stored under the verbatim prefixed id keeps matching", async () => {
    // Operators worked around this bug by declaring the exact step string as the
    // custom model id. That row must keep resolving after the prefix is stripped.
    const verbatimOnly = "acme-verbatim-7";
    await addCustomModel(
      "codex",
      `cx/${verbatimOnly}`,
      "Acme Verbatim 7",
      "manual",
      "responses",
      ["chat"],
      undefined,
      {},
      true
    );
    const caps = await getResolvedModelCapabilities({
      provider: "codex",
      model: `cx/${verbatimOnly}`,
    });
    assert.equal(caps.supportsVision, true);
  });

  test("Vision Bridge classifies an all-prefixed custom-vision combo as skip, not no-vision", async () => {
    await combosDb.createCombo({
      name: "prefixed-vision-combo-bridge",
      models: [
        { providerId: "codex", model: `cx/${MODEL_ID}`, weight: 1 },
        { providerId: "cx", model: `cx/${MODEL_ID}`, weight: 1 },
      ],
    });
    assert.equal(await getComboVisionBridgeDecision("prefixed-vision-combo-bridge"), "skip");
  });

  test("image tool result reaches a prefixed custom-vision step instead of 400 capability_mismatch", async () => {
    const dispatched: string[] = [];
    const response = await handleComboChat({
      body: toolImageBody,
      combo: {
        name: "prefixed-vision-combo",
        strategy: "priority",
        models: [{ providerId: "codex", model: `cx/${MODEL_ID}`, weight: 1 }],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body, modelStr) => {
        dispatched.push(modelStr);
        return new Response(JSON.stringify({ output_text: "red" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });

    const text = response.status === 200 ? "" : await response.text();
    assert.equal(response.status, 200, `expected dispatch, got ${response.status} ${text}`);
    assert.deepEqual(dispatched, [`cx/${MODEL_ID}`]);
  });
});

describe("combo-vision-unknown-fallback-17289", () => {
  const { deriveRequestCompatibilityRequirements } = comboStructure;
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const request = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe image" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  };
  const target = (modelStr: string) => ({
    kind: "model" as const,
    stepId: modelStr,
    executionKey: modelStr,
    modelStr,
    provider: modelStr.slice(0, modelStr.indexOf("/")),
    providerId: null,
    connectionId: null,
    weight: 1,
    label: null,
  });
  const ids = (targets: ReturnType<typeof target>[]) => targets.map((t) => t.modelStr);

  beforeEach(async () => {
    resetAllComboMetrics();
    await resetAllCircuitBreakers();
    resetAllSemaphores();
  });
  after(async () => {
    resetAllComboMetrics();
    await resetAllCircuitBreakers();
    resetAllSemaphores();
  });

  test("#17289 WorkBuddy's exact DeepSeek Flash aliases have scoped vision evidence", async () => {
    for (const id of ["workbuddy/global:deepseek-v4.1-flash", "workbuddy/cn:deepseek-v4.1-flash"]) {
      assert.equal((await getResolvedModelCapabilities(id)).supportsVision, true, id);
    }
    assert.notEqual(
      (await getResolvedModelCapabilities("workbuddy/global:unrelated-unknown-model-17289"))
        .supportsVision,
      true
    );
    assert.notEqual(
      (await getResolvedModelCapabilities("codearts/deepseek-v4.1-flash")).supportsVision,
      true,
      "WorkBuddy evidence must not be globalized to a different gateway"
    );
  });

  test("#17289 confirmed vision takes precedence over unknown; explicit false stays blocked", async () => {
    const known = target("workbuddy/global:deepseek-v4.1-flash");
    const unknown = target("workbuddy/unknown-model-17289");
    const blind = target("cmd/gpt-5.3-codex");
    assert.equal(deriveRequestCompatibilityRequirements(request).requiresVision, true);
    assert.equal((await getResolvedModelCapabilities(unknown.modelStr)).supportsVision, null);
    assert.equal((await getResolvedModelCapabilities(blind.modelStr)).supportsVision, false);
    assert.deepEqual(
      ids(
        await comboStructure.filterTargetsByRequestCompatibility(
          [unknown, blind, known],
          request,
          log
        )
      ),
      [known.modelStr, unknown.modelStr]
    );
    assert.deepEqual(
      ids(await comboStructure.filterTargetsByRequestCompatibility([unknown, blind], request, log)),
      [unknown.modelStr]
    );
    assert.deepEqual(
      ids(await comboStructure.filterTargetsByRequestCompatibility([blind], request, log)),
      []
    );
  });

  test("#17289 priority dispatch reaches an unknown target if no confirmed target exists", async () => {
    const calls: string[] = [];
    const model = "workbuddy/unknown-model-17289";
    const response = await handleComboChat({
      body: request,
      combo: {
        name: "workbuddy-unknown-vision-17289",
        strategy: "priority",
        models: [model],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [model]);
  });

  test("#17289 round-robin rotates within the confirmed tier; unknown stays last resort", async () => {
    const confirmed = "mistral/pixtral-12b-latest";
    const unknown = "mistral/ministral-14b-latest";
    // A different provider than the confirmed one: a quota/outage on one provider
    // skips its siblings for the rest of the request (#1731), which would mask the fallback.
    const unknownOtherProvider = "groq/llama-3.1-8b-instant";
    assert.equal((await getResolvedModelCapabilities(confirmed)).supportsVision, true);
    assert.equal((await getResolvedModelCapabilities(unknown)).supportsVision, null);
    assert.equal((await getResolvedModelCapabilities(unknownOtherProvider)).supportsVision, null);
    const run = async (name: string, models: string[], failing: Set<string>) => {
      const calls: string[] = [];
      const combo = { name, strategy: "round-robin", models, config: { maxRetries: 0 } };
      for (let i = 0; i < 4; i++) {
        const response = await handleComboChat({
          body: request,
          combo,
          handleSingleModel: async (_body, modelStr) => {
            calls.push(modelStr);
            if (failing.has(modelStr)) {
              return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
                status: 503,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
          isModelAvailable: async () => true,
          log,
          settings: null,
          relayOptions: null,
          allCombos: null,
        });
        assert.equal(response.status, 200, `${name} request ${i}: ${calls.join(",")}`);
      }
      return calls;
    };
    // Healthy confirmed target: every image request is served by it, never by the unknown one.
    assert.deepEqual(await run("rr-vision-healthy-17289", [confirmed, unknown], new Set()), [
      confirmed,
      confirmed,
      confirmed,
      confirmed,
    ]);
    // Order in the combo does not matter: the confirmed tier still goes first.
    assert.deepEqual(await run("rr-vision-reversed-17289", [unknown, confirmed], new Set()), [
      confirmed,
      confirmed,
      confirmed,
      confirmed,
    ]);
    // Confirmed target failing: the unknown target is still reachable as last resort.
    const fallbackCalls = await run(
      "rr-vision-fallback-17289",
      [confirmed, unknownOtherProvider],
      new Set([confirmed])
    );
    assert.ok(
      fallbackCalls.includes(unknownOtherProvider),
      "unknown target must serve when the confirmed one fails"
    );
  });

  test("#17289 rotateWithinVisionTiers rotates the confirmed prefix, then the unknown tail", () => {
    const order = (start: number, total: number, confirmed: number) =>
      Array.from({ length: total }, (_, offset) =>
        rotateWithinVisionTiers(offset, start, total, confirmed)
      );
    assert.deepEqual(order(0, 4, 0), [0, 1, 2, 3], "no tiering: plain rotation");
    assert.deepEqual(order(2, 4, 0), [2, 3, 0, 1], "no tiering: plain rotation from start");
    assert.deepEqual(order(0, 4, 2), [0, 1, 2, 3]);
    assert.deepEqual(order(1, 4, 2), [1, 0, 2, 3], "confirmed tier rotates, unknown stays last");
    assert.deepEqual(
      order(3, 4, 2),
      [1, 0, 3, 2],
      "start inside the unknown tier still leads with confirmed"
    );
    assert.deepEqual(order(1, 2, 1), [0, 1], "one confirmed target is always first");
  });

  test("#17289: unknown-vision fallback reports actionable upstream attachment rejection", async () => {
    for (const strategy of ["priority", "round-robin"] as const) {
      const attempted: string[] = [];
      const model = "workbuddy/unconfirmed-upstream-17289";
      assert.equal(
        (await getResolvedModelCapabilities(model)).supportsVision,
        null,
        "fixture must have an unknown-vision model"
      );
      const response = await handleComboChat({
        body: request,
        combo: {
          name: "unknown-vision-upstream-" + strategy,
          strategy,
          models: [model],
          config: { maxRetries: 0 },
        },
        handleSingleModel: async (_body, modelStr) => {
          attempted.push(modelStr);
          return new Response(
            JSON.stringify({
              error: {
                message: "this profile has no attachment handler installed; 无法处理图片",
                code: "unsupported_content",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        relayOptions: null,
        allCombos: null,
      });
      assert.deepEqual(
        attempted,
        [model],
        strategy + " must dispatch unknown vision before failing"
      );
      assert.equal(response.status, 400);
      const json = (await response.json()) as { error: { message: string; code?: string } };
      assert.match(
        json.error.message,
        /attachment handler/i,
        "upstream explanation must survive the combo error boundary"
      );
      assert.match(
        json.error.message,
        /无法处理图片/,
        "non-English upstream explanation must not collapse to a generic 400"
      );
      assert.doesNotMatch(
        json.error.message,
        /No target.*confirmed vision support|capability_mismatch/i
      );
    }
  });

  test("#17289: an empty upstream 404 identifies the attempted model in combo diagnostics", async () => {
    const model = "workbuddy/unconfirmed-404-17289";
    assert.equal(
      (await getResolvedModelCapabilities(model)).supportsVision,
      null,
      "fixture must have an unknown-vision model"
    );
    const response = await handleComboChat({
      body: request,
      combo: {
        name: "unknown-vision-404-detail-17289",
        strategy: "priority",
        models: [model],
        config: { maxRetries: 0 },
      },
      handleSingleModel: async () => new Response(null, { status: 404 }),
      isModelAvailable: async () => true,
      log,
      settings: null,
      relayOptions: null,
      allCombos: null,
    });
    assert.equal(response.status, 404);
    const bodyText = await response.text();
    assert.ok(
      bodyText.trim(),
      "combo must synthesize a nonempty JSON error for blank upstream 404"
    );
    const json = JSON.parse(bodyText) as { error: { message: string } };
    assert.match(
      json.error.message,
      /unconfirmed-404-17289/,
      "404 diagnostic must identify which upstream target was attempted"
    );
  });

  test("#17289: mixed multi-model vision fallback preserves both upstream failure reasons", async () => {
    const confirmed = "mistral/pixtral-12b-latest";
    const unknown = "workbuddy/unconfirmed-mixed-errors-17289";
    assert.equal(
      (await getResolvedModelCapabilities(confirmed)).supportsVision,
      true,
      "fixture must have a confirmed vision model"
    );
    assert.equal(
      (await getResolvedModelCapabilities(unknown)).supportsVision,
      null,
      "fixture must have an unknown-vision model"
    );
    for (const strategy of ["priority", "round-robin"] as const) {
      const calls: string[] = [];
      const response = await handleComboChat({
        body: request,
        combo: {
          name: "vision-upstream-multi-" + strategy,
          strategy,
          // Reverse the intended order: a plain traversal would try unknown first.
          models: [unknown, confirmed],
          config: { maxRetries: 0 },
        },
        handleSingleModel: async (_body, modelStr) => {
          calls.push(modelStr);
          return modelStr === confirmed
            ? new Response(
                JSON.stringify({ error: { message: "temporary confirmed-model outage" } }),
                {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }
              )
            : new Response(JSON.stringify({ error: { message: "missing attachment handler" } }), {
                status: 400,
                headers: { "content-type": "application/json" },
              });
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        relayOptions: null,
        allCombos: null,
      });
      assert.deepEqual(
        calls,
        [confirmed, unknown],
        strategy + " must try confirmed vision first and unknown last"
      );
      assert.equal(
        response.status,
        502,
        "heterogeneous upstream errors must aggregate as gateway failure"
      );
      assert.match(response.headers.get("content-type") || "", /application\/json/i);
      const payload = (await response.json()) as {
        error?: { message?: unknown; code?: unknown; type?: unknown };
      };
      assert.equal(
        typeof payload.error?.message,
        "string",
        "combo terminal failure must have a structured client-visible error message"
      );
      const message = payload.error.message as string;
      assert.match(message, /temporary confirmed-model outage/);
      assert.match(message, /missing attachment handler/);
      assert.doesNotMatch(
        JSON.stringify(payload),
        /capability_mismatch|No target in combo .*confirmed vision/i,
        "a dispatched upstream failure must never be misclassified as pre-dispatch capability rejection"
      );
    }
  });
});

describe("model-compat-vision-custom-node-prefix", () => {
  /**
   * modelCompatOverrides.supportsVision must resolve for a custom openai-compatible
   * node no matter which of the node's two identities addresses the target.
   *
   * #15086 taught the canonical resolver (and therefore the combo vision filter and
   * /v1/models) to read `modelCompatOverrides.supportsVision`. That lookup is keyed by
   * the provider id `PUT /api/provider-models` was given — normally the node's internal
   * id (`openai-compatible-responses-<uuid>`). The catalog and prefix-addressed requests
   * address the same node by its user-defined prefix (`nr/<model>`, see catalog.ts's
   * `alias = prefix || providerIdToAlias[providerId] || providerId`), so the flag was
   * still invisible on that path: an image request to a prefix-addressed combo target
   * was rejected as vision-incapable even though the operator had flagged the model.
   *
   * Regression guard: the node-id form, the prefix form, and the catalog-shaped string
   * form must all agree, and an unrelated provider must not inherit the override.
   */
  const NODE_ID = "openai-compatible-responses-8ab99c2a-77e7-483d-84d6-d0277115607e";
  const PREFIX = "nr";
  const VISION_MODEL = "deepseek/deepseek-v4.1-flash";
  const BLIND_MODEL = "deepseek/deepseek-v4.1-blind";
  const UNSET_MODEL = "deepseek/deepseek-v4.1-unset";

  function imageRequestBody() {
    return {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "which colors?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    };
  }

  function comboTarget(providerId: string | null, provider: string, modelStr: string) {
    return {
      kind: "model",
      stepId: "step-1",
      executionKey: "exec-1",
      modelStr,
      provider,
      providerId,
      connectionId: null,
      weight: 1,
      label: null,
    } as never;
  }

  const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

  before(async () => {
    await resetTestDb();
    await nodesDb.createProviderNode({
      id: NODE_ID,
      type: "openai-compatible",
      name: "NordRouter",
      prefix: PREFIX,
      baseUrl: "https://example.invalid/v1",
      apiType: "responses",
    });
    // The live write path: PUT /api/provider-models { provider: <node id>, modelId, supportsVision }
    await modelsDb.mergeModelCompatOverride(NODE_ID, VISION_MODEL, { supportsVision: true });
    await modelsDb.mergeModelCompatOverride(NODE_ID, BLIND_MODEL, { supportsVision: false });
  });

  after(async () => {
    await resetTestDb();
  });

  test("node prefix maps back to its internal node id", async () => {
    assert.equal(await nodePrefix.getProviderNodeIdByPrefixSync(PREFIX), NODE_ID);
    assert.equal(await nodePrefix.getProviderNodeIdByPrefixSync(PREFIX.toUpperCase()), NODE_ID);
    assert.equal(await nodePrefix.getProviderNodeIdByPrefixSync("no-such-node-prefix"), null);
    assert.equal(await nodePrefix.getProviderNodePrefixSync(NODE_ID), PREFIX);
  });

  test("compat vision override resolves for the node id and for its prefix alike", async () => {
    const cases = [
      { provider: NODE_ID, model: VISION_MODEL },
      { provider: PREFIX, model: VISION_MODEL },
      { provider: NODE_ID, model: `${PREFIX}/${VISION_MODEL}` },
      { provider: PREFIX, model: `${PREFIX}/${VISION_MODEL}` },
      `${NODE_ID}/${VISION_MODEL}`,
      `${PREFIX}/${VISION_MODEL}`,
    ] as const;

    for (const input of cases) {
      assert.equal(
        (await modelCapabilities.getResolvedModelCapabilities(input)).supportsVision,
        true,
        JSON.stringify(input)
      );
    }
  });

  test("an explicit supportsVision:false on the node reaches the prefix form too", async () => {
    assert.equal(
      (
        await modelCapabilities.getResolvedModelCapabilities({
          provider: NODE_ID,
          model: BLIND_MODEL,
        })
      ).supportsVision,
      false
    );
    assert.equal(
      (
        await modelCapabilities.getResolvedModelCapabilities({
          provider: PREFIX,
          model: BLIND_MODEL,
        })
      ).supportsVision,
      false
    );
    assert.equal(
      (
        await modelCapabilities.getResolvedModelCapabilities({
          provider: PREFIX,
          model: UNSET_MODEL,
        })
      ).supportsVision,
      null,
      "a model with no override on this node must stay unknown"
    );
  });

  test("prefix-addressed combo target survives the vision filter for an image request", async () => {
    const body = imageRequestBody();
    const variants = [
      ["node id + bare model", comboTarget(NODE_ID, PREFIX, VISION_MODEL)],
      ["node id + prefix/model", comboTarget(NODE_ID, PREFIX, `${PREFIX}/${VISION_MODEL}`)],
      ["prefix + bare model", comboTarget(PREFIX, PREFIX, VISION_MODEL)],
      ["prefix only, catalog-shaped model", comboTarget(null, PREFIX, `${PREFIX}/${VISION_MODEL}`)],
    ] as const;

    for (const [label, target] of variants) {
      assert.equal(
        (await filterTargetsByRequestCompatibility([target], body, log)).length,
        1,
        `image request must keep the vision-capable target (${label})`
      );
    }

    assert.equal(
      (
        await filterTargetsByRequestCompatibility(
          [comboTarget(PREFIX, PREFIX, BLIND_MODEL)],
          body,
          log
        )
      ).length,
      0,
      "an explicitly vision-disabled node model must still be dropped"
    );
  });

  test("no cross-provider leak: an unrelated provider keeps its own verdict", async () => {
    assert.equal(
      (
        await modelCapabilities.getResolvedModelCapabilities({
          provider: "zz-unrelated-provider",
          model: VISION_MODEL,
        })
      ).supportsVision,
      null
    );
    // Static / models.dev catalog targets are untouched by the node mapping.
    assert.equal(
      (
        await modelCapabilities.getResolvedModelCapabilities({
          provider: "openai",
          model: "gpt-4o",
        })
      ).supportsVision,
      true
    );
  });
});

describe("fusion-judge-model-6455", () => {
  /**
   * Regression guard for #6455 — fusion combo silently returning a panel member
   * instead of the configured judgeModel's synthesis.
   *
   * Root cause: handleFusionChat()'s "degrade gracefully" path (added for #6454)
   * returned the lone surviving panel answer directly whenever only one panel
   * member succeeded — regardless of whether an explicit `config.judgeModel`
   * was configured. With a 2-model panel and the default `minPanel: 2`, any
   * single flaky/rate-limited panelist forces this path on *every* request, so
   * the configured judge (e.g. "auto/claude-opus") was never invoked and the
   * client-visible `.model` field always reflected whichever panel member
   * happened to survive that request (case (a): judge genuinely not run).
   *
   * Fix: when an explicit judgeModel is configured, still route the lone
   * surviving answer through the judge for synthesis instead of returning it
   * raw. Only the truly implicit case (no judgeModel set, "judge" defaults to
   * panel[0]) keeps the cheap direct-answer shortcut.
   */
  type Body = Record<string, unknown>;

  function jsonResponse(model: string, content: string): Response {
    const body = JSON.stringify({
      model,
      choices: [{ message: { role: "assistant", content } }],
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  function errResponse(status = 500): Response {
    return new Response(JSON.stringify({ error: { message: "boom" } }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function fusionCombo(models: string[], extra: Record<string, unknown> = {}) {
    return {
      name: "fusion-free",
      strategy: "fusion",
      models: models.map((m) => ({ model: m })),
      config: extra,
    };
  }

  test("6455: judge synthesizes even a single surviving panel answer when judgeModel is explicit", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      if (m === "gpt-5.5-panelist") return jsonResponse(m, "panel answer");
      if (m === "sonar-pro-panelist") return errResponse(503); // flaky panel member
      if (m === "auto/claude-opus") return jsonResponse("auto/claude-opus", "JUDGED FINAL");
      throw new Error(`unexpected model ${m}`);
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["gpt-5.5-panelist", "sonar-pro-panelist"], {
        judgeModel: "auto/claude-opus",
      }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // (a) The judge model MUST be invoked to synthesize, not skipped.
    assert.ok(
      calls.includes("auto/claude-opus"),
      `expected the configured judge to be invoked; calls were: ${calls.join(", ")}`
    );
    // The judge call is the last one — it consumes the panel answer(s).
    assert.equal(calls[calls.length - 1], "auto/claude-opus");

    // (b) The response body reflects the judge's synthesis, not the raw panelist.
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<Record<string, unknown>>;
    };
    assert.equal(json.model, "auto/claude-opus");
    const message = json.choices?.[0]?.message as { content?: string } | undefined;
    assert.equal(message?.content, "JUDGED FINAL");
  });

  test("6455: panel still fans out to every member before degrading (no regression)", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      if (m === "p/a") return jsonResponse(m, "answer-a");
      if (m === "p/b") return jsonResponse(m, "answer-b");
      if (m === "p/judge") return jsonResponse("p/judge", "FUSED");
      throw new Error(`unexpected model ${m}`);
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["p/a", "p/b"], { judgeModel: "p/judge" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.deepEqual(calls.slice(0, 2).sort(), ["p/a", "p/b"]);
    assert.equal(calls[2], "p/judge");
    assert.equal(res.status, 200);
    const json = (await res.json()) as { model?: string };
    assert.equal(json.model, "p/judge");
  });

  test("6455: implicit judge (no judgeModel configured) still short-circuits a lone survivor", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      if (m === "p/ok") return jsonResponse(m, "lone");
      return errResponse(500);
    };

    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["p/ok", "p/bad"]), // no judgeModel — defaults to panel[0]
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // Panel fan-out calls p/ok and p/bad; the lone survivor is then answered
    // directly with the client's original body (not a judge-synthesis turn) —
    // panel[0] IS the implicit judge, so there is nothing to gain by routing
    // it through a separate synthesis call.
    assert.deepEqual(calls, ["p/ok", "p/bad", "p/ok"]);
  });
});

describe("fusion-tools-bypass-6771", () => {
  /**
   * Regression guard for #6771 — fusion combos stripping tools/tool_choice for
   * tool-bearing requests via panel-fan-out-then-judge synthesis.
   *
   * Root cause: panel members answer tool-shaped prompts with no tool access
   * (degraded prose), and the judge's injected synthesis directive ("produce
   * ONE authoritative final answer" from anonymized panel sources) steers even
   * a tools-capable judge away from emitting a real tool call.
   *
   * Fix: detect a tool-bearing request up front (non-empty `tools`, and
   * `tool_choice` not explicitly "none") and bypass the panel fan-out +
   * judge-synthesis path entirely — route the full, unmodified body straight
   * to a single model (the configured judgeModel, or panel[0]).
   */
  type Body = Record<string, unknown>;

  function jsonResponse(model: string, content: string): Response {
    const body = JSON.stringify({
      model,
      choices: [{ message: { role: "assistant", content } }],
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const noop = () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };

  function fusionCombo(models: string[], extra: Record<string, unknown> = {}) {
    return {
      name: "fusion-tools",
      strategy: "fusion",
      models: models.map((m) => ({ model: m })),
      config: extra,
    };
  }

  const TOOLS = [
    {
      type: "function",
      function: { name: "get_weather", description: "Get the weather", parameters: {} },
    },
  ];

  test("6771: tool-bearing request bypasses panel fan-out — single call, tools intact, targets configured judge", async () => {
    const calls: Array<{ model: string; body: Body }> = [];
    const handleSingleModel = async (b: Body, m: string) => {
      calls.push({ model: m, body: b });
      return jsonResponse(m, "tool decision");
    };

    const requestBody: Body = {
      messages: [{ role: "user", content: "what's the weather?" }],
      tools: TOOLS,
      tool_choice: "auto",
    };

    const res = await handleComboChat({
      body: requestBody,
      combo: fusionCombo(["panel/a", "panel/b"], { judgeModel: "judge/model" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // Exactly one call — not once per panel member + once for the judge.
    assert.equal(
      calls.length,
      1,
      `expected exactly 1 call, got: ${calls.map((c) => c.model).join(", ")}`
    );
    assert.equal(calls[0].model, "judge/model");

    // The forwarded body still contains the original tools/tool_choice unmodified.
    assert.deepEqual(calls[0].body.tools, TOOLS);
    assert.equal(calls[0].body.tool_choice, "auto");

    assert.equal(res.status, 200);
  });

  test("6771: tool-bearing request with no explicit judgeModel targets panel[0]", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return jsonResponse(m, "tool decision");
    };

    await handleComboChat({
      body: {
        messages: [{ role: "user", content: "what's the weather?" }],
        tools: TOOLS,
      },
      combo: fusionCombo(["panel/a", "panel/b"]), // no judgeModel — defaults to panel[0]
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.deepEqual(calls, ["panel/a"]);
  });

  test('6771: tools present but tool_choice:"none" still goes through normal fan-out+judge path', async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return jsonResponse(m, "prose answer");
    };

    await handleComboChat({
      body: {
        messages: [{ role: "user", content: "hi" }],
        tools: TOOLS,
        tool_choice: "none",
      },
      combo: fusionCombo(["panel/a", "panel/b"], { judgeModel: "judge/model" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    // panel.length (2) fan-out calls + 1 judge call = 3.
    assert.equal(calls.length, 3, `expected 3 calls (fan-out+judge), got: ${calls.join(", ")}`);
    assert.deepEqual(calls.slice(0, 2).sort(), ["panel/a", "panel/b"]);
    assert.equal(calls[2], "judge/model");
  });

  test("6771: no regression — request without tools still goes through normal fan-out+judge path", async () => {
    const calls: string[] = [];
    const handleSingleModel = async (_b: Body, m: string) => {
      calls.push(m);
      return jsonResponse(m, "prose answer");
    };

    await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      combo: fusionCombo(["panel/a", "panel/b"], { judgeModel: "judge/model" }),
      handleSingleModel,
      log,
      settings: {},
      allCombos: [],
    });

    assert.equal(calls.length, 3, `expected 3 calls (fan-out+judge), got: ${calls.join(", ")}`);
    assert.deepEqual(calls.slice(0, 2).sort(), ["panel/a", "panel/b"]);
    assert.equal(calls[2], "judge/model");
  });
});

describe("fusion-vision-panel-3378", () => {
  // Regression guard for upstream decolua/9router#3378: "Fusion combo sometimes
  // can't see images even when all models support vision".
  //
  // Every non-fusion combo strategy runs the request through
  // filterTargetsByRequestCompatibility (comboStructure.ts) before dispatch, which
  // treats a target whose vision support is not *confirmed* `=== true` (unknown OR
  // false) as vision-incompatible and excludes it (#8332). The fusion dispatch
  // branch (dispatchPrelude.ts::tryFusionDispatch) resolves its panel via the raw
  // resolveComboTargets() and skips that compat filter entirely — so a panel
  // member whose model id is unrecognized by the capability registry (and thus
  // resolves to supportsVision !== true) still receives the unmodified
  // image-bearing body, without any signal that its capability could not be
  // confirmed.
  function createLog() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  }

  function okResponse(content: string) {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }

  function capabilityEntry(overrides: Record<string, unknown> = {}) {
    return {
      tool_call: true,
      reasoning: false,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: false,
      limit_context: 128000,
      limit_input: 128000,
      limit_output: 4096,
      interleaved_field: null,
      ...overrides,
    };
  }

  const imageRequestBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
  };

  beforeEach(async () => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
    await clearModelsDevCapabilities();
  });

  after(async () => {
    resetAllComboMetrics();
    resetAllCircuitBreakers();
    resetAllSemaphores();
    await clearModelsDevCapabilities();
  });

  test(
    "fusion panel must not dispatch an image_url request to a member whose vision " +
      "support cannot be confirmed (#3378)",
    async () => {
      // fusion-vision-a is confirmed vision-capable. fusion-unknown has no
      // capability entry at all (unrecognized id) -> getResolvedModelCapabilities
      // resolves supportsVision to something other than `true`, exactly like the
      // "unknown id silently treated as no vision" failure mode from the upstream
      // report.
      await saveModelsDevCapabilities({
        openai: {
          "fusion-vision-a": capabilityEntry({ attachment: true }),
        },
      });

      const dispatched: string[] = [];
      const result = await handleComboChat({
        body: imageRequestBody,
        combo: {
          name: "fusion-vision-panel-3378",
          strategy: "fusion",
          models: ["openai/fusion-vision-a", "openai/fusion-unknown"],
          config: { judgeModel: "openai/fusion-vision-a" },
        },
        handleSingleModel: async (_body, modelStr) => {
          dispatched.push(modelStr);
          return okResponse(`answer from ${modelStr}`);
        },
        log: createLog(),
        settings: {},
        allCombos: [],
      });

      assert.ok(result.status < 500, "combo call should not hard-fail");
      assert.ok(
        !dispatched.includes("openai/fusion-unknown"),
        "a panel member with unconfirmed vision support must never receive the raw image_url body"
      );
    }
  );
});

describe("repro-6637-kimi-token-limit", () => {
  // Repro probe for issue #6637: combo stops fallback after Kimi total token-limit 400.
  //
  // Observed provider response (Kimi, verbatim from the issue report):
  //   "Invalid request: Your request exceeded model token limit: 262144 (requested: 308458)"
  //
  // combo.ts's #2101 guard (handleComboChat) treats a 400 as a combo-halting
  // "body-specific" error UNLESS isContextOverflow400() or isParamValidation400()
  // recognizes it as a context/param overflow that should fall through to the next
  // combo target. Kimi's exact wording ("... exceeded model token limit ...") does
  // NOT contain the literal word "context", so isContextOverflow400() misses it even
  // though accountFallback.ts's OWN CONTEXT_OVERFLOW_PATTERNS (used one layer below,
  // to decide fallbackResult.shouldFallback) explicitly matches `/\btoken limit\b/i`
  // and `/\bmax.*token/i`. The two classifiers disagree, and the stricter one wins,
  // so the combo halts instead of trying the next (larger-context) target.
  const { isContextOverflow400, isParamValidation400 } = comboModule;

  const KIMI_ERROR_TEXT =
    "Invalid request: Your request exceeded model token limit: 262144 (requested: 308458)";

  test("#6637: Kimi's 'exceeded model token limit' 400 must be classified as context/token overflow (not body-specific)", () => {
    // This is the exact predicate combo.ts checks before deciding to abort the
    // whole combo instead of falling through to the next target (combo.ts ~L2038-2049):
    //   if (status === 400 && fallbackResult.shouldFallback &&
    //       !isContextOverflow400(errorText) && !isParamValidation400(errorText) && ...)
    //     -> "stopping combo"
    //
    // For the fallback to proceed to the next target, at least one of these must be true.
    const isRecognizedAsOverflow =
      isContextOverflow400(KIMI_ERROR_TEXT) || isParamValidation400(KIMI_ERROR_TEXT);

    assert.equal(
      isRecognizedAsOverflow,
      true,
      `Expected Kimi's "exceeded model token limit" 400 to be classified as context/token ` +
        `overflow so combo fallback continues to the next target, but neither ` +
        `isContextOverflow400() nor isParamValidation400() matched it. This causes ` +
        `handleComboChat's #2101 guard to treat it as a body-specific error and halt the ` +
        `whole combo (bug #6637).`
    );
  });
});

describe("repro-8841-context-overflow-opencode", () => {
  const noopLog = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  function largeBody() {
    return {
      messages: [{ role: "user", content: "x".repeat(840_000) }],
      max_tokens: 8192,
    };
  }

  function upstreamContextOverflowResponse() {
    return new Response(
      JSON.stringify({
        error: {
          code: "context_length_exceeded",
          message:
            "Input exceeds the context window for opencode/mimo-v2.5-free: estimated 210724 input tokens, limit 200000. Reduce the prompt or route to a model with a larger context window.",
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  test("#8841 advertised vs compat-filter limit agree", async () => {
    const advertised = await getTokenLimit("opencode-zen", "mimo-v2.5-free");
    const caps = await getResolvedModelCapabilities("opencode/mimo-v2.5-free");
    assert.ok(advertised > 0);
    assert.ok(
      caps.contextWindow != null && caps.contextWindow > 0,
      `contextWindow known (got ${caps.contextWindow})`
    );
  });

  test("#8841 real upstream context overflow remains a fatal 400 after dispatch", async () => {
    const body = largeBody();
    let dispatches = 0;
    const result = await handleComboChat({
      body,
      combo: {
        name: "pro-coding-repro-8841",
        strategy: "priority",
        models: [
          { model: "opencode/north-mini-code-free" },
          { model: "opencode/north-mini-code-free" },
        ],
      },
      handleSingleModel: async () => {
        dispatches += 1;
        return upstreamContextOverflowResponse();
      },
      log: noopLog,
      settings: {},
      allCombos: [],
    });

    assert.equal(dispatches, 1, "real upstream overflow must short-circuit fallback");
    assert.equal(result.status, 400);
    const json = await result.json();
    assert.equal(json.error?.code, "context_length_exceeded");
  });
});

describe("output-limit-advisory-setting", () => {
  /**
   * The output-limit advisory is the only supported way to keep combo targets whose
   * known output ceiling sits below the request's max_tokens. The combo resolver has
   * read it from three places for a while -- the per-combo config, the round-robin
   * config, and the global settings row -- but only the per-combo copy could be set
   * from the dashboard, so an operator with a dozen combos had to edit every one.
   *
   * It lives in settings now, which means it needs a schema entry or the settings API
   * strips it, and a declared default or the resolver sees undefined.
   */
  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

  before(async () => {
    await resetTestDb();
  });

  after(async () => {
    await clearModelsDevCapabilities();
    await updateSettings({ outputLimitAdvisory: false });
  });

  function capabilityEntry(limitOutput: number) {
    return {
      tool_call: true,
      reasoning: false,
      attachment: false,
      structured_output: true,
      temperature: true,
      modalities_input: JSON.stringify(["text"]),
      modalities_output: JSON.stringify(["text"]),
      knowledge_cutoff: null,
      release_date: null,
      last_updated: null,
      status: null,
      family: null,
      open_weights: false,
      limit_context: 128_000,
      limit_input: 128_000,
      limit_output: limitOutput,
      interleaved_field: null,
    };
  }

  test("outputLimitAdvisory is off unless an operator turns it on", async () => {
    const settings = await getSettings();
    assert.equal(settings.outputLimitAdvisory, false);
  });

  test("the schema accepts outputLimitAdvisory as a boolean and keeps its neighbours", () => {
    const parsed = updateSettingsSchema.parse({ outputLimitAdvisory: true, theme: "dark" });
    assert.equal(parsed.outputLimitAdvisory, true);
    assert.equal(parsed.theme, "dark");
  });

  test("the schema rejects a non-boolean advisory instead of coercing it", () => {
    assert.equal(updateSettingsSchema.safeParse({ outputLimitAdvisory: "yes" }).success, false);
  });

  test("turning it on through updateSettings is visible to the combo resolver", async () => {
    await updateSettings({ outputLimitAdvisory: true });
    const settings = await getSettings();
    assert.equal(settings.outputLimitAdvisory, true);

    await updateSettings({ outputLimitAdvisory: false });
    const restored = await getSettings();
    assert.equal(restored.outputLimitAdvisory, false);
  });

  test("a combo with no advisory in its own config honours the global setting", async () => {
    await saveModelsDevCapabilities({
      // Separate providers: a 503 from one provider must not skip the other.
      "unit-global-advisory-a": { insufficient: capabilityEntry(128) },
      "unit-global-advisory-b": { sufficient: capabilityEntry(4_096) },
    });
    const run = async () => {
      const calls: string[] = [];
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "hello" }], max_tokens: 512 },
        combo: {
          name: "global-output-limit-advisory",
          strategy: "priority",
          models: ["unit-global-advisory-a/insufficient", "unit-global-advisory-b/sufficient"],
        },
        // Same source the chat handler passes to handleComboChat.
        settings: await getSettings(),
        handleSingleModel: async (_body: Record<string, unknown>, modelStr: string) => {
          calls.push(modelStr);
          const ok = modelStr.endsWith("/insufficient");
          return new Response(
            JSON.stringify(ok ? { choices: [{ message: { content: "ok" } }] } : { error: "down" }),
            { status: ok ? 200 : 503, headers: { "Content-Type": "application/json" } }
          );
        },
        log: noopLog,
      });
      return { status: response.status, calls };
    };

    await updateSettings({ outputLimitAdvisory: false });
    const strict = await run();
    assert.notEqual(strict.status, 200);
    assert.ok(!strict.calls.includes("unit-global-advisory-a/insufficient"));

    await updateSettings({ outputLimitAdvisory: true });
    try {
      const advisory = await run();
      assert.equal(advisory.status, 200);
      assert.deepEqual(advisory.calls, ["unit-global-advisory-a/insufficient"]);
    } finally {
      await updateSettings({ outputLimitAdvisory: false });
    }
  });
});
