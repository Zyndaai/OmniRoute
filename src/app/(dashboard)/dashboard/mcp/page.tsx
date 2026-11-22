import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
} from "react-router";
import { useTranslations } from "use-intl";
import { PageHeader } from "@omniroute/ui-kit/page-header";
import { interpolateNodes, nodeArgs } from "@/shared/utils/interpolateNodes";
import { RadioGroup, RadioGroupItem } from "@omniroute/ui-kit/radio-group";
import { Switch } from "@omniroute/ui-kit/switch";
import { Card } from "@/shared/components";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import EmptyState from "@/shared/components/EmptyState";
import Icon from "@/shared/components/Icon";
import { cn } from "@/shared/utils/cn";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { apiAction, apiJson, apiRequest } from "@/server/routing/dashboardApi.server";
import McpDashboardPage from "../endpoint/components/MCPDashboard";

type ServiceStatus = { online: boolean; loading: boolean };
type McpTransport = "stdio" | "sse" | "streamable-http";

const TRANSPORTS: readonly McpTransport[] = ["stdio", "sse", "streamable-http"];
const STATUS_POLL_MS = 30_000;

async function readMcpOnline(): Promise<boolean> {
  try {
    const response = await apiRequest("/api/mcp/status");
    if (!response.ok) return false;
    return Boolean(((await response.json()) as { online?: unknown }).online);
  } catch {
    return false;
  }
}

/** MCP on/off, its transport and whether the server is up (polled by the page). */
export async function loader() {
  const [settings, online] = await Promise.all([
    apiJson<{ mcpEnabled?: unknown; mcpTransport?: unknown }>("/api/settings"),
    readMcpOnline(),
  ]);
  const transport = TRANSPORTS.find((value) => value === settings.mcpTransport);
  return {
    mcpEnabled: Boolean(settings.mcpEnabled),
    mcpTransport: transport ?? "streamable-http",
    online,
  };
}

/** Saves `mcpEnabled` or `mcpTransport`; nothing else goes through this page's action. */
export async function action({ request }: ActionFunctionArgs) {
  const submitted = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof submitted.mcpEnabled === "boolean") patch.mcpEnabled = submitted.mcpEnabled;
  if (TRANSPORTS.includes(submitted.mcpTransport as McpTransport)) {
    patch.mcpTransport = submitted.mcpTransport;
  }
  return apiAction("/api/settings", { method: "PATCH", body: patch });
}

function ServiceToggle({
  label,
  status,
  enabled,
  onToggle,
  toggling,
}: {
  label: string;
  status: ServiceStatus;
  enabled: boolean;
  onToggle: () => void;
  toggling: boolean;
}) {
  const t = useTranslations("mcpDashboard");
  const online = enabled && status.online;
  const loading = enabled && status.loading;

  return (
    <div className="flex items-center gap-3">
      <Badge variant={loading ? "default" : online ? "success" : "error"} dot>
        {loading ? "..." : online ? t("online") : t("offline")}
      </Badge>

      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={toggling}
        aria-label={enabled ? t("disableLabel", { label }) : t("enableLabel", { label })}
        title={enabled ? t("disableLabel", { label }) : t("enableLabel", { label })}
      />

      <span
        className={cn(
          "text-xs font-medium min-w-[24px]",
          enabled ? "text-success" : "text-text-muted"
        )}
      >
        {toggling ? "..." : enabled ? "ON" : "OFF"}
      </span>
    </div>
  );
}

function TransportSelector({
  value,
  onChange,
  disabled,
  baseUrl,
}: {
  value: McpTransport;
  onChange: (t: McpTransport) => void;
  disabled: boolean;
  baseUrl: string;
}) {
  const t = useTranslations("mcpDashboard");
  const options: { value: McpTransport; label: string; desc: string }[] = [
    { value: "stdio", label: "stdio", desc: t("transportStdioDesc") },
    { value: "sse", label: "SSE", desc: t("transportSseDesc") },
    {
      value: "streamable-http",
      label: "Streamable HTTP",
      desc: t("transportStreamableHttpDesc"),
    },
  ];

  const urlMap: Record<McpTransport, string> = {
    stdio: "omniroute --mcp",
    sse: `${baseUrl}/api/mcp/sse`,
    "streamable-http": `${baseUrl}/api/mcp/stream`,
  };

  return (
    <Card padding="sm" className="bg-bg-subtle">
      <RadioGroup
        label={
          <span className="flex items-center gap-2">
            <Icon name="swap_horiz" size={16} className="text-primary" />
            {t("transportMode")}
          </span>
        }
        orientation="horizontal"
        value={value}
        onValueChange={(next) => onChange(next as McpTransport)}
        disabled={disabled}
      >
        {options.map((opt) => (
          <RadioGroupItem
            key={opt.value}
            value={opt.value}
            card
            label={opt.label}
            description={opt.desc}
          />
        ))}
      </RadioGroup>

      <div className="mt-3 rounded-md bg-surface-2 px-3 py-2 flex items-center gap-2">
        <Icon
          name={value === "stdio" ? "terminal" : "link"}
          size={14}
          className="text-text-muted"
        />
        <code className="text-xs break-all text-text-muted">{urlMap[value]}</code>
        {value !== "stdio" && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => void copyToClipboard(urlMap[value])}
            title={t("mcpDashboardCopyUrl")}
          >
            {t("copy")}
          </Button>
        )}
      </div>
    </Card>
  );
}

function DisabledPanel() {
  const t = useTranslations("mcpDashboard");
  return (
    <EmptyState
      icon="power_settings_new"
      title={t("mcpDisabledTitle")}
      description={t("mcpDisabledDesc")}
    />
  );
}

export default function McpPage() {
  const t = useTranslations("mcpDashboard");
  const tSidebar = useTranslations("sidebar");
  const { mcpEnabled, mcpTransport, online } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const toggleFetcher = useFetcher<typeof action>();
  const transportFetcher = useFetcher<typeof action>();
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    setBaseUrl(`${window.location.protocol}//${window.location.host}`);
  }, []);

  // Re-runs the loader, which re-reads the server status. Skipped while the tab is hidden.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") {
        void revalidator.revalidate();
      }
    }, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [revalidator]);

  const mcpToggling = toggleFetcher.state !== "idle";
  const transportSaving = transportFetcher.state !== "idle";
  const mcpStatus: ServiceStatus = { online, loading: revalidator.state === "loading" };

  const toggleMcp = () =>
    toggleFetcher.submit({ mcpEnabled: !mcpEnabled }, { method: "post", encType: "application/json" });
  const changeTransport = (next: McpTransport) =>
    transportFetcher.submit({ mcpTransport: next }, { method: "post", encType: "application/json" });

  return (
    <div className="flex flex-col gap-6">
      {/* Page title (lote 7 pendência 12): the shell title hides when a PageHeader is present. */}
      <PageHeader compact title={tSidebar("mcp")} description={tSidebar("mcpSubtitle")} />
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-text-muted">
              {t("mcpIntro", { tools: 37, scopes: 13, transports: 3 })}
            </p>
            <ol className="mt-2 text-sm space-y-0.5 list-decimal list-inside text-text-muted">
              <li>
                {interpolateNodes(t("mcpStep1", nodeArgs(["code"])), {
                  // `{code}` is an ICU argument, not a tag (see interpolateNodes).
                  code: <code className="text-xs">omniroute --mcp</code>,
                })}
              </li>
              <li>{t("mcpStep2")}</li>
              <li>
                {interpolateNodes(t("mcpStep3", nodeArgs(["code1", "code2"])), {
                  code1: <code className="text-xs">omniroute_get_health</code>,
                  code2: <code className="text-xs">omniroute_list_combos</code>,
                })}
              </li>
            </ol>
          </div>
          <div className="shrink-0">
            <ServiceToggle
              label="MCP"
              status={mcpStatus}
              enabled={mcpEnabled}
              onToggle={() => void toggleMcp()}
              toggling={mcpToggling}
            />
          </div>
        </div>
      </Card>

      {mcpEnabled && (
        <TransportSelector
          value={mcpTransport}
          onChange={(t) => void changeTransport(t)}
          disabled={transportSaving}
          baseUrl={baseUrl}
        />
      )}

      {mcpEnabled ? <McpDashboardPage /> : <DisabledPanel />}
    </div>
  );
}
