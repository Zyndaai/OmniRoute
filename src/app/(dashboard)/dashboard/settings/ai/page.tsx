import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import ConnectionTestSettings from "../components/ConnectionTestSettings";
import ThinkingBudgetTab from "../components/ThinkingBudgetTab";
import ModalityBridgeMovedCard from "../components/ModalityBridgeMovedCard";
import SystemPromptTab from "../components/SystemPromptTab";
import ResponsesStatePolicyTab from "../components/ResponsesStatePolicyTab";
import CodexFastTierTab from "../components/CodexFastTierTab";
import CodexAutoPingTab, { type CodexConnection } from "../components/CodexAutoPingTab";
import ClaudeFastModeTab from "../components/ClaudeFastModeTab";
import SkillsSettingsTab from "../components/SkillsSettingsTab";
import ModelsDevSyncTab from "../components/ModelsDevSyncTab";
import UsageTokenBufferTab from "../components/UsageTokenBufferTab";
import ModelCapabilityOverridesTab from "../components/ModelCapabilityOverridesTab";

type SettingsResponse = Record<string, unknown> & {
  codexAutoPing?: { connections?: Record<string, boolean> } | null;
};

/**
 * First-paint reads of every card on this page, one `/api/settings` read shared by the cards
 * that use it. No read is required: a failed read hands its card `undefined`, and the card then
 * fetches on the client as it always did. `ModelCapabilityOverridesTab` stays client-side (it
 * needs the full `/api/pricing/models` catalog).
 */
export async function loader() {
  const [settings, thinkingBudget, systemPrompt, providers] = await Promise.all([
    apiJsonOrNull<SettingsResponse>("/api/settings"),
    apiJsonOrNull<{ mode: string; customBudget: number; effortLevel: string }>(
      "/api/settings/thinking-budget"
    ),
    apiJsonOrNull<{ enabled?: boolean; prefixPrompt?: string; suffixPrompt?: string }>(
      "/api/settings/system-prompt"
    ),
    apiJsonOrNull<{ connections?: CodexConnection[] }>("/api/providers", {
      query: { provider: "codex" },
    }),
  ]);

  return {
    thinkingBudget: thinkingBudget ?? undefined,
    systemPrompt: systemPrompt ?? undefined,
    settings: settings
      ? {
          responsesPreviousResponseIdMode: settings.responsesPreviousResponseIdMode ?? null,
          usageTokenBuffer:
            typeof settings.usageTokenBuffer === "number" ? settings.usageTokenBuffer : null,
          codexFastTier: {
            codexServiceTier: settings.codexServiceTier,
            codexFastServiceTier: settings.codexFastServiceTier,
          },
          connectionTestPrompt:
            typeof settings.connectionTestPrompt === "string"
              ? settings.connectionTestPrompt
              : null,
          claudeFastMode: { claudeFastMode: settings.claudeFastMode },
          skills: {
            skillsEnabled: settings.skillsEnabled,
            skillsmpApiKey: settings.skillsmpApiKey,
            skillsProvider: settings.skillsProvider,
          },
          modelsDev: {
            modelsDevSyncEnabled: settings.modelsDevSyncEnabled,
            modelsDevSyncInterval: settings.modelsDevSyncInterval,
          },
        }
      : undefined,
    codexAutoPing:
      settings && providers
        ? {
            enabledMap: settings.codexAutoPing?.connections || {},
            connections: (providers.connections || []).map((c) => ({
              id: c.id,
              provider: c.provider,
              authType: c.authType,
              name: c.name,
              email: c.email,
              displayName: c.displayName,
            })),
          }
        : undefined,
  };
}

export default function SettingsAiPage() {
  const t = useTranslations("settings");
  const tSidebar = useTranslations("sidebar");
  const { thinkingBudget, systemPrompt, settings, codexAutoPing } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader compact title={tSidebar("settingsAi")} description={t("aiSettingsIntro")} />
      <ThinkingBudgetTab initialConfig={thinkingBudget} />
      <ModalityBridgeMovedCard />
      <SystemPromptTab initialConfig={systemPrompt} />
      <ResponsesStatePolicyTab initialMode={settings?.responsesPreviousResponseIdMode} />
      <UsageTokenBufferTab initialBuffer={settings?.usageTokenBuffer} />
      <CodexFastTierTab initialSettings={settings?.codexFastTier} />
      <ConnectionTestSettings initialPrompt={settings?.connectionTestPrompt} />
      <CodexAutoPingTab initialData={codexAutoPing} />
      <ClaudeFastModeTab initialSettings={settings?.claudeFastMode} />
      <SkillsSettingsTab initialSettings={settings?.skills} />
      <ModelCapabilityOverridesTab />
      <ModelsDevSyncTab initialSettings={settings?.modelsDev} />
    </div>
  );
}
