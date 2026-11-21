import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import ConductorPageClient from "./ConductorPageClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("conductor", request);
  return { title: t("title"), description: t("subtitle") };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function ConductorPage() {
  return <ConductorPageClient />;
}
