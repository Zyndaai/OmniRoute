import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import ConductorPageClient, { type FleetSnapshot } from "./ConductorPageClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("conductor", request);
  // The page polls this loader: a failed read is `null` and the page keeps its last snapshot.
  const fleet = await apiJsonOrNull<FleetSnapshot>("/api/conductor/fleet");
  return { title: t("title"), description: t("subtitle"), fleet };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function ConductorPage() {
  const { fleet } = useLoaderData<typeof loader>();
  return <ConductorPageClient loaded={fleet} />;
}
