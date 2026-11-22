import { Suspense, useMemo } from "react";
import { useLoaderData, useSearchParams } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@omniroute/ui-kit/tabs";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { skipSearchOnlyRevalidation } from "@/shared/utils/routeRevalidation";

import ModalityBridgeAudioTab from "@/app/(dashboard)/dashboard/settings/components/modalityBridge/ModalityBridgeAudioTab";
import ModalityBridgeVideoTab from "@/app/(dashboard)/dashboard/settings/components/modalityBridge/ModalityBridgeVideoTab";
import ModalityBridgeVisionTab from "@/app/(dashboard)/dashboard/settings/components/modalityBridge/ModalityBridgeVisionTab";

type TabId = "vision" | "audio" | "video";

const TABS: ReadonlyArray<{ id: TabId; labelKey: string }> = [
  { id: "vision", labelKey: "modalityBridgeVisionTab" },
  { id: "audio", labelKey: "modalityBridgeAudioTab" },
  { id: "video", labelKey: "modalityBridgeVideoTab" },
];

// The query string only holds the active tab; the loader reads the same data for every tab.
export const shouldRevalidate = skipSearchOnlyRevalidation;

/** Settings keys the three tabs read (`modalityBridge*` plus the legacy `visionBridge*` fallbacks). */
const LEGACY_VISION_KEYS = new Set([
  "visionBridgeEnabled",
  "visionBridgeModel",
  "visionBridgePrompt",
  "visionBridgeTimeout",
  "visionBridgeMaxImages",
  "visionBridgeRerouteTextOnly",
]);

/**
 * One `/api/settings` read (projected to the keys the tabs use) and the in-memory
 * `/api/modality-bridge/stats` read, shared by all tabs, so switching tabs needs no loader run.
 * Neither is required: a failed read hands the tabs `undefined` and they fetch on the client as
 * before. The video runtime probe stays in the tab (it depends on the browser's host name).
 */
export async function loader() {
  const [settings, stats] = await Promise.all([
    apiJsonOrNull<Record<string, unknown>>("/api/settings"),
    apiJsonOrNull<unknown>("/api/modality-bridge/stats"),
  ]);
  return {
    settings: settings
      ? Object.fromEntries(
          Object.entries(settings).filter(
            ([key]) => key.startsWith("modalityBridge") || LEGACY_VISION_KEYS.has(key)
          )
        )
      : undefined,
    stats: stats ?? undefined,
  };
}

function ModalityBridgePageContent() {
  const t = useTranslations("settings");
  const tSidebar = useTranslations("sidebar");
  const { settings, stats } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeTab = useMemo<TabId>(() => {
    const requested = searchParams.get("tab") as TabId | null;
    return requested && TABS.some((tab) => tab.id === requested) ? requested : "vision";
  }, [searchParams]);

  const handleTabChange = (tab: TabId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    setSearchParams(params, { replace: true, preventScrollReset: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        compact
        title={tSidebar("settingsModalityBridge")}
        description={t("modalityBridgeIntro")}
      />
      <Tabs
        variant="underline"
        value={activeTab}
        onValueChange={(next) => handleTabChange(next as TabId)}
      >
        <TabsList
          aria-label={t("modalityBridgeSubTabsAria")}
          className="max-w-full overflow-x-auto"
        >
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {t(tab.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="pt-4">
            {tab.id === "vision" && (
              <ModalityBridgeVisionTab initialSettings={settings} initialStats={stats} />
            )}
            {tab.id === "audio" && (
              <ModalityBridgeAudioTab initialSettings={settings} initialStats={stats} />
            )}
            {tab.id === "video" && (
              <ModalityBridgeVideoTab initialSettings={settings} initialStats={stats} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

export default function ModalityBridgePage() {
  return (
    <Suspense fallback={null}>
      <ModalityBridgePageContent />
    </Suspense>
  );
}
