import { decrypt, encrypt } from "./encryption";

export const CACHE_SECRET_MASK = "********";
export const CACHE_SECRET_KEYS = ["semanticCacheEmbeddingApiKey", "semanticCacheRedisUrl"] as const;

export class CacheCredentialEndpointError extends Error {
  constructor() {
    super("Re-enter or clear the embedding API key when changing its provider or endpoint");
    this.name = "CacheCredentialEndpointError";
  }
}

export function assertCacheCredentialEndpoint(
  current: Record<string, unknown>,
  updates: Record<string, unknown> | undefined
): void {
  if (!updates) return;
  const changed = ["semanticCacheEmbeddingBaseUrl", "semanticCacheEmbeddingProvider"].some(
    (field) => updates[field] !== undefined && (updates[field] || "") !== (current[field] || "")
  );
  const key = updates.semanticCacheEmbeddingApiKey;
  if (
    changed &&
    current.semanticCacheEmbeddingApiKey &&
    (key === undefined || key === CACHE_SECRET_MASK)
  ) {
    throw new CacheCredentialEndpointError();
  }
}

export function isCacheSecret(key: string): boolean {
  return CACHE_SECRET_KEYS.some((secret) => secret === key);
}

export function encryptCacheValue(key: string, value: unknown): unknown {
  return isCacheSecret(key) && typeof value === "string" ? encrypt(value) : value;
}

export function decryptCacheSecrets(cache: Record<string, unknown>): void {
  for (const key of CACHE_SECRET_KEYS) {
    if (typeof cache[key] === "string") cache[key] = decrypt(cache[key]) ?? "";
  }
}

export function redactCacheSecrets<T extends Record<string, unknown>>(cache: T): T {
  const redacted: Record<string, unknown> = { ...cache };
  for (const key of CACHE_SECRET_KEYS) {
    const value = redacted[key];
    if (typeof value !== "string" || !value) continue;
    // An unauthenticated Redis endpoint is configuration, not a secret.
    if (key === "semanticCacheRedisUrl") {
      try {
        const url = new URL(value);
        if (!url.username && !url.password) continue;
      } catch {
        // Malformed connection strings can still contain a password; hide them.
      }
    }
    redacted[key] = CACHE_SECRET_MASK;
  }
  return redacted as T;
}
