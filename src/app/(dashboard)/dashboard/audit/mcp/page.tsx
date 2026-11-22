import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import McpAuditTab, { type McpAuditInitial } from "../McpAuditTab";

/**
 * First page of the MCP audit log (default filters) and its stats. Both are optional: when a read
 * fails the tab shows an empty table / no stats card, as the client fetches did.
 */
export async function loader(): Promise<McpAuditInitial> {
  const [audit, stats] = await Promise.all([
    apiJsonOrNull<NonNullable<McpAuditInitial["audit"]>>("/api/mcp/audit", {
      query: { limit: 25, offset: 0 },
    }),
    apiJsonOrNull<NonNullable<McpAuditInitial["stats"]>>("/api/mcp/audit/stats"),
  ]);
  return { audit, stats };
}

export default function AuditMcpPage() {
  const initial = useLoaderData<typeof loader>();
  return <McpAuditTab initial={initial} />;
}
