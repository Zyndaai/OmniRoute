import test from "node:test";
import assert from "node:assert";
import { tencent_aistudio_webProvider } from "../../../open-sse/config/providers/registry/tencent-aistudio-web/index.ts";
import executor from "../../../open-sse/executors/tencent-aistudio-web.ts";

test("tencent-aistudio-web is registered with the expected id, alias, format and models", () => {
  assert.strictEqual(tencent_aistudio_webProvider.id, "tencent-aistudio-web");
  assert.strictEqual(tencent_aistudio_webProvider.alias, "tasw");
  assert.strictEqual(tencent_aistudio_webProvider.format, "openai");
  assert.strictEqual(tencent_aistudio_webProvider.executor, "tencent-aistudio-web");
  assert(tencent_aistudio_webProvider.models.length > 0);

  const modelIds = tencent_aistudio_webProvider.models.map((m) => m.id);
  assert(modelIds.includes("hy3-g"));
});

test("tencent-aistudio-web executor returns 401 when the cookie is missing", async () => {
  const input = {
    model: "hy3-g",
    body: { model: "hy3-g", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: { apiKey: "" },
  } as unknown as Parameters<typeof executor.execute>[0];

  const res = await executor.execute(input);
  assert.strictEqual(res.response.status, 401);
  const data = await res.response.json();
  assert(data.error.message.includes("Cookie"));
});
