import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useTranslations } from "use-intl";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import { TrafficInspectorPageClient } from "./TrafficInspectorPageClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("metadata", request);
  return { title: t("trafficInspectorTitle"), description: t("trafficInspectorDescription") };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function TrafficInspectorPage() {
  const t = useTranslations("sidebar");
  return (
    <TrafficInspectorPageClient
      title={t("trafficInspector")}
      subtitle={t("trafficInspectorSubtitle")}
      purpose={t("trafficInspectorPurpose")}
    />
  );
}
