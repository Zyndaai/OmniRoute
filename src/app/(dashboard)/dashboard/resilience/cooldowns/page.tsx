import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiRead } from "@/server/routing/dashboardApi.server";
import type { CooldownConnection } from "@/lib/resilience/cooldownManager";
import CooldownManagerClient from "./components/CooldownManagerClient";
import { toCooldownRules, type CooldownLoad } from "./components/useCooldownData";

/**
 * Connections + cooldown rules. The page polls this loader, so a failed read is reported as
 * `failed` (never thrown) and the page keeps its last good data. Both reads must succeed
 * together, as before.
 */
export async function loader(): Promise<CooldownLoad> {
  const [list, settings] = await Promise.all([
    apiRead<{ connections?: CooldownConnection[] }>("/api/resilience/cooldowns"),
    apiRead<Record<string, unknown>>("/api/resilience"),
  ]);
  if (!list.ok || !settings.ok) return { connections: null, rules: null, failed: true };
  return {
    connections: list.data?.connections ?? [],
    rules: toCooldownRules(settings.data ?? {}),
    failed: false,
  };
}

export default function ResilienceCooldownsPage() {
  const t = useTranslations("resilienceCooldowns");
  const loaded = useLoaderData<typeof loader>();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader compact title={t("title")} description={t("description")} />
      <CooldownManagerClient loaded={loaded as CooldownLoad} />
    </div>
  );
}
