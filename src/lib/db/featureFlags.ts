/**
 * db/featureFlags.ts — Feature flag DB overrides.
 *
 * Stores per-flag override values in `config_entries` under the "feature_flags"
 * namespace (raw text kept as a JSON string). When an override is present it takes
 * precedence over the process environment variable of the same name.
 */

import { FEATURE_FLAG_DEFINITIONS } from "@/shared/constants/featureFlagDefinitions";
import { db } from "./pg";
import {
  deleteConfigNamespace,
  deleteConfigValue,
  getConfigText,
  getConfigTextEntries,
  setConfigText,
} from "./configEntries";
import { finishModelCatalogWriteWithoutBackup } from "./models/modelCatalogWriteSignals";

const NAMESPACE = "feature_flags";

// Flag reads sit on hot paths that call them once per string leaf of a request
// body (sanitizePII, the PII masker guardrail), so a round trip per read would be
// a thousand queries for a 2 MB agentic request. The cache is invalidated by every
// writer in this module; the short TTL only covers edits made from outside this
// process (another instance, a manual change).
const OVERRIDE_CACHE_TTL_MS = 1000;
type OverrideCacheEntry = { value: string | undefined; expiresAt: number };
const overrideCache = new Map<string, OverrideCacheEntry>();

export function clearFeatureFlagOverrideCache(key?: string): void {
  if (key === undefined) overrideCache.clear();
  else overrideCache.delete(key);
}

// The synchronous resolvers (src/shared/utils/featureFlags.ts) serve their own snapshot of
// the override table. It registers here so every committed write reloads it before the
// writer returns, and the writing process reads its own change immediately.
type WriteListener = () => Promise<void>;
let writeListener: WriteListener | null = null;

export function registerFeatureFlagWriteListener(listener: WriteListener): void {
  writeListener = listener;
}

async function afterOverrideWrite(key?: string): Promise<void> {
  clearFeatureFlagOverrideCache(key);
  // The resolver module registers its listener when it loads. A writer that runs before
  // anything has read a flag loads it here (dynamic, so there is no import cycle), otherwise
  // its first synchronous read would miss this write.
  if (!writeListener) await import("@/shared/utils/featureFlags");
  if (writeListener) await writeListener();
}

const CATALOG_RELEVANT_FEATURE_FLAGS = new Set([
  "MODEL_CATALOG_INCLUDE_NAMES",
  "MODELS_CATALOG_PREFIX_MODE",
  "EXPOSE_CC_DISCOVERY_ALIASES",
  "NO_THINKING_ALIAS_ENABLED",
  "OMNIROUTE_DISABLE_THINKING_LEVEL_VARIANTS",
  "CATALOG_MIRROR_REFINEMENTS_ENABLED",
  // #16929: hides models with no runnable endpoint adapter from /v1/models.
  "MODEL_ENDPOINT_CAPABILITY_GATE_ENABLED",
  "MODELS_DEV_EFFORT_TIERS_ENABLED",
]);

/**
 * Returns all feature flag overrides as a key→value map.
 */
export async function getFeatureFlagOverrides(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const row of await getConfigTextEntries(NAMESPACE)) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Returns the override value for a single flag, or undefined if no override
 * is stored.
 */
export async function getFeatureFlagOverride(key: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = overrideCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await getConfigText(NAMESPACE, key);
  overrideCache.set(key, { value, expiresAt: now + OVERRIDE_CACHE_TTL_MS });
  return value;
}

/**
 * Persists (or replaces) an override for a single flag.
 */
export async function setFeatureFlagOverride(key: string, value: string): Promise<void> {
  const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
  if (!definition) {
    throw new Error(`Unknown feature flag key: ${key}`);
  }
  if (
    definition.type === "enum" &&
    definition.enumValues &&
    !definition.enumValues.includes(value)
  ) {
    throw new Error(
      `Invalid value "${value}" for enum flag ${key}. Allowed: ${definition.enumValues.join(", ")}`
    );
  }
  await setConfigText(NAMESPACE, key, value);
  await afterOverrideWrite(key);
  if (CATALOG_RELEVANT_FEATURE_FLAGS.has(key)) {
    finishModelCatalogWriteWithoutBackup();
  }
}

/**
 * Removes the override for a single flag, restoring env-var / default
 * behaviour.
 */
export async function removeFeatureFlagOverride(key: string): Promise<void> {
  await deleteConfigValue(NAMESPACE, key);
  await afterOverrideWrite(key);
  if (CATALOG_RELEVANT_FEATURE_FLAGS.has(key)) {
    finishModelCatalogWriteWithoutBackup();
  }
}

/**
 * Removes all stored feature flag overrides.
 */
export async function clearAllFeatureFlagOverrides(): Promise<void> {
  const relevant = await db().queryOne(
    "SELECT 1 AS hit FROM config_entries WHERE namespace = $1 AND key = ANY($2::text[]) LIMIT 1",
    [NAMESPACE, Array.from(CATALOG_RELEVANT_FEATURE_FLAGS)]
  );
  await deleteConfigNamespace(NAMESPACE);
  await afterOverrideWrite();
  if (relevant) {
    finishModelCatalogWriteWithoutBackup();
  }
}
