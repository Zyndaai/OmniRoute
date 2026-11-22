import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import type { ProviderUtilizationResponse } from "@/shared/types/utilization";
import ProviderUtilizationTab from "../ProviderUtilizationTab";

/**
 * The default view (24h, by provider). Optional read: when it fails the tab shows its load
 * error, as the client fetch did. Changing the range or grouping is fetched by the tab itself.
 */
export async function loader() {
  return {
    utilization: await apiJsonOrNull<ProviderUtilizationResponse>("/api/usage/utilization", {
      query: { range: "24h", aggregateBy: "provider" },
    }),
  };
}

export default function AnalyticsUtilizationPage() {
  const { utilization } = useLoaderData<typeof loader>();
  return <ProviderUtilizationTab initial={utilization} />;
}
