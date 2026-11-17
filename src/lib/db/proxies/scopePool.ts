import type { DbExecutor } from "@/lib/db/pg";

/**
 * Append proxies to a scope's rotation pool in one statement. Existing members
 * are skipped by the (scope, scope_id, proxy_id) unique key, so concurrent
 * callers cannot create duplicates. New members are placed after the current
 * highest `position` (index within `proxyIds` keeps their relative order).
 * Returns the number of rows actually inserted. `scopeId` is the normalized
 * assignment scope id (`'__global__'` for the global scope).
 */
export async function appendProxiesToScopePool(
  executor: DbExecutor,
  scope: string,
  scopeId: string,
  proxyIds: string[]
): Promise<number> {
  if (proxyIds.length === 0) return 0;
  const result = await executor.execute(
    `INSERT INTO proxy_assignments (proxy_id, scope, scope_id, position, created_at, updated_at)
     SELECT t.pid, $2::text, $3::text, b.base + t.ord - 1, now(), now()
       FROM unnest($1::text[]) WITH ORDINALITY AS t(pid, ord)
      CROSS JOIN (
        SELECT COALESCE(MAX(position) + 1, 0) AS base
          FROM proxy_assignments WHERE scope = $2::text AND scope_id = $3::text
      ) b
     ON CONFLICT (scope, scope_id, proxy_id) DO NOTHING`,
    [proxyIds, scope, scopeId]
  );
  return result.changes;
}
