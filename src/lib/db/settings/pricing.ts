/**
 * db/settings/pricing.ts — Pricing data CRUD (user overrides, LiteLLM sync, models.dev sync).
 */

import { db, jsonb } from "../pg";
import {
  clearPricingSource,
  deletePricingProvider,
  readPricingSource,
  writePricingProvider,
  type PricingSourceName,
} from "../modelPricing";
import { getCachedPricing, invalidateDbCache } from "../readCache";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { invalidateUserPricingMemo } from "@/lib/catalogUserPricing";
import { type JsonRecord, toRecord } from "./shared";

type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
export type PricingSource = "default" | "litellm" | "modelsDev" | "user";
export type PricingSourceMap = Record<string, Record<string, PricingSource>>;

async function touchPricing(): Promise<void> {
  invalidateDbCache("pricing");
  invalidateUserPricingMemo();
  try {
    const { clearTierCache } = await import("@omniroute/open-sse/services/tierResolver");
    await clearTierCache();
  } catch {
    // fail-open: a missed tier invalidation must never break a price write
  }
}

async function readPricingNamespace(source: PricingSourceName): Promise<PricingByProvider> {
  return (await readPricingSource(source)) as PricingByProvider;
}

function mergePricingLayers(layers: PricingByProvider[]): PricingByProvider {
  const mergedPricing: PricingByProvider = {};

  for (const layer of layers) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
        continue;
      }

      for (const [model, pricing] of Object.entries(models)) {
        mergedPricing[provider][model] = mergedPricing[provider][model]
          ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
          : pricing;
      }
    }
  }

  return mergedPricing;
}

function buildPricingSourceMap(layers: {
  defaults: PricingByProvider;
  litellm: PricingByProvider;
  modelsDev: PricingByProvider;
  user: PricingByProvider;
}): PricingSourceMap {
  const sourceMap: PricingSourceMap = {};
  const mergedPricing = mergePricingLayers([
    layers.defaults,
    layers.litellm,
    layers.modelsDev,
    layers.user,
  ]);

  for (const [provider, models] of Object.entries(mergedPricing)) {
    sourceMap[provider] = {};

    for (const model of Object.keys(models)) {
      if (layers.user[provider]?.[model]) {
        sourceMap[provider][model] = "user";
      } else if (layers.modelsDev[provider]?.[model]) {
        sourceMap[provider][model] = "modelsDev";
      } else if (layers.litellm[provider]?.[model]) {
        sourceMap[provider][model] = "litellm";
      } else {
        sourceMap[provider][model] = "default";
      }
    }
  }

  return sourceMap;
}

async function getPricingLayers() {
  // Layer 1: Hardcoded defaults (lowest priority)
  const { getDefaultPricing } = await import("@/shared/constants/pricing");
  const [litellm, modelsDev, user] = await Promise.all([
    readPricingNamespace("litellm"),
    readPricingNamespace("models_dev"),
    readPricingNamespace("user"),
  ]);
  return { defaults: getDefaultPricing(), litellm, modelsDev, user };
}

export async function getPricing() {
  const layers = await getPricingLayers();
  // Merge: defaults → LiteLLM → models.dev → user (each layer overrides the previous)
  return mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]);
}

export async function getPricingWithSources(): Promise<{
  pricing: PricingByProvider;
  sourceMap: PricingSourceMap;
}> {
  const layers = await getPricingLayers();
  return {
    pricing: mergePricingLayers([layers.defaults, layers.litellm, layers.modelsDev, layers.user]),
    sourceMap: buildPricingSourceMap(layers),
  };
}

/** Case-insensitive key lookup; returns the first matching key in insertion order. */
type PricingKeyFinder = <T>(
  obj: Record<string, T> | undefined | null,
  key: string
) => T | undefined;

function findKeyInsensitive<T>(obj: Record<string, T> | undefined | null, key: string) {
  if (!obj || !key) return undefined;
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lowerKey) return v;
  }
  return undefined;
}

/**
 * Provider half of {@link getPricingForModel}: the provider's model table in a merged
 * pricing table, matched by id, alias, reverse alias, then without a `-cn` suffix.
 * Pure, so the `/v1/models` catalog can resolve prices with the same rules from one
 * in-memory table (`find` lets it pass an indexed finder with identical semantics).
 */
export function findProviderPricing(
  pricing: PricingByProvider,
  provider: string,
  find: PricingKeyFinder = findKeyInsensitive
): PricingModels | null {
  const pLower = (provider || "").toLowerCase();
  let providerPricing = find<PricingModels>(pricing, pLower);

  if (!providerPricing) {
    const alias = find<string>(PROVIDER_ID_TO_ALIAS, pLower);
    if (alias) providerPricing = find(pricing, alias);
  }

  if (!providerPricing) {
    for (const [id, mappedAlias] of Object.entries(PROVIDER_ID_TO_ALIAS)) {
      if (typeof mappedAlias === "string" && mappedAlias.toLowerCase() === pLower) {
        providerPricing = find(pricing, id);
        if (providerPricing) break;
      }
    }
  }

  if (!providerPricing) {
    const np = pLower.replace(/-cn$/, "");
    if (np && np !== pLower) {
      providerPricing = find(pricing, np);
    }
  }

  return providerPricing || null;
}

/** Model half of {@link getPricingForModel}: exact id, then dots replaced by hyphens. */
export function findModelPricing(
  providerPricing: PricingModels,
  model: string,
  find: PricingKeyFinder = findKeyInsensitive
): JsonRecord | null {
  const mLower = (model || "").toLowerCase();
  return (
    find<JsonRecord>(providerPricing, mLower) ||
    find<JsonRecord>(providerPricing, mLower.replace(/\./g, "-")) ||
    null
  );
}

export async function getPricingForModel(provider: string, model: string) {
  const pricing = (await getCachedPricing()) as PricingByProvider;
  const providerPricing = findProviderPricing(pricing, provider);
  return providerPricing ? findModelPricing(providerPricing, model) : null;
}

export async function updatePricing(pricingData: PricingByProvider) {
  // The upsert merges per provider in SQL (`||` keeps the stored models and overwrites the
  // ones in `pricingData`), so two concurrent updates cannot drop each other's models.
  await db().transaction(async (tx) => {
    for (const [provider, models] of Object.entries(pricingData)) {
      await tx.execute(
        `INSERT INTO model_pricing (source, provider, models) VALUES ('user', $1, $2::jsonb)
         ON CONFLICT (source, provider)
         DO UPDATE SET models = model_pricing.models || EXCLUDED.models, updated_at = now()`,
        [provider, jsonb(models)]
      );
    }
  });
  await touchPricing();
  return readPricingNamespace("user");
}

export async function resetPricing(provider: string, model?: string) {
  if (model) {
    await db().transaction(async (tx) => {
      const models = await tx.queryOne<{ models: unknown }>(
        "SELECT models FROM model_pricing WHERE source = 'user' AND provider = $1 FOR UPDATE",
        [provider]
      );
      if (!models) return;
      const next = { ...toRecord(models.models) };
      delete next[model];
      if (Object.keys(next).length === 0) await deletePricingProvider("user", provider, tx);
      else await writePricingProvider("user", provider, next, tx);
    });
  } else {
    await deletePricingProvider("user", provider);
  }

  await touchPricing();
  return readPricingNamespace("user") as Promise<Record<string, unknown>>;
}

export async function resetAllPricing() {
  await clearPricingSource("user");
  await touchPricing();
  return {};
}
