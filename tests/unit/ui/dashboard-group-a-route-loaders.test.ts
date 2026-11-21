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
  const status = (params: { kind: string; id: string }) =>
    (thrown(() => loader({ params })) as { init?: { status?: number } }).init?.status;
  assert.equal(status({ kind: "nope", id: "openai" }), 404);
  assert.equal(status({ kind: "embedding", id: "no-such-provider" }), 404);

  const { loader: listLoader } = await import(`${base}/media-providers/[kind]/page.tsx`);
  const listed = listLoader({ params: { kind: "embedding" } }).providers[0].id;
  const detail = loader({ params: { kind: "embedding", id: listed } });
  assert.equal(detail.provider.id, listed);
  assert.equal(detail.kind, "embedding");
});

test("cli-code and cli-agents detail pages 404 on a tool of the other category", async () => {
  const code = await import(`${base}/cli-code/[id]/page.tsx`);
  const agents = await import(`${base}/cli-agents/[id]/page.tsx`);
  const status = (fn: () => unknown) => (thrown(fn) as { init?: { status?: number } }).init?.status;

  assert.deepEqual(code.loader({ params: { id: "claude" } }), { id: "claude" });
  assert.equal(
    status(() => code.loader({ params: { id: "hermes-agent" } })),
    404
  );
  assert.equal(
    status(() => code.loader({ params: { id: "invalid-id-xyz" } })),
    404
  );

  assert.deepEqual(agents.loader({ params: { id: "hermes-agent" } }), { id: "hermes-agent" });
  assert.equal(
    status(() => agents.loader({ params: { id: "claude" } })),
    404
  );
});
