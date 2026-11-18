/**
 * DB Read Cache — In-memory TTL cache for hot read paths.
 *
 * Every uncached read is a PostgreSQL round trip, and some functions (getSettings,
 * getPricing, getProviderConnections) are called several times per request. A short TTL
 * (5 s) removes that traffic. Writes in this process invalidate immediately; other
 * processes on the same database see a change within one TTL, so keep TTLs short.
 *
 * Usage:
 *   import { dbCache } from '@/lib/db/readCache';
 *   const settings = await dbCache.getSettings();
 */

import { onBusResync, onInvalidation, publishInvalidation } from "../cluster/bus";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private pending = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number, maxSize?: number) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize ?? 0;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict LRU (first key in insertion order) when at capacity
    if (this.maxSize > 0 && this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  load(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const promise: Promise<T> = loader().then(
      (value) => {
        if (this.pending.get(key) === promise) {
          this.pending.delete(key);
          this.set(key, value);
        }
        return value;
      },
      (error: unknown) => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
        throw error;
      }
    );
    this.pending.set(key, promise);
    return promise;
  }

  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
      this.pending.delete(key);
    } else {
      this.cache.clear();
      this.pending.clear();
    }
  }
}

// Cache with 5s TTL — short enough to pick up dashboard changes quickly,
// long enough to absorb request bursts without a round trip each.
const SETTINGS_TTL_MS = 5_000;
const PRICING_TTL_MS = 30_000;
const CONNECTIONS_TTL_MS = 5_000;
const settingsCache = new TTLCache<Record<string, unknown>>(SETTINGS_TTL_MS);
const pricingCache = new TTLCache<Record<string, unknown>>(PRICING_TTL_MS);
const connectionsCache = new TTLCache<unknown[]>(CONNECTIONS_TTL_MS, 500);

/**
 * Cached wrapper for getSettings.
 * Invalidated on every updateSettings() call.
 */
export async function getCachedSettings(): Promise<Record<string, unknown>> {
  return settingsCache.load("settings", async () => {
    const { getSettings } = await import("@/lib/db/settings");
    return getSettings();
  });
}

/**
 * Cached wrapper for getPricing.
 * Longer TTL since pricing rarely changes mid-session.
 */
export async function getCachedPricing(): Promise<Record<string, unknown>> {
  return pricingCache.load("pricing", async () => {
    const { getPricing } = await import("@/lib/db/settings");
    return getPricing();
  });
}
/**
 * Cached wrapper for getProviderConnections.
 * Used in request hot-paths (usageStats, callLogs, usageHistory, catalog, virtualFactory).
 * Now caches ALL query variants (filtered and unfiltered) for 5s.
 */
export async function getCachedProviderConnections(
  filter?: Record<string, unknown>
): Promise<unknown[]> {
  const cacheKey = filter && Object.keys(filter).length > 0 ? JSON.stringify(filter) : "all";

  return connectionsCache.load(cacheKey, async () => {
    const { getProviderConnections } = await import("@/lib/db/providers");
    return getProviderConnections(filter);
  });
}

const rawConnectionsCache = new TTLCache<unknown[]>(CONNECTIONS_TTL_MS, 500);

/**
 * Cached wrapper for getRawProviderConnections.
 * Same 5s TTL as the encrypted variant but preserves ciphertext fields
 * for lazy decryption — used by the auth selection hot path where 10k+
 * connections are filtered to find the winner but only 1 row needs
 * credential decryption.
 */
export async function getCachedRawProviderConnections(
  filter?: Record<string, unknown>
): Promise<unknown[]> {
  const key = JSON.stringify(filter ?? {});
  return rawConnectionsCache.load(key, async () => {
    const { getRawProviderConnections } = await import("./providers");
    return getRawProviderConnections(filter);
  });
}

const connectionByIdCache = new TTLCache<Record<string, unknown> | null>(
  CONNECTIONS_TTL_MS,
  10_000
);
const nodesCache = new TTLCache<(Record<string, unknown> | null)[]>(CONNECTIONS_TTL_MS);

/**
 * Cached wrapper for getProviderConnectionById.
 * Keyed by connection ID, shared 5s TTL.
 * Invalidated on every provider_connections write.
 */
export async function getCachedProviderConnectionById(
  id: string
): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  return connectionByIdCache.load(id, async () => {
    const { getProviderConnectionById } = await import("@/lib/db/providers");
    return getProviderConnectionById(id);
  });
}

/**
 * Cached wrapper for getProviderNodes.
 * Keyed by JSON-serialized filter, shared 5s TTL.
 * Invalidated on every provider_nodes write.
 */
export async function getCachedProviderNodes(
  filter?: Record<string, unknown>
): Promise<(Record<string, unknown> | null)[]> {
  const cacheKey = filter ? JSON.stringify(filter) : "all";
  return nodesCache.load(cacheKey, async () => {
    const { getProviderNodes } = await import("@/lib/db/providers");
    return getProviderNodes(filter);
  });
}

// ──────────────── LKGP Cache Wrappers ────────────────

interface LKGPRecordCache {
  provider: string;
  connectionId?: string;
}

const lkgpCache = new TTLCache<LKGPRecordCache | null>(SETTINGS_TTL_MS);

export async function getCachedLKGP(
  comboName: string,
  modelId: string
): Promise<LKGPRecordCache | null> {
  const cacheKey = `lkgp:${comboName}:${modelId}`;
  return lkgpCache.load(cacheKey, async () => {
    const { getLKGP } = await import("@/lib/db/settings");
    return getLKGP(comboName, modelId);
  });
}

export async function setCachedLKGP(
  comboName: string,
  modelId: string,
  providerId: string,
  connectionId?: string
): Promise<void> {
  const { setLKGP } = await import("@/lib/db/settings");
  await setLKGP(comboName, modelId, providerId, connectionId);
  lkgpCache.invalidate(`lkgp:${comboName}:${modelId}`);
}

/**
 * Invalidate one persisted LKGP pin by its `${comboName}:${modelId}` storage key,
 * or every cached LKGP pin when no key is provided. Used both when a target
 * fails (`clearLKGP`) and when its provider connection is deleted (#8887,
 * `deleteLKGPByConnectionIds`), so a stale pin cannot be served from memory
 * for the rest of the TTL window.
 */
export function invalidateCachedLKGP(pinKey?: string): void {
  lkgpCache.invalidate(pinKey ? `lkgp:${pinKey}` : undefined);
}

// ──────────────── Combo Cache Invalidation Signal ────────────────
//
// The nested-combo expansion caches live in request handlers
// (`src/sse/handlers/chat.ts` getCombosCachedForChat and
// `open-sse/handlers/chatCore.ts` getCombosCached), each with a 10s TTL. A db
// module must NOT import a request handler (that would create an import cycle),
// so instead those caches consult this monotonically-incrementing version.
// Combo writes call `invalidateDbCache("combos")`, which bumps the version;
// the handlers compare the version they were populated at against the current
// one and treat a mismatch as a cache miss — so combo edits take effect
// immediately instead of after the 10s window (#3147).
let combosCacheVersion = 0;

/**
 * Current combo-cache version. Cache layers snapshot this when they populate
 * and re-read it on every access; a change means the underlying combos were
 * written and the cached expansion must be refreshed.
 */
export function getCombosCacheVersion(): number {
  return combosCacheVersion;
}

// ──────────────── Combo Name / Mapping Read Cache ────────────────
//
// apiKeyPolicy.resolveRequestedComboName and model.ts.getCombo issue up to 3
// getComboByName queries per request, and resolveComboForModel runs for every
// non-combo model. Entries are keyed by combosCacheVersion, so combo or
// mapping writes (invalidateDbCache("combos")) bust them immediately — same
// contract as the handler-level caches above. 10s TTL mirrors
// getCombosCachedForChat.
const COMBO_LOOKUP_TTL_MS = 10_000;
const comboByNameCache = new TTLCache<Record<string, unknown> | null>(COMBO_LOOKUP_TTL_MS, 500);
const comboForModelCache = new TTLCache<Record<string, unknown> | null>(COMBO_LOOKUP_TTL_MS, 500);

/** Cached getComboByName — version-keyed, so combo writes take effect at once. */
export async function getCachedComboByName(name: string): Promise<Record<string, unknown> | null> {
  const key = `${getCombosCacheVersion()}:${name}`;
  return comboByNameCache.load(key, async () => {
    const { getComboByName } = await import("@/lib/db/combos");
    return getComboByName(name);
  });
}

const comboByIdCache = new TTLCache<Record<string, unknown> | null>(COMBO_LOOKUP_TTL_MS, 500);

/** Cached getComboById — same version-keyed contract as above. */
export async function getCachedComboById(id: string): Promise<Record<string, unknown> | null> {
  const key = `${getCombosCacheVersion()}:${id}`;
  return comboByIdCache.load(key, async () => {
    const { getComboById } = await import("@/lib/db/combos");
    return getComboById(id);
  });
}

/** Cached resolveComboForModel — same version-keyed contract as above. */
export async function getCachedComboForModel(
  model: string
): Promise<Record<string, unknown> | null> {
  const key = `${getCombosCacheVersion()}:${model}`;
  return comboForModelCache.load(key, async () => {
    const { resolveComboForModel } = await import("@/lib/db/modelComboMappings");
    return resolveComboForModel(model);
  });
}

// ──────────────── Model Catalog Cache Invalidation Signal ────────────────
//
// #6408 added a request-shape-keyed (prefix/isCodex/apiKey/configuredOnly) TTL
// cache around the unified /v1/models builder (src/app/api/v1/models/catalog.ts)
// to coalesce concurrent/bursty GETs. That cache key does not vary with the
// underlying DB state the builder reads (connections, settings, combos), so
// writes need an explicit invalidation signal. Same import-cycle
// constraint as combosCacheVersion above (a db module must not import the route
// module): catalogCache.ts compares this version on every access and builder
// completion, then hard-invalidates snapshots and old-generation work when it moves.
let modelCatalogCacheVersion = 0;

/**
 * Current model-catalog-cache version. A change means catalog-backed state was
 * written and the next read must synchronously build the new generation.
 */
export function getModelCatalogCacheVersion(): number {
  return modelCatalogCacheVersion;
}

/** Invalidate only the unified model catalog response cache (here and in the cluster). */
export function invalidateModelCatalogCache(): void {
  modelCatalogCacheVersion++;
  publishInvalidation(MODEL_CATALOG_SCOPE);
}

// ──────────────── API-Key Policy Config ────────────────
//
// enforceApiKeyPolicy and the post-response accounting read a key's billing team, quota
// limits, token limits and pool allocations on every request (measured 2026-11-17: 6 queries).
// These are admin-edited config rows, so they share the settings TTL. Each owning module drops
// the whole cache on any write (writes are rare, so per-key invalidation is not worth its risk).
// Usage counters and the unpriced-usage flags are runtime state and are never cached here.
const API_KEY_POLICY_TTL_MS = 5_000;
const apiKeyPolicyCache = new TTLCache<unknown>(API_KEY_POLICY_TTL_MS, 5_000);

/** Cached per-key policy config read; the caller gets its own copy. */
export async function loadApiKeyPolicyConfig<T>(key: string, loader: () => Promise<T>): Promise<T> {
  return structuredClone((await apiKeyPolicyCache.load(key, loader)) as T);
}

/**
 * Call after any write to a table read through loadApiKeyPolicyConfig. Goes through
 * invalidateDbCache (scope "api-key-policy") so every invalidation shares one entry point;
 * policy config does not feed the /v1/models catalog, so that cache is left alone.
 */
export function invalidateApiKeyPolicyCache(): void {
  invalidateDbCache("api-key-policy", undefined, { skipModelCatalog: true });
}

// ──────────────── Model Metadata Snapshots ────────────────
//
// The chat path reads provider_model_catalog documents and the model capability/context
// override tables dozens of times per request (measured 2026-11-17: ~77 of 116 queries before
// dispatch). Each of those tables is small, so one query loads the whole table into a snapshot
// that the per-model getters answer from. Writes in this process call
// invalidateDbCache("model-capabilities"), which bumps the version and drops every snapshot at
// once; the TTL bounds how long another process keeps serving an old one.
const MODEL_METADATA_TTL_MS = 10_000;
let modelMetadataVersion = 0;
const modelMetadataSnapshots = new Map<
  string,
  { version: number; expiresAt: number; value: Promise<unknown> }
>();

/**
 * Drop the model-metadata snapshots only, without the /v1/models catalog bump that
 * invalidateDbCache("model-capabilities") also does. For batch writers that defer the catalog
 * invalidation to the end of a pass but must still read their own writes.
 */
export function invalidateModelMetadataSnapshots(): void {
  modelMetadataVersion++;
}

/**
 * One shared load of `loader()` per `name`, reused until a model-metadata write or the TTL.
 * A load that fails is not kept, so the next read retries. Callers must not mutate the value.
 */
export function loadModelMetadataSnapshot<T>(name: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = modelMetadataSnapshots.get(name);
  if (entry && entry.version === modelMetadataVersion && entry.expiresAt > now) {
    return entry.value as Promise<T>;
  }
  const value = loader();
  const next = { version: modelMetadataVersion, expiresAt: now + MODEL_METADATA_TTL_MS, value };
  modelMetadataSnapshots.set(name, next);
  value.catch(() => {
    if (modelMetadataSnapshots.get(name) === next) modelMetadataSnapshots.delete(name);
  });
  return value;
}

/**
 * Connection fields written by the chat path's error/cooldown machinery.
 * The unified model catalog builder consumes ONLY `isActive` and
 * `providerSpecificData.excludedModels` from a connection row (see
 * src/app/api/v1/models/catalog.ts and hasEligibleConnectionForModel) — none of
 * the fields below appear anywhere in the catalog build. Writing them is
 * high-frequency runtime bookkeeping (measured 2026-09-17: ~2.6 writes/min on a
 * live gateway — 429 cooldowns, markAccountUnavailable, clearAccountError), and
 * every one of those writes used to bump `modelCatalogCacheVersion` through
 * `invalidateDbCache("connections")`, dropping the memoized /v1/models body so
 * the endpoint paid its full ~7 s rebuild on nearly every call.
 */
const CONNECTION_RUNTIME_STATE_FIELDS = new Set([
  "testStatus",
  "lastError",
  "lastErrorAt",
  "lastErrorType",
  "lastErrorSource",
  "errorCode",
  "rateLimitedUntil",
  "backoffLevel",
]);

/**
 * True when an update touches ONLY runtime-state fields, i.e. fields that keep
 * account selection/cooldown state fresh but cannot change the catalog body.
 * Fail-closed by construction: an empty update or any field outside the set
 * (isActive, provider, priority, providerSpecificData, ...) returns false and
 * the caller falls back to the full catalog invalidation.
 */
export function isConnectionRuntimeStateUpdate(data: Record<string, unknown>): boolean {
  const keys = Object.keys(data);
  return keys.length > 0 && keys.every((key) => CONNECTION_RUNTIME_STATE_FIELDS.has(key));
}

export type UpdateOpts = { skipModelCatalog?: boolean };

/**
 * Cache invalidation for `updateProviderConnection()`: runtime-state-only
 * updates (cooldowns, error fields) keep the connection read caches fresh
 * without dropping the memoized /v1/models catalog — the builder never reads
 * these fields. Anything else falls back to the full invalidation so config
 * edits stay immediately visible in the catalog.
 */
export function invalidateConnectionUpdate(
  id: string,
  data: Record<string, unknown>,
  opts?: UpdateOpts
): void {
  // #13389: a caller that vouches its write is catalog-irrelevant (OAuth token
  // rotation — credentials only, see updateProviderCredentials) opts in explicitly.
  if (opts?.skipModelCatalog || isConnectionRuntimeStateUpdate(data)) {
    invalidateDbCache("connections", id, { skipModelCatalog: true });
  } else {
    invalidateDbCache("connections");
  }
}

/**
 * Invalidate caches (call after writes to any of: settings, pricing,
 * connections, combos, nodes, model capability/context metadata).
 *
 * When scope is `"connections"` and an `id` is provided, only that
 * connection's by-ID cache entry is invalidated (the filter-keyed raw
 * cache must still be fully cleared since overlapping filter results
 * cannot be selectively invalidated).
 *
 * `skipModelCatalog` (#13389): the unified `/v1/models` builder
 * (`src/app/api/v1/models/catalog.ts`) never reads routing/health-only
 * connection fields — `backoffLevel`, `testStatus`, `rateLimitedUntil`,
 * `lastError*`, `errorCode` — only structural fields such as
 * `excludedModels` or enabled/disabled. A caller that only touched those
 * routing fields (e.g. `resetConnectionBackoff`) should still bust the
 * connections read cache but must NOT bump `modelCatalogCacheVersion`:
 * doing so was busting the entire `/v1/models` response cache on every
 * routine backoff auto-recovery during normal request routing, far more
 * often than the cache's own 60s TTL / 30s stale-while-revalidate window
 * intends, forcing frequent expensive cold rebuilds. Structural connection
 * writes (create/update/delete) must keep the default (omit this flag) so
 * the catalog still reflects them immediately.
 */
type DbCacheScope =
  | "settings"
  | "pricing"
  | "connections"
  | "combos"
  | "nodes"
  | "model-capabilities"
  | "api-key-policy";

const DB_CACHE_SCOPES: ReadonlySet<string> = new Set<DbCacheScope>([
  "settings",
  "pricing",
  "connections",
  "combos",
  "nodes",
  "model-capabilities",
  "api-key-policy",
]);

export function invalidateDbCache(
  scope?: DbCacheScope,
  id?: string,
  opts?: { skipModelCatalog?: boolean }
): void {
  invalidateDbCacheLocal(scope, id, opts);
  publishInvalidation(DB_CACHE_BUS_SCOPE, id, {
    scope: scope ?? "all",
    skipModelCatalog: opts?.skipModelCatalog === true,
  });
}

// ──────────────── Cluster invalidation ────────────────
//
// In cluster mode every write also tells the other processes to drop the same entries
// (src/lib/cluster/bus.ts). Received messages call only the local twins below, so they are
// never republished. Some writers invalidate inside their transaction, so a peer could
// re-read the old row before the commit lands: the receiver drops the entries again after
// RECEIVED_REINVALIDATE_MS. The TTLs above stay as the floor when a message is lost.
const DB_CACHE_BUS_SCOPE = "db-cache";
const MODEL_CATALOG_SCOPE = "model-catalog";
const RECEIVED_REINVALIDATE_MS = 1_000;

function twice(fn: () => void): void {
  fn();
  setTimeout(fn, RECEIVED_REINVALIDATE_MS).unref?.();
}

onInvalidation(DB_CACHE_BUS_SCOPE, (id, data) => {
  const raw = typeof data?.scope === "string" ? data.scope : "all";
  const scope = DB_CACHE_SCOPES.has(raw) ? (raw as DbCacheScope) : undefined;
  if (raw !== "all" && !scope) return;
  const skipModelCatalog = data?.skipModelCatalog === true;
  twice(() => invalidateDbCacheLocal(scope, id, { skipModelCatalog }));
});
onInvalidation(MODEL_CATALOG_SCOPE, () => twice(() => modelCatalogCacheVersion++));
// After a bus reconnect, messages sent meanwhile are lost: drop everything once.
onBusResync(() => invalidateDbCacheLocal());

function invalidateDbCacheLocal(
  scope?: DbCacheScope,
  id?: string,
  opts?: { skipModelCatalog?: boolean }
): void {
  if (!scope || scope === "settings") settingsCache.invalidate();
  if (!scope || scope === "pricing") pricingCache.invalidate();
  if (!scope || scope === "connections") {
    connectionsCache.invalidate();
    rawConnectionsCache.invalidate();
    if (id) {
      connectionByIdCache.invalidate(id);
    } else {
      connectionByIdCache.invalidate();
    }
  }
  if (!scope || scope === "nodes") nodesCache.invalidate();
  if (!scope || scope === "combos") combosCacheVersion++;
  if (!scope || scope === "model-capabilities") modelMetadataVersion++;
  if (!scope || scope === "api-key-policy") apiKeyPolicyCache.invalidate();
  if (opts?.skipModelCatalog) return;
  // Settings/connections/combos all feed the unified model catalog builder
  // (blockedProviders + hidePaidModels, provider connections + excludedModels,
  // combo definitions, respectively) — pricing does too, via isFreeModel().
  // Local bump only: the db-cache message already carries skipModelCatalog to peers.
  modelCatalogCacheVersion++;
}
