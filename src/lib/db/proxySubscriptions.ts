// Proxy-subscription-specific pool operations, split out of `proxies.ts` to keep
// that module under its frozen size cap. Re-exported from `proxies.ts` so callers
// (subscriptionService.ts et al.) can keep importing from the original module.
import { db } from "@/lib/db/pg";
import { normalizeScope, normalizeAssignmentScopeId, isScopeIdMissing } from "./proxies/mappers";
import { bumpProxyRegistryGeneration } from "./proxies/registryGeneration";
import { appendProxiesToScopePool } from "./proxies/scopePool";

/**
 * Add MULTIPLE proxies to a scope's rotation POOL in a single batched write
 * (#6365). Idempotent per (scope, scope_id, proxy_id): existing members are
 * skipped. New members are appended after the current highest `position` so
 * round-robin order is stable. Returns the number of proxies actually added.
 * Prefer this over N calls to `addProxyToScopePool` when binding a whole pool
 * (e.g. a synced subscription's node list).
 */
export async function addProxiesToScopePool(
  scope: string,
  scopeId: string | null,
  proxyIds: string[]
): Promise<number> {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeAssignmentScopeId(normalizedScope, scopeId);
  // Contract: normalizedScope is already normalized — the raw-scope guard applies to it directly.
  if (isScopeIdMissing(normalizedScope, normalizedScopeId) || normalizedScopeId === null) {
    throw new Error("scopeId is required for non-global proxy assignments");
  }
  const unique = [...new Set((proxyIds || []).filter(Boolean))];
  if (unique.length === 0) return 0;

  const added = await appendProxiesToScopePool(db(), normalizedScope, normalizedScopeId, unique);
  if (added > 0) bumpProxyRegistryGeneration();
  return added;
}
