import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const upstreamProxyDb = await import("../../../src/lib/db/upstreamProxy.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

describe("db/upstreamProxy (module coverage)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  after(async () => {
    await resetTestDb();
  });

  it("validates proxy URLs and blocks unsupported or private destinations", async () => {
    assert.deepEqual(upstreamProxyDb.validateProxyUrl("https://proxy.example.com"), {
      valid: true,
      url: "https://proxy.example.com",
    });
    assert.equal(upstreamProxyDb.validateProxyUrl("ftp://proxy.example.com").valid, false);
    assert.match(
      upstreamProxyDb.validateProxyUrl("http://169.254.169.254").error,
      /private\/internal address/
    );
    assert.match(upstreamProxyDb.validateProxyUrl("not-a-url").error, /Invalid URL/);
  });

  it("round-trips configs through upsert, update, mode filters and fallback ordering", async () => {
    await upstreamProxyDb.upsertUpstreamProxyConfig({
      providerId: "claude",
      mode: "fallback",
      cliproxyapiModelMapping: { "claude-4": "claude-4-cli" },
      nativePriority: 10,
      cliproxyapiPriority: 1,
    });
    await upstreamProxyDb.upsertUpstreamProxyConfig({
      providerId: "openai",
      mode: "native",
      enabled: false,
    });

    const loaded = await upstreamProxyDb.getUpstreamProxyConfig("claude");
    assert.deepEqual(loaded.cliproxyapiModelMapping, { "claude-4": "claude-4-cli" });

    const updated = await upstreamProxyDb.updateUpstreamProxyConfig("claude", {
      mode: "cliproxyapi",
      cliproxyapiModelMapping: null,
      enabled: true,
    });
    assert.equal(updated.mode, "cliproxyapi");
    assert.equal(updated.cliproxyapiModelMapping, null);

    const byMode = await upstreamProxyDb.getProvidersByMode("cliproxyapi");
    assert.equal(byMode.length, 1);
    assert.equal(byMode[0].providerId, "claude");

    const chain = await upstreamProxyDb.getFallbackChainForProvider("claude");
    assert.deepEqual(chain, [
      { executor: "cliproxyapi", priority: 1 },
      { executor: "native", priority: 10 },
    ]);
  });

  it("handles invalid stored JSON, missing rows and deletion", async () => {
    // The mapping column is jsonb, so raw text cannot be stored; a JSON string scalar that
    // is not a JSON object is the closest stored shape the reader must still survive.
    await getTestBackend().execute(
      `INSERT INTO upstream_proxy_config
       (provider_id, mode, cliproxyapi_model_mapping, native_priority, cliproxyapi_priority, enabled)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      ["broken", "fallback", JSON.stringify("{not-json"), 1, 2, true]
    );

    const broken = await upstreamProxyDb.getUpstreamProxyConfig("broken");
    assert.equal(broken.cliproxyapiModelMapping, null);

    await assert.rejects(
      upstreamProxyDb.updateUpstreamProxyConfig("ghost", { mode: "native" }),
      /Provider ghost not found/
    );

    assert.equal(await upstreamProxyDb.deleteUpstreamProxyConfig("broken"), true);
    assert.equal(await upstreamProxyDb.deleteUpstreamProxyConfig("broken"), false);
    assert.deepEqual(await upstreamProxyDb.getFallbackChainForProvider("ghost"), []);
  });
});
