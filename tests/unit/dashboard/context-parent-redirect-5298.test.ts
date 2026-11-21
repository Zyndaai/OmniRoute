import test from "node:test";
import assert from "node:assert/strict";

// #5298: `/dashboard/context` had only sub-routes and no parent page, so the bare parent
// 404'd. The parent page redirects to a canonical sub-route; this guards the pure route resolver
// it uses and the loader that applies it.
const { resolveContextRoute } =
  await import("../../../src/app/(dashboard)/dashboard/context/resolveContextRoute.ts");
const { loader } = await import("../../../src/app/(dashboard)/dashboard/context/page.tsx");

test("#5298: resolveContextRoute defaults the bare parent to the canonical sub-route", () => {
  assert.equal(resolveContextRoute(undefined), "/dashboard/context/settings");
  assert.equal(resolveContextRoute(""), "/dashboard/context/settings");
});

test("#5298: resolveContextRoute maps a known tab to its sub-route", () => {
  assert.equal(resolveContextRoute("ultra"), "/dashboard/context/ultra");
  assert.equal(resolveContextRoute("session-dedup"), "/dashboard/context/session-dedup");
});

test("#5298: resolveContextRoute sends the removed llmlingua tab to the default", () => {
  assert.equal(resolveContextRoute("llmlingua"), "/dashboard/context/settings");
});

test("#5298: resolveContextRoute falls back to the default for an unknown tab", () => {
  assert.equal(resolveContextRoute("bogus"), "/dashboard/context/settings");
});

test("#5298: the loader redirects the parent to the sub-route named by ?tab=", () => {
  for (const [url, location] of [
    ["http://localhost/dashboard/context", "/dashboard/context/settings"],
    ["http://localhost/dashboard/context?tab=ultra", "/dashboard/context/ultra"],
    ["http://localhost/dashboard/context?tab=bogus", "/dashboard/context/settings"],
  ]) {
    let thrown: unknown;
    try {
      loader({ request: new Request(url) });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Response);
    assert.equal(thrown.status, 307);
    assert.equal(thrown.headers.get("Location"), location);
  }
});
