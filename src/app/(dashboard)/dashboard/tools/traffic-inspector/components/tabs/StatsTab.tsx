import { lazy, Suspense } from "react";
import { ClientOnly } from "@/shared/components/ClientOnly";
import { useTranslations } from "use-intl";
import type { InterceptedRequest } from "@/mitm/inspector/types";

interface StatsTabProps {
  requests: InterceptedRequest[];
}

// The Recharts bundle is split out and only loaded in the browser.
const StatsCharts = lazy(() => import("./StatsCharts"));

function LoadingCharts() {
  const t = useTranslations("trafficInspector");
  return <div className="p-4 text-sm text-text-muted">{t("loadingCharts")}</div>;
}

export function StatsTab({ requests }: StatsTabProps) {
  const t = useTranslations("trafficInspector");
  if (requests.length === 0) {
    return <div className="p-4 text-sm text-text-muted">{t("statsNoData")}</div>;
  }
  return (
    <ClientOnly fallback={<LoadingCharts />}>
      {() => (
        <Suspense fallback={<LoadingCharts />}>
          <StatsCharts requests={requests} />
        </Suspense>
      )}
    </ClientOnly>
  );
}
