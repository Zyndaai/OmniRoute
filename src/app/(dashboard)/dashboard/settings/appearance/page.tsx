import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import AppearanceTab from "../components/AppearanceTab";

// A failed read hands the tab `null`; it then fetches the settings itself and degrades as before.
export async function loader() {
  const s = await apiJsonOrNull<Record<string, unknown>>("/api/settings");
  // Only the fields AppearanceTab reads.
  return {
    settings: s && {
      showQuickStartOnHome: s.showQuickStartOnHome,
      showProviderTopologyOnHome: s.showProviderTopologyOnHome,
      autoRefreshProviderQuota: s.autoRefreshProviderQuota,
      autoRefreshProviderQuotaInterval: s.autoRefreshProviderQuotaInterval,
      comboConfigMode: s.comboConfigMode,
      hideEndpointCloudflaredTunnel: s.hideEndpointCloudflaredTunnel,
      hideEndpointTailscaleFunnel: s.hideEndpointTailscaleFunnel,
      hideEndpointNgrokTunnel: s.hideEndpointNgrokTunnel,
      hideHealthCheckLogs: s.hideHealthCheckLogs,
      instanceName: s.instanceName,
      customLogoUrl: s.customLogoUrl,
      customLogoBase64: s.customLogoBase64,
      customFaviconUrl: s.customFaviconUrl,
      customFaviconBase64: s.customFaviconBase64,
    },
  };
}

export default function SettingsAppearancePage() {
  const tSidebar = useTranslations("sidebar");
  const { settings } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsAppearance")}
        description={tSidebar("settingsAppearanceSubtitle")}
      />
      <AppearanceTab initialSettings={settings} />
    </div>
  );
}
