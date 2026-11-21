import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import SystemStorageTab from "../components/SystemStorageTab";

export default function SettingsStoragePage() {
  const tSidebar = useTranslations("sidebar");
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsGeneral")}
        description={tSidebar("settingsGeneralSubtitle")}
      />
      <SystemStorageTab />
    </div>
  );
}
