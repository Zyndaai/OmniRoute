import { getDatabaseSettingsSection } from "@/lib/db/databaseSettingsSections";
import { db } from "@/lib/db/pg";
import { decryptConnectionFields } from "@/lib/db/encryption";
import {
  registerSemanticCacheConfigResolver,
  type SemanticCacheConfig,
} from "@omniroute/open-sse/config/semanticCacheConfig.ts";
import { resolveEmbeddingCredentials } from "@omniroute/open-sse/services/cache/embeddingEndpoint";

let registered = false;

/** The resolver is synchronous (it runs inside constructors), so it reads this snapshot. */
let snapshot: Partial<SemanticCacheConfig> | null = null;
let snapshotAt = 0;
let refreshing: Promise<void> | null = null;
let firstRefresh: Promise<void> = Promise.resolve();
const SNAPSHOT_TTL_MS = 5_000;

export async function resolveProviderConnectionDetails(provider: string): Promise<{
  baseUrl?: string;
  apiKey?: string;
}> {
  if (!provider) return {};
  try {
    const row = await db().queryOne<Record<string, unknown>>(
      "SELECT * FROM provider_connections WHERE provider = $1 AND is_active ORDER BY priority ASC, id ASC LIMIT 1",
      [provider]
    );

    if (!row) return {};
    const decrypted = decryptConnectionFields(row);
    let baseUrl: string | undefined;
    if (decrypted.provider_specific_data) {
      try {
        const parsed =
          typeof decrypted.provider_specific_data === "string"
            ? JSON.parse(decrypted.provider_specific_data)
            : decrypted.provider_specific_data;
        if (typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim()) {
          baseUrl = parsed.baseUrl.trim();
        }
      } catch {
        // Ignore parse error
      }
    }
    const rawKey = decrypted.api_key || decrypted.apiKey;
    const apiKey = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : undefined;
    return { baseUrl, apiKey };
  } catch {
    return {};
  }
}

async function loadSemanticCacheConfig(): Promise<Partial<SemanticCacheConfig> | null | undefined> {
  try {
    // Configuration reads touch only the cache settings section, never table statistics.
    const s = await getDatabaseSettingsSection("cache");
    if (!s) return undefined;

    const conn = s.semanticCacheEmbeddingProvider
      ? await resolveProviderConnectionDetails(s.semanticCacheEmbeddingProvider)
      : {};

    const { baseUrl: embeddingBaseUrl, apiKey: embeddingApiKey } = resolveEmbeddingCredentials(
      { baseUrl: s.semanticCacheEmbeddingBaseUrl, apiKey: s.semanticCacheEmbeddingApiKey },
      conn
    );

    return {
      // The vector layer is opt-in (#14159): it only runs when the operator turned
      // on BOTH the master semantic-cache toggle and the vector-layer toggle. With
      // it off, chatCore behaves exactly like the legacy exact-match cache.
      enabled: s.semanticCacheEnabled !== false && s.semanticCacheVectorEnabled === true,
      backend: s.semanticCacheBackend,
      similarityThreshold: s.semanticCacheThreshold,
      ttlMs: s.semanticCacheTTL,
      maxEntries: s.semanticCacheMaxSize,
      embeddingProvider: s.semanticCacheEmbeddingProvider,
      embeddingModel: s.semanticCacheEmbeddingModel,
      embeddingDimension: s.semanticCacheEmbeddingDimension,
      embeddingBaseUrl,
      embeddingApiKey,
      redisUrl: s.semanticCacheRedisUrl,
      redisPrefix: s.semanticCacheRedisPrefix,
      requireZeroTemperature: s.semanticCacheRequireZeroTemp,
    };
  } catch {
    // undefined (not null) = the read failed; the caller keeps the last good snapshot.
    return undefined;
  }
}

/**
 * Re-reads the cache settings into the snapshot the synchronous config resolver serves.
 * Concurrent calls share one read. Await it after changing the cache settings to make
 * the change visible to the next `resolveSemanticCacheConfig()` call. A failed read keeps
 * the last good snapshot.
 */
export function refreshSemanticCacheDbBridge(): Promise<void> {
  if (!refreshing) {
    refreshing = loadSemanticCacheConfig()
      .then((config) => {
        if (config === undefined) return;
        snapshot = config;
        snapshotAt = Date.now();
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

/**
 * Registers the resolver once. Returns the first snapshot read: await it before the first
 * SemanticCacheManager is built, because the manager reads its config once in its constructor.
 */
export function ensureSemanticCacheDbBridge(): Promise<void> {
  if (registered) return firstRefresh;
  registered = true;
  firstRefresh = refreshSemanticCacheDbBridge();
  registerSemanticCacheConfigResolver(() => {
    // Stale-while-revalidate: serve the last snapshot, refresh in the background.
    if (Date.now() - snapshotAt > SNAPSHOT_TTL_MS) void refreshSemanticCacheDbBridge();
    return snapshot;
  });
  return firstRefresh;
}
