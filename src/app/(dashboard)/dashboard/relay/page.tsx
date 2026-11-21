import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import RelayProxyClient from "./RelayProxyClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("metadata", request);
  return { title: t("relayTitle"), description: t("relayDescription") };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function RelayProxyPage() {
  return <RelayProxyClient />;
}
