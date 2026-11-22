import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import CompressionPanel from "./CompressionPanel";
import CompressionStylesTile, { type CompressionStylesSummary } from "../CompressionStylesTile";

/**
 * Only the telemetry tile is read here; the panel keeps its own load (it seeds a save queue
 * and retry logic from the GET). The read is optional: a failure shows an empty summary.
 */
export async function loader() {
  return {
    stylesSummary: await apiJsonOrNull<CompressionStylesSummary>(
      "/api/settings/compression/run-telemetry"
    ),
  };
}

export default function CompressionSettingsPage() {
  const { stylesSummary } = useLoaderData<typeof loader>();
  return (
    <div className="flex flex-col gap-4 p-4">
      <CompressionPanel />
      {/* D0: read-only telemetry tile (output-token savings + applied styles) */}
      <CompressionStylesTile summary={stylesSummary} />
    </div>
  );
}
