import { useCallback, useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import type { CooldownConnection } from "@/lib/resilience/cooldownManager";

export type CooldownProfile = { baseCooldownMs: number; maxBackoffSteps: number };

export interface CooldownRules {
  streamStallCooldown: boolean;
  oauth: CooldownProfile;
  apikey: CooldownProfile;
}

export interface ClearResult {
  cleared: number;
  unchanged: number;
  skippedTerminal: number;
  lockoutsCleared: number;
}

const POLL_INTERVAL_MS = 15000;

function toProfile(value: unknown): CooldownProfile {
  const record = (value ?? {}) as Partial<CooldownProfile>;
  return {
    baseCooldownMs: Number(record.baseCooldownMs ?? 0),
    maxBackoffSteps: Number(record.maxBackoffSteps ?? 0),
  };
}

export function toCooldownRules(json: Record<string, unknown>): CooldownRules {
  const cooldown = (json.connectionCooldown ?? {}) as Record<string, unknown>;
  const stall = (json.streamStallCooldown ?? {}) as { enabled?: boolean };
  return {
    streamStallCooldown: stall.enabled === true,
    oauth: toProfile(cooldown.oauth),
    apikey: toProfile(cooldown.apikey),
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** What the route loader read: both reads succeeded, or `failed` with nothing else. */
export interface CooldownLoad {
  connections: CooldownConnection[] | null;
  rules: CooldownRules | null;
  failed: boolean;
}

/**
 * Connections + cooldown rules for the cooldown manager. The route loader supplies them and
 * this hook re-runs it every few seconds while the tab is visible; a failed re-read keeps the
 * last good data (only `loadError` flips).
 */
export function useCooldownData(loaded: CooldownLoad) {
  const revalidator = useRevalidator();
  const [connections, setConnections] = useState(loaded.connections);
  const [rules, setRules] = useState(loaded.rules);
  const [shownLoaded, setShownLoaded] = useState(loaded);
  if (loaded !== shownLoaded) {
    setShownLoaded(loaded);
    if (loaded.connections && loaded.rules) {
      setConnections(loaded.connections);
      setRules(loaded.rules);
    }
  }
  const loadError = loaded.failed;

  const refresh = useCallback(async () => {
    await revalidator.revalidate();
  }, [revalidator]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && revalidator.state === "idle") void revalidator.revalidate();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [revalidator]);

  const clearCooldowns = useCallback(
    async (body: { connectionIds?: string[]; all?: boolean; provider?: string }) => {
      const result = (await fetchJson("/api/resilience/cooldowns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })) as unknown as ClearResult;
      await refresh();
      return result;
    },
    [refresh]
  );

  const saveRules = useCallback(async (next: CooldownRules) => {
    const json = await fetchJson("/api/resilience", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamStallCooldown: { enabled: next.streamStallCooldown },
        connectionCooldown: { oauth: next.oauth, apikey: next.apikey },
      }),
    });
    setRules(toCooldownRules(json));
  }, []);

  return { connections, rules, loadError, refresh, clearCooldowns, saveRules };
}
