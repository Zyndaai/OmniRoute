import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import MediaPageClient from "./MediaPageClient";

const LOCAL_PROVIDERS = ["sdwebui", "comfyui"];

/**
 * Optional read: which local providers have a connection. When the read fails the page keeps
 * every local provider visible (`null`), as before.
 */
export async function loader() {
  const data = await apiJsonOrNull<
    { provider?: string }[] | { connections?: { provider?: string }[]; providers?: unknown }
  >("/api/providers");
  if (data === null) return { configuredLocalProviderIds: null };
  const connections: { provider?: string }[] = Array.isArray(data)
    ? data
    : ((data?.connections ?? data?.providers ?? []) as { provider?: string }[]);
  const configured = new Set<string>();
  for (const conn of connections) {
    const id = conn?.provider;
    if (id && LOCAL_PROVIDERS.includes(id)) configured.add(id);
  }
  return { configuredLocalProviderIds: [...configured] };
}

export default function MediaPage() {
  const { configuredLocalProviderIds } = useLoaderData<typeof loader>();
  return <MediaPageClient configuredLocalProviderIds={configuredLocalProviderIds} />;
}
