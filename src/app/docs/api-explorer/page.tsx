import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useTranslations } from "use-intl";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import { ApiExplorerClient } from "../components/ApiExplorerClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("docs", request);
  return {
    title: t("apiExplorerMetadataTitle"),
    description: t("apiExplorerMetadataDescription"),
  };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function ApiExplorerPage() {
  const t = useTranslations("docs");
  return (
    <div>
      <h1 className="ci-heading text-3xl mb-2">{t("apiExplorerTitle")}</h1>
      <p className="text-text-muted mb-8">{t("apiExplorerDescription")}</p>
      <ApiExplorerClient />
    </div>
  );
}
