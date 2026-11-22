import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import {
  isAnthropicCompatibleProvider,
  isClaudeCodeCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { skipSearchOnlyRevalidation } from "@/shared/utils/routeRevalidation";
import ProviderDetailPageClient from "./ProviderDetailPageClient";
import type { ProviderConnectionsInitialData } from "./hooks/useProviderConnections";
import {
  connectionBelongsToProviderPage,
  getProviderConnectionsRequestUrl,
} from "../providerPageUtils";

// `?action=add-api-key` only opens a modal; the loader reads nothing from the query string.
export const shouldRevalidate = skipSearchOnlyRevalidation;

type ProviderNodesResponse = { nodes?: Array<{ id?: string }> };

/**
 * First paint: this provider's connections and (for compatible providers) its node. Both reads
 * are optional, as they were client-side: a failed read leaves `null` / `nodeResolved: false`
 * and the page keeps what it shows. Model metadata, aliases, quota, proxy settings and the
 * referral link stay client-side (secondary panels, several of them upstream-backed).
 */
export async function loader({
  params,
}: LoaderFunctionArgs): Promise<ProviderConnectionsInitialData> {
  const providerId = params.id as string;
  const isCompatible =
    isOpenAICompatibleProvider(providerId) ||
    isClaudeCodeCompatibleProvider(providerId) ||
    isAnthropicCompatibleProvider(providerId);

  const [connectionsData, nodesData] = await Promise.all([
    apiJsonOrNull<{ connections?: Array<{ provider?: string }> }>(
      getProviderConnectionsRequestUrl(providerId)
    ),
    apiJsonOrNull<ProviderNodesResponse>("/api/provider-nodes"),
  ]);

  const connections = connectionsData
    ? (connectionsData.connections || []).filter((c) =>
        connectionBelongsToProviderPage(c.provider, providerId)
      )
    : null;

  let node: unknown = null;
  const nodeResolved = nodesData !== null;
  if (nodesData) {
    node = (nodesData.nodes || []).find((entry) => entry.id === providerId) || null;
    // A newly created compatible node can be briefly unavailable on one worker.
    if (!node && isCompatible) {
      for (let attempt = 0; attempt < 3 && !node; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const retry = await apiJsonOrNull<ProviderNodesResponse>("/api/provider-nodes");
        node = retry?.nodes?.find((entry) => entry.id === providerId) || null;
      }
    }
  }

  return {
    connections: connections as ProviderConnectionsInitialData["connections"],
    node,
    nodeResolved,
  };
}

// Thin route wrapper — all logic lives in ProviderDetailPageClient (Issue #3501,
// Phase 0 of the strangler-fig decomposition of this 12.8K-LOC god-component).
// The client reads the route id itself via useParams(), so no props are threaded.
export default function ProviderDetailPage() {
  const initialConnectionsData = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  return (
    <ProviderDetailPageClient
      initialConnectionsData={initialConnectionsData as ProviderConnectionsInitialData}
      revalidate={revalidate}
    />
  );
}
