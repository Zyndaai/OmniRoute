// Port of upstream #19022: an upstream Retry-After header or JSON retryDelay hint puts a
// connection in cooldown for 30 days at most (an epoch-like value used to lock it for decades).
import test from "node:test";
import assert from "node:assert/strict";

const { checkFallbackError, parseRetryAfterFromBody } =
  await import("../../../open-sse/services/accountFallback.ts");

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const PROFILE = {
  baseCooldownMs: 125,
  useUpstreamRetryHints: true,
  maxCooldownMs: 60000,
  maxBackoffSteps: 3,
  failureThreshold: 60,
  resetTimeoutMs: 5000,
  transientCooldown: 125,
  rateLimitCooldown: 125,
  maxBackoffLevel: 3,
  circuitBreakerThreshold: 60,
  circuitBreakerReset: 5000,
  providerFailureThreshold: 5,
  providerFailureWindowMs: 300000,
  providerCooldownMs: 60000,
};

test("an epoch-like Retry-After header is clamped to 30 days", () => {
  const result = checkFallbackError(
    429,
    "rate limited",
    0,
    "test-model",
    "openai",
    { "retry-after": "1700000000" },
    PROFILE
  );
  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.ok(result.cooldownMs <= THIRTY_DAYS_MS, `cooldown ${result.cooldownMs}ms exceeds 30 days`);
});

test("a huge JSON retryDelay hint is clamped to 30 days", () => {
  const body = {
    error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "9999999999s" }] },
  };
  const parsed = parseRetryAfterFromBody(body);
  assert.ok(parsed.retryAfterMs !== null);
  assert.ok(parsed.retryAfterMs <= THIRTY_DAYS_MS);
});
