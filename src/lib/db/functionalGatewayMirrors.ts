/**
 * db/functionalGatewayMirrors.ts — functional-gateway mirror gate.
 *
 * Storage: `config_entries`, namespace `functionalGatewayMirrors`, following the
 * ccDiscoveryAliases pattern (raw "on"/"off" kept as JSON strings). Global flag
 * `EXPOSE_FUNCTIONAL_GATEWAY_MIRRORS` (env "1"|"true" > DB flag > default false).
 * Provider/model overrides stored as `provider:<id>` and `model:<provider>/<model>` keys.
 */
import { getFeatureFlagOverride } from "./featureFlags";
import {
  deleteConfigValue,
  getConfigText,
  loadCatalogOverrideMaps,
  setConfigText,
} from "./configEntries";

const NAMESPACE = "functionalGatewayMirrors";
const FLAG_KEY = "EXPOSE_FUNCTIONAL_GATEWAY_MIRRORS";

export type FunctionalGatewaySetting = "on" | "off" | null;

function parseSetting(value: string | undefined): FunctionalGatewaySetting {
  if (value === "on" || value === "off") return value;
  return null;
}

function providerKey(providerId: string): string {
  return `provider:${providerId}`;
}

function modelKey(modelId: string): string {
  return `model:${modelId}`;
}

async function writeSetting(key: string, v: FunctionalGatewaySetting): Promise<void> {
  if (v === null) await deleteConfigValue(NAMESPACE, key);
  else await setConfigText(NAMESPACE, key, v);
}

export async function getFunctionalGatewayProviderSetting(
  providerId: string
): Promise<FunctionalGatewaySetting> {
  return parseSetting(await getConfigText(NAMESPACE, providerKey(providerId)));
}

export async function setFunctionalGatewayProviderSetting(
  providerId: string,
  v: FunctionalGatewaySetting
): Promise<void> {
  await writeSetting(providerKey(providerId), v);
}

export async function getFunctionalGatewayModelSetting(
  modelId: string
): Promise<FunctionalGatewaySetting> {
  return parseSetting(await getConfigText(NAMESPACE, modelKey(modelId)));
}

export async function setFunctionalGatewayModelSetting(
  modelId: string,
  v: FunctionalGatewaySetting
): Promise<void> {
  await writeSetting(modelKey(modelId), v);
}

export async function getFunctionalGatewaySettingsBulk() {
  return loadCatalogOverrideMaps(NAMESPACE);
}

function envForcesGlobalOn(): boolean {
  const raw = process.env[FLAG_KEY];
  return raw === "1" || raw === "true";
}

export async function getFunctionalGatewayGlobalState(): Promise<{
  enabled: boolean;
  source: "env" | "db" | "default";
}> {
  if (envForcesGlobalOn()) {
    return { enabled: true, source: "env" };
  }

  const dbOverride = await getFeatureFlagOverride(FLAG_KEY);
  if (dbOverride !== undefined) {
    return { enabled: dbOverride === "true" || dbOverride === "1", source: "db" };
  }

  return { enabled: false, source: "default" };
}

export async function isFunctionalGatewayGlobalEnabled(): Promise<boolean> {
  return (await getFunctionalGatewayGlobalState()).enabled;
}
