import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import DebugModeCard from "../components/DebugModeCard";
import LogToolSourcesCard from "../components/LogToolSourcesCard";
import PayloadRulesTab from "../components/PayloadRulesTab";
import RequestLimitsTab from "../components/RequestLimitsTab";
import CliproxyapiSettingsTab from "../components/CliproxyapiSettingsTab";
import HeadroomProxyCard from "../components/HeadroomProxyCard";

// Every read degrades: a failed read hands its component `null`/undefined and the component then
// fetches it itself and shows the same error state as before. The CLIProxyAPI version-manager
// status and the Headroom lifecycle status stay client reads (they probe running services).
export async function loader() {
  const [settings, payloadRules] = await Promise.all([
    // An untyped bag; each card's own props type the fields it receives.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiJsonOrNull<Record<string, any>>("/api/settings"),
    apiJsonOrNull<Record<string, unknown>>("/api/settings/payload-rules"),
  ]);

  // One projected read of /api/settings, shared by the cards below.
  return {
    debugMode: settings ? settings.debugMode === true : null,
    logToolSources: settings ? settings.logToolSources === true : null,
    requestLimits: settings && { maxBodySizeMb: settings.maxBodySizeMb },
    cliproxyapi: settings && {
      cliproxyapi_fallback_enabled: settings.cliproxyapi_fallback_enabled,
      cliproxyapi_url: settings.cliproxyapi_url,
      cliproxyapi_fallback_codes: settings.cliproxyapi_fallback_codes,
    },
    headroom: settings && { headroomUrl: settings.headroomUrl },
    payloadRules,
  };
}

export default function SettingsAdvancedPage() {
  const tSidebar = useTranslations("sidebar");
  const data = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsAdvanced")}
        description={tSidebar("settingsAdvancedSubtitle")}
      />
      <DebugModeCard initialDebugMode={data.debugMode ?? undefined} />
      <LogToolSourcesCard initialLogToolSources={data.logToolSources ?? undefined} />
      <PayloadRulesTab initialRules={data.payloadRules} />
      <RequestLimitsTab initialSettings={data.requestLimits} />
      <CliproxyapiSettingsTab initialSettings={data.cliproxyapi} />
      <HeadroomProxyCard initialSettings={data.headroom} />
    </div>
  );
}
