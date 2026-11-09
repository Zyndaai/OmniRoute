import assert from "node:assert/strict";
import test from "node:test";

const { renderMetrics, quotaPeriod } = await import("../../scripts/ops/metrics-exporter.mjs");

const now = Date.parse("2026-11-09T12:00:00.000Z");

const connections = {
  connections: [
    { id: "conn-claude", provider: "claude", name: "someone@example.com" },
    { id: "conn-mock", provider: "openai-compatible-chat-abc", name: "stressmock-test" },
  ],
};

const limits = {
  caches: {
    "conn-claude": {
      plan: "default_claude_max_20x",
      fetchedAt: "2026-11-09T11:30:00.000Z",
      quotas: {
        "weekly (7d)": { used: 65, total: 100, resetAt: "2026-11-09T13:00:00.000Z" },
        "session (5h)": { unlimited: true, resetAt: "2026-11-09T12:30:00.000Z" },
      },
      modelQuotas: { "weekly fable (7d)": { remainingPercentage: 90, resetAt: "bad" } },
    },
    "conn-mock": { plan: "x", quotas: { weekly: { used: 1, total: 2 } }, limitReached: true },
  },
};

const providerMetrics = {
  metrics: {
    claude: { totalRequests: 392, totalSuccesses: 387 },
    "openai-compatible-chat-abc": { totalRequests: 10, totalSuccesses: 0 },
  },
};

test("quota windows map to weekly, session or other", () => {
  assert.equal(quotaPeriod("weekly (7d)"), "weekly");
  assert.equal(quotaPeriod("gemini_weekly"), "weekly");
  assert.equal(quotaPeriod("session (5h)"), "session");
  assert.equal(quotaPeriod("gemini-3.8-flash-high"), "other");
});

test("renders quota and provider series, without emails or excluded test connections", () => {
  const text = renderMetrics({ limits, providerMetrics, connections, now });

  assert.match(
    text,
    /omniroute_quota_used_ratio\{connection="conn-claude",provider="claude",plan="default_claude_max_20x",scope="account",window="weekly \(7d\)",period="weekly"\} 0\.65/
  );
  assert.match(text, /scope="model",window="weekly fable \(7d\)",period="weekly"\} 0\.1/);
  assert.match(text, /omniroute_quota_reset_seconds\{[^}]*window="weekly \(7d\)"[^}]*\} 3600/);
  assert.match(text, /omniroute_quota_last_sync_timestamp_seconds\{connection="conn-claude",provider="claude"\} \d+/);
  assert.match(text, /omniroute_provider_requests_total\{provider="claude"\} 392/);
  assert.match(text, /omniroute_exporter_source_up\{endpoint="providers"\} 1/);

  // An unlimited window has no share; an unparseable reset time has no series.
  assert.doesNotMatch(text, /used_ratio\{[^}]*session \(5h\)/);
  assert.doesNotMatch(text, /reset_seconds\{[^}]*weekly fable/);
  // Connection names (emails) never reach a label; the test connection is dropped.
  assert.doesNotMatch(text, /example\.com|stressmock|conn-mock|openai-compatible-chat-abc/);
});

test("a failed route shows as source down instead of breaking the scrape", () => {
  const text = renderMetrics({ limits: undefined, providerMetrics, connections, now });
  assert.match(text, /omniroute_exporter_source_up\{endpoint="provider-limits"\} 0/);
  assert.match(text, /omniroute_provider_requests_total\{provider="claude"\} 392/);
});
