/**
 * db/paramFilters.ts — Provider/Model parameter filter configuration.
 *
 * CRUD against `config_entries` under namespace "provider_param_filters" (one row per provider,
 * plus `__global__` for the global auto-learn flag).
 */

import { db, type DbExecutor } from "./pg";
import {
  deleteConfigValue,
  getConfigEntries,
  getConfigValue,
  setConfigValue,
} from "./configEntries";

const NAMESPACE = "provider_param_filters";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ModelParamFilter {
  block?: string[];
  allow?: string[];
}

export interface ProviderParamFilter {
  /** Provider-level params to strip from all requests to this provider. */
  block: string[];
  /** Provider-level params to re-add after denylist stripping. */
  allow: string[];
  /** Model-specific overrides (stricter than provider-level). */
  models?: Record<string, ModelParamFilter>;
  /** When true, upstream 400 "Unsupported parameter" errors auto-populate block. */
  autoLearn?: boolean;
}

// ── Cache ───────────────────────────────────────────────────────────────────

// The TTL bounds staleness when another instance sharing the database writes.
const CACHE_TTL_MS = 5_000;

let filterCache: Map<string, ProviderParamFilter> | null = null;
let filterCacheLoadedAt = 0;
let cacheGeneration = 0;

function bumpCacheGeneration(): void {
  cacheGeneration++;
  filterCache = null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNormalizedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : [];
}

function toModelParamFilter(raw: Record<string, unknown>): ModelParamFilter | null {
  const block = toStringArray(raw.block);
  const allow = toStringArray(raw.allow);
  if (block.length === 0 && allow.length === 0) return null;
  const filter: ModelParamFilter = {};
  if (block.length > 0) filter.block = block;
  if (allow.length > 0) filter.allow = allow;
  return filter;
}

function toModelParamFilters(raw: unknown): Record<string, ModelParamFilter> {
  const models: Record<string, ModelParamFilter> = {};
  if (!isRecord(raw)) return models;
  for (const [modelId, val] of Object.entries(raw)) {
    if (!isRecord(val)) continue;
    const filter = toModelParamFilter(val);
    if (filter) models[modelId] = filter;
  }
  return models;
}

function toProviderParamFilter(raw: unknown): ProviderParamFilter | null {
  if (!isRecord(raw)) return null;
  const block = toStringArray(raw.block);
  const allow = toStringArray(raw.allow);
  const models = toModelParamFilters(raw.models);
  const autoLearn = typeof raw.autoLearn === "boolean" ? raw.autoLearn : false;
  return { block, allow, models: Object.keys(models).length > 0 ? models : undefined, autoLearn };
}

// ── Read ────────────────────────────────────────────────────────────────────

async function loadAllConfigs(): Promise<Map<string, ProviderParamFilter>> {
  const map = new Map<string, ProviderParamFilter>();
  for (const row of await getConfigEntries(NAMESPACE)) {
    const parsed = toProviderParamFilter(row.value);
    if (parsed) {
      map.set(row.key, parsed);
    }
  }
  return map;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Warm the cache so the first call to getParamFilterConfig does not hit the DB.
 * Idempotent — subsequent calls return the cached map.
 */
export async function loadParamFilterConfigs(): Promise<Map<string, ProviderParamFilter>> {
  if (filterCache !== null && Date.now() - filterCacheLoadedAt > CACHE_TTL_MS) filterCache = null;
  if (filterCache === null) {
    const generation = cacheGeneration;
    const loaded = await loadAllConfigs();
    // A write that landed while loading bumped the generation: the loaded map may predate it.
    if (generation !== cacheGeneration) return loadParamFilterConfigs();
    filterCache = loaded;
    filterCacheLoadedAt = Date.now();
  }
  return filterCache;
}

/**
 * Get the param filter config for a single provider, or null if not configured.
 * Uses an in-memory cache refreshed on write.
 */
export async function getParamFilterConfig(provider: string): Promise<ProviderParamFilter | null> {
  return toNormalizedString(provider)
    ? ((await loadParamFilterConfigs()).get(provider) ?? null)
    : null;
}

function normalizeConfig(config: ProviderParamFilter): ProviderParamFilter {
  return {
    block: config.block ?? [],
    allow: config.allow ?? [],
    autoLearn: config.autoLearn ?? false,
    models: config.models && Object.keys(config.models).length > 0 ? config.models : undefined,
  };
}

/**
 * Upsert the entire param filter config for a provider.
 * Invalidates the in-memory cache. With a transaction executor the caller invalidates
 * after it commits (invalidating earlier lets a concurrent reader cache the pre-commit rows).
 */
export async function setParamFilterConfig(
  provider: string,
  config: ProviderParamFilter,
  ex?: DbExecutor
): Promise<void> {
  if (!toNormalizedString(provider)) return;

  await setConfigValue(NAMESPACE, provider, normalizeConfig(config), ex);
  if (!ex) bumpCacheGeneration();
}

/**
 * Delete the param filter config for a provider.
 * Resets to no filtering for that provider.
 */
export async function deleteParamFilterConfig(provider: string): Promise<void> {
  if (!toNormalizedString(provider)) return;

  await deleteConfigValue(NAMESPACE, provider);
  bumpCacheGeneration();
}

// ── Global auto-learn flag ──────────────────────────────────────────────────

const GLOBAL_AUTOLEARN_KEY = "__global__";

/**
 * Check whether the global auto-learn flag is enabled.
 * When enabled, ALL providers auto-learn unsupported params from 400 errors
 * regardless of their per-provider autoLearn setting.
 * Only fires when this is explicitly configured, else returns false.
 */
export async function isAutoLearnGloballyEnabled(): Promise<boolean> {
  const globalCfg = await getParamFilterConfig(GLOBAL_AUTOLEARN_KEY);
  return globalCfg?.autoLearn === true;
}

/**
 * Enable or disable global auto-learn globally for all providers.
 * When enabled, the per-provider autoLearn flag is still honored after
 * the global check (either being on is sufficient to trigger auto-learn).
 */
export async function setGlobalAutoLearnEnabled(enabled: boolean): Promise<void> {
  const existing = await getParamFilterConfig(GLOBAL_AUTOLEARN_KEY);
  await setParamFilterConfig(GLOBAL_AUTOLEARN_KEY, {
    block: existing?.block ?? [],
    allow: existing?.allow ?? [],
    autoLearn: enabled,
  });
}

/**
 * Auto-learn helper: add a single parameter to a provider's block list.
 * If the field is already in the block list (or the config does not exist),
 * this is a no-op. Optionally scoped to a specific model.
 *
 * The stored document is read and rewritten whole, so the read runs inside a transaction
 * holding a per-provider advisory lock: two upstream 400s learning different params at once
 * both land.
 */
export async function addParamToBlocklist(
  provider: string,
  paramName: string,
  model?: string
): Promise<void> {
  if (!toNormalizedString(provider) || !toNormalizedString(paramName)) return;

  let written = false;
  await db().transaction(async (tx) => {
    await tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `provider_param_filters:${provider}`,
    ]);
    const stored = toProviderParamFilter(await getConfigValue(NAMESPACE, provider, tx));
    const existing: ProviderParamFilter = stored ?? {
      block: [],
      allow: [],
      autoLearn: false,
    };

    if (model) {
      // Model-level
      const models = existing.models ?? {};
      const modelCfg = models[model] ?? {};

      if (Array.isArray(modelCfg.block) && modelCfg.block.includes(paramName)) return;

      const updatedBlock = [...(modelCfg.block ?? []), paramName];
      models[model] = { ...modelCfg, block: updatedBlock };
      existing.models = models;
    } else {
      // Provider-level
      if (existing.block.includes(paramName)) return;
      existing.block = [...existing.block, paramName];
    }

    await setParamFilterConfig(provider, existing, tx);
    written = true;
  });
  if (written) bumpCacheGeneration();
}
