/**
 * /dashboard/chaos/page.tsx — Chaos Mode Configuration
 */
import { useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import ChaosConfigPageClient from "./ChaosConfigPageClient";
import { chaosConfigFromPayload, chaosProvidersFromPayload } from "./useChaosConfigData";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("chaosConfig", request);
  // Both reads are optional: the old page kept the default config / an empty provider list
  // when either failed.
  const [config, providers] = await Promise.all([
    apiJsonOrNull("/api/chaos/config"),
    apiJsonOrNull("/api/providers"),
  ]);
  return {
    title: `${t("pageTitle")} — OmniRoute`,
    config: chaosConfigFromPayload(config),
    providers: chaosProvidersFromPayload(providers),
  };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(matches, loaderData ? [{ title: loaderData.title }] : []);

export default function Page() {
  const { config, providers } = useLoaderData<typeof loader>();
  return <ChaosConfigPageClient initialConfig={config} providers={providers} />;
}
