/**
 * Provider Stats Dashboard
 *
 * Shows per-provider and per-model statistics aggregated from call_logs,
 * plus in-memory combo metrics and telemetry data.
 */

import { useState, useEffect, useCallback, Fragment } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { useTranslations } from "use-intl";
import { apiRead } from "@/server/routing/dashboardApi.server";

import { useProviderNodeMap, resolveProviderName } from "@/lib/display/useProviderNodeMap";
import { formatComboSuccessRate } from "@/lib/usage/providerStatsFormatters";
import { Alert } from "@omniroute/ui-kit/alert";
import { SortableTableHead } from "@omniroute/ui-kit/data-table-shell";
import { PageHeader, SectionHeader } from "@omniroute/ui-kit/page-header";
import { Stat, StatRow } from "@omniroute/ui-kit/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@omniroute/ui-kit/table";
import { Button, Card } from "@/shared/components";
import Icon from "@/shared/components/Icon";

interface ProviderStat {
  provider: string;
  totalRequests: number;
  successfulRequests: number;
  avgLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

interface ModelStat {
  provider: string;
  model: string;
  requests: number;
  avgLatencyMs: number;
  successfulRequests: number;
}

interface ToolLatencyStat {
  avgTtftAfterToolMs: number;
  avgGapAfterToolMs: number;
  measurementCount: number;
}

type SortKey =
  | "totalRequests"
  | "successfulRequests"
  | "avgLatencyMs"
  | "totalTokensIn"
  | "totalTokensOut"
  | "avgTtftAfterToolMs"
  | "avgGapAfterToolMs";
type SortDir = "asc" | "desc";

function rateTone(rate: number): string {
  if (rate >= 99) return "text-success";
  if (rate >= 95) return "text-warning";
  return "text-error";
}

/** Latency for the summary Stat: seconds from 1 s up, whole milliseconds below. */
function latencyStat(ms: number): { value: number; suffix: string; digits: number } {
  return ms >= 1000
    ? { value: ms / 1000, suffix: "s", digits: 1 }
    : { value: Math.round(ms), suffix: "ms", digits: 0 };
}

function formatNumber(n: number | null): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

interface ProviderStatsData {
  providers: ProviderStat[];
  models: ModelStat[];
  comboMetrics: Record<string, unknown>;
  telemetry: Record<string, unknown>;
  toolLatency: Record<string, ToolLatencyStat>;
  windowSince?: string;
}

/**
 * The stats, or the failure (`HTTP <status>`). A failed read does not reach the error boundary:
 * the page keeps its last good stats on a failed refresh and shows an alert only when it has
 * none.
 */
export async function loader() {
  const result = await apiRead<ProviderStatsData>("/api/provider-stats");
  return result.ok && result.data
    ? { stats: result.data, error: null }
    : { stats: null, error: result.ok ? "empty response" : `HTTP ${result.status}` };
}

export default function ProviderStatsPage() {
  const t = useTranslations("providerStats");
  const tc = useTranslations("common");
  const nodeMap = useProviderNodeMap();
  const loaded = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  // Last good stats: a failed refresh keeps showing them (as before the loader).
  const [data, setData] = useState<ProviderStatsData | null>(loaded.stats);
  const [shownLoaded, setShownLoaded] = useState(loaded);
  if (loaded !== shownLoaded) {
    setShownLoaded(loaded);
    if (loaded.stats) setData(loaded.stats);
  }
  const error = loaded.error;
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("totalRequests");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  const fetchData = useCallback(() => revalidator.revalidate(), [revalidator]);

  // The time is client-only (`Date`, locale and timezone) so it is set in an effect: the
  // server-rendered header must not differ from the first client render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stamps each good loader result
    if (loaded.stats) setLastRefresh(new Date());
  }, [loaded]);

  useEffect(() => {
    // Skip ticks while the tab is hidden; a hidden tab gets nothing from a
    // refetch, so the poll only costs the server. The interval keeps running —
    // hosts that report a permanent "hidden" state without ever firing a
    // visibilitychange still refresh, and a real background tab stops costing
    // a computation every tick.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    }, 30000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [revalidator]);

  // Compute summary stats
  const totalRequests = data?.providers.reduce((s, p) => s + (p.totalRequests || 0), 0) ?? 0;
  const totalSuccessful = data?.providers.reduce((s, p) => s + (p.successfulRequests || 0), 0) ?? 0;
  const avgLatency = data?.providers.length
    ? Math.round(
        data.providers.reduce((s, p) => s + (p.avgLatencyMs || 0), 0) / data.providers.length
      )
    : 0;
  const activeProviders = data?.providers.length ?? 0;

  // Sorted providers
  const sortedProviders = [...(data?.providers ?? [])].sort((a, b) => {
    if (sortKey === "avgTtftAfterToolMs" || sortKey === "avgGapAfterToolMs") {
      const aLatency = data?.toolLatency?.[a.provider] ?? null;
      const bLatency = data?.toolLatency?.[b.provider] ?? null;
      const va = aLatency ? ((aLatency[sortKey] as number) ?? 0) : 0;
      const vb = bLatency ? ((bLatency[sortKey] as number) ?? 0) : 0;
      return sortDir === "desc" ? vb - va : va - vb;
    }
    const va = (a[sortKey] as number) ?? 0;
    const vb = (b[sortKey] as number) ?? 0;
    return sortDir === "desc" ? vb - va : va - vb;
  });

  // Group models by provider
  const modelsByProvider = new Map<string, ModelStat[]>();
  for (const m of data?.models ?? []) {
    if (!modelsByProvider.has(m.provider)) modelsByProvider.set(m.provider, []);
    modelsByProvider.get(m.provider)!.push(m);
  }

  const pageHeader = (
    <PageHeader
      compact
      title={t("title")}
      description={t("description")}
      actions={
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-text-muted">
              {t("updated", { time: lastRefresh.toLocaleTimeString() })}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            icon="refresh"
            onClick={fetchData}
            title={t("refresh")}
            aria-label={t("refresh")}
          />
        </div>
      }
    />
  );

  if (!data) {
    return (
      <div className="space-y-6">
        {pageHeader}
        {/* Re-keyed on the message: a new failure re-shows a dismissed alert. The header's
            refresh button stays as the retry affordance after a dismiss. */}
        <Alert
          key={error ?? "error"}
          variant="critical"
          icon={<Icon name="error" size={20} />}
          title={t("loadFailed", { error: error ?? "" })}
          dismissLabel={tc("close")}
          actions={
            <Button variant="secondary" size="sm" icon="refresh" onClick={fetchData}>
              {t("retry")}
            </Button>
          }
        />
      </div>
    );
  }

  const sortHead = (key: SortKey, label: string) => (
    <SortableTableHead
      align="right"
      direction={sortKey === key ? sortDir : undefined}
      onDirectionChange={(direction) => {
        setSortKey(key);
        setSortDir(direction);
      }}
    >
      {label}
    </SortableTableHead>
  );
  const latency = latencyStat(avgLatency);

  return (
    <div className="space-y-6">
      {pageHeader}

      {/* Summary */}
      <StatRow columns={4}>
        <Stat
          label={t("totalRequests")}
          icon={<Icon name="analytics" size={18} />}
          value={totalRequests}
          format="compact"
        />
        <Stat
          label={t("avgLatency")}
          icon={<Icon name="timer" size={18} />}
          value={latency.value}
          suffix={latency.suffix}
          numberFormatOptions={{ maximumFractionDigits: latency.digits }}
        />
        <Stat
          label={t("successRate")}
          icon={<Icon name="check_circle" size={18} />}
          value={totalRequests > 0 ? totalSuccessful / totalRequests : null}
          format="percent"
          numberFormatOptions={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
        />
        <Stat
          label={t("activeProviders")}
          icon={<Icon name="dns" size={18} />}
          value={activeProviders}
        />
      </StatRow>

      {/* Provider Table */}
      <Card className="p-5">
        <SectionHeader
          className="mb-4"
          title={t("providerBreakdown")}
          description={
            data.windowSince
              ? t("windowSince", {
                  date: new Date(data.windowSince).toLocaleDateString(),
                })
              : undefined
          }
          actions={
            <span className="text-xs text-text-muted">
              {t("providerCount", { count: activeProviders })}
            </span>
          }
        />

        <Table scrollbarLabel={t("providerBreakdown")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("provider")}</TableHead>
              {sortHead("totalRequests", t("requests"))}
              {sortHead("successfulRequests", t("success"))}
              <TableHead className="text-right">{t("rate")}</TableHead>
              {sortHead("avgLatencyMs", t("avgLatency"))}
              {sortHead("totalTokensIn", t("tokensIn"))}
              {sortHead("totalTokensOut", t("tokensOut"))}
              {sortHead("avgTtftAfterToolMs", t("ttftAfterTool"))}
              {sortHead("avgGapAfterToolMs", t("gapAfterTool"))}
              <TableHead className="w-8">
                <span className="sr-only">{t("model")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedProviders.map((p) => {
              const isExpanded = expandedProvider === p.provider;
              const models = modelsByProvider.get(p.provider) ?? [];
              const rate = p.totalRequests > 0 ? (p.successfulRequests / p.totalRequests) * 100 : 0;
              const providerName = resolveProviderName(p.provider, nodeMap);
              const toggle = () =>
                setExpandedProvider(isExpanded ? null : models.length > 0 ? p.provider : null);
              return (
                <Fragment key={p.provider}>
                  <TableRow
                    className={models.length > 0 ? "cursor-pointer" : undefined}
                    onClick={toggle}
                  >
                    <TableCell className="font-medium text-text-main">{providerName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(p.totalRequests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(p.successfulRequests)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className={rateTone(rate)}>{rate.toFixed(1)}%</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLatency(p.avgLatencyMs)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-text-muted">
                      {formatNumber(p.totalTokensIn)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-text-muted">
                      {formatNumber(p.totalTokensOut)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLatency(data?.toolLatency?.[p.provider]?.avgTtftAfterToolMs ?? null)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatLatency(data?.toolLatency?.[p.provider]?.avgGapAfterToolMs ?? null)}
                    </TableCell>
                    <TableCell className="text-center">
                      {models.length > 0 && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-expanded={isExpanded}
                          aria-label={t("toggleModels", { provider: providerName })}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle();
                          }}
                        >
                          <Icon
                            name="chevron_right"
                            size={16}
                            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {isExpanded && models.length > 0 && (
                    <TableRow key={`${p.provider}-models`} className="hover:bg-transparent">
                      <TableCell colSpan={10} className="bg-bg-subtle p-0">
                        <Table
                          className="min-w-0 text-xs"
                          persistentScrollbars={false}
                          containerClassName="rounded-none border-0"
                        >
                          <TableHeader>
                            <TableRow>
                              <TableHead className="pl-12">{t("model")}</TableHead>
                              <TableHead className="text-right">{t("requests")}</TableHead>
                              <TableHead className="text-right">{t("success")}</TableHead>
                              <TableHead className="text-right">{t("rate")}</TableHead>
                              <TableHead className="text-right">{t("avgLatency")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {models.map((m) => {
                              const mRate =
                                m.requests > 0 ? (m.successfulRequests / m.requests) * 100 : 0;
                              return (
                                <TableRow key={m.model}>
                                  <TableCell className="pl-12 font-mono">{m.model}</TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    {formatNumber(m.requests)}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    {formatNumber(m.successfulRequests)}
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    <span className={rateTone(mRate)}>{mRate.toFixed(1)}%</span>
                                  </TableCell>
                                  <TableCell className="text-right tabular-nums">
                                    {formatLatency(m.avgLatencyMs)}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
            {sortedProviders.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-text-muted">
                  {t("noProviderData")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* In-Memory Metrics */}
      {data?.comboMetrics && Object.keys(data.comboMetrics).length > 0 && (
        <Card
          title={t("comboMetrics")}
          subtitle={t("comboMetricsDescription")}
          icon="speed"
          className="p-5"
        >
          <Table scrollbarLabel={t("comboMetrics")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("combo")}</TableHead>
                <TableHead className="text-right">{t("requests")}</TableHead>
                <TableHead className="text-right">{t("avgTtft")}</TableHead>
                <TableHead className="text-right">{t("avgTotal")}</TableHead>
                <TableHead className="text-right">{t("success")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(data.comboMetrics).map(([name, m]: [string, any]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium text-text-main">{name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(m.requestCount ?? m.totalRequests ?? 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatLatency(m.avgTtft ?? m.ttftMs ?? null)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatLatency(m.avgLatency ?? m.avgTotalMs ?? null)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {typeof m.successRate === "number"
                      ? formatComboSuccessRate(m.successRate)
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Telemetry Phase Breakdown */}
      {data?.telemetry && Object.keys(data.telemetry).length > 0 && (
        <Card
          title={t("requestTelemetry")}
          subtitle={t("requestTelemetryDescription")}
          icon="route"
          className="p-5"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(data.telemetry).map(([key, val]: [string, any]) => {
              if (val == null || typeof val === "object") return null;
              return (
                <div key={key} className="rounded-control border border-border bg-bg-subtle p-3">
                  <p className="ci-eyebrow">{key.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}</p>
                  <p className="text-lg font-semibold text-text-main mt-1 tabular-nums">
                    {typeof val === "number" ? formatNumber(val) : String(val)}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
