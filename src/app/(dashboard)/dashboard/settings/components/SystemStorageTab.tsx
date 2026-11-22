import { useState, useEffect, useCallback } from "react";
import { useFormatter, useTranslations } from "use-intl";
import { Card, Button, Badge, Checkbox, ConfirmModal, Input, Select } from "@/shared/components";
import Icon from "@/shared/components/Icon";
import ProviderTransferPanel from "./ProviderTransferPanel";
import { fetchDatabaseSettingsData, AuthRequiredBanner } from "./systemStorageAuth";
import { extractApiErrorMessage } from "@/shared/http/apiErrorMessage";

// Whitelist mirrored from src/lib/db/cleanup.ts::RESET_USAGE_HISTORY_PERIODS.
const RESET_USAGE_PERIOD_VALUES = [
  "5m",
  "1h",
  "3h",
  "6h",
  "12h",
  "1d",
  "7d",
  "30d",
  "all",
] as const;

// Sections PATCH /api/settings/database persists (src/app/api/settings/database/route.ts).
const EDITABLE_SECTIONS = ["logs", "cache", "retention", "aggregation"] as const;

// Retention windows read by src/lib/db/cleanup.ts: [key, label key, fallback days].
const RETENTION_FIELDS = [
  ["quotaSnapshots", "retentionQuotaSnapshots", 7],
  ["compressionAnalytics", "retentionCompressionAnalytics", 30],
  ["mcpAudit", "retentionMcpAudit", 30],
  ["a2aEvents", "retentionA2aEvents", 30],
  ["callLogs", "retentionCallLogs", 30],
  ["conversationTurnNodes", "retentionConversationTurnNodes", 30],
  ["usageHistory", "retentionUsageHistory", 30],
] as const;

type Status = { type: string; message: string };
const NO_STATUS: Status = { type: "", message: "" };

export type StorageHealth = {
  driver: string;
  sizeBytes: number;
  dataDir?: string;
  retentionDays: { app: number; call: number };
  tableMaxRows: { callLogs: number; proxyLogs: number };
};

async function fetchStorageHealthData(): Promise<Partial<StorageHealth> | null> {
  try {
    const res = await fetch("/api/storage/health");
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Failed to fetch storage health:", err);
    return null;
  }
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Runs a POST maintenance action and reports `{ deleted }` through the given message keys.
 * Shared by the purge buttons, which all follow the same request/response shape.
 */
function usePurgeAction(
  url: string,
  successKey: string,
  failureKey: string,
  t: ReturnType<typeof useTranslations>
) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status>(NO_STATUS);
  const run = async () => {
    setLoading(true);
    setStatus(NO_STATUS);
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setStatus({ type: "success", message: t(successKey, { count: data?.deleted ?? 0 }) });
      } else {
        setStatus({ type: "error", message: extractApiErrorMessage(data, t(failureKey)) });
      }
    } catch {
      setStatus({ type: "error", message: t("errorOccurred") });
    } finally {
      setLoading(false);
    }
  };
  return { loading, status, run };
}

export default function SystemStorageTab({
  initialStorageHealth,
  initialDatabaseSettings,
}: {
  /** The `/api/storage/health` body read by the route loader; without it the tab fetches. */
  initialStorageHealth?: Partial<StorageHealth> | null;
  /** The `/api/settings/database` result read by the route loader; without it the tab fetches. */
  initialDatabaseSettings?: { data: any; authRequired: boolean } | null;
} = {}) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [exportLoading, setExportLoading] = useState(false);
  const [exportStatus, setExportStatus] = useState<Status>(NO_STATUS);
  const [clearCacheLoading, setClearCacheLoading] = useState(false);
  const [clearCacheStatus, setClearCacheStatus] = useState<Status>(NO_STATUS);
  const [resetUsageModalOpen, setResetUsageModalOpen] = useState(false);
  const [resetUsagePeriod, setResetUsagePeriod] = useState("all");
  const [resetUsageLoading, setResetUsageLoading] = useState(false);
  const [resetUsageStatus, setResetUsageStatus] = useState<Status>(NO_STATUS);
  const purgeLogs = usePurgeAction("/api/settings/purge-logs", "logsDeleted", "purgeLogsFailed", t);
  const purgeQuotaSnapshots = usePurgeAction(
    "/api/settings/purge-quota-snapshots",
    "purgeQuotaSnapshotsSuccess",
    "purgeQuotaSnapshotsFailed",
    t
  );
  const purgeCallLogs = usePurgeAction(
    "/api/settings/purge-call-logs",
    "purgeCallLogsSuccess",
    "purgeCallLogsFailed",
    t
  );
  const [storageHealth, setStorageHealth] = useState<StorageHealth>({
    driver: "postgres",
    sizeBytes: 0,
    retentionDays: { app: 7, call: 7 },
    tableMaxRows: { callLogs: 100000, proxyLogs: 100000 },
    ...(initialStorageHealth ?? {}),
  });

  const [dbSettings, setDbSettings] = useState<any>(initialDatabaseSettings?.data ?? null);
  const [dbSettingsLoading, setDbSettingsLoading] = useState(!initialDatabaseSettings);
  const [dbSettingsAuthRequired, setDbSettingsAuthRequired] = useState(
    initialDatabaseSettings?.authRequired ?? false
  );
  const [dbSettingsSaving, setDbSettingsSaving] = useState(false);

  // Keyed copies: a new loader result (compared by content) replaces the local values.
  const healthKey = initialStorageHealth ? JSON.stringify(initialStorageHealth) : null;
  const [shownHealthKey, setShownHealthKey] = useState(healthKey);
  if (healthKey !== shownHealthKey) {
    setShownHealthKey(healthKey);
    if (initialStorageHealth) setStorageHealth((prev) => ({ ...prev, ...initialStorageHealth }));
  }
  const dbKey = initialDatabaseSettings ? JSON.stringify(initialDatabaseSettings) : null;
  const [shownDbKey, setShownDbKey] = useState(dbKey);
  if (dbKey !== shownDbKey) {
    setShownDbKey(dbKey);
    if (initialDatabaseSettings) {
      if (initialDatabaseSettings.data) setDbSettings(initialDatabaseSettings.data);
      setDbSettingsAuthRequired(initialDatabaseSettings.authRequired);
      setDbSettingsLoading(false);
    }
  }

  const applyStorageHealth = useCallback((data: Partial<StorageHealth> | null) => {
    if (!data) return;
    setStorageHealth((prev) => ({ ...prev, ...data }));
  }, []);

  const applyDatabaseSettings = useCallback((result: { data: any; authRequired: boolean }) => {
    if (result.data) setDbSettings(result.data);
    setDbSettingsAuthRequired(result.authRequired);
    setDbSettingsLoading(false);
  }, []);

  const loadDatabaseSettings = async () => {
    setDbSettingsLoading(true);
    applyDatabaseSettings(await fetchDatabaseSettingsData());
  };

  const saveDatabaseSettings = async () => {
    if (!dbSettings) return;
    setDbSettingsSaving(true);
    try {
      const body = Object.fromEntries(
        EDITABLE_SECTIONS.filter((section) => dbSettings[section]).map((section) => [
          section,
          dbSettings[section],
        ])
      );
      const res = await fetch("/api/settings/database", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await loadDatabaseSettings();
      }
    } catch (err) {
      console.error("Failed to save database settings:", err);
    } finally {
      setDbSettingsSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    // Each read the route loader already supplied is skipped.
    if (!initialStorageHealth) {
      void (async () => {
        const data = await fetchStorageHealthData();
        if (!cancelled) applyStorageHealth(data);
      })();
    }
    if (!initialDatabaseSettings) {
      void (async () => {
        const data = await fetchDatabaseSettingsData();
        if (!cancelled) applyDatabaseSettings(data);
      })();
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the initial props only gate the mount fetches
  }, [applyStorageHealth, applyDatabaseSettings]);

  const handleClearCache = async () => {
    setClearCacheLoading(true);
    setClearCacheStatus(NO_STATUS);
    try {
      const res = await fetch("/api/cache", { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setClearCacheStatus({ type: "success", message: t("cacheCleared") });
      } else {
        setClearCacheStatus({
          type: "error",
          message: extractApiErrorMessage(data, t("clearCacheFailed")),
        });
      }
    } catch {
      setClearCacheStatus({ type: "error", message: t("errorOccurred") });
    } finally {
      setClearCacheLoading(false);
    }
  };

  const handleResetUsageHistory = async () => {
    setResetUsageLoading(true);
    setResetUsageStatus(NO_STATUS);
    try {
      const res = await fetch("/api/settings/purge-usage-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: resetUsagePeriod }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        const deleted = data?.deleted ?? 0;
        setResetUsageStatus({
          type: "success",
          message:
            t("resetUsageSuccess", { count: deleted }) ||
            `Usage data reset (${deleted} row(s) deleted).`,
        });
        setResetUsageModalOpen(false);
      } else {
        setResetUsageStatus({
          type: "error",
          message:
            data?.error?.message ||
            (typeof data?.error === "string" ? data.error : null) ||
            t("resetUsageFailed") ||
            "Failed to reset usage data",
        });
      }
    } catch {
      setResetUsageStatus({ type: "error", message: t("errorOccurred") });
    } finally {
      setResetUsageLoading(false);
    }
  };

  const openResetUsageModal = () => {
    setResetUsagePeriod("all");
    setResetUsageStatus(NO_STATUS);
    setResetUsageModalOpen(true);
  };

  /** Fetches a URL, reads the response as a Blob and triggers a browser download. */
  const fetchAndDownload = async (
    apiUrl: string,
    fallbackFilename: string,
    errorMessage: string
  ) => {
    const res = await fetch(apiUrl);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(extractApiErrorMessage(data, errorMessage));
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = disposition.match(/filename="?([^"]+)"?/)?.[1] || fallbackFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportJson = async () => {
    setExportLoading(true);
    setExportStatus(NO_STATUS);
    try {
      await fetchAndDownload(
        "/api/settings/export-json",
        `omniroute-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        t("jsonExportFailed")
      );
    } catch (err) {
      console.error("Export JSON failed:", err);
      setExportStatus({
        type: "error",
        message: t("exportFailedWithError", { error: (err as Error).message }),
      });
    } finally {
      setExportLoading(false);
    }
  };

  const renderStatusAlert = (status: Status, index: number) => {
    if (!status.message) return null;
    const isInfo = status.type === "info";
    const isSuccess = status.type === "success";
    const className =
      "p-3 rounded-lg text-sm " +
      (isSuccess
        ? "bg-success/10 text-success border border-success/20"
        : isInfo
          ? "bg-info/10 text-info border border-info/20"
          : "bg-error/10 text-error border border-error/20");

    return (
      <div key={index} className={className} role="alert">
        <div className="flex items-center gap-2">
          <Icon name={isSuccess ? "check_circle" : isInfo ? "info" : "error"} size={16} />
          {status.message}
        </div>
      </div>
    );
  };

  const renderRetentionSettings = () => {
    if (dbSettingsLoading || !dbSettings?.retention) return null;

    return (
      <div className="mt-6 p-4 rounded-lg border border-border bg-bg">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <Icon name="schedule" size={18} />
              {t("storageRetentionCleanup")}
            </h4>
            <p className="mt-1 text-xs text-text-muted">{t("storageRetentionCleanupDesc")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="default" size="sm">
              {t("retentionCallDays", { count: storageHealth.retentionDays.call })}
            </Badge>
            <Badge variant="default" size="sm">
              {t("retentionAppDays", { count: storageHealth.retentionDays.app })}
            </Badge>
            <Badge variant="default" size="sm">
              {t("retentionRows", {
                // use-intl pins the locale, so server and client render the same digits.
                count: format.number(storageHealth.tableMaxRows?.callLogs ?? 100000),
              })}
            </Badge>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {RETENTION_FIELDS.map(([key, labelKey, fallback]) => (
            <Input
              key={key}
              label={t(labelKey)}
              type="number"
              min="1"
              max="365"
              value={dbSettings.retention[key]}
              onChange={(e) =>
                setDbSettings({
                  ...dbSettings,
                  retention: {
                    ...dbSettings.retention,
                    [key]: parseInt(e.target.value) || fallback,
                  },
                })
              }
            />
          ))}
        </div>
        <div className="mt-3">
          <Button
            variant="primary"
            size="sm"
            onClick={saveDatabaseSettings}
            loading={dbSettingsSaving}
          >
            {t("saveRetentionSettings")}
          </Button>
        </div>
      </div>
    );
  };

  const renderCompressionAggregationSettings = () => {
    if (dbSettingsLoading || !dbSettings?.aggregation) return null;

    return (
      <div className="mt-6 p-4 rounded-lg border border-border bg-bg">
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Icon name="compress" size={18} />
          {t("storageCompressionAggregation")}
        </h4>
        <div className="space-y-4">
          <Checkbox
            id="aggregation-enabled"
            label={t("storageEnableAggregation")}
            checked={dbSettings.aggregation.enabled}
            onChange={(e) =>
              setDbSettings({
                ...dbSettings,
                aggregation: { ...dbSettings.aggregation, enabled: e.target.checked },
              })
            }
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={t("storageRawDataRetention")}
              type="number"
              min="1"
              max="365"
              value={dbSettings.aggregation.rawDataRetentionDays}
              onChange={(e) =>
                setDbSettings({
                  ...dbSettings,
                  aggregation: {
                    ...dbSettings.aggregation,
                    rawDataRetentionDays: parseInt(e.target.value) || 30,
                  },
                })
              }
            />
            <Select
              label={t("storageGranularity")}
              value={dbSettings.aggregation.granularity}
              onChange={(e) =>
                setDbSettings({
                  ...dbSettings,
                  aggregation: {
                    ...dbSettings.aggregation,
                    granularity: e.target.value as "hourly" | "daily" | "weekly",
                  },
                })
              }
              options={[
                { value: "hourly", label: t("storageHourly") },
                { value: "daily", label: t("storageDaily") },
                { value: "weekly", label: t("storageWeekly") },
              ]}
            />
          </div>
        </div>
        <div className="mt-3">
          <Button
            variant="primary"
            size="sm"
            onClick={saveDatabaseSettings}
            loading={dbSettingsSaving}
          >
            {t("storageSaveAggregation")}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-bg-subtle text-text-muted">
          <Icon name="database" size={20} />
        </span>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">{t("systemStorage")}</h3>
          <p className="text-xs text-text-muted">{t("allDataLocal")}</p>
          <p className="text-xs text-text-muted mt-1">{t("storagePostgresBackupNote")}</p>
        </div>
        <Badge variant="success" size="sm">
          {storageHealth.driver || "postgres"}
        </Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <div className="p-3 rounded-lg bg-bg border border-border">
          <p className="text-[11px] text-text-muted uppercase tracking-wide mb-1">
            {t("storageDatabaseSize")}
          </p>
          <p className="text-sm font-semibold">{formatBytes(storageHealth.sizeBytes)}</p>
        </div>
        {storageHealth.dataDir ? (
          <div className="p-3 rounded-lg bg-bg border border-border">
            <p className="text-[11px] text-text-muted uppercase tracking-wide mb-1">
              {t("storageDataDirectory")}
            </p>
            <p className="text-sm font-mono text-text-main break-all">{storageHealth.dataDir}</p>
          </div>
        ) : null}
      </div>

      {dbSettingsAuthRequired && !dbSettingsLoading && <AuthRequiredBanner t={t} />}

      <div className="pt-3 border-t border-border/50 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Icon name="file_export" size={18} className="text-success" />
          <p className="font-medium">{t("export")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon="data_object"
            variant="outline"
            size="sm"
            onClick={handleExportJson}
            loading={exportLoading}
          >
            {t("exportJson")}
          </Button>
          <ProviderTransferPanel />
        </div>
        {exportStatus.message && <div className="mt-3">{renderStatusAlert(exportStatus, 0)}</div>}
      </div>

      <div className="pt-3 border-t border-border/50 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Icon name="build" size={18} className="text-info" />
          <p className="font-medium">{t("maintenance")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon="delete_sweep"
            variant="outline"
            size="sm"
            loading={clearCacheLoading}
            onClick={handleClearCache}
          >
            {t("clearCache")}
          </Button>
          <Button
            icon="auto_delete"
            variant="outline"
            size="sm"
            loading={purgeLogs.loading}
            onClick={purgeLogs.run}
          >
            {t("purgeExpiredLogs")}
          </Button>
          <Button
            icon="delete_forever"
            variant="outline"
            size="sm"
            loading={purgeQuotaSnapshots.loading}
            onClick={purgeQuotaSnapshots.run}
          >
            {t("purgeQuotaSnapshots")}
          </Button>
          <Button
            icon="delete_forever"
            variant="outline"
            size="sm"
            loading={purgeCallLogs.loading}
            onClick={purgeCallLogs.run}
          >
            {t("purgeCallLogs")}
          </Button>
          <Button
            icon="restart_alt"
            variant="danger"
            size="sm"
            loading={resetUsageLoading}
            onClick={openResetUsageModal}
          >
            {t("resetUsageData")}
          </Button>
        </div>
        <div className="mt-4 border-t border-border/50 pt-3">
          <div className="flex flex-col gap-2">
            {[
              clearCacheStatus,
              purgeLogs.status,
              purgeQuotaSnapshots.status,
              purgeCallLogs.status,
              resetUsageStatus,
            ].map(renderStatusAlert)}
          </div>
        </div>
      </div>

      {renderRetentionSettings()}
      {renderCompressionAggregationSettings()}

      <ConfirmModal
        isOpen={resetUsageModalOpen}
        onClose={() => !resetUsageLoading && setResetUsageModalOpen(false)}
        onConfirm={handleResetUsageHistory}
        title={t("resetUsageData")}
        message={
          <div className="space-y-3">
            <p className="text-text-muted">
              {t("resetUsageDataDesc") ||
                "Select how far back you want to delete usage, request logs, and analytics data. Provider configuration, connections, API keys, combos, and settings are preserved. This action cannot be undone."}
            </p>
            <Select
              aria-label={t("resetUsageData")}
              value={resetUsagePeriod}
              onChange={(e) => setResetUsagePeriod(e.target.value)}
              options={RESET_USAGE_PERIOD_VALUES.map((value) => ({
                value,
                label: t(`resetUsagePeriod_${value}`) || value,
              }))}
            />
          </div>
        }
        confirmText={resetUsageLoading ? t("resetting") : t("reset")}
        variant="danger"
        loading={resetUsageLoading}
      />
    </Card>
  );
}
