import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { skipSearchOnlyRevalidation } from "@/shared/utils/routeRevalidation";
import { pageMeta } from "@/shared/utils/pageMeta";
import type { ProviderOptionsData } from "./hooks/useProviderOptions";
import TranslatorPageClient from "./TranslatorPageClient";

/**
 * Providers and provider nodes for the Translate tab's provider list. Both reads are optional:
 * when they fail the list falls back to the static provider catalog, as before. Only the fields
 * the option builder reads are returned.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("translator", request);
  const [providers, nodes] = await Promise.all([
    apiJsonOrNull<{ connections?: Array<{ provider: string; isActive?: boolean }> }>(
      "/api/providers"
    ),
    apiJsonOrNull<{ nodes?: Array<{ id: string; name?: string; prefix?: string }> }>(
      "/api/provider-nodes"
    ),
  ]);
  const providerData: ProviderOptionsData = {
    connections: (providers?.connections || []).map((c) => ({
      provider: c.provider,
      isActive: c.isActive,
    })),
    nodes: (nodes?.nodes || []).map((n) => ({ id: n.id, name: n.name, prefix: n.prefix })),
  };
  return { title: t("metaTitle"), description: t("metaDescription"), providerData };
}

/** The tab and the open accordion live in the query string; they do not need new reads. */
export const shouldRevalidate = skipSearchOnlyRevalidation;

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function TranslatorPage() {
  const { providerData } = useLoaderData<typeof loader>();
  return <TranslatorPageClient providerData={providerData} />;
}
