import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { getTranslator } from "@/i18n/request.server";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { pageMeta } from "@/shared/utils/pageMeta";
import { TrafficInspectorPageClient } from "./TrafficInspectorPageClient";
import type { SessionInfo } from "./hooks/useSessionRecorder";

export async function loader({ request }: LoaderFunctionArgs) {
  // Both API reads are optional (best-effort in the old page): a failed capture-modes read means
  // "no system proxy applied"; a failed session read leaves `sessions` null so the recorder
  // fetches the list itself.
  const [t, captureModes, sessionsBody] = await Promise.all([
    getTranslator("metadata", request),
    apiJsonOrNull<{ systemProxy?: { applied: boolean } }>(
      "/api/tools/traffic-inspector/capture-modes"
    ),
    apiJsonOrNull<{ sessions?: SessionInfo[] }>("/api/tools/traffic-inspector/sessions"),
  ]);
  return {
    title: t("trafficInspectorTitle"),
    description: t("trafficInspectorDescription"),
    captureModes: captureModes ? { systemProxy: captureModes.systemProxy } : null,
    sessions: sessionsBody ? (sessionsBody.sessions ?? []) : null,
  };
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
  const { captureModes, sessions } = useLoaderData<typeof loader>();
  return (
    <TrafficInspectorPageClient
      title={t("trafficInspector")}
      subtitle={t("trafficInspectorSubtitle")}
      purpose={t("trafficInspectorPurpose")}
      initialCaptureModes={captureModes}
      initialSessions={sessions ?? undefined}
    />
  );
}
