import test from "node:test";
import assert from "node:assert/strict";

import type { loader as ListLoader } from "../../../src/app/(dashboard)/dashboard/providers/page.tsx";
import type { loader as DetailLoader } from "../../../src/app/(dashboard)/dashboard/providers/[id]/page.tsx";

// The providers pages read their first-paint data in route loaders (through the API routes).

const base = "../../../src/app/(dashboard)/dashboard/providers";

async function withApi<T>(
  routes: Record<string, () => Response>,
  run: () => Promise<T>
): Promise<{ result: T; requested: string[] }> {
  const { runWithIncoming } = await import("../../../src/server/requestContext.ts");
  const requested: string[] = [];
  const result = await runWithIncoming(
    {
      request: new Request("http://omniroute.test/dashboard/providers"),
      basePath: "",
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        requested.push(url.pathname + url.search);
        const route = routes[url.pathname];
        return route ? route() : Response.json({ error: "nope" }, { status: 500 });
      },
    },
    run
  );
  return { result, requested };
}

test("providers list loader projects connections and degrades failing reads", async () => {
  const { loader } = await import(`${base}/page.tsx`);
  const { result } = await withApi(
    {
      "/api/providers": () =>
        Response.json({
          connections: [
            {
              id: "c1",
              provider: "openai",
              authType: "apikey",
              name: "Main",
              isActive: true,
              testStatus: "active",
              apiKey: "sk-secret",
              providerSpecificData: { baseUrl: "https://x", apiKeyHealth: {}, secret: "s" },
            },
          ],
        }),
      "/api/provider-nodes": () =>
        Response.json({
          nodes: [{ id: "n1", name: "N", type: "openai-compatible", apiKey: "k" }],
          ccCompatibleProviderEnabled: true,
        }),
      "/api/settings": () =>
        Response.json({ blockedProviders: ["a"], codexServiceTier: { enabled: true } }),
      // expiration, env repair and deprecated fail with 500
    },
    () => loader() as ReturnType<typeof ListLoader>
  );
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0].apiKey, undefined);
  assert.equal(result.connections[0].providerSpecificData.secret, undefined);
  assert.equal(result.connections[0].providerSpecificData.baseUrl, "https://x");
  assert.equal(result.providerNodes[0].apiKey, undefined);
  assert.equal(result.ccCompatibleProviderEnabled, true);
  assert.deepEqual(result.blockedProviders, ["a"]);
  assert.equal(result.codexGlobalServiceMode, "priority");
  assert.deepEqual(result.expirationList, []);
  assert.equal(result.expirationSummary, null);
  assert.equal(result.oauthEnvRepairStatus, null);
  assert.deepEqual(result.deprecatedLeftovers, []);
});

test("providers list loader keeps the expiration summary the banner renders", async () => {
  const { loader } = await import(`${base}/page.tsx`);
  const { result } = await withApi(
    {
      "/api/providers/expiration": () =>
        Response.json({
          list: [{ provider: "codex", status: "expired", connectionId: "c1" }],
          summary: { expired: 1, expiringSoon: 2, ok: 5 },
        }),
    },
    () => loader() as ReturnType<typeof ListLoader>
  );
  assert.deepEqual(result.expirationList, [{ provider: "codex", status: "expired" }]);
  assert.deepEqual(result.expirationSummary, { expired: 1, expiringSoon: 2 });
});

test("provider detail loader reads this provider's connections and node", async () => {
  const { loader } = await import(`${base}/[id]/page.tsx`);
  const { result, requested } = await withApi(
    {
      "/api/providers": () =>
        Response.json({
          connections: [
            { id: "c1", provider: "groq" },
            { id: "c2", provider: "other" },
          ],
        }),
      "/api/provider-nodes": () => Response.json({ nodes: [{ id: "groq" }] }),
    },
    () => loader({ params: { id: "groq" } }) as ReturnType<typeof DetailLoader>
  );
  assert.deepEqual(
    result.connections?.map((c: { id: string }) => c.id),
    ["c1"]
  );
  assert.equal(result.nodeResolved, true);
  assert.ok(requested.includes("/api/providers?provider=groq"));
});

test("provider detail loader keeps the page alive when the reads fail", async () => {
  const { loader } = await import(`${base}/[id]/page.tsx`);
  const { result } = await withApi(
    {},
    () => loader({ params: { id: "groq" } }) as ReturnType<typeof DetailLoader>
  );
  assert.equal(result.connections, null);
  assert.equal(result.nodeResolved, false);
});

test("new provider loader defaults the Claude Code option to off", async () => {
  const { loader } = await import(`${base}/new/page.tsx`);
  const { result } = await withApi({}, () => loader());
  assert.deepEqual(result, { ccCompatibleProviderEnabled: false });
});
