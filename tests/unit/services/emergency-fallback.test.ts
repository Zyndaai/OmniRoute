import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousDataDir = process.env.DATA_DIR;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-emergency-fallback-"));
process.env.DATA_DIR = tmpDir;

const core = await import("../../../src/lib/db/core.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");
const { setFeatureFlagOverride, removeFeatureFlagOverride } =
  await import("../../../src/lib/db/featureFlags.ts");
const {
  shouldUseFallback,
  isEmergencyFallbackEnvEnabled,
  EMERGENCY_FALLBACK_CONFIG,
  resetEmergencyFallbackEnvCache,
  setEmergencyFallbackFeatureFlagResolverForTest,
} = await import("../../../open-sse/services/emergencyFallback.ts");
const { resolveEmergencyFallbackDecision, resetEmergencyFallbackWarnForTest } =
  await import("../../../src/sse/handlers/emergencyFallbackHeader.ts");
const { getActiveSyncedCatalog } =
  await import("../../../src/lib/db/models/activeSyncedCatalog.ts");
const { replaceSyncedAvailableModelsForConnection } = await import("../../../src/lib/db/models.ts");
// Flag reads are synchronous against an in-process snapshot of the DB overrides, so tests
// that change an override must reload that snapshot (the same call the dashboard path makes).
const { refreshFeatureFlagSnapshot } = await import("../../../src/shared/utils/featureFlags.ts");

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function resetTestState() {
  await resetTestDb();
  await refreshFeatureFlagSnapshot();
  delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  resetEmergencyFallbackEnvCache();
  setEmergencyFallbackFeatureFlagResolverForTest(null);
  resetEmergencyFallbackWarnForTest();
}

const FALLBACK_PROVIDER = EMERGENCY_FALLBACK_CONFIG.provider;
const FALLBACK_MODEL = EMERGENCY_FALLBACK_CONFIG.model;
const FALLBACK_CONNECTION = "emergency-fallback-live-catalog";

async function seedLiveCatalog(modelIds: string[]) {
  const now = new Date().toISOString();
  await getTestBackend().execute(
    `INSERT INTO provider_connections
       (id, provider, is_active, created_at, updated_at)
     VALUES ($1, $2, true, $3, $4)
     ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, is_active = true, updated_at = EXCLUDED.updated_at`,
    [FALLBACK_CONNECTION, FALLBACK_PROVIDER, now, now]
  );
  await replaceSyncedAvailableModelsForConnection(
    FALLBACK_PROVIDER,
    FALLBACK_CONNECTION,
    modelIds.map((id) => ({ id, name: id, source: "imported" as const }))
  );
}

function freshScope(): object {
  return {};
}

test.beforeEach(async () => {
  await resetTestState();
});

test.afterEach(() => {
  resetEmergencyFallbackEnvCache();
  setEmergencyFallbackFeatureFlagResolverForTest(null);
  resetEmergencyFallbackWarnForTest();
  delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
});

test.after(async () => {
  await core.resetDbInstance();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  restoreEnv("DATA_DIR", previousDataDir);
});

async function withEnv(value: string | undefined, fn: () => void | Promise<void>) {
  const previous = process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  if (value === undefined) {
    delete process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  } else {
    process.env.OMNIROUTE_EMERGENCY_FALLBACK = value;
  }
  resetEmergencyFallbackEnvCache();
  try {
    await fn();
  } finally {
    restoreEnv("OMNIROUTE_EMERGENCY_FALLBACK", previous);
    resetEmergencyFallbackEnvCache();
  }
}

async function withFeatureFlagOverride(value: string, fn: () => void | Promise<void>) {
  try {
    await setFeatureFlagOverride("OMNIROUTE_EMERGENCY_FALLBACK", value);
    await refreshFeatureFlagSnapshot();
    resetEmergencyFallbackEnvCache();
    await fn();
  } finally {
    await removeFeatureFlagOverride("OMNIROUTE_EMERGENCY_FALLBACK");
    await refreshFeatureFlagSnapshot();
    resetEmergencyFallbackEnvCache();
  }
}

test("emergency fallback stays enabled when the env switch is unset (default behavior)", async () => {
  await withEnv(undefined, () => {
    assert.equal(isEmergencyFallbackEnvEnabled(), true);
    const decision = shouldUseFallback(402, "", false);
    assert.equal(decision.shouldFallback, true);
    if (decision.shouldFallback) {
      assert.equal(decision.provider, EMERGENCY_FALLBACK_CONFIG.provider);
      assert.equal(decision.model, EMERGENCY_FALLBACK_CONFIG.model);
    }
  });
});

test("budget keywords trigger fallback when the env switch is unset", async () => {
  await withEnv(undefined, () => {
    const decision = shouldUseFallback(429, "All accounts quota exceeded", false);
    assert.equal(decision.shouldFallback, true);
  });
});

test("OMNIROUTE_EMERGENCY_FALLBACK=false disables the 402 redirect", async () => {
  await withEnv("false", () => {
    assert.equal(isEmergencyFallbackEnvEnabled(), false);
    const decision = shouldUseFallback(402, "", false);
    assert.equal(decision.shouldFallback, false);
    assert.match(decision.reason, /OMNIROUTE_EMERGENCY_FALLBACK/);
  });
});

test("OMNIROUTE_EMERGENCY_FALLBACK=0 disables the budget-keyword redirect", async () => {
  await withEnv("0", () => {
    const decision = shouldUseFallback(429, "quota exceeded for account", false);
    assert.equal(decision.shouldFallback, false);
    assert.match(decision.reason, /OMNIROUTE_EMERGENCY_FALLBACK/);
  });
});

test("DB feature flag override can disable an env-enabled fallback", async () => {
  await withEnv("true", async () => {
    await withFeatureFlagOverride("false", () => {
      const decision = shouldUseFallback(402, "", false);
      assert.equal(isEmergencyFallbackEnvEnabled(), false);
      assert.equal(decision.shouldFallback, false);
      assert.match(decision.reason, /OMNIROUTE_EMERGENCY_FALLBACK/);
    });
  });
});

test("DB feature flag override can enable an env-disabled fallback", async () => {
  await withEnv("false", async () => {
    await withFeatureFlagOverride("true", () => {
      const decision = shouldUseFallback(402, "", false);
      assert.equal(isEmergencyFallbackEnvEnabled(), true);
      assert.equal(decision.shouldFallback, true);
    });
  });
});

test("raw env fallback is used when feature flag resolution throws", async () => {
  await withEnv("0", () => {
    const warnings: unknown[][] = [];
    const previousWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    setEmergencyFallbackFeatureFlagResolverForTest(() => {
      throw new Error("feature flag store unavailable");
    });

    try {
      assert.equal(isEmergencyFallbackEnvEnabled(), false);
      const decision = shouldUseFallback(402, "", false);
      assert.equal(decision.shouldFallback, false);
      assert.match(decision.reason, /OMNIROUTE_EMERGENCY_FALLBACK/);
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]?.[0]), /Feature flag resolution failed/);
    } finally {
      console.warn = previousWarn;
    }
  });
});

test("explicit truthy values keep the fallback enabled", async () => {
  await withEnv("true", () => {
    assert.equal(isEmergencyFallbackEnvEnabled(), true);
    assert.equal(shouldUseFallback(402, "", false).shouldFallback, true);
  });
});

test("env switch does not override config.enabled=false", async () => {
  await withEnv("true", () => {
    const decision = shouldUseFallback(402, "", false, {
      ...EMERGENCY_FALLBACK_CONFIG,
      enabled: false,
    });
    assert.equal(decision.shouldFallback, false);
  });
});

test("tool-bearing requests are still skipped regardless of env switch", async () => {
  await withEnv(undefined, () => {
    const decision = shouldUseFallback(402, "", true);
    assert.equal(decision.shouldFallback, false);
    assert.match(decision.reason, /tools/);
  });
});

test("402 with the target in the live catalog keeps the redirect", async () => {
  await seedLiveCatalog([FALLBACK_MODEL]);
  const catalog = await getActiveSyncedCatalog(FALLBACK_PROVIDER);
  assert.equal(catalog.authoritative, true);
  const decision = await resolveEmergencyFallbackDecision(402, "", false, freshScope());
  assert.equal(decision.shouldFallback, true);
});

test("402 with the target missing from the live catalog keeps original routing", async () => {
  await seedLiveCatalog(["openai/gpt-oss-20b"]);
  const catalog = await getActiveSyncedCatalog(FALLBACK_PROVIDER);
  assert.equal(catalog.authoritative, true);
  const decision = await resolveEmergencyFallbackDecision(402, "", false, freshScope());
  assert.equal(decision.shouldFallback, false);
  assert.match(decision.reason, /not in the live catalog; keeping original routing/);
});

test("second 402 with the target still missing logs no new warning", async () => {
  await seedLiveCatalog(["openai/gpt-oss-20b"]);
  const { logger: rootLogger } = await import("../../../src/shared/utils/logger.ts");
  const warnCalls: unknown[][] = [];
  const debugCalls: unknown[][] = [];
  const previousWarn = rootLogger.warn.bind(rootLogger);
  const previousDebug = rootLogger.debug.bind(rootLogger);
  rootLogger.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
    return rootLogger;
  }) as typeof rootLogger.warn;
  rootLogger.debug = ((...args: unknown[]) => {
    debugCalls.push(args);
    return rootLogger;
  }) as typeof rootLogger.debug;
  try {
    const first = await resolveEmergencyFallbackDecision(402, "", false, freshScope());
    assert.equal(first.shouldFallback, false);
    const second = await resolveEmergencyFallbackDecision(402, "", false, freshScope());
    assert.equal(second.shouldFallback, false);
    const fallbackWarns = warnCalls.filter((args) =>
      args.some(
        (arg) =>
          (typeof arg === "string" && arg.includes("EMERGENCY_FALLBACK")) ||
          (typeof arg === "object" &&
            arg !== null &&
            (arg as Record<string, unknown>).tag === "EMERGENCY_FALLBACK")
      )
    );
    assert.equal(fallbackWarns.length, 1);
    assert.ok(debugCalls.length >= 1);
  } finally {
    rootLogger.warn = previousWarn;
    rootLogger.debug = previousDebug;
  }
});

test("disabled switch keeps original routing without reading the catalog", async () => {
  await seedLiveCatalog([FALLBACK_MODEL]);
  let reads = 0;
  const countingLoad = async (providerId: string) => {
    reads += 1;
    return getActiveSyncedCatalog(providerId);
  };
  const previousEnabled = EMERGENCY_FALLBACK_CONFIG.enabled;
  EMERGENCY_FALLBACK_CONFIG.enabled = false;
  try {
    const decision = await resolveEmergencyFallbackDecision(
      402,
      "",
      false,
      freshScope(),
      countingLoad
    );
    assert.equal(decision.shouldFallback, false);
    assert.match(decision.reason, /emergency fallback disabled/);
    assert.equal(reads, 0);
  } finally {
    EMERGENCY_FALLBACK_CONFIG.enabled = previousEnabled;
    resetEmergencyFallbackWarnForTest();
  }
});

test("unknown catalog keeps the redirect and warns once per process", async () => {
  const { logger: rootLogger } = await import("../../../src/shared/utils/logger.ts");
  const warnCalls: unknown[][] = [];
  const previousWarn = rootLogger.warn.bind(rootLogger);
  rootLogger.warn = ((...args: unknown[]) => {
    warnCalls.push(args);
    return rootLogger;
  }) as typeof rootLogger.warn;
  try {
    const unknownLoad = async () => ({ authoritative: false, models: [] });
    const first = await resolveEmergencyFallbackDecision(402, "", false, freshScope(), unknownLoad);
    assert.equal(first.shouldFallback, true);
    const second = await resolveEmergencyFallbackDecision(
      402,
      "",
      false,
      freshScope(),
      unknownLoad
    );
    assert.equal(second.shouldFallback, true);
    const fallbackWarns = warnCalls.filter((args) =>
      args.some(
        (arg) =>
          (typeof arg === "string" && arg.includes("EMERGENCY_FALLBACK")) ||
          (typeof arg === "object" &&
            arg !== null &&
            (arg as Record<string, unknown>).tag === "EMERGENCY_FALLBACK")
      )
    );
    assert.equal(fallbackWarns.length, 1);
  } finally {
    rootLogger.warn = previousWarn;
  }
});

test("non-budget failures never read the catalog", async () => {
  let reads = 0;
  const countingLoad = async (providerId: string) => {
    reads += 1;
    return getActiveSyncedCatalog(providerId);
  };
  const scope = freshScope();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const decision = await resolveEmergencyFallbackDecision(500, "", false, scope, countingLoad);
    assert.equal(decision.shouldFallback, false);
    assert.match(decision.reason, /no budget error detected/);
  }
  assert.equal(reads, 0);
  const triggered = await resolveEmergencyFallbackDecision(402, "", false, scope, countingLoad);
  assert.equal(triggered.shouldFallback, true);
  assert.equal(reads, 1);
});
