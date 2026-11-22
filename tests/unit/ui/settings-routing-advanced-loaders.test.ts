import test from "node:test";
import assert from "node:assert/strict";

// The settings routing/advanced pages read through their route loaders (one projected
// /api/settings read each) and degrade per read.

const base = "../../../src/app/(dashboard)/dashboard/settings";

async function runLoader(
  path: string,
  answer: (pathname: string) => Response
): // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the loader result is inspected loosely
Promise<{ data: Record<string, any>; requested: string[] }> {
  const { loader } = await import(`${base}/${path}/page.tsx`);
  const { runWithIncoming } = await import("../../../src/server/requestContext.ts");
  const requested: string[] = [];
  const data = await runWithIncoming(
    {
      request: new Request(`http://omniroute.test/dashboard/settings/${path}`),
      basePath: "",
      fetch: async (request: Request) => {
        const { pathname } = new URL(request.url);
        requested.push(pathname);
        return answer(pathname);
      },
    },
    () => loader()
  );
  return { data, requested };
}

test("advanced loader: one settings read, projected to the fields the cards use", async () => {
  const { data, requested } = await runLoader("advanced", (pathname) =>
    pathname === "/api/settings"
      ? Response.json({
          debugMode: true,
          logToolSources: false,
          maxBodySizeMb: 12,
          cliproxyapi_url: "http://x:1",
          headroomUrl: "http://h:2",
          password: "must-not-leak",
        })
      : Response.json({ default: [], override: [], filter: [], defaultRaw: [] })
  );
  assert.deepEqual(requested.sort(), ["/api/settings", "/api/settings/payload-rules"]);
  assert.equal(data.debugMode, true);
  assert.equal(data.logToolSources, false);
  assert.deepEqual(data.requestLimits, { maxBodySizeMb: 12 });
  assert.equal(data.cliproxyapi.cliproxyapi_url, "http://x:1");
  assert.deepEqual(data.headroom, { headroomUrl: "http://h:2" });
  assert.ok(!JSON.stringify(data).includes("must-not-leak"));
});

test("advanced loader: a failed settings read leaves every card to its own client fetch", async () => {
  const { data } = await runLoader("advanced", () =>
    Response.json({ error: "x" }, { status: 500 })
  );
  assert.equal(data.debugMode, null);
  assert.equal(data.logToolSources, null);
  assert.equal(data.requestLimits, null);
  assert.equal(data.cliproxyapi, null);
  assert.equal(data.headroom, null);
  assert.equal(data.payloadRules, null);
});

test("routing loader: shared settings projection, provider names, silent defaults", async () => {
  const { data, requested } = await runLoader("routing", (pathname) => {
    switch (pathname) {
      case "/api/settings":
        return Response.json({
          fallbackStrategy: "round-robin",
          hideAutoCombos: true,
          wildcardAliases: [{ pattern: "a*", target: "b" }],
          jwtSecret: "must-not-leak",
        });
      case "/api/settings/combo-defaults":
        return Response.json({ comboDefaults: { strategy: "priority" }, providerOverrides: {} });
      case "/api/providers":
        return Response.json({
          connections: [
            { provider: "zeta", isActive: true },
            { provider: "alpha", isActive: true },
            { provider: "off", isActive: false },
          ],
        });
      case "/api/resilience":
        return Response.json({ quotaPreflight: { enabled: true }, other: 1 });
      case "/api/fallback/chains":
        return Response.json({ chains: { m: [] } });
      default:
        return Response.json({ error: "down" }, { status: 503 });
    }
  });
  assert.equal(requested.filter((p) => p === "/api/settings").length, 1);
  assert.equal(data.strategySettings.fallbackStrategy, "round-robin");
  assert.equal(data.catalogVisibility.hideAutoCombos, true);
  assert.deepEqual(data.comboDefaultsData.providerNames, ["alpha", "zeta"]);
  assert.deepEqual(data.quotaPreflight, { enabled: true });
  assert.equal(data.quotaPreflightLoaded, true);
  assert.deepEqual(data.chains, { m: [] });
  // Failed reads: aliases degrade to empty lists, the background-degradation tab refetches.
  assert.deepEqual(data.aliases, {
    wildcardAliases: [{ pattern: "a*", target: "b" }],
    builtIn: {},
    custom: {},
  });
  assert.equal(data.backgroundDegradation, null);
  assert.ok(!JSON.stringify(data).includes("must-not-leak"));
});

test("routing loader: a failed settings read hands every settings-backed card null", async () => {
  const { data } = await runLoader("routing", () =>
    Response.json({ error: "down" }, { status: 500 })
  );
  assert.equal(data.strategySettings, null);
  assert.equal(data.comboDefaultsData, null);
  assert.equal(data.catalogVisibility, null);
  assert.equal(data.routingSettings, null);
  assert.equal(data.quotaPreflightLoaded, false);
  assert.deepEqual(data.chains, {});
});
