import { useLoaderData, useRevalidator } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import RoutingStrategyCard from "../components/RoutingStrategyCard";
import QuotaPreflightCard from "../components/QuotaPreflightCard";
import RoutingTab from "../components/RoutingTab";
import ModelRoutingSection from "@/shared/components/ModelRoutingSection";
import ComboDefaultsTab, { activeProviderNames } from "../components/ComboDefaultsTab";
import FallbackChainsEditor from "../components/FallbackChainsEditor";
import ModelAliasesUnified from "../components/ModelAliasesUnified";
import BackgroundDegradationTab from "../components/BackgroundDegradationTab";
import RoutingEntryLink from "@/shared/components/routing/RoutingEntryLink";
import CatalogVisibilityCard from "../components/CatalogVisibilityCard";

// `/api/settings` is an untyped bag; each component's own props type the fields it receives.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SettingsBody = Record<string, any>;

// Every read degrades: a read that fails hands its component `null` (or the old default where the
// component used to degrade silently), and the component then falls back to its own client fetch,
// which shows the same error state as before. Nothing here is required for the page itself.
export async function loader() {
  const [settings, comboDefaults, providers, resilience, aliases, chains, backgroundDegradation] =
    await Promise.all([
      apiJsonOrNull<SettingsBody>("/api/settings"),
      apiJsonOrNull<{ comboDefaults?: unknown; providerOverrides?: unknown }>(
        "/api/settings/combo-defaults"
      ),
      apiJsonOrNull<{ connections?: unknown[] }>("/api/providers"),
      apiJsonOrNull<{ quotaPreflight?: unknown }>("/api/resilience"),
      apiJsonOrNull<{ builtIn?: Record<string, string>; custom?: Record<string, string> }>(
        "/api/settings/model-aliases"
      ),
      apiJsonOrNull<{ chains?: Record<string, unknown> } & Record<string, unknown>>(
        "/api/fallback/chains"
      ),
      apiJsonOrNull<Record<string, unknown>>("/api/settings/background-degradation"),
    ]);

  // One projected read of /api/settings, shared by the cards below. Only the fields these
  // components read are returned.
  const s = settings;
  return {
    strategySettings: s && {
      fallbackStrategy: s.fallbackStrategy,
      stickyRoundRobinLimit: s.stickyRoundRobinLimit,
      comboStrategy: s.comboStrategy,
      comboStickyRoundRobinLimit: s.comboStickyRoundRobinLimit,
    },
    quotaPreflight: resilience ? (resilience.quotaPreflight ?? null) : null,
    quotaPreflightLoaded: resilience !== null,
    comboDefaultsData:
      s && comboDefaults
        ? {
            comboDefaults: comboDefaults.comboDefaults ?? null,
            providerOverrides: comboDefaults.providerOverrides ?? null,
            settings: {
              fallbackStrategy: s.fallbackStrategy,
              stickyRoundRobinLimit: s.stickyRoundRobinLimit,
              disableSessionStickiness: s.disableSessionStickiness,
              sessionAffinityTtlMs: s.sessionAffinityTtlMs,
              promptCacheAffinityEnabled: s.promptCacheAffinityEnabled,
            },
            // The providers read is non-critical in the old code: a failure leaves the list empty.
            providerNames: activeProviderNames(providers),
          }
        : null,
    catalogVisibility: s && {
      hideAutoCombos: s.hideAutoCombos,
      hideNoThinkVariants: s.hideNoThinkVariants,
      exposeCombosOnly: s.exposeCombosOnly,
    },
    // Model aliases degrade to empty lists on any failed read.
    aliases: {
      wildcardAliases: s?.wildcardAliases || [],
      builtIn: aliases?.builtIn || {},
      custom: aliases?.custom || {},
    },
    // Fallback chains degrade to "no chains" on a failed read.
    chains: (chains?.chains || chains || {}) as Record<string, unknown>,
    routingSettings: s && {
      adaptiveVolumeRouting: s.adaptiveVolumeRouting,
      alwaysPreserveClientCache: s.alwaysPreserveClientCache,
      antigravitySignatureCacheMode: s.antigravitySignatureCacheMode,
      autoRoutingDefaultVariant: s.autoRoutingDefaultVariant,
      autoRoutingEnabled: s.autoRoutingEnabled,
      ccBridgeTransforms: s.ccBridgeTransforms,
      cliCompatProviders: s.cliCompatProviders,
      echoRequestedModelName: s.echoRequestedModelName,
      lkgpEnabled: s.lkgpEnabled,
      searchProviderTimeoutsMs: s.searchProviderTimeoutsMs,
      searchTimeoutMs: s.searchTimeoutMs,
      systemTransforms: s.systemTransforms,
      webSearchRouteModel: s.webSearchRouteModel,
    },
    backgroundDegradation,
  };
}

export default function SettingsRoutingPage() {
  const t = useTranslations("settings");
  const tSidebar = useTranslations("sidebar");
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("globalRouting")}
        description={t("routingSettingsIntro")}
      />
      <RoutingStrategyCard initialSettings={data.strategySettings} />
      <QuotaPreflightCard
        initialQuotaPreflight={data.quotaPreflightLoaded ? data.quotaPreflight : undefined}
      />
      <ComboDefaultsTab initialData={data.comboDefaultsData} />
      <CatalogVisibilityCard initialSettings={data.catalogVisibility} />
      <RoutingEntryLink />
      <ModelAliasesUnified initialAliases={data.aliases} />
      <FallbackChainsEditor
        initialChains={data.chains}
        onChanged={() => revalidator.revalidate()}
      />
      <ModelRoutingSection />
      <RoutingTab initialSettings={data.routingSettings} />
      <BackgroundDegradationTab initialConfig={data.backgroundDegradation} />
    </div>
  );
}
