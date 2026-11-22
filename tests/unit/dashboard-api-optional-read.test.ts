/**
 * `apiJsonOrNull()` is the loader helper for reads a page can do without: a failed read falls
 * back to a default instead of the route error boundary, but an expired session still goes to
 * the login page.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { runWithIncoming } = await import("../../src/server/requestContext.ts");
const { apiJsonOrNull, apiRead } = await import("../../src/server/routing/dashboardApi.server.ts");

function readWith(response: Response, basePath = "") {
  const seen: Request[] = [];
  const incoming = {
    request: new Request("http://omniroute.test/dashboard/combos", {
      headers: { cookie: "auth_token=abc" },
    }),
    basePath,
    fetch: async (request: Request) => {
      seen.push(request);
      return response;
    },
  };
  return {
    seen,
    run: () => runWithIncoming(incoming, () => apiJsonOrNull("/api/combos/metrics")),
  };
}

test("a successful read returns the JSON body", async () => {
  const { run, seen } = readWith(Response.json({ metrics: { a: 1 } }));
  assert.deepEqual(await run(), { metrics: { a: 1 } });
  assert.equal(new URL(seen[0].url).pathname, "/api/combos/metrics");
  assert.equal(seen[0].headers.get("cookie"), "auth_token=abc");
});

test("an error other than 401 returns null", async () => {
  for (const status of [403, 404, 500, 503]) {
    const { run } = readWith(Response.json({ error: "nope" }, { status }));
    assert.equal(await run(), null, `status ${status}`);
  }
});

test("an empty successful body returns null", async () => {
  const { run } = readWith(new Response(null, { status: 200 }));
  assert.equal(await run(), null);
});

test("apiRead keeps the status of a failed read and the body of a successful one", async () => {
  const fail = readWith(Response.json({ error: "down" }, { status: 503 }));
  const failed = await runWithIncoming(
    {
      request: new Request("http://omniroute.test/dashboard"),
      basePath: "",
      fetch: async () => Response.json({ error: "down" }, { status: 503 }),
    },
    () => apiRead("/api/provider-stats")
  );
  assert.deepEqual(failed, { ok: false, status: 503 });
  assert.equal(await fail.run(), null);

  const succeeded = await runWithIncoming(
    {
      request: new Request("http://omniroute.test/dashboard"),
      basePath: "",
      fetch: async () => Response.json({ providers: [] }),
    },
    () => apiRead("/api/provider-stats")
  );
  assert.deepEqual(succeeded, { ok: true, status: 200, data: { providers: [] } });
});

test("a 401 throws the login redirect, under the base path", async () => {
  const { run } = readWith(Response.json({ error: "unauthorized" }, { status: 401 }), "/omni");
  await assert.rejects(run(), (thrown: unknown) => {
    assert.ok(thrown instanceof Response);
    assert.equal(thrown.status, 302);
    assert.equal(thrown.headers.get("location"), "/omni/login");
    return true;
  });
});
