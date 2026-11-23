import { test, after } from "node:test";
import assert from "node:assert/strict";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
import {
  removeFeatureFlagOverride,
  setFeatureFlagOverride,
} from "../../../src/lib/db/featureFlags.ts";
import {
  getFunctionalGatewayGlobalState,
  getFunctionalGatewayProviderSetting,
  getFunctionalGatewayModelSetting,
  setFunctionalGatewayProviderSetting,
  setFunctionalGatewayModelSetting,
  getFunctionalGatewaySettingsBulk,
} from "../../../src/lib/db/functionalGatewayMirrors.ts";

const FLAG_KEY = "EXPOSE_FUNCTIONAL_GATEWAY_MIRRORS";

after(async () => {
  await removeFeatureFlagOverride(FLAG_KEY);
  await resetDbInstance();
});

test("global state defaults to off", async () => {
  const { enabled } = await getFunctionalGatewayGlobalState();
  assert.equal(enabled, false);
});

test("can flip global on via feature-flag override (the dashboard/env mechanism)", async () => {
  await setFeatureFlagOverride(FLAG_KEY, "true");
  const { enabled, source } = await getFunctionalGatewayGlobalState();
  assert.equal(enabled, true);
  assert.equal(source, "db");
});

test("provider and model settings default to null", async () => {
  assert.equal(await getFunctionalGatewayProviderSetting("agentrouter"), null);
  assert.equal(
    await getFunctionalGatewayModelSetting("agentrouter/deepseek/deepseek-v4-flash"),
    null
  );
});

test("bulk settings reflect provider/model overrides", async () => {
  await setFunctionalGatewayProviderSetting("agentrouter", "on");
  await setFunctionalGatewayModelSetting("openrouter/deepseek/deepseek-v4-flash", "off");
  const { providers, models } = await getFunctionalGatewaySettingsBulk();
  assert.equal(providers.get("agentrouter"), "on");
  assert.equal(models.get("openrouter/deepseek/deepseek-v4-flash"), "off");
  await setFunctionalGatewayProviderSetting("agentrouter", null);
  await setFunctionalGatewayModelSetting("openrouter/deepseek/deepseek-v4-flash", null);
});
