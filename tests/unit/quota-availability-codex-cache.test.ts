import test from "node:test";
import assert from "node:assert/strict";
import { getCodexUsage, setCodexUsageFetchForTests } from "../../open-sse/services/usage/codex.ts";
import { parseCodexUsageResponse } from "../../open-sse/services/codexQuotaParser.ts";
import { evaluateQuotaCutoff } from "../../open-sse/services/quotaPreflight.ts";
import { buildConnectionQuotaAvailability } from "../../src/lib/usage/availability.ts";
import { convertCachedUsageToQuotaInfo } from "../../src/lib/usage/cachedQuotaConversion.ts";
import {
  toProviderLimitsCacheEntry,
  mergeProviderLimitsCacheEntry,
} from "../../src/lib/usage/providerLimitsCache.ts";
import {
  getProviderLimitsCache,
  setProviderLimitsCache,
  setProviderLimitsCacheBatch,
  deleteProviderLimitsCache,
} from "../../src/lib/db/providerLimits.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import {
  buildHealthAccount,
  type HealthQuota,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/healthOverview.ts";
import { displayAccount } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/availabilityDisplay.ts";

const policy = { enabled: true, defaultThresholdPercent: 2, providerWindowDefaults: {} };
test("Codex upstream limit flag survives cache writes and server reconstruction", async () => {
  const now = Date.now();
  const wire = {
    rate_limit: {
      limit_reached: true,
      primary_window: { used_percent: 20, reset_at: (now + 3600000) / 1000 },
      secondary_window: { used_percent: 20, reset_at: (now + 144 * 3600000) / 1000 },
    },
    rate_limit_reached_type: "weekly",
  };
  // The limits cache row has a foreign key to provider_connections, so the fixture must be a stored connection.
  const stored = await createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "Synthetic codex limit flag",
    accessToken: "synthetic-access-token",
    isActive: true,
  });
  const connection = { id: stored.id, provider: "codex", isActive: true };
  setCodexUsageFetchForTests(async () => Response.json(wire));
  try {
    const usage = await getCodexUsage("synthetic-token");
    const routing = evaluateQuotaCutoff(parseCodexUsageResponse(wire, "gpt-5.4"), undefined, {
      provider: "codex",
      requestedModel: "gpt-5.4",
    });
    const next = toProviderLimitsCacheEntry(usage, "manual", new Date(now).toISOString());
    const merged = mergeProviderLimitsCacheEntry("codex", next, { ...next, limitReached: false });
    await setProviderLimitsCache(connection.id, merged);
    const cached = (await getProviderLimitsCache(connection.id))!;
    const verdict = await buildConnectionQuotaAvailability(connection, cached, policy);
    const display = displayAccount(
      buildHealthAccount(
        connection,
        {
          raw: {
            fetchedAt: cached.fetchedAt,
            quotas: cached.quotas as Record<string, Partial<HealthQuota>>,
          },
        },
        {},
        now,
        {
          availability: verdict,
          availabilityObservedAt: now,
        }
      ),
      now
    );
    assert.equal(routing.proceed, false);
    assert.equal(verdict.account.usable, false);
    assert.equal(cached.limitReached, true);
    assert.equal(cached.rateLimitReachedType, "weekly");
    assert.equal(convertCachedUsageToQuotaInfo("codex", cached, "gpt-5.4")?.limitReached, true);
    const reconstructed = convertCachedUsageToQuotaInfo("codex", cached, "gpt-5.4");
    assert.ok(reconstructed && "rateLimitReachedType" in reconstructed);
    assert.equal(reconstructed.rateLimitReachedType, "weekly");
    assert.notEqual(display.kind, "ok");
    await setProviderLimitsCacheBatch([{ connectionId: connection.id, entry: merged }]);
    assert.deepEqual(await getProviderLimitsCache(connection.id), cached);
    wire.rate_limit.limit_reached = false;
    const cleared = mergeProviderLimitsCacheEntry(
      "codex",
      toProviderLimitsCacheEntry(await getCodexUsage("synthetic-token"), "scheduled"),
      cached
    );
    await setProviderLimitsCache(connection.id, cleared);
    assert.equal((await getProviderLimitsCache(connection.id))?.limitReached, false);
    assert.equal(
      (await buildConnectionQuotaAvailability(connection, cleared, policy)).account.usable,
      true
    );
    assert.equal(
      mergeProviderLimitsCacheEntry(
        "codex",
        toProviderLimitsCacheEntry({ message: "synthetic failure" }, "manual"),
        cached
      ),
      cached
    );
  } finally {
    setCodexUsageFetchForTests(null);
    await deleteProviderLimitsCache(connection.id);
  }
});

test("Codex legacy cache entries without a limit flag retain their existing eligibility", async () => {
  const now = Date.now();
  const usage = toProviderLimitsCacheEntry(
    {
      quotas: {
        session: { remainingPercentage: 80, resetAt: new Date(now + 3600000).toISOString() },
      },
    },
    "manual"
  );
  const quota = convertCachedUsageToQuotaInfo("codex", usage, "gpt-5.4");
  assert.equal(quota?.limitReached, false);
  assert.equal(
    (
      await buildConnectionQuotaAvailability(
        { id: "synthetic-codex-legacy", provider: "codex" },
        usage,
        policy
      )
    ).account.usable,
    true
  );
});
