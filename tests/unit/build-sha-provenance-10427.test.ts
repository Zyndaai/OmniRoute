import test from "node:test";
import assert from "node:assert/strict";

/**
 * #10427 — identifying what is deployed used to need SSH + grepping the compiled chunks:
 * the internal gateway once served a build from `fix/9603-qwen-token-plan-quota` (SHA
 * 178febc50f) that predated #10373, and every request died with `502 … Executor result must
 * contain a Response`.
 *
 * The image now carries its commit in OMNIROUTE_BUILD_SHA (Dockerfile build argument, set by
 * the publish workflow) and the health payload exposes it, so a deployment is auditable over
 * HTTP.
 */

const { buildHealthPayload } = await import("../../src/lib/monitoring/observability.ts");

/** Minimal but complete options for buildHealthPayload — only `buildSha` varies below. */
function healthOptions(buildSha?: string) {
  return {
    appVersion: "3.8.50",
    ...(buildSha === undefined ? {} : { buildSha }),
    settings: { setupComplete: true },
    connections: [],
    circuitBreakers: [],
    rateLimitStatus: {},
    learnedLimits: {},
    lockouts: {},
    localProviders: {},
    inflightRequests: 0,
    quotaMonitorSummary: {},
    quotaMonitorMonitors: [],
    activeSessions: [],
  } as unknown as Parameters<typeof buildHealthPayload>[0];
}

test("the health payload exposes buildSha so deployments are auditable over HTTP", () => {
  const payload = buildHealthPayload(healthOptions("e05ac345da"));
  assert.equal(
    (payload.system as { buildSha?: string }).buildSha,
    "e05ac345da",
    "without this, identifying a bad deploy needs SSH + grepping compiled chunks"
  );
});

test("health stays valid when no buildSha is known (dev runs)", () => {
  const payload = buildHealthPayload(healthOptions());
  const system = payload.system as { version?: string; buildSha?: string };
  assert.equal(system.version, "3.8.50", "the existing contract must not regress");
  assert.ok(
    system.buildSha === undefined || system.buildSha === null || system.buildSha === "",
    "an unknown build SHA must be absent/empty, never a fabricated value"
  );
});

test("readRunningBuildSha reads the image's OMNIROUTE_BUILD_SHA, trimmed", async () => {
  const previous = process.env.OMNIROUTE_BUILD_SHA;
  process.env.OMNIROUTE_BUILD_SHA = "  e05ac345da\n";
  try {
    const { readRunningBuildSha } = await import(
      `../../src/lib/monitoring/buildSha.ts?set=${Date.now()}`
    );
    assert.equal(readRunningBuildSha(), "e05ac345da");
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BUILD_SHA;
    else process.env.OMNIROUTE_BUILD_SHA = previous;
  }
});

test("readRunningBuildSha is null when the variable is unset or blank", async () => {
  const previous = process.env.OMNIROUTE_BUILD_SHA;
  process.env.OMNIROUTE_BUILD_SHA = "   ";
  try {
    const { readRunningBuildSha } = await import(
      `../../src/lib/monitoring/buildSha.ts?blank=${Date.now()}`
    );
    assert.equal(readRunningBuildSha(), null);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BUILD_SHA;
    else process.env.OMNIROUTE_BUILD_SHA = previous;
  }
});

test("the image and the publish workflow wire the commit through", async () => {
  const { readFileSync } = await import("node:fs");
  const dockerfile = readFileSync("Dockerfile", "utf8");
  assert.match(dockerfile, /ARG OMNIROUTE_BUILD_SHA=""\nENV OMNIROUTE_BUILD_SHA=\$\{OMNIROUTE_BUILD_SHA\}/);
  const workflow = readFileSync(".github/workflows/docker-build-push.yml", "utf8");
  assert.match(workflow, /OMNIROUTE_BUILD_SHA=\$\{\{ github\.sha \}\}/);
});
