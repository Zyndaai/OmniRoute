import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import CostOverviewTab, { type UsageAnalyticsPayload } from "./CostOverviewTab";
import { parseApiKeyIds, parseCostRange } from "./costExplorerParams";

/**
 * Analytics for the range and API key filter in the URL. Optional read: when it fails the tab
 * shows its "overview load failed" error, as the client fetch did. A later change of the range
 * or key filter is fetched by the tab itself.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const params = new URL(request.url).searchParams;
  const range = parseCostRange(params.get("range"));
  const apiKeyFilter = parseApiKeyIds(params.get("apiKeyIds")).join(",");
  const analytics = await apiJsonOrNull<UsageAnalyticsPayload>("/api/usage/analytics", {
    query: {
      range,
      presets: "1d,7d,30d",
      includeFlatRateEstimates: "true",
      apiKeyIds: apiKeyFilter || undefined,
    },
  });
  return { analytics, range, apiKeyFilter };
}

export default function CostsPage() {
  const initial = useLoaderData<typeof loader>();
  return <CostOverviewTab initial={initial} />;
}
