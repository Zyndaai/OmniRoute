/**
 * db/ccDiscoveryAliases.ts — Claude Code discovery-alias gate.
 *
 * Gates `claude/<provider>/<model>` mirror ids on the /v1/models catalog so
 * the Claude Code gateway's model discovery can list non-Claude models. This
 * module only owns the gate (global flag + per-provider/per-model overrides
 * + precedence resolver) — the catalog wiring itself lives elsewhere.
 *
 * Storage: `config_entries`, namespace `ccDiscoveryAliases` (raw "on"/"off" kept as
 * JSON strings). Keys:
 *   - `provider:<providerId>`              -> "on" | "off"
 *   - `model:<providerId>/<modelId>`       -> "on" | "off"
 * A missing key means "inherit" (null).
 *
 * Global enablement precedence (see `getCcAliasGlobalState`):
 *   env EXPOSE_CC_DISCOVERY_ALIASES ("1"|"true") > DB flag override > default
 * (env wins over the dashboard DB override, matching the brief — this is the
 * opposite precedence from the generic `resolveFeatureFlag` helper, which is
 * why this module resolves the flag directly instead of reusing it).
 */

import { getFeatureFlagOverride } from "./featureFlags";
import {
  deleteConfigValue,
  getConfigText,
  loadCatalogOverrideMaps,
  setConfigText,
} from "./configEntries";
import { finishModelCatalogWriteWithoutBackup } from "./models/modelCatalogWriteSignals";

const NAMESPACE = "ccDiscoveryAliases";
const FLAG_KEY = "EXPOSE_CC_DISCOVERY_ALIASES";

export type CcAliasSetting = "on" | "off" | null;

function providerKey(providerId: string): string {
  return `provider:${providerId}`;
}

function modelKey(providerId: string, modelId: string): string {
  return `model:${providerId}/${modelId}`;
}

function parseSetting(value: string | undefined): CcAliasSetting {
  if (value === "on" || value === "off") return value;
  return null;
}

/**
 * Pure precedence resolver: model setting wins over provider setting, which
 * wins over the global flag. `null`/`undefined` means "inherit" from the
 * next level down.
 */
export function resolveCcAliasEnabled(opts: {
  model?: CcAliasSetting;
  provider?: CcAliasSetting;
  global: boolean;
}): boolean {
  if (opts.model === "on") return true;
  if (opts.model === "off") return false;
  if (opts.provider === "on") return true;
  if (opts.provider === "off") return false;
  return opts.global;
}

async function writeSetting(key: string, v: CcAliasSetting): Promise<void> {
  if (v === null) await deleteConfigValue(NAMESPACE, key);
  else await setConfigText(NAMESPACE, key, v);
  finishModelCatalogWriteWithoutBackup();
}

export async function getCcAliasProviderSetting(providerId: string): Promise<CcAliasSetting> {
  return parseSetting(await getConfigText(NAMESPACE, providerKey(providerId)));
}

export async function setCcAliasProviderSetting(
  providerId: string,
  v: CcAliasSetting
): Promise<void> {
  await writeSetting(providerKey(providerId), v);
}

export async function getCcAliasModelSetting(
  providerId: string,
  modelId: string
): Promise<CcAliasSetting> {
  return parseSetting(await getConfigText(NAMESPACE, modelKey(providerId, modelId)));
}

export async function setCcAliasModelSetting(
  providerId: string,
  modelId: string,
  v: CcAliasSetting
): Promise<void> {
  await writeSetting(modelKey(providerId, modelId), v);
}

/**
 * Loads every provider/model override in a single query — intended for the
 * catalog builder, which needs the full set rather than per-row lookups.
 */
export async function getCcAliasSettingsBulk() {
  return loadCatalogOverrideMaps(NAMESPACE);
}

function envForcesGlobalOn(): boolean {
  const raw = process.env[FLAG_KEY];
  return raw === "1" || raw === "true";
}

/**
 * Resolves the effective global state, and where it came from.
 * Precedence: env forces on > DB override > definition default.
 */
export async function getCcAliasGlobalState(): Promise<{
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

export async function isCcAliasGlobalEnabled(): Promise<boolean> {
  return (await getCcAliasGlobalState()).enabled;
}
