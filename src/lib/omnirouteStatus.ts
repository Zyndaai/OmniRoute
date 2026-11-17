import { db } from "@/lib/db/pg";
import { listPools } from "@/lib/db/quotaPools";

interface ProviderStatusRow {
  id: string;
  provider: string;
  is_active: boolean;
  test_status: string | null;
  last_error: string | null;
}

async function readProviderStatusRows(): Promise<ProviderStatusRow[]> {
  return db().query<ProviderStatusRow>(
    "SELECT id, provider, is_active, test_status, last_error FROM provider_connections"
  );
}

async function isDatabaseReachable(): Promise<boolean> {
  try {
    return (await db().health()).ok;
  } catch {
    return false;
  }
}

export async function buildOmniRouteStatus() {
  const [connections, circuitModule, quotaMonitorModule, reachable] = await Promise.all([
    readProviderStatusRows(),
    import("@/shared/utils/circuitBreaker").catch(() => null),
    import("../../open-sse/services/quotaMonitor").catch(() => null),
    isDatabaseReachable(),
  ]);
  const pools = (await listPools()).items;
  const circuitStatuses = circuitModule ? await circuitModule.getAllCircuitBreakerStatuses() : null;
  const quotaSummary = quotaMonitorModule?.getQuotaMonitorSummary() ?? null;
  const active = connections.filter((connection) => connection.is_active);
  const disabled = connections.filter((connection) => !connection.is_active);
  const healthy = active.filter((connection) => connection.test_status === "active");

  return {
    gateway: reachable ? "healthy" : "degraded",
    catalog: { available: true },
    providers: {
      configured: connections.length,
      active: active.length,
      healthy: healthy.length,
      disabled: disabled.length,
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        active: connection.is_active,
        health: !connection.is_active
          ? "disabled"
          : connection.test_status === "active"
            ? "healthy"
            : "unknown",
        failureState: connection.last_error ? "recent_error" : "none",
      })),
    },
    pools: {
      count: pools.length,
      allocations: pools.reduce((count, pool) => count + pool.allocations.length, 0),
      items: pools.map((pool) => ({
        id: pool.id,
        name: pool.name,
        connectionIds: pool.connectionIds,
        allocationCount: pool.allocations.length,
      })),
    },
    quotaMonitoring: {
      authoritative: quotaSummary?.active ?? 0,
      headerBased: 0,
      configured: 0,
      unsupported: quotaSummary ? Math.max(0, active.length - quotaSummary.active) : null,
      status: quotaSummary?.active ? "partial" : "unknown",
    },
    circuits: circuitStatuses
      ? {
          open: circuitStatuses.filter((c) => c.state === "OPEN").length,
          halfOpen: circuitStatuses.filter((c) => c.state === "HALF_OPEN").length,
          closed: circuitStatuses.filter((c) => c.state === "CLOSED").length,
          source: "persisted circuit breaker registry",
        }
      : { status: "unknown", source: "resilience subsystem unavailable" },
    usage: { source: "usage_history and call_logs", liveRequestsExecuted: false },
    budgets: { source: "internal governance limits", upstreamQuotaClaims: false },
  };
}
