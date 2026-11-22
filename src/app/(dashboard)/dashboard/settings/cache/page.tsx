import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import CacheSettingsTab from "../components/CacheSettingsTab";

// A failed read hands the tab `null`; it then fetches the config itself and shows the same load
// error as before. The embedding connection test is user-triggered and stays a client call.
export async function loader() {
  return {
    config: await apiJsonOrNull<Record<string, unknown> & { modelCatalogCacheTtlMs: number }>(
      "/api/settings/cache-config"
    ),
  };
}

export default function SettingsCachePage() {
  const tSidebar = useTranslations("sidebar");
  const { config } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsCache")}
        description={tSidebar("settingsCacheSubtitle")}
      />
      <CacheSettingsTab initialConfig={config} />
    </div>
  );
}
