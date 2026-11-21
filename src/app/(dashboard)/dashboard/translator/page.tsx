import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import TranslatorPageClient from "./TranslatorPageClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("translator", request);
  return { title: t("metaTitle"), description: t("metaDescription") };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function TranslatorPage() {
  return <TranslatorPageClient />;
}
