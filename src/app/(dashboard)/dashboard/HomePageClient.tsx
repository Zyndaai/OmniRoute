import { useTranslations } from "use-intl";

import { useState, useEffect, useMemo, useCallback, useRef, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
import { SectionHeader } from "@omniroute/ui-kit/page-header";
import { WorkflowGuide } from "@omniroute/ui-kit/workflow-guide";
import EmptyState from "@/shared/components/EmptyState";
import Icon from "@/shared/components/Icon";
import { CardSkeleton, Button, Modal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, NOAUTH_PROVIDERS, OAUTH_PROVIDERS } from "@/shared/constants/providers";
import {
  isProviderConnectionConnected,
  isProviderConnectionErrored,
} from "@/shared/utils/providerConnectionStatus";
import { useNotificationStore } from "@/store/notificationStore";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { getProviderDisplayLabel } from "@/shared/utils/providerDisplayLabel";
import { HomeProviderTopologySection } from "./HomeProviderTopologySection";
import { shouldShowProviderTopologyOnHome } from "./homeAppearance";
import HomeRecentRequests from "../home/HomeRecentRequests";

type HomePageClientProps = {
  machineId?: string;
};

type ProviderSummaryItem = {
  id: string;
  provider: {
    id: string;
    name: string;
    color?: string;
    textIcon?: string;
    alias?: string;
  };
  total: number;
  connected: number;
  errors: number;
  modelCount: number;
  authType: "free" | "oauth" | "apikey" | string;
};

type ProviderMetricSummary = {
  totalRequests?: number;
  totalSuccesses?: number;
  successRate?: number;
  avgLatencyMs?: number;
  lastRequestAt?: string | null;
  lastErrorAt?: string | null;
  lastStatus?: number | null;
  lastErrorStatus?: number | null;
};

type ProviderModelSummary = {
  fullModel: string;
  alias?: string;
  model?: string;
};

const PROVIDER_ALIAS_TO_ID = new Map(
  Object.entries(AI_PROVIDERS)
    .flatMap(([providerId, providerInfo]) =>
      providerInfo.alias ? [[providerInfo.alias.toLowerCase(), providerId]] : []
    )
    .filter((entry): entry is [string, string] => entry.length === 2)
);

function normalizeProviderId(providerId?: string | null): string {
  const normalized = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  if (!normalized) return "";
  return AI_PROVIDERS[normalized] ? normalized : PROVIDER_ALIAS_TO_ID.get(normalized) || normalized;
}

// Quick-start link classes, shared by the quick-start <Link>s.
const INLINE_LINK = "text-primary hover:underline";
// The kit WorkflowGuide numbers its steps itself; the step titles carry a "1. " prefix.
const stripStepNumber = (title: string) => title.replace(/^\s*\d+[.)]\s*/, "");
const DOCS_LINK =
  "hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-text-muted hover:text-text-main hover:bg-bg-subtle transition-colors";

// Stable no-op subscription for useSyncExternalStore reads of never-changing
// browser globals (location.origin does not change without a full navigation).
function emptySubscribe() {
  return () => {};
}

export default function HomePageClient({ machineId }: HomePageClientProps) {
  const navigate = useNavigate();
  const t = useTranslations("home");
  const tp = useTranslations("providers");
  const [providerConnections, setProviderConnections] = useState([]);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  // useSyncExternalStore keeps SSR/hydration consistent ("/v1" on the server,
  // the real origin after hydration) without a setState-in-effect round-trip.
  const baseUrl = useSyncExternalStore(
    emptySubscribe,
    () => `${globalThis.location.origin}/v1`,
    () => "/v1"
  );
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [providerMetrics, setProviderMetrics] = useState<Record<string, ProviderMetricSummary>>({});
  const [providerTopology, setProviderTopology] = useState({ lastProvider: "", errorProvider: "" });
  const [providerNodes, setProviderNodes] = useState<
    Array<{ id?: string; prefix?: string; name?: string }>
  >([]);

  // The live in-flight request feed for the Provider Topology pulse animation is owned by
  // <HomeProviderTopologySection>, which subscribes to it (gated by the `enabled` prop)
  // only when the topology is actually shown. HomePageClient must NOT open its own
  // unconditional live socket: the binding here was unused (ReferenceError in prod,
  // #4759/#4745) and the socket opened even when topology was hidden (#4596).

  // Appearance settings for home page pinning
  const [showQuickStartOnHome, setShowQuickStartOnHome] = useState(true); // default on
  // #4596: default hidden until appearance settings load, so the live-WS
  // topology connection is never opened before we know the user wants it.
  const [showProviderTopologyOnHome, setShowProviderTopologyOnHome] = useState(false);
  const [appearanceSettingsLoaded, setAppearanceSettingsLoaded] = useState(false);

  useEffect(() => {
    // Fetch the pin settings (lightweight)
    fetch("/api/settings")
      .then((r): Promise<Record<string, unknown>> | Record<string, unknown> =>
        r.ok ? r.json() : {}
      )
      .then((data) => {
        if (data) {
          if (typeof data.showQuickStartOnHome === "boolean") {
            setShowQuickStartOnHome(data.showQuickStartOnHome);
          }
          // #4596 regression fix: the topology card defaults ON (matches the
          // AppearanceTab toggle's `!== false`). Honoring only an explicit boolean
          // left the card hidden whenever the setting was never persisted
          // (undefined), silently removing it for most installs. The live-WS
          // connection is still gated by `appearanceSettingsLoaded` in the data
          // effect, so it is never opened before settings load.
          setShowProviderTopologyOnHome(
            shouldShowProviderTopologyOnHome(data.showProviderTopologyOnHome)
          );
        }
      })
      .catch(() => {
        /* ignore — defaults stay */
      })
      .finally(() => {
        setAppearanceSettingsLoaded(true);
      });
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [provRes, modelsRes] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/models"),
      ]);
      if (provRes.ok) {
        const provData = await provRes.json();
        setProviderConnections(provData.connections || []);
      }
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        setModels(modelsData.models || []);
      }
    } catch (e) {
      console.log("Error fetching data:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await fetchData();
    })();
  }, [fetchData]);

  // Fetch provider nodes for display labels (compat providers)
  useEffect(() => {
    fetch("/api/provider-nodes")
      .then((r) => (r.ok ? r.json() : { nodes: [] }))
      .then((d) => setProviderNodes(d.nodes || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!appearanceSettingsLoaded || !showProviderTopologyOnHome) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const loadTopologyActivity = async () => {
      const currentController = new AbortController();
      controller = currentController;
      try {
        const metricsRes = await fetch("/api/provider-metrics", {
          cache: "no-store",
          signal: currentController.signal,
        });
        if (metricsRes.ok) {
          const data = await metricsRes.json();
          if (!cancelled) {
            setProviderMetrics(data.metrics || {});
            setProviderTopology({
              lastProvider: normalizeProviderId(data.topology?.lastProvider),
              errorProvider: normalizeProviderId(data.topology?.errorProvider),
            });
          }
        }
      } catch (error) {
        const isAbortError = error instanceof DOMException && error.name === "AbortError";
        if (!cancelled && !isAbortError) {
          console.error("Failed to load topology activity:", error);
        }
      } finally {
        if (controller === currentController) {
          controller = null;
        }
        if (!cancelled) {
          timeoutId = setTimeout(loadTopologyActivity, 3000);
        }
      }
    };

    loadTopologyActivity();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      controller?.abort();
    };
  }, [appearanceSettingsLoaded, showProviderTopologyOnHome]);

  // T07: Check for unhealthy API keys and show notification (once per session)
  const notifiedUnhealthyKeys = useRef<Set<string>>(new Set());
  useEffect(() => {
    const checkApiKeyHealth = () => {
      const newUnhealthyKeys = new Set<string>();
      const unhealthyProviderIds = new Set<string>();
      const unhealthyConnections: string[] = [];
      let firstUnhealthyProviderId: string | null = null;
      let hasWarning = false;

      for (const conn of providerConnections) {
        const health = conn.providerSpecificData?.apiKeyHealth as
          | Record<
              string,
              {
                status: "active" | "warning" | "invalid";
                failures: number;
                lastFailure: string | null;
              }
            >
          | undefined;
        if (!health) continue;

        // Defense-in-depth: skip stale extra_N health entries whose index
        // is out of range of the current extraApiKeys list.
        // The backend cleans this up on PATCH, but existing stale data from
        // before the fix or other code paths could still have orphan entries.
        const extras: string[] = conn.providerSpecificData?.extraApiKeys ?? [];
        const extraKeyCount = Array.isArray(extras) ? extras.length : 0;

        const unhealthyKeys = Object.entries(health).filter(([keyId, h]) => {
          if (h.status !== "invalid" && h.status !== "warning") return false;
          // extra_N entries: only flag if the index is still within bounds
          if (keyId.startsWith("extra_")) {
            const idx = Number.parseInt(keyId.slice(6), 10);
            if (Number.isNaN(idx) || idx >= extraKeyCount) return false;
          }
          return true;
        });

        if (unhealthyKeys.length > 0) {
          for (const [, h] of unhealthyKeys) {
            if (h.status === "warning") hasWarning = true;
            break;
          }
          for (const [keyId] of unhealthyKeys) {
            newUnhealthyKeys.add(`${conn.id}:${keyId}`);
          }
          firstUnhealthyProviderId ??= conn.provider;
          unhealthyConnections.push(conn.name || conn.id);
          unhealthyProviderIds.add(conn.provider);
        }
      }

      // Only notify for newly unhealthy keys (not already notified)
      const hasNewUnhealthy = Array.from(newUnhealthyKeys).some(
        (k) => !notifiedUnhealthyKeys.current.has(k)
      );
      if (hasNewUnhealthy) {
        const navigateTo =
          newUnhealthyKeys.size === 1 && firstUnhealthyProviderId
            ? `/dashboard/providers/${firstUnhealthyProviderId}`
            : `/dashboard/providers?search=${encodeURIComponent(Array.from(unhealthyProviderIds).join(" "))}`;

        const notificationType = hasWarning ? "warning" : "error";

        useNotificationStore.getState().addNotification({
          type: notificationType,
          message: tp(hasWarning ? "apiKeyWarningAlert" : "apiKeyInvalidAlert", {
            count: newUnhealthyKeys.size,
            connections: unhealthyConnections.join(", "),
          }),
          title: tp(hasWarning ? "apiKeyWarningAlertTitle" : "apiKeyInvalidAlertTitle"),
          duration: 10000,
          onClick: () => navigate(navigateTo),
        });
        // Mark all current unhealthy keys as notified
        newUnhealthyKeys.forEach((k) => notifiedUnhealthyKeys.current.add(k));
      }
    };

    if (providerConnections.length > 0) {
      checkApiKeyHealth();
    }
  }, [providerConnections, t, tp, navigate]);

  const providerStats = useMemo(() => {
    return Object.entries(AI_PROVIDERS).map(([providerId, providerInfo]) => {
      const connections = providerConnections.filter((conn) => conn.provider === providerId);
      const connected = connections.filter((connection) =>
        isProviderConnectionConnected(connection)
      ).length;
      const errors = connections.filter((connection) =>
        isProviderConnectionErrored(connection)
      ).length;

      const providerKeys = new Set([providerId, providerInfo.alias].filter(Boolean));
      const providerModels = models.filter((m) => providerKeys.has(m.provider));

      const authType = NOAUTH_PROVIDERS[providerId]
        ? "no-auth"
        : OAUTH_PROVIDERS[providerId]
          ? "oauth"
          : "apikey";

      return {
        id: providerId,
        provider: providerInfo,
        total: connections.length,
        connected,
        errors,
        modelCount: providerModels.length,
        authType,
      };
    });
  }, [providerConnections, models]);

  const selectedProviderModels = useMemo(() => {
    if (!selectedProvider) return [];
    const providerKeys = new Set(
      [selectedProvider.id, selectedProvider.provider?.alias].filter(Boolean)
    );
    return models.filter((m) => providerKeys.has(m.provider));
  }, [selectedProvider, models]);

  const topologyProviders = useMemo(() => {
    type ProviderHealth = "active" | "error" | "idle";
    const byProvider = new Map<
      string,
      { id: string; provider: string; name?: string; status: ProviderHealth }
    >();
    const providerConfig = AI_PROVIDERS as Record<string, { name?: string }>;

    // Connection-health per provider, so the topology node reflects "what is connected"
    // at rest (green healthy / red error) instead of going blank between requests. A
    // provider with ≥1 healthy connection is "active"; if none are healthy but some are
    // errored it is "error"; otherwise "idle". Live/recent traffic still overrides this.
    const healthByProvider = new Map<string, ProviderHealth>();
    for (const stat of providerStats) {
      const canonical = normalizeProviderId(stat.id);
      if (!canonical) continue;
      healthByProvider.set(
        canonical,
        stat.connected > 0 ? "active" : stat.errors > 0 ? "error" : "idle"
      );
    }

    const addProvider = (providerId?: string | null, name?: string) => {
      const rawProviderId = typeof providerId === "string" ? providerId.trim() : "";
      if (!rawProviderId) return;

      const canonicalProviderId = normalizeProviderId(rawProviderId);
      if (!canonicalProviderId || byProvider.has(canonicalProviderId)) return;

      // Exclude providers with no active connections (or where all connections are deactivated)
      const hasActiveConn = providerConnections.some(
        (c) => normalizeProviderId(c.provider) === canonicalProviderId && c.isActive !== false
      );
      if (!hasActiveConn) return;

      const resolvedName =
        getProviderDisplayLabel(rawProviderId, providerNodes) ||
        name ||
        providerConfig[canonicalProviderId]?.name ||
        rawProviderId;

      byProvider.set(canonicalProviderId, {
        id: canonicalProviderId,
        provider: canonicalProviderId,
        name: resolvedName,
        status: healthByProvider.get(canonicalProviderId) ?? "idle",
      });
    };

    providerStats
      .filter((provider) => provider.total > 0)
      .forEach((provider) => addProvider(provider.id, provider.provider.name));
    providerConnections.forEach((conn) => addProvider(conn.provider));
    Object.keys(providerMetrics).forEach((provider) => addProvider(provider));

    return Array.from(byProvider.values());
  }, [providerStats, providerMetrics, providerNodes, providerConnections]);

  const { lastProvider, errorProvider } = providerTopology;

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;

  return (
    <div className="flex flex-col gap-8">
      {/* Quick Start (controlled by Appearance setting, default on) */}
      {showQuickStartOnHome && (
        <section className="flex flex-col gap-3">
          <SectionHeader
            title={t("quickStart")}
            description={t("quickStartDesc")}
            actions={
              <Link to="/docs" className={DOCS_LINK}>
                <Icon name="menu_book" size={14} />
                {t("fullDocs")}
              </Link>
            }
          />
          <WorkflowGuide
            label={t("quickStart")}
            items={[
              {
                id: "step1",
                icon: <Icon name="key" size={18} />,
                title: stripStepNumber(t("step1Title")),
                description: (
                  <>
                    {t.rich("step1Desc", {
                      endpoint: (chunks) => (
                        <Link to="/dashboard/api-manager" className={INLINE_LINK}>
                          {chunks}
                        </Link>
                      ),
                    })}
                  </>
                ),
              },
              {
                id: "step2",
                icon: <Icon name="dns" size={18} />,
                title: stripStepNumber(t("step2Title")),
                description: (
                  <>
                    {t.rich("step2Desc", {
                      providers: (chunks) => (
                        <Link to="/dashboard/providers" className={INLINE_LINK}>
                          {chunks}
                        </Link>
                      ),
                    })}
                  </>
                ),
              },
              {
                id: "step3",
                icon: <Icon name="link" size={18} />,
                title: stripStepNumber(t("step3Title")),
                description: <>{t("step3Desc", { url: currentEndpoint })}</>,
              },
              {
                id: "step4",
                icon: <Icon name="analytics" size={18} />,
                title: stripStepNumber(t("step4Title")),
                description: (
                  <>
                    {t.rich("step4Desc", {
                      logs: (chunks) => (
                        <Link to="/dashboard/logs" className={INLINE_LINK}>
                          {chunks}
                        </Link>
                      ),
                      analytics: (chunks) => (
                        <Link to="/dashboard/analytics" className={INLINE_LINK}>
                          {chunks}
                        </Link>
                      ),
                    })}
                  </>
                ),
              },
            ]}
          />
        </section>
      )}

      {showProviderTopologyOnHome && (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3">
          <HomeProviderTopologySection
            providers={topologyProviders}
            lastProvider={lastProvider}
            errorProvider={errorProvider}
            enabled={showProviderTopologyOnHome}
          />
          <HomeRecentRequests enabled={showProviderTopologyOnHome} />
        </div>
      )}

      {/* Provider Models Modal */}
      {selectedProvider && (
        <ProviderModelsModal
          provider={selectedProvider}
          models={selectedProviderModels}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </div>
  );
}

function ProviderOverviewCard({
  item,
  metrics,
  onClick,
}: {
  item: ProviderSummaryItem;
  metrics?: ProviderMetricSummary;
  onClick: () => void;
}) {
  const t = useTranslations("home");
  const tc = useTranslations("common");

  const statusVariant =
    item.errors > 0 ? "text-error" : item.connected > 0 ? "text-success" : "text-text-muted";

  const authTypeConfig = {
    "no-auth": { color: "bg-text-muted/30", label: t("noAuthLabel") },
    free: { color: "bg-success", label: tc("free") },
    oauth: { color: "bg-info", label: t("oauthLabel") },
    apikey: { color: "bg-warning", label: t("apiKeyLabel") },
  };
  const authInfo = authTypeConfig[item.authType] || authTypeConfig.apikey;

  return (
    <Button
      variant="outline"
      onClick={onClick}
      className="block h-auto min-h-0 w-full p-3 text-left font-normal"
    >
      <div className="flex items-center gap-2.5">
        <div
          className="size-8 rounded-lg flex items-center justify-center shrink-0"
          style={{
            backgroundColor: `color-mix(in srgb, ${item.provider.color || "var(--color-text-muted)"} 8%, transparent)`,
          }}
        >
          <ProviderIcon providerId={item.provider.id} size={26} type="color" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold truncate">{item.provider.name}</p>
            <span
              className={`size-2 rounded-full ${authInfo.color} shrink-0`}
              title={authInfo.label}
            />
          </div>
          <p className={`text-xs ${statusVariant}`}>
            {item.total === 0
              ? tc("notConfigured")
              : t("activeError", { active: item.connected, errors: item.errors })}
          </p>
          {metrics && metrics.totalRequests > 0 && (
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-text-muted">
                <span className="text-success">{metrics.totalSuccesses}</span>/
                {t("requestsShort", { count: metrics.totalRequests })}
              </span>
              <span className="text-[10px] text-text-muted">{metrics.successRate}%</span>
              <span className="text-[10px] text-text-muted">~{metrics.avgLatencyMs}ms</span>
            </div>
          )}
        </div>

        <div className="text-right shrink-0">
          <p className="text-xs font-medium text-text-main">{item.modelCount}</p>
          <p className="text-[10px] text-text-muted">{tc("models")}</p>
        </div>
      </div>
    </Button>
  );
}

function ProviderModelsModal({
  provider,
  models,
  onClose,
}: {
  provider: ProviderSummaryItem;
  models: ProviderModelSummary[];
  onClose: () => void;
}) {
  const [copiedModel, setCopiedModel] = useState(null);
  const notify = useNotificationStore();
  const navigate = useNavigate();
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const ts = useTranslations("sidebar");

  const navigateTo = (path) => {
    onClose();
    navigate(path);
  };

  const handleCopy = async (text) => {
    await copyToClipboard(text);
    setCopiedModel(text);
    notify.success(t("copiedModel", { model: text }));
    setTimeout(() => setCopiedModel(null), 2000);
  };

  return (
    <Modal
      isOpen={true}
      title={t("providerModelsTitle", { provider: provider.provider.name })}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {/* Summary */}
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Icon name="token" size={16} />
          {models.length === 1
            ? t("modelAvailable", { count: models.length })
            : t("modelsAvailable", { count: models.length })}
          {provider.total > 0 && (
            <span className="ml-auto text-xs text-success">
              ●{" "}
              {provider.connected === 1
                ? t("connectionsActive", { count: provider.connected })
                : t("connectionsActivePlural", { count: provider.connected })}
            </span>
          )}
        </div>

        {models.length === 0 ? (
          <EmptyState
            icon="search_off"
            title={t("noModelsAvailable")}
            description={t("configureFirst", { providers: ts("providers") })}
          />
        ) : (
          <div className="flex flex-col gap-1 max-h-[400px] overflow-y-auto">
            {models.map((m) => (
              <div
                key={m.fullModel}
                className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-surface/50 transition-colors group"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-text-main truncate">{m.fullModel}</p>
                  {m.alias !== m.model && (
                    <p className="text-[10px] text-text-muted">
                      {t("aliasLabel")}: {m.alias}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  icon={copiedModel === m.fullModel ? "check" : "content_copy"}
                  onClick={() => handleCopy(m.fullModel)}
                  title={t("copyModelName")}
                  aria-label={t("copyModelName")}
                  className="ml-2 shrink-0 text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                />
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2 border-t border-border">
          <Button
            variant="secondary"
            fullWidth
            size="sm"
            onClick={() => navigateTo(`/dashboard/providers/${provider.id}`)}
            className="flex-1"
          >
            <Icon name="settings" size={14} />
            {t("configureProvider")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {tc("close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
