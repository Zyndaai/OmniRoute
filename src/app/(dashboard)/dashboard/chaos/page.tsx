/**
 * /dashboard/chaos/page.tsx — Chaos Mode Configuration
 */
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { getTranslator } from "@/i18n/request.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import ChaosConfigPageClient from "./ChaosConfigPageClient";

export async function loader({ request }: LoaderFunctionArgs) {
  const t = await getTranslator("chaosConfig", request);
  return { title: `${t("pageTitle")} — OmniRoute` };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData, matches }) =>
  pageMeta(matches, loaderData ? [{ title: loaderData.title }] : []);

export default function Page() {
  return <ChaosConfigPageClient />;
}
