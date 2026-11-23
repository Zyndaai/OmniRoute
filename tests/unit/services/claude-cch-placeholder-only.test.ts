import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { signRequestBody } from "../../../open-sse/services/claudeCodeCCH.ts";

const BILLING = "x-anthropic-billing-header: cc_version=2.1.0.abc; cc_entrypoint=cli; cch=00000;";

describe("signRequestBody only rewrites the billing placeholder", () => {
  it("leaves user text containing cch=xxxxx; untouched and signs the billing header", async () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "my token is cch=abcde; keep it" }],
      system: [{ type: "text", text: BILLING }],
    });
    const signed = await signRequestBody(body);
    assert.ok(signed.includes("cch=abcde; keep it"), "user text must be unchanged");
    assert.ok(!signed.includes("cch=00000;"), "billing placeholder must be signed");
    assert.match(signed, /cc_entrypoint=cli; cch=[0-9a-f]{5};/);
  });

  it("does not sign a placeholder that appears only in user text", async () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: '"text":"x-anthropic-billing-header cch=00000;' },
      ],
      system: "plain",
    });
    assert.equal(await signRequestBody(body), body);
  });

  it("signs the legacy top-level billing key", async () => {
    const body = `{"x-anthropic-billing-header":"cc_version=1.abc; cch=00000;","model":"claude"}`;
    const signed = await signRequestBody(body);
    assert.ok(!signed.includes("cch=00000;"));
    assert.match(signed, /cch=[0-9a-f]{5};/);
  });
});
