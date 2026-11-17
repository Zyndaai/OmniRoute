import { db, type DbExecutor } from "@/lib/db/pg";

export const PROXY_ALIVE_PREDICATE =
  "(p.status IS NULL OR LOWER(p.status) NOT IN ('inactive','error','disabled','dead','down'))";

const PROXY_UNAVAILABLE_STATUSES = new Set(["inactive", "error", "disabled", "dead", "down"]);

/** Keep by-id account proxy resolution aligned with the pool alive predicate above. */
export function isProxyRegistryStatusAlive(status: unknown): boolean {
  return status == null || !PROXY_UNAVAILABLE_STATUSES.has(String(status).toLowerCase());
}

export async function isGlobalProxyEnabled(executor: DbExecutor = db()): Promise<boolean> {
  try {
    const row = await executor.queryOne<{ value: unknown }>(
      "SELECT value FROM config_entries WHERE namespace = 'settings' AND key = 'proxyEnabled'"
    );
    if (!row || row.value === null || row.value === undefined) return true;
    if (typeof row.value === "string") {
      try {
        return JSON.parse(row.value) !== false;
      } catch {
        return true;
      }
    }
    return row.value !== false;
  } catch {
    return true;
  }
}

/**
 * #6246 fail-closed guard for a connection with an assigned dead proxy pool.
 * Explicitly disabling proxying globally or for the connection allows direct egress.
 */
export async function hasBlockingProxyAssignment(
  connectionId: string,
  providerId?: string,
  comboName?: string | null
): Promise<boolean> {
  try {
    const executor = db();
    if (!(await isGlobalProxyEnabled(executor))) return false;

    const conn = await executor.queryOne<{ provider: string | null; proxy_enabled: boolean }>(
      "SELECT provider, proxy_enabled FROM provider_connections WHERE id = $1",
      [connectionId]
    );
    if (conn && conn.proxy_enabled === false) return false;
    const provider = conn?.provider ?? providerId ?? null;
    // #13469: include combo scope — a fully dead combo-scoped pool must not
    // fall through to direct egress.
    const dead = await executor.queryOne(
      `SELECT 1 FROM proxy_assignments a JOIN proxy_registry p ON p.id = a.proxy_id
         WHERE ((a.scope = 'account' AND a.scope_id = $1)
             OR (a.scope = 'provider' AND a.scope_id = $2::text)
             OR (a.scope = 'global')
             OR (a.scope = 'combo' AND a.scope_id = $3::text))
           AND NOT ${PROXY_ALIVE_PREDICATE}
         LIMIT 1`,
      [connectionId, provider, comboName ?? null]
    );
    return !!dead;
  } catch {
    return false;
  }
}

/**
 * #7380 fail-closed guard for providers without a connection row. Returns true
 * when a provider/global proxy assignment exists but all assigned proxies are known dead.
 */
export async function hasBlockingProxyAssignmentForProvider(providerId: string): Promise<boolean> {
  try {
    const executor = db();
    if (!(await isGlobalProxyEnabled(executor))) return false;

    const assignments = await executor.queryOne<{ assigned: boolean; alive: boolean }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM proxy_assignments a
           WHERE ((a.scope = 'provider' AND a.scope_id = $1)
               OR a.scope = 'global')
         ) AS assigned,
         EXISTS(
           SELECT 1 FROM proxy_assignments a JOIN proxy_registry p ON p.id = a.proxy_id
           WHERE ((a.scope = 'provider' AND a.scope_id = $1)
               OR a.scope = 'global')
             AND ${PROXY_ALIVE_PREDICATE}
         ) AS alive`,
      [providerId]
    );
    return assignments?.assigned === true && assignments.alive === false;
  } catch {
    return false;
  }
}
