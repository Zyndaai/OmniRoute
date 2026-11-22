import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import RuntimePageClient, {
  type RuntimeConnection,
  type RuntimeData,
  type RuntimeHealthPayload,
} from "./RuntimePageClient";

/**
 * Health snapshot + connections. The page re-runs this loader every few seconds, and the old
 * page took a failed read as "no data" (health `null`, connections `[]`), so both reads are
 * optional. Connections are projected to the fields the runtime page shows.
 */
export async function loader(): Promise<RuntimeData> {
  const [health, clients] = await Promise.all([
    apiJsonOrNull<RuntimeHealthPayload>("/api/monitoring/health"),
    apiJsonOrNull<{ connections?: RuntimeConnection[] }>("/api/providers/client"),
  ]);
  const connections = Array.isArray(clients?.connections) ? clients.connections : [];
  return {
    health,
    connections: connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name,
      displayName: c.displayName,
      email: c.email,
      authType: c.authType,
      rateLimitedUntil: c.rateLimitedUntil,
      testStatus: c.testStatus,
      lastError: c.lastError,
      lastErrorType: c.lastErrorType,
      errorCode: c.errorCode,
      backoffLevel: c.backoffLevel,
    })),
    serverNow: Date.now(),
  };
}

export default function RuntimePage() {
  const loaded = useLoaderData<typeof loader>();
  return <RuntimePageClient loaded={loaded as RuntimeData} />;
}
