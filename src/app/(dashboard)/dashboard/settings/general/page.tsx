import { useLoaderData } from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { apiRequest } from "@/server/routing/dashboardApi.server";
import SystemStorageTab, { type StorageHealth } from "../components/SystemStorageTab";
import { isAuthRequiredResponse } from "../components/systemStorageAuth";

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

// Both reads degrade as the tab's own fetches did, so they use `apiRequest` and not `apiJson`:
// `/api/settings/database` answers a guest session with 401 on purpose and the tab shows an
// "authentication required" banner for it, which a login redirect would replace. Provider
// transfer (`/api/settings/transfer/catalog`) opens in a dialog on click and stays client-side.
export async function loader() {
  const [healthResponse, databaseResponse] = await Promise.all([
    apiRequest("/api/storage/health"),
    apiRequest("/api/settings/database"),
  ]);
  const health = healthResponse.ok
    ? ((await readJson(healthResponse)) as Partial<StorageHealth>)
    : null;
  const databaseBody = await readJson(databaseResponse);
  return {
    storageHealth: health,
    databaseSettings: {
      data: databaseResponse.ok ? databaseBody : null,
      authRequired: databaseResponse.ok
        ? false
        : isAuthRequiredResponse(databaseResponse.status, databaseBody),
    },
  };
}

export default function SettingsStoragePage() {
  const tSidebar = useTranslations("sidebar");
  const { storageHealth, databaseSettings } = useLoaderData<typeof loader>();
  return (
    <div className="space-y-6">
      <PageHeader
        compact
        title={tSidebar("settingsGeneral")}
        description={tSidebar("settingsGeneralSubtitle")}
      />
      <SystemStorageTab
        initialStorageHealth={storageHealth}
        initialDatabaseSettings={databaseSettings}
      />
    </div>
  );
}
