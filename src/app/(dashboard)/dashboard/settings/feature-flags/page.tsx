import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import FeatureFlagsGrid, { type FeatureFlagsData } from "../components/FeatureFlagsGrid";

// A failed read hands the grid `null`; it then fetches the flags itself and shows the same error
// state with a retry button as before. The restart probe (`/api/health/ping`) stays client-side.
export async function loader() {
  return { flags: await apiJsonOrNull<FeatureFlagsData>("/api/settings/feature-flags") };
}

export default function FeatureFlagsPage() {
  const { flags } = useLoaderData<typeof loader>();
  return <FeatureFlagsGrid initialData={flags} />;
}
