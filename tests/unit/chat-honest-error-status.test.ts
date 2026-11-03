/**
 * A server-to-server client treats 401 as "my API key is bad". Chat must
 * therefore keep 401 for the caller key only and report the other no-credential
 * cases honestly for NON-combo requests:
 *   - unknown provider prefix           -> 404 model_not_found
 *   - known provider, no account        -> 503 provider_not_configured
 * Combo routing keeps its internal 404 fall-through so a dead leg is skipped.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("honest-error-status");
const { buildOpenAIResponse, buildRequest, combosDb, handleChat, resetStorage, seedConnection } =
  harness;

type ErrorBody = { error?: { message?: string; code?: string; type?: string } };

function chatBody(model: string) {
  return { model, stream: false, messages: [{ role: "user", content: "Hello" }] };
}

test.beforeEach(async () => {
  process.env.REQUIRE_API_KEY = "false";
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

test("non-combo: unknown provider prefix returns 404 model_not_found", async () => {
  const response = await handleChat(buildRequest({ body: chatBody("nosuch/model-xyz") }));
  const json = (await response.json()) as ErrorBody;

  assert.equal(response.status, 404);
  assert.equal(json.error?.code, "model_not_found");
  assert.equal(json.error?.type, "invalid_request_error");
});

test("non-combo: known provider without an account returns 503 provider_not_configured", async () => {
  const response = await handleChat(buildRequest({ body: chatBody("zai/glm-5.3-flash") }));
  const json = (await response.json()) as ErrorBody;

  assert.equal(response.status, 503);
  assert.equal(json.error?.code, "provider_not_configured");
  assert.match(json.error?.message ?? "", /No active credentials for provider: /);
});

test("combo: a leg with no account or an unknown provider still falls through to the next target", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-honest-status" });
  await combosDb.createCombo({
    name: "honest-status-combo",
    strategy: "priority",
    config: { maxRetries: 0, retryDelayMs: 0 },
    models: ["zai/glm-5.3-flash", "nosuch/model-xyz", "openai/gpt-4o-mini"],
  });
  globalThis.fetch = async () => buildOpenAIResponse("served by the third leg");

  const response = await handleChat(buildRequest({ body: chatBody("honest-status-combo") }));
  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };

  assert.equal(response.status, 200);
  assert.equal(json.choices?.[0]?.message?.content, "served by the third leg");
});
