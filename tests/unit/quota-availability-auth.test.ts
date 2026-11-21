import assert from "node:assert/strict";
import { test } from "node:test";
import { updateSettings } from "../../src/lib/db/settings.ts";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { isAuthzPath } from "../../src/server/http/authzPaths.ts";
import { createAppHandler } from "../../src/server/http/handler.ts";

const handle = createAppHandler({ basePath: () => "", render: async () => new Response(null) });

test("central pipeline rejects anonymous availability and provider-limits management GETs", async () => {
  await updateSettings({ requireLogin: true });
  for (const path of ["/api/usage/availability", "/api/usage/provider-limits"]) {
    assert.equal(isAuthzPath(path), true);
    assert.equal(classifyRoute(path, "GET").routeClass, "MANAGEMENT");
    const response = await handle(
      new Request(`http://synthetic.example.test${path}`, { method: "GET" })
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-omniroute-route-class"), "MANAGEMENT");
    assert.equal((await response.json()).error.code, "AUTH_001");
  }
});
