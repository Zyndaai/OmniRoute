import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import CompressionAnalyticsTab, {
  type CompressionAnalyticsSummary,
} from "../CompressionAnalyticsTab";

/**
 * The default (24h) summary. Optional read: when it fails the tab shows its "no data" state,
 * as the client fetch did. Picking another window is fetched by the tab itself.
 */
export async function loader() {
  return {
    stats: await apiJsonOrNull<CompressionAnalyticsSummary>("/api/analytics/compression", {
      query: { since: "24h" },
    }),
  };
}

export default function AnalyticsCompressionPage() {
  const { stats } = useLoaderData<typeof loader>();
  return <CompressionAnalyticsTab initial={stats} />;
}
