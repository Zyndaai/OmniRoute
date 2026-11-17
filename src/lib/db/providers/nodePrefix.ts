/**
 * db/providers/nodePrefix.ts — lookup of a provider node's own routing prefix (#15563).
 */

import { db } from "../pg";

// #16814 — capability resolution calls this several times per provider on the auto/* request
// path. Memoized per backend (a reset/reopened backend drops it) and cleared by the
// provider_nodes writers in nodes.ts. The memo holds the load promise, so concurrent
// first calls share one query.
interface PrefixIndex {
  byId: Map<string, string | null>;
  byPrefix: Map<string, string>;
}

let memo: Promise<PrefixIndex> | null = null;
let memoBackend: unknown = null;
export function resetProviderNodePrefixCache(): void {
  memo = null;
}

async function loadPrefixes(): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const rows = await db().query<{ id: unknown; prefix: unknown }>(
    "SELECT id, prefix FROM provider_nodes"
  );
  for (const row of rows) {
    if (typeof row.id !== "string") continue;
    const prefix = typeof row.prefix === "string" ? row.prefix.trim() : "";
    map.set(row.id, prefix || null);
  }
  return map;
}

/**
 * Reverse index (prefix → node id) built from the same memoized prefix map.
 * Kept in the same module/backend memo so the two directions can never
 * disagree about which nodes exist.
 */
function buildPrefixToId(prefixes: Map<string, string | null>): Map<string, string> {
  const byPrefix = new Map<string, string>();
  for (const [id, prefix] of prefixes) {
    if (!prefix) continue;
    const key = prefix.toLowerCase();
    const current = byPrefix.get(key);
    // Prefixes are unique (lower(btrim(prefix)) index), but resolve a
    // duplicate deterministically anyway: keep the lowest id.
    if (current === undefined || id < current) byPrefix.set(key, id);
  }
  return byPrefix;
}

async function loadPrefixIndex(): Promise<PrefixIndex> {
  const byId = await loadPrefixes();
  return { byId, byPrefix: buildPrefixToId(byId) };
}

function ensurePrefixCache(): Promise<PrefixIndex> {
  const backend = db();
  if (backend !== memoBackend) {
    memo = null;
    memoBackend = backend;
  }
  if (memo === null) {
    const loading = loadPrefixIndex();
    memo = loading;
    // A failed load must not stay memoized.
    loading.catch(() => {
      if (memo === loading) memo = null;
    });
  }
  return memo;
}

/**
 * Returns the routing prefix (e.g. `aegy`) of a custom provider node, or null
 * when the id is not a node or has no prefix. Never throws (capability
 * resolution must stay best-effort).
 */
export async function getProviderNodePrefixSync(providerId: string): Promise<string | null> {
  if (!providerId) return null;
  try {
    return (await ensurePrefixCache()).byId.get(providerId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns the internal id of the custom provider node that owns `prefix`
 * (e.g. `nr` → `openai-compatible-responses-<uuid>`), or null when no node
 * declares it. Never throws (capability resolution must stay best-effort).
 *
 * Counterpart of {@link getProviderNodePrefixSync}: a node is reachable both by
 * its internal id (combo steps store it, #2778) and by its user-defined prefix
 * (what the catalog and prefix-addressed requests use), so every consumer that
 * keys persisted per-node state on one of the two forms needs to map to the other.
 */
export async function getProviderNodeIdByPrefixSync(prefix: string): Promise<string | null> {
  const key = typeof prefix === "string" ? prefix.trim().toLowerCase() : "";
  if (!key) return null;
  try {
    return (await ensurePrefixCache()).byPrefix.get(key) ?? null;
  } catch {
    return null;
  }
}
