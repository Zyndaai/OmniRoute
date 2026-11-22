import test from "node:test";
import assert from "node:assert/strict";

import {
  __testing,
  fetchCodexQuota,
  getCodexQuotaFetchTimeoutMs,
  invalidateCodexQuotaCache,
} from "../../open-sse/services/codexQuotaFetcher.ts";

const originalFetch = globalThis.fetch;
const originalTimeout = process.env.CODEX_QUOTA_FETCH_TIMEOUT_MS;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTimeout === undefined) delete process.env.CODEX_QUOTA_FETCH_TIMEOUT_MS;
  else process.env.CODEX_QUOTA_FETCH_TIMEOUT_MS = originalTimeout;
});

function usage(primaryPercent: number, resetSeconds = 3_600) {
  return {
    rate_limit: {
      primary_window: { used_percent: primaryPercent, reset_after_seconds: resetSeconds },
      secondary_window: { used_percent: 10, reset_after_seconds: 86_400 },
    },
  };
}

const connection = (token: string) => ({
  accessToken: token,
  providerSpecificData: { workspaceId: "ws" },
});

test("a timed out refresh reuses a recent healthy snapshot instead of failing the account", async () => {
  const id = "codex-stale-fallback-timeout";
  try {
    globalThis.fetch = async () => Response.json(usage(30));
    const fresh = await fetchCodexQuota(id, connection("tok-a"));
    assert.ok(fresh);

    __testing.ageCacheEntry(id, 120_000); // past the 60 s TTL, inside the stale window
    globalThis.fetch = async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    };
    const reused = await fetchCodexQuota(id, connection("tok-a"));
    assert.ok(reused, "a recent healthy snapshot must be reused");
    assert.equal(reused?.stale, true);
    assert.equal(reused?.window5h.percentUsed, fresh?.window5h.percentUsed);
  } finally {
    invalidateCodexQuotaCache(id);
  }
});

test("an exhausted or too old snapshot is not reused when the refresh fails", async () => {
  const id = "codex-stale-fallback-exhausted";
  try {
    globalThis.fetch = async () => Response.json(usage(100));
    assert.ok(await fetchCodexQuota(id, connection("tok-b")));
    __testing.ageCacheEntry(id, 120_000);
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    assert.equal(await fetchCodexQuota(id, connection("tok-b")), null, "spent window stays unknown");

    globalThis.fetch = async () => Response.json(usage(20));
    __testing.ageCacheEntry(id, 16 * 60_000);
    __testing.sweepQuotaCache();
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    assert.equal(await fetchCodexQuota(id, connection("tok-b")), null, "15 min old is dropped");
  } finally {
    invalidateCodexQuotaCache(id);
  }
});

test("a replaced access token does not inherit the previous owner's snapshot", async () => {
  const id = "codex-stale-fallback-owner";
  try {
    globalThis.fetch = async () => Response.json(usage(25));
    assert.ok(await fetchCodexQuota(id, connection("tok-old")));
    __testing.ageCacheEntry(id, 120_000);
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    assert.equal(await fetchCodexQuota(id, connection("tok-new")), null);
  } finally {
    invalidateCodexQuotaCache(id);
  }
});

test("CODEX_QUOTA_FETCH_TIMEOUT_MS tunes the request timeout and rejects garbage", () => {
  delete process.env.CODEX_QUOTA_FETCH_TIMEOUT_MS;
  assert.equal(getCodexQuotaFetchTimeoutMs(), 8_000);
  process.env.CODEX_QUOTA_FETCH_TIMEOUT_MS = "20000";
  assert.equal(getCodexQuotaFetchTimeoutMs(), 20_000);
  for (const bad of ["0", "-5", "1.5", "abc", "99999999999"]) {
    process.env.CODEX_QUOTA_FETCH_TIMEOUT_MS = bad;
    assert.equal(getCodexQuotaFetchTimeoutMs(), 8_000, bad);
  }
});
