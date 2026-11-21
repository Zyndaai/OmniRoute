import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import CooldownManagerClient from "./components/CooldownManagerClient";

export default function ResilienceCooldownsPage() {
  const t = useTranslations("resilienceCooldowns");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader compact title={t("title")} description={t("description")} />
      <CooldownManagerClient />
    </div>
  );
}
