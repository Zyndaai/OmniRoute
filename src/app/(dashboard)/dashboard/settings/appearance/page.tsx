import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import AppearanceTab from "../components/AppearanceTab";

export default function SettingsAppearancePage() {
  const tSidebar = useTranslations("sidebar");
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsAppearance")}
        description={tSidebar("settingsAppearanceSubtitle")}
      />
      <AppearanceTab />
    </div>
  );
}
