import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import ResilienceTab, { type ResilienceResponse } from "../components/ResilienceTab";

// Every read degrades: a read that fails hands its component `null`, and the component then
// fetches it itself and shows the same error/default state as before. Nothing is required here.
export async function loader() {
  const [resilience, autoDisable, settings] = await Promise.all([
    apiJsonOrNull<ResilienceResponse>("/api/resilience"),
    apiJsonOrNull<{ enabled?: boolean; threshold?: number; scope?: string }>(
      "/api/settings/auto-disable-accounts"
    ),
    apiJsonOrNull<Record<string, unknown>>("/api/settings"),
  ]);
  return {
    resilience,
    autoDisable,
    // Only the field ModelLockoutCard reads.
    lockoutSettings: settings && { modelLockout: settings.modelLockout },
  };
}

export default function SettingsResiliencePage() {
  const t = useTranslations("settings");
  const tSidebar = useTranslations("sidebar");
  const data = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsResilience")}
        description={`${t("resilienceSettingsIntro")} ${t("resilienceStructureDesc")}`}
      />
      <ResilienceTab
        initialData={data.resilience}
        initialAutoDisable={data.autoDisable as never}
        initialSettings={data.lockoutSettings}
      />
    </div>
  );
}
