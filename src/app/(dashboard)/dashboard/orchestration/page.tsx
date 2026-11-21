import { Suspense } from "react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import OrchestrationPageClient from "./OrchestrationPageClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("orchestration", request);
  return { title: t("title"), description: t("description") };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function OrchestrationPage() {
  return (
    <Suspense fallback={null}>
      <OrchestrationPageClient />
    </Suspense>
  );
}
