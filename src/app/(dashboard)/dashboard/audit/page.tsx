import { useLoaderData } from "react-router";
import { apiJson, apiRequest } from "@/server/routing/dashboardApi.server";
import ComplianceTab from "./ComplianceTab";

const PAGE_SIZE = 50;

/**
 * First page of the audit log for the default (unfiltered) view. Optional read: on an error the
 * tab shows its "failed to fetch" alert over an empty table, as the client fetch did. The total
 * comes from the `x-total-count` header, so this reads the response directly.
 */
export async function loader() {
  const response = await apiRequest("/api/compliance/audit-log", {
    query: { limit: PAGE_SIZE, offset: 0 },
  });
  // apiJson throws the login redirect for a 401; the call is repeated only to get it.
  if (response.status === 401) await apiJson("/api/compliance/audit-log");
  const body = await response.json().catch(() => []);
  const total = Number(response.headers.get("x-total-count") || "0");
  return {
    entries: response.ok && Array.isArray(body) ? body : [],
    totalCount: response.ok && Number.isFinite(total) ? total : 0,
    failed: !response.ok,
  };
}

export default function AuditPage() {
  const initial = useLoaderData<typeof loader>();
  return <ComplianceTab initial={initial} />;
}
