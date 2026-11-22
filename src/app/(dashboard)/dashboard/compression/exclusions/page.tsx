import { useLoaderData } from "react-router";
import { apiRead } from "@/server/routing/dashboardApi.server";
import ExclusionsPanel from "./ExclusionsPanel";

/**
 * The stored exclusion list. Optional read, but a failed one is not an empty list: the panel
 * locks its editor with the status so a Save cannot overwrite the stored list with nothing.
 */
export async function loader() {
  const result = await apiRead<{ exclusions?: unknown }>("/api/settings/compression");
  if (result.ok && Array.isArray(result.data?.exclusions)) {
    return { exclusions: result.data.exclusions as string[], loadError: null };
  }
  return { exclusions: [] as string[], loadError: result.ok ? "" : String(result.status) };
}

export default function CompressionExclusionsPage() {
  const { exclusions, loadError } = useLoaderData<typeof loader>();
  return (
    <div className="flex flex-col gap-4 p-4">
      <ExclusionsPanel exclusions={exclusions} loadError={loadError} />
    </div>
  );
}
