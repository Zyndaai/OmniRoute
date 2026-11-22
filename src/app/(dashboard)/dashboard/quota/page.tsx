import { Suspense } from "react";
import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { CardSkeleton } from "@/shared/components";
import ProviderLimits from "../usage/components/ProviderLimits";

/** Optional read: when settings fail to load the page keeps its defaults (refresh off, 180 s). */
export async function loader() {
  const settings = await apiJsonOrNull<Record<string, unknown>>("/api/settings");
  return {
    autoRefreshEnabled:
      typeof settings?.autoRefreshProviderQuota === "boolean"
        ? settings.autoRefreshProviderQuota
        : false,
    autoRefreshInterval:
      typeof settings?.autoRefreshProviderQuotaInterval === "number"
        ? settings.autoRefreshProviderQuotaInterval
        : 180,
  };
}

export default function QuotaPage() {
  const { autoRefreshEnabled, autoRefreshInterval } = useLoaderData<typeof loader>();

  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<CardSkeleton />}>
        <ProviderLimits autoRefreshInterval={autoRefreshEnabled ? autoRefreshInterval : 0} />
      </Suspense>
    </div>
  );
}
