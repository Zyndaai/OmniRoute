import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import SidebarTab from "../components/SidebarTab";

// A failed read hands the tab `null`; it then fetches the settings itself and degrades as before.
export async function loader() {
  const s = await apiJsonOrNull<Record<string, unknown>>("/api/settings");
  // Only the fields SidebarTab reads.
  return {
    settings: s && {
      hiddenSidebarItems: s.hiddenSidebarItems,
      hiddenSidebarSections: s.hiddenSidebarSections,
      hiddenSidebarGroupLabels: s.hiddenSidebarGroupLabels,
      sidebarSectionOrder: s.sidebarSectionOrder,
      sidebarItemOrder: s.sidebarItemOrder,
      sidebarActivePreset: s.sidebarActivePreset,
      debugMode: s.debugMode,
      radarAdminUrl: s.radarAdminUrl,
    },
  };
}

export default function SettingsSidebarPage() {
  const tSidebar = useTranslations("sidebar");
  const { settings } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsSidebar")}
        description={tSidebar("settingsSidebarSubtitle")}
      />
      <SidebarTab initialSettings={settings} />
    </div>
  );
}
