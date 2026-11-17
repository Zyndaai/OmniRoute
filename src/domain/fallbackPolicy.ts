/**
 * Fallback Policy — Domain Layer (T-19)
 *
 * Declarative fallback chain for model routing.
 * When a primary provider is unavailable, the policy engine
 * resolves to alternative providers in priority order.
 *
 * State is persisted in SQLite via domainState.js.
 *
 * @module domain/fallbackPolicy
 */

import {
  saveFallbackChain,
  loadFallbackChain,
  loadAllFallbackChains,
  deleteFallbackChain,
  deleteAllFallbackChains,
} from "../lib/db/domainState";

/**
 * @typedef {Object} FallbackEntry
 * @property {string} provider - Provider ID
 * @property {number} [priority=0] - Lower = higher priority
 * @property {boolean} [enabled=true] - Whether this fallback is active
 */

/** @type {Map<string, FallbackEntry[]>} In-memory cache backed by SQLite */
const fallbackChains = new Map();

/** @type {boolean} Whether we've loaded from DB yet */
let _loaded = false;
/** @type {Promise<void> | null} In-flight hydration shared by concurrent callers */
let _loading = null;

/**
 * Ensure in-memory cache is hydrated from the database.
 */
async function ensureLoaded() {
  if (_loaded) return;
  if (!_loading) {
    _loading = (async () => {
      try {
        const all = await loadAllFallbackChains();
        for (const [model, chain] of Object.entries(all)) {
          if (!fallbackChains.has(model)) fallbackChains.set(model, chain);
        }
      } catch {
        // DB may not be ready yet (build phase), that's ok
      }
      _loaded = true;
      _loading = null;
    })();
  }
  await _loading;
}

/**
 * Register a fallback chain for a model.
 *
 * @param {string} model - Model identifier (e.g. "gpt-4o")
 * @param {FallbackEntry[]} chain - Ordered list of fallback providers
 */
export async function registerFallback(model, chain) {
  await ensureLoaded();
  const sorted = [...chain]
    .map((e) => ({
      provider: e.provider,
      priority: e.priority ?? 0,
      enabled: e.enabled ?? true,
    }))
    .sort((a, b) => a.priority - b.priority);

  fallbackChains.set(model, sorted);
  try {
    await saveFallbackChain(model, sorted);
  } catch {
    // Non-critical: in-memory still works
  }
}

/**
 * Resolve the fallback chain for a model.
 * Returns only enabled providers, sorted by priority.
 *
 * @param {string} model
 * @param {string[]} [excludeProviders=[]] - Providers to skip (e.g. already tried)
 * @returns {Promise<FallbackEntry[]>} Ordered list of fallback providers
 */
export async function resolveFallbackChain(model, excludeProviders = []) {
  await ensureLoaded();
  const chain = fallbackChains.get(model);
  if (!chain) return [];

  const excludeSet = new Set(excludeProviders);
  return chain.filter((e) => e.enabled && !excludeSet.has(e.provider));
}

/**
 * Get the next provider in the fallback chain.
 *
 * @param {string} model
 * @param {string[]} [excludeProviders=[]]
 * @returns {Promise<string | null>} Next provider ID or null if chain exhausted
 */
export async function getNextFallback(model, excludeProviders = []) {
  const chain = await resolveFallbackChain(model, excludeProviders);
  return chain.length > 0 ? chain[0].provider : null;
}

/**
 * Check if a model has any fallback providers configured.
 *
 * @param {string} model
 * @returns {Promise<boolean>}
 */
export async function hasFallback(model) {
  await ensureLoaded();
  const chain = fallbackChains.get(model);
  return !!chain && chain.some((e) => e.enabled);
}

/**
 * Remove a fallback chain for a model.
 *
 * @param {string} model
 * @returns {Promise<boolean>} true if removed
 */
export async function removeFallback(model) {
  await ensureLoaded();
  const removed = fallbackChains.delete(model);
  if (removed) {
    try {
      await deleteFallbackChain(model);
    } catch {
      // Non-critical
    }
  }
  return removed;
}

/**
 * Get all registered fallback chains (for dashboard).
 *
 * @returns {Promise<Record<string, FallbackEntry[]>>}
 */
export async function getAllFallbackChains() {
  await ensureLoaded();
  /** @type {Record<string, FallbackEntry[]>} */
  const result = {};
  for (const [model, chain] of fallbackChains.entries()) {
    result[model] = chain;
  }
  return result;
}

/**
 * Reset all fallback chains (for testing).
 */
export async function resetAllFallbacks() {
  fallbackChains.clear();
  _loaded = false;
  try {
    await deleteAllFallbackChains();
  } catch {
    // Non-critical
  }
}
