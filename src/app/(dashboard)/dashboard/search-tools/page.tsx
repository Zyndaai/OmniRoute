import { useLoaderData } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import type { SearchProviderCatalogItem } from "@/shared/schemas/searchTools";
import SearchToolsClient from "./SearchToolsClient";

// Optional read: the old page showed empty provider lists when the call failed.
export async function loader() {
  const body = await apiJsonOrNull<{ providers?: SearchProviderCatalogItem[] }>(
    "/api/search/providers"
  );
  return {
    catalogProviders: Array.isArray(body?.providers)
      ? body.providers
      : ([] as SearchProviderCatalogItem[]),
  };
}

export default function SearchToolsPage() {
  const { catalogProviders } = useLoaderData<typeof loader>();
  return <SearchToolsClient catalogProviders={catalogProviders} />;
}
