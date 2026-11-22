import { useLoaderData } from "react-router";
import { apiRead } from "@/server/routing/dashboardApi.server";
import { DiscoveryPageClient, type DiscoveryResult } from "./DiscoveryPageClient";

/** A failed read shows the empty list plus a "load failed" message, as the old page did. */
export async function loader() {
  const read = await apiRead<{ results?: DiscoveryResult[] }>("/api/discovery/results");
  const results = read.ok && Array.isArray(read.data?.results) ? read.data.results : [];
  return { results, loadFailed: !read.ok };
}

export default function DiscoveryPage() {
  const { results, loadFailed } = useLoaderData<typeof loader>();
  return <DiscoveryPageClient results={results} loadFailed={loadFailed} />;
}
