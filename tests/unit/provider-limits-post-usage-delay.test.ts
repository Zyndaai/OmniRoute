// The post-usage provider-limits refresh (Antigravity) must wait its default delay when the
// env knob is unset. `Number("")` is 0, so the old parse fired the refresh immediately after
// every request: ~8 extra Cloud Code quota calls per Antigravity request.
import test from "node:test";
import assert from "node:assert/strict";

const { getProviderLimitsPostUsageRefreshDelayMs } =
  await import("../../src/lib/usage/providerLimits.ts");

test("unset or blank delay env uses the 5 s default, not 0", () => {
  assert.equal(getProviderLimitsPostUsageRefreshDelayMs({}), 5_000);
  assert.equal(
    getProviderLimitsPostUsageRefreshDelayMs({ PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: "" }),
    5_000
  );
  assert.equal(
    getProviderLimitsPostUsageRefreshDelayMs({ PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: " " }),
    5_000
  );
});

test("an explicit delay is honoured, including an explicit 0", () => {
  assert.equal(
    getProviderLimitsPostUsageRefreshDelayMs({
      PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: "1500",
    }),
    1_500
  );
  assert.equal(
    getProviderLimitsPostUsageRefreshDelayMs({ PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: "0" }),
    0
  );
});

test("an invalid delay falls back to the default", () => {
  for (const value of ["abc", "-5", "NaN"]) {
    assert.equal(
      getProviderLimitsPostUsageRefreshDelayMs({
        PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: value,
      }),
      5_000,
      value
    );
  }
});
