import { useState, useCallback } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { apiJsonOrNull } from "@/server/routing/dashboardApi.server";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { Card, Button, EmptyState } from "@/shared/components";
import Badge from "@/shared/components/Badge";
import { useNotificationStore } from "@/store/notificationStore";
import { useConfirmDialog } from "@/shared/hooks/useConfirmDialog";
import { useTranslations } from "use-intl";

interface PluginInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
  status: string;
  enabled: boolean;
  hooks: string[];
}

/** A failed read shows the empty list, as the old page did (optional read). */
export async function loader() {
  const data = await apiJsonOrNull<{ plugins?: PluginInfo[] }>("/api/plugins");
  return { plugins: data?.plugins || [] };
}

export default function PluginsPage() {
  const { addNotification } = useNotificationStore();
  const t = useTranslations("plugins");
  const [confirm, confirmDialog] = useConfirmDialog();
  const { plugins } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [scanning, setScanning] = useState(false);

  const fetchPlugins = useCallback(async () => {
    await revalidator.revalidate();
  }, [revalidator]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/plugins/scan", { method: "POST" });
      if (res.ok) {
        addNotification({ type: "success", message: t("pluginScanComplete") });
        await fetchPlugins();
      }
    } catch {
      addNotification({ type: "error", message: t("pluginScanFailed") });
    } finally {
      setScanning(false);
    }
  };

  const handleToggle = async (name: string, enable: boolean) => {
    const endpoint = enable ? "activate" : "deactivate";
    try {
      const res = await fetch(`/api/plugins/${name}/${endpoint}`, { method: "POST" });
      if (res.ok) {
        addNotification({
          type: "success",
          message: enable ? t("activated", { name }) : t("deactivated", { name }),
        });
        await fetchPlugins();
      }
    } catch {
      addNotification({
        type: "error",
        message: enable ? t("activateFailed", { name }) : t("deactivateFailed", { name }),
      });
    }
  };

  const handleUninstall = async (name: string) => {
    if (!(await confirm(t("uninstallConfirm", { name })))) return;
    try {
      const res = await fetch(`/api/plugins/${name}`, { method: "DELETE" });
      if (res.ok) {
        addNotification({ type: "success", message: t("uninstalled", { name }) });
        await fetchPlugins();
      }
    } catch {
      addNotification({ type: "error", message: t("uninstallFailed", { name }) });
    }
  };

  return (
    <div className="space-y-6 p-6">
      {confirmDialog}
      <PageHeader
        compact
        title={t("title")}
        actions={
          <Button onClick={handleScan} disabled={scanning}>
            {scanning ? t("scanning") : t("scanForPlugins")}
          </Button>
        }
      />
      {plugins.length === 0 ? (
        <EmptyState title={t("noPlugins")} description={t("noPluginsDescription")} />
      ) : (
        <div className="grid gap-4">
          {plugins.map((plugin) => (
            <Card key={plugin.name} padding="sm">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">{plugin.name}</h3>
                  <p className="text-sm text-text-muted">
                    v{plugin.version}
                    {plugin.author ? ` by ${plugin.author}` : ""}
                    {plugin.description ? ` — ${plugin.description}` : ""}
                  </p>
                  <div className="mt-1 flex gap-1">
                    {plugin.hooks.map((hook) => (
                      <Badge key={hook} variant="info" size="sm">
                        {hook}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={plugin.enabled ? "secondary" : "primary"}
                    onClick={() => handleToggle(plugin.name, !plugin.enabled)}
                  >
                    {plugin.enabled ? t("deactivate") : t("activate")}
                  </Button>
                  <Button variant="danger" onClick={() => handleUninstall(plugin.name)}>
                    {t("uninstall")}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
