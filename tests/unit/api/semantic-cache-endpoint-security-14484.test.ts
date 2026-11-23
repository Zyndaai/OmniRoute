import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omni-cache-endpoint-14484-"));
process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS = "true";
process.env.OUTBOUND_SSRF_GUARD_ENABLED = "true";

const { createDefaultEmbeddingGenerator } =
  await import("../../../open-sse/services/cache/embeddingClient.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { POST } = await import("../../../src/app/api/settings/cache-config/test-embedding/route.ts");
const { PUT } = await import("../../../src/app/api/settings/cache-config/route.ts");
const { resolveSemanticCacheConfig } = await import("../../../open-sse/config/semanticCacheConfig.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { setConfigValue } = await import("../../../src/lib/db/configEntries.ts");
const { encryptCacheValue } = await import("../../../src/lib/db/cacheSecrets.ts");
const { ensureSemanticCacheDbBridge, refreshSemanticCacheDbBridge } =
  await import("../../../src/lib/cache/semanticCacheDbBridge.ts");

test.after(() => resetDbInstance());

/** Writes cache settings the way the cache-config route does, then refreshes the resolver snapshot. */
async function setCacheSettings(cache: Record<string, unknown>) {
  await ensureSemanticCacheDbBridge();
  for (const [key, value] of Object.entries(cache)) {
    await setConfigValue("databaseSettings", `cache.${key}`, encryptCacheValue(key, value));
  }
  await refreshSemanticCacheDbBridge();
}

function request(body: unknown, method = "POST") {
  return new Request("http://localhost/api/settings/cache-config/test-embedding", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("embedding generator blocks metadata before sending credentials", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: [{ embedding: [1, 0] }] });
  });
  for (const embeddingBaseUrl of [
    "http://169.254.169.254/latest",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://[::ffff:169.254.169.254]/",
  ]) {
    const generator = createDefaultEmbeddingGenerator({
      embeddingBaseUrl,
      embeddingApiKey: "fixture-only-provider-secret",
    });
    assert.equal(await generator("hello"), null);
  }
  assert.equal(calls, 0);
});

test("configured LAN embeddings work without following redirects", async (t) => {
  let redirect: RequestRedirect | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    redirect = init?.redirect;
    return Response.json({ data: [{ embedding: [1, 0] }] });
  });
  const generator = createDefaultEmbeddingGenerator({ embeddingBaseUrl: "http://127.0.0.1:12345" });
  assert.deepEqual((await generator("hello"))?.embedding, [1, 0]);
  assert.equal(redirect, "manual");
});

test("strict provider policy blocks LAN embeddings", async (t) => {
  const previous = process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS;
  process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS = "false";
  t.after(() => {
    process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS = previous;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ data: [{ embedding: [1, 0] }] });
  });
  assert.equal(
    await createDefaultEmbeddingGenerator({ embeddingBaseUrl: "http://127.0.0.1:12345" })("hello"),
    null
  );
  assert.equal(calls, 0);
});

test("test endpoint never transfers a stored connection key to an overridden endpoint", async (t) => {
  await createProviderConnection({
    provider: "fixture-14484",
    authType: "apikey",
    name: "fixture",
    apiKey: "fixture-only-stored-connection-key",
    isActive: true,
    providerSpecificData: { baseUrl: "http://127.0.0.1:12345/v1" },
  });
  let authorization: string | null = null;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("Authorization");
    return Response.json({ data: [{ embedding: [1, 0] }] });
  });
  const response = await POST(
    request({ provider: "fixture-14484", model: "embed", baseUrl: "http://127.0.0.2:12345/v1" })
  );
  assert.equal(response.status, 200);
  assert.equal(authorization, null);
  await POST(request({ provider: "fixture-14484", model: "embed" }));
  assert.equal(authorization, "Bearer fixture-only-stored-connection-key");
  await setCacheSettings({
    semanticCacheEmbeddingProvider: "fixture-14484",
    semanticCacheEmbeddingBaseUrl: "http://127.0.0.2:12345/v1",
  });
  assert.equal(resolveSemanticCacheConfig().embeddingApiKey, undefined);
});

test("PUT rejects metadata embedding endpoints before persistence", async () => {
  const response = await PUT(
    request({ semanticCacheEmbeddingBaseUrl: "http://169.254.169.254/" }, "PUT") as never
  );
  assert.equal(response.status, 400);
});
