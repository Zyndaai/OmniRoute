/** Upstream proxy config persistence for upstream_proxy_config table. */
import { db, jsonb } from "@/lib/db/pg";
import { toIntOrNull } from "@/lib/db/proxies/sanitize";
import {
  isCloudMetadataHost,
  isPrivateHost as isPrivateNetworkHost,
  mappedIpv4Host,
} from "@/shared/network/outboundUrlGuard";
import { normalizeHost } from "@/shared/network/privateHost";

/** Which embedded proxy handles the retry leg when mode === "fallback". */
export type FallbackBackend = "cliproxyapi" | "dario";

interface UpstreamProxyConfig {
  providerId: string;
  mode: string;
  cliproxyapiModelMapping: Record<string, unknown> | null;
  nativePriority: number;
  cliproxyapiPriority: number;
  enabled: boolean;
  family: string;
  // #dario: retry-leg backend for mode="fallback" ("cliproxyapi" default).
  fallbackBackend: FallbackBackend;
  createdAt: string;
  updatedAt: string;
}

interface UpstreamProxyRow {
  provider_id: unknown;
  mode: unknown;
  cliproxyapi_model_mapping: unknown;
  native_priority: unknown;
  cliproxyapi_priority: unknown;
  enabled: unknown;
  family: unknown;
  fallback_backend: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Reject a proxy target that is private or cloud-metadata, judging the ADDRESS
 * rather than its spelling.
 *
 * This module used to carry its own prefix regexes, which matched only the
 * dotted form: `http://169.254.169.254` was refused while
 * `http://[::ffff:169.254.169.254]` — the same address, serialised by WHATWG
 * URL as `::ffff:a9fe:a9fe` — was accepted, as were `::ffff:10.0.0.5`,
 * `fd00::/8`, `fe80::/10` and CGNAT `100.64.0.0/10`. #10843 fixed exactly that
 * class in the shared guard; routing this copy through the same helpers keeps
 * the two from drifting apart again.
 *
 * The deliberate exception stays: CLIProxyAPI runs on localhost:8317, so
 * loopback is allowed — and now so is its mapped spelling, for the same
 * address-not-spelling reason.
 */
function isPrivateHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  const asIpv4 = mappedIpv4Host(normalized) ?? normalized;

  if (LOOPBACK_HOSTNAMES.has(normalized) || LOOPBACK_HOSTNAMES.has(asIpv4)) return false;

  return isCloudMetadataHost(normalized) || isPrivateNetworkHost(normalized);
}

export function validateProxyUrl(
  url: string
): { valid: true; url: string } | { valid: false; error: string } {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return {
        valid: false,
        error: `Unsupported protocol "${parsed.protocol}" — use http or https`,
      };
    }
    if (isPrivateHost(parsed.hostname)) {
      return {
        valid: false,
        error: `Proxy URL cannot point to private/internal address "${parsed.hostname}"`,
      };
    }
    return { valid: true, url };
  } catch {
    return { valid: false, error: `Invalid URL: "${url}"` };
  }
}

/** Normalize an arbitrary stored/user value to a valid FallbackBackend. */
function normalizeFallbackBackend(value: unknown): FallbackBackend {
  return value === "dario" ? "dario" : "cliproxyapi";
}

function rowToConfig(record: Record<string, unknown>): UpstreamProxyConfig {
  // jsonb arrives parsed; a legacy JSON string is still accepted.
  let mapping: Record<string, unknown> | null = null;
  const rawMapping = record.cliproxyapi_model_mapping;
  if (rawMapping && typeof rawMapping === "object") {
    mapping = rawMapping as Record<string, unknown>;
  } else if (rawMapping && typeof rawMapping === "string") {
    try {
      mapping = JSON.parse(rawMapping);
    } catch {
      mapping = null;
    }
  }
  return {
    providerId: record.provider_id as string,
    mode: record.mode as string,
    cliproxyapiModelMapping: mapping,
    nativePriority: record.native_priority as number,
    cliproxyapiPriority: record.cliproxyapi_priority as number,
    enabled: record.enabled === 1 || record.enabled === true,
    family: typeof record.family === "string" ? record.family : "auto",
    fallbackBackend: normalizeFallbackBackend(record.fallback_backend),
    createdAt: record.created_at as string,
    updatedAt: record.updated_at as string,
  };
}
export async function getUpstreamProxyConfig(providerId: string) {
  const row = await db().queryOne<UpstreamProxyRow>(
    "SELECT * FROM upstream_proxy_config WHERE provider_id = $1",
    [providerId]
  );
  if (!row) return null;
  return rowToConfig(toRecord(row));
}

export async function upsertUpstreamProxyConfig(data: {
  providerId: string;
  mode?: string;
  cliproxyapiModelMapping?: Record<string, unknown> | null;
  nativePriority?: number;
  cliproxyapiPriority?: number;
  enabled?: boolean;
  family?: string;
  fallbackBackend?: FallbackBackend;
}) {
  const mode = data.mode ?? "native";
  const cliproxyapiModelMapping =
    data.cliproxyapiModelMapping !== undefined ? jsonb(data.cliproxyapiModelMapping) : null;
  const nativePriority = toIntOrNull(data.nativePriority) ?? 1;
  const cliproxyapiPriority = toIntOrNull(data.cliproxyapiPriority) ?? 2;
  const enabled = data.enabled !== false;
  const family = data.family ?? "auto";
  const fallbackBackend = normalizeFallbackBackend(data.fallbackBackend);

  await db().execute(
    `INSERT INTO upstream_proxy_config
     (provider_id, mode, cliproxyapi_model_mapping, native_priority, cliproxyapi_priority, enabled, family, fallback_backend, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT (provider_id) DO UPDATE SET
       mode = EXCLUDED.mode,
       cliproxyapi_model_mapping = EXCLUDED.cliproxyapi_model_mapping,
       native_priority = EXCLUDED.native_priority,
       cliproxyapi_priority = EXCLUDED.cliproxyapi_priority,
       enabled = EXCLUDED.enabled,
       family = EXCLUDED.family,
       fallback_backend = EXCLUDED.fallback_backend,
       updated_at = now()`,
    [
      data.providerId,
      mode,
      cliproxyapiModelMapping,
      nativePriority,
      cliproxyapiPriority,
      enabled,
      family,
      fallbackBackend,
    ]
  );

  return getUpstreamProxyConfig(data.providerId);
}

export async function updateUpstreamProxyConfig(
  providerId: string,
  updates: Record<string, unknown>
) {
  const current = await getUpstreamProxyConfig(providerId);
  if (!current) {
    throw new Error(`Provider ${providerId} not found`);
  }

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  const set = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (updates.mode !== undefined) set("mode", updates.mode);
  if (updates.cliproxyapiModelMapping !== undefined) {
    set("cliproxyapi_model_mapping", jsonb(updates.cliproxyapiModelMapping), "::jsonb");
  }
  const nativePriority = toIntOrNull(updates.nativePriority);
  if (nativePriority !== null) set("native_priority", nativePriority);
  const cliproxyapiPriority = toIntOrNull(updates.cliproxyapiPriority);
  if (cliproxyapiPriority !== null) set("cliproxyapi_priority", cliproxyapiPriority);
  if (updates.enabled !== undefined) set("enabled", updates.enabled === true);
  if (updates.family !== undefined) set("family", updates.family);
  if (updates.fallbackBackend !== undefined) {
    set("fallback_backend", normalizeFallbackBackend(updates.fallbackBackend));
  }

  params.push(providerId);
  await db().execute(
    `UPDATE upstream_proxy_config SET ${sets.join(", ")} WHERE provider_id = $${params.length}`,
    params
  );

  return getUpstreamProxyConfig(providerId);
}

export async function deleteUpstreamProxyConfig(providerId: string) {
  const result = await db().execute("DELETE FROM upstream_proxy_config WHERE provider_id = $1", [
    providerId,
  ]);
  return result.changes > 0;
}

export async function getProvidersByMode(mode: string) {
  const rows = await db().query<UpstreamProxyRow>(
    "SELECT * FROM upstream_proxy_config WHERE mode = $1 AND enabled = true ORDER BY provider_id",
    [mode]
  );
  return rows.map((row) => rowToConfig(toRecord(row)));
}

export async function getFallbackChainForProvider(providerId: string) {
  const config = await getUpstreamProxyConfig(providerId);
  if (!config) return [];

  const chain: { executor: "native" | "cliproxyapi" | "dario"; priority: number }[] = [];

  if (config.enabled) {
    chain.push({ executor: "native", priority: config.nativePriority });
    if (config.mode === "cliproxyapi") {
      chain.push({ executor: "cliproxyapi", priority: config.cliproxyapiPriority });
    } else if (config.mode === "dario") {
      chain.push({ executor: "dario", priority: config.cliproxyapiPriority });
    } else if (config.mode === "fallback") {
      chain.push({ executor: config.fallbackBackend, priority: config.cliproxyapiPriority });
    }
  }

  chain.sort((a, b) => a.priority - b.priority);
  return chain;
}
