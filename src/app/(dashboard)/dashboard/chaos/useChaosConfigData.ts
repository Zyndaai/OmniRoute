import { useMemo, useState } from "react";
import {
  DEFAULT_CHAOS_PAGE_CONFIG,
  type ChaosPageConfig,
  type ChaosProviderInfo,
} from "./chaosPageTypes";

function pickProviderName(conn: any): string {
  return conn.provider || conn.name || conn.id || "";
}

function toProviderInfo(conn: any, providerName: string): ChaosProviderInfo {
  return {
    id: conn.id,
    name: conn.name || conn.provider || providerName,
    provider: conn.provider || providerName,
    defaultModel: conn.defaultModel || null,
  };
}

/** Extract a deduplicated ChaosProviderInfo[] from the /api/providers connections payload. */
function extractProvidersFromPayload(payload: unknown): ChaosProviderInfo[] {
  const allConnections = (payload as any)?.connections || (payload as any)?.data || payload;
  if (!Array.isArray(allConnections)) return [];

  const extracted: ChaosProviderInfo[] = [];
  const seenProvider = new Set<string>();
  for (const conn of allConnections) {
    const providerName = pickProviderName(conn);
    if (!providerName || seenProvider.has(providerName.toLowerCase())) continue;
    seenProvider.add(providerName.toLowerCase());
    extracted.push(toProviderInfo(conn, providerName));
  }
  return extracted;
}

/** The persisted chaos config from the `/api/chaos/config` payload (default when absent). */
export function chaosConfigFromPayload(payload: unknown): ChaosPageConfig {
  return (payload as { config?: ChaosPageConfig } | null)?.config || DEFAULT_CHAOS_PAGE_CONFIG;
}

/** The deduplicated providers from the `/api/providers` payload ([] when absent). */
export function chaosProvidersFromPayload(payload: unknown): ChaosProviderInfo[] {
  return payload ? extractProvidersFromPayload(payload) : [];
}

/**
 * Chaos config + provider-connection state for the Chaos Mode config page. The route loader
 * reads both; the config is editable, so it is kept as a local copy that every new loader
 * result replaces. Extracted out of the page component to keep it under the
 * complexity/size ratchet (config/quality/complexity-baseline.json).
 */
export function useChaosConfigData(loadedConfig: ChaosPageConfig, providers: ChaosProviderInfo[]) {
  const [config, setConfig] = useState<ChaosPageConfig>(loadedConfig);
  const [shownLoadedConfig, setShownLoadedConfig] = useState(loadedConfig);
  if (loadedConfig !== shownLoadedConfig) {
    setShownLoadedConfig(loadedConfig);
    setConfig(loadedConfig);
  }

  // Build a unique list of provider names from active connections for the dropdown
  const availableProviders = useMemo(() => {
    const seen = new Set<string>();
    return providers.filter((p) => {
      const key = p.provider || p.name || p.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [providers]);

  return { config, setConfig, availableProviders };
}
