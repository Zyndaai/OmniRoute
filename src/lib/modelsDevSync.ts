/**
 * modelsDevSync.ts — Fetch model specs, pricing, and capabilities from models.dev
 *
 * models.dev (https://github.com/anomalyco/models.dev) is an open-source database
 * of AI model specifications maintained by the SST/OpenCode team (MIT license).
 *
 * API: https://models.dev/api.json
 * - 109 providers, 4,146+ models
 * - Data: pricing, capabilities, limits, modalities, metadata
 *
 * Resolution order (highest → lowest):
 *   1. User overrides (`pricing` namespace)
 *   2. models.dev sync (`models_dev_pricing` namespace)
 *   3. LiteLLM sync (`pricing_synced` namespace)
 *   4. Hardcoded defaults (`pricing.ts`)
 *
 * Settings UI (`modelsDevSyncEnabled`) controls the periodic sync by default.
 * `MODELS_DEV_SYNC_ENABLED=0|false|off|no` is a hard kill switch: it wins over
 * the DB setting so an operator can recover a wedged process (dashboard /
 * /healthz frozen on the same event loop — #10052) without the UI. Unset =
 * honor settings. `1|true|on|yes` forces sync on even if the setting is off.
 */

import { db, type DbExecutor } from "./db/pg";
import { jsonTextParam, jsonToText } from "./db/pgJsonText";
import { clearPricingSource, readPricingSource, replacePricingSource } from "./db/modelPricing";
import { invalidateDbCache, getModelCatalogCacheVersion } from "./db/readCache";
import { preserveStoredModalitySets } from "./db/models/capabilityModalities";

import {
  transformModelsDevToPricing,
  transformModelsDevToCapabilities,
} from "./modelsDevSync/transform";
import type {
  PricingByProvider,
  ModelCapabilityEntry,
  CapabilitiesByProvider,
  ModelsDevData,
} from "./modelsDevSync/transform";

// Re-export the pure transform layer (moved to ./modelsDevSync/transform)
// so this module's public API is unchanged.
export {
  mapProviderId,
  transformModelsDevToPricing,
  transformModelsDevToCapabilities,
} from "./modelsDevSync/transform";
export type {
  ModelCapabilityEntry,
  CapabilitiesByProvider,
  PricingByProvider,
} from "./modelsDevSync/transform";

// ─── Types ───────────────────────────────────────────────

interface SyncStatus {
  enabled: boolean;
  lastSync: string | null;
  lastSyncModelCount: number;
  lastSyncCapabilityCount: number;
  nextSync: string | null;
  intervalMs: number;
}

interface SyncResult {
  success: boolean;
  modelCount: number;
  providerCount: number;
  capabilityCount: number;
  dryRun: boolean;
  data?: { pricing: PricingByProvider; capabilities: CapabilitiesByProvider };
  error?: string;
}

// ─── Configuration ───────────────────────────────────────

const MODELS_DEV_API_URL = "https://models.dev/api.json";

const parsedInterval = parseInt(process.env.MODELS_DEV_SYNC_INTERVAL || "86400", 10);
const SYNC_INTERVAL_MS =
  Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval * 1000 : 86400 * 1000;

/** Parse MODELS_DEV_SYNC_ENABLED. Invalid / empty → unset (honor DB settings). */
export function readModelsDevSyncEnvFlag(
  value: string | undefined = process.env.MODELS_DEV_SYNC_ENABLED
): "true" | "false" | "unset" {
  if (value == null) return "unset";
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return "unset";
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return "true";
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return "false";
  }
  return "unset";
}

export function isModelsDevSyncEnvDisabled(): boolean {
  return readModelsDevSyncEnvFlag() === "false";
}

export function isModelsDevSyncEnvForcedOn(): boolean {
  return readModelsDevSyncEnvFlag() === "true";
}

// ─── Periodic sync state ─────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
let activeSyncAbortController: AbortController | null = null;
let activeSyncPromise: Promise<SyncResult> | null = null;
let activePeriodicSyncToken: { stopped: boolean } | null = null;
let lastSyncTime: string | null = null;
let lastSyncModelCount = 0;
let lastSyncCapabilityCount = 0;
let activeSyncIntervalMs = SYNC_INTERVAL_MS;
let cachedData: ModelsDevData | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let cachedCapabilities: CapabilitiesByProvider | null = null;
let cachedCapabilitiesLoadedAll = false;
let cachedCapabilitiesLoadedAt = 0;
let capabilitiesFullLoad: Promise<CapabilitiesByProvider> | null = null;
/**
 * A full in-memory copy of model_capabilities is reused for this long. The sync job runs in
 * one process; other processes on the same database pick its result up within this window.
 */
const CAPABILITIES_REFRESH_MS = 5 * 60 * 1000;

function markCapabilitiesFullyLoaded(data: CapabilitiesByProvider): void {
  cachedCapabilities = data;
  cachedCapabilitiesLoadedAll = true;
  cachedCapabilitiesLoadedAt = Date.now();
}

/** Drops the in-memory copy so the next lookup reads the table again (tests, after truncation). */
export function resetSyncedCapabilitiesCache(): void {
  cachedCapabilities = null;
  cachedCapabilitiesLoadedAll = false;
  cachedCapabilitiesLoadedAt = 0;
}

function hasFreshFullCapabilities(): boolean {
  return (
    cachedCapabilitiesLoadedAll && Date.now() - cachedCapabilitiesLoadedAt < CAPABILITIES_REFRESH_MS
  );
}
const MODELS_DEV_ABORT_ERROR = "AbortError";

function createAbortError(): Error {
  const error = new Error("models.dev sync aborted");
  error.name = MODELS_DEV_ABORT_ERROR;
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === MODELS_DEV_ABORT_ERROR;
}

function createAbortedSyncResult(dryRun: boolean): SyncResult {
  return {
    success: false,
    modelCount: 0,
    providerCount: 0,
    capabilityCount: 0,
    dryRun,
    error: "aborted",
  };
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── Core: Fetch ─────────────────────────────────────────

/**
 * Fetch raw data from models.dev API.
 * Uses in-memory cache with 24h TTL to avoid repeated fetches.
 */
export async function fetchModelsDev(signal?: AbortSignal): Promise<ModelsDevData> {
  // Return cached data if still fresh
  if (cachedData && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedData;
  }

  const response = await fetch(MODELS_DEV_API_URL, {
    signal: signal ?? AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`models.dev fetch failed [${response.status}]: ${response.statusText}`);
  }
  const text = await response.text();
  try {
    const data = JSON.parse(text) as ModelsDevData;
    cachedData = data;
    cacheTime = Date.now();
    return data;
  } catch {
    throw new Error(`models.dev returned invalid JSON (${text.slice(0, 100)}...)`);
  }
}

// ─── DB: models.dev pricing namespace ────────────────────

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseReasoningEfforts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const efforts = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  return efforts.length > 0 ? efforts : null;
}

/** Nullable boolean column: real booleans from Postgres, NULL stays "unknown". */
function toTriState(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

function mapCapabilityRecord(record: Record<string, unknown>): ModelCapabilityEntry {
  return {
    tool_call: toTriState(record.tool_call),
    reasoning: toTriState(record.reasoning),
    attachment: toTriState(record.attachment),
    structured_output: toTriState(record.structured_output),
    temperature: toTriState(record.temperature),
    modalities_input: jsonToText(record.modalities_input) ?? "[]",
    modalities_output: jsonToText(record.modalities_output) ?? "[]",
    knowledge_cutoff: typeof record.knowledge_cutoff === "string" ? record.knowledge_cutoff : null,
    release_date: typeof record.release_date === "string" ? record.release_date : null,
    last_updated: typeof record.last_updated === "string" ? record.last_updated : null,
    status: typeof record.status === "string" ? record.status : null,
    family: typeof record.family === "string" ? record.family : null,
    open_weights: toTriState(record.open_weights),
    limit_context: typeof record.limit_context === "number" ? record.limit_context : null,
    limit_input: typeof record.limit_input === "number" ? record.limit_input : null,
    limit_output: typeof record.limit_output === "number" ? record.limit_output : null,
    interleaved_field:
      typeof record.interleaved_field === "string" ? record.interleaved_field : null,
    reasoning_efforts: parseReasoningEfforts(record.reasoning_efforts),
  };
}

// #8697: getModelsDevPricing() re-ran the SELECT + JSON.parse of ~180 blobs on
// every call — called once per catalog model (up to ~6091x) instead of once per
// request, freezing the whole server 41-54s on a cold /v1/models rebuild.
// Memoized here, invalidated via the same modelCatalogCacheVersion signal
// save/clearModelsDevPricing already bump through invalidateDbCache("pricing") —
// reusing the existing pattern (getCachedRawProviderConnections et al. in
// db/readCache.ts) instead of introducing a new invalidation mechanism.
let pricingMemo: PricingByProvider | null = null;
let pricingMemoVersion = -1; // -1: never equals a real cacheVersion (starts at 0), guarantees a miss on the first call

/**
 * Read synced pricing from `models_dev_pricing` namespace.
 * Results are memoized until `saveModelsDevPricing` / `clearModelsDevPricing`.
 */
export async function getModelsDevPricing(): Promise<PricingByProvider> {
  // Kill switch: skip the query entirely so a leftover models.dev price table
  // cannot pin the event loop (#9685 / #10052).
  if (isModelsDevSyncEnvDisabled()) {
    return {};
  }

  const currentVersion = getModelCatalogCacheVersion();
  if (pricingMemo !== null && pricingMemoVersion === currentVersion) {
    return pricingMemo;
  }

  const synced = (await readPricingSource("models_dev")) as PricingByProvider;
  pricingMemo = synced;
  pricingMemoVersion = currentVersion;
  return synced;
}

/**
 * Save synced pricing (`model_pricing` rows of source `models_dev`, full replace).
 */
export async function saveModelsDevPricing(data: PricingByProvider): Promise<void> {
  await replacePricingSource("models_dev", data);
  invalidateDbCache("pricing");
}

/**
 * Clear all models.dev synced pricing data.
 */
export async function clearModelsDevPricing(): Promise<void> {
  await clearPricingSource("models_dev");
  invalidateDbCache("pricing");
}

// ─── DB: model_capabilities table ────────────────────────

/**
 * Kept for callers written when the table was created lazily. The table is part of the
 * schema migration now, so there is nothing left to ensure.
 */
export async function ensureCapabilitiesTable(): Promise<void> {}

function defineEnumerableDataProperty<T extends object>(
  target: T,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function capabilitiesFromRows(rows: unknown[]): CapabilitiesByProvider {
  const result: CapabilitiesByProvider = {};

  for (const row of rows) {
    const record = toRecord(row);
    const prov = typeof record.provider === "string" ? record.provider : null;
    const mid = typeof record.model_id === "string" ? record.model_id : null;
    if (!prov || !mid) continue;

    if (!Object.hasOwn(result, prov)) {
      defineEnumerableDataProperty(result, prov, {});
    }
    defineEnumerableDataProperty(result[prov], mid, mapCapabilityRecord(record));
  }

  return result;
}

/**
 * Uncached full-table models.dev capability read for build-local snapshots.
 * Shares mapping with the ordinary all-row API but never mutates the module-global
 * `cachedCapabilities` / `cachedCapabilitiesLoadedAll` runtime cache.
 */
export async function loadAllSyncedCapabilitiesUncached(): Promise<CapabilitiesByProvider> {
  const rows = await db().query("SELECT * FROM model_capabilities");
  return capabilitiesFromRows(rows);
}

/**
 * Reasoning tiers already resident in this process. A catalog/discovery read
 * must use this instead of `getSyncedCapabilities()` — that path queries the database.
 */
export function peekCachedReasoningEfforts(provider: string, modelId: string): string[] | null {
  if (!cachedCapabilitiesLoadedAll || !cachedCapabilities) return null;
  const efforts = cachedCapabilities[provider]?.[modelId]?.reasoning_efforts;
  return efforts && efforts.length > 0 ? [...efforts] : null;
}

/**
 * Read synced capabilities from `model_capabilities` table.
 */
export async function getSyncedCapabilities(
  provider?: string,
  modelId?: string
): Promise<CapabilitiesByProvider> {
  if (hasFreshFullCapabilities()) {
    if (!provider) {
      return cachedCapabilities || {};
    }

    if (!modelId) {
      return cachedCapabilities?.[provider] ? { [provider]: cachedCapabilities[provider] } : {};
    }

    const providerCaps = cachedCapabilities?.[provider];
    return providerCaps?.[modelId] ? { [provider]: { [modelId]: providerCaps[modelId] } } : {};
  }

  let query = "SELECT * FROM model_capabilities";
  const params: string[] = [];

  if (provider) {
    query += " WHERE provider = $1";
    params.push(provider);
    if (modelId) {
      query += " AND model_id = $2";
      params.push(modelId);
    }
  }

  const result = capabilitiesFromRows(await db().query(query, params));

  if (!provider && !modelId) markCapabilitiesFullyLoaded(result);

  return result;
}

/**
 * Resolved providers/aliases to also try when looking up a synced capability.
 * Required because models.dev has historically stored capability rows under one
 * side of an alias pair while the catalog & combo targets reference the other.
 * Without this fallback such combos end up with `context_length: null` in the
 * catalog.
 */
const SYNCED_CAPABILITY_FALLBACK_ALIASES: Record<string, string[]> = {
  "opencode-go": ["opencode-zen"],
};

async function lookupSyncedCapabilityWithFallbacks(
  provider: string,
  lookup: (provider: string) => Promise<ModelCapabilityEntry | null> | ModelCapabilityEntry | null
): Promise<ModelCapabilityEntry | null> {
  const direct = await lookup(provider);
  if (direct) return direct;

  const fallbacks = SYNCED_CAPABILITY_FALLBACK_ALIASES[provider];
  if (fallbacks) {
    for (const alt of fallbacks) {
      const found = await lookup(alt);
      if (found) return found;
    }
  }

  return null;
}

export async function getSyncedCapability(
  provider: string,
  modelId: string,
  bulk?: CapabilitiesByProvider | null
): Promise<ModelCapabilityEntry | null> {
  if (!provider || !modelId) return null;

  if (bulk) {
    return lookupSyncedCapabilityWithFallbacks(provider, (p) => bulk[p]?.[modelId] ?? null);
  }

  // Callers look up many provider x model x alias candidates per request, so load the
  // whole table once (one query, shared by concurrent callers) instead of one query per
  // candidate, and answer from memory until it is due for a refresh.
  if (!hasFreshFullCapabilities()) {
    capabilitiesFullLoad ??= getSyncedCapabilities().finally(() => {
      capabilitiesFullLoad = null;
    });
    await capabilitiesFullLoad;
  }
  return lookupSyncedCapabilityWithFallbacks(
    provider,
    (p) => cachedCapabilities?.[p]?.[modelId] ?? null
  );
}

type CapabilityRowParams = readonly unknown[];

const nullableInt = (value: number | null): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

/**
 * Multi-row insert of capability rows through `unnest` (one round trip per chunk instead of
 * one per row). With `upsert`, an existing row is rewritten only when a capability column
 * actually differs, so the returned count is the number of semantic changes (a re-sync that
 * only refreshes `last_synced` counts as none).
 */
async function insertCapabilityRows(
  ex: DbExecutor,
  rows: Array<{ provider: string; modelId: string; cap: ModelCapabilityEntry }>,
  upsert: boolean
): Promise<number> {
  const CHUNK = 1500;
  let changes = 0;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const params: CapabilityRowParams[] = [
      chunk.map((r) => r.provider),
      chunk.map((r) => r.modelId),
      chunk.map((r) => r.cap.tool_call),
      chunk.map((r) => r.cap.reasoning),
      chunk.map((r) => r.cap.attachment),
      chunk.map((r) => r.cap.structured_output),
      chunk.map((r) => r.cap.temperature),
      // Validated in JS: a malformed value must not abort the whole `::jsonb` batch.
      chunk.map((r) => jsonTextParam(r.cap.modalities_input)),
      chunk.map((r) => jsonTextParam(r.cap.modalities_output)),
      chunk.map((r) => r.cap.knowledge_cutoff),
      chunk.map((r) => r.cap.release_date),
      chunk.map((r) => r.cap.last_updated),
      chunk.map((r) => r.cap.status),
      chunk.map((r) => r.cap.family),
      chunk.map((r) => r.cap.open_weights),
      chunk.map((r) => nullableInt(r.cap.limit_context)),
      chunk.map((r) => nullableInt(r.cap.limit_input)),
      chunk.map((r) => nullableInt(r.cap.limit_output)),
      chunk.map((r) => r.cap.interleaved_field),
      chunk.map((r) => (r.cap.reasoning_efforts ? JSON.stringify(r.cap.reasoning_efforts) : null)),
    ];
    const conflict = upsert
      ? `ON CONFLICT (provider, model_id) DO UPDATE SET
           tool_call = EXCLUDED.tool_call, reasoning = EXCLUDED.reasoning,
           attachment = EXCLUDED.attachment, structured_output = EXCLUDED.structured_output,
           temperature = EXCLUDED.temperature, modalities_input = EXCLUDED.modalities_input,
           modalities_output = EXCLUDED.modalities_output,
           knowledge_cutoff = EXCLUDED.knowledge_cutoff, release_date = EXCLUDED.release_date,
           last_updated = EXCLUDED.last_updated, status = EXCLUDED.status,
           family = EXCLUDED.family, open_weights = EXCLUDED.open_weights,
           limit_context = EXCLUDED.limit_context, limit_input = EXCLUDED.limit_input,
           limit_output = EXCLUDED.limit_output, interleaved_field = EXCLUDED.interleaved_field,
           reasoning_efforts = EXCLUDED.reasoning_efforts, last_synced = EXCLUDED.last_synced
         WHERE (
           model_capabilities.tool_call, model_capabilities.reasoning,
           model_capabilities.attachment, model_capabilities.structured_output,
           model_capabilities.temperature, model_capabilities.modalities_input,
           model_capabilities.modalities_output, model_capabilities.knowledge_cutoff,
           model_capabilities.release_date, model_capabilities.last_updated,
           model_capabilities.status, model_capabilities.family, model_capabilities.open_weights,
           model_capabilities.limit_context, model_capabilities.limit_input,
           model_capabilities.limit_output, model_capabilities.interleaved_field,
           model_capabilities.reasoning_efforts
         ) IS DISTINCT FROM (
           EXCLUDED.tool_call, EXCLUDED.reasoning, EXCLUDED.attachment, EXCLUDED.structured_output,
           EXCLUDED.temperature, EXCLUDED.modalities_input, EXCLUDED.modalities_output,
           EXCLUDED.knowledge_cutoff, EXCLUDED.release_date, EXCLUDED.last_updated,
           EXCLUDED.status, EXCLUDED.family, EXCLUDED.open_weights,
           EXCLUDED.limit_context, EXCLUDED.limit_input, EXCLUDED.limit_output,
           EXCLUDED.interleaved_field, EXCLUDED.reasoning_efforts
         )`
      : "";
    const result = await ex.execute(
      `INSERT INTO model_capabilities (
         provider, model_id, tool_call, reasoning, attachment, structured_output,
         temperature, modalities_input, modalities_output, knowledge_cutoff,
         release_date, last_updated, status, family, open_weights,
         limit_context, limit_input, limit_output, interleaved_field, reasoning_efforts,
         last_synced
       )
       SELECT t.provider, t.model_id, t.tool_call, t.reasoning, t.attachment, t.structured_output,
         t.temperature, t.modalities_input::jsonb, t.modalities_output::jsonb, t.knowledge_cutoff,
         t.release_date, t.last_updated, t.status, t.family, t.open_weights,
         t.limit_context, t.limit_input, t.limit_output, t.interleaved_field,
         t.reasoning_efforts::jsonb, now()
       FROM unnest(
         $1::text[], $2::text[], $3::boolean[], $4::boolean[], $5::boolean[], $6::boolean[],
         $7::boolean[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
         $13::text[], $14::text[], $15::boolean[], $16::int[], $17::int[], $18::int[],
         $19::text[], $20::text[]
       ) AS t(provider, model_id, tool_call, reasoning, attachment, structured_output,
         temperature, modalities_input, modalities_output, knowledge_cutoff,
         release_date, last_updated, status, family, open_weights,
         limit_context, limit_input, limit_output, interleaved_field, reasoning_efforts)
       ${conflict}`,
      params
    );
    changes += result.changes;
  }
  return changes;
}

function flattenCapabilities(
  data: CapabilitiesByProvider
): Array<{ provider: string; modelId: string; cap: ModelCapabilityEntry }> {
  return Object.entries(data).flatMap(([provider, models]) =>
    Object.entries(models).map(([modelId, cap]) => ({ provider, modelId, cap }))
  );
}

/**
 * Save synced capabilities to `model_capabilities` table (full replace).
 */
export async function saveModelsDevCapabilities(data: CapabilitiesByProvider): Promise<void> {
  const rows = flattenCapabilities(data);
  const changed = await db().transaction(async (tx) => {
    const deleted = await tx.execute("DELETE FROM model_capabilities");
    const inserted = await insertCapabilityRows(tx, rows, false);
    return deleted.changes > 0 || inserted > 0;
  });
  markCapabilitiesFullyLoaded(data);
  if (changed) invalidateDbCache("model-capabilities");
}

/**
 * Insert-or-replace one provider's capability rows without wiping the table.
 * Used by the OpenRouter live catalog walk so architecture.input_modalities
 * survive into the next combo LCD (#12613).
 */
export async function upsertSyncedCapabilities(
  provider: string,
  models: Record<string, ModelCapabilityEntry>
): Promise<void> {
  if (!provider || Object.keys(models).length === 0) return;
  // A catalog read must not invalidate its own generation just by refreshing
  // last_synced. The null-safe SQL predicate counts only semantic changes.
  const { persistedModels, changed } = await db().transaction(async (tx) => {
    const persisted = await preserveStoredModalitySets(provider, models, tx);
    const rows = Object.entries(persisted).map(([modelId, cap]) => ({ provider, modelId, cap }));
    const changes = await insertCapabilityRows(tx, rows, true);
    return { persistedModels: persisted, changed: changes > 0 };
  });
  if (cachedCapabilities) {
    cachedCapabilities[provider] = {
      ...(cachedCapabilities[provider] || {}),
      ...persistedModels,
    };
  }
  if (changed) invalidateDbCache("model-capabilities");
}

/**
 * Clear all synced capability data.
 */
export async function clearModelsDevCapabilities(): Promise<void> {
  const info = await db().execute("DELETE FROM model_capabilities");
  markCapabilitiesFullyLoaded({});
  if (info.changes > 0) invalidateDbCache("model-capabilities");
}

// ─── Main sync function ──────────────────────────────────

/**
 * Fetch, transform, and save pricing + capabilities from models.dev.
 */
export async function syncModelsDev(opts?: {
  dryRun?: boolean;
  syncCapabilities?: boolean;
  maxRetries?: number;
  signal?: AbortSignal;
}): Promise<SyncResult> {
  const dryRun = opts?.dryRun ?? false;
  const syncCapabilities = opts?.syncCapabilities ?? true;
  const maxRetries = opts?.maxRetries ?? 3;
  const signal = opts?.signal;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return createAbortedSyncResult(dryRun);
    }

    try {
      const raw = await fetchModelsDev(signal);
      const pricing = transformModelsDevToPricing(raw);
      const capabilities = syncCapabilities ? transformModelsDevToCapabilities(raw) : {};

      const modelCount = Object.values(pricing).reduce(
        (sum, models) => sum + Object.keys(models).length,
        0
      );
      const providerCount = Object.keys(pricing).length;
      const capabilityCount = syncCapabilities
        ? Object.values(capabilities).reduce((sum, models) => sum + Object.keys(models).length, 0)
        : 0;

      if (signal?.aborted) {
        return createAbortedSyncResult(dryRun);
      }

      if (!dryRun) {
        await saveModelsDevPricing(pricing);
        if (syncCapabilities) {
          await saveModelsDevCapabilities(capabilities);
        }
        lastSyncTime = new Date().toISOString();
        lastSyncModelCount = modelCount;
        lastSyncCapabilityCount = capabilityCount;
      }

      return {
        success: true,
        modelCount,
        providerCount,
        capabilityCount,
        dryRun,
        ...(dryRun ? { data: { pricing, capabilities } } : {}),
      };
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        return createAbortedSyncResult(dryRun);
      }

      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
        console.warn(
          `[MODELS_DEV] Sync attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`,
          lastError.message
        );
        try {
          await sleepWithAbort(delayMs, signal);
        } catch (sleepError) {
          if (signal?.aborted || isAbortError(sleepError)) {
            return createAbortedSyncResult(dryRun);
          }
          throw sleepError;
        }
      }
    }
  }

  const message = lastError?.message || "Unknown error";
  console.warn(`[MODELS_DEV] Sync failed after ${maxRetries + 1} attempts:`, message);
  return {
    success: false,
    modelCount: 0,
    providerCount: 0,
    capabilityCount: 0,
    dryRun,
    error: message,
  };
}

// ─── Periodic sync ───────────────────────────────────────

/**
 * Start periodic models.dev sync (non-blocking).
 */
export function startPeriodicSync(intervalMs?: number): void {
  if (syncTimer) return; // Already running

  const interval = intervalMs ?? SYNC_INTERVAL_MS;
  activeSyncIntervalMs = interval;
  const syncToken = { stopped: false };
  activePeriodicSyncToken = syncToken;
  console.log(`[MODELS_DEV] Starting periodic sync every ${interval / 1000}s`);

  const launchSync = () => {
    if (syncToken.stopped) {
      return Promise.resolve(createAbortedSyncResult(false));
    }

    if (activeSyncPromise) return activeSyncPromise;

    const controller = new AbortController();
    activeSyncAbortController = controller;
    const promise = syncModelsDev({ signal: controller.signal }).finally(() => {
      if (activeSyncAbortController === controller) {
        activeSyncAbortController = null;
      }
      if (activeSyncPromise === promise) {
        activeSyncPromise = null;
      }
    });
    activeSyncPromise = promise;
    return promise;
  };

  // Initial sync (non-blocking)
  launchSync()
    .then((result) => {
      if (result.success) {
        console.log(
          `[MODELS_DEV] Initial sync complete: ${result.modelCount} pricing entries, ${result.capabilityCount} capabilities from ${result.providerCount} providers`
        );
      }
    })
    .catch((err) => {
      console.warn("[MODELS_DEV] Initial sync error:", err instanceof Error ? err.message : err);
    });

  syncTimer = setInterval(() => {
    launchSync()
      .then((result) => {
        if (result.success) {
          console.log(`[MODELS_DEV] Periodic sync complete: ${result.modelCount} pricing entries`);
        }
      })
      .catch((err) => {
        console.warn("[MODELS_DEV] Periodic sync error:", err instanceof Error ? err.message : err);
      });
  }, interval);

  if (syncTimer && typeof syncTimer === "object" && "unref" in syncTimer) {
    (syncTimer as { unref?: () => void }).unref?.();
  }
}

/**
 * Stop periodic sync and cleanup timer.
 */
export function stopPeriodicSync(): void {
  if (activePeriodicSyncToken) {
    activePeriodicSyncToken.stopped = true;
    activePeriodicSyncToken = null;
  }

  if (activeSyncAbortController) {
    activeSyncAbortController.abort();
    activeSyncAbortController = null;
  }

  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log("[MODELS_DEV] Periodic sync stopped");
  }
}

/**
 * Get current sync status.
 */
export function getSyncStatus(): SyncStatus {
  // If the sync timer is active, it's enabled.
  const enabled = syncTimer !== null;
  return {
    enabled,
    lastSync: lastSyncTime,
    lastSyncModelCount,
    lastSyncCapabilityCount,
    nextSync:
      syncTimer && lastSyncTime
        ? new Date(new Date(lastSyncTime).getTime() + activeSyncIntervalMs).toISOString()
        : null,
    intervalMs: activeSyncIntervalMs,
  };
}

// ─── Init (called from src/server/boot.ts) ───────────────────

/**
 * Initialize models.dev sync if enabled.
 */
export async function initModelsDevSync(): Promise<void> {
  if (isModelsDevSyncEnvDisabled()) {
    console.log("[MODELS_DEV] Disabled (MODELS_DEV_SYNC_ENABLED=0)");
    return;
  }

  const { getSettings } = await import("@/lib/db/settings");
  const settings = await getSettings();

  if (!isModelsDevSyncEnvForcedOn() && settings.modelsDevSyncEnabled !== true) {
    console.log("[MODELS_DEV] Disabled (enable via Settings > AI or MODELS_DEV_SYNC_ENABLED=1)");
    return;
  }

  const interval = settings.modelsDevSyncInterval as number | undefined;
  startPeriodicSync(interval);
}
