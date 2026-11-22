import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import CavemanContextPageClient, { type CavemanInitialData } from "./CavemanContextPageClient";

/**
 * Every read is optional, as before: a failing one leaves its part of the page empty (no
 * analytics, default settings, no language packs).
 */
export async function loader(): Promise<CavemanInitialData> {
  const [analytics, settings, packs] = await Promise.all([
    apiJsonOrNull<CavemanInitialData["analytics"]>("/api/context/analytics", {
      query: { since: "7d" },
    }),
    apiJsonOrNull<CavemanInitialData["settings"]>("/api/context/caveman/config"),
    apiJsonOrNull<{ packs?: CavemanInitialData["languagePacks"] }>(
      "/api/compression/language-packs"
    ),
  ]);
  return {
    analytics,
    settings,
    languagePacks: Array.isArray(packs?.packs) ? packs.packs : [],
  };
}

export default function CavemanContextPage() {
  const initial = useLoaderData<typeof loader>();
  return <CavemanContextPageClient initial={initial} />;
}
