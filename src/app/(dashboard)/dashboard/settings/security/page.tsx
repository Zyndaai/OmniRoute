import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import SecurityTab from "../components/SecurityTab";

// Every read degrades: a read that fails hands its component `null`, and the component then
// fetches it itself and shows the same error/default state as before. Nothing is required here.
// SessionInfoCard stays client-side (it reads sessionStorage and the browser's user agent).
export async function loader() {
  const [settings, ipFilter, pii, inventory] = await Promise.all([
    apiJsonOrNull<Record<string, unknown>>("/api/settings"),
    apiJsonOrNull<Record<string, unknown>>("/api/settings/ip-filter"),
    apiJsonOrNull<Record<string, unknown>>("/api/settings/pii"),
    apiJsonOrNull<Record<string, unknown>>("/api/settings/authz-inventory"),
  ]);
  return {
    // Only the fields SecurityTab reads.
    settings: settings && {
      requireLogin: settings.requireLogin,
      hasPassword: settings.hasPassword,
      corsOrigins: settings.corsOrigins,
      bruteForceProtection: settings.bruteForceProtection,
      blockedProviders: settings.blockedProviders,
      customBannedSignals: settings.customBannedSignals,
      credentialRedactionEnabled: settings.credentialRedactionEnabled,
    },
    ipFilter,
    pii,
    inventory,
  };
}

export default function SettingsSecurityPage() {
  const tSidebar = useTranslations("sidebar");
  const data = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsSecurity")}
        description={tSidebar("settingsSecuritySubtitle")}
      />
      <SecurityTab
        initialSettings={data.settings}
        initialIpFilter={data.ipFilter}
        initialPii={data.pii as never}
        initialInventory={data.inventory as never}
      />
    </div>
  );
}
