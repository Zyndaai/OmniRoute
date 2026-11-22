import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import RelayProxyClient, { type RelayToken } from "./RelayProxyClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("metadata", request);
  // Optional read: a failed read shows no tokens, as the old page did.
  const tokens = await apiJsonOrNull<RelayToken[]>("/api/relay/tokens");
  return {
    title: t("relayTitle"),
    description: t("relayDescription"),
    tokens: Array.isArray(tokens) ? tokens : [],
  };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(
    matches,
    loaderData
      ? [{ title: loaderData.title }, { name: "description", content: loaderData.description }]
      : []
  );

export default function RelayProxyPage() {
  const { tokens } = useLoaderData<typeof loader>();
  return <RelayProxyClient tokens={tokens} />;
}
