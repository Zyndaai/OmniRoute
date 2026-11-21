import { lazy, Suspense } from "react";
import { ClientOnly } from "@/shared/components/ClientOnly";
import type { PoolUsageSnapshot } from "@/lib/quota/types";

const BurnRateChartInner = lazy(() => import("./BurnRateChartInner"));

export interface BurnRateChartProps {
  usage: PoolUsageSnapshot | null;
}

export default function BurnRateChart({ usage }: BurnRateChartProps) {
  return (
    <ClientOnly>
      {() => (
        <Suspense fallback={null}>
          <BurnRateChartInner usage={usage} />
        </Suspense>
      )}
    </ClientOnly>
  );
}
