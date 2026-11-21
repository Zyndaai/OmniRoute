import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import SidebarTab from "../components/SidebarTab";

export default function SettingsSidebarPage() {
  const tSidebar = useTranslations("sidebar");
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsSidebar")}
        description={tSidebar("settingsSidebarSubtitle")}
      />
      <SidebarTab />
    </div>
  );
}
