import test from "node:test";
import assert from "node:assert/strict";

// Server-side behaviour of the converted dashboard pages (redirects and not-found conditions).

const base = "../../../src/app/(dashboard)/dashboard";

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected the loader to throw");
}

test("limits, auto-combo and media-providers redirect with 307", async () => {
  const cases: Array<[string, string]> = [
    [`${base}/limits/page.tsx`, "/dashboard/quota"],
    [`${base}/auto-combo/page.tsx`, "/dashboard/combos?filter=intelligent"],
    [`${base}/media-providers/page.tsx`, "/dashboard/media-providers/embedding"],
  ];
  for (const [path, target] of cases) {
    const { loader } = await import(path);
    const response = thrown(() => loader()) as Response;
    assert.equal(response.status, 307, path);
    assert.equal(response.headers.get("Location"), target, path);
  }
});

test("media provider kind page: 404 for an unknown kind, provider list for a known one", async () => {
  const { loader } = await import(`${base}/media-providers/[kind]/page.tsx`);
  const missing = thrown(() => loader({ params: { kind: "nope" } })) as {
    init?: { status?: number };
  };
  assert.equal(missing.init?.status, 404);

  const result = loader({ params: { kind: "embedding" } });
  assert.equal(result.kind, "embedding");
  assert.ok(result.providers.length > 0);
  assert.deepEqual(Object.keys(result.providers[0]).sort(), ["color", "hasFree", "id", "name"]);
});

test("media provider page: 404 for unknown kind, unknown provider and a kind the provider lacks", async () => {
  const { loader } = await import(`${base}/media-providers/[kind]/[id]/page.tsx`);
  const status = async (params: { kind: string; id: string }) => {
    try {
      await loader({ params });
    } catch (error) {
      return (error as { init?: { status?: number } }).init?.status;
    }
    assert.fail("expected the loader to throw");
  };
  assert.equal(await status({ kind: "nope", id: "openai" }), 404);
  assert.equal(await status({ kind: "embedding", id: "no-such-provider" }), 404);

  // A valid page also lists the provider's connections, read through /api/providers.
  const { loader: listLoader } = await import(`${base}/media-providers/[kind]/page.tsx`);
  const listed = listLoader({ params: { kind: "embedding" } }).providers[0].id;
  const { runWithIncoming } = await import("../../../src/server/requestContext.ts");
  const requested: string[] = [];
  const detail = await runWithIncoming(
    {
      request: new Request("http://omniroute.test/dashboard/media-providers/embedding/x"),
      basePath: "",
      fetch: async (request: Request) => {
        requested.push(new URL(request.url).pathname + new URL(request.url).search);
        return Response.json({
          connections: [
            { id: "c1", name: "Mine", testStatus: "active", isActive: true, provider: listed },
            { id: "c2", name: "Other", testStatus: "active", isActive: true, provider: "zzz" },
          ],
        });
      },
    },
    () => loader({ params: { kind: "embedding", id: listed } })
  );
  assert.equal(detail.provider.id, listed);
  assert.equal(detail.kind, "embedding");
  assert.deepEqual(requested, [`/api/providers?provider=${encodeURIComponent(listed)}`]);
  assert.deepEqual(detail.connections, [
    { id: "c1", name: "Mine", testStatus: "active", isActive: true },
  ]);
});

test("cli-code and cli-agents detail pages 404 on a tool of the other category", async () => {
  const code = await import(`${base}/cli-code/[id]/page.tsx`);
  const agents = await import(`${base}/cli-agents/[id]/page.tsx`);
  const { runWithIncoming } = await import("../../../src/server/requestContext.ts");
  const requested: string[] = [];
  const run = <T>(fn: () => Promise<T>) =>
    runWithIncoming(
      {
        request: new Request("http://omniroute.test/dashboard/cli-code/x"),
        basePath: "",
        fetch: async (request: Request) => {
          const { pathname } = new URL(request.url);
          requested.push(pathname);
          if (pathname === "/api/providers") return Response.json({ connections: [{ id: "c1" }] });
          if (pathname === "/api/cli-tools/keys") return Response.json({ keys: [{ id: "k1" }] });
          // Settings fail: the page falls back to cloudEnabled = false.
          return Response.json({ error: "boom" }, { status: 500 });
        },
      },
      fn
    );
  const status = async (fn: () => Promise<unknown>) => {
    try {
      await run(fn);
    } catch (error) {
      return (error as { init?: { status?: number } }).init?.status;
    }
    assert.fail("expected the loader to throw");
  };

  assert.deepEqual(await run(() => code.loader({ params: { id: "claude" } })), {
    id: "claude",
    connections: [{ id: "c1" }],
    apiKeys: [{ id: "k1" }],
    cloudEnabled: false,
  });
  assert.deepEqual(requested.sort(), ["/api/cli-tools/keys", "/api/providers", "/api/settings"]);
  assert.equal(await status(() => code.loader({ params: { id: "hermes-agent" } })), 404);
  assert.equal(await status(() => code.loader({ params: { id: "invalid-id-xyz" } })), 404);

  assert.equal(
    ((await run(() => agents.loader({ params: { id: "hermes-agent" } }))) as { id: string }).id,
    "hermes-agent"
  );
  assert.equal(await status(() => agents.loader({ params: { id: "claude" } })), 404);
});
