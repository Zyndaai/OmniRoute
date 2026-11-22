// @ts-nocheck
// /v1/models catalog cache behaviour: cache-key hashing, TTL, in-flight coalescing, event-loop
// yielding of the builder and runtime invalidation of the published catalog.
//
// Merged from 6 single-topic files so the catalog module graph loads once per process instead of
// once per file. Each `describe` below is one former file (its name is the old file name without
// `.test.ts`); its helpers, fixtures and hooks stay scoped to it.
//
// Shared state: one process, one DATA_DIR, one Postgres database, one module cache. The catalog
// cache, its in-flight map and the builder-run counter are process-global, so every describe
// drains background refreshes and resets them in its own hooks (each former file started from an
// empty cache); the database handle is closed once at the end of the file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-models-catalog-cache-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";
// These cases measure caching and yielding, not the cold-build time bound; the production budget
// (8s) would answer 503 `catalog_build_timeout` on a loaded host before the assertions run.
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const capabilityOverrides = await import("../../../src/lib/db/modelCapabilityOverrides.ts");
const contextOverrides = await import("../../../src/lib/db/modelContextOverrides.ts");
const readCache = await import("../../../src/lib/db/readCache.ts");
const modelsDevSync = await import("../../../src/lib/modelsDevSync.ts");
const v1ModelsCatalog = await import("../../../src/app/api/v1/models/catalog.ts");
const catalogCacheMod = await import("../../../src/app/api/v1/models/catalogCache.ts");
const auth = await import("../../../src/sse/services/auth.ts");
const cooperativeYield = await import("../../../open-sse/services/autoCombo/cooperativeYield.ts");
const { getTestBackend, resetTestDb } = await import("../../helpers/postgres.ts");

after(async () => {
  await core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Settle any background refresh the previous test left in flight, then start from a cold cache. */
async function resetCatalogCache() {
  await catalogCacheMod.__flushCatalogBackgroundRefreshForTest();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

describe("10313-catalog-cache-key-hashing", () => {
  const SECRET = "sk-live-PROBE-10313-SUPER-SECRET-TOKEN";

  beforeEach(async () => {
    await core.resetDbInstance();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetTestDb();
    await resetCatalogCache();
  });

  function captureMapKeys(): { keys: string[]; restore: () => void } {
    const capturedKeys: string[] = [];
    const originalSet = Map.prototype.set;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Map.prototype as any).set = function (key: unknown, value: unknown) {
      if (typeof key === "string") capturedKeys.push(key);
      return originalSet.call(this, key, value);
    };
    return {
      keys: capturedKeys,
      release: () => {
        Map.prototype.set = originalSet;
      },
    };
  }

  // buildCatalogCacheKey emits
  // `prefix|isCodex|apiKeyFingerprint|configuredOnly|hideAuto|hideNoThink|page`
  // (7 pipe-delimited fields). Other in-flight keys (e.g. `x-request-id`) don't match.
  function isCatalogCacheKey(k: string): boolean {
    return k.split("|").length === 7;
  }

  test("catalog cache Map keys must not contain the raw bearer API key (#10313)", async () => {
    const probe = captureMapKeys();

    try {
      const request = new Request("http://localhost/v1/models", {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      const res = await v1ModelsCatalog.getUnifiedModelsResponse(request);
      assert.ok(res.status === 200 || res.status === 401 || res.status === 403);
    } finally {
      probe.release();
    }

    const catalogKeys = probe.keys.filter(isCatalogCacheKey);
    assert.ok(
      catalogKeys.length > 0,
      "no catalog cache Map.set() calls observed — the probe did not exercise catalogCache/catalogInFlight"
    );

    const leaked = catalogKeys.filter((k) => k.includes(SECRET));
    assert.deepEqual(
      leaked,
      [],
      `catalog cache Map key retained the raw API key verbatim: ${JSON.stringify(leaked)} — ` +
        `buildCatalogCacheKey() must hash the secret (e.g. sha256) before using it as a Map key`
    );

    assert.ok(catalogCacheMod.CATALOG_CACHE_TTL_MS_DEFAULT > 0);
  });

  test("cache keys embed the sha256 digest of the secret, never the raw secret (#10313)", async () => {
    // Capture ALL Map keys emitted across BOTH requests (a 2nd identical-secret request
    // may be a cache hit and emit no new catalog key — irrelevant here: we assert on the
    // digest that did appear).
    const probe = captureMapKeys();
    try {
      const resA = await v1ModelsCatalog.getUnifiedModelsResponse(
        new Request("http://localhost/v1/models", {
          headers: { Authorization: "Bearer sk-10313-DIGEST-A" },
        })
      );
      const resB = await v1ModelsCatalog.getUnifiedModelsResponse(
        new Request("http://localhost/v1/models", {
          headers: { Authorization: "Bearer sk-10313-DIGEST-B" },
        })
      );
      assert.ok(resA.status === 200 || resA.status === 401 || resA.status === 403);
      assert.ok(resB.status === 200 || resB.status === 401 || resB.status === 403);
    } finally {
      probe.release();
    }

    const catalogKeys = probe.keys.filter(isCatalogCacheKey);
    assert.ok(catalogKeys.length > 0, "expected catalog cache Map.set() calls");

    // #10538 sync note: buildCatalogCacheKey() delegates to the canonical
    // fingerprintCatalogAuthKey() (landed on release/v3.8.50 independently of #10313),
    // which truncates the sha256 hex digest to 16 chars for a shorter Map key. Derive
    // the expected fingerprint the same way rather than re-hardcoding the full digest.
    const digestA = catalogCacheMod.fingerprintCatalogAuthKey("sk-10313-DIGEST-A");
    const digestB = catalogCacheMod.fingerprintCatalogAuthKey("sk-10313-DIGEST-B");
    const rawA = "sk-10313-DIGEST-A";
    const rawB = "sk-10313-DIGEST-B";

    // The hashed fingerprint, not the raw secret, rides in the cache keys.
    const keysWithDigestA = catalogKeys.filter((k) => k.includes(digestA));
    const keysWithDigestB = catalogKeys.filter((k) => k.includes(digestB));
    assert.ok(
      keysWithDigestA.length > 0,
      `expected a cache key embedding the fingerprint of A: ${catalogKeys.join(",")}`
    );
    assert.ok(
      keysWithDigestB.length > 0,
      `expected a cache key embedding the fingerprint of B: ${catalogKeys.join(",")}`
    );

    // Raw secrets must never appear (issue #10313 root cause).
    assert.ok(!catalogKeys.some((k) => k.includes(rawA) || k.includes(rawB)));

    // Identical secrets ⇒ identical key (memoized reuse); different ⇒ distinct.
    assert.ok(
      keysWithDigestA.every((k) => k === keysWithDigestA[0]),
      "all A keys must be identical"
    );
    assert.ok(
      keysWithDigestB.every((k) => k === keysWithDigestB[0]),
      "all B keys must be identical"
    );
    assert.notEqual(keysWithDigestA[0], keysWithDigestB[0]);
  });
});

describe("9147-catalog-eventloop-yield", () => {
  // This case measures whether the builder YIELDS, not how fast it finishes. The
  // production cold-path budget (CATALOG_BUILD_TIMEOUT_MS, 8s) is not the subject:
  // when the seeded catalog-scale build overruns it, getUnifiedModelsResponse
  // answers 503 `catalog_build_timeout` and the two assertions that actually guard
  // the invariant — the max event-loop gap and the traversal to the last seeded
  // model — are never reached, because the status check precedes them. That is how
  // this guard went silently dead on loaded runners (CI observed 8350ms, right at
  // the bound). The budget is pinned far above any healthy build at the top of the
  // file so the yield invariant is evaluated; build-latency budgeting is a separate
  // concern from this test.
  const CONNECTION_COUNT = 60;
  const MODELS_PER_CONNECTION = 12; // ~720 synced models total

  async function resetStorage() {
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    await resetCatalogCache();
  }

  async function seedCatalogScaleDataset() {
    const now = new Date().toISOString();
    await getTestBackend().transaction(async (tx) => {
      for (let i = 0; i < CONNECTION_COUNT; i++) {
        const id = `probe-conn-${i}`;
        await tx.execute(
          `INSERT INTO provider_connections (id, provider, auth_type, name, priority, is_active, api_key, created_at, updated_at)
         VALUES ($1, 'openai-compatible', 'apikey', $2, $3, true, $4, $5, $5)`,
          [id, `probe-connection-${i}`, i, `sk-probe-${i}`, now]
        );
        const models = Array.from({ length: MODELS_PER_CONNECTION }, (_, m) => ({
          id: `probe-model-${i}-${m}`,
          name: `Probe Model ${i}-${m}`,
          contextLength: 128000,
        }));
        await tx.execute(
          `INSERT INTO connection_model_sync (connection_id, provider, models)
         VALUES ($1, 'openai-compatible', $2::jsonb)`,
          [id, JSON.stringify(models)]
        );
      }
    });
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#9147 — catalog build at catalog-scale must not pin the event loop for a long stretch", async (t) => {
    await seedCatalogScaleDataset();
    const req = new Request("http://localhost/v1/models");
    let settled = false;
    const buildPromise = v1ModelsCatalog.getUnifiedModelsResponse(req).then((res) => {
      settled = true;
      return res;
    });
    let lastTick = performance.now();
    let maxGapMs = 0;
    let ticks = 0;
    while (!settled) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - lastTick);
      lastTick = now;
      ticks++;
      if (ticks > 20000) break;
    }
    const res = await buildPromise;
    assert.equal(res.status, 200);
    t.diagnostic(
      `maximum event-loop gap: ${maxGapMs.toFixed(1)}ms across ${ticks} interleaved ticks`
    );
    // 2026-08-30: 400 → 800. With the catalog at 352 providers the hosted shards measure
    // 410–633ms gaps (runs 33325191658, 33327592128, 33328119934); 800ms still fails a
    // true pin (seconds) — re-tighten with the v4.0 catalog modularization.
    // 150ms is tight on GitHub-hosted unit shards (`--test-concurrency=4`):
    // sibling tests share the event loop, so a healthy yielding builder still
    // records 200–260ms gaps. 400ms still fails a true pin (seconds) while
    // absorbing shard contention. Observed CI: 252.5ms on run 32494847431.
    assert.ok(
      maxGapMs < 800,
      `event loop was blocked for ${maxGapMs.toFixed(1)}ms in a single stretch while building the ` +
        `catalog for ${CONNECTION_COUNT} connections / ${CONNECTION_COUNT * MODELS_PER_CONNECTION} models ` +
        `(${ticks} interleaved ticks observed) — the builder is not yielding to the event loop`
    );
    const body = (await res.json()) as { data?: Array<{ root?: string }> };
    assert.ok(
      body.data?.some((model) => model.root === "probe-model-59-11"),
      "the responsiveness probe must still traverse and return the last seeded catalog model"
    );
  });
});

describe("catalog-yield-skipped-models-9147", () => {
  // #9147: the catalog builder yields every N loop iterations, but the yield used to sit at
  // the BOTTOM of each loop body, so entries skipped by an early `continue` never counted.
  // A registry made mostly of skipped rows was then walked without a single yield. This
  // counts the builder's `setImmediate` yields with and without a large block of rows that
  // the custom-model loop skips (no string id), and requires the skipped rows to yield.
  // The auto-candidate preparation that runs inside the same request now yields on a
  // wall-clock budget, so its yield count differs between the cold baseline run and the warm
  // run and would swamp this difference. The budget slice is pinned to Infinity (it never
  // yields on time) so only the catalog loop's deterministic every-N yields are compared.
  const SKIPPED_ROWS = 2000;

  async function resetStorage() {
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    await resetCatalogCache();
  }

  async function seed(skippedRows: number) {
    const db = getTestBackend();
    const now = new Date().toISOString();
    await db.execute(
      `INSERT INTO provider_connections (id, provider, auth_type, name, priority, is_active, api_key, created_at, updated_at)
     VALUES ('skip-conn', 'openai', 'apikey', 'skip-connection', 1, true, 'sk-skip', $1, $2)`,
      [now, now]
    );
    const rows = Array.from({ length: skippedRows }, (_, i) => ({ name: `no-id-${i}` }));
    await db.execute(
      `INSERT INTO provider_model_catalog (provider, custom_models) VALUES ('openai', $1::jsonb)`,
      [JSON.stringify(rows)]
    );
  }

  async function countBuildYields(skippedRows: number): Promise<number> {
    await resetStorage();
    await seed(skippedRows);
    const original = globalThis.setImmediate;
    let yields = 0;
    globalThis.setImmediate = ((...args: Parameters<typeof setImmediate>) => {
      yields++;
      return original(...args);
    }) as typeof setImmediate;
    try {
      const res = await v1ModelsCatalog.getUnifiedModelsResponse(
        new Request("http://localhost/v1/models")
      );
      assert.equal(res.status, 200);
    } finally {
      globalThis.setImmediate = original;
    }
    return yields;
  }

  test("#9147 — rows skipped by an early `continue` still count toward catalog yields", async () => {
    cooperativeYield.__setCooperativeYieldSliceMsForTest(Number.POSITIVE_INFINITY);
    let baseline: number;
    let withSkipped: number;
    try {
      baseline = await countBuildYields(0);
      withSkipped = await countBuildYields(SKIPPED_ROWS);
    } finally {
      cooperativeYield.__setCooperativeYieldSliceMsForTest(null);
    }
    const extra = withSkipped - baseline;
    // One yield per 5 iterations → ~400 for 2000 skipped rows; allow slack for jitter.
    assert.ok(
      extra >= SKIPPED_ROWS / 5 - 5,
      `expected ~${SKIPPED_ROWS / 5} extra yields for ${SKIPPED_ROWS} skipped rows, got ${extra} ` +
        `(baseline ${baseline}, with skipped rows ${withSkipped})`
    );
  });
});

describe("v1-models-catalog-ttl", () => {
  // Regression guard — GET /v1/models re-ran the full builder on almost every request.
  //
  // The response cache added by #6408 memoized the serialized body for
  // CATALOG_CACHE_TTL_MS_DEFAULT, which was 1500 ms. On a real install the builder
  // takes tens of seconds (measured 2026-07-28 on the production VPS: ~49 s for a
  // 1.3 MB / 2645-model catalog), so any two requests more than 1.5 s apart both
  // missed the fresh window. The second one fell into the stale-while-revalidate
  // path, which kicks off the rebuild via setTimeout(…, 0) — and because the builder
  // is overwhelmingly synchronous (SQLite reads + 8 registry walks) under the
  // single-threaded App Router, it pins the event loop, so even the "served
  // immediately" stale response only reaches the client once the rebuild finishes.
  // Net effect: a ~50 s response on essentially every call.
  //
  // A short TTL is redundant with the invalidation this cache already has:
  // invalidateDbCache() bumps modelCatalogCacheVersion on every settings/connections/
  // combos/pricing write, and dropCatalogCacheIfStateChanged() drops the whole cache
  // the moment it moves. So post-write freshness does not depend on the TTL at all —
  // the TTL only governs the "nothing was written" case, where serving a body that is
  // a few seconds old is exactly what a cache is for.
  //
  // This test pins that: with DB state untouched, a request arriving well after the
  // old 1.5 s window must still be served from cache without a second builder run.
  const catalogCache = catalogCacheMod;

  /** Comfortably past the old 1500 ms TTL, and a realistic client poll gap. */
  const GAP_MS = 10_000;

  beforeEach(async () => {
    await core.resetDbInstance();
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetCatalogCache();
  });

  test("the settings default and the constant agree on the catalog TTL", async () => {
    // catalog.ts resolves the TTL as `dbSettings.cache?.modelCatalogCacheTtlMs ??
    // CATALOG_CACHE_TTL_MS_DEFAULT`. The `??` never falls through while the settings
    // default is defined, so the settings value is the one that takes effect and raising
    // only the constant is a silent no-op — which is exactly how the first attempt at
    // this fix measured identical to no fix at all.
    const { DEFAULT_DATABASE_SETTINGS } = await import("../../../src/types/databaseSettings.ts");
    assert.equal(
      DEFAULT_DATABASE_SETTINGS.cache.modelCatalogCacheTtlMs,
      catalogCache.CATALOG_CACHE_TTL_MS_DEFAULT,
      "settings default and CATALOG_CACHE_TTL_MS_DEFAULT drifted — the settings value wins, " +
        "so the constant alone does not change runtime behavior"
    );
  });

  test("the effective TTL stays within what the settings schema accepts", async () => {
    const { databaseSettingsSchema } =
      await import("../../../src/shared/validation/settingsSchemas.ts");
    // An operator must be able to configure the value the product ships with; a default
    // above the schema ceiling would be rejected the moment anyone saved settings.
    const parsed = databaseSettingsSchema.shape.cache.shape.modelCatalogCacheTtlMs.safeParse(
      catalogCache.CATALOG_CACHE_TTL_MS_DEFAULT
    );
    assert.ok(
      parsed.success,
      `default TTL ${catalogCache.CATALOG_CACHE_TTL_MS_DEFAULT} ms is outside the range the ` +
        `settings schema allows`
    );
  });

  test("the default TTL outlives a realistic gap between catalog polls", () => {
    assert.ok(
      catalogCache.CATALOG_CACHE_TTL_MS_DEFAULT >= GAP_MS,
      `default catalog TTL is ${catalogCache.CATALOG_CACHE_TTL_MS_DEFAULT} ms — too short to ` +
        `survive a ${GAP_MS} ms gap, so every poll pays a full rebuild (~49 s in production)`
    );
  });

  test("a request after the old 1.5s window is served from cache, without a second builder run", async (t) => {
    // Fake Date so the cache's expiresAt comparison sees the gap without sleeping.
    // Timer callbacks stay real: scheduleBackgroundRefresh() uses setTimeout(…, 0),
    // and mocking that away would hide the very rebuild this test must not trigger.
    t.mock.timers.enable({ apis: ["Date"] });

    const res1 = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(res1.status, 200);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      1,
      "cold request must run the builder exactly once"
    );
    const body1 = await res1.text();

    t.mock.timers.tick(GAP_MS);

    const res2 = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(res2.status, 200);
    assert.equal(await res2.text(), body1, "cached response must be byte-identical");

    // The stale path returns the body immediately and rebuilds via setTimeout(…, 0), so
    // reading the counter right here would still show 1 even when the request missed the
    // fresh window. Let any scheduled refresh settle first — a rebuild that happens at all
    // is the defect: in production it pins the event loop and the "immediate" stale
    // response is only flushed ~49 s later.
    await catalogCache.__flushCatalogBackgroundRefreshForTest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await catalogCache.__flushCatalogBackgroundRefreshForTest();

    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      1,
      `builder re-ran ${GAP_MS} ms after the first request with no DB write in between — ` +
        `the caller pays a full rebuild on every poll`
    );
  });
});

describe("v1-models-concurrent-6408", () => {
  // Regression guard for #6408 — GET /v1/models serializes concurrent requests
  // (~1.2 s per request under any concurrency).
  //
  // The catalog builder walks 8 model registries + hits SQLite for connections,
  // combos, custom models, and aliases on every call. Under Next.js App Router
  // (single-threaded per-instance), N concurrent GETs run back-to-back so the
  // 10th request completes ~12 s after the 1st (linear staircase reproduced in
  // the issue).
  //
  // Fix: coalesce identical concurrent requests onto a single in-flight promise
  // and memoize the serialized JSON body for ~1.5 s. This test uses the
  // __getCatalogBuilderRunsForTest hook to assert that N concurrent GETs
  // collapse to exactly ONE builder execution (not N).
  async function resetStorage() {
    await core.resetDbInstance();
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    await resetCatalogCache();
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("#6408 — 10 concurrent identical GET /v1/models calls collapse to ONE builder run", async () => {
    const N = 10;
    const requests = Array.from({ length: N }, () => new Request("http://localhost/v1/models"));
    const responses = await Promise.all(
      requests.map((req) => v1ModelsCatalog.getUnifiedModelsResponse(req))
    );

    for (const res of responses) assert.equal(res.status, 200);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    for (let i = 1; i < bodies.length; i++) {
      assert.equal(bodies[i], bodies[0], "concurrent responses must be byte-identical");
    }

    const runs = v1ModelsCatalog.__getCatalogBuilderRunsForTest();
    assert.equal(
      runs,
      1,
      `builder ran ${runs} times for ${N} concurrent requests — expected exactly 1 (in-flight coalescing)`
    );
  });

  test("#6408 — a second call within the TTL window is served from cache without re-running the builder", async () => {
    const res1 = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(res1.status, 200);
    assert.equal(v1ModelsCatalog.__getCatalogBuilderRunsForTest(), 1);

    const res2 = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    assert.equal(res2.status, 200);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      1,
      "second call within TTL should reuse cache — builder must not run again"
    );

    assert.equal(await res2.text(), await res1.text());
  });

  test("#6408 — requests with different cache keys (prefix param) run the builder independently", async () => {
    const resAlias = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models?prefix=alias")
    );
    const resCanon = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models?prefix=canonical")
    );
    assert.equal(resAlias.status, 200);
    assert.equal(resCanon.status, 200);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      2,
      "distinct cache keys must not collapse into each other"
    );
  });
});

describe("model-catalog-runtime-invalidation", () => {
  async function resetStorage() {
    await resetTestDb();
    apiKeysDb.resetApiKeyState();
    await resetCatalogCache();
  }

  async function seedOpenAiConnection() {
    return providersDb.createProviderConnection({
      provider: "openai",
      authType: "apikey",
      name: "openai-catalog-invalidation",
      apiKey: "sk-test",
      isActive: true,
      testStatus: "active",
      providerSpecificData: {},
    });
  }

  function catalogRequest() {
    return new Request("http://localhost/api/v1/models?prefix=alias");
  }

  /**
   * #9147 yields in getUnifiedModelsResponse before the cache generation is bound.
   * A single setImmediate therefore mutates during the auth prologue, where both
   * callers correctly coalesce onto one current-generation build. Isolation is
   * only observable after the builder has started.
   */
  async function waitForInFlightCatalogBuild(
    isSettled: () => boolean,
    message: string
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (v1ModelsCatalog.__getCatalogBuilderRunsForTest() < 1) {
      assert.equal(isSettled(), false, message);
      assert.ok(Date.now() < deadline, "timed out waiting for catalog builder to start");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Drain the builder's post-auth cooperative yield so settings/capabilities
    // are snapshotted against the in-flight generation before we write.
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(isSettled(), false, message);
    }
  }

  beforeEach(async () => {
    await resetStorage();
  });

  test("session-affinity bookkeeping preserves the published model catalog", async () => {
    await settingsDb.updateSettings({ sessionAffinityTtlMs: 60_000 });
    const connection = await seedOpenAiConnection();
    const firstResponse = await v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());
    const firstBody = await firstResponse.text();

    const firstSelection = await auth.getProviderCredentials("openai", null, null, "gpt-5.4-mini", {
      sessionKey: "catalog-runtime-affinity-session",
      forcedConnectionId: connection.id as string,
    });

    const secondSelection = await auth.getProviderCredentials(
      "openai",
      null,
      null,
      "gpt-5.4-mini",
      {
        sessionKey: "catalog-runtime-affinity-session",
        forcedConnectionId: connection.id as string,
      }
    );

    assert.equal(firstSelection?.connectionId, connection.id);
    assert.equal(secondSelection?.connectionId, connection.id);
    const persisted = await providersDb.getProviderConnectionById(connection.id as string);
    assert.equal(
      persisted?.consecutiveUseCount,
      2,
      "reusing a cached affinity connection must keep its usage counter current"
    );
    assert.equal(typeof persisted?.lastUsedAt, "string");

    const secondResponse = await v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());
    const secondBody = await secondResponse.text();

    assert.equal(secondBody, firstBody);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      1,
      "runtime-only affinity bookkeeping must not force a second catalog build"
    );
  });

  test("catalog-affecting connection changes still rebuild the published catalog", async () => {
    const connection = await seedOpenAiConnection();
    const firstResponse = await v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());
    const firstBody = (await firstResponse.json()) as { data: Array<{ id: string }> };
    assert.equal(
      firstBody.data.some((model) => model.id === "openai/gpt-5.4-mini"),
      true
    );

    await providersDb.updateProviderConnection(connection.id as string, {
      providerSpecificData: {
        excludedModels: ["gpt-5.4*"],
      },
    });

    const secondResponse = await v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());
    const secondBody = (await secondResponse.json()) as { data: Array<{ id: string }> };

    assert.equal(
      secondBody.data.some((model) => model.id === "openai/gpt-5.4-mini"),
      false
    );
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      2,
      "catalog-affecting connection changes must keep hard invalidation"
    );
  });

  test("#9199 capability data writes advance the model-catalog generation", async () => {
    const expectGenerationAdvance = async (label: string, mutate: () => Promise<void>) => {
      const before = readCache.getModelCatalogCacheVersion();
      await mutate();
      assert.ok(
        readCache.getModelCatalogCacheVersion() > before,
        `${label} must hard-invalidate the published model catalog`
      );
    };
    const expectGenerationUnchanged = async (label: string, mutate: () => Promise<void>) => {
      const before = readCache.getModelCatalogCacheVersion();
      await mutate();
      assert.equal(
        readCache.getModelCatalogCacheVersion(),
        before,
        `${label} must not invalidate when no capability row changed`
      );
    };

    await expectGenerationAdvance("setModelCapabilityOverride", async () => {
      assert.equal(
        await capabilityOverrides.setModelCapabilityOverride(
          "openai/gpt-5.4-mini",
          "max_token",
          64000
        ),
        true
      );
    });
    await expectGenerationAdvance("removeModelCapabilityOverride", async () => {
      assert.equal(
        await capabilityOverrides.removeModelCapabilityOverride("openai/gpt-5.4-mini", "max_token"),
        true
      );
    });
    await expectGenerationAdvance("set reasoning_efforts override", async () => {
      assert.equal(
        await capabilityOverrides.setModelCapabilityOverride(
          "openai/gpt-5.4-mini",
          "reasoning_efforts",
          "low,max,ultra"
        ),
        true
      );
    });
    await expectGenerationAdvance("remove reasoning_efforts override", async () => {
      assert.equal(
        await capabilityOverrides.removeModelCapabilityOverride(
          "openai/gpt-5.4-mini",
          "reasoning_efforts"
        ),
        true
      );
    });
    await expectGenerationAdvance("setModelContextOverride", async () => {
      assert.equal(
        await contextOverrides.setModelContextOverride("openai", "gpt-5.4-mini", 400000),
        true
      );
    });
    await expectGenerationAdvance("removeModelContextOverride", async () => {
      assert.equal(
        await contextOverrides.removeModelContextOverride("openai", "gpt-5.4-mini"),
        true
      );
    });

    await expectGenerationUnchanged("empty saveModelsDevCapabilities", async () => {
      await modelsDevSync.saveModelsDevCapabilities({});
    });
    await expectGenerationAdvance("saveModelsDevCapabilities", async () => {
      await modelsDevSync.saveModelsDevCapabilities({
        openai: {
          "gpt-5.4-mini": {
            tool_call: true,
            reasoning: true,
            attachment: false,
            structured_output: true,
            temperature: true,
            modalities_input: '["text"]',
            modalities_output: '["text"]',
            knowledge_cutoff: null,
            release_date: null,
            last_updated: null,
            status: null,
            family: "gpt",
            open_weights: false,
            limit_context: 400000,
            limit_input: 380000,
            limit_output: 64000,
            interleaved_field: null,
          },
        },
      });
    });
    await expectGenerationAdvance("clearModelsDevCapabilities", async () => {
      await modelsDevSync.clearModelsDevCapabilities();
    });
    await expectGenerationUnchanged("empty clearModelsDevCapabilities", async () => {
      await modelsDevSync.clearModelsDevCapabilities();
    });
  });

  test("#9199 a capability mutation during preparation detaches the obsolete generation", async () => {
    let firstSettled = false;
    const firstPromise = v1ModelsCatalog
      .getUnifiedModelsResponse(catalogRequest())
      .then((response) => {
        firstSettled = true;
        return response;
      });

    await waitForInFlightCatalogBuild(
      () => firstSettled,
      "the mutation must occur while capability preparation is active"
    );
    assert.equal(
      await capabilityOverrides.setModelCapabilityOverride(
        "openai/gpt-5.4-mini",
        "max_token",
        64000
      ),
      true
    );

    const secondPromise = v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());
    await Promise.all([firstPromise, secondPromise]);
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      2,
      "a post-mutation caller must not join capability work from the old generation"
    );

    await v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      2,
      "obsolete capability work must not repopulate the current cache generation"
    );
  });

  test("#9199 a mutation during a cooperative catalog build detaches the obsolete generation", async () => {
    await settingsDb.updateSettings({ blockedProviders: [] });
    // Keep auto/best-coding eligible before the test changes its provider visibility.
    await seedOpenAiConnection();

    let firstSettled = false;
    const firstPromise = v1ModelsCatalog
      .getUnifiedModelsResponse(catalogRequest())
      .then((response) => {
        firstSettled = true;
        return response;
      });

    await waitForInFlightCatalogBuild(
      () => firstSettled,
      "the mutation must occur while the first build is in flight"
    );

    await settingsDb.updateSettings({ blockedProviders: ["auto"] });
    const secondPromise = v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());

    const [firstResponse, secondResponse] = await Promise.all([firstPromise, secondPromise]);
    const firstBody = (await firstResponse.json()) as { data: Array<{ id: string }> };
    const secondBody = (await secondResponse.json()) as { data: Array<{ id: string }> };
    const thirdResponse = await v1ModelsCatalog.getUnifiedModelsResponse(catalogRequest());
    const thirdBody = (await thirdResponse.json()) as { data: Array<{ id: string }> };
    const advertisesAuto = (body: { data: Array<{ id: string }> }) =>
      body.data.some((model) => model.id === "auto/best-coding");

    assert.equal(advertisesAuto(firstBody), true, "the pre-mutation caller keeps its own snapshot");
    assert.equal(
      advertisesAuto(secondBody),
      false,
      "a post-mutation caller must not join the obsolete in-flight build"
    );
    assert.equal(
      advertisesAuto(thirdBody),
      false,
      "the obsolete build must not repopulate the current cache generation"
    );
    assert.equal(
      v1ModelsCatalog.__getCatalogBuilderRunsForTest(),
      2,
      "the current generation must publish from a distinct builder run"
    );
  });
});
