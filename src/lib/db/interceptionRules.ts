/**
 * db/interceptionRules.ts — Per-model web-search / web-fetch interception rules (#3384).
 *
 * CRUD against `config_entries` under namespace "interception_rules" (one row per provider).
 *
 * Resolution precedence (see resolveInterceptSearch): per-model rule > provider-level
 * rule > undefined (caller falls back to the existing native-bypass defaults).
 */

import { deleteConfigValue, getConfigEntries, setConfigValue } from "./configEntries";

const NAMESPACE = "interception_rules";

// ── Types ───────────────────────────────────────────────────────────────────

export type FetchInterceptionBackend = "firecrawl" | "jina" | "tavily";

export interface ModelInterceptionRule {
  /** true = route through OmniRoute's /v1/search; false = force native passthrough. */
  interceptSearch?: boolean;
  /** true = route through OmniRoute's /v1/web/fetch; false = force native passthrough. */
  interceptFetch?: boolean;
  fetchBackend?: FetchInterceptionBackend;
  fetchProxyUrl?: string;
}

export interface ProviderInterceptionRules {
  /** Provider-level default, used when a model has no override. */
  interceptSearch?: boolean;
  interceptFetch?: boolean;
  fetchBackend?: FetchInterceptionBackend;
  fetchProxyUrl?: string;
  /** Per-model overrides (stricter/looser than provider-level). */
  models?: Record<string, ModelInterceptionRule>;
}

// ── Cache ───────────────────────────────────────────────────────────────────

// The TTL bounds staleness when another instance sharing the database writes.
const CACHE_TTL_MS = 5_000;

let rulesCache: Map<string, ProviderInterceptionRules> | null = null;
let rulesCacheLoadedAt = 0;
let cacheGeneration = 0;

function invalidateCache(): void {
  cacheGeneration++;
  rulesCache = null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toNormalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toOptionalBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toFetchBackend(value: unknown): FetchInterceptionBackend | undefined {
  return value === "firecrawl" || value === "jina" || value === "tavily" ? value : undefined;
}

function toModelInterceptionRule(raw: unknown): ModelInterceptionRule | null {
  if (!isRecord(raw)) return null;
  const rule: ModelInterceptionRule = {
    interceptSearch: toOptionalBool(raw.interceptSearch),
    interceptFetch: toOptionalBool(raw.interceptFetch),
    fetchBackend: toFetchBackend(raw.fetchBackend),
    fetchProxyUrl: toNormalizedString(raw.fetchProxyUrl) ?? undefined,
  };
  const hasAnyField = Object.values(rule).some((v) => v !== undefined);
  return hasAnyField ? rule : null;
}

function toModelInterceptionRules(raw: unknown): Record<string, ModelInterceptionRule> {
  const models: Record<string, ModelInterceptionRule> = {};
  if (!isRecord(raw)) return models;
  for (const [modelId, val] of Object.entries(raw)) {
    const rule = toModelInterceptionRule(val);
    if (rule) models[modelId] = rule;
  }
  return models;
}

function toProviderInterceptionRules(raw: unknown): ProviderInterceptionRules | null {
  if (!isRecord(raw)) return null;
  const models = toModelInterceptionRules(raw.models);
  return {
    interceptSearch: toOptionalBool(raw.interceptSearch),
    interceptFetch: toOptionalBool(raw.interceptFetch),
    fetchBackend: toFetchBackend(raw.fetchBackend),
    fetchProxyUrl: toNormalizedString(raw.fetchProxyUrl) ?? undefined,
    models: Object.keys(models).length > 0 ? models : undefined,
  };
}

// ── Read ────────────────────────────────────────────────────────────────────

async function loadAllRules(): Promise<Map<string, ProviderInterceptionRules>> {
  const map = new Map<string, ProviderInterceptionRules>();
  for (const row of await getConfigEntries(NAMESPACE)) {
    const parsed = toProviderInterceptionRules(row.value);
    if (parsed) map.set(row.key, parsed);
  }
  return map;
}

async function loadRulesCached(): Promise<Map<string, ProviderInterceptionRules>> {
  if (rulesCache !== null && Date.now() - rulesCacheLoadedAt > CACHE_TTL_MS) rulesCache = null;
  if (rulesCache === null) {
    const generation = cacheGeneration;
    const loaded = await loadAllRules();
    // A write that landed while loading invalidated the cache: the loaded map may predate it.
    if (generation !== cacheGeneration) return loadRulesCached();
    rulesCache = loaded;
    rulesCacheLoadedAt = Date.now();
  }
  return rulesCache;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Get the interception rules for a single provider, or null if not configured. */
export async function getInterceptionRules(
  provider: string
): Promise<ProviderInterceptionRules | null> {
  return toNormalizedString(provider) ? ((await loadRulesCached()).get(provider) ?? null) : null;
}

/** Upsert the entire interception rule set for a provider. Invalidates the cache. */
export async function setInterceptionRules(
  provider: string,
  rules: ProviderInterceptionRules
): Promise<void> {
  const normalizedProvider = toNormalizedString(provider);
  if (!normalizedProvider) return;

  const normalized: ProviderInterceptionRules = {
    interceptSearch: rules.interceptSearch,
    interceptFetch: rules.interceptFetch,
    fetchBackend: rules.fetchBackend,
    fetchProxyUrl: rules.fetchProxyUrl,
    models: rules.models && Object.keys(rules.models).length > 0 ? rules.models : undefined,
  };

  await setConfigValue(NAMESPACE, normalizedProvider, normalized);
  invalidateCache();
}

/** Delete the interception rules for a provider. Resets that provider to default behavior. */
export async function deleteInterceptionRules(provider: string): Promise<void> {
  const normalizedProvider = toNormalizedString(provider);
  if (!normalizedProvider) return;

  await deleteConfigValue(NAMESPACE, normalizedProvider);
  invalidateCache();
}

/**
 * Resolve the effective `interceptSearch` override for a provider/model pair.
 *
 * Precedence: per-model rule > provider-level rule > undefined (no override — the
 * caller should fall back to the existing native-bypass defaults).
 */
export async function resolveInterceptSearch(
  provider: string | null | undefined,
  model: string | null | undefined
): Promise<boolean | undefined> {
  const normalizedProvider = toNormalizedString(provider);
  if (!normalizedProvider) return undefined;

  const rules = await getInterceptionRules(normalizedProvider);
  if (!rules) return undefined;

  const normalizedModel = toNormalizedString(model);
  if (normalizedModel && rules.models?.[normalizedModel]?.interceptSearch !== undefined) {
    return rules.models[normalizedModel].interceptSearch;
  }

  return rules.interceptSearch;
}

/**
 * Resolve the effective `interceptFetch` override for a provider/model pair.
 *
 * Precedence: per-model rule > provider-level rule > undefined (no override — the
 * caller should fall back to the existing native-bypass defaults). Structural twin of
 * resolveInterceptSearch above (#7339 / Phase 3 of #3384).
 */
export async function resolveInterceptFetch(
  provider: string | null | undefined,
  model: string | null | undefined
): Promise<boolean | undefined> {
  const normalizedProvider = toNormalizedString(provider);
  if (!normalizedProvider) return undefined;

  const rules = await getInterceptionRules(normalizedProvider);
  if (!rules) return undefined;

  const normalizedModel = toNormalizedString(model);
  if (normalizedModel && rules.models?.[normalizedModel]?.interceptFetch !== undefined) {
    return rules.models[normalizedModel].interceptFetch;
  }

  return rules.interceptFetch;
}
